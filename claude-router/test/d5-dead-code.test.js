"use strict";
/**
 * D5 item 5 (Review-A minor): dead code removed and kept out. Each name had exactly one
 * definition and no reader (appendEnglishInvariant: never called; UI_VISION_ROLES: never read;
 * SUBAGENT_PRIMARY_MODEL: never read). The old fallback4xx forward() parameter is no longer banned
 * by name: the OpenCode Go lane rule (retry429.fallback4xx, WO spec S3) reuses that name legitimately.
 * The retired Z.AI symbols, hosts and env names are asserted absent in the second test.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["server.js", "keepwarm.js", "context-shaping.js"];
const DEAD_CODE = ["appendEnglishInvariant", "UI_VISION_ROLES", "SUBAGENT_PRIMARY_MODEL"];
const RETIRED_ZAI = ["handleZai", "api.z.ai", "ZAI_API_KEY", "glm-"];

test("removed dead code stays removed from every router source", () => {
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const name of DEAD_CODE) {
      assert.ok(!src.includes(name), `${file} still mentions ${name}`);
    }
  }
});

test("retired Z.AI symbols, hosts and env names stay absent from every router source", () => {
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const name of RETIRED_ZAI) {
      assert.ok(!src.includes(name), `${file} still mentions retired ${name}`);
    }
    assert.doesNotMatch(src, /zai/i, `${file} still mentions a retired zai helper or env name`);
  }
});

test("server.js still loads and exports its public surface", () => {
  const server = require("../server");
  for (const name of ["classifyRequest", "routerRequestHandler", "buildAnthropicOutboundBody"]) {
    assert.equal(typeof server[name], "function", name);
  }
});
