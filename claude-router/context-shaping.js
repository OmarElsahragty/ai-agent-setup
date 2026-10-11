/**
 * context-shaping.js — D10 compaction pruning, D12 observation masking, D11 CEO effort hint.
 *
 * Three independent levers, all default OFF behind env flags so prod behaviour is unchanged until
 * the owner flips a line in .env:
 *
 *   ROUTER_D10_PRUNE=1  pruneForCompaction()  — compaction branch only. Keeps every user text
 *                        message, the last KEEP_TURNS turns, and any message naming a written
 *                        file path or carrying an `→ exit` / `exit code` marker; replaces the
 *                        remaining tool_result bodies with `[pruned: N chars, archive <path>#<i>]`
 *                        and archives the originals to a JSONL side file.
 *   ROUTER_D12_MASK=1   maskObservations()     — main-orchestrator, non-compaction only. Old
 *                        tool_result bodies become a one-line stub + archive pointer (JetBrains
 *                        "The Complexity Trap", arXiv 2508.21433: masking halves agent cost). The
 *                        cutoff is quantised to 20-turn batches so the cached prefix changes at
 *                        most once per 20 turns — without that, rewriting history every turn
 *                        would destroy the 98.6% CEO cache-hit baseline (baseline-20261002.md).
 *   ROUTER_D11_EFFORT=1 applyEffortHint()      — main-orchestrator only. Asks the local decide
 *                        daemon whether the last user message is `trivial` with conf ≥ 0.9 and, if
 *                        so, drops the CEO turn to effort=medium.
 *
 * Optional retention scoring (D10) and the complexity probe (D11) both call the local decide
 * daemon at POST /v1/decide with a 300 ms timeout. The daemon does not exist yet (ledger B1), so
 * every call is expected to fail: the shaping functions are written to be pure and synchronous,
 * and the caller passes an already-resolved hint. Daemon down → deterministic rules only.
 *
 * Invariants:
 * - Fail-open. Any throw returns the caller's original body untouched.
 * - Pairing. tool_use / tool_result halves are never dropped: only the *content* of a
 *   tool_result block is rewritten, so every tool_use_id still has exactly one tool_result.
 * - Deterministic. Same input bytes → same output bytes; no clock, no randomness, no locale
 *   dependence in the rewritten body (the archive path is passed in by the caller).
 * - No secrets are ever read, logged or written.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEEP_TURNS = 8;             // D10: turns never pruned
const MASK_WARMUP_TURNS = 10;     // D12: never mask anything newer than this
const MASK_BATCH_TURNS = 20;      // D12: the boundary advances at most once per 20 turns
const PRUNE_STUB_PREFIX = "[pruned:";
const MASK_STUB_PREFIX = "[masked:";
const DEFAULT_DECIDE_URL = "http://127.0.0.1:11438/v1/decide";
const DEFAULT_DECIDE_TIMEOUT_MS = 300;
// Template host: AI_SETUP_ROOT wins, else the repo root this file lives in (one level above claude-router/).
const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT || path.resolve(__dirname, "..");
const DEFAULT_ARCHIVE_DIR = path.join(AI_SETUP_ROOT, "state", "compaction-archive");

// A tool_result that carries any of these is never rewritten: the first token of a failure or a
// command's exit status is the load-bearing part of an agent trajectory.
const SIGNIFICANT_RESULT = /(→\s*exit\b|exit code|traceback|failed|\berror\b)/i;

function flags() {
  const num = (name, dflt) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    d10: process.env.ROUTER_D10_PRUNE === "1",
    d11: process.env.ROUTER_D11_EFFORT === "1",
    d12: process.env.ROUTER_D12_MASK === "1",
    archiveDir: process.env.ROUTER_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR,
    decideUrl: process.env.ROUTER_DECIDE_URL || DEFAULT_DECIDE_URL,
    decideTimeoutMs: num("ROUTER_DECIDE_TIMEOUT_MS", DEFAULT_DECIDE_TIMEOUT_MS),
  };
}

/** True when a user message only carries tool results (the assistant's answer coming back). */
function isToolResultCarrier(msg) {
  return Array.isArray(msg?.content) && msg.content.some((b) => b && b.type === "tool_result");
}

/**
 * Turn index per message. A turn starts at every user message that is NOT a tool_result carrier:
 * in the Anthropic wire format one agentic turn is user instruction → assistant tool_use →
 * user tool_result, and counting the tool_result carrier as a new turn would triple every count
 * (and make "the last 8 turns" mean the last 2.7 real turns). Deterministic, no inference.
 */
function computeTurns(messages) {
  const turns = new Array(messages.length);
  let turn = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg && msg.role === "user" && !isToolResultCarrier(msg)) turn += 1;
    turns[i] = turn;
  }
  return { turns, totalTurns: turn + 1 };
}

/** Flatten a tool_result body (string or [{type:"text",text}]) to plain text. */
function resultText(block) {
  const content = block && block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isUserTextMessage(msg) {
  if (!msg || msg.role !== "user") return false;
  if (typeof msg.content === "string") return msg.content.length > 0;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.length > 0);
}

/** Walks every content block of every message: fn(msgIndex, blockIndex, block, msg) */
function eachBlock(messages, fn) {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j += 1) {
      fn(i, j, msg.content[j], msg);
    }
  }
}

/**
 * Structural copy of a message's content. The blocks themselves must be copied, not just the
 * array: rewriting `block.content` on a shared block object would mutate the caller's body, which
 * is the same object the router forwards upstream (and the one the "flags off" invariant holds).
 */
function copyBlocks(msg) {
  if (!Array.isArray(msg?.content)) return msg ? msg.content : msg;
  return msg.content.map((b) => (b && typeof b === "object" && !Array.isArray(b) ? { ...b } : b));
}

function messageMentionsWrittenFile(msg) {
  if (!msg || !Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && b.type === "tool_use" && typeof b.input === "object" && b.input !== null && typeof b.input.file_path === "string");
}

function safeSegment(value, fallback) {
  const cleaned = String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return cleaned || fallback;
}

/** `<session>-<ts>.jsonl`; ts has no colons so the name is shell-safe. */
function archiveName(sessionId, nowMs) {
  const ts = new Date(nowMs === undefined ? Date.now() : nowMs).toISOString().replace(/[:.]/g, "-");
  return `${safeSegment(sessionId, "sess")}-${ts}.jsonl`;
}

/** Session id from the CLI header, else a stable hash of the conversation seed. */
function sessionIdFor(headers, body) {
  const fromHeader = String((headers || {})["x-claude-code-session-id"] || "").trim();
  if (fromHeader) return safeSegment(fromHeader, "sess");
  const first = Array.isArray(body?.messages) ? body.messages[0] : null;
  const seed = `${JSON.stringify((first && first.content) || "")}|${JSON.stringify(body?.system || "")}`;
  return "h" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * Appends records to the archive JSONL. Throws on any failure — the caller must then abandon the
 * rewrite rather than drop tool output that was never written down.
 */
function writeArchive(dir, name, records) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(path.join(dir, name), lines, { encoding: "utf8", mode: 0o600 });
}

function jsonSize(body) {
  try {
    return JSON.stringify(body).length;
  } catch {
    return 0;
  }
}

/**
 * D10. Returns the original body when it must not be pruned (short conversation, no user text,
 * unusable shape, archive write failure, decide hint absent). Never mutates the input.
 *
 * retention (optional, from the decide daemon): { keep: [msgIndex], drop: [msgIndex] }.
 * `keep` forces a message verbatim; `drop` forces a tool_result rewrite. Neither can override the
 * hard keeps below, and neither can break pairing because only tool_result content is rewritten.
 */
function pruneForCompaction(body, options = {}) {
  const unchanged = { body, prunedChars: 0, charsBefore: 0, charsAfter: 0, archive: null, archived: 0 };
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return unchanged;
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return unchanged;

    const { turns, totalTurns } = computeTurns(messages);
    const keepFrom = Math.max(0, totalTurns - KEEP_TURNS);
    const hintKeep = new Set((options.retention?.keep || []).map(Number).filter(Number.isInteger));
    const hintDrop = new Set((options.retention?.drop || []).map(Number).filter(Number.isInteger));

    // Pass 1: per message, hardKeep (never prunable) vs advisory keeps.
    // Hard keeps: user text, the last KEEP_TURNS turns, any written file_path, unusable shape.
    // hintKeep can additionally rescue a message; hintDrop can override hintKeep ONLY — a hard
    // keep always wins, so the daemon can never make the model forget a path it must report.
    const keepMessage = new Array(messages.length).fill(true);
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      const hardKeep = isUserTextMessage(msg) ||
        turns[i] >= keepFrom ||
        messageMentionsWrittenFile(msg) ||
        !Array.isArray(msg.content);
      if (hardKeep) {
        keepMessage[i] = true;
      } else if (hintDrop.has(i)) {
        keepMessage[i] = false;
      } else if (hintKeep.has(i)) {
        keepMessage[i] = true;
      } else {
        keepMessage[i] = false;
      }
    }

    // Pass 1b: pairing. A kept tool_use protects its tool_result, and a kept tool_result protects
    // its tool_use, iterated to a fixed point: an assistant tool_use and the user message carrying
    // its result are SEPARATE messages, so keeping only the tool_use side would leave the model
    // with "I edited /path/server.js" and a stub saying nothing happened.
    const protectedUseIds = new Set();
    const protect = (i) => {
      const blocks = messages[i]?.content;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block?.type === "tool_use" && typeof block.id === "string") protectedUseIds.add(block.id);
      }
    };
    for (let i = 0; i < messages.length; i += 1) if (keepMessage[i]) protect(i);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < messages.length; i += 1) {
        if (keepMessage[i]) continue;
        const blocks = messages[i]?.content;
        if (!Array.isArray(blocks)) continue;
        let needed = false;
        for (const block of blocks) {
          if (!block) continue;
          if (block.type === "tool_use" && protectedUseIds.has(block.id)) needed = true;
          if (block.type === "tool_result" && protectedUseIds.has(block.tool_use_id)) needed = true;
        }
        if (!needed) continue;
        keepMessage[i] = true;
        protect(i);
        changed = true;
      }
    }

    // Pass 2: collect the tool_result bodies that will be replaced.
    const targets = [];
    eachBlock(messages, (i, j, block) => {
      if (!block || block.type !== "tool_result") return;
      if (keepMessage[i]) return;
      const text = resultText(block);
      if (SIGNIFICANT_RESULT.test(text)) return;      // exit status / error output stays
      if (text.startsWith(PRUNE_STUB_PREFIX) || text.startsWith(MASK_STUB_PREFIX)) return; // idempotency
      if (text.length === 0) return;
      targets.push({ msgIndex: i, blockIndex: j, chars: text.length, text });
    });
    if (targets.length === 0) return unchanged;

    const charsBefore = jsonSize(body);
    const name = options.archiveName || archiveName(options.sessionId || "sess", options.nowMs);
    const archivePath = path.join(options.archiveDir || DEFAULT_ARCHIVE_DIR, name);
    const records = targets.map((t) => ({
      i: t.msgIndex,
      b: t.blockIndex,
      turn: turns[t.msgIndex],
      chars: t.chars,
      content: t.text,
    }));
    // Archive FIRST: never drop content that was not durably written.
    writeArchive(options.archiveDir || DEFAULT_ARCHIVE_DIR, name, records);

    const next = messages.map((msg) => ({ ...msg, content: copyBlocks(msg) }));
    let prunedChars = 0;
    for (const t of targets) {
      const block = next[t.msgIndex].content[t.blockIndex];
      block.content = `${PRUNE_STUB_PREFIX} ${t.chars} chars, archive ${archivePath}#${t.msgIndex}.${t.blockIndex}]`;
      prunedChars += t.chars;
    }
    const out = { ...body, messages: next };
    return {
      body: out,
      prunedChars,
      charsBefore,
      charsAfter: jsonSize(out),
      archive: archivePath,
      archived: targets.length,
    };
  } catch (err) {
    return unchanged;
  }
}

/**
 * D12. tool_result bodies older than MASK_WARMUP_TURNS turns become a one-line stub + archive
 * pointer, but the cutoff only advances at multiples of MASK_BATCH_TURNS so the cached prefix is
 * stable for 20 turns at a time.
 *
 * Idempotent: an already-stubbed block is recognised and left alone, so re-running on the output
 * is a byte-level no-op.
 */
function maskObservations(body, options = {}) {
  const unchanged = { body, masked: 0, charsBefore: 0, charsAfter: 0, archive: null, boundary: 0 };
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return unchanged;
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return unchanged;

    const { turns, totalTurns } = computeTurns(messages);
    const boundary = Math.floor(totalTurns / MASK_BATCH_TURNS) * MASK_BATCH_TURNS;
    const cutoff = boundary - MASK_WARMUP_TURNS;
    if (cutoff <= 0) return { ...unchanged, boundary };

    const targets = [];
    eachBlock(messages, (i, j, block) => {
      if (!block || block.type !== "tool_result") return;
      if (turns[i] >= cutoff) return;
      const text = resultText(block);
      if (SIGNIFICANT_RESULT.test(text)) return;
      if (text.startsWith(PRUNE_STUB_PREFIX) || text.startsWith(MASK_STUB_PREFIX)) return;
      if (text.length === 0) return;
      targets.push({ msgIndex: i, blockIndex: j, chars: text.length, text });
    });
    if (targets.length === 0) return { ...unchanged, boundary };

    const charsBefore = jsonSize(body);
    const name = options.archiveName || archiveName(options.sessionId || "sess", options.nowMs);
    const archivePath = path.join(options.archiveDir || DEFAULT_ARCHIVE_DIR, name);
    writeArchive(options.archiveDir || DEFAULT_ARCHIVE_DIR, name, targets.map((t) => ({
      i: t.msgIndex,
      b: t.blockIndex,
      turn: turns[t.msgIndex],
      chars: t.chars,
      content: t.text,
    })));

    const next = messages.map((msg) => ({ ...msg, content: copyBlocks(msg) }));
    for (const t of targets) {
      next[t.msgIndex].content[t.blockIndex].content =
        `${MASK_STUB_PREFIX} ${t.chars} chars, archive ${archivePath}#${t.msgIndex}.${t.blockIndex}]`;
    }
    const out = { ...body, messages: next };
    return { body: out, masked: targets.length, charsBefore, charsAfter: jsonSize(out), archive: archivePath, boundary };
  } catch (err) {
    return unchanged;
  }
}

/** Reads the decide daemon's answer without ever throwing. Returns null when unreachable. */
async function decide(payload, options = {}) {
  const cfg = flags();
  const url = options.decideUrl || cfg.decideUrl;
  const timeoutMs = options.decideTimeoutMs || cfg.decideTimeoutMs;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;   // daemon down / timeout → deterministic rules only
  }
}

/** POST /v1/decide { head, task: "retention" } → { keep: number[], drop: number[] } | null */
async function fetchRetention(head, options = {}) {
  const raw = await decide({ head, task: "retention" }, options);
  if (!raw || typeof raw !== "object") return null;
  const node = raw.retention && typeof raw.retention === "object" ? raw.retention : raw;
  const keep = Array.isArray(node.keep) ? node.keep.map(Number).filter(Number.isInteger) : [];
  const drop = Array.isArray(node.drop) ? node.drop.map(Number).filter(Number.isInteger) : [];
  return keep.length || drop.length ? { keep, drop } : null;
}

/** POST /v1/decide { head, task: "complexity" } → "trivial" with conf ≥ 0.9, else null */
async function isTrivialRequest(head, options = {}) {
  const minConf = options.minConfidence === undefined ? 0.9 : options.minConfidence;
  const raw = await decide({ head, task: "complexity" }, options);
  if (!raw || typeof raw !== "object") return false;
  const node = raw.complexity && typeof raw.complexity === "object" ? raw.complexity : raw;
  const label = String(node.label || node.decision || "").toLowerCase();
  const conf = Number(node.confidence ?? node.conf ?? node.score);
  return label === "trivial" && Number.isFinite(conf) && conf >= minConf;
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
      if (text.trim()) return text;
    }
  }
  return "";
}

/**
 * Single entry point for the request handler. Returns { body, effort } and NEVER throws: an
 * exception anywhere leaves the caller's body untouched (fail-open).
 *
 * role/reason come from classifyRequest(). The role gate is the safety property: D12 and D11 must
 * not touch a subagent's context (its prompt cache is separate and its transcripts are short) and
 * must not touch the compaction request (which carries the history D10 exists to shrink).
 */
async function applyContextShaping(req, body, route, role, options = {}) {
  const out = { body, effort: null };
  try {
    const cfg = flags();
    if (!cfg.d10 && !cfg.d11 && !cfg.d12) return out;
    if (!body || typeof body !== "object" || Array.isArray(body)) return out;

    const isCompaction = route?.reason === "compaction" || role === "compaction";
    const isMain = route?.reason === "main-orchestrator" && role === "main-orchestrator";
    const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
    const sessionId = sessionIdFor(req?.headers, body);
    const base = { sessionId, nowMs, archiveDir: cfg.archiveDir };

    if (cfg.d10 && isCompaction) {
      let retention = null;
      try {
        const head = lastUserText(body).slice(0, 4000);
        if (head) retention = await fetchRetention(head, cfg);
      } catch { retention = null; }
      const r = pruneForCompaction(body, { ...base, retention });
      out.body = r.body;
      if (r.prunedChars > 0) {
        console.log(`[D10] pruned=${r.prunedChars} chars_before=${r.charsBefore} chars_after=${r.charsAfter} archive=${r.archive}`);
      }
    }

    if (cfg.d12 && isMain && !isCompaction) {
      const r = maskObservations(out.body, base);
      out.body = r.body;
      if (r.masked > 0) {
        console.log(`[D12] masked=${r.masked} boundary=${r.boundary} chars_before=${r.charsBefore} chars_after=${r.charsAfter}`);
      }
    }

    if (cfg.d11 && isMain && !isCompaction) {
      try {
        const head = lastUserText(out.body);
        if (head && (await isTrivialRequest(head, cfg))) {
          out.effort = "medium";
          console.log(`[D11] effort=medium role=${role} chars=${head.length}`);
        }
      } catch { /* fail-open */ }
    }
    return out;
  } catch (err) {
    return { body, effort: null };
  }
}

module.exports = {
  applyContextShaping,
  pruneForCompaction,
  maskObservations,
  sessionIdFor,
  fetchRetention,
  isTrivialRequest,
  decide,
  flags,
  computeTurns,
  KEEP_TURNS,
  MASK_WARMUP_TURNS,
  MASK_BATCH_TURNS,
  DEFAULT_DECIDE_URL,
  DEFAULT_ARCHIVE_DIR,
};