"use strict";
// Owner lane directive 2026-10-11: every subagent, background job and image payload routes to OpenCode Go
// deepseek-v4.1-flash at max effort. The removed Z.AI provider is never a route target or a fallback target.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./d5-harness");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-"));
H.clearRouterEnv();
process.env.ROUTER_USAGE_LOG = path.join(TMP, "router-usage.jsonl");
process.env.CLAUDE_ROUTER_FALLBACK_STATE = path.join(TMP, "fallback-state.json");
process.env.OPENCODE_GO_API_KEY = H.PLACEHOLDER;

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server.js");
const { classifyRequest, fallbackTargetFor } = server;
const hook = server.__fallbackBudgetTestHook;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ROLES = ["qa", "code-reviewer", "security-reviewer", "implementer", "quant-engineer", "tester",
               "research", "database-analyst", "homelab-operator", "ui-designer", "android-engineer",
               "explore", "plan", "general-purpose"];
const PROVIDERS = new Set(["OPENCODE_GO", "ANTHROPIC"]);
const IMAGE_PART = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];

function route(role) {
  const req = { headers: { "x-subagent-name": role, "x-claude-code-agent-id": "a1" } };
  return classifyRequest(req, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });
}

function envNameFor(role) {
  return `ROLE_PLAN_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function captureWarnings(fn) {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.warn = realWarn;
  }
  return warnings;
}

function allPathRequests() {
  const text = [{ role: "user", content: "hi" }];
  const image = [{ role: "user", content: [IMAGE_PART] }];
  const sub = (role) => ({ headers: { "x-subagent-name": role, "x-claude-code-agent-id": "a1" } });
  const reqs = [];
  for (const role of [...ROLES, "some-future-agent"]) {
    reqs.push([`role ${role}`, sub(role), { model: "claude-opus-5-5", tools: TOOLS, messages: text }]);
    reqs.push([`role ${role} image`, sub(role), { model: "claude-opus-5-5", tools: TOOLS, messages: image }]);
  }
  reqs.push(["main orchestrator", { headers: {} }, { model: "claude-opus-5-5[1m]", tools: TOOLS, messages: text }]);
  reqs.push(["main orchestrator image", { headers: {} }, { model: "claude-opus-5-5[1m]", tools: TOOLS, messages: image }]);
  reqs.push(["main deepseek CEO", { headers: {} }, { model: "deepseek-v4.1-flash", tools: TOOLS, messages: text }]);
  reqs.push(["negative control main glm-5.3", { headers: {} }, { model: "glm-5.3", tools: TOOLS, messages: text }]);
  reqs.push(["negative control main glm-5.3-flash image", { headers: {} }, { model: "glm-5.3-flash", tools: TOOLS, messages: image }]);
  reqs.push(["background haiku title", { headers: {} }, { model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "Please generate a title for this conversation" }] }]);
  reqs.push(["background header", { headers: { "x-claude-code-background": "1" } }, { model: "claude-opus-5-5", messages: text }]);
  reqs.push(["background task type", { headers: { "x-claude-code-task-type": "title" } }, { model: "claude-opus-5-5", messages: text }]);
  reqs.push(["background role bg", { headers: { "x-subagent-name": "bg" } }, { model: "claude-opus-5-5", messages: text }]);
  reqs.push(["summary task type", { headers: { "x-claude-code-task-type": "summary" } }, { model: "claude-opus-5-5", messages: text }]);
  reqs.push(["away summary prompt", { headers: {} }, { model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "Write a brief away summary" }] }]);
  reqs.push(["explicit compact", { headers: { "x-claude-code-task-type": "compact" } }, { model: "claude-opus-5-5", tools: TOOLS, messages: text }]);
  reqs.push(["prompt compact", { headers: {} }, { model: "claude-opus-5-5", tools: TOOLS,
    messages: [{ role: "user", content: "Your task is to create a detailed summary of the conversation so far" }] }]);
  reqs.push(["subagent compact", sub("implementer"), { model: "deepseek-v4.1-flash", tools: TOOLS,
    messages: [{ role: "user", content: "create a detailed summary of the conversation so far" }] }]);
  return reqs;
}

function assertProvidersOnly() {
  const reasons = new Set();
  for (const [label, req, body] of allPathRequests()) {
    const r = classifyRequest(req, body);
    reasons.add(r.reason);
    assert.ok(PROVIDERS.has(r.target), `${label}: target ${r.target}`);
    if (r.fallback) assert.ok(PROVIDERS.has(r.fallback.target), `${label}: fallback target ${r.fallback.target}`);
    assert.doesNotMatch(JSON.stringify(r), /zai/i, label);
  }
  for (const reason of ["compaction", "summary", "background", "main-orchestrator", "implementer"]) {
    assert.ok(reasons.has(reason), `path not exercised: ${reason}`);
  }
}

test("every subagent (11 roles + built-ins) routes to deepseek-v4.1-flash at max effort (owner 2026-10-11)", () => {
  for (const role of ROLES) {
    const r = route(role);
    assert.strictEqual(r.target, "OPENCODE_GO", role);
    assert.strictEqual(r.model, "deepseek-v4.1-flash", role);
    assert.strictEqual(r.effort, "max", role);
    assert.strictEqual(r.anthropicFallbackModel, "claude-haiku-5-5", role);
  }
});

test("a subagent inheriting deepseek-v4.1-flash from a DeepSeek CEO runs on deepseek-v4.1-flash; the DeepSeek CEO itself keeps deepseek-v4.1-flash", () => {
  for (const role of ROLES) {
    const req = { headers: { "x-subagent-name": role, "x-claude-code-agent-id": "a1" } };
    const r = classifyRequest(req, { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.target, "OPENCODE_GO", role);
    assert.strictEqual(r.model, "deepseek-v4.1-flash", role);
  }
  const ceo = classifyRequest({ headers: {} }, { model: "deepseek-v4.1-flash", tools: [{ name: "Agent" }],
    messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(ceo.target, "OPENCODE_GO");
  assert.strictEqual(ceo.model, "deepseek-v4.1-flash");
  assert.strictEqual(ceo.role, "main-orchestrator");
});

test("background title jobs stay on deepseek-v4.1-flash", () => {
  const r = classifyRequest({ headers: {} }, { model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "Please generate a title for this conversation" }] });
  assert.strictEqual(r.target, "OPENCODE_GO");
  assert.strictEqual(r.model, "deepseek-v4.1-flash");
});

test("image on a subagent routes to deepseek-v4.1-flash like any subagent", () => {
  const req = { headers: { "x-subagent-name": "ui-designer", "x-claude-code-agent-id": "a1" } };
  const r = classifyRequest(req, { model: "claude-opus-5-5", messages: [{ role: "user", content: [IMAGE_PART] }] });
  assert.strictEqual(r.target, "OPENCODE_GO");
  assert.strictEqual(r.model, "deepseek-v4.1-flash");
  assert.strictEqual(r.effort, "max");
  assert.deepStrictEqual(r, route("ui-designer"));
});

test("a stale deepseek ROLE_PLAN override falls back to the default plan with exactly one warning", () => {
  const baseline = withEnv({}, () => route("implementer"));
  assert.strictEqual(baseline.target, "OPENCODE_GO");
  assert.strictEqual(baseline.model, "deepseek-v4.1-flash");
  assert.strictEqual(baseline.effort, "max");
  let routes;
  const warnings = withEnv({ ROLE_PLAN_IMPLEMENTER: "deepseek:x:y:max" }, () =>
    captureWarnings(() => { routes = [route("implementer"), route("implementer"), route("implementer")]; }));
  for (const r of routes) assert.deepStrictEqual(r, baseline);
  assert.strictEqual(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /role=implementer\b/);
  assert.match(warnings[0], /target=deepseek\b/);
});

test("a stale zai ROLE_PLAN override is ignored and the warning names only the role and target", () => {
  const baseline = route("research");
  let r;
  const warnings = withEnv({ ROLE_PLAN_RESEARCH: "zai:stale-model-q7:stale-fallback-z9:max" }, () =>
    captureWarnings(() => { r = route("research"); }));
  assert.deepStrictEqual(r, baseline);
  assert.strictEqual(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /role=research\b/);
  assert.match(warnings[0], /target=zai\b/);
  for (const leaked of ["stale-model-q7", "stale-fallback-z9"]) assert.ok(!warnings[0].includes(leaked), leaked);
});

test("valid opencode-go, opencode_go and anthropic ROLE_PLAN overrides are still honoured without a warning", () => {
  let t;
  let q;
  let h;
  const warnings = withEnv({
    ROLE_PLAN_TESTER: "opencode-go:deepseek-v4.1-flash:claude-haiku-5-5:max",
    ROLE_PLAN_QA: "anthropic:claude-opus-5-5:deepseek-v4.1-flash:medium",
    ROLE_PLAN_HOMELAB_OPERATOR: "opencode_go:deepseek-v4.1-flash:claude-haiku-5-5:max",
  }, () => captureWarnings(() => { t = route("tester"); q = route("qa"); h = route("homelab-operator"); }));
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(t.target, "OPENCODE_GO");
  assert.strictEqual(t.model, "deepseek-v4.1-flash");
  assert.strictEqual(t.effort, "max");
  assert.strictEqual(t.anthropicFallbackModel, "claude-haiku-5-5");
  assert.strictEqual(h.target, "OPENCODE_GO");
  assert.strictEqual(h.model, "deepseek-v4.1-flash");
  assert.strictEqual(h.anthropicFallbackModel, "claude-haiku-5-5");
  assert.strictEqual(q.target, "ANTHROPIC");
  assert.strictEqual(q.model, "claude-opus-5-5");
  assert.strictEqual(q.effort, "medium");
  assert.deepStrictEqual(q.fallback, { target: "OPENCODE_GO", model: "deepseek-v4.1-flash" });
});

test("negative control: every classifyRequest path (roles, images, main, background, summary, compaction) targets only OPENCODE_GO or ANTHROPIC", () => {
  assertProvidersOnly();
});

test("stale zai and deepseek overrides on every role still leave only OPENCODE_GO or ANTHROPIC routes, one warning each", () => {
  const stale = ["zai:glm-5.3-flash:claude-sonnet-5:max", "deepseek:deepseek-flash:claude-sonnet-5:max"];
  const vars = {};
  [...ROLES, "some-future-agent"].forEach((role, i) => { vars[envNameFor(role)] = stale[i % 2]; });
  const warnings = withEnv(vars, () => captureWarnings(assertProvidersOnly));
  assert.strictEqual(warnings.length, Object.keys(vars).length, warnings.join("\n"));
});

test("fallbackTargetFor maps deepseek-* to OPENCODE_GO and every other model, including glm-*, to ANTHROPIC", () => {
  assert.strictEqual(fallbackTargetFor("deepseek-v4.1-flash"), "OPENCODE_GO");
  assert.strictEqual(fallbackTargetFor("claude-opus-5-5"), "ANTHROPIC");
  assert.strictEqual(fallbackTargetFor("claude-sonnet-5"), "ANTHROPIC");
  assert.strictEqual(fallbackTargetFor("claude-haiku-5-5"), "ANTHROPIC");
  assert.strictEqual(fallbackTargetFor("glm-5.3"), "ANTHROPIC");
  assert.strictEqual(fallbackTargetFor("glm-5.3-flash"), "ANTHROPIC");
});

test("the removed provider lanes leave no exported test seams", () => {
  for (const name of ["resolveOpenCodeGoModel", "isOpenCodeGoDeadModelCause", "__openCodeGoModelSeam",
    "handleZai", "isTerminalZai429", "__zaiEgressTestHook"]) {
    assert.strictEqual(server[name], undefined, name);
  }
});

test("negative control: a main request on glm-5.3 or glm-5.3-flash classifies to ANTHROPIC, never OPENCODE_GO", () => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    const r = classifyRequest({ headers: {} }, { model, tools: TOOLS, messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(r.target, "ANTHROPIC", model);
    assert.notStrictEqual(r.target, "OPENCODE_GO", model);
    assert.strictEqual(r.model, model, model);
    assert.strictEqual(r.role, "main-orchestrator", model);
    // Owner ruling 2026-10-11: the main lane is Anthropic-only, so it carries no fallback plan at all.
    assert.strictEqual(r.fallback, null, model);
  }
});

test("owner ruling 2026-10-11: the main and compaction lanes carry no fallback; the DeepSeek CEO and subagent lanes keep theirs", () => {
  const main = classifyRequest({ headers: {} }, { model: "claude-opus-5-5[1m]", tools: TOOLS, messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(main.role, "main-orchestrator");
  assert.strictEqual(main.fallback, null);
  const compact = classifyRequest({ headers: { "x-claude-code-task-type": "compact" } },
    { model: "claude-opus-5-5", tools: TOOLS, messages: [{ role: "user", content: "create a detailed summary of the conversation so far" }] });
  assert.strictEqual(compact.target, "ANTHROPIC");
  assert.strictEqual(compact.reason, "compaction");
  assert.strictEqual(compact.model, server.COMPACTION_PLAN.model);
  assert.strictEqual(compact.effort, "medium");
  assert.strictEqual(compact.fallback, null);
  assert.strictEqual(server.COMPACTION_PLAN.fallback, null);
  // Untouched lanes: every subagent still hops to Haiku, the DeepSeek CEO still hops to Opus 5.5 high.
  assert.strictEqual(server.DEFAULT_ROLE_PLAN["implementer"].fallback, "claude-haiku-5-5");
  const ceo = classifyRequest({ headers: {} }, { model: "deepseek-v4.1-flash", tools: TOOLS, messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(ceo.role, "main-orchestrator");
  assert.strictEqual(ceo.target, "OPENCODE_GO");
  assert.strictEqual(ceo.anthropicFallbackModel, "claude-opus-5-5");
  assert.strictEqual(ceo.anthropicFallbackEffort, "high");
});

test("negative control (wire): a main glm-5.3 request reaches only api.anthropic.com; OpenCode Go is never dialled", async () => {
  hook.reset();
  const up = H.installUpstreams({ ogo: () => H.ogoOk("glm-control"), anthropic: () => H.anthropicOk() });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  try {
    const r = await H.send(srv, { body: { model: "glm-5.3", max_tokens: 64, stream: true, tools: TOOLS,
      messages: [{ role: "user", content: "marker=glmcontrol" }] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(up.anthropic.length, 1, "exactly one upstream call");
    assert.strictEqual(up.anthropic[0].host, "api.anthropic.com");
    assert.strictEqual(up.anthropic[0].body.model, "glm-5.3", "the client model is answered as-is, never rewritten");
    assert.strictEqual(up.ogo.length, 0, "OpenCode Go was never dialled");
    assert.ok(log.lines.some((l) => l.startsWith("[ROUTE:ANTHROPIC] model=glm-5.3 reason=main-orchestrator")), "routed to the Anthropic main lane");
  } finally {
    log.restore();
    await H.stopRouter(srv);
    up.restore();
    hook.reset();
  }
});

test("negative control: ROLE_PLAN_IMPLEMENTER=zai:... is ignored; the implementer keeps the default deepseek plan with exactly one warning", () => {
  const baseline = withEnv({}, () => route("implementer"));
  assert.strictEqual(baseline.target, "OPENCODE_GO");
  assert.strictEqual(baseline.model, "deepseek-v4.1-flash");
  let routes;
  const warnings = withEnv({ ROLE_PLAN_IMPLEMENTER: "zai:glm-5.3-flash:claude-haiku-5-5:max" }, () =>
    captureWarnings(() => { routes = [route("implementer"), route("implementer"), route("implementer")]; }));
  for (const r of routes) assert.deepStrictEqual(r, baseline);
  assert.strictEqual(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /role=implementer\b/);
  assert.match(warnings[0], /target=zai\b/);
  for (const leaked of ["glm-5.3-flash", "claude-haiku-5-5"]) assert.ok(!warnings[0].includes(leaked), leaked);
});
