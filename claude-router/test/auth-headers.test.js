"use strict";
/**
 * G1 fixes I6 / I6b / I9 — header fidelity and log fields on the Anthropic lane.
 * Run: node --test claude-router/test/*.test.js
 *
 * routerRequestHandler is driven over a real loopback HTTP server, but the upstream
 * https.request is stubbed in-process (server.js holds the same module object), so no
 * request ever leaves the machine and no credential is ever real. The stub records the
 * exact outbound headers, which is what I6 asserts.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./d5-harness");
const { routerRequestHandler, __fallbackBudgetTestHook } = require("../server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Main-lane body: tools present (not background/compaction), no subagent headers,
// no glm/flash/haiku model -> classifyRequest returns the ANTHROPIC main orchestrator.
function mainBody() {
  return {
    model: "claude-opus-5-5",
    max_tokens: 64,
    stream: false,
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "ping" }],
  };
}

/**
 * Replace https.request for the duration of one test. Every upstream call is answered
 * with `status`/`payload` and recorded (options + nothing else — never the body).
 */
function stubUpstream(status, payload) {
  const real = https.request;
  const calls = [];
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  https.request = function patched(options, cb) {
    calls.push(options);
    const proxyRes = new PassThrough();
    proxyRes.statusCode = status;
    proxyRes.headers = { "content-type": "application/json" };
    // A plain EventEmitter stand-in — a real ClientRequest would actually try to connect.
    const req = new EventEmitter();
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => {
        cb(proxyRes);
        proxyRes.end(body);
      });
      return req;
    };
    return req;
  };
  return {
    calls,
    bodyLength: body.length,
    restore: () => { https.request = real; },
  };
}

let server;
let baseUrl;
test("boot the loopback router", async () => {
  server = http.createServer(routerRequestHandler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

async function postToRouter(headers, extra = {}) {
  const body = Buffer.from(JSON.stringify(mainBody()), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  }).then(async (out) => {
    await sleep(30); // let the res "finish" handlers ([DONE]) land before the caller asserts logs
    return out;
  });
}

function captureLogs() {
  const lines = [];
  const real = console.log;
  console.log = (line) => lines.push(String(line));
  return { lines, restore: () => { console.log = real; } };
}

function withKeepwarmOff() {
  const saved = process.env.ROUTER_KEEPWARM;
  delete process.env.ROUTER_KEEPWARM;
  return () => {
    if (saved === undefined) delete process.env.ROUTER_KEEPWARM;
    else process.env.ROUTER_KEEPWARM = saved;
  };
}

test("I6: a Bearer client with no anthropic-beta gets none fabricated", async () => {
  const restoreEnv = withKeepwarmOff();
  const stub = stubUpstream(200, { ok: true });
  try {
    // Dummy token: structurally an OAuth credential, never a real secret.
    await postToRouter({ authorization: "Bearer dummy-token-for-tests" });
    assert.equal(stub.calls.length, 1, "exactly one upstream call");
    const sent = stub.calls[0].headers;
    assert.equal("anthropic-beta" in sent, false,
      "no anthropic-beta may be fabricated for an authorization client");
    assert.equal(sent.authorization, "Bearer dummy-token-for-tests",
      "the client credential is forwarded unchanged");
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("I6: an x-api-key client with no beta still gets the cache beta (behaviour kept)", async () => {
  const restoreEnv = withKeepwarmOff();
  const stub = stubUpstream(200, { ok: true });
  try {
    await postToRouter({ "x-api-key": "dummy-key-for-tests" });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].headers["anthropic-beta"], "prompt-caching-2024-07-31");
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("I6: a client beta header survives byte-identical (deliberate append documented)", async () => {
  const restoreEnv = withKeepwarmOff();
  const stub = stubUpstream(200, { ok: true });
  try {
    // Already carries prompt-caching: must pass EXACTLY as sent.
    await postToRouter({
      authorization: "Bearer dummy-token-for-tests",
      "anthropic-beta": "prompt-caching-2024-07-31,context-management-2025-06-27",
    });
    assert.equal(stub.calls[0].headers["anthropic-beta"],
      "prompt-caching-2024-07-31,context-management-2025-06-27", "byte-identical passthrough");

    // Another beta without prompt-caching: the client value stays the prefix; the documented
    // deliberate append adds prompt-caching so cache writes keep working.
    await postToRouter({
      authorization: "Bearer dummy-token-for-tests",
      "anthropic-beta": "context-management-2025-06-27",
    });
    assert.equal(stub.calls[1].headers["anthropic-beta"],
      "context-management-2025-06-27,prompt-caching-2024-07-31",
      "client value preserved as the prefix, deliberate append at the end");
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("I6b: no credential at all -> one [AUTH] line, still forwarded", async () => {
  const restoreEnv = withKeepwarmOff();
  const stub = stubUpstream(200, { ok: true });
  const logs = captureLogs();
  try {
    const out = await postToRouter({});
    assert.equal(stub.calls.length, 1, "the request is still forwarded");
    assert.equal(out.status, 200);
    const authLines = logs.lines.filter((l) => l.includes("[AUTH]"));
    assert.equal(authLines.length, 1, "exactly one [AUTH] line");
    assert.match(authLines[0], /^\[AUTH\] role=main-orchestrator path=\/v1\/messages no-credentials$/);
    assert.equal(/Bearer|dummy|sk-ant/.test(authLines[0]), false, "no credential material in the log");
  } finally {
    logs.restore();
    stub.restore();
    restoreEnv();
  }
});

test("I6b owner ruling 2026-10-11: the router key is injected for a credential-less main request only", async () => {
  const restoreEnv = withKeepwarmOff();
  const hadKey = process.env.ANTHROPIC_API_KEY;
  const hadPlan = process.env.ROLE_PLAN_IMPLEMENTER;
  const KEY = "router-key-placeholder-for-tests";
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.ROLE_PLAN_IMPLEMENTER = "anthropic:claude-opus-5-5:claude-haiku-5-5:max";
  const stub = stubUpstream(200, { ok: true });
  const logs = captureLogs();
  try {
    await postToRouter({});
    assert.equal(stub.calls[0].headers["x-api-key"], KEY, "main lane: router key injected");
    await postToRouter({ "x-subagent-name": "implementer" });
    assert.equal(stub.calls.length, 2, "the subagent request is still forwarded on its Anthropic lane");
    assert.equal(stub.calls[1].headers["x-api-key"], undefined, "subagent lane: no router key");
    assert.equal(stub.calls[1].headers.authorization, undefined);
    const authLines = logs.lines.filter((l) => l.includes("[AUTH]"));
    assert.match(authLines[0], /^\[AUTH\] role=main-orchestrator injected router ANTHROPIC_API_KEY$/);
    assert.match(authLines[1], /^\[AUTH\] role=implementer path=\/v1\/messages no-credentials$/);
    assert.equal(authLines.some((l) => l.includes(KEY)), false, "no key material in the log");
  } finally {
    logs.restore();
    stub.restore();
    if (hadKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hadKey;
    if (hadPlan === undefined) delete process.env.ROLE_PLAN_IMPLEMENTER; else process.env.ROLE_PLAN_IMPLEMENTER = hadPlan;
    restoreEnv();
  }
});

test("I6b: a credentialed request logs no [AUTH] line", async () => {
  const restoreEnv = withKeepwarmOff();
  const stub = stubUpstream(200, { ok: true });
  const logs = captureLogs();
  try {
    await postToRouter({ authorization: "Bearer dummy-token-for-tests" });
    assert.equal(logs.lines.filter((l) => l.includes("[AUTH]")).length, 0);
  } finally {
    logs.restore();
    stub.restore();
    restoreEnv();
  }
});

test("I9: the [DONE] line carries out_bytes equal to the bytes streamed to the client", async () => {
  const restoreEnv = withKeepwarmOff();
  const stub = stubUpstream(200, { ok: true, echoed: "0123456789" });
  const logs = captureLogs();
  try {
    const out = await postToRouter({ authorization: "Bearer dummy-token-for-tests" });
    assert.equal(out.status, 200);
    const done = logs.lines.find((l) => l.startsWith("[DONE] "));
    assert.ok(done, "a [DONE] line is logged");
    const m = done.match(/out_bytes=(\d+)/);
    assert.ok(m, `out_bytes present in: ${done}`);
    assert.equal(Number(m[1]), stub.bodyLength,
      "out_bytes must equal the response bytes streamed to the client");
    // Existing fields keep their order: role/model/status/ms all still in place before out_bytes.
    assert.match(done, /^\[DONE\] role=\S+ model=\S+ status=\d+ ms=\d+ out_bytes=\d+$/);
  } finally {
    logs.restore();
    stub.restore();
    restoreEnv();
  }
});

// S3 negative control (2026-10-11): what leaves for opencode.ai. The client's own bearer and cookie
// must never reach the third-party host; the captured entry carries the Go key, the x-opencode-session
// id and the user agent, and the body carries adaptive thinking at effort max.
test("OpenCode Go egress: client bearer and cookie never leave; session, user-agent, adaptive thinking, effort max", async () => {
  const GO_KEY_ENV = ["OPENCODE", "GO", "API", "KEY"].join("_");
  const goKey = ["go", "unit", "egress", "placeholder"].join("-");
  const clientCookie = ["session", "unit-test-cookie"].join("=");
  const clientUa = "claude-cli/unit-test";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-ogo-"));
  const restoreEnv = H.withEnv({
    [GO_KEY_ENV]: goKey,
    ROUTER_USAGE_LOG: path.join(tmp, "router-usage.jsonl"),
    CLAUDE_ROUTER_FALLBACK_STATE: path.join(tmp, "fallback-state.json"),
  });
  __fallbackBudgetTestHook.reset();
  const up = H.installUpstreams({ ogo: () => H.ogoOk("egress"), anthropic: () => H.anthropicOk() });
  const inbound = [];
  const srv = await H.startRouter(routerRequestHandler, (req) => { inbound.push(req.headers); });
  try {
    const r = await H.send(srv, {
      headers: {
        authorization: H.CLIENT_AUTH,
        cookie: clientCookie,
        "user-agent": clientUa,
        "x-subagent-name": "implementer",
        "x-claude-code-session-id": "sess-auth-neg",
      },
      body: {
        model: "claude-opus-5-5",
        max_tokens: 64,
        stream: false,
        messages: [{ role: "user", content: "marker=egress-neg" }],
        tools: [{ name: "Bash", input_schema: { type: "object" } }],
      },
    });
    assert.equal(r.status, 200);
    // Negative-control precondition: the inbound request really carried both client secrets.
    assert.equal(inbound[0].cookie, clientCookie);
    assert.equal(inbound[0].authorization, H.CLIENT_AUTH);
    assert.equal(up.ogo.length, 1, "served by OpenCode Go");
    const sent = up.ogo[0].headers;
    assert.equal(sent.authorization, ["Bearer", goKey].join(" "), "the Go key authenticates, not the client bearer");
    assert.equal(Object.keys(sent).some((k) => k.toLowerCase() === "cookie"), false, "no cookie header");
    const wire = JSON.stringify(sent);
    assert.equal(wire.includes(H.PLACEHOLDER), false, "client bearer material never reaches opencode.ai");
    assert.equal(wire.includes(clientCookie), false, "cookie value never reaches opencode.ai");
    assert.equal(sent["x-opencode-session"], "sess-auth-neg");
    assert.equal(sent["user-agent"], clientUa);
    assert.deepEqual(up.ogo[0].body.thinking, { type: "adaptive" });
    assert.equal(up.ogo[0].body.output_config.effort, "max");
  } finally {
    await H.stopRouter(srv);
    __fallbackBudgetTestHook.reset();
    up.restore();
    restoreEnv();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("shutdown the loopback router", () => new Promise((resolve) => server.close(() => resolve())));
