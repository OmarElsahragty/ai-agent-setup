"use strict";
/**
 * WO-6 cost visibility — usage extraction to router-usage.jsonl.
 * Run: node --test claude-router/test/*.test.js
 *
 * routerRequestHandler is driven over a real loopback HTTP server with https.request
 * stubbed in-process (same pattern as auth-headers.test.js); no request leaves the
 * machine. ROUTER_USAGE_LOG points at a temp file so the test never touches the real
 * ${AI_SETUP_ROOT}/state/router-usage.jsonl.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const zlib = require("node:zlib");

const { routerRequestHandler, normaliseUpstream, __resetUsageModeCheck, __fallbackBudgetTestHook, USAGE_LIMITS } = require("../server");
const H = require("./d5-harness");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mainBody(stream) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 64,
    stream,
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "ping" }],
  };
}

/**
 * Stub the upstream with a raw SSE payload delivered in several writes (exercises the
 * scanner's cross-chunk line reassembly). Records nothing but the call count.
 */
function stubUpstreamSse(status, sseText, chunkSize = 7) {
  const real = https.request;
  https.request = function patched(options, cb) {
    const proxyRes = new PassThrough({ decodeStrings: false });
    proxyRes.statusCode = status;
    proxyRes.headers = { "content-type": "text/event-stream" };
    const req = new EventEmitter();
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => {
        cb(proxyRes);
        for (let i = 0; i < sseText.length; i += chunkSize) {
          proxyRes.write(Buffer.from(sseText.slice(i, i + chunkSize), "utf8"));
        }
        proxyRes.end();
      });
      return req;
    };
    return req;
  };
  return {
    restore() { https.request = real; },
  };
}

/** Post a body through a loopback server running routerRequestHandler. */
async function post(handlerServer, body) {
  const res = await fetch(`http://127.0.0.1:${handlerServer.address().port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

function readLines(p) {
  try { return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; }
}

test("SSE response: exactly one usage line with correct numbers, bytes unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sse-"));
  const logPath = path.join(tmp, "router-usage.jsonl");
  process.env.ROUTER_USAGE_LOG = logPath;

  const sse = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"output_tokens":2,"cache_read_input_tokens":5000,"cache_creation_input_tokens":800}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":150}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":250}}',
    "",
    "event: message_stop",
    "data: [DONE]",
    "",
  ].join("\n");
  const expectedBytes = Buffer.from(sse, "utf8");

  const stub = stubUpstreamSse(200, sse);
  const handlerServer = http.createServer(routerRequestHandler);
  await new Promise((r) => handlerServer.listen(0, "127.0.0.1", r));
  try {
    const res = await post(handlerServer, mainBody(true));
    assert.equal(res.status, 200);
    assert.ok(res.bytes.equals(expectedBytes), "client bytes must be byte-identical to the upstream SSE payload");
    await sleep(150); // appendUsageLine is async and fires on 'finish'
    const lines = readLines(logPath);
    assert.equal(lines.length, 1, `exactly one jsonl line, got ${lines.length}`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.input, 100);
    assert.equal(rec.output, 250); // cumulative message_delta -> last/max wins
    assert.equal(rec.cache_read, 5000);
    assert.equal(rec.cache_creation, 800);
    assert.equal(rec.model, "claude-opus-5-5");
    assert.equal(rec.upstream, "ANTHROPIC");
    assert.equal(rec.status, 200);
    assert.equal(rec.role, "main-orchestrator");
    assert.equal(rec.fallback, 0, "WO-N1: a primary-served response carries fallback=0");
    assert.equal(typeof rec.ms, "number");
    assert.ok(rec.ts && rec.ts.endsWith("Z"));
    // WO-N1 (M-002) deliberately adds the `fallback` 0/1 marker: 11 -> 12 fields.
    // The owner ruling 2026-10-11 adds the `credential` marker: 12 -> 13 fields.
    assert.equal(Object.keys(rec).length, 13); // no extra fields, no content, no headers
    assert.ok(["oauth", "api_key", "router"].includes(rec.credential), `credential must come from the fixed vocabulary, got ${rec.credential}`);
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600, "WO-7 REQ4: usage log created with mode 0600");
  } finally {
    handlerServer.close();
    stub.restore();
    delete process.env.ROUTER_USAGE_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("non-streaming JSON response: usage line from the body-level usage object", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-json-"));
  const logPath = path.join(tmp, "router-usage.jsonl");
  process.env.ROUTER_USAGE_LOG = logPath;

  const payload = { id: "msg_2", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } };
  const real = https.request;
  https.request = function patched(options, cb) {
    const proxyRes = new PassThrough();
    proxyRes.statusCode = 200;
    proxyRes.headers = { "content-type": "application/json" };
    const req = new EventEmitter();
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => { cb(proxyRes); proxyRes.end(Buffer.from(JSON.stringify(payload), "utf8")); });
      return req;
    };
    return req;
  };
  const handlerServer = http.createServer(routerRequestHandler);
  await new Promise((r) => handlerServer.listen(0, "127.0.0.1", r));
  try {
    const res = await post(handlerServer, mainBody(false));
    assert.equal(res.status, 200);
    assert.ok(res.bytes.equals(Buffer.from(JSON.stringify(payload), "utf8")));
    await sleep(150);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.input, 42);
    assert.equal(rec.output, 17);
    assert.equal(rec.cache_read, 900);
    assert.equal(rec.cache_creation, 0);
  } finally {
    handlerServer.close();
    https.request = real;
    delete process.env.ROUTER_USAGE_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("NEGATIVE: unwritable log path — request still succeeds, no crash", async () => {
  process.env.ROUTER_USAGE_LOG = path.join(os.tmpdir(), "no-such-dir-usage", "router-usage.jsonl");
  const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\ndata: [DONE]\n\n';
  const stub = stubUpstreamSse(200, sse);
  const handlerServer = http.createServer(routerRequestHandler);
  await new Promise((r) => handlerServer.listen(0, "127.0.0.1", r));
  try {
    const res = await post(handlerServer, mainBody(true));
    assert.equal(res.status, 200);
    assert.ok(res.bytes.equals(Buffer.from(sse, "utf8")), "bytes unchanged even when logging fails");
    await sleep(150);
  } finally {
    handlerServer.close();
    stub.restore();
    delete process.env.ROUTER_USAGE_LOG;
  }
});

test("OpenAI-style usage (prompt/completion/cached_tokens) is mapped to the shared fields", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-openai-"));
  const logPath = path.join(tmp, "router-usage.jsonl");
  process.env.ROUTER_USAGE_LOG = logPath;
  const payload = { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 77, completion_tokens: 33, prompt_tokens_details: { cached_tokens: 40 } } };
  const real = https.request;
  https.request = function patched(options, cb) {
    const proxyRes = new PassThrough();
    proxyRes.statusCode = 200;
    proxyRes.headers = { "content-type": "application/json" };
    const req = new EventEmitter();
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => { cb(proxyRes); proxyRes.end(Buffer.from(JSON.stringify(payload), "utf8")); });
      return req;
    };
    return req;
  };
  const handlerServer = http.createServer(routerRequestHandler);
  await new Promise((r) => handlerServer.listen(0, "127.0.0.1", r));
  try {
    const res = await post(handlerServer, mainBody(false));
    assert.equal(res.status, 200);
    await sleep(150);
    const lines = readLines(logPath);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.input, 77);
    assert.equal(rec.output, 33);
    assert.equal(rec.cache_read, 40);
    assert.equal(rec.cache_creation, 0);
  } finally {
    handlerServer.close();
    https.request = real;
    delete process.env.ROUTER_USAGE_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("WO-7 REQ4: a pre-existing 0644 usage log is tightened to 0600 on the first append", async () => {
  __resetUsageModeCheck(); // the chmod is one-shot per process
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-mode-"));
  const logPath = path.join(tmp, "router-usage.jsonl");
  fs.writeFileSync(logPath, "{}\n"); // created with the default 0644 mode
  process.env.ROUTER_USAGE_LOG = logPath;
  const sse = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\ndata: [DONE]\n\n';
  const stub = stubUpstreamSse(200, sse);
  const handlerServer = http.createServer(routerRequestHandler);
  await new Promise((r) => handlerServer.listen(0, "127.0.0.1", r));
  try {
    const res = await post(handlerServer, mainBody(true));
    assert.equal(res.status, 200);
    await sleep(150);
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600, "existing log file must end up 0600");
  } finally {
    handlerServer.close();
    stub.restore();
    delete process.env.ROUTER_USAGE_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("WO-7 REQ4 / S2: upstream values are normalised to the fixed {OPENCODE_GO, ANTHROPIC} vocabulary", () => {
  assert.equal(normaliseUpstream("ANTHROPIC"), "ANTHROPIC");
  assert.equal(normaliseUpstream("anthropic"), "ANTHROPIC");
  assert.equal(normaliseUpstream("OPENCODE_GO"), "OPENCODE_GO");
  assert.equal(normaliseUpstream("opencode_go"), "OPENCODE_GO");
  assert.equal(normaliseUpstream("ZAI"), "OTHER", "a retired upstream is outside the vocabulary");
  assert.equal(normaliseUpstream("zai"), "OTHER");
  assert.equal(normaliseUpstream("DEEPSEEK"), "OTHER");
  assert.equal(normaliseUpstream("CAMEL"), "OTHER");
  assert.equal(normaliseUpstream("camelstream"), "OTHER");
  assert.equal(normaliseUpstream("OPENROUTER"), "OTHER");
  assert.equal(normaliseUpstream("deepseek-v4.1-flash"), "OTHER", "a model name is not an upstream");
  assert.equal(normaliseUpstream("glm-5.3"), "OTHER");
  assert.equal(normaliseUpstream(""), "OTHER");
  assert.equal(normaliseUpstream(undefined), "OTHER");
  assert.equal(normaliseUpstream(null), "OTHER");
});

test("WO-7 REQ4 / S2: a Go-served subagent logs upstream OPENCODE_GO; its Haiku hop logs ANTHROPIC with fallback=1", async () => {
  const GO_KEY_ENV = ["OPENCODE", "GO", "API", "KEY"].join("_");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-vocab-"));
  const logPath = path.join(tmp, "router-usage.jsonl");
  const restoreEnv = H.withEnv({
    ROUTER_USAGE_LOG: logPath,
    [GO_KEY_ENV]: ["go", "unit", "usage", "placeholder"].join("-"),
    CLAUDE_ROUTER_FALLBACK_STATE: path.join(tmp, "fallback-state.json"),
  });
  const regionsRefusal = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This model requires Global regions for your workspace." } });
  const up = H.installUpstreams({
    ogo: (entry) => (entry.marker === "vocab-hop" ? { status: 400, contentType: "application/json", body: regionsRefusal } : H.ogoOk("vocab")),
    anthropic: () => H.anthropicOk(),
  });
  __fallbackBudgetTestHook.reset();
  const srv = await H.startRouter(routerRequestHandler);
  try {
    const headers = { "x-subagent-name": "implementer" };
    const body = (marker) => ({
      model: "claude-opus-5-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: `marker=${marker}` }],
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
    });
    assert.equal((await H.send(srv, { headers, body: body("vocab-go") })).status, 200);
    assert.equal((await H.send(srv, { headers, body: body("vocab-hop") })).status, 200);
    await sleep(150); // appendUsageLine is async
    const recs = readLines(logPath).map((l) => JSON.parse(l));
    assert.equal(recs.length, 2, "one usage line per served response");
    const served = recs.find((r) => r.upstream === "OPENCODE_GO");
    const hopped = recs.find((r) => r.upstream === "ANTHROPIC");
    assert.ok(served && hopped, "both upstream values come from the fixed vocabulary");
    assert.equal(served.model, "deepseek-v4.1-flash");
    assert.equal(served.fallback, 0);
    assert.equal(served.credential, "router", "the OpenCode Go lane is served with the router's own credential");
    assert.equal(hopped.model, "claude-haiku-5-5");
    assert.equal(hopped.fallback, 1);
    assert.equal(hopped.credential, "oauth", "the Anthropic hop carries the client's OAuth bearer");
  } finally {
    await H.stopRouter(srv);
    __fallbackBudgetTestHook.reset();
    up.restore();
    restoreEnv();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WO-6 wire reproduction (2026-10-11): the CEO lane went Anthropic-primary and its usage
// lines stopped. handleAnthropic forwards the CLIENT's headers verbatim (server.js:721), so
// the client's `accept-encoding: gzip, br` (documented live in keepwarm.js:286) reaches
// api.anthropic.com and the streamed reply comes back content-encoded. createUsageScanner
// read those opaque bytes as UTF-8 text, found no `data:` lines and wrote nothing, while the
// OpenCode Go lane — which builds its own header allowlist without accept-encoding — kept
// logging. These tests drive routerRequestHandler over loopback with https.request stubbed
// (H.installUpstreams) and assert the token numbers AND that the bytes the client receives are
// the upstream bytes untouched.
// ---------------------------------------------------------------------------

/** The main lane's real request shape: Bearer client, streamed, tools present. */
function mainWireBody(stream) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 64,
    stream,
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "wire" }],
  };
}

/**
 * Raw loopback POST: returns the bytes the router actually put on the wire. fetch() is not used
 * here on purpose — it transparently decodes content-encoding, which would hide whether the
 * router altered (or re-encoded) the upstream bytes.
 */
function rawPost(srv, { body, headers = {} }) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: srv.address().port,
      path: "/v1/messages",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": payload.length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/** An Anthropic answer carrying the shared usage SSE, optionally content-encoded. */
function wiredAnthropic(encoding) {
  const plain = Buffer.from(H.SSE_OK, "utf8");
  const wire = encoding === "gzip" ? zlib.gzipSync(plain) : encoding ? zlib.brotliCompressSync(plain) : plain;
  return {
    plain,
    wire,
    // Replayed across several writes: the side copy must survive chunk boundaries, as it does live.
    answer: () => ({
      status: 200,
      contentType: "text/event-stream",
      headers: encoding ? { "content-encoding": encoding } : {},
      chunks: [wire.subarray(0, 1), wire.subarray(1, 5), wire.subarray(5)],
    }),
  };
}

async function withUsageLog(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-wire-"));
  const restoreEnv = H.withEnv({ ROUTER_USAGE_LOG: path.join(tmp, "router-usage.jsonl"), CLAUDE_ROUTER_FALLBACK_STATE: path.join(tmp, "fallback-state.json") });
  const logPath = path.join(tmp, "router-usage.jsonl");
  try {
    await fn(logPath);
  } finally {
    restoreEnv();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function usageRecords(logPath) {
  return readLines(logPath).map((l) => JSON.parse(l));
}

test("wire (a) main-lane SSE stream logs one usage line (credential=oauth) and the client bytes are untouched", async () => {
  await withUsageLog(async (logPath) => {
    const fixture = wiredAnthropic(null);
    const up = H.installUpstreams({ ogo: () => H.ogoOk("never-forged"), anthropic: () => fixture.answer() });
    const srv = await H.startRouter(routerRequestHandler);
    try {
      const r = await rawPost(srv, { body: mainWireBody(true), headers: { authorization: H.CLIENT_AUTH } });
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-type"], "text/event-stream");
      assert.ok(r.raw.equals(fixture.wire), "the client receives the upstream SSE bytes byte-identically");
      await H.waitFor(() => usageRecords(logPath).length >= 1, "the usage line");
      const recs = usageRecords(logPath);
      assert.equal(recs.length, 1, `exactly one usage line, got ${recs.length}`);
      const rec = recs[0];
      assert.equal(rec.role, "main-orchestrator");
      assert.equal(rec.upstream, "ANTHROPIC");
      assert.equal(rec.credential, "oauth", "the CEO's own bearer served it");
      assert.equal(rec.input, 11, "message_start input_tokens");
      assert.equal(rec.output, 7, "message_delta output_tokens");
      assert.ok(rec.input > 0 && rec.output > 0);
      assert.equal(rec.status, 200);
    } finally {
      await H.stopRouter(srv);
      up.restore();
    }
  });
});

test("wire (b) gzip- and br-encoded Anthropic SSE still logs usage (decoded side copy) and the client bytes are untouched", async () => {
  for (const encoding of ["gzip", "br"]) {
    await withUsageLog(async (logPath) => {
      const fixture = wiredAnthropic(encoding);
      const up = H.installUpstreams({ ogo: () => H.ogoOk("never-forged"), anthropic: () => fixture.answer() });
      const srv = await H.startRouter(routerRequestHandler);
      try {
        const r = await rawPost(srv, { body: mainWireBody(true), headers: { authorization: H.CLIENT_AUTH } });
        assert.equal(r.status, 200);
        assert.equal(r.headers["content-encoding"], encoding, "the upstream encoding is relayed as-is");
        assert.ok(r.raw.equals(fixture.wire), `${encoding}: the client receives the encoded upstream bytes byte-identically`);
        assert.ok(!r.raw.equals(fixture.plain), `${encoding}: the response really was encoded on the wire`);
        await H.waitFor(() => usageRecords(logPath).length >= 1, `${encoding}: the usage line`);
        const recs = usageRecords(logPath);
        assert.equal(recs.length, 1, `${encoding}: exactly one usage line, got ${recs.length}`);
        const rec = recs[0];
        assert.equal(rec.role, "main-orchestrator");
        assert.equal(rec.upstream, "ANTHROPIC");
        assert.equal(rec.credential, "oauth");
        assert.equal(rec.input, 11, `${encoding}: input_tokens read from the decoded copy`);
        assert.equal(rec.output, 7, `${encoding}: output_tokens read from the decoded copy`);
        assert.ok(rec.input > 0 && rec.output > 0);
      } finally {
        await H.stopRouter(srv);
        up.restore();
      }
    });
  }
});

test("wire (c) non-streaming JSON logs usage with identity and with gzip encoding", async () => {
  const payload = Buffer.from(JSON.stringify({
    id: "msg_wire",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 42, output_tokens: 17, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  }), "utf8");
  for (const encoding of [null, "gzip"]) {
    await withUsageLog(async (logPath) => {
      const wire = encoding ? zlib.gzipSync(payload) : payload;
      const up = H.installUpstreams({
        ogo: () => H.ogoOk("never-forged"),
        anthropic: () => ({ status: 200, contentType: "application/json", headers: encoding ? { "content-encoding": encoding } : {}, body: wire }),
      });
      const srv = await H.startRouter(routerRequestHandler);
      try {
        const r = await rawPost(srv, { body: mainWireBody(false), headers: { authorization: H.CLIENT_AUTH } });
        assert.equal(r.status, 200);
        assert.ok(r.raw.equals(wire), `${encoding || "identity"}: client bytes identical to the upstream body`);
        await H.waitFor(() => usageRecords(logPath).length >= 1, `${encoding || "identity"}: the usage line`);
        const recs = usageRecords(logPath);
        assert.equal(recs.length, 1, `${encoding || "identity"}: exactly one usage line, got ${recs.length}`);
        assert.equal(recs[0].role, "main-orchestrator");
        assert.equal(recs[0].credential, "oauth");
        assert.equal(recs[0].input, 42);
        assert.equal(recs[0].output, 17);
        assert.equal(recs[0].cache_read, 900);
      } finally {
        await H.stopRouter(srv);
        up.restore();
      }
    });
  }
});

test("wire (d) key-retry served on an encoded SSE stream logs credential=api_key with real tokens", async () => {
  await withUsageLog(async (logPath) => {
    const ROUTER_KEY_ENV = ["ANTHROPIC", "API", "KEY"].join("_");
    const ROUTER_KEY = ["sk", "ant", "unit", "test", "wire", "key"].join("-");
    const restoreEnv = H.withEnv({ [ROUTER_KEY_ENV]: ROUTER_KEY });
    const fixture = wiredAnthropic("gzip");
    const seen = [];
    const up = H.installUpstreams({
      ogo: () => H.ogoOk("never-forged"),
      anthropic: (entry) => { seen.push(entry.headers["x-api-key"]); return seen.length === 1 ? H.anthropic429() : fixture.answer(); },
    });
    const srv = await H.startRouter(routerRequestHandler);
    const log = H.captureConsole();
    try {
      const r = await rawPost(srv, { body: mainWireBody(true), headers: { authorization: H.CLIENT_AUTH } });
      assert.equal(r.status, 200, r.raw.toString("utf8"));
      assert.equal(seen.length, 2, "OAuth attempt, then the router key");
      assert.equal(seen[1], ROUTER_KEY);
      assert.ok(log.lines.some((l) => l.startsWith("[ANTHROPIC-KEY-FALLBACK] role=main-orchestrator OAuth status=429")), log.lines.join("\n"));
      assert.ok(r.raw.equals(fixture.wire), "the client bytes are the retry's encoded upstream bytes");
      await H.waitFor(() => usageRecords(logPath).length >= 1, "the usage line");
      const rec = usageRecords(logPath)[0];
      assert.equal(rec.credential, "api_key", "the router key served it");
      assert.equal(rec.role, "main-orchestrator");
      assert.equal(rec.upstream, "ANTHROPIC");
      assert.equal(rec.fallback, 0);
      assert.equal(rec.input, 11);
      assert.equal(rec.output, 7);
    } finally {
      log.restore();
      await H.stopRouter(srv);
      up.restore();
      restoreEnv();
    }
  });
});

test("wire (e) NEGATIVE: an encoded body the scanner cannot read yields no line and still streams the bytes", async () => {
  await withUsageLog(async (logPath) => {
    // Brotli bytes labelled as SSE but not decodable by the label: best-effort means no line,
    // never a throw and never an altered response.
    const junk = Buffer.from("not-a-compressed-body", "utf8");
    const up = H.installUpstreams({
      ogo: () => H.ogoOk("never-forged"),
      anthropic: () => ({ status: 200, contentType: "text/event-stream", headers: { "content-encoding": "gzip" }, body: junk }),
    });
    const srv = await H.startRouter(routerRequestHandler);
    const log = H.captureConsole();
    try {
      const r = await rawPost(srv, { body: mainWireBody(true), headers: { authorization: H.CLIENT_AUTH } });
      assert.equal(r.status, 200);
      assert.ok(r.raw.equals(junk), "an undecodable body is still relayed byte-identically");
      await H.sleep(150);
      assert.equal(usageRecords(logPath).length, 0, "no usage line is invented for a body that cannot be decoded");
      assert.ok(!log.lines.some((l) => /USAGE/i.test(l) && /error/i.test(l)), "the scanner logs no error noise");
    } finally {
      log.restore();
      await H.stopRouter(srv);
      up.restore();
    }
  });
});

test("wire (f) the encoded side copy is bounded: past either cap no line is written and the bytes still stream", async () => {
  // The caps are fields so this test shrinks them instead of allocating megabytes.
  const saved = { ...USAGE_LIMITS };
  try {
    for (const [field, value, label] of [["encodedMaxBytes", 4, "copy cap"], ["decodeMaxBytes", 4, "inflate cap"]]) {
      await withUsageLog(async (logPath) => {
        const fixture = wiredAnthropic("gzip");
        USAGE_LIMITS[field] = value;
        const up = H.installUpstreams({ ogo: () => H.ogoOk("never-forged"), anthropic: () => fixture.answer() });
        const srv = await H.startRouter(routerRequestHandler);
        try {
          const r = await rawPost(srv, { body: mainWireBody(true), headers: { authorization: H.CLIENT_AUTH } });
          assert.equal(r.status, 200, `${label}: the request still succeeds`);
          assert.ok(r.raw.equals(fixture.wire), `${label}: the encoded bytes reach the client untouched`);
          await H.sleep(150);
          assert.equal(usageRecords(logPath).length, 0, `${label}: no usage line beyond the bound`);
        } finally {
          USAGE_LIMITS[field] = saved[field];
          await H.stopRouter(srv);
          up.restore();
        }
      });
    }
  } finally {
    Object.assign(USAGE_LIMITS, saved);
  }
});
