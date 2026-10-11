"use strict";
/**
 * node --test for the M4 keep-warm ping (keepwarm.js) and the G4 no-injection assertion.
 * Run: node --test ${AI_SETUP_ROOT}/claude-router/test/
 *
 * Every timer is driven with a small KEEPWARM_IDLE_MS instead of a fake clock: the ping
 * path is I/O (https.request), so a real short timer is the only honest test. Each test
 * points KEEPWARM_UPSTREAM_URL at a local fake Anthropic, so no real request is ever made.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const keepwarm = require("../keepwarm");
const { buildAnthropicOutboundBody } = require("../server");

const ENV_KEYS = [
  "ROUTER_KEEPWARM", "KEEPWARM_IDLE_MS", "KEEPWARM_MAX_IDLE_MS", "KEEPWARM_MAX_SESSIONS",
  "KEEPWARM_MAX_BODY_BYTES", "KEEPWARM_TIMEOUT_MS", "KEEPWARM_MISS_RATIO", "KEEPWARM_UPSTREAM_URL",
];

function withEnv(overrides) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `cond` is true. A ping RE-ARMS after every hit (by design), so a fixed sleep
 * would race the next ping; every timing assertion below waits for the event it needs and
 * only then pins the exact count.
 */
async function waitFor(cond, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

// A minimal `res` stand-in: handleAnthropic/keepwarm only need once("finish").
function fakeRes() {
  const listeners = {};
  return {
    statusCode: 200,
    fallbackHop: 0,
    fallbackModel: undefined,
    once(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return this; },
    finish(status) {
      if (status !== undefined) this.statusCode = status;
      for (const cb of listeners.finish || []) cb();
    },
  };
}

/**
 * Fake Anthropic. `respond(req, res, count)` decides the reply; the parsed ping body and
 * headers are recorded so the tests can assert byte-identity.
 */
function startFakeUpstream(respond) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
      const entry = { body, headers: req.headers, raw, path: req.url };
      received.push(entry);
      respond(req, res, received.length, entry);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, received, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

function stopUpstream(fake) {
  return new Promise((resolve) => {
    // A keep-alive socket from a finished ping would hold server.close() open until the
    // agent's keep-alive timeout; destroy idle sockets so teardown is deterministic.
    if (typeof fake.server.closeIdleConnections === "function") fake.server.closeIdleConnections();
    fake.server.close(() => resolve());
  });
}

function jsonResponse(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

// A CEO main-lane body: system + tools + a cache breakpoint + thinking + effort, i.e. every
// field the Anthropic docs say a pre-warm must reproduce exactly.
function ceoBody(marker) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 32000,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [{ type: "text", text: "you are the CEO", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: `marker=${marker}` }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  };
}

function ceoOutbound(marker) {
  const { outboundBody, targetModel } = buildAnthropicOutboundBody(ceoBody(marker), "claude-opus-5-5", {});
  return Buffer.from(JSON.stringify({ ...outboundBody, model: targetModel }), "utf8");
}

function serveRequest({ sessionId, marker, res, served = true, status = 200, path = "/v1/messages" }) {
  keepwarm.observe({
    sessionId,
    role: "main-orchestrator",
    res,
    body: ceoOutbound(marker),
    headers: {
      "x-claude-code-session-id": sessionId,
      "anthropic-beta": "prompt-caching-2024-07-31",
      authorization: "Bearer sk-ant-redacted",
      "content-type": "application/json",
      "accept-encoding": "gzip, deflate, br",
    },
    path,
    method: "POST",
    outcome: () => ({ served, status }),
  });
  res.finish(status);
}

// ---------------------------------------------------------------------------
// flag off
// ---------------------------------------------------------------------------
test("flag off: no timers, no state, body bytes untouched", () => {
  const restore = withEnv({});
  try {
    const res = fakeRes();
    const body = ceoOutbound("off");
    const before = Buffer.from(body);
    const armed = keepwarm.observe({
      sessionId: "sess-flag-off", role: "main-orchestrator", res, body,
      headers: { "x-claude-code-session-id": "sess-flag-off" }, path: "/v1/messages", method: "POST",
      outcome: () => ({ served: true, status: 200 }),
    });
    res.finish(200);
    assert.equal(armed, false);
    assert.equal(keepwarm.sessionCount(), 0);
    assert.equal(keepwarm.pendingTimerCount(), 0);
    assert.deepEqual(body, before, "keep-warm must never mutate the forwarded body");
  } finally {
    keepwarm.reset();
    restore();
  }
});

test("G4: the router injects no context_management, and the ping inherits none", () => {
  const restore = withEnv({ ROUTER_KEEPWARM: "1" });
  try {
    const built = buildAnthropicOutboundBody(ceoBody("g4"), "claude-opus-5-5", {});
    assert.equal("context_management" in built.outboundBody, false);
    const session = { body: Buffer.from(JSON.stringify(built.outboundBody), "utf8") };
    const ping = JSON.parse(keepwarm.buildPingBody(session, 0).toString("utf8"));
    assert.equal("context_management" in ping, false);
    assert.equal("context_management" in built.outboundBody.messages, false);
  } finally {
    keepwarm.reset();
    restore();
  }
});

// ---------------------------------------------------------------------------
// who may arm
// ---------------------------------------------------------------------------
test("only the main-orchestrator role arms a session", () => {
  const restore = withEnv({ ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "100000" });
  try {
    for (const role of ["implementer", "code-reviewer", "compaction", "summary", "background", "quant-engineer"]) {
      const res = fakeRes();
      const armed = keepwarm.observe({
        sessionId: `sess-${role}`, role, res, body: ceoOutbound(role),
        headers: {}, path: "/v1/messages", method: "POST",
        outcome: () => ({ served: true, status: 200 }),
      });
      res.finish(200);
      assert.equal(armed, false, `role ${role} must not arm`);
    }
    assert.equal(keepwarm.sessionCount(), 0);
    assert.equal(keepwarm.pendingTimerCount(), 0);
  } finally {
    keepwarm.reset();
    restore();
  }
});

test("a fallback-served request never arms and cancels an armed session", () => {
  const restore = withEnv({ ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "100000" });
  try {
    // Served by another provider (Z.AI): no Anthropic cache to warm.
    const fb = fakeRes();
    serveRequest({ sessionId: "sess-fallback", marker: "fb", res: fb, served: false, status: 200 });
    assert.equal(keepwarm.sessionCount(), 0, "a fallback-served main request must not arm");

    // An HTTP failure on the Anthropic lane must not arm either.
    const bad = fakeRes();
    serveRequest({ sessionId: "sess-500", marker: "err", res: bad, served: true, status: 500 });
    assert.equal(keepwarm.sessionCount(), 0, "a failed main request must not arm");

    // A session that WAS armed is dropped when a later request for it falls back.
    const ok = fakeRes();
    serveRequest({ sessionId: "sess-mix", marker: "ok", res: ok });
    assert.equal(keepwarm.sessionCount(), 1);
    const fb2 = fakeRes();
    serveRequest({ sessionId: "sess-mix", marker: "ok2", res: fb2, served: false, status: 200 });
    assert.equal(keepwarm.sessionCount(), 0, "a fallback-served request must stop the armed session");
    assert.equal(keepwarm.pendingTimerCount(), 0);
  } finally {
    keepwarm.reset();
    restore();
  }
});

test("a request without a session id never arms", () => {
  const restore = withEnv({ ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "100000" });
  try {
    const res = fakeRes();
    serveRequest({ sessionId: "", marker: "no-session", res });
    assert.equal(keepwarm.sessionCount(), 0);
  } finally {
    keepwarm.reset();
    restore();
  }
});

// ---------------------------------------------------------------------------
// the ping itself
// ---------------------------------------------------------------------------
test("ping fires after the idle window: max_tokens 0, stream false, rest byte-identical", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, {
    usage: { cache_read_input_tokens: 182065, cache_creation_input_tokens: 0 },
  }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "200", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-ping-abc", marker: "ping", res: fakeRes() });
    assert.equal(keepwarm.sessionCount(), 1);
    assert.equal(keepwarm.pendingTimerCount(), 1);
    await waitFor(() => fake.received.length >= 1, "the first ping");
    assert.equal(fake.received.length, 1, "exactly one ping in the idle window");

    const sent = fake.received[0];
    assert.equal(sent.path, "/v1/messages");
    assert.equal(sent.body.max_tokens, 0, "pre-warm must ask for zero output tokens");
    assert.equal(sent.body.stream, false, "pre-warm is not a stream");
    // Everything that makes a cache hit possible is byte-identical to real traffic.
    const original = JSON.parse(ceoOutbound("ping").toString("utf8"));
    for (const key of ["model", "thinking", "output_config", "system", "tools", "messages"]) {
      assert.deepEqual(sent.body[key], original[key], `ping ${key} must match real traffic`);
    }
    assert.equal(sent.body.system[0].cache_control.type, "ephemeral", "the cache breakpoint must survive");
    assert.equal(sent.headers["anthropic-beta"], "prompt-caching-2024-07-31");
    assert.equal(sent.headers.authorization, "Bearer sk-ant-redacted");
    // Re-armed: the session survives a hit and pings again on the next idle window.
    // (The timer is nulled while the response is in flight, so poll rather than pin it.)
    assert.equal(keepwarm.sessionCount(), 1);
    await waitFor(() => keepwarm.pendingTimerCount() === 1, "the re-armed timer");
    await waitFor(() => fake.received.length >= 2, "the re-armed second ping");
    assert.equal(keepwarm.sessionCount(), 1);
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("a new request cancels the pending ping and re-arms on the newer body", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, {
    usage: { cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 },
  }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "200", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-cancel", marker: "first", res: fakeRes() });
    await sleep(60);
    // A newer request arrives before the window elapses: it must cancel the first ping.
    serveRequest({ sessionId: "sess-cancel", marker: "second", res: fakeRes() });
    assert.equal(keepwarm.pendingTimerCount(), 1, "still exactly one pending ping after the new request");
    await waitFor(() => fake.received.length >= 2, "two pings of the re-armed session");
    // The first request armed a ping at t=0 that would have fired at t=200; the new request
    // at t=60 cancelled it, so both pings carry the NEW body and none carries the old one.
    assert.equal(fake.received.length, 2, "the cancelled ping must never be sent");
    for (const [i, sent] of fake.received.entries()) {
      assert.equal(sent.body.messages[0].content[0].text, "marker=second",
        `ping ${i} must replay the newest body, not the cancelled one`);
    }
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("a ping in flight when a newer request arrives does not re-arm on the old body", async () => {
  // The fake upstream holds the first ping open; a newer request for the same session
  // supersedes it, and the in-flight ping must not schedule another ping of the old body.
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const fake = await startFakeUpstream((req, res, count, entry) => {
    if (count === 1) {
      gate.then(() => jsonResponse(res, 200, {
        usage: { cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 },
      }));
      return undefined;
    }
    return jsonResponse(res, 200, {
      usage: { cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 },
    });
  });
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "60", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-inflight", marker: "stale", res: fakeRes() });
    await waitFor(() => fake.received.length >= 1, "the in-flight ping");
    serveRequest({ sessionId: "sess-inflight", marker: "fresh", res: fakeRes() });
    release();
    await waitFor(() => fake.received.length >= 3, "two pings of the new body");
    // Ping 0 was already on the wire when the newer request arrived — unavoidable. What must
    // never happen is the in-flight ping re-arming the superseded body afterwards.
    assert.equal(fake.received[0].body.messages[0].content[0].text, "marker=stale");
    for (const [i, sent] of fake.received.entries()) {
      if (i === 0) continue;
      assert.equal(sent.body.messages[0].content[0].text, "marker=fresh",
        `ping ${i} must not replay the superseded body`);
    }
    assert.equal(keepwarm.sessionCount(), 1);
    // With a 60 ms idle window a ping is often on the wire (timer cleared) at this instant;
    // poll for the re-armed timer instead of sampling once, and never accept more than one.
    await waitFor(() => keepwarm.pendingTimerCount() === 1, "exactly one live timer for the session");
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("429 stops the session for good", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 429, { type: "error" }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "40", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-429", marker: "429", res: fakeRes() });
    await sleep(400);
    assert.equal(fake.received.length, 1);
    assert.equal(keepwarm.sessionCount(), 0, "a 429 must stop pinging that session");
    assert.equal(keepwarm.pendingTimerCount(), 0);
    await sleep(200);
    assert.equal(fake.received.length, 1, "no retry storm after a 429");
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("the 12 h idle cap stops the session", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, {
    usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "80", KEEPWARM_MAX_IDLE_MS: "40",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-cap", marker: "cap", res: fakeRes() });
    await sleep(400);
    assert.equal(fake.received.length, 0, "no ping once the idle budget is spent");
    assert.equal(keepwarm.sessionCount(), 0, "the max-idle cap must stop the session");
    assert.equal(keepwarm.pendingTimerCount(), 0);
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("max_tokens 0 rejected with 400: one retry with 1, remembered for the session", async () => {
  const fake = await startFakeUpstream((req, res, count, entry) => {
    if (entry.body.max_tokens === 0) return jsonResponse(res, 400, { type: "error", error: { message: "max_tokens must be greater than 0" } });
    return jsonResponse(res, 200, { usage: { cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 } });
  });
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "150", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-400", marker: "400", res: fakeRes() });
    await waitFor(() => fake.received.length >= 2, "the max_tokens 1 retry");
    assert.equal(fake.received.length, 2, "exactly one retry after the 400");
    assert.equal(fake.received[0].body.max_tokens, 0);
    assert.equal(fake.received[1].body.max_tokens, 1, "the retry uses max_tokens 1");
    // The next ping in the same session must already know max_tokens 0 is refused.
    await waitFor(() => fake.received.length >= 3, "the re-armed ping after the retry");
    assert.equal(fake.received[2].body.max_tokens, 1, "the refusal must be remembered");
    assert.equal(keepwarm.sessionCount(), 1);
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("a repeated 400 after the retry stops the session", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 400, { type: "error" }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "40", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serveRequest({ sessionId: "sess-400-hard", marker: "hard", res: fakeRes() });
    await sleep(300);
    assert.equal(fake.received.length, 2, "exactly one retry with max_tokens 1");
    assert.equal(keepwarm.sessionCount(), 0, "a 4xx on the retry must stop the session");
    assert.equal(keepwarm.pendingTimerCount(), 0);
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("a cache-creation heavy ping is a miss: [KEEPWARM-MISS] and the session stops", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, {
    usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 180000 },
  }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "40", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  const logged = [];
  const realLog = console.log;
  console.log = (line) => { logged.push(String(line)); };
  try {
    serveRequest({ sessionId: "sess-miss", marker: "miss", res: fakeRes() });
    await sleep(300);
    const missLine = logged.find((l) => l.startsWith("[KEEPWARM-MISS]"));
    assert.ok(missLine, "a prefix miss must be logged");
    assert.match(missLine, /session=sess-mis/);
    assert.match(missLine, /cache_read=1000/);
    assert.match(missLine, /cache_creation=180000/);
    assert.match(missLine, /status=200/);
    assert.equal(keepwarm.sessionCount(), 0, "a cache miss must stop pinging that session");
    await sleep(200);
    assert.equal(fake.received.length, 1, "no further pings after a miss");
  } finally {
    console.log = realLog;
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("the keep-warm log line carries session, idle, usage and status", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, {
    usage: { cache_read_input_tokens: 182065, cache_creation_input_tokens: 12 },
  }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "40", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  const logged = [];
  const realLog = console.log;
  console.log = (line) => { logged.push(String(line)); };
  try {
    serveRequest({ sessionId: "abcdef0123456789", marker: "log", res: fakeRes() });
    await sleep(300);
    const line = logged.find((l) => l.startsWith("[KEEPWARM] "));
    assert.ok(line, "a successful ping must log [KEEPWARM]");
    assert.match(line, /session=abcdef01/);
    assert.match(line, /idle_min=0\.0/);
    assert.match(line, /cache_read=182065/);
    assert.match(line, /cache_creation=12/);
    assert.match(line, /status=200/);
    assert.equal(/Bearer|sk-ant/.test(logged.join("\n")), false, "credentials must never be logged");
  } finally {
    console.log = realLog;
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("a transport error stops the session without touching real traffic", async () => {
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "30", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_TIMEOUT_MS: "500", KEEPWARM_UPSTREAM_URL: "http://127.0.0.1:1/v1/messages",
  });
  const logged = [];
  const realLog = console.log;
  console.log = (line) => { logged.push(String(line)); };
  try {
    serveRequest({ sessionId: "sess-econn", marker: "err", res: fakeRes() });
    await sleep(400);
    assert.equal(keepwarm.sessionCount(), 0, "a connect error must stop the session");
    assert.equal(keepwarm.pendingTimerCount(), 0);
    assert.equal(logged.filter((l) => l.startsWith("[KEEPWARM] ")).length, 0,
      "an errored ping logs no usage line");
  } finally {
    console.log = realLog;
    keepwarm.reset();
    restore();
  }
});

test("at most 8 sessions are tracked, LRU evicted", () => {
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "100000", KEEPWARM_MAX_SESSIONS: "8",
  });
  try {
    for (let i = 0; i < 8; i += 1) serveRequest({ sessionId: `sess-lru-${i}`, marker: `lru${i}`, res: fakeRes() });
    assert.equal(keepwarm.sessionCount(), 8);
    assert.equal(keepwarm.pendingTimerCount(), 8);
    serveRequest({ sessionId: "sess-lru-new", marker: "new", res: fakeRes() });
    assert.equal(keepwarm.sessionCount(), 8, "the cap holds at 8 sessions");
    assert.equal(keepwarm.sessions.has("sess-lru-0"), false, "the least recently touched session is evicted");
    assert.equal(keepwarm.pendingTimerCount(), 8, "the evicted session's timer is cleared");
  } finally {
    keepwarm.reset();
    restore();
  }
});

// ---------------------------------------------------------------------------
// G1 fixes: I7a path guard, I7b zero-read miss
// ---------------------------------------------------------------------------
test("I7a: a /v1/messages/count_tokens request never arms or replaces the stored body", () => {
  const restore = withEnv({ ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "100000" });
  try {
    // Arm the session with a real /v1/messages request first.
    const ok = fakeRes();
    serveRequest({ sessionId: "sess-ct", marker: "real", res: ok });
    assert.equal(keepwarm.sessionCount(), 1);
    const stored = keepwarm.sessions.get("sess-ct");
    const storedBody = Buffer.from(stored.body);
    const storedTimer = stored.timer;

    // A count_tokens call for the SAME session: not an arm, no supersede, no body swap.
    const ct = fakeRes();
    const armed = keepwarm.observe({
      sessionId: "sess-ct", role: "main-orchestrator", res: ct, body: ceoOutbound("count-tokens"),
      headers: {}, path: "/v1/messages/count_tokens", method: "POST",
      outcome: () => ({ served: true, status: 200 }),
    });
    ct.finish(200);
    assert.equal(armed, false, "count_tokens must not arm a session");
    const after = keepwarm.sessions.get("sess-ct");
    assert.ok(after, "the real session must survive a count_tokens request");
    assert.equal(after.body, stored.body, "the stored ping body must not be replaced");
    assert.equal(after.timer, storedTimer, "the real session's ping must not be cancelled");
    assert.ok(storedBody.includes("marker=real"), "the stored prefix is still the messages request");

    // A count_tokens request with NO prior session must not create one either.
    const fresh = fakeRes();
    const freshArmed = keepwarm.observe({
      sessionId: "sess-ct-fresh", role: "main-orchestrator", res: fresh, body: ceoOutbound("x"),
      headers: {}, path: "/v1/messages/count_tokens", method: "POST",
      outcome: () => ({ served: true, status: 200 }),
    });
    fresh.finish(200);
    assert.equal(freshArmed, false);
    assert.equal(keepwarm.sessionCount(), 1, "no new session may come from count_tokens");
    assert.equal(keepwarm.pendingTimerCount(), 1);
  } finally {
    keepwarm.reset();
    restore();
  }
});

test("I7b: a 200 with no cache usage (0/0) is a miss: [KEEPWARM-MISS], no re-arm", async () => {
  // A response whose usage has no cache fields (here: {"input_tokens":N}) parses to
  // cache_read=0 / cache_creation=0 — the old predicate read that as a HIT and re-armed.
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, { input_tokens: 123456 }));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "40", KEEPWARM_MAX_IDLE_MS: "600000",
    KEEPWARM_UPSTREAM_URL: fake.url,
  });
  const logged = [];
  const realLog = console.log;
  console.log = (line) => { logged.push(String(line)); };
  try {
    serveRequest({ sessionId: "sess-zeroutil", marker: "zero", res: fakeRes() });
    await sleep(300);
    const missLine = logged.find((l) => l.startsWith("[KEEPWARM-MISS]"));
    assert.ok(missLine, "a usage-less 200 must log [KEEPWARM-MISS]");
    assert.match(missLine, /cache_read=0/);
    assert.match(missLine, /cache_creation=0/);
    assert.match(missLine, /status=200/);
    assert.equal(keepwarm.sessionCount(), 0, "a 0/0 response must drop the session as cache-miss");
    assert.equal(keepwarm.pendingTimerCount(), 0);
    await sleep(200);
    assert.equal(fake.received.length, 1, "no re-arm: exactly one ping ever");
  } finally {
    console.log = realLog;
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

// Live 2026-10-02 10:34: the ping replayed the client's `accept-encoding: gzip, br`, the
// reply came back compressed, JSON.parse failed silently and every ping read as 0/0.
for (const [label, alwaysCompress] of [["honours identity", false], ["ignores identity", true]]) {
  test(`keep-warm reads usage when the upstream ${label} (compressed replies decoded)`, async () => {
    const zlib = require("zlib");
    const fake = await startFakeUpstream((req, res) => {
      const payload = Buffer.from(JSON.stringify({
        usage: { cache_read_input_tokens: 150000, cache_creation_input_tokens: 0 },
      }));
      const wantsGzip = /gzip/.test(String(req.headers["accept-encoding"] || ""));
      if (alwaysCompress || wantsGzip) {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync(payload));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(payload);
    });
    const restore = withEnv({
      ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "40", KEEPWARM_MAX_IDLE_MS: "600000",
      KEEPWARM_UPSTREAM_URL: fake.url,
    });
    const logged = [];
    const realLog = console.log;
    console.log = (line) => { logged.push(String(line)); };
    try {
      serveRequest({ sessionId: `sess-enc-${alwaysCompress}`, marker: "enc", res: fakeRes() });
      await sleep(300);
      assert.equal(fake.received[0].headers["accept-encoding"], "identity");
      const hit = logged.find((l) => l.startsWith("[KEEPWARM]"));
      assert.ok(hit, "the ping must log [KEEPWARM]");
      assert.match(hit, /cache_read=150000/);
      assert.ok(!logged.some((l) => l.startsWith("[KEEPWARM-MISS]")), "a decoded hit is not a miss");
    } finally {
      console.log = realLog;
      keepwarm.reset();
      restore();
      await stopUpstream(fake);
    }
  });
}
