// H1/H2 (2026-10-10), ported to OpenCode Go 2026-10-11: fallback error composition, doomed-hop
// detection, OpenCode Go 429 terminal/transient discrimination, the OpenCode Go egress semaphore,
// the fallback badge state file, and the wire-level hop rules for 400 / 401 / 429 (WO-S3).
// NOTE: credential-shaped fixtures are assembled at runtime (concatenation), never inline.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./d5-harness");
const {
  composeBothProvidersError,
  anthropicHopViable,
  isTerminalOgo429,
  updateFallbackBadge,
  decodeProxyBody,
  routerRequestHandler,
  __ogoEgressTestHook,
  __fallbackBudgetTestHook,
} = require("../server.js");

const ANT_PREFIX = ["sk", "ant"].join("-"); // assembled: secret-write-guard-safe
const GO_KEY = ["go", "unit", "placeholder"].join("-"); // OpenCode Go key stand-in, assembled at runtime
const GO_KEY_ENV = ["OPENCODE", "GO", "API", "KEY"].join("_"); // env var NAME only; the value is GO_KEY

test("composeBothProvidersError names every cause", () => {
  assert.match(
    composeBothProvidersError(["claude-opus-5-5: status=429", "deepseek-v4.1-flash: status=429"]),
    /^both providers unavailable \(claude-opus-5-5: status=429; deepseek-v4\.1-flash: status=429\)$/
  );
});

test("composeBothProvidersError tolerates missing causes", () => {
  assert.strictEqual(composeBothProvidersError([]), "both providers unavailable");
  assert.strictEqual(composeBothProvidersError(undefined), "both providers unavailable");
});

test("anthropicHopViable: OAuth bearer is viable", () => {
  assert.strictEqual(anthropicHopViable({ authorization: "Bearer whatever" }), true);
});

test("anthropicHopViable: anthropic console key is viable", () => {
  assert.strictEqual(anthropicHopViable({ "x-api-key": ANT_PREFIX + "-api03-unit-test" }), true);
});

test("anthropicHopViable: a non-Anthropic key alone is doomed (negative control)", () => {
  assert.strictEqual(anthropicHopViable({ "x-api-key": ["abcdef0123456789abcdef0123456789", "xyz"].join(".") }), false);
});

test("anthropicHopViable: no credentials at all is doomed", () => {
  assert.strictEqual(anthropicHopViable({}), false);
  assert.strictEqual(anthropicHopViable(undefined), false);
});

// Fix pass 2026-10-10: handleAnthropic forwards the CLIENT's headers, so a router-held key never
// rescues a non-Anthropic-keyed client (counting it would send that key to api.anthropic.com).
test("anthropicHopViable: router-held key does NOT make a non-Anthropic-keyed hop viable", () => {
  const had = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = ANT_PREFIX + "-router-held-unit-test";
  try {
    assert.strictEqual(anthropicHopViable({ "x-api-key": "not-anthropic-shaped" }), false);
    assert.strictEqual(anthropicHopViable({}), false);
  } finally {
    if (had === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = had;
  }
});

// R3 (2026-10-10), ported 2026-10-11 to the OpenCode Go 429 vocabulary (opencode.ai/docs/go, checked
// 2026-10-11). Account-window refusals and a drained pooled account are TERMINAL and hop at once; a
// plain upstream "Too many requests" or a congestion rate_limit_error is TRANSIENT and retries.
const GO_WINDOW_MESSAGE = "Weekly usage limit reached. Resets in 1 day.";

test("isTerminalOgo429: GoUsageLimitError (account window spent) is terminal", () => {
  assert.strictEqual(
    isTerminalOgo429(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: GO_WINDOW_MESSAGE } })),
    true
  );
});

test("isTerminalOgo429: FreeUsageLimitError is terminal", () => {
  assert.strictEqual(
    isTerminalOgo429(JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } })),
    true
  );
});

test("isTerminalOgo429: 'insufficient balance' (drained pooled account) is terminal", () => {
  assert.strictEqual(isTerminalOgo429('{"type":"error","error":{"message":"Insufficient balance. Top up to continue."}}'), true);
});

test("isTerminalOgo429: 'usage limit reached' and 'limit exhausted' wording are terminal", () => {
  assert.strictEqual(isTerminalOgo429('{"error":{"message":"usage limit reached"}}'), true);
  assert.strictEqual(isTerminalOgo429('{"error":{"message":"limit exhausted"}}'), true);
});

test("isTerminalOgo429: plain 'Too many requests' is transient", () => {
  assert.strictEqual(
    isTerminalOgo429('{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}'),
    false
  );
});

test("isTerminalOgo429: congestion rate_limit_error retries", () => {
  assert.strictEqual(
    isTerminalOgo429('{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}'),
    false
  );
});

test("isTerminalOgo429: empty/absent body is treated as transient (fail toward retry)", () => {
  assert.strictEqual(isTerminalOgo429(""), false);
  assert.strictEqual(isTerminalOgo429(undefined), false);
});

// R5 (2026-10-10, ported 2026-10-11): OpenCode Go egress semaphore: FIFO handoff, bounded in-flight.
test("ogoEgress semaphore: FIFO handoff, slot transfers on release", async () => {
  const hook = __ogoEgressTestHook;
  hook.reset();
  const order = [];
  const ran = (n) => new Promise((resolve) => {
    // every acquire runs immediately at default cap 4 in a fresh state
    hook.acquire(() => { order.push("run" + n); resolve(); });
  });
  await Promise.all([ran(1), ran(2), ran(3)]);
  assert.deepEqual(order, ["run1", "run2", "run3"]);

  // fill to cap, next acquire must WAIT until a release hands it the slot
  hook.reset();
  const seq = [];
  hook.acquire(() => seq.push("a"));   // slot 1
  hook.acquire(() => seq.push("b"));   // slot 2
  hook.acquire(() => seq.push("c"));   // slot 3
  hook.acquire(() => seq.push("d"));   // slot 4 (cap)
  let queuedRan = false;
  hook.acquire(() => { queuedRan = true; seq.push("queued"); });
  assert.strictEqual(queuedRan, false); // still waiting
  hook.release();                        // a's slot transfers to the queued job
  assert.strictEqual(queuedRan, true);
  assert.deepEqual(seq, ["a", "b", "c", "d", "queued"]);
  hook.reset();
});

test("ogoEgress: a queue timeout never frees a slot it did not hold", async () => {
  const hook = __ogoEgressTestHook;
  hook.reset();
  for (let i = 0; i < 4; i++) hook.acquire(() => {});            // fill the default cap of 4
  const err = await new Promise((resolve) => hook.acquire((e) => resolve(e), 20));
  assert.match(String(err && err.message), /opencode_go_egress_queue_timeout/);
  assert.deepEqual(hook.state(), { active: 4, queued: 0 });       // cap still fully held
  hook.reset();
});

test("ogoEgress: cancelling a queued request withdraws it without touching the active count", () => {
  const hook = __ogoEgressTestHook;
  hook.reset();
  for (let i = 0; i < 4; i++) hook.acquire(() => {});
  let ran = false;
  const queued = hook.acquire(() => { ran = true; });
  assert.strictEqual(queued.granted, false);
  hook.cancel(queued);
  assert.deepEqual(hook.state(), { active: 4, queued: 0 });
  hook.release();                                                 // frees a real slot
  assert.strictEqual(ran, false);                                 // the cancelled job never runs
  assert.deepEqual(hook.state(), { active: 3, queued: 0 });
  hook.reset();
});

test("ogoEgress: the main lane (priority) is granted before earlier queued subagents", () => {
  const hook = __ogoEgressTestHook;
  hook.reset();
  for (let i = 0; i < 4; i++) hook.acquire(() => {});
  const order = [];
  hook.acquire(() => order.push("sub"), 60000, false);
  hook.acquire(() => order.push("main"), 60000, true);
  hook.release();
  assert.deepEqual(order, ["main"]);
  hook.reset();
});

test("ogoEgress: a throwing queued job is contained and its slot is freed", () => {
  const hook = __ogoEgressTestHook;
  hook.reset();
  for (let i = 0; i < 4; i++) hook.acquire(() => {});
  hook.acquire(() => { throw new Error("boom"); });
  assert.doesNotThrow(() => hook.release());
  assert.deepEqual(hook.state(), { active: 3, queued: 0 });
  hook.reset();
});

// Badge state: the override path keeps tests off the live /run file.
test("updateFallbackBadge: writes on fallback, clears on primary, replaces a planted symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "badge-"));
  const file = path.join(dir, "fallback-state.json");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "keep");
  const had = process.env.CLAUDE_ROUTER_FALLBACK_STATE;
  process.env.CLAUDE_ROUTER_FALLBACK_STATE = file;
  try {
    fs.symlinkSync(victim, file);
    updateFallbackBadge("deepseek-v4.1-flash");
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "keep");   // symlink target untouched
    assert.strictEqual(fs.lstatSync(file).isSymbolicLink(), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).model, "deepseek-v4.1-flash");
    updateFallbackBadge(undefined);
    assert.strictEqual(fs.existsSync(file), false);
  } finally {
    if (had === undefined) delete process.env.CLAUDE_ROUTER_FALLBACK_STATE;
    else process.env.CLAUDE_ROUTER_FALLBACK_STATE = had;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("decodeProxyBody: a gzip bomb is capped instead of inflating unbounded", () => {
  const zlib = require("node:zlib");
  const bomb = zlib.gzipSync(Buffer.alloc(8 << 20));               // 8 MiB of zeros, ~8 KiB compressed
  const out = decodeProxyBody(bomb, { "content-encoding": "gzip" });
  assert.ok(out.length < (2 << 20), `decoded ${out.length} bytes`);
  assert.strictEqual(decodeProxyBody(zlib.gzipSync(Buffer.from("ok")), { "content-encoding": "gzip" }), "ok");
});

// ---------------------------------------------------------------------------------------------
// WO-S3 wire rules (2026-10-11). Each case drives routerRequestHandler over a loopback server; the
// D5 harness stubs https.request (opencode.ai and api.anthropic.com only), so nothing leaves the machine.
const GO_REGIONS_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This model requires Global regions for your workspace." } });
const GO_SESSION_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "MissingSessionID" } });
const GO_AUTH_401 = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid api key" } });
const GO_TOO_MANY_429 = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many requests" } });
const ANT_NONLENGTH_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content: text content blocks must be non-empty" } });
const ANT_LENGTH_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } });
const SUBAGENT = { "x-subagent-name": "implementer" };
const chatBody = (marker) => ({
  model: "claude-opus-5-5",
  max_tokens: 64,
  stream: false,
  messages: [{ role: "user", content: `marker=${marker}` }],
  tools: [{ name: "Bash", input_schema: { type: "object" } }],
});
const jsonAnswer = (status, body) => ({ status, contentType: "application/json", body });

async function withWire(answers, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-wire-"));
  const restoreEnv = H.withEnv({
    [GO_KEY_ENV]: GO_KEY,
    ROUTER_USAGE_LOG: path.join(tmp, "router-usage.jsonl"),
    CLAUDE_ROUTER_FALLBACK_STATE: path.join(tmp, "fallback-state.json"),
  });
  const up = H.installUpstreams(answers);
  const log = H.captureConsole();
  __fallbackBudgetTestHook.reset();
  const srv = await H.startRouter(routerRequestHandler);
  try {
    await fn({ srv, up, logs: log.lines });
  } finally {
    await H.stopRouter(srv);
    __fallbackBudgetTestHook.reset();
    log.restore();
    up.restore();
    restoreEnv();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("wire: Go 400 'requires Global regions' hops once to claude-haiku-5-5 and the client is served", async () => {
  await withWire({ ogo: () => jsonAnswer(400, GO_REGIONS_400), anthropic: () => H.anthropicOk() }, async ({ srv, up, logs }) => {
    const r = await H.send(srv, { headers: SUBAGENT, body: chatBody("regions") });
    assert.equal(r.status, 200);
    assert.deepEqual(up.markers("ogo"), ["regions"]);
    assert.equal(up.anthropic.length, 1, "exactly one Anthropic hop");
    assert.equal(up.anthropic[0].body.model, "claude-haiku-5-5");
    assert.ok(logs.some((l) => l.includes("cause=status=400 lane_refusal")), "hop cause is the lane refusal");
  });
});

test("wire: Go 400 MissingSessionID is lane policy: it hops once to claude-haiku-5-5", async () => {
  await withWire({ ogo: () => jsonAnswer(400, GO_SESSION_400), anthropic: () => H.anthropicOk() }, async ({ srv, up, logs }) => {
    const r = await H.send(srv, { headers: SUBAGENT, body: chatBody("session") });
    assert.equal(r.status, 200);
    assert.deepEqual(up.markers("ogo"), ["session"]);
    assert.equal(up.anthropic.length, 1, "exactly one Anthropic hop");
    assert.equal(up.anthropic[0].body.model, "claude-haiku-5-5");
    assert.ok(logs.some((l) => l.includes("cause=status=400 lane_refusal")), "hop cause is the lane refusal");
  });
});

test("wire: Go 401 is replayed to the client and never hops (a bad key must fail loudly)", async () => {
  await withWire({ ogo: () => jsonAnswer(401, GO_AUTH_401), anthropic: () => H.anthropicOk() }, async ({ srv, up }) => {
    const r = await H.send(srv, { headers: SUBAGENT, body: chatBody("auth401") });
    assert.equal(r.status, 401);
    assert.equal(r.text, GO_AUTH_401);
    assert.equal(up.ogo.length, 1);
    assert.equal(up.anthropic.length, 0, "no Anthropic hop for a 401");
  });
});

test("wire: Anthropic-lane non-length 400 is still replayed to the client, no hop", async () => {
  await withWire({ ogo: () => H.ogoOk("never"), anthropic: () => jsonAnswer(400, ANT_NONLENGTH_400) }, async ({ srv, up }) => {
    const r = await H.send(srv, { body: chatBody("ant400") });
    assert.equal(r.status, 400);
    assert.equal(r.text, ANT_NONLENGTH_400);
    assert.equal(up.anthropic.length, 1);
    assert.equal(up.ogo.length, 0, "a non-length Anthropic 400 never reaches OpenCode Go");
  });
});

test("wire (negative control): an Anthropic-primary subagent lane's length 400 still hops to OpenCode Go", async () => {
  // Owner ruling 2026-10-11: the MAIN lane carries no fallback any more, so the Anthropic -> OpenCode Go
  // length-refusal hop is exercised through a lane that still has one (a ROLE_PLAN override with an
  // Anthropic primary and a deepseek-* fallback: the swapped-lane branch in routerRequestHandler).
  const had = process.env.ROLE_PLAN_IMPLEMENTER;
  process.env.ROLE_PLAN_IMPLEMENTER = "anthropic:claude-opus-5-5:deepseek-v4.1-flash:max";
  try {
    await withWire({ ogo: () => H.ogoOk("length-hop"), anthropic: () => jsonAnswer(400, ANT_LENGTH_400) }, async ({ srv, up }) => {
      const r = await H.send(srv, { headers: SUBAGENT, body: chatBody("length-hop") });
      assert.equal(r.status, 200);
      assert.match(r.text, /served-by-ogo length-hop/);
      assert.equal(up.anthropic.length, 1);
      assert.equal(up.anthropic[0].body.model, "claude-opus-5-5");
      assert.deepEqual(up.markers("ogo"), ["length-hop"]);
    });
  } finally {
    if (had === undefined) delete process.env.ROLE_PLAN_IMPLEMENTER;
    else process.env.ROLE_PLAN_IMPLEMENTER = had;
  }
});

test("wire: a MAIN-lane length 400 never hops (owner ruling 2026-10-11): the upstream body is replayed", async () => {
  await withWire({ ogo: () => H.ogoOk("never-forged"), anthropic: () => jsonAnswer(400, ANT_LENGTH_400) }, async ({ srv, up }) => {
    const r = await H.send(srv, { body: chatBody("main-length") });
    assert.equal(r.status, 400, "the real Anthropic status, not a synthetic 502");
    assert.equal(r.text, ANT_LENGTH_400, "and the real Anthropic body, byte for byte");
    assert.equal(up.anthropic.length, 1);
    assert.equal(up.ogo.length, 0, "the main lane never reaches OpenCode Go");
  });
});

test("wire: a terminal GoUsageLimitError 429 is not retried: one OpenCode Go call, then the Haiku hop", async () => {
  await withWire({ ogo: () => H.ogo429(), anthropic: () => H.anthropicOk() }, async ({ srv, up }) => {
    const r = await H.send(srv, { headers: SUBAGENT, body: chatBody("window429") });
    assert.equal(r.status, 200);
    assert.equal(up.ogo.length, 1, "terminal 429: no retry");
    assert.equal(up.anthropic[0].body.model, "claude-haiku-5-5");
  });
});

test("wire: a transient 'Too many requests' 429 is retried before the Haiku hop", async () => {
  await withWire({ ogo: () => jsonAnswer(429, GO_TOO_MANY_429), anthropic: () => H.anthropicOk() }, async ({ srv, up, logs }) => {
    const r = await H.send(srv, { headers: SUBAGENT, body: chatBody("congested") });
    assert.equal(r.status, 200);
    // OPENCODE_GO_429_MAX_ATTEMPTS defaults to 3; the test only pins "more than one attempt".
    assert.ok(up.ogo.length >= 2, `transient 429 is retried, got ${up.ogo.length} OpenCode Go call(s)`);
    assert.ok(logs.some((l) => l.includes("[RETRY-429]")), "retry logged");
    assert.equal(up.anthropic[0].body.model, "claude-haiku-5-5");
  });
});

test("wire: a replayed refusal is framed for the bytes the router sends, never by the raw upstream headers", async () => {
  // Gate fix 2026-10-11: the replayed body can be a CAPPED buffer, so the upstream content-length
  // (the full body) and hop-by-hop headers must not describe it. Only the allowlisted headers go out,
  // and the content-length is recomputed from the bytes actually written.
  const BODY = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum — truncated copy" },
  });
  const raw = {
    status: 400,
    contentType: "application/json",
    body: BODY,
    headers: { "content-length": "9999", "transfer-encoding": "chunked", "x-upstream-trace": "must-not-replay", "retry-after": "7" },
  };
  await withWire({ ogo: () => H.ogoOk("never-forged"), anthropic: () => raw }, async ({ srv, up }) => {
    const r = await H.send(srv, { body: chatBody("replay-framing") });
    assert.equal(r.status, 400, "the real Anthropic status");
    assert.equal(r.text, BODY, "and the real Anthropic body, byte for byte");
    assert.equal(up.anthropic.length, 1);
    assert.equal(r.headers["content-length"], String(Buffer.byteLength(BODY)), "framing matches the replayed bytes");
    assert.equal(r.headers["retry-after"], "7", "an upstream retry hint survives the replay");
    assert.equal(r.headers["transfer-encoding"], undefined, "no raw hop-by-hop header is replayed");
    assert.ok(!("x-upstream-trace" in r.headers), "no raw upstream header is replayed");
  });
});
