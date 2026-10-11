"use strict";
/**
 * Owner ruling 2026-10-11: the main and compaction lanes are Anthropic-only — they never fall back to a
 * third-party model. On 429/402/403 the OAuth attempt is retried ONCE with the router's own
 * ANTHROPIC_API_KEY; if that attempt also fails, the client receives THAT attempt's real status and body
 * (a 429 stays a 429 with the upstream body), never a hop and never a synthetic 502.
 * Cases (a)-(d) of the work order. https.request is stubbed in-process by the shared D5 harness, so no
 * request leaves the machine; ROUTER_USAGE_LOG and CLAUDE_ROUTER_FALLBACK_STATE point into a temp dir,
 * so neither the live usage log nor the live /run/claude-router/fallback-state.json is touched.
 * The router key is assembled at runtime and never printed.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./d5-harness");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-key-"));
H.clearRouterEnv();
process.env.ROUTER_USAGE_LOG = path.join(TMP, "router-usage.jsonl");
process.env.CLAUDE_ROUTER_FALLBACK_STATE = path.join(TMP, "fallback-state.json");
process.env.OPENCODE_GO_API_KEY = H.PLACEHOLDER;

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server.js");
const keepwarm = require("../keepwarm");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ROUTER_KEY_ENV = ["ANTHROPIC", "API", "KEY"].join("_");
const ROUTER_KEY = ["sk", "ant", "unit", "test", "router", "key"].join("-");
const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
const USAGE_LOG = process.env.ROUTER_USAGE_LOG;
const BADGE = path.join(TMP, "fallback-state.json");

const ANTHROPIC_429_BODY = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "window" } });

function body(marker, model = "claude-opus-5-5") {
  return { model, max_tokens: 64, stream: true, tools: TOOLS, messages: [{ role: "user", content: `marker=${marker}` }] };
}

function readUsage() {
  try {
    return fs.readFileSync(USAGE_LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

function clearArtifacts() {
  fs.rmSync(USAGE_LOG, { force: true });
  fs.rmSync(BADGE, { force: true });
}

test("(a) main lane: OAuth 429 -> router key 200 -> client 200; usage credential=api_key and the -api-key badge", async () => {
  clearArtifacts();
  const restoreEnv = H.withEnv({ [ROUTER_KEY_ENV]: ROUTER_KEY });
  // The stub sees the headers object the router will send for THIS attempt (it is mutated again before
  // the retry), so each attempt is snapshotted as it is dialled.
  const seen = [];
  const up = H.installUpstreams({
    ogo: () => H.ogoOk("never-forged"),
    anthropic: (entry) => {
      seen.push({ authorization: entry.headers.authorization, apiKey: entry.headers["x-api-key"] });
      return seen.length === 1 ? H.anthropic429() : H.anthropicOk();
    },
  });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, { body: body("key-a") });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(up.ogo.length, 0, "the main lane never dials OpenCode Go");
    assert.strictEqual(up.anthropic.length, 2, "exactly two Anthropic attempts: OAuth, then the router key");
    assert.ok(seen[0].authorization, "attempt 1 carries the client's OAuth bearer");
    assert.strictEqual(seen[0].apiKey, undefined, "attempt 1 carries no API key");
    assert.strictEqual(seen[1].apiKey, ROUTER_KEY, "attempt 2 carries the router ANTHROPIC_API_KEY");
    assert.strictEqual(seen[1].authorization, undefined, "the refused OAuth bearer is dropped on the retry");
    assert.ok(log.lines.some((l) => l.startsWith("[ANTHROPIC-KEY-FALLBACK] role=main-orchestrator OAuth status=429")), log.lines.join("\n"));
    await H.waitFor(() => readUsage().length >= 1, "the usage line");
    const rec = readUsage()[0];
    assert.strictEqual(rec.credential, "api_key", "served by the router key");
    assert.strictEqual(rec.role, "main-orchestrator");
    assert.strictEqual(rec.upstream, "ANTHROPIC");
    assert.strictEqual(rec.model, "claude-opus-5-5");
    assert.strictEqual(rec.fallback, 0, "a key-served turn is not a fallback-served turn");
    await H.waitFor(() => fs.existsSync(BADGE), "the fallback badge file");
    const badge = JSON.parse(fs.readFileSync(BADGE, "utf8"));
    assert.strictEqual(badge.model, "claude-opus-5-5-api-key");
    assert.match(badge.model, /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/, "must pass the statusline MODEL_RE allowlist");
    assert.strictEqual(badge.role, "main-orchestrator");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
  }
});

test("(b) main lane: OAuth 429 -> key 429 -> client 429 with the upstream body; OpenCode Go gets 0 requests", async () => {
  clearArtifacts();
  const restoreEnv = H.withEnv({ [ROUTER_KEY_ENV]: ROUTER_KEY });
  const seen = [];
  const up = H.installUpstreams({
    ogo: () => H.ogoOk("never-forged"),
    anthropic: (entry) => {
      seen.push({ authorization: entry.headers.authorization, apiKey: entry.headers["x-api-key"] });
      return H.anthropic429();
    },
  });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, { body: body("key-b") });
    assert.strictEqual(r.status, 429, "the client gets the key attempt's real status, not a synthetic 502");
    assert.strictEqual(r.text, ANTHROPIC_429_BODY, "and its real, unmodified body");
    assert.strictEqual(seen.length, 2, "one OAuth attempt then one key attempt, no further hop");
    assert.strictEqual(seen[1].apiKey, ROUTER_KEY);
    assert.strictEqual(up.ogo.length, 0, "OpenCode Go upstream got 0 requests");
    assert.ok(log.lines.some((l) => /^\[4XX\] status=429 /.test(l)), log.lines.join("\n"));
    assert.ok(!log.lines.some((l) => l.startsWith("[FALLBACK]")), "no fallback hop is attempted");
    await H.sleep(150);
    assert.strictEqual(readUsage().length, 0, "a refusal carries no usage, so no usage line is written");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
  }
});

test("(c) compaction lane: OAuth 429 -> key 429 -> client 429, OpenCode Go untouched", async () => {
  clearArtifacts();
  const route = server.classifyRequest({ headers: { "x-claude-code-task-type": "compact" } },
    { model: "claude-opus-5-5", tools: TOOLS, messages: [{ role: "user", content: "create a detailed summary of the conversation so far" }] });
  assert.strictEqual(route.reason, "compaction");
  assert.strictEqual(route.fallback, null, "compaction has no fallback plan to fall back to");

  const restoreEnv = H.withEnv({ [ROUTER_KEY_ENV]: ROUTER_KEY });
  const seen = [];
  const up = H.installUpstreams({
    ogo: () => H.ogoOk("never-forged"),
    anthropic: (entry) => {
      seen.push({ authorization: entry.headers.authorization, apiKey: entry.headers["x-api-key"] });
      return H.anthropic429();
    },
  });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, {
      headers: { "x-claude-code-task-type": "compact" },
      body: { ...body("key-c"), messages: [{ role: "user", content: "create a detailed summary of the conversation so far" }] },
    });
    assert.strictEqual(r.status, 429, r.text);
    assert.strictEqual(r.text, ANTHROPIC_429_BODY, "compaction returns the upstream error verbatim too");
    assert.strictEqual(seen.length, 2, "OAuth attempt, then the router-key attempt");
    assert.strictEqual(seen[1].apiKey, ROUTER_KEY);
    assert.strictEqual(up.ogo.length, 0, "OpenCode Go upstream got 0 requests");
    assert.ok(log.lines.some((l) => l.startsWith("[ROUTE:ANTHROPIC]") && l.includes("reason=compaction")), log.lines.join("\n"));
    assert.ok(log.lines.some((l) => l.startsWith("[ANTHROPIC-KEY-FALLBACK] role=compaction OAuth status=429")), log.lines.join("\n"));
    assert.ok(!log.lines.some((l) => l.startsWith("[FALLBACK]")), "compaction never hops");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
  }
});

test("(e) a plain OAuth-served main turn logs credential=oauth, clears the badge, and never dials OpenCode Go", async () => {
  clearArtifacts();
  const restoreEnv = H.withEnv({ [ROUTER_KEY_ENV]: undefined });
  const up = H.installUpstreams({ ogo: () => H.ogoOk("never-forged"), anthropic: () => H.anthropicOk() });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, { body: body("key-e") });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(up.anthropic.length, 1, "the OAuth attempt is served first time");
    assert.strictEqual(up.ogo.length, 0);
    assert.ok(!log.lines.some((l) => l.startsWith("[ANTHROPIC-KEY-FALLBACK]")), "no key retry without a refusal");
    await H.waitFor(() => readUsage().length >= 1, "the usage line");
    const rec = readUsage()[0];
    assert.strictEqual(rec.credential, "oauth");
    assert.strictEqual(rec.model, "claude-opus-5-5");
    assert.strictEqual(fs.existsSync(BADGE), false, "a subscription-served turn leaves no stale badge");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
  }
});

test("(d) DeepSeek CEO lane: OpenCode Go 429 still falls back one hop to Opus 5.5 high", async () => {
  clearArtifacts();
  const up = H.installUpstreams({
    ogo: () => H.ogo429(),
    anthropic: () => H.anthropicOk(),
  });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, { body: body("key-d", "deepseek-v4.1-flash") });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(up.ogo.length, 1, "the DeepSeek CEO lane still runs on OpenCode Go first");
    assert.strictEqual(up.anthropic.length, 1, "and still hops once to Anthropic");
    assert.strictEqual(up.anthropic[0].body.model, "claude-opus-5-5", "the hop model is Opus 5.5");
    assert.strictEqual(up.anthropic[0].body.output_config.effort, "high", "at high effort");
    assert.strictEqual(up.anthropic[0].headers.authorization, H.CLIENT_AUTH, "on the client's own OAuth bearer");
    assert.ok(log.lines.some((l) => l.startsWith("[FALLBACK] role=main-orchestrator from=deepseek-v4.1-flash to=claude-opus-5-5 effort=high")), log.lines.join("\n"));
    await H.waitFor(() => readUsage().length >= 1, "the usage line");
    const rec = readUsage()[0];
    assert.strictEqual(rec.upstream, "ANTHROPIC");
    assert.strictEqual(rec.model, "claude-opus-5-5");
    assert.strictEqual(rec.fallback, 1, "the hop is still marked as a fallback-served turn");
    assert.strictEqual(rec.credential, "oauth", "the hop runs on the client's subscription bearer");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
  }
});

test("(f) the paid key is NOT spent on a fallback hop: a subagent haiku hop on OAuth 429 reports 429, while the main lane still retries with it", async () => {
  clearArtifacts();
  const restoreEnv = H.withEnv({ [ROUTER_KEY_ENV]: ROUTER_KEY });
  const seen = [];
  let dialled = 0;
  const up = H.installUpstreams({
    ogo: () => H.ogo429(),
    anthropic: (entry) => {
      dialled += 1;
      seen.push({ authorization: entry.headers.authorization, apiKey: entry.headers["x-api-key"], model: entry.body.model, marker: entry.marker });
      // phase 1 = the subagent's haiku hop; phase 2 = the main lane's OAuth attempt + key retry.
      return dialled <= 2 ? H.anthropic429() : H.anthropicOk();
    },
  });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    // phase 1: role code-reviewer -> OpenCode Go 429 -> one haiku hop on the CLIENT's bearer.
    // A hop has no successor and no paid key, so the client gets the real 429 with the router's own
    // refusal detail (unchanged pre-existing behaviour) — never a fabricated 200 and never a retry.
    const sub = await H.send(srv, { headers: { "x-subagent-name": "code-reviewer" }, body: body("key-f-sub") });
    assert.strictEqual(sub.status, 429, sub.text);
    assert.match(sub.text, /Anthropic refused \(status=429\)/, "the real refusal, not a fabricated 200");
    assert.strictEqual(up.anthropic.length, 1, "exactly one Anthropic attempt: no key retry for a subagent hop");
    assert.strictEqual(seen[0].model, "claude-haiku-5-5");
    assert.strictEqual(seen[0].authorization, H.CLIENT_AUTH, "the hop runs on the client's OAuth bearer");
    assert.strictEqual(seen[0].apiKey, undefined, "the router ANTHROPIC_API_KEY is never dialled for a subagent hop");
    assert.ok(!log.lines.some((l) => l.startsWith("[ANTHROPIC-KEY-FALLBACK]")), log.lines.join("\n"));

    // phase 2 (positive control): the same stub shape on the MAIN lane still spends the router key.
    const main = await H.send(srv, { headers: { "x-claude-code-session-id": "sess-key-f" }, body: body("key-f-main") });
    assert.strictEqual(main.status, 200, main.text);
    assert.strictEqual(up.anthropic.length, 3, "OAuth attempt, then the key retry, after the subagent hop");
    assert.strictEqual(seen[1].authorization, H.CLIENT_AUTH, "the main OAuth attempt carries the client bearer");
    assert.strictEqual(seen[2].apiKey, ROUTER_KEY, "the main lane still retries with the router key");
    assert.strictEqual(seen[2].authorization, undefined);
    assert.ok(log.lines.some((l) => l.startsWith("[ANTHROPIC-KEY-FALLBACK] role=main-orchestrator OAuth status=429")), log.lines.join("\n"));
    assert.strictEqual(up.ogo.length, 1, "only the subagent lane dials OpenCode Go");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
  }
});

test("(g) a key-served main turn leaves keepwarm's stored/learned credential as the client OAuth bearer", async () => {
  clearArtifacts();
  const restoreEnv = H.withEnv({
    [ROUTER_KEY_ENV]: ROUTER_KEY,
    ROUTER_KEEPWARM: "1",
    KEEPWARM_IDLE_MS: "600000",
    KEEPWARM_MAX_IDLE_MS: "600000",
  });
  let dialled = 0;
  const up = H.installUpstreams({
    ogo: () => H.ogoOk("never-forged"),
    anthropic: () => (++dialled === 1 ? H.anthropic429() : H.anthropicOk()),
  });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, { headers: { "x-claude-code-session-id": "sess-key-g" }, body: body("key-g") });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(up.anthropic.length, 2, "OAuth attempt, then the router-key retry");
    await H.waitFor(() => keepwarm.sessions.has("sess-key-g"), "the keep-warm session armed");
    const session = keepwarm.sessions.get("sess-key-g");
    assert.strictEqual(session.headers.authorization, H.CLIENT_AUTH, "the stored session keeps the client's OAuth bearer");
    assert.strictEqual(session.headers["x-api-key"], undefined, "the paid router key never becomes the session credential");
    // The ping that this session will send must carry the client bearer and no paid key.
    const pingHeaders = keepwarm.buildPingHeaders(session, { upstreamUrl: keepwarm.DEFAULT_UPSTREAM_URL }, 16, null);
    assert.strictEqual(pingHeaders.authorization, H.CLIENT_AUTH);
    assert.strictEqual(pingHeaders["x-api-key"], undefined);
    assert.ok(keepwarm.credentialState().sessions >= 1, "the served turn still learns the client credential");
  } finally {
    keepwarm.reset();
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
  }
});
