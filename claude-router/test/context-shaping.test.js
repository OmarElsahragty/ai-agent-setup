"use strict";
/**
 * node --test for the D10/D11/D12 context-shaping levers.
 * Run: node --test ${AI_SETUP_ROOT}/claude-router/test/
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  pruneForCompaction,
  maskObservations,
  applyContextShaping,
  computeTurns,
  isTrivialRequest,
  fetchRetention,
  KEEP_TURNS,
  MASK_WARMUP_TURNS,
  MASK_BATCH_TURNS,
} = require("../context-shaping");

const FIXED_NOW = Date.parse("2026-10-02T04:00:00.000Z");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ctxshape-"));
}

// turn 0..turns-1; each turn = user text + assistant tool_use + user tool_result
function conversation(turns, filler) {
  const messages = [];
  for (let t = 0; t < turns; t += 1) {
    messages.push({ role: "user", content: [{ type: "text", text: `instruction ${t}` }] });
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `tu_${t}`, name: "Bash", input: { command: `echo ${t}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu_${t}`, content: filler ? filler(t) : `x`.repeat(500) }],
    });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "create a detailed summary of the conversation so far" }] });
  return { model: "claude-opus-5-5", max_tokens: 4096, messages };
}

function opts(dir, extra = {}) {
  return { sessionId: "sess-test", nowMs: FIXED_NOW, archiveDir: dir, archiveName: "sess-test-fixed.jsonl", ...extra };
}

function toolPairs(body) {
  const uses = new Set();
  const results = new Set();
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") uses.add(b.id);
      if (b.type === "tool_result") results.add(b.tool_use_id);
    }
  }
  return { uses, results };
}

// ---------------------------------------------------------------- flags off

test("flags off → applyContextShaping returns the identical body object", async () => {
  for (const k of ["ROUTER_D10_PRUNE", "ROUTER_D11_EFFORT", "ROUTER_D12_MASK"]) delete process.env[k];
  const body = conversation(12);
  const snapshot = JSON.parse(JSON.stringify(body));
  const out = await applyContextShaping({ headers: {} }, body, { reason: "main-orchestrator" }, "main-orchestrator");
  assert.deepEqual(out.body, snapshot);
  assert.equal(out.effort, null);
  assert.equal(out.body, body, "fail-open: same object reference when nothing is enabled");
});

test("flags on but role not eligible → body deep-equals input", async () => {
  process.env.ROUTER_D12_MASK = "1";
  process.env.ROUTER_D10_PRUNE = "1";
  try {
    const body = conversation(30);
    const snapshot = JSON.parse(JSON.stringify(body));
    const out = await applyContextShaping({ headers: {} }, body, { reason: "implementer" }, "implementer");
    assert.deepEqual(out.body, snapshot);
  } finally {
    delete process.env.ROUTER_D12_MASK;
    delete process.env.ROUTER_D10_PRUNE;
  }
});

// ---------------------------------------------------------------- D10

test("D10: user messages and the last 8 turns are byte-identical", () => {
  const dir = tmpDir();
  const body = conversation(20);
  const r = pruneForCompaction(body, opts(dir));
  assert.ok(r.prunedChars > 0, "expected pruning to happen");

  const next = r.body.messages;
  // every user text message survives verbatim
  for (let i = 0; i < body.messages.length; i += 1) {
    const before = body.messages[i];
    const after = next[i];
    const isUserText = before.role === "user" && Array.isArray(before.content) &&
      before.content.some((b) => b.type === "text");
    if (isUserText) assert.deepEqual(after, before, `user text message ${i} changed`);
  }
  // the last KEEP_TURNS turns (tool_result bodies included) survive verbatim
  const { turns, totalTurns } = computeTurns(body.messages);
  const keepFrom = totalTurns - KEEP_TURNS;
  for (let i = 0; i < body.messages.length; i += 1) {
    if (turns[i] >= keepFrom) assert.deepEqual(next[i], body.messages[i], `turn ${turns[i]} message ${i} changed`);
  }
  // and something older was actually pruned
  assert.notDeepEqual(next.slice(0, keepFrom * 3), body.messages.slice(0, keepFrom * 3));
});

test("D10: tool_use/tool_result pairing stays valid", () => {
  const dir = tmpDir();
  const r = pruneForCompaction(conversation(20), opts(dir));
  const { uses, results } = toolPairs(r.body);
  assert.deepEqual([...uses].sort(), [...results].sort());
  assert.equal(uses.size, 20);
});

test("D10: archive file is written with the original contents", () => {
  const dir = tmpDir();
  const body = conversation(20, (t) => `ORIGINAL-OUTPUT-${t}-`.repeat(10));
  const r = pruneForCompaction(body, opts(dir));
  assert.ok(r.archive.endsWith("sess-test-fixed.jsonl"));
  assert.ok(fs.existsSync(r.archive), "archive file must exist on disk");
  const lines = fs.readFileSync(r.archive, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, r.archived);
  for (const rec of lines) {
    assert.match(rec.content, /^ORIGINAL-OUTPUT-\d+-/);
    assert.equal(rec.chars, rec.content.length);
    // every archived record corresponds to a replaced block in the output
    assert.match(r.body.messages[rec.i].content[rec.b].content, /^\[pruned: \d+ chars, archive .*#\d+\.\d+\]$/);
  }
});

test("D10: writes a written file_path message and an exit-status message verbatim", () => {
  const dir = tmpDir();
  const body = conversation(20);
  // turn 2: an Edit tool_use (written file path) — far outside the keep window
  body.messages[2 * 3 + 1].content[0] = {
    type: "tool_use", id: "tu_edit", name: "Edit",
    input: { file_path: "${AI_SETUP_ROOT}/claude-router/server.js" },
  };
  // the paired tool_result must carry the same id, or it is an orphan and the pairing rule
  // has nothing to follow
  body.messages[2 * 3 + 2].content[0].tool_use_id = "tu_edit";
  body.messages[2 * 3 + 2].content[0].content = "edited successfully";
  // turn 4: a command result carrying its exit status
  body.messages[4 * 3 + 2].content[0].content = "npm test\n→ exit code 1\nFAILED 3 tests";

  const r = pruneForCompaction(body, opts(dir));
  assert.deepEqual(r.body.messages[2 * 3 + 1], body.messages[2 * 3 + 1], "file_path tool_use must stay");
  assert.deepEqual(r.body.messages[2 * 3 + 2], body.messages[2 * 3 + 2], "its tool_result must stay");
  assert.deepEqual(r.body.messages[4 * 3 + 2], body.messages[4 * 3 + 2], "exit-code output must stay");
  // an ordinary old result in the same conversation is still pruned
  assert.match(r.body.messages[1 * 3 + 2].content[0].content, /^\[pruned: /);
});

test("D10: idempotent — re-running on the output prunes nothing more", () => {
  const dir = tmpDir();
  const once = pruneForCompaction(conversation(20), opts(dir));
  const twice = pruneForCompaction(once.body, opts(dir, { archiveName: "second.jsonl" }));
  assert.equal(twice.prunedChars, 0);
  assert.deepEqual(twice.body, once.body);
});

test("D10: short conversation is returned untouched", () => {
  const dir = tmpDir();
  const body = conversation(3);
  const r = pruneForCompaction(body, opts(dir));
  assert.deepEqual(r.body, body);
  assert.equal(r.prunedChars, 0);
  assert.equal(fs.existsSync(path.join(dir, "sess-test-fixed.jsonl")), false, "no archive written when nothing pruned");
});

test("D10: malformed input fails open", () => {
  const dir = tmpDir();
  for (const bad of [null, undefined, 42, "str", [], { messages: "nope" }, { messages: [] }]) {
    const r = pruneForCompaction(bad, opts(dir));
    assert.equal(r.body, bad, "must return the input unchanged");
    assert.equal(r.prunedChars, 0);
  }
});

test("D10: unwritable archive directory fails open", () => {
  // ENOTDIR is the deterministic failure here. Do NOT use /proc: recursive mkdir under procfs
  // blocks forever on this host instead of returning EACCES, which hangs the whole suite.
  const dir = tmpDir();
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const body = conversation(20);
  const r = pruneForCompaction(body, { ...opts(path.join(blocker, "sub")) });
  assert.equal(r.body, body, "archive failure must forward the original body");
  assert.equal(r.prunedChars, 0);
});

test("D10: decide retention hint never overrides a hard keep", async () => {
  const dir = tmpDir();
  const body = conversation(20);
  // drop hint on a user text message and on the last turn: both are hard keeps
  const r = pruneForCompaction(body, opts(dir, { retention: { keep: [], drop: [0, 18] } }));
  assert.deepEqual(r.body.messages[0], body.messages[0], "user text message survives the drop hint");
  assert.deepEqual(r.body.messages[18], body.messages[18], "last-8-turn message survives the drop hint");
});

// ---------------------------------------------------------------- D12

test("D12: boundary only advances at multiples of 20", () => {
  const dir = tmpDir();
  // conversation(n) ends with a summary user message, so it is n+1 real turns.
  const boundaryFor = (n) => Math.floor((n + 1) / MASK_BATCH_TURNS) * MASK_BATCH_TURNS;
  for (const n of [18, 19, 20, 21, 38, 39, 40, 41, 59, 60]) {
    const r = maskObservations(conversation(n), opts(dir, { archiveName: `b${n}.jsonl` }));
    assert.equal(r.boundary, boundaryFor(n), `boundary for ${n} helper turns`);
    assert.equal(r.boundary % MASK_BATCH_TURNS, 0, "boundary is always a multiple of 20");
  }
  // The property that protects the cache: inside one batch the boundary never moves.
  const b19 = maskObservations(conversation(19), opts(dir, { archiveName: "x1.jsonl" })).boundary;
  const b20 = maskObservations(conversation(20), opts(dir, { archiveName: "x2.jsonl" })).boundary;
  const b37 = maskObservations(conversation(37), opts(dir, { archiveName: "x3.jsonl" })).boundary;
  const b38 = maskObservations(conversation(38), opts(dir, { archiveName: "x4.jsonl" })).boundary;
  const b39 = maskObservations(conversation(39), opts(dir, { archiveName: "x5.jsonl" })).boundary;
  assert.equal(b19, b20, "turn counts 20 and 21 sit in the same batch");
  assert.equal(b37, b38, "turn counts 38 and 39 sit in the same batch");
  assert.ok(b39 > b38, "crossing a multiple of 20 does move the boundary");
});

test("D12: masks only tool_results older than the 10-turn warm-up", () => {
  const dir = tmpDir();
  const body = conversation(60);
  const r = maskObservations(body, opts(dir));
  const { turns, totalTurns } = computeTurns(body.messages);
  const cutoff = Math.floor(totalTurns / MASK_BATCH_TURNS) * MASK_BATCH_TURNS - MASK_WARMUP_TURNS;
  for (let i = 0; i < body.messages.length; i += 1) {
    const b = body.messages[i].content[0];
    if (b.type !== "tool_result") continue;
    const masked = /^\[masked: /.test(r.body.messages[i].content[0].content);
    if (turns[i] < cutoff) assert.ok(masked, `turn ${turns[i]} (i=${i}) should be masked`);
    else assert.deepEqual(r.body.messages[i], body.messages[i], `turn ${turns[i]} (i=${i}) must be verbatim`);
  }
  assert.ok(r.masked > 0);
});

test("D12: idempotent — masking twice is byte-identical and archives nothing more", () => {
  const dir = tmpDir();
  const once = maskObservations(conversation(60), opts(dir, { archiveName: "once.jsonl" }));
  const sizeAfterOnce = fs.statSync(once.archive).size;
  const twice = maskObservations(once.body, opts(dir, { archiveName: "twice.jsonl" }));
  assert.equal(twice.masked, 0);
  assert.deepEqual(twice.body, once.body);
  assert.equal(fs.existsSync(path.join(dir, "twice.jsonl")), false, "second pass must not write an archive");
  assert.equal(fs.statSync(once.archive).size, sizeAfterOnce);
});

test("D12: the cached prefix is unchanged across turns inside one batch", () => {
  const dir = tmpDir();
  const a = conversation(40);
  const b = conversation(40);
  // one more turn, still inside the same 20-turn batch
  b.messages.push({ role: "user", content: [{ type: "text", text: "next instruction" }] });
  b.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tu_x", name: "Bash", input: {} }] });
  b.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_x", content: "y".repeat(10) }] });

  // Same archive name for both passes: the stub text is a pure function of the turn, so the whole
  // masked prefix comes out byte-identical — that prefix is exactly what Anthropic re-reads from cache.
  const ra = maskObservations(a, opts(dir, { archiveName: "shared.jsonl" }));
  const rb = maskObservations(b, opts(dir, { archiveName: "shared.jsonl" }));
  assert.equal(ra.boundary, rb.boundary, "boundary must not move inside a batch");
  const prefixLen = 30;
  assert.deepEqual(
    rb.body.messages.slice(0, prefixLen),
    ra.body.messages.slice(0, prefixLen),
    "masked prefix must be byte-identical so the CEO cache prefix survives",
  );
});

test("D12: error / exit outputs are kept verbatim", () => {
  const dir = tmpDir();
  const body = conversation(60, (t) =>
    t % 3 === 0 ? `Traceback (most recent call last):\n  File "x"\nValueError: boom` :
    t % 3 === 1 ? "npm test\n→ exit 0" :
    `output ${t}`);
  const r = maskObservations(body, opts(dir));
  for (let t = 0; t < 60; t += 1) {
    const i = t * 3 + 2;
    if (t % 3 !== 2) {
      assert.deepEqual(r.body.messages[i], body.messages[i], `turn ${t} result must stay verbatim`);
    }
  }
});

test("D12: malformed input fails open", () => {
  const dir = tmpDir();
  for (const bad of [null, 7, [], { messages: null }]) {
    const r = maskObservations(bad, opts(dir));
    assert.equal(r.body, bad);
    assert.equal(r.masked, 0);
  }
});

// ---------------------------------------------------------------- wiring

test("applyContextShaping: D12 does not touch a subagent or a compaction request", async () => {
  process.env.ROUTER_D12_MASK = "1";
  const dir = tmpDir();
  process.env.ROUTER_ARCHIVE_DIR = dir;
  try {
    const sub = conversation(60);
    const s1 = await applyContextShaping({ headers: {} }, sub, { reason: "implementer" }, "implementer");
    assert.deepEqual(s1.body, sub);

    const comp = conversation(60);
    comp.messages[comp.messages.length - 1].content[0].text = "create a detailed summary of the conversation so far";
    const s2 = await applyContextShaping({ headers: {} }, comp, { reason: "compaction" }, "compaction");
    assert.deepEqual(s2.body, comp, "D12 must skip the compaction branch");
  } finally {
    delete process.env.ROUTER_D12_MASK;
    delete process.env.ROUTER_ARCHIVE_DIR;
  }
});

test("applyContextShaping: D10 runs only on the compaction branch and never mutates the input", async () => {
  process.env.ROUTER_D10_PRUNE = "1";
  process.env.ROUTER_D11_EFFORT = "0";
  const dir = tmpDir();
  process.env.ROUTER_ARCHIVE_DIR = dir;
  try {
    const body = conversation(20);
    const snapshot = JSON.parse(JSON.stringify(body));
    const out = await applyContextShaping({ headers: { "x-claude-code-session-id": "sess-abc" } }, body, { reason: "compaction" }, "compaction");
    assert.notDeepEqual(out.body, snapshot, "compaction branch must be pruned");
    assert.deepEqual(body, snapshot, "input body must not be mutated");
  } finally {
    delete process.env.ROUTER_D10_PRUNE;
    delete process.env.ROUTER_ARCHIVE_DIR;
  }
});

test("decide daemon unreachable → fetchRetention null and isTrivialRequest false (fail-open)", async () => {
  const nullish = await fetchRetention("some head", { decideUrl: "http://127.0.0.1:11438/v1/decide", decideTimeoutMs: 300 });
  assert.equal(nullish, null);
  assert.equal(await isTrivialRequest("hi", { decideUrl: "http://127.0.0.1:11438/v1/decide", decideTimeoutMs: 300 }), false);
});

test("session id falls back to a stable hash when the header is absent", () => {
  const { sessionIdFor } = require("../context-shaping");
  const body = conversation(2);
  const a = sessionIdFor({}, body);
  const b = sessionIdFor({}, body);
  assert.equal(a, b, "hash must be stable for the same conversation");
  assert.match(a, /^h[0-9a-f]{16}$/);
  assert.equal(sessionIdFor({ "x-claude-code-session-id": "sess/../evil id" }, body), "sess-..-evil-id");
});