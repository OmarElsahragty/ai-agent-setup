/**
 * keepwarm.js — M4: Anthropic prompt-cache keep-warm ping for the CEO lane only.
 *
 * Why (evidence: state/local-decide/RESEARCH-LONGTASK.md Q8 / M4):
 *   Claude Code 2.1.x already writes the main conversation into the 1h cache bucket
 *   (grep of live transcripts: `ephemeral_1h_input_tokens` 100% of writes), so a main
 *   session that goes idle for more than an hour pays a 2.0x cache WRITE on resume.
 *   Anthropic documents pre-warming with `max_tokens: 0`: it reads the prefix, refreshes
 *   the cache, bills zero output tokens. Break-even at the measured P=182,065 prefix is
 *   ~2.6% resume probability, so a ping is worth it whenever the session is likely to come
 *   back inside the TTL.
 *
 * What a ping must be, or it is pure waste (docs, called out explicitly):
 *   the SAME body as real traffic — same thinking config, same `output_config.effort`,
 *   same tools, same system, same messages, same cache_control breakpoint — with only
 *   `max_tokens` and `stream` changed. A ping that differs writes an entry real traffic
 *   never hits. Therefore this module never rewrites the prefix: it replays the exact
 *   outbound Buffer that was sent for the last served request.
 *
 * Scope / safety:
 *   - OFF by default (ROUTER_KEEPWARM=1 enables it). No flag → no timer, no state.
 *   - Arms ONLY for role `main-orchestrator` requests that were SERVED by Anthropic
 *     (a request served by the OpenCode Go deepseek-v4.1-flash lane has no Anthropic
 *     cache to warm, and a ping on that lane is billed waste). Subagent lanes, compaction,
 *     summaries and background jobs never arm.
 *   - State lives in memory only. The stored body is the request prefix (the CEO's own
 *     context) and the stored headers carry the Anthropic credential: neither is ever
 *     written to disk, a log line, or a crash dump of this module.
 *   - Bounded: at most one in-flight ping per session, at most KEEPWARM_MAX_SESSIONS
 *     (8) tracked sessions with LRU eviction, at most KEEPWARM_MAX_BODY_BYTES of body
 *     per session, and a hard KEEPWARM_MAX_IDLE_MS (12 h) idle budget per session.
 *   - Fail-safe: any transport error, any 4xx/429/5xx, a cache-creation miss, or an
 *     exception stops pinging that session and never touches real traffic.
 *   - Timers are unref'd: keep-warm can never hold the process open.
 *   - Credential freshness (M-016, per account since D5): Claude Code refreshes its OAuth token
 *     while a session idles, so a ping replays the NEWEST credential a served main-lane request
 *     carried for this session or, of the same kind, for this session's ACCOUNT (metadata.user_id
 *     account_uuid) — never another account's, never one that already drew a 401. A 401 drops that
 *     credential (kept only as a sha256 fingerprint); a session left with nothing but dead
 *     credentials skips its ping ([KEEPWARM-SKIP]) instead of collecting another 401.
 *
 * It does NOT inject `context_management` (G4): Claude Code already sends the beta and
 * already prunes; the router must not write a second entry. The ping body is the stored
 * body with two keys replaced, so it inherits whatever the client sent and nothing else.
 */
"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const DEFAULT_UPSTREAM_URL = "https://api.anthropic.com";
const DEFAULT_IDLE_MS = 55 * 60 * 1000;          // TTL is 1h; ping just before it lapses
const DEFAULT_MAX_IDLE_MS = 12 * 60 * 60 * 1000; // give up on a session after a half day
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MISS_RATIO = 0.10;                // cache_creation > 10% of cache_read == prefix miss
const MAIN_ROLE = "main-orchestrator";
const MAX_USAGE_BYTES = 65536;
const MAX_DEAD_CREDENTIALS = 32;

/** Env-derived config, re-read on every call so a hot .env edit needs no restart. */
function flags(env) {
  const e = env || process.env;
  const num = (name, dflt) => {
    const v = Number(e[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const ratio = Number(e.KEEPWARM_MISS_RATIO);
  return {
    enabled: e.ROUTER_KEEPWARM === "1",
    idleMs: num("KEEPWARM_IDLE_MS", DEFAULT_IDLE_MS),
    maxIdleMs: num("KEEPWARM_MAX_IDLE_MS", DEFAULT_MAX_IDLE_MS),
    maxSessions: num("KEEPWARM_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
    maxBodyBytes: num("KEEPWARM_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES),
    timeoutMs: num("KEEPWARM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    missRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_MISS_RATIO,
    upstreamUrl: safeUpstream(e.KEEPWARM_UPSTREAM_URL),
  };
}

// The ping replays the stored client headers (incl. authorization), so the upstream may only be
// https://api.anthropic.com, or a loopback test double (security re-audit 2026-10-02).
function safeUpstream(value) {
  if (!value) return DEFAULT_UPSTREAM_URL;
  try {
    const u = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
    if ((u.protocol === "https:" && u.hostname === "api.anthropic.com") || loopback) return value;
  } catch { /* fall through */ }
  console.warn("[KEEPWARM] KEEPWARM_UPSTREAM_URL rejected (not api.anthropic.com or loopback); using the default");
  return DEFAULT_UPSTREAM_URL;
}

/** sessionId -> { id, account, body, headers, path, method, lastRealAt, timer, inFlight, zeroUnsupported, touchedAt } */
const sessions = new Map();

/**
 * M-016 + D5 (Review-A minor: the old single lane-wide credential assumed ONE account). The newest
 * credential a SERVED main-lane request carried is tracked per ACCOUNT and per SESSION, never
 * lane-wide: a ping may borrow a fresher credential only from the same account (the CLI names it in
 * metadata.user_id) or, when the account is unknown, only from the same session id. One account's
 * prompt prefix is therefore never replayed under another account's credential. Memory only.
 * Each value: { name, value, seenAt }. Bounded, oldest entry evicted first.
 */
const accountCredentials = new Map();
const sessionCredentials = new Map();
const MAX_TRACKED_CREDENTIALS = 32;
/** sha256 fingerprints of credentials that drew a 401 (bounded, oldest evicted first). */
const deadCredentials = new Set();

/**
 * The account a main-lane request belongs to, from the request body's metadata.user_id: the current
 * CLI sends a JSON string with `account_uuid`; older builds sent `user_<hash>_account_<uuid>_session_<uuid>`.
 * "" when absent/unparsable (API-key clients send an empty account): such a request lends nothing.
 */
function accountOf(parsedBody) {
  try {
    const raw = parsedBody && parsedBody.metadata && parsedBody.metadata.user_id;
    if (typeof raw !== "string" || !raw || raw.length > 4096) return "";
    let id = "";
    if (raw.trim().startsWith("{")) {
      const meta = JSON.parse(raw);
      id = meta && typeof meta.account_uuid === "string" ? meta.account_uuid : "";
    } else {
      const m = /_account_([0-9A-Za-z-]+)_session_/.exec(raw);
      id = m ? m[1] : "";
    }
    return /^[0-9A-Za-z-]{1,64}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function rememberCredential(map, key, entry) {
  if (!key) return;
  const cur = map.get(key);
  if (cur && cur.seenAt > entry.seenAt) return;
  map.delete(key); // re-insert: Map order is the eviction order
  map.set(key, entry);
  while (map.size > MAX_TRACKED_CREDENTIALS) map.delete(map.keys().next().value);
}

function credentialOf(headers) {
  if (!headers) return null;
  if (headers.authorization) return { name: "authorization", value: String(headers.authorization) };
  if (headers["x-api-key"]) return { name: "x-api-key", value: String(headers["x-api-key"]) };
  return null;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** A served (status < 400) main-lane request proves its credential valid at `at` — for its account and session. */
function noteServedCredential(req, at) {
  const cred = credentialOf(req.headers);
  if (!cred) return;
  deadCredentials.delete(fingerprint(cred.value));
  const entry = { ...cred, seenAt: at };
  rememberCredential(accountCredentials, String(req.account || ""), entry);
  rememberCredential(sessionCredentials, String(req.sessionId || ""), entry);
}

function markCredentialDead(cred) {
  if (!cred) return;
  deadCredentials.add(fingerprint(cred.value));
  while (deadCredentials.size > MAX_DEAD_CREDENTIALS) deadCredentials.delete(deadCredentials.values().next().value);
  for (const map of [accountCredentials, sessionCredentials]) {
    for (const [key, entry] of Array.from(map)) if (entry.value === cred.value) map.delete(key);
  }
}

/**
 * The credential a ping carries: the newest one of the same kind seen for this session or for this
 * session's account, skipping any that drew a 401. null = the session stored no credential (headers
 * go as-is); { dead: true } = every candidate is dead, so the ping is skipped instead of collecting
 * a 401. A credential seen only on ANOTHER account (or on a request whose account is unknown and
 * whose session differs) is never a candidate.
 */
function pingCredential(session) {
  const own = credentialOf(session.headers);
  if (!own) return null;
  const candidates = [{ ...own, seenAt: session.lastRealAt || 0 }];
  const borrow = (c) => { if (c && c.name === own.name && c.value !== own.value) candidates.push(c); };
  borrow(sessionCredentials.get(session.id));
  if (session.account) borrow(accountCredentials.get(session.account));
  candidates.sort((a, b) => b.seenAt - a.seenAt);
  return candidates.find((c) => !deadCredentials.has(fingerprint(c.value))) || { dead: true };
}

/** Learns from every main-lane request: served -> freshest credential of its account/session; 401 -> dead. */
function learnCredential(req) {
  const res = req.res;
  if (!res || typeof res.once !== "function") return;
  res.once("finish", () => {
    const outcome = typeof req.outcome === "function" ? req.outcome() : null;
    if (!outcome || !outcome.served) return;
    const status = Number(outcome.status) || 0;
    if (status === 401) markCredentialDead(credentialOf(req.headers));
    else if (status > 0 && status < 400) noteServedCredential(req, Date.now());
  });
}

/** Test helper: credential bookkeeping without any credential value. */
function credentialState() {
  return { accounts: accountCredentials.size, sessions: sessionCredentials.size, dead: deadCredentials.size };
}

function shortId(id) {
  return String(id || "").slice(0, 8);
}

function clearTimer(session) {
  if (session && session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function dropSession(session, why) {
  if (!session) return;
  clearTimer(session);
  session.stopped = why || "stopped";
  if (sessions.get(session.id) === session) sessions.delete(session.id);
}

function sessionCount() {
  return sessions.size;
}

function pendingTimerCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.timer) n += 1;
  return n;
}

/** LRU eviction: the least recently touched session loses its slot. */
function evictLru(cfg) {
  while (sessions.size > cfg.maxSessions) {
    let oldest = null;
    for (const s of sessions.values()) {
      if (!oldest || s.touchedAt < oldest.touchedAt) oldest = s;
    }
    if (!oldest) return;
    dropSession(oldest, "lru-evict");
  }
}

/**
 * The ping body: the stored outbound body with exactly two keys replaced. Everything
 * that makes a cache hit possible — thinking, output_config.effort, tools, system,
 * messages and every cache_control breakpoint — is byte-identical to real traffic.
 */
function buildPingBody(session, maxTokens) {
  if (!session || !session.body) return null;
  let parsed;
  try {
    parsed = JSON.parse(session.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return Buffer.from(JSON.stringify({ ...parsed, max_tokens: maxTokens, stream: false }), "utf8");
}

/** Decode a (possibly compressed) usage body; an upstream may ignore `identity`. */
function decodeBody(buf, encoding) {
  const enc = String(encoding || "").trim().toLowerCase();
  const opts = { maxOutputLength: MAX_USAGE_BYTES * 4 };
  if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf, opts);
  if (enc === "deflate") return zlib.inflateSync(buf, opts);
  if (enc === "br") return zlib.brotliDecompressSync(buf, opts);
  return buf;
}

/** Headers for the ping: the ones actually used upstream, minus hop-by-hop + length. */
function buildPingHeaders(session, cfg, bodyLength, credential) {
  const headers = { ...(session.headers || {}) };
  if (credential && credential.name) headers[credential.name] = credential.value; // M-016: freshest credential
  delete headers.connection;
  delete headers["Content-Length"];
  delete headers.host;
  // The stored client headers carry `accept-encoding: gzip, br`; a compressed reply made
  // JSON.parse fail silently and every ping read as cache 0/0 (live 2026-10-02 10:34).
  headers["accept-encoding"] = "identity";
  try {
    headers.host = new URL(cfg.upstreamUrl).host;
  } catch { /* keep the stored host */ }
  headers["content-length"] = bodyLength;
  return headers;
}

/**
 * One ping round trip. Never rejects: a transport failure resolves to `{error: true}`
 * so the caller can stop the session without an unhandled rejection.
 */
function sendPing(session, cfg, maxTokens, credential) {
  return new Promise((resolve) => {
    const body = buildPingBody(session, maxTokens);
    if (!body) return resolve({ error: true, status: 0, reason: "unparsable-body" });
    let url;
    try {
      url = new URL(cfg.upstreamUrl);
    } catch {
      return resolve({ error: true, status: 0, reason: "bad-upstream-url" });
    }
    const headers = buildPingHeaders(session, cfg, body.length, credential);
    const lib = url.protocol === "http:" ? http : https;
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: session.path || url.pathname || "/v1/messages",
      method: session.method || "POST",
      headers,
      family: 4,
    }, (res) => {
      const status = res.statusCode || 0;
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        if (size < MAX_USAGE_BYTES) { chunks.push(c); size += c.length; }
      });
      res.on("end", () => {
        let usage = null;
        try {
          const parsed = JSON.parse(decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]).toString("utf8"));
          if (parsed && typeof parsed === "object" && parsed.usage && typeof parsed.usage === "object") {
            usage = {
              cacheRead: Number(parsed.usage.cache_read_input_tokens) || 0,
              cacheCreation: Number(parsed.usage.cache_creation_input_tokens) || 0,
            };
          }
        } catch { /* a body without usage is still a valid HTTP outcome */ }
        finish({ status, usage });
      });
    });
    const timer = setTimeout(() => {
      try { req.destroy(); } catch { /* already gone */ }
      finish({ error: true, status: 0, reason: "timeout" });
    }, cfg.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("error", (err) => finish({ error: true, status: 0, reason: err && err.code ? err.code : "connect_error" }));
    try {
      req.write(body);
      req.end();
    } catch (err) {
      finish({ error: true, status: 0, reason: "write_error" });
    }
  });
}

function scheduleNext(session, delayMs) {
  clearTimer(session);
  session.timer = setTimeout(() => {
    session.timer = null;
    runPing(session).catch(() => dropSession(session, "error"));
  }, delayMs);
  if (typeof session.timer.unref === "function") session.timer.unref();
  return session.timer;
}

async function runPing(session) {
  const cfg = flags();
  if (!cfg.enabled) return dropSession(session, "flag-off");
  if (session.stopped || sessions.get(session.id) !== session) return undefined;
  if (session.inFlight) return undefined;            // at most one ping per session
  const now = Date.now();
  const idleMs = now - session.lastRealAt;
  if (idleMs >= cfg.maxIdleMs) return dropSession(session, "max-idle");
  session.inFlight = true;
  try {
    // M-016: the newest credential seen for this session/lane; never one that drew a 401.
    const credential = pingCredential(session);
    if (credential && credential.dead) {
      console.log(`[KEEPWARM-SKIP] session=${shortId(session.id)} idle_min=${(idleMs / 60000).toFixed(1)} reason=stale-credential`);
      return dropSession(session, "stale-credential");
    }
    let maxTokens = session.zeroUnsupported ? 1 : 0;
    let out = await sendPing(session, cfg, maxTokens, credential);
    // A 400 on max_tokens 0 means this API does not accept a zero-token pre-warm.
    // Retry exactly once with 1 and remember it for the rest of the session's life.
    if (!out.error && out.status === 400 && maxTokens === 0) {
      session.zeroUnsupported = true;
      out = await sendPing(session, cfg, 1, credential);
    }
    const read = out.usage ? out.usage.cacheRead : 0;
    const created = out.usage ? out.usage.cacheCreation : 0;
    const status = out.status || 0;
    if (!out.error) {
      console.log(`[KEEPWARM] session=${shortId(session.id)} idle_min=${(idleMs / 60000).toFixed(1)} `
        + `cache_read=${read} cache_creation=${created} status=${status}`);
    }
    if (out.error) return dropSession(session, `error:${out.reason || "transport"}`);
    // M-016: a 401 retires that credential for every session; no ping is ever retried with it.
    if (status === 401) markCredentialDead(credential);
    if (status >= 400) return dropSession(session, `http-${status}`);
    // A ping that mostly WRITES the prefix did not hit the cache: stop, the entry the
    // owner pays for is not being read back. I7b: read<=0 is ALWAYS a miss, created or not —
    // a 200 whose usage carries no cache_read (e.g. 0/0) proves nothing was read back, and
    // pinging on would be an unobserved loop of full-price writes.
    const missed = read <= 0 || created > read * cfg.missRatio;
    if (missed) {
      console.log(`[KEEPWARM-MISS] session=${shortId(session.id)} idle_min=${(idleMs / 60000).toFixed(1)} `
        + `cache_read=${read} cache_creation=${created} status=${status}`);
      return dropSession(session, "cache-miss");
    }
    // Hit: re-arm from now — but only if this session is still the live one. A newer real
    // request for the same session id replaced it while this ping was in flight, and its
    // body/prefix is the one that must be warmed.
    if (sessions.get(session.id) !== session) {
      dropSession(session, "superseded");
      return undefined;
    }
    session.touchedAt = Date.now();
    scheduleNext(session, cfg.idleMs);
    return undefined;
  } catch {
    return dropSession(session, "exception");
  } finally {
    session.inFlight = false;
  }
}

/**
 * Called from handleAnthropic for every Anthropic-bound request. Arms (or re-arms) the
 * session ONLY when the request was actually served by Anthropic as the primary lane.
 * Returns true when a session is armed, so a test can assert the negative cases.
 */
function observe(req) {
  const cfg = flags();
  if (!cfg.enabled) return false;
  if (req.role !== MAIN_ROLE) return false;
  // M-016: any main-lane request (any session, any path) refreshes the lane credential.
  learnCredential(req);
  const sessionId = String(req.sessionId || "");
  if (!sessionId) return false;
  // I7a: only the messages endpoint warms a conversation cache. A /v1/messages/count_tokens
  // call carries a DIFFERENT prefix (no tools/system contract) and must neither arm a session
  // nor supersede (cancel + replace the body of) one that a real messages request armed.
  if (!/^\/v1\/messages(\?|$)/.test(String(req.path || ""))) return false;
  if (!req.body || req.body.length > cfg.maxBodyBytes) return false;

  const existing = sessions.get(sessionId);
  if (existing) {
    // A newer request cancels the pending ping and supersedes the stored prefix, including
    // any ping of it that is still in flight (that ping must not re-arm on the old body).
    clearTimer(existing);
    existing.stopped = "superseded";
  }

  req.res.once("finish", () => {
    const outcome = typeof req.outcome === "function" ? req.outcome() : null;
    const served = !!(outcome && outcome.served);
    const status = Number(outcome && outcome.status) || 0;
    if (!served || status >= 400) {
      // Fell back to another provider (no Anthropic cache to warm) or the request
      // failed: the stored prefix is no longer known-good, so stop.
      const cur = sessions.get(sessionId);
      if (cur) dropSession(cur, served ? `http-${status}` : "fallback-served");
      return;
    }
    const now = Date.now();
    const session = {
      id: sessionId,
      account: String(req.account || ""),
      body: req.body,
      headers: req.headers,
      path: req.path,
      method: req.method,
      lastRealAt: now,
      touchedAt: now,
      timer: null,
      inFlight: false,
      zeroUnsupported: false,
      stopped: null,
    };
    sessions.set(sessionId, session);
    evictLru(cfg);
    if (!sessions.has(sessionId)) return;    // evicted immediately (maxSessions edge)
    scheduleNext(session, cfg.idleMs);
  });
  return true;
}

/** Test/shutdown helper: drop every session and timer. */
function reset() {
  for (const s of Array.from(sessions.values())) dropSession(s, "reset");
  sessions.clear();
  accountCredentials.clear();
  sessionCredentials.clear();
  deadCredentials.clear();
}

module.exports = {
  flags,
  observe,
  accountOf,
  runPing,
  buildPingBody,
  buildPingHeaders,
  sendPing,
  scheduleNext,
  dropSession,
  reset,
  sessionCount,
  pendingTimerCount,
  credentialState,
  sessions,
  MAIN_ROLE,
  DEFAULT_UPSTREAM_URL,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_IDLE_MS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MISS_RATIO,
};
