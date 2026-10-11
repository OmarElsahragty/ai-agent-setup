"use strict";
/**
 * D5 item 4 (Review-A minor): keep-warm's M-016 credential refresh assumed ONE account (a single
 * lane-wide "newest credential"). A ping may now borrow a fresher credential only from the same
 * account (metadata.user_id account_uuid) or, with no account, only from the same session.
 * Real short timers; the fake Anthropic is a loopback server behind KEEPWARM_UPSTREAM_URL.
 * NOTE: credential-shaped fixtures are assembled at runtime (concatenation), never inline.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const H = require("./d5-harness");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "d5-kw-account-"));
H.clearRouterEnv();
process.env.ROUTER_USAGE_LOG = path.join(TMP, "router-usage.jsonl");

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const keepwarm = require("../keepwarm");
const server = require("../server");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const bearer = (name) => ["Bearer", `tok-${name}-unit`].join(" ");
const KW_KEYS = ["ROUTER_KEEPWARM", "KEEPWARM_IDLE_MS", "KEEPWARM_MAX_IDLE_MS", "KEEPWARM_UPSTREAM_URL", "KEEPWARM_MAX_SESSIONS",
  "KEEPWARM_MAX_BODY_BYTES", "KEEPWARM_TIMEOUT_MS", "KEEPWARM_MISS_RATIO"];
const HIT = { usage: { cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 } };

function kwEnv(vars) {
  const all = {};
  for (const k of KW_KEYS) all[k] = undefined;
  return H.withEnv({ ...all, ...vars });
}

function fakeRes() {
  const listeners = {};
  return {
    statusCode: 200,
    once(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return this; },
    finish(status) { if (status !== undefined) this.statusCode = status; for (const cb of listeners.finish || []) cb(); },
  };
}

function startFake() {
  const received = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers });
      const text = JSON.stringify(HIT);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, received, url: `http://127.0.0.1:${srv.address().port}/v1/messages` })));
}

function serve({ sessionId, auth, account = "", path: p = "/v1/messages" }) {
  const res = fakeRes();
  keepwarm.observe({
    sessionId,
    account,
    role: "main-orchestrator",
    res,
    body: Buffer.from(JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] })),
    headers: { ...(sessionId ? { "x-claude-code-session-id": sessionId } : {}), authorization: auth, "content-type": "application/json" },
    path: p,
    method: "POST",
    outcome: () => ({ served: true, status: 200 }),
  });
  res.finish(200);
}

async function withFake(fn) {
  const fake = await startFake();
  const restore = kwEnv({ ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "250", KEEPWARM_MAX_IDLE_MS: "600000", KEEPWARM_UPSTREAM_URL: fake.url });
  try {
    await fn(fake);
  } finally {
    keepwarm.reset();
    restore();
    fake.srv.closeAllConnections();
    await new Promise((r) => fake.srv.close(() => r()));
  }
}

test("accountOf reads account_uuid from the CLI's metadata.user_id (JSON and legacy forms)", () => {
  const uid = (o) => ({ metadata: { user_id: JSON.stringify(o) } });
  assert.equal(keepwarm.accountOf(uid({ device_id: "d1", account_uuid: "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab", session_id: "s1" })),
    "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab");
  assert.equal(keepwarm.accountOf({ metadata: { user_id: "user_abc123_account_0b1c2d3e-aaaa-bbbb-cccc-0123456789ab_session_s1" } }),
    "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab");
  assert.equal(keepwarm.accountOf(uid({ device_id: "d1", account_uuid: "", session_id: "s1" })), "", "API-key clients carry no account");
  assert.equal(keepwarm.accountOf({ metadata: { user_id: "{not json" } }), "");
  assert.equal(keepwarm.accountOf(uid({ account_uuid: "x\" injected" })), "", "only a plain id is accepted");
  assert.equal(keepwarm.accountOf({}), "");
  assert.equal(keepwarm.accountOf(null), "");
});

test("a ping never borrows another account's newer credential", async () => {
  await withFake(async (fake) => {
    serve({ sessionId: "sess-acct-a", auth: bearer("acctA"), account: "acct-A" });
    await H.sleep(30);
    serve({ sessionId: "sess-acct-b", auth: bearer("acctB"), account: "acct-B" });
    await H.waitFor(() => fake.received.some((r) => r.headers["x-claude-code-session-id"] === "sess-acct-a"), "a's ping");
    const pingA = fake.received.find((r) => r.headers["x-claude-code-session-id"] === "sess-acct-a");
    assert.equal(pingA.headers.authorization, bearer("acctA"), "account A's prefix only ever goes out under account A");
  });
});

test("a credential seen without any account or session is never lent to a session", async () => {
  await withFake(async (fake) => {
    serve({ sessionId: "sess-solo", auth: bearer("solo"), account: "acct-solo" });
    await H.sleep(30);
    serve({ sessionId: "", auth: bearer("anonymous-newer") });
    await H.waitFor(() => fake.received.length >= 1, "the ping");
    assert.equal(fake.received[0].headers.authorization, bearer("solo"));
  });
});

test("a refreshed credential of the SAME account is still borrowed (M-016 kept)", async () => {
  await withFake(async (fake) => {
    serve({ sessionId: "sess-x", auth: bearer("x-old"), account: "acct-X" });
    await H.sleep(30);
    serve({ sessionId: "", auth: bearer("x-new"), account: "acct-X" });
    await H.waitFor(() => fake.received.length >= 1, "the ping");
    assert.equal(fake.received[0].headers.authorization, bearer("x-new"));
  });
});

test("router wiring: a served CEO request arms keep-warm with the account from metadata.user_id", async () => {
  const restore = kwEnv({ ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "600000", KEEPWARM_MAX_IDLE_MS: "600000" });
  const up = H.installUpstreams({ ogo: () => H.ogo429(), anthropic: () => H.anthropicOk() });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const body = {
      model: "claude-opus-5-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "marker=kw" }],
      metadata: { user_id: JSON.stringify({ device_id: "dev", account_uuid: "acc-0001", session_id: "sess-wire" }) },
    };
    const r = await H.send(srv, { headers: { "x-claude-code-session-id": "sess-wire" }, body });
    assert.equal(r.status, 200);
    await H.waitFor(() => keepwarm.sessions.has("sess-wire"), "session armed");
    assert.equal(keepwarm.sessions.get("sess-wire").account, "acc-0001");
  } finally {
    log.restore();
    keepwarm.reset();
    await H.stopRouter(srv);
    up.restore();
    restore();
  }
});
