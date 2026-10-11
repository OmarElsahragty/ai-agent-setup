"use strict";
/**
 * WO-N1 / M-002 (owner ruling 2026-10-10): the Anthropic fallback budget for subagent/background
 * OpenCode Go lanes. Run: node --test test/
 *
 * routerRequestHandler runs on a loopback server and https.request is stubbed in-process, so no
 * request leaves the machine: opencode.ai answers per `up.ogoMode` (terminal GoUsageLimitError 429 or
 * a 200), and every api.anthropic.com stream is held open until the test releases it, so each held
 * stream pins exactly one fallback slot. Every assertion that separates the budget from the pre-change
 * router is behavioural (which requests reached which upstream, what each client received); the test
 * hook is only read after those.
 * NOTE: credential-shaped fixtures are assembled at runtime (concatenation), never inline.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLACEHOLDER = ["unit", "test", "placeholder"].join("-");
const CLIENT_AUTH = ["Bearer", PLACEHOLDER].join(" ");

// Module-level knobs must be set before server.js loads. https is stubbed: nothing is sent.
const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-budget-"));
process.env.ROUTER_USAGE_LOG = path.join(USAGE_DIR, "router-usage.jsonl");
process.env["OPENCODE_GO_" + "API_KEY"] = PLACEHOLDER;
process.env.OPENCODE_GO_BREAKER_COOLDOWN_MS = "300";
for (const k of ["OPENCODE_GO_SIMULATE_STATUS", "ROUTER_KEEPWARM", "SUBAGENT_PRIMARY", "ROLE_PLAN_IMPLEMENTER",
  "FALLBACK_MAX_CONCURRENT", "FALLBACK_QUEUE_MAX_WAIT_MS", "OPENCODE_GO_MAX_CONCURRENT", "OPENCODE_GO_BREAKER_FAILS"]) {
  delete process.env[k];
}

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const server = require("../server");
const { routerRequestHandler } = server;
const hook = server.__fallbackBudgetTestHook;
const egress = server.__ogoEgressTestHook;

after(() => fs.rmSync(USAGE_DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`timeout waiting for: ${what}`); })]);
}

const OGO_LIMIT = JSON.stringify({
  type: "error",
  error: { type: "GoUsageLimitError", message: "Weekly usage limit reached. Resets in 1 day." },
});
const SSE_START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n';
const SSE_END = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: [DONE]\n\n';

function installUpstreams() {
  const real = https.request;
  const up = { ogoMode: "fail", ogo: [], anthropic: [], ogoHeld: [] };
  https.request = function stubbedRequest(options, cb) {
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => { chunks.push(Buffer.from(c)); return true; };
    req.destroy = () => {};
    req.end = () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const marker = (/marker=([A-Za-z0-9_-]+)/.exec(text) || [])[1] || "?";
      const proxyRes = new PassThrough();
      if (options.hostname === "opencode.ai") {
        up.ogo.push(marker);
        if (up.ogoMode === "hold") { // answer (GoUsageLimitError 429, or up.holdStatus) only when the test releases it
          const st = up.holdStatus || 429;
          proxyRes.statusCode = st;
          proxyRes.headers = { "content-type": "application/json" };
          up.ogoHeld.push(() => { cb(proxyRes); proxyRes.end(st === 429 ? OGO_LIMIT : JSON.stringify({ error: { code: String(st) } })); });
          return req;
        }
        const ok = up.ogoMode === "ok";
        proxyRes.statusCode = ok ? 200 : 429;
        proxyRes.headers = { "content-type": "application/json" };
        const payload = ok
          ? JSON.stringify({ id: "ogo", content: [{ type: "text", text: `served-by-ogo ${marker}` }], usage: { input_tokens: 5, output_tokens: 3 } })
          : OGO_LIMIT;
        process.nextTick(() => { cb(proxyRes); proxyRes.end(payload); });
      } else {
        let ended = false;
        up.anthropic.push({ marker, release() { if (!ended) { ended = true; proxyRes.end(SSE_END); } } });
        proxyRes.statusCode = 200;
        proxyRes.headers = { "content-type": "text/event-stream" };
        process.nextTick(() => { cb(proxyRes); proxyRes.write(SSE_START); });
      }
      return req;
    };
    return req;
  };
  up.restore = () => { https.request = real; };
  up.releaseAll = () => { for (const a of up.anthropic) a.release(); };
  up.markers = () => up.anthropic.map((a) => a.marker);
  return up;
}

// lane: "subagent" (implementer, OpenCode Go primary), "main-deepseek" (DeepSeek CEO lane, OpenCode Go
// primary), "main" (the CEO's Anthropic-primary lane).
function sendTo(srv, { marker, lane = "subagent", signal }) {
  const headers = { "content-type": "application/json", authorization: CLIENT_AUTH };
  if (lane === "subagent") headers["x-subagent-name"] = "implementer";
  const model = lane === "main" ? "claude-opus-5-5" : "deepseek-v4.1-flash";
  const body = { model, max_tokens: 64, stream: true, messages: [{ role: "user", content: `marker=${marker}` }] };
  return fetch(`http://127.0.0.1:${srv.address().port}/v1/messages`, {
    method: "POST", headers, body: JSON.stringify(body), signal,
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

async function setup(env = {}) {
  if (hook) hook.reset();
  if (egress) egress.reset();
  const savedEnv = {};
  for (const [k, v] of Object.entries(env)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  const up = installUpstreams();
  const srv = http.createServer(routerRequestHandler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  const pending = [];
  return {
    up,
    logs,
    send(opts) {
      const p = sendTo(srv, opts);
      pending.push(p.catch(() => null));
      return p;
    },
    count: (prefix) => logs.filter((l) => l.startsWith(prefix)).length,
    async done() {
      up.releaseAll();
      await sleep(50);
      up.releaseAll(); // anything a release just granted
      await Promise.race([Promise.all(pending), sleep(2000)]);
      console.log = realLog;
      srv.closeAllConnections();
      srv.close();
      up.restore();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (hook) hook.reset();
      if (egress) egress.reset();
    },
  };
}

const QUEUED = "[FALLBACK-BUDGET] queued";

/** Fill both fallback slots with held subagent streams. */
async function fillSlots(t, a, b) {
  const pa = t.send({ marker: a });
  const pb = t.send({ marker: b });
  await waitFor(() => t.up.anthropic.length >= 2, "two subagent fallbacks on Anthropic");
  return [pa, pb];
}

/**
 * Send one more subagent request and wait until it either queued or hopped. Returns `{ response }`:
 * an async function returning the bare promise would make the caller's await adopt (and wait for) it.
 */
async function sendThird(t, marker, opts = {}) {
  const queuedBefore = t.count(QUEUED);
  const hopsBefore = t.up.anthropic.length;
  const response = t.send({ marker, ...opts });
  response.catch(() => null);
  await waitFor(() => t.count(QUEUED) > queuedBefore || t.up.anthropic.length > hopsBefore, `${marker} queued or hopped`);
  return { response };
}

test("cap: two concurrent subagent fallbacks hop to Anthropic, the third queues until a slot frees", async () => {
  const t = await setup();
  try {
    const [pa, pb] = await fillSlots(t, "capA", "capB");
    const { response: pc } = await sendThird(t, "capC");
    await sleep(100);
    assert.deepEqual(t.up.markers(), ["capA", "capB"], "the 3rd concurrent fallback must queue, not hop");
    assert.ok(t.up.ogo.includes("capC"), "the queued request tried OpenCode Go first");
    assert.ok(t.logs.some((l) => /^\[FALLBACK-BUDGET\] queued role=implementer .*cause=status=429/.test(l)), "one queued line");
    assert.deepEqual(hook.state(), { active: 2, queued: 1 });

    t.up.anthropic[0].release(); // A's stream ends -> its slot goes to C
    await waitFor(() => t.up.anthropic.length >= 3, "C granted when A's slot frees");
    assert.equal(t.up.anthropic[2].marker, "capC");
    assert.ok(t.logs.some((l) => /^\[FALLBACK-BUDGET\] granted role=implementer waited_ms=[1-9]\d* .*via=anthropic/.test(l)), "granted line after a wait");
    t.up.releaseAll();
    const results = await withTimeout(Promise.all([pa, pb, pc]), 3000, "all three responses");
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    await waitFor(() => hook.state().active === 0, "every slot freed");
  } finally {
    await t.done();
  }
});

test("main lane: never queued and never counted, even with the budget full", async () => {
  const t = await setup();
  try {
    await fillSlots(t, "mainA", "mainB");
    await sendThird(t, "mainC");
    await sleep(50);
    assert.ok(!t.up.markers().includes("mainC"), "the subagent request must wait");

    // The DeepSeek CEO lane (`claude --model deepseek-v4.1-flash`) falls back OpenCode Go -> Anthropic past the full budget.
    const pm1 = t.send({ marker: "mainDeepseek", lane: "main-deepseek" });
    await waitFor(() => t.up.markers().includes("mainDeepseek"), "main DeepSeek lane hops at once");
    // The CEO's Anthropic-primary lane is untouched by the budget.
    const pm2 = t.send({ marker: "mainOpus", lane: "main" });
    await waitFor(() => t.up.markers().includes("mainOpus"), "main Anthropic lane served at once");
    assert.ok(!t.up.markers().includes("mainC"), "the main lane went first; the subagent still waits");
    assert.ok(!t.logs.some((l) => l.startsWith(QUEUED) && l.includes("role=main-orchestrator")), "main is never queued");
    assert.deepEqual(hook.state(), { active: 2, queued: 1 }, "main holds no budget slot");

    // Main streams ending must not free a budget slot they never held.
    for (const a of t.up.anthropic.filter((x) => x.marker === "mainDeepseek" || x.marker === "mainOpus")) a.release();
    const [m1, m2] = await withTimeout(Promise.all([pm1, pm2]), 3000, "main responses");
    assert.equal(m1.status, 200);
    assert.equal(m2.status, 200);
    await sleep(100);
    assert.ok(!t.up.markers().includes("mainC"), "a main stream ending frees no subagent slot");

    t.up.anthropic[0].release();
    await waitFor(() => t.up.markers().includes("mainC"), "C granted on a real slot release");
  } finally {
    await t.done();
  }
});

test("FIFO: queued fallbacks are granted in arrival order", async () => {
  const t = await setup();
  try {
    await fillSlots(t, "fifoA", "fifoB");
    for (const m of ["fifoC", "fifoD", "fifoE"]) await sendThird(t, m);
    await sleep(50);
    assert.deepEqual(t.up.markers(), ["fifoA", "fifoB"], "C, D and E must all queue");
    assert.equal(hook.state().queued, 3);

    t.up.anthropic[0].release();
    await waitFor(() => t.up.anthropic.length >= 3, "first grant");
    t.up.anthropic[1].release();
    await waitFor(() => t.up.anthropic.length >= 4, "second grant");
    t.up.anthropic[2].release();
    await waitFor(() => t.up.anthropic.length >= 5, "third grant");
    assert.deepEqual(t.up.markers().slice(2), ["fifoC", "fifoD", "fifoE"]);
  } finally {
    await t.done();
  }
});

test("breaker close: queued fallbacks go back to OpenCode Go, and the usage log marks real fallbacks", async () => {
  const t = await setup();
  try {
    fs.rmSync(process.env.ROUTER_USAGE_LOG, { force: true });
    const [pa, pb] = await fillSlots(t, "drainA", "drainB");
    const { response: pc } = await sendThird(t, "drainC"); // 3rd consecutive OpenCode Go failure opens the breaker
    const { response: pd } = await sendThird(t, "drainD"); // breaker open: short-circuited, then queued
    await sleep(50);
    assert.deepEqual(t.up.markers(), ["drainA", "drainB"], "C and D must queue, not hop");
    assert.ok(!t.up.ogo.includes("drainD"), "D was short-circuited by the open breaker");
    assert.ok(hook.breaker.openUntil > 0, "the breaker is open");

    t.up.ogoMode = "ok";
    await waitFor(() => Date.now() >= hook.breaker.openUntil, "breaker cooldown elapsed", 2000);
    const probe = await withTimeout(t.send({ marker: "drainProbe" }), 3000, "probe response");
    assert.equal(probe.status, 200);
    const [rc, rd] = await withTimeout(Promise.all([pc, pd]), 3000, "drained responses");
    assert.equal(rc.status, 200);
    assert.match(rc.text, /served-by-ogo drainC/);
    assert.equal(rd.status, 200);
    assert.match(rd.text, /served-by-ogo drainD/);
    assert.deepEqual(t.up.markers(), ["drainA", "drainB"], "no drained request touched Anthropic");
    assert.ok(t.logs.some((l) => l.startsWith("[BREAKER] opencode-go closed")), "breaker closed");
    assert.equal(t.logs.filter((l) => /^\[FALLBACK-BUDGET\] granted role=implementer .*via=ogo/.test(l)).length, 2);
    assert.deepEqual(hook.state(), { active: 2, queued: 0 });

    t.up.releaseAll();
    await withTimeout(Promise.all([pa, pb]), 3000, "held fallbacks");
    await sleep(150); // usage lines are appended asynchronously on finish
    const recs = fs.readFileSync(process.env.ROUTER_USAGE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const anth = recs.filter((r) => r.upstream === "ANTHROPIC");
    const ogo = recs.filter((r) => r.upstream === "OPENCODE_GO");
    assert.equal(anth.length, 2);
    // Owner ruling 2026-10-10 (unchanged 2026-10-11): OpenCode Go subagent and background lanes fall back to claude-haiku-5-5 (max).
    assert.ok(anth.every((r) => r.fallback === 1 && r.model === "claude-haiku-5-5"), "fallback-served lines carry fallback=1");
    assert.equal(ogo.length, 3, "probe + two drained requests");
    assert.ok(ogo.every((r) => r.fallback === 0), "OpenCode Go-served lines carry fallback=0");
  } finally {
    await t.done();
  }
});

test("max wait: a queued fallback expires with the original OpenCode Go error", async () => {
  const t = await setup({ FALLBACK_QUEUE_MAX_WAIT_MS: "300" });
  try {
    await fillSlots(t, "waitA", "waitB");
    const { response: pc } = await sendThird(t, "waitC");
    await sleep(20);
    assert.deepEqual(t.up.markers(), ["waitA", "waitB"], "C must queue, not hop");
    const r = await withTimeout(pc, 3000, "the expired response");
    assert.equal(r.status, 429, "the original OpenCode Go status");
    assert.equal(r.text, OGO_LIMIT, "the original OpenCode Go error body, byte for byte");
    assert.ok(t.logs.some((l) => /^\[FALLBACK-BUDGET\] expired role=implementer waited_ms=\d+ .*status=429/.test(l)), "expired line");
    assert.deepEqual(t.up.markers(), ["waitA", "waitB"]);
    assert.deepEqual(hook.state(), { active: 2, queued: 0 });
  } finally {
    await t.done();
  }
});

test("FALLBACK_MAX_CONCURRENT=0: no subagent fallback reaches Anthropic; the main lane still falls back", async () => {
  const t = await setup({ FALLBACK_MAX_CONCURRENT: "0", FALLBACK_QUEUE_MAX_WAIT_MS: "300" });
  try {
    const { response: ps } = await sendThird(t, "zeroSub");
    await sleep(20);
    assert.ok(!t.up.markers().includes("zeroSub"), "cap 0: a subagent never hops to Anthropic");
    const r = await withTimeout(ps, 3000, "the expired response");
    assert.equal(r.status, 429);
    assert.equal(r.text, OGO_LIMIT);
    assert.ok(t.logs.some((l) => /^\[FALLBACK-BUDGET\] expired role=implementer .*active=0\/0/.test(l)));

    const pm = t.send({ marker: "zeroMain", lane: "main-deepseek" });
    await waitFor(() => t.up.markers().includes("zeroMain"), "the main lane still falls back");
    t.up.releaseAll();
    assert.equal((await withTimeout(pm, 3000, "main response")).status, 200);
    assert.equal(hook.config().maxConcurrent, 0);
  } finally {
    await t.done();
  }
});

test("a client that disconnects while queued is withdrawn and never reaches Anthropic", async () => {
  const t = await setup();
  try {
    await fillSlots(t, "goneA", "goneB");
    const ac = new AbortController();
    await sendThird(t, "goneC", { signal: ac.signal });
    await sleep(20);
    assert.deepEqual(t.up.markers(), ["goneA", "goneB"], "C must queue, not hop");
    ac.abort();
    await waitFor(() => t.logs.some((l) => /^\[FALLBACK-BUDGET\] withdrawn role=implementer .*reason=client_gone/.test(l)), "withdrawn line");
    t.up.anthropic[0].release();
    await sleep(100);
    assert.deepEqual(t.up.markers(), ["goneA", "goneB"], "a withdrawn request is never granted");
    assert.deepEqual(hook.state(), { active: 1, queued: 0 }, "no slot leaked");
    t.send({ marker: "goneD" });
    await waitFor(() => t.up.markers().includes("goneD"), "a fresh fallback takes the free slot at once");
  } finally {
    await t.done();
  }
});

// gate-2 tester: with the default 3 attempts a held 429 is retried and forward()'s older
// `if (res.destroyed) return` exits before onFail, so the 429 case alone cannot catch a regression in the
// fallback guards. The 403 case reaches onFail directly (FALLBACK_STATUS) and does.
for (const holdStatus of [429, 403])
test(`clients that abort while OpenCode Go is in flight never hop and never leak a slot (review-A blocker, OpenCode Go ${holdStatus})`, async () => {
  const t = await setup();
  try {
    t.up.ogoMode = "hold";
    t.up.holdStatus = holdStatus;
    const acs = [new AbortController(), new AbortController()];
    t.send({ marker: "abortA", signal: acs[0].signal });
    t.send({ marker: "abortB", signal: acs[1].signal });
    await waitFor(() => t.up.ogoHeld.length >= 2, "both requests in flight at OpenCode Go");
    for (const ac of acs) ac.abort();
    await sleep(50);
    for (const answer of t.up.ogoHeld.splice(0)) answer(); // OpenCode Go refuses after the clients left
    await sleep(100);
    assert.deepEqual(t.up.markers(), [], "an aborted client must not reach Anthropic");
    assert.deepEqual(hook.state(), { active: 0, queued: 0 }, "no fallback slot leaked");
    t.up.ogoMode = "fail";
    const [pa, pb] = await fillSlots(t, "aliveA", "aliveB");
    assert.deepEqual(t.up.markers(), ["aliveA", "aliveB"], "both slots are still available to live clients");
    t.up.releaseAll();
    const results = await withTimeout(Promise.all([pa, pb]), 3000, "live responses");
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
  } finally {
    await t.done();
  }
});

test("config: FALLBACK_MAX_CONCURRENT / FALLBACK_QUEUE_MAX_WAIT_MS parsing and defaults", () => {
  const saved = { c: process.env.FALLBACK_MAX_CONCURRENT, w: process.env.FALLBACK_QUEUE_MAX_WAIT_MS };
  try {
    const cases = [["", 2], ["0", 0], ["3", 3], ["-1", 2], ["abc", 2], ["1.5", 2]];
    for (const [raw, want] of cases) {
      process.env.FALLBACK_MAX_CONCURRENT = raw;
      assert.equal(hook.config().maxConcurrent, want, `FALLBACK_MAX_CONCURRENT=${JSON.stringify(raw)}`);
    }
    delete process.env.FALLBACK_MAX_CONCURRENT;
    assert.equal(hook.config().maxConcurrent, 2);
    delete process.env.FALLBACK_QUEUE_MAX_WAIT_MS;
    assert.equal(hook.config().maxWaitMs, 600000, "default max wait is 10 min");
    process.env.FALLBACK_QUEUE_MAX_WAIT_MS = "1500";
    assert.equal(hook.config().maxWaitMs, 1500);
    process.env.FALLBACK_QUEUE_MAX_WAIT_MS = "0";
    assert.equal(hook.config().maxWaitMs, 600000);
  } finally {
    if (saved.c === undefined) delete process.env.FALLBACK_MAX_CONCURRENT; else process.env.FALLBACK_MAX_CONCURRENT = saved.c;
    if (saved.w === undefined) delete process.env.FALLBACK_QUEUE_MAX_WAIT_MS; else process.env.FALLBACK_QUEUE_MAX_WAIT_MS = saved.w;
  }
});
