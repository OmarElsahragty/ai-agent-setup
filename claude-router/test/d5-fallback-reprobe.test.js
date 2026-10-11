"use strict";
/**
 * D5 item 2 (Review-A minor): queued fallback jobs re-probe OpenCode Go on a timer. Before the fix a queue
 * only moved when an Anthropic slot freed or a NEW request reached OpenCode Go after the cooldown; with no
 * fresh traffic every job waited out FALLBACK_QUEUE_MAX_WAIT_MS. No test here sends any extra request:
 * the timer alone must bring the queued jobs back to OpenCode Go. https is stubbed in-process.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./d5-harness");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "d5-reprobe-"));
H.clearRouterEnv();
process.env.ROUTER_USAGE_LOG = path.join(TMP, "router-usage.jsonl");
process.env["OPENCODE_GO_" + "API_KEY"] = H.PLACEHOLDER;
process.env.OPENCODE_GO_BREAKER_FAILS = "2";
process.env.OPENCODE_GO_BREAKER_COOLDOWN_MS = "200";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const hook = server.__fallbackBudgetTestHook;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SUB = { "x-subagent-name": "implementer", "x-claude-code-agent-id": "a1" };
const body = (marker) => ({ model: "deepseek-v4.1-flash", max_tokens: 64, stream: false, messages: [{ role: "user", content: `marker=${marker}` }] });

/** OpenCode Go fails the first `fails` calls of each marker, then serves it. */
function failingThenOk(fails) {
  const seen = new Map();
  return (e) => {
    const n = (seen.get(e.marker) || 0) + 1;
    seen.set(e.marker, n);
    return n <= fails ? H.ogo429() : H.ogoOk(e.marker);
  };
}

async function setup(ogo) {
  hook.reset();
  const restoreEnv = H.withEnv({ FALLBACK_MAX_CONCURRENT: "0", FALLBACK_QUEUE_MAX_WAIT_MS: "4000" });
  const up = H.installUpstreams({ ogo, anthropic: () => { throw new Error("no Anthropic call is expected"); } });
  const srv = await H.startRouter(server.routerRequestHandler);
  const log = H.captureConsole();
  return {
    up, srv, log,
    async done() {
      log.restore();
      await H.stopRouter(srv);
      up.restore();
      restoreEnv();
      hook.reset();
    },
  };
}

const within = (p, ms, what) => Promise.race([p, H.sleep(ms).then(() => { throw new Error(`timeout waiting for: ${what}`); })]);

test("closed breaker: a queued job goes back to OpenCode Go on the re-probe timer, no new traffic needed", async () => {
  const t = await setup(failingThenOk(1));
  try {
    const p = H.send(t.srv, { headers: SUB, body: body("rpA") });
    await H.waitFor(() => hook.state().queued === 1, "rpA queued");
    assert.equal(hook.breaker.openUntil, 0, "one failure (< OPENCODE_GO_BREAKER_FAILS) leaves the breaker closed");
    const r = await within(p, 2500, "rpA served by the re-probe");
    assert.equal(r.status, 200);
    assert.match(r.text, /served-by-ogo rpA/);
    assert.equal(t.up.markers("ogo").filter((m) => m === "rpA").length, 2);
    assert.ok(t.log.lines.some((l) => /^\[FALLBACK-BUDGET\] granted role=implementer .*via=ogo reprobe=1/.test(l)), "re-probe grant logged");
    assert.deepEqual(hook.state(), { active: 0, queued: 0 });
  } finally {
    await t.done();
  }
});

test("open breaker: a failed re-probe re-queues the job, the timer re-arms at openUntil, the next probe serves it", async () => {
  const t = await setup(failingThenOk(2));
  try {
    const p = H.send(t.srv, { headers: SUB, body: body("rpB") });
    const r = await within(p, 3000, "rpB served after two failed attempts");
    assert.equal(r.status, 200);
    assert.match(r.text, /served-by-ogo rpB/);
    assert.equal(t.up.markers("ogo").filter((m) => m === "rpB").length, 3, "first try + failed probe + served probe");
    assert.ok(t.log.lines.some((l) => l.startsWith("[BREAKER] opencode-go OPEN")), "the failed probe opened the breaker");
    assert.ok(t.log.lines.some((l) => l.startsWith("[BREAKER] opencode-go closed")), "the served probe closed it");
    assert.equal(hook.breaker.consecutiveFailures, 0);
    assert.deepEqual(hook.state(), { active: 0, queued: 0 });
  } finally {
    await t.done();
  }
});

test("only the queue head probes; its success drains the rest back to OpenCode Go", async () => {
  const t = await setup(failingThenOk(1));
  try {
    const p1 = H.send(t.srv, { headers: SUB, body: body("rpC1") });
    await H.waitFor(() => hook.state().queued === 1, "rpC1 queued");
    const p2 = H.send(t.srv, { headers: SUB, body: body("rpC2") });
    await H.waitFor(() => hook.state().queued === 2, "rpC2 queued (its failure opened the breaker)");
    const [r1, r2] = await within(Promise.all([p1, p2]), 3000, "both served");
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const order = t.up.markers("ogo");
    assert.deepEqual(order.slice(0, 2), ["rpC1", "rpC2"], "both tried OpenCode Go once");
    assert.deepEqual(order.slice(2), ["rpC1", "rpC2"], "the head re-probed first, then the drain sent rpC2");
    assert.equal(t.log.lines.filter((l) => /via=ogo reprobe=1/.test(l)).length, 1, "exactly one re-probe");
  } finally {
    await t.done();
  }
});
