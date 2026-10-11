"use strict";
/**
 * D5 shared test harness (not a test file: the suite glob is test/*.test.js).
 * https.request is stubbed in-process, so no request ever leaves the machine; any host other than
 * opencode.ai / api.anthropic.com throws. The stub request emits "close" once its response has been
 * consumed, like a real https.ClientRequest, so forward()'s own per-attempt listener is removed
 * exactly as in production and listener counts on the client response stay meaningful.
 * NOTE: credential-shaped fixtures are assembled at runtime (concatenation), never inline.
 */
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const PLACEHOLDER = ["unit", "test", "placeholder"].join("-");
const CLIENT_AUTH = ["Bearer", PLACEHOLDER].join(" ");
// OpenCode Go account-window refusal (terminal): the shape Go returns once a 5-hour/weekly/monthly window is spent.
const OGO_LIMIT = JSON.stringify({
  type: "error",
  error: { type: "GoUsageLimitError", message: "Weekly usage limit reached. Resets in 1 day." },
});
const SSE_OK = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

function ogoOk(marker) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "ogo", content: [{ type: "text", text: `served-by-ogo ${marker}` }], usage: { input_tokens: 5, output_tokens: 3 } }),
  };
}
const ogo429 = () => ({ status: 429, contentType: "application/json", body: OGO_LIMIT });
const anthropicOk = () => ({ status: 200, contentType: "text/event-stream", body: SSE_OK });
const anthropic429 = () => ({ status: 429, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "window" } }) });

/** answers: { ogo(entry), anthropic(entry) } -> { status, contentType, body } */
function installUpstreams(answers) {
  const real = https.request;
  const up = { ogo: [], anthropic: [] };
  https.request = function stubbedRequest(options, cb) {
    const host = options && options.hostname;
    if (host !== "opencode.ai" && host !== "api.anthropic.com") throw new Error(`unexpected egress host ${host}`);
    const req = new EventEmitter();
    const chunks = [];
    let closed = false;
    const close = () => { if (!closed) { closed = true; process.nextTick(() => req.emit("close")); } };
    req.write = (c) => { chunks.push(Buffer.from(c)); return true; };
    req.destroy = () => close();
    req.end = () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const marker = (/marker=([A-Za-z0-9_-]+)/.exec(text) || [])[1] || "?";
      const entry = { host, path: options.path, headers: options.headers, body, marker };
      const isOgo = host === "opencode.ai";
      (isOgo ? up.ogo : up.anthropic).push(entry);
      const answer = (isOgo ? answers.ogo : answers.anthropic)(entry);
      const proxyRes = new PassThrough();
      proxyRes.statusCode = answer.status;
      // answer.headers lets a test replay RAW upstream framing (content-length of the full body,
      // transfer-encoding, a non-allowlisted header) the router must not pass through.
      proxyRes.headers = { "content-type": answer.contentType || "application/json", ...(answer.headers || {}) };
      proxyRes.on("end", close);
      process.nextTick(() => {
        cb(proxyRes);
        // answer.chunks replays a body split across writes (a real streamed/encoded reply);
        // otherwise the body is delivered in one write.
        if (Array.isArray(answer.chunks)) {
          for (const c of answer.chunks) proxyRes.write(c);
          proxyRes.end();
        } else {
          proxyRes.end(answer.body || "");
        }
      });
      return req;
    };
    return req;
  };
  up.restore = () => { https.request = real; };
  up.markers = (which) => up[which].map((e) => e.marker);
  return up;
}

async function startRouter(handler, onRequest) {
  const srv = http.createServer((req, res) => {
    if (onRequest) onRequest(req, res);
    handler(req, res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

function stopRouter(srv) {
  srv.closeAllConnections();
  return new Promise((r) => srv.close(() => r()));
}

function send(srv, { headers = {}, body, signal, path = "/v1/messages" }) {
  return fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: CLIENT_AUTH, ...headers },
    body: JSON.stringify(body),
    signal,
  }).then(async (r) => ({ status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) }));
}

function captureConsole() {
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.log = realLog; console.warn = realWarn; } };
}

function withEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Module-level knobs every D5 test file clears before server.js loads. */
const ROUTER_ENV_KEYS = ["OPENCODE_GO_SIMULATE_STATUS", "ROUTER_KEEPWARM", "SUBAGENT_PRIMARY", "OPENCODE_GO_FALLBACK_MODEL",
  "FALLBACK_MAX_CONCURRENT", "FALLBACK_QUEUE_MAX_WAIT_MS", "OPENCODE_GO_MAX_CONCURRENT", "OPENCODE_GO_429_MAX_ATTEMPTS"];

function clearRouterEnv() {
  for (const k of ROUTER_ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("ROLE_PLAN_")) delete process.env[k];
}

module.exports = {
  PLACEHOLDER, CLIENT_AUTH, OGO_LIMIT, SSE_OK, sleep, waitFor, ogoOk, ogo429, anthropicOk, anthropic429,
  installUpstreams, startRouter, stopRouter, send, captureConsole, withEnv, clearRouterEnv,
};
