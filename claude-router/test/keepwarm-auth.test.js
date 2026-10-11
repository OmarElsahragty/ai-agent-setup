"use strict";
/**
 * WO-N1 / M-016: keep-warm pings carry the freshest credential seen for the session/lane, and a
 * credential that drew a 401 is never pinged with again. Run: node --test test/
 *
 * Same harness as keepwarm.test.js: real short timers, a loopback fake Anthropic behind
 * KEEPWARM_UPSTREAM_URL, nothing leaves the machine.
 * NOTE: credential-shaped fixtures are assembled at runtime (concatenation), never inline.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const keepwarm = require("../keepwarm");
const { buildAnthropicOutboundBody } = require("../server");

const bearer = (name) => ["Bearer", `tok-${name}-unit`].join(" ");

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

async function waitFor(cond, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

function fakeRes() {
  const listeners = {};
  return {
    statusCode: 200,
    once(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return this; },
    finish(status) {
      if (status !== undefined) this.statusCode = status;
      for (const cb of listeners.finish || []) cb();
    },
  };
}

function startFakeUpstream(respond) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      const entry = { body, headers: req.headers };
      received.push(entry);
      respond(req, res, entry);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/v1/messages` });
    });
  });
}

function stopUpstream(fake) {
  return new Promise((resolve) => {
    if (typeof fake.server.closeIdleConnections === "function") fake.server.closeIdleConnections();
    fake.server.close(() => resolve());
  });
}

function jsonResponse(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const HIT = { usage: { cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 } };
const AUTH_ERROR = { type: "error", error: { type: "authentication_error", message: "invalid credential" } };

function ceoOutbound(marker) {
  const body = {
    model: "claude-opus-5-5",
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "you are the CEO", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: `marker=${marker}` }] }],
  };
  const { outboundBody, targetModel } = buildAnthropicOutboundBody(body, "claude-opus-5-5", {});
  return Buffer.from(JSON.stringify({ ...outboundBody, model: targetModel }), "utf8");
}

/** One served main-lane request (what handleAnthropic hands keepwarm.observe). */
function serve({ sessionId, auth, status = 200, path = "/v1/messages", marker = "m", account = "" }) {
  const res = fakeRes();
  keepwarm.observe({
    sessionId,
    account,
    role: "main-orchestrator",
    res,
    body: ceoOutbound(marker),
    headers: {
      ...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
      "anthropic-beta": "prompt-caching-2024-07-31",
      authorization: auth,
      "content-type": "application/json",
    },
    path,
    method: "POST",
    outcome: () => ({ served: true, status }),
  });
  res.finish(status);
}

function captureLog() {
  const lines = [];
  const real = console.log;
  console.log = (line) => { lines.push(String(line)); };
  return { lines, restore: () => { console.log = real; } };
}

test("M-016: the ping carries the newest credential seen on the lane, not the session's stale one", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, HIT));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "250", KEEPWARM_MAX_IDLE_MS: "600000", KEEPWARM_UPSTREAM_URL: fake.url,
  });
  try {
    serve({ sessionId: "sess-fresh-a", auth: bearer("old"), marker: "fresh" });
    await sleep(40);
    // Claude Code refreshed its token: a later main-lane call (a count_tokens call here) proves the
    // new one. It must neither arm nor replace the stored prefix (I7a), only refresh the credential.
    serve({ sessionId: "sess-fresh-a", auth: bearer("new"), path: "/v1/messages/count_tokens", marker: "count" });
    await waitFor(() => fake.received.length >= 1, "the first ping");
    const ping = fake.received[0];
    assert.equal(ping.headers["x-claude-code-session-id"], "sess-fresh-a");
    assert.equal(ping.headers.authorization, bearer("new"), "the ping must use the freshest credential");
    assert.match(JSON.stringify(ping.body.messages), /marker=fresh/, "the stored prefix is unchanged");
  } finally {
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("M-016: a 401 retires the credential; no other session pings with it (one 401, not one per session)", async () => {
  const fake = await startFakeUpstream((req, res) => (
    req.headers.authorization === bearer("stale") ? jsonResponse(res, 401, AUTH_ERROR) : jsonResponse(res, 200, HIT)
  ));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "300", KEEPWARM_MAX_IDLE_MS: "600000", KEEPWARM_UPSTREAM_URL: fake.url,
  });
  const log = captureLog();
  try {
    serve({ sessionId: "sess-401-a", auth: bearer("stale") });
    await sleep(100);
    serve({ sessionId: "sess-401-b", auth: bearer("stale") });
    // a pings at ~300 ms -> 401; b's ping at ~400 ms must not reuse the dead credential.
    await waitFor(() => keepwarm.sessionCount() === 0, "both sessions stopped");
    await sleep(150);
    assert.equal(fake.received.length, 1, "exactly one ping carried the stale credential");
    assert.equal(log.lines.filter((l) => /^\[KEEPWARM\].*status=401/.test(l)).length, 1, "one 401 in the journal");
    assert.ok(log.lines.some((l) => /^\[KEEPWARM-SKIP\] session=sess-401 .*reason=stale-credential/.test(l)), "b skipped its ping");
    assert.deepEqual(keepwarm.credentialState(), { accounts: 0, sessions: 0, dead: 1 });

    // A fresh credential re-arms keep-warm normally.
    serve({ sessionId: "sess-401-c", auth: bearer("fresh") });
    await waitFor(() => fake.received.length >= 2, "the fresh session's ping");
    assert.equal(fake.received[1].headers.authorization, bearer("fresh"));
    assert.equal(log.lines.filter((l) => /^\[KEEPWARM\].*status=401/.test(l)).length, 1, "still one 401");
  } finally {
    log.restore();
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("M-016: after a 401, a session holding the dead credential pings with a fresher one of its own account", async () => {
  const fake = await startFakeUpstream((req, res) => (
    req.headers.authorization === bearer("stale") ? jsonResponse(res, 401, AUTH_ERROR) : jsonResponse(res, 200, HIT)
  ));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "300", KEEPWARM_MAX_IDLE_MS: "600000", KEEPWARM_UPSTREAM_URL: fake.url,
  });
  const log = captureLog();
  try {
    // D5: borrowing is per account (metadata.user_id account_uuid), so all three share one account.
    serve({ sessionId: "sess-swap-a", auth: bearer("stale"), account: "acct-swap" });
    await sleep(100);
    serve({ sessionId: "sess-swap-b", auth: bearer("stale"), account: "acct-swap" });
    await waitFor(() => fake.received.length >= 1, "a's ping (401)");
    // The CLI refreshed; a request without a session id proves the new credential before b pings.
    serve({ sessionId: "", auth: bearer("refreshed"), account: "acct-swap" });
    await waitFor(() => fake.received.length >= 2, "b's ping");
    assert.equal(fake.received[1].headers["x-claude-code-session-id"], "sess-swap-b");
    assert.equal(fake.received[1].headers.authorization, bearer("refreshed"), "b borrows the fresher credential");
    await sleep(50);
    assert.equal(log.lines.filter((l) => /^\[KEEPWARM\].*status=401/.test(l)).length, 1, "one 401 only");
    assert.equal(keepwarm.sessionCount(), 1, "b keeps warming on the fresh credential");
  } finally {
    log.restore();
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});

test("M-016: a real request that drew a 401 retires its credential before any ping uses it", async () => {
  const fake = await startFakeUpstream((req, res) => jsonResponse(res, 200, HIT));
  const restore = withEnv({
    ROUTER_KEEPWARM: "1", KEEPWARM_IDLE_MS: "200", KEEPWARM_MAX_IDLE_MS: "600000", KEEPWARM_UPSTREAM_URL: fake.url,
  });
  const log = captureLog();
  try {
    serve({ sessionId: "sess-real-401", auth: bearer("revoked") });
    // Anthropic answered a later real call carrying the same credential with 401.
    serve({ sessionId: "sess-real-401", auth: bearer("revoked"), path: "/v1/messages/count_tokens", status: 401 });
    await waitFor(() => keepwarm.sessionCount() === 0, "the session stopped");
    await sleep(50);
    assert.equal(fake.received.length, 0, "no ping is sent with a credential known to be dead");
    assert.ok(log.lines.some((l) => l.startsWith("[KEEPWARM-SKIP]")), "the skip is logged");
  } finally {
    log.restore();
    keepwarm.reset();
    restore();
    await stopUpstream(fake);
  }
});
