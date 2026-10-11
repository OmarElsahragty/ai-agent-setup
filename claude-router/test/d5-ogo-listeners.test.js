"use strict";
/**
 * D5 item 1 (Review-A minor): handleOpenCodeGo re-enters with the SAME client response on every
 * fallback-budget drain -> OpenCode Go retry -> re-queue cycle. Each entry used to add a "close" and a
 * "finish" listener that were never removed. Behavioural: the cycles are driven through
 * routerRequestHandler on a loopback server; https is stubbed in-process (nothing leaves the machine).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./d5-harness");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "d5-listeners-"));
H.clearRouterEnv();
process.env.ROUTER_USAGE_LOG = path.join(TMP, "router-usage.jsonl");
process.env["OPENCODE_GO_" + "API_KEY"] = H.PLACEHOLDER;
process.env.OPENCODE_GO_BREAKER_FAILS = "3";
process.env.OPENCODE_GO_BREAKER_COOLDOWN_MS = "600000"; // the closed-breaker re-probe never fires inside this test

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const hook = server.__fallbackBudgetTestHook;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SUB = { "x-subagent-name": "implementer", "x-claude-code-agent-id": "a1" };
const body = (marker) => ({ model: "deepseek-v4.1-flash", max_tokens: 64, stream: false, messages: [{ role: "user", content: `marker=${marker}` }] });

test("12 drain -> OpenCode Go retry -> re-queue cycles leave the client response's listener counts flat", async () => {
  hook.reset();
  const restoreEnv = H.withEnv({ FALLBACK_MAX_CONCURRENT: "0", FALLBACK_QUEUE_MAX_WAIT_MS: "60000" });
  const up = H.installUpstreams({
    ogo: (e) => (e.marker === "loop" ? H.ogo429() : H.ogoOk(e.marker)),
    anthropic: () => { throw new Error("no Anthropic call is expected in this test"); },
  });
  const responses = [];
  const srv = await H.startRouter(server.routerRequestHandler, (req, res) => responses.push(res));
  const warnings = [];
  const onWarning = (w) => warnings.push(w && w.name);
  process.on("warning", onWarning);
  const log = H.captureConsole();
  const ac = new AbortController();
  try {
    H.send(srv, { headers: SUB, body: body("loop"), signal: ac.signal }).catch(() => null);
    await H.waitFor(() => hook.state().queued === 1, "the loop request queued after its OpenCode Go failure");
    const res = responses[0];
    const base = { close: res.listenerCount("close"), finish: res.listenerCount("finish") };
    const loopCalls = () => up.ogo.filter((e) => e.marker === "loop").length;
    for (let i = 0; i < 12; i++) {
      const before = loopCalls();
      const probe = await H.send(srv, { headers: SUB, body: body(`probe${i}`) });
      assert.equal(probe.status, 200, `probe ${i} served by OpenCode Go`);
      // The probe's success closes the breaker, drains the queue, and the loop request retries OpenCode Go,
      // fails again and re-queues: one full handleOpenCodeGo re-entry per cycle.
      await H.waitFor(() => loopCalls() > before && hook.state().queued === 1, `cycle ${i} re-queued`);
    }
    assert.equal(loopCalls(), 13, "13 handleOpenCodeGo entries for the same client response");
    assert.equal(res.listenerCount("close"), base.close, "close listeners must not grow per cycle");
    assert.equal(res.listenerCount("finish"), base.finish, "finish listeners must not grow per cycle");
    assert.ok(!warnings.includes("MaxListenersExceededWarning"), "no MaxListenersExceededWarning");
    assert.equal(up.anthropic.length, 0);
  } finally {
    ac.abort();
    await H.sleep(30);
    log.restore();
    process.removeListener("warning", onWarning);
    await H.stopRouter(srv);
    up.restore();
    restoreEnv();
    hook.reset();
  }
});
