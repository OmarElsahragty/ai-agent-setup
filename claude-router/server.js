/**
 * Claude Code router — lane map (owner ruling 2026-10-11, supersedes the 2026-10-10 map):
 * - Main session -> Anthropic claude-opus-5-5 (client-selected effort, default high). Never falls back to
 *   a third-party model: a 429/402/403 on the OAuth credential is retried ONCE with the router's own
 *   ANTHROPIC_API_KEY; if that also fails the client receives the key attempt's real status and body.
 * - DeepSeek CEO (`claude --model deepseek-v4.1-flash`) -> OpenCode Go deepseek-v4.1-flash max; one hop
 *   to Anthropic claude-opus-5-5 high (unbudgeted, like main).
 * - EVERY subagent role + built-in (Explore, Plan, general-purpose, ...) -> OpenCode Go
 *   deepseek-v4.1-flash, max effort; one hop to Anthropic claude-haiku-5-5 at max effort (budgeted,
 *   see fallbackToAnthropic).
 * - Background jobs (titles, command checks, away/session summaries) and image payloads ->
 *   deepseek-v4.1-flash max, claude-haiku-5-5 max fallback.
 * - Compact & auto-compact -> Anthropic Opus 5.5 MEDIUM, same Anthropic-only rule as main (no hop).
 * - The Anthropic fallback budget (FALLBACK_MAX_CONCURRENT, default 2, FIFO, main lane exempt)
 *   applies to every haiku hop unchanged (WO-N1 / M-002).
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { applyContextShaping } = require("./context-shaping");
const keepwarm = require("./keepwarm");

if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

const PORT = 3920;
const HOST = "127.0.0.1";
const ANTHROPIC_HOST = "api.anthropic.com";
const OPENCODE_GO_HOST = "opencode.ai";
const OPENCODE_GO_PATH = "/zen/go/v1/messages";
// Every model id served by the OpenCode Go lane starts with "deepseek-" (owner ruling 2026-10-11).
const OPENCODE_GO_MODEL_RE = /^deepseek-/i;
const DEEPSEEK_FLASH_MODEL = "deepseek-v4.1-flash";

// SUBAGENT_PRIMARY (default "anthropic") lets every role follow its rolePlanFor() plan below;
// SUBAGENT_PRIMARY=opencode-go forces every role onto OpenCode Go with no per-role plan (emergency switch).
const SUBAGENT_PRIMARY = (process.env.SUBAGENT_PRIMARY || "anthropic").trim().toLowerCase();

// Override a single role in .env, e.g. ROLE_PLAN_IMPLEMENTER="opencode-go:deepseek-v4.1-flash:claude-haiku-5-5:max"
// (target:model:fallback:effort; target is opencode-go or anthropic only).
// Historical lane directives (2026-09-22 .. 2026-10-10) are archived in memory SOT and git history;
// the owner ruling 2026-10-11 below is the current map (see the header comment).
// `effort` is applied as output_config.effort by handleAnthropic (Opus 5.5: thinking cannot be
// disabled and budget_tokens / forced tool_choice return 400, so those are normalised there).
// Owner ruling 2026-10-11 (the previous provider is removed completely; OpenCode Go deepseek-v4.1-flash
// max replaces both of its models everywhere); the 2026-10-10 lane shape is otherwise unchanged:
const OPUS_MEDIUM_LANE = { target: "ANTHROPIC", model: "claude-opus-5-5", fallback: null, effort: "medium" };
const HAIKU_MAX_FALLBACK_MODEL = "claude-haiku-5-5";
const HAIKU_MAX_FALLBACK_EFFORT = "max";
// deepseek-v4.1-flash lane: one hop to Anthropic Haiku 5.5 at max effort (budgeted — fallbackToAnthropic).
const DEEPSEEK_FLASH_MAX_LANE = { target: "OPENCODE_GO", model: DEEPSEEK_FLASH_MODEL, fallback: HAIKU_MAX_FALLBACK_MODEL, fallbackEffort: HAIKU_MAX_FALLBACK_EFFORT, effort: "max" };
const DEFAULT_ROLE_PLAN = {
  "quant-engineer":    DEEPSEEK_FLASH_MAX_LANE,
  "implementer":       DEEPSEEK_FLASH_MAX_LANE,
  "code-reviewer":     DEEPSEEK_FLASH_MAX_LANE,
  "tester":            DEEPSEEK_FLASH_MAX_LANE,
  "qa":                DEEPSEEK_FLASH_MAX_LANE,
  "security-reviewer": DEEPSEEK_FLASH_MAX_LANE,
  "database-analyst":  DEEPSEEK_FLASH_MAX_LANE,
  "research":          DEEPSEEK_FLASH_MAX_LANE,
  "homelab-operator":  DEEPSEEK_FLASH_MAX_LANE,
  "ui-designer":       DEEPSEEK_FLASH_MAX_LANE,
  "android-engineer":  DEEPSEEK_FLASH_MAX_LANE,
};
// EVERY subagent (all 11 roles + built-ins: Explore, Plan, general-purpose, ...) runs on OpenCode Go
// deepseek-v4.1-flash at max effort with the claude-haiku-5-5 max one-hop fallback (budgeted).
// Background jobs (titles, command checks, summaries) use the same lane (background branch in classifyRequest).
const DEFAULT_SUBAGENT_PLAN = DEEPSEEK_FLASH_MAX_LANE;
// Compaction + auto-compact ONLY: Anthropic Opus 5.5 MEDIUM. Main and compaction are Anthropic-only
// (owner ruling 2026-10-11): neither hops to a third-party model, so there is no Opus fallback model.
// The one substitution left on these lanes is the router ANTHROPIC_API_KEY retry in handleAnthropic.
const OPUS_FALLBACK_MODEL = null;
// The DeepSeek CEO lane (`claude --model deepseek-v4.1-flash`) falls back to the CEO model, Opus 5.5 at
// high effort — not the claude-haiku-5-5 default every other OpenCode Go lane uses. Unbudgeted, like main.
const DEEPSEEK_CEO_FALLBACK_MODEL = "claude-opus-5-5";
const DEEPSEEK_CEO_FALLBACK_EFFORT = "high";
const COMPACTION_PLAN = { ...OPUS_MEDIUM_LANE, fallback: OPUS_FALLBACK_MODEL };
// An Anthropic lane's fallback provider follows from the fallback model's name.
function fallbackTargetFor(model) {
  return OPENCODE_GO_MODEL_RE.test(String(model || "")) ? "OPENCODE_GO" : "ANTHROPIC";
}

const warnedRolePlanOverrides = new Set();

function parseRolePlanOverride(role) {
  const envName = `ROLE_PLAN_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const raw = process.env[envName];
  if (!raw) return null;
  const [target, model, fallback, effort] = raw.split(":").map((s) => (s || "").trim());
  const t = (target || "").toUpperCase().replace(/-/g, "_");
  if (t && t !== "OPENCODE_GO" && t !== "ANTHROPIC") {
    if (!warnedRolePlanOverrides.has(`${envName}=${raw}`)) {
      warnedRolePlanOverrides.add(`${envName}=${raw}`);
      const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 40);
      console.warn(`[ROLE_PLAN] role=${safe(role)} ignoring ${envName} target=${safe(target)}: only opencode-go or anthropic are supported; using the default plan`);
    }
    return null;
  }
  if (!t || !model) return null;
  return { target: t, model, fallback: fallback || undefined, effort: effort || undefined };
}

function rolePlanFor(role) {
  return parseRolePlanOverride(role) || DEFAULT_ROLE_PLAN[role] || DEFAULT_SUBAGENT_PLAN;
}

const QA_REVIEWER_TESTER_ROLES = new Set([
  "qa",
  "tester",
  "code-reviewer",
  // clean-code-reviewer merged into code-reviewer (2026-09-22): one review pass, both checklists
  "security-reviewer",
  "database-analyst",
]);

function systemTextOf(parsedBody) {
  return typeof parsedBody?.system === "string"
    ? parsedBody.system
    : Array.isArray(parsedBody?.system)
      ? parsedBody.system.map((item) => item.text || "").join(" ")
      : "";
}

function detectRole(req, parsedBody) {
  const headers = req?.headers || {};
  let role = String(headers["x-subagent-name"] || "").trim().toLowerCase();
  if (!role && parsedBody) {
    const sysText = systemTextOf(parsedBody);
    const match = sysText.match(/\[Agent:\s*([a-zA-Z0-9_-]+)/i);
    if (match) {
      role = match[1].toLowerCase();
    }
  }
  return role;
}

function classifyRequest(req, parsedBody = {}) {
  const headers = req.headers || {};
  const detectedRole = detectRole(req, parsedBody);
  const rawRole = detectedRole || String(headers["x-subagent-name"] || "").trim().toLowerCase();
  // Review-A minor (D5): "main-orchestrator" is minted ONLY by the branches below that identify the
  // CEO session structurally (no subagent/background markers + the client's own model choice). A
  // client-supplied string — the x-subagent-name header or a system-text "[Agent: main-orchestrator]"
  // tag — must never claim it: effectiveRole === "main-orchestrator" arms keep-warm, flips the
  // statusline fallback badge and skips the Anthropic fallback budget in fallbackToAnthropic, so a
  // forged string was a free priority bypass. A claiming client gets subagent treatment.
  const role = rawRole === "main-orchestrator" ? "subagent" : rawRole;
  const taskType = String(headers["x-claude-code-task-type"] || "").trim().toLowerCase();
  const isSubagent = !!(headers["x-claude-code-agent-id"] || role);
  const hasTools = Array.isArray(parsedBody?.tools) && parsedBody.tools.length > 0;

  // Compaction detection: COMPACTION_PLAN (Anthropic Opus 5.5 medium, deepseek-v4.1-flash fallback).
  // The compaction prompt is matched regardless of whether tools are attached (2026-09-22):
  // the CLI now sends the tool list with the compaction request, and the `!hasTools` gate
  // silently sent every compaction to the main session's Anthropic model.
  const isExplicitCompact = taskType.includes("compact");
  // Only the LAST message may carry the instruction: a continued session's history contains
  // the previous summary text and must keep routing to the main model.
  const lastMsg = Array.isArray(parsedBody?.messages) ? parsedBody.messages[parsedBody.messages.length - 1] : null;
  const lastText = lastMsg ? (typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content || "")) : "";
  const isPromptCompact =
    lastText.includes("create a detailed summary of the conversation so far") ||
    (!hasTools && (lastText.includes("Summary of previous conversation") || lastText.includes("compact_boundary")));
  if (isExplicitCompact || isPromptCompact) {
    return {
      target: "ANTHROPIC",
      model: COMPACTION_PLAN.model,
      reason: "compaction",
      role: "compaction",
      forceModel: true,
      effort: COMPACTION_PLAN.effort,
      // Owner ruling 2026-10-11: compaction never leaves Anthropic (the router-key retry in
      // handleAnthropic is its only substitution), so there is no fallback target.
      fallback: null,
    };
  }

  // Background detection: explicit background header OR tool-less title/summary request -> OpenCode Go deepseek-v4.1-flash
  // The CLI's small-fast-model calls (haiku: titles, away summaries, command-prefix checks, WebFetch
  // digests) arrive without a subagent header; they are background work, not the CEO (2026-09-26). A haiku
  // subagent (Explore) or any tool-carrying haiku request keeps its role, and with it its tool set.
  const isSmallFastModel = !isSubagent && !hasTools && typeof parsedBody?.model === "string" && /haiku/i.test(parsedBody.model);
  const isExplicitBg = !!(
    isSmallFastModel ||
    headers["x-claude-code-background"] ||
    taskType.includes("background") ||
    taskType.includes("title") ||
    taskType.includes("summary") ||
    role === "bg"
  );
  const isPromptBg = !hasTools && (
    parsedBody?.messages?.some(m => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return text.includes("generate a title") || text.includes("generate a 3-word title") || text.includes("brief away summary");
    })
  );
  if (isExplicitBg || isPromptBg) {
    // Summaries are background jobs (owner 2026-10-10) — deepseek-v4.1-flash max with the
    // claude-haiku-5-5 max one-hop fallback, same as titles and the CLI's small-fast checks.
    const isSummary = taskType.includes("summary") || (parsedBody?.messages || []).some(m => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return text.includes("brief away summary");
    });
    return {
      target: "OPENCODE_GO", model: DEEPSEEK_FLASH_MODEL, reason: isSummary ? "summary" : "background",
      role: isSummary ? "summary" : "background", effort: "max",
      anthropicFallbackModel: HAIKU_MAX_FALLBACK_MODEL, anthropicFallbackEffort: HAIKU_MAX_FALLBACK_EFFORT,
    };
  }

  // Subagent routing: every role follows rolePlanFor() (owner 2026-10-11: deepseek-v4.1-flash max for all).
  // A MAIN session that selects a deepseek-* model (`claude --model deepseek-v4.1-flash`) is the DeepSeek
  // CEO lane: it keeps the main-orchestrator role and the full CEO tool set. Any other non-Anthropic model
  // name from a main session (e.g. a retired model id) is NOT routed to a third-party host: it falls through
  // to the Anthropic main lane below, which answers it as-is.
  const mainDeepseek = !isSubagent && !role && typeof parsedBody?.model === "string" && OPENCODE_GO_MODEL_RE.test(parsedBody.model);
  if (isSubagent || role || mainDeepseek) {
    const outRole = mainDeepseek ? "main-orchestrator" : (role || "subagent");
    // The per-role plan applies unless SUBAGENT_PRIMARY=opencode-go. `mainDeepseek` is excluded: an
    // explicit `claude --model deepseek-v4.1-flash` session must stay on DeepSeek.
    const plan = (!mainDeepseek && SUBAGENT_PRIMARY === "anthropic") ? rolePlanFor(outRole) : null;
    if (plan && plan.target === "ANTHROPIC") {
      return {
        target: "ANTHROPIC",
        model: plan.model,
        reason: outRole,
        role: outRole,
        forceModel: true,
        effort: plan.effort,
        fallback: { target: fallbackTargetFor(plan.fallback || DEEPSEEK_FLASH_MODEL), model: plan.fallback || DEEPSEEK_FLASH_MODEL },
      };
    }
    if (plan && plan.target === "OPENCODE_GO") {
      return {
        target: "OPENCODE_GO",
        model: plan.model,
        reason: outRole,
        role: outRole,
        // handleOpenCodeGo always sends output_config.effort "max" with adaptive thinking (owner directive:
        // every OpenCode Go lane is max); the plan effort is carried so the route log flags a non-max plan.
        effort: plan.effort,
        anthropicFallbackModel: plan.fallback,
        anthropicFallbackEffort: plan.fallbackEffort,
      };
    }
    return {
      target: "OPENCODE_GO", model: DEEPSEEK_FLASH_MODEL, reason: outRole, role: outRole, effort: "max",
      ...(mainDeepseek ? { anthropicFallbackModel: DEEPSEEK_CEO_FALLBACK_MODEL, anthropicFallbackEffort: DEEPSEEK_CEO_FALLBACK_EFFORT } : {}),
    };
  }

  // Main orchestrator routes to Anthropic (respecting user-configured or interactive model/effort)
  const requestedModel = parsedBody?.model;
  return {
    target: "ANTHROPIC",
    model: requestedModel || "claude-opus-5-5[1m]",
    reason: "main-orchestrator",
    role: "main-orchestrator",
    // Owner ruling 2026-10-11: the main lane never falls back to a third-party model. On 429/402/403
    // handleAnthropic retries once with the router ANTHROPIC_API_KEY, then reports the real error.
    fallback: null,
  };
}


const MAIN_CODEBASE_TOOLS = new Set([
  "mcp__codebase-memory__search_code",
  "mcp__codebase-memory__search_graph",
  "mcp__codebase-memory__get_code_snippet",
  "mcp__codebase-memory__get_architecture",
  "mcp__codebase-memory__get_graph_schema",
  // CLAUDE.md names these in the mandatory zero-reread protocol, so the
  // orchestrator must actually be able to call them.
  "mcp__codebase-memory__query_graph",
  "mcp__codebase-memory__trace_path",
  "mcp__codebase-memory__index_status",
  "mcp__codebase-memory__check_index_coverage",
]);

const SUBAGENT_ALLOWED_PREFIXES = {
  "ui-designer": [
    "mcp__stitch__",
    "mcp__claude-design__",
    "mcp__playwright__",
    "mcp__exa__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "database-analyst": [
    "mcp__postgres__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "android-engineer": [
    "mcp__android-adb__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "browser-automator": [
    "mcp__playwright__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "research": [
    // exa is the SOLE internet access tool (CLAUDE.md). The former
    // mcp__deep-research__ entry pointed at a provider whose systemd unit is
    // stopped, so this role had no internet access at all.
    "mcp__exa__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "qa": [
    "mcp__playwright__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "quant-engineer": [
    "mcp__postgres__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "code-reviewer": [
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "clean-code-reviewer": [
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "tester": [
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "security-reviewer": [
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "implementer": [
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "homelab-operator": [
    "mcp__cloudflare__",
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
  "github-assistant": [
    "mcp__unified-memory__",
    "mcp__codebase-memory__",
  ],
};

// Conservative default for unrecognized subagent roles (explore/general-purpose
// built-ins): non-MCP tools pass, MCP limited to memory + codebase discovery.
const SUBAGENT_DEFAULT_PREFIXES = ["mcp__unified-memory__", "mcp__codebase-memory__"];

function pruneTools(tools, role = "", taskType = "") {
  if (!Array.isArray(tools)) return [];

  const r = String(role || "").trim().toLowerCase();
  const t = String(taskType || "").trim().toLowerCase();
  const hadToolCache = tools.some((tool) => tool && tool.cache_control);

  // Compaction check
  if (r === "compaction" || t.includes("compact") || r.includes("compact")) {
    return [];
  }

  // Background / summary / title check
  if (
    r === "bg" ||
    r === "background" ||
    r.includes("summary") ||
    r.includes("title") ||
    t.includes("background") ||
    t.includes("summary") ||
    t.includes("title")
  ) {
    return [];
  }

  let filtered = [];

  // Main orchestrator check
  if (r === "main-orchestrator" || !r) {
    filtered = tools.filter((tool) => {
      const name = tool && typeof tool.name === "string" ? tool.name : "";
      if (!name.startsWith("mcp__")) return true;
      if (name.startsWith("mcp__unified-memory__")) return true;
      if (MAIN_CODEBASE_TOOLS.has(name)) return true;
      if (name.startsWith("mcp__sequential-thinking__")) return true;
      if (name.startsWith("mcp__mcp-reasoner__")) return true;
      // exa is the sole internet access tool; the orchestrator needs it to
      // verify a subagent's findings without re-delegating a whole round.
      if (name.startsWith("mcp__exa__")) return true;
      return false;
    });
  } else if (SUBAGENT_ALLOWED_PREFIXES[r]) {
    const allowed = SUBAGENT_ALLOWED_PREFIXES[r];
    const isQualityReviewer = QA_REVIEWER_TESTER_ROLES.has(r);
    filtered = tools.filter((tool) => {
      const name = tool && typeof tool.name === "string" ? tool.name : "";
      if (!name.startsWith("mcp__")) return true;
      if (!allowed.some((prefix) => name.startsWith(prefix))) return false;
      // Strip mutation tools for read-only reviewers & testers to save tokens and guarantee safety
      if (isQualityReviewer && (
        name.includes("delete_project") ||
        name.includes("index_repository") ||
        name.includes("manage_adr")
      )) {
        return false;
      }
      return true;
    });
  } else {
    // Unrecognized subagent (explore/general-purpose built-ins): conservative
    // default allowlist instead of unpruned — non-MCP tools always pass, MCP
    // limited to memory + codebase discovery (2026-09-22).
    filtered = tools.filter((tool) => {
      const name = tool && typeof tool.name === "string" ? tool.name : "";
      if (!name.startsWith("mcp__")) return true;
      return SUBAGENT_DEFAULT_PREFIXES.some((prefix) => name.startsWith(prefix));
    });
  }

  // Re-anchor prompt caching: deterministic sort + ephemeral breakpoint only if caller intended tool caching
  if (Array.isArray(filtered) && filtered.length > 0) {
    filtered.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i].cache_control) {
        delete filtered[i].cache_control;
      }
    }
    if (hadToolCache) {
      filtered[filtered.length - 1].cache_control = { type: "ephemeral" };
    }
  }

  return filtered;
}

function safeError(res, statusCode, message = "upstream unavailable") {
  if (!res.headersSent) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "proxy_error", message } }));
  }
}

// Upstream 5xx absorption (2026-09-22): retry transient upstream failures
// (Anthropic 529 overloaded / 500 / 502-504) in-place when nothing has been
// forwarded to the client yet. Bodies are always fully buffered, so replay is
// safe; failed responses produced no billable content. 529 gets a deeper budget
// (sustained overload windows) but total wait stays < ~40s, under the client's
// 60s first-byte timeout.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = { 529: 5, default: 3 }; // total attempts incl. the first
const BACKOFFS_MS = [1000, 2000, 4000, 8000];

// Provider fallback (2026-09-22, owner directive): when a OpenCode Go lane is refused (429 rate
// limit / 402 / 403 quota) or its retry budget is exhausted, the SAME request is re-issued
// to Anthropic on the fallback model instead of dying in the caller's lap. `onFail(cause)`
// is only invoked while nothing has been sent to the client, so the replay is clean.
// 401 is deliberately NOT a fallback trigger: a bad OpenCode Go key must fail loudly, not
// silently move every lane onto the subscription.
const FALLBACK_STATUS = new Set([402, 403, 429]);

// R3 (2026-10-10): decode a buffered proxy body for logging/discrimination. The client still
// receives the original bytes; this COPY is ours alone (gzip/br/deflate/zstd aware).
// WO-6 fix 2026-10-11: `cap` is a parameter because the usage scanner decodes a much larger
// copy (a streamed SSE reply) than the 4xx/log path ever buffers.
function decodeProxyBody(raw, headers, cap = 1 << 20) {
  try {
    const enc = String((headers && headers["content-encoding"]) || "").toLowerCase();
    const zlib = require("zlib");
    const opts = { maxOutputLength: cap }; // a tiny compressed body must not inflate past MemoryMax
    return (enc === "br" ? zlib.brotliDecompressSync(raw, opts)
      : enc === "gzip" || enc === "x-gzip" ? zlib.gunzipSync(raw, opts)
      : enc === "deflate" ? zlib.inflateSync(raw, opts)
      : enc === "zstd" && zlib.zstdDecompressSync ? zlib.zstdDecompressSync(raw, opts)
      : raw).toString("utf8");
  } catch {
    return raw.toString("utf8");
  }
}

function forward(req, res, body, options, attempt = 1, onFail = null, retry429 = null) {
  if (res.destroyed) return; // a scheduled retry whose client went away: spend nothing
  const proxyReq = https.request(options, (proxyRes) => {
    const status = proxyRes.statusCode || 502;
    const maxAttempts = MAX_ATTEMPTS[status] || MAX_ATTEMPTS.default;
    if (RETRYABLE_STATUS.has(status) && attempt < maxAttempts && !res.headersSent) {
      const backoff = BACKOFFS_MS[Math.min(attempt - 1, BACKOFFS_MS.length - 1)];
      console.log(`[RETRY] status=${status} attempt=${attempt}/${maxAttempts} in ${backoff}ms`);
      proxyRes.destroy();
      setTimeout(() => forward(req, res, body, options, attempt + 1, onFail, retry429), backoff);
      return;
    }
    // R3 (2026-10-10 wave-kill): a 429 is NOT in RETRYABLE_STATUS — it hops to the fallback
    // immediately. When BOTH providers are limited (OpenCode Go RPM congestion + a closed Anthropic
    // window) every hop dies and agents terminate. A caller that passes retry429 (only the
    // OpenCode Go hop does) gets the 429 body buffered and discriminated first: transient congestion
    // is retried with the standard backoff; terminal exhaustion (drained account, code 1113)
    // still hops immediately so the breaker opens fast.
    if (status === 429 && retry429 && attempt < retry429.maxAttempts && !res.headersSent) {
      const chunks = [];
      let size = 0;
      proxyRes.on("error", () => { if (onFail && !res.headersSent) onFail("status=429 body_reset", { status: 429 }); else safeError(res, 502); });
      proxyRes.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
      proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = decodeProxyBody(raw, proxyRes.headers);
        if (res.destroyed) return; // client gone: do not spend quota on a retry nobody reads
        if (retry429.shouldRetry(text)) {
          const backoff = BACKOFFS_MS[Math.min(attempt - 1, BACKOFFS_MS.length - 1)];
          console.log(`[RETRY-429] attempt=${attempt}/${retry429.maxAttempts} in ${backoff}ms (transient rate limit)`);
          setTimeout(() => forward(req, res, body, options, attempt + 1, onFail, retry429), backoff);
          return;
        }
        console.log(`[429-TERMINAL] body=${text.slice(0, 300).replace(/\s+/g, " ")}`);
        if (onFail && !res.headersSent) { onFail("status=429", { status, headers: proxyRes.headers, body: raw }); return; }
        if (!res.headersSent) { res.writeHead(status, proxyRes.headers); res.end(raw); }
      });
      return;
    }
    if (onFail && !res.headersSent && (FALLBACK_STATUS.has(status) || RETRYABLE_STATUS.has(status))) {
      proxyRes.resume();
      onFail(`status=${status}`, { status, headers: proxyRes.headers });
      return;
    }
    // A 4xx carries a reason and is small: buffer it so the log says WHY, and so a
    // context-length refusal can fall back to the provider with the bigger window instead of
    // killing the lane. Anything else is replayed to the client byte-for-byte.
    if (status >= 400 && status < 500 && !res.headersSent) {
      const chunks = [];
      let size = 0;
      proxyRes.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
      proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks);
        // The upstream body may be compressed: decode a COPY for the log and the
        // length-refusal check; the client still receives the original bytes and headers.
        const text = decodeProxyBody(raw, proxyRes.headers);
        console.log(`[4XX] status=${status} body=${text.slice(0, 300).replace(/\s+/g, " ")}`);
        const isLengthRefusal = /too long|max_tokens|context|token count|exceed|must be passed back/i.test(text);
        if (onFail && isLengthRefusal) return onFail(`status=${status} length_refusal`, { status, headers: proxyRes.headers, body: raw });
        if (onFail && retry429 && retry429.fallback4xx && retry429.fallback4xx(status)) {
          return onFail(`status=${status} lane_refusal`, { status, headers: proxyRes.headers, body: raw });
        }
        if (!res.headersSent) {
          res.writeHead(status, proxyRes.headers);
          res.end(raw);
        }
      });
      return;
    }
    res.writeHead(status, proxyRes.headers);
    proxyRes.pipe(res);
  });
  // A client that leaves before the response finished aborts the upstream call too, so a cancelled
  // fallback stops holding an Anthropic stream (real concurrency stays within the budget).
  const abortUpstream = () => { if (!res.writableFinished) proxyReq.destroy(); };
  res.once("close", abortUpstream);
  proxyReq.once("close", () => res.removeListener("close", abortUpstream));
  proxyReq.on("error", () => {
    if (res.destroyed) return; // aborted because the client left: no retry, no fallback
    if (attempt < 3 && !res.headersSent) {
      console.log(`[RETRY] upstream connect error attempt=${attempt}/3 in 1000ms`);
      setTimeout(() => forward(req, res, body, options, attempt + 1, onFail, retry429), 1000);
      return;
    }
    if (onFail && !res.headersSent) {
      onFail("connect_error");
      return;
    }
    safeError(res, 502);
  });
  if (body.length) proxyReq.write(body);
  proxyReq.end();
}

function capCacheControlBlocks(body, maxAllowed = 4) {
  if (!body) return;
  let count = 0;
  if (Array.isArray(body.system)) {
    for (const b of body.system) if (b && b.cache_control) count++;
  } else if (body.system && body.system.cache_control) {
    count++;
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) if (t && t.cache_control) count++;
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && m.cache_control) count++;
      if (Array.isArray(m?.content)) {
        for (const c of m.content) if (c && c.cache_control) count++;
      }
    }
  }

  if (count > maxAllowed) {
    let excess = count - maxAllowed;
    // Remove excess from oldest messages first to stay within Anthropic 4-block limit
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (excess <= 0) break;
        if (m && m.cache_control) {
          delete m.cache_control;
          excess--;
        }
        if (Array.isArray(m?.content)) {
          for (const c of m.content) {
            if (excess <= 0) break;
            if (c && c.cache_control) {
              delete c.cache_control;
              excess--;
            }
          }
        }
      }
    }
    // If still excess, drop from tools
    if (excess > 0 && Array.isArray(body.tools)) {
      for (const t of body.tools) {
        if (excess <= 0) break;
        if (t && t.cache_control) {
          delete t.cache_control;
          excess--;
        }
      }
    }
  }
}

// Anthropic thinking signatures are long opaque base64; other providers' can be UUIDs or
// 64-char hex digests, and a normalised foreign turn has an empty one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SIG_RE = /^[0-9a-f]+$/i;
function isAnthropicThinkingSignature(sig) {
  return typeof sig === "string" && sig.length >= 64 && !UUID_RE.test(sig) && !HEX_SIG_RE.test(sig);
}

/**
 * The exact outbound body handleAnthropic sends upstream, extracted so it can be asserted
 * offline. G4: the router must NOT inject `context_management` (nor anything else) — Claude
 * Code already sends the beta and already prunes; a second router-written entry would be a
 * cache write nobody reads. A main-lane request with no effort, no foreign thinking block
 * and no cache-cap overflow comes out byte-identical to what the client sent.
 */
function buildAnthropicOutboundBody(parsedBody, model, options = {}) {
  const { forceModel = false, effort = null } = options;
  let outboundBody = parsedBody;
  if (outboundBody && effort) {
    // Routed Anthropic lane: effort is the only depth control. Thinking cannot be disabled and
    // budget_tokens / forced tool_choice return 400 on this model, so normalise them.
    outboundBody = { ...outboundBody, output_config: { ...(outboundBody.output_config || {}), effort } };
    if (outboundBody.thinking && outboundBody.thinking.type !== "adaptive") {
      outboundBody.thinking = { type: "adaptive" };
    }
    const tc = outboundBody.tool_choice;
    if (tc && (tc.type === "any" || tc.type === "tool")) {
      outboundBody.tool_choice = { type: "auto", ...(tc.disable_parallel_tool_use !== undefined ? { disable_parallel_tool_use: tc.disable_parallel_tool_use } : {}) };
    }
  }
  // Routed lanes only (compaction, fallbacks): a conversation that ran on another provider carries
  // thinking blocks signed by that provider (a UUID / hex digest) or with an empty signature; Anthropic rejects them with
  // "Invalid `signature` in `thinking` block" (400, measured 02:24). Drop only those blocks. Since the
  // 2026-09-30 cross-provider Opus fallback the CEO session can carry them too (5x 400 on 09-30 18:04-18:24),
  // so every Anthropic request is filtered; Anthropic-signed blocks are never touched.
  if (outboundBody && Array.isArray(outboundBody.messages)) {
    const foreign = (c) => c && c.type === "thinking" && !isAnthropicThinkingSignature(c.signature);
    if (outboundBody.messages.some((m) => Array.isArray(m?.content) && m.content.some(foreign))) {
      outboundBody = { ...outboundBody, messages: outboundBody.messages.map((m) => (
        Array.isArray(m?.content) && m.content.some(foreign) ? { ...m, content: m.content.filter((c) => !foreign(c)) } : m
      )) };
    }
  }
  if (outboundBody && Array.isArray(outboundBody.tools) && outboundBody.tools.length === 0) {
    outboundBody = { ...outboundBody };
    delete outboundBody.tools;
    delete outboundBody.tool_choice;
  }
  if (outboundBody) {
    capCacheControlBlocks(outboundBody, 4);
  }
  // forceModel: a swapped subagent lane must ignore the body's model (the agent frontmatter
  // may name another model) and use the routed Anthropic model.
  const targetModel = forceModel ? model : (parsedBody?.model || model || "claude-opus-5-5[1m]");
  return { outboundBody, targetModel };
}

// Owner ruling 2026-10-11: an Anthropic lane with no fallback must still terminate. forward()'s hop
// branch discards the body, so the client gets the buffered body when one exists and always the real
// status — never a hang and never a fabricated 200.
function replayUpstreamFailure(res, detail, cause) {
  if (res.headersSent || res.destroyed) return;
  const status = (detail && detail.status) || 502;
  if (detail && detail.body) {
    // Gate fix 2026-10-11: replay only the headers that describe THESE bytes (the OpenCode Go
    // allowlist): raw upstream framing carried the FULL body's content-length, and hop-by-hop
    // headers (transfer-encoding, connection) must never describe the possibly-capped buffer we send.
    // `retry-after` survives the allowlist, so a rate-limit answer keeps its retry hint.
    const headers = ogoErrorHeaders(detail.headers);
    headers["content-length"] = detail.body.length;
    res.writeHead(status, headers);
    res.end(detail.body);
    return;
  }
  safeError(res, status, `Anthropic refused (${cause})`);
}

function handleAnthropic(req, res, rawBody, parsedBody, model, options = {}) {
  const { onFail = null, keepWarmRole = null } = options;
  const role = options.role || keepWarmRole || "";
  // Gate fix 2026-10-11 (owner ruling: the paid key is for the CEO only): the router
  // ANTHROPIC_API_KEY retry below fires for the CEO's own primary Anthropic lane and for compaction
  // ONLY. A fallback hop (res.fallbackHop is set by fallbackToAnthropic: the DeepSeek CEO's Opus hop,
  // a subagent's haiku hop) and a ROLE_PLAN Anthropic primary lane keep their previous behaviour —
  // the client's own bearer, then the real upstream refusal.
  const keyRetryRole = (role === "main-orchestrator" || role === "compaction") && !res.fallbackHop;
  const { outboundBody, targetModel } = buildAnthropicOutboundBody(parsedBody, model, options);
  const body = outboundBody ? Buffer.from(JSON.stringify({ ...outboundBody, model: targetModel }), "utf8") : rawBody;
  const headers = { ...req.headers, host: ANTHROPIC_HOST };
  // I6 (G1): never fabricate `anthropic-beta` for an OAuth Bearer client. Claude Code's OAuth
  // flow signs the request as-is; a beta the client did not send is an unsigned mutation of
  // that request (and Anthropic may reject or bill it differently). Fabrication stays ONLY for
  // x-api-key clients that send no beta at all. Documented deliberate append (existing
  // behaviour, kept for both credential types): a client that lists other betas but not
  // prompt-caching still gets it appended, so cache writes keep working; the client's own
  // value is preserved byte-identical as the prefix.
  if (!headers["anthropic-beta"]) {
    if (!headers.authorization) headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  } else if (!headers["anthropic-beta"].includes("prompt-caching")) {
    headers["anthropic-beta"] = headers["anthropic-beta"] + ",prompt-caching-2024-07-31";
  }
  // I6b (G1): a request carrying no credential at all can only 401 upstream. Say so once —
  // no header values, no secrets — and still forward so the client sees the real answer.
  // Owner ruling 2026-10-11: the router key is injected for main-orchestrator/compaction only
  // (keyRetryRole); every other credential-less request goes upstream bare and gets the real 401.
  const routerAnthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!headers["x-api-key"] && !headers.authorization) {
    if (routerAnthropicKey && keyRetryRole) {
      headers["x-api-key"] = routerAnthropicKey;
      console.log(`[AUTH] role=${role || "-"} injected router ANTHROPIC_API_KEY`);
    } else {
      console.log(`[AUTH] role=${role || "-"} path=${String(req.url || "").split("?")[0]} no-credentials`);
    }
  }
  delete headers.connection;
  delete headers["content-length"];
  delete headers["Content-Length"];
  headers["content-length"] = body.length;
  // Owner ruling 2026-10-11: which credential this Anthropic response is billed to, for the usage line
  // (oauth = the client's subscription bearer, api_key = an Anthropic key, router = a router-held
  // provider credential on the OpenCode Go lane, which overwrites this when it serves after a hop).
  res.credential = headers.authorization ? "oauth" : headers["x-api-key"] ? "api_key" : null;
  // M4 keep-warm: arm (or re-arm) the CEO session's prompt-cache ping with the exact bytes
  // and headers that are going upstream. keepWarmRole is set ONLY for a main-orchestrator
  // request on the primary Anthropic lane, and keepwarm re-checks on `finish` that the
  // request was actually served here (a fallback-served request has no Anthropic cache).
  if (keepWarmRole) {
    keepwarm.observe({
      sessionId: headers["x-claude-code-session-id"],
      role: keepWarmRole,
      res,
      body,
      // Gate fix 2026-10-11: keepwarm STORES this object and learns the session credential from it,
      // so it gets a copy — the retry below must never turn the warmed session's credential into the
      // router ANTHROPIC_API_KEY (and a ping must never be sent under the paid key).
      headers: { ...headers },
      path: req.url,
      method: req.method,
      // D5: the CLI's metadata.user_id names the account; keep-warm never lends a credential across accounts.
      account: keepwarm.accountOf(parsedBody),
      outcome: () => ({ served: !res.fallbackHop && !res.fallbackModel, status: res.statusCode }),
    });
  }
  const anthropicOnFail = (cause, detail) => {
    const status = detail?.status;
    const isPlanLimit = status === 429 || status === 402 || status === 403;
    if (isPlanLimit && keyRetryRole && headers.authorization && routerAnthropicKey && !req._anthropicApiKeyAttempted && !res.headersSent) {
      req._anthropicApiKeyAttempted = true;
      console.log(`[ANTHROPIC-KEY-FALLBACK] role=${role || "-"} OAuth status=${status} -> retrying with router ANTHROPIC_API_KEY`);
      // Gate fix 2026-10-11: the retry dials a NEW headers object. `headers` is the client's own
      // request (and the object handed to keepwarm.observe above): mutating it would drop the client
      // bearer from the warmed session and make every later ping carry the paid key. The body and its
      // content-length are unchanged, so the copy is byte-identical apart from the credential.
      const retryHeaders = { ...headers, "x-api-key": routerAnthropicKey };
      delete retryHeaders.authorization;
      res.credential = "api_key";
      // Model the router key had to serve: the statusline badge is suffixed from it (R4).
      res.keyServedModel = targetModel;
      // No onFail on the inner attempt (owner ruling 2026-10-11): the retry must not hop onward, so the
      // client receives THIS attempt's real status and body (a 429 stays a 429 with the upstream body).
      forward(req, res, body, { hostname: ANTHROPIC_HOST, port: 443, path: req.url, method: req.method, headers: retryHeaders, family: 4 }, 1, null);
      return;
    }
    if (onFail) return onFail(cause, detail);
    // Main and compaction carry no hop (fallback: null), so an upstream refusal has no successor: the
    // client gets the real status instead of waiting on a fallback that does not exist.
    replayUpstreamFailure(res, detail, cause);
  };
  forward(req, res, body, { hostname: ANTHROPIC_HOST, port: 443, path: req.url, method: req.method, headers, family: 4 }, 1, anthropicOnFail);
}

// Anthropic fallback for every OpenCode Go lane that reaches fallbackToAnthropic without an explicit
// target: Anthropic claude-haiku-5-5 (owner ruling 2026-10-10). Hop effort defaults to "max"
// (see fallbackToAnthropic). OPENCODE_GO_SIMULATE_STATUS=<code> is a test hook that makes handleOpenCodeGo
// behave as if OpenCode Go answered that status — the negative control for this path.
const OPENCODE_GO_FALLBACK_MODEL = process.env.OPENCODE_GO_FALLBACK_MODEL || HAIKU_MAX_FALLBACK_MODEL;

// H2 (2026-10-10): name every provider cause in the terminal 502 so an outage is diagnosable
// from the client error alone. Causes are our own short strings (model + status code), never
// upstream bodies, so the message is safe to replay to any client.
function composeBothProvidersError(causes) {
  const detail = Array.isArray(causes) && causes.length ? ` (${causes.join("; ")})` : "";
  return `both providers unavailable${detail}`;
}

// H1 (2026-10-10): an x-api-key-only client (voice-gateway, other S2S callers) carries a non-Anthropic
// key that Anthropic will always reject with 401 — the fallback hop is doomed before it starts.
// Viable only with an OAuth bearer or an sk-ant-* console key. (A router-held ANTHROPIC_API_KEY
// does NOT count: handleAnthropic forwards the CLIENT's headers, so a third-party key would leak to Anthropic.)
// ponytail: prefix sniff instead of full key validation; upgrade to a real probe if shapes converge.
// R4/R6 badge state for statusline.py. CLAUDE_ROUTER_FALLBACK_STATE overrides the path; under
// `node --test` (NODE_TEST_CONTEXT) the live file is never touched unless a test sets the override.
function fallbackStatePath() {
  if (process.env.CLAUDE_ROUTER_FALLBACK_STATE) return process.env.CLAUDE_ROUTER_FALLBACK_STATE;
  return process.env.NODE_TEST_CONTEXT ? null : "/run/claude-router/fallback-state.json";
}

function updateFallbackBadge(fallbackModel) {
  const file = fallbackStatePath();
  if (!file) return;
  try {
    if (fallbackModel) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ model: String(fallbackModel), at: new Date().toISOString(), role: "main-orchestrator" }), { flag: "wx", mode: 0o644 });
      fs.renameSync(tmp, file); // atomic; rename replaces a planted symlink instead of following it
    } else {
      // R6: a primary-served main turn clears the badge at once (no 15-min stale warning).
      fs.rmSync(file, { force: true });
    }
  } catch { /* badge is best-effort */ }
}

function anthropicHopViable(headers) {
  const k = headers && headers["x-api-key"];
  return Boolean(
    (headers && headers.authorization) ||
    (typeof k === "string" && k.startsWith("sk-ant"))
  );
}

function fallbackToAnthropic(req, res, rawBody, parsedBody, fromModel, role, cause, toModel, effort = null) {
  // One hop only: a request that already fell back Anthropic -> OpenCode Go must not bounce back.
  res.fallbackCauses = [...(res.fallbackCauses || []), `${fromModel}: ${cause}`];
  // Gate fix (2026-10-10 review-A BLOCKER): a client that already went away gets no hop. Its
  // `close` has fired, so a budget slot taken now would never be freed (and Opus would be billed
  // for an answer nobody reads).
  if (res.destroyed || res.writableEnded) {
    console.log(`[FALLBACK] role=${role || "-"} from=${fromModel} skipped: client_gone cause=${cause}`);
    return undefined;
  }
  if (res.fallbackHop) return safeError(res, 502, composeBothProvidersError(res.fallbackCauses));
  const target = toModel || OPENCODE_GO_FALLBACK_MODEL;
  // H1: skip the doomed Anthropic hop instead of replaying a confusing upstream 401.
  if (!OPENCODE_GO_MODEL_RE.test(target) && !anthropicHopViable(req.headers)) {
    res.fallbackCauses.push(`${target}: hop skipped — client credential not valid at Anthropic`);
    return safeError(res, 502, composeBothProvidersError(res.fallbackCauses));
  }
  // Owner ruling 2026-10-10: a Haiku hop with no explicit effort runs at max. Any other Anthropic
  // target keeps the caller's effort (null = model default); a deepseek-* target is OpenCode Go, where
  // handleOpenCodeGo always sends effort max (logged as max).
  const hopEffort = OPENCODE_GO_MODEL_RE.test(target) ? "max" : (effort || (/haiku/i.test(target) ? HAIKU_MAX_FALLBACK_EFFORT : null));
  const hop = () => {
    res.fallbackHop = 1;
    console.log(`[FALLBACK] role=${role || "-"} from=${fromModel} to=${target} effort=${hopEffort || "default"} cause=${cause}`);
    res.fallbackModel = target;
    res.usageUpstream = OPENCODE_GO_MODEL_RE.test(target) ? "OPENCODE_GO" : "ANTHROPIC"; // WO-6: who actually served
    // A deepseek-* fallback target is served by OpenCode Go; the hop flag above keeps it one hop.
    if (OPENCODE_GO_MODEL_RE.test(target)) return handleOpenCodeGo(req, res, rawBody, parsedBody, target, role);
    const body = parsedBody ? { ...parsedBody, model: target } : parsedBody;
    return handleAnthropic(req, res, rawBody, body, target, { forceModel: true, effort: hopEffort, role });
  };
  // WO-N1 (M-002): only a subagent/background OpenCode Go -> Anthropic hop spends the fallback budget;
  // the main-orchestrator lane is never budgeted or queued.
  if (OPENCODE_GO_MODEL_RE.test(target) || role === "main-orchestrator") return hop();
  return fallbackBudgetGate({
    res,
    role,
    cause,
    hop,
    retryOgo: () => handleOpenCodeGo(req, res, rawBody, parsedBody, fromModel, role, toModel, effort),
  });
}

// OpenCode Go circuit breaker (2026-09-22 21:10). Without it, a saturated OpenCode Go account turns the cost
// split into pure loss: every call pays a full round-trip, collects a 429, and then runs on
// Anthropic anyway. After OPENCODE_GO_BREAKER_FAILS consecutive refusals the breaker opens and requests
// go straight to Anthropic for OPENCODE_GO_BREAKER_COOLDOWN_MS; the first request after that window is a
// probe, and one success closes it. Cheap when OpenCode Go is healthy, free when it is not.
const OPENCODE_GO_BREAKER_FAILS = Number(process.env.OPENCODE_GO_BREAKER_FAILS || 3);
const OPENCODE_GO_BREAKER_COOLDOWN_MS = Number(process.env.OPENCODE_GO_BREAKER_COOLDOWN_MS || 300000);
// lastFailure: the OpenCode Go error that last fed the breaker (status/headers/body), so a request
// short-circuited by an open breaker can still be answered with the original OpenCode Go error.
const ogoBreaker = { consecutiveFailures: 0, openUntil: 0, lastFailure: null };

// R3 (2026-10-10): transient-vs-terminal OpenCode Go 429 discrimination. Under a parallel dispatch
// wave the funded account still answers 429 on RPM/concurrency peaks; those clear in seconds,
// so the OpenCode Go hop retries them with the standard backoff before falling back. A drained/plan-
// exhausted account (code 1113 "Insufficient balance or no resource package", 1305 quota) is
// terminal for hours: retrying only delays the hop and the breaker, so it skips straight to
// fallback exactly as before. OPENCODE_GO_429_MAX_ATTEMPTS=1 restores the old immediate-hop behaviour.
const OPENCODE_GO_429_MAX_ATTEMPTS = Number(process.env.OPENCODE_GO_429_MAX_ATTEMPTS || 3);
// OpenCode Go (checked 2026-10-11, opencode.ai/docs/go + anomalyco/opencode retry.ts): GoUsageLimitError /
// FreeUsageLimitError ("Weekly usage limit reached. Resets in ...") are the account's 5-hour/weekly/monthly
// windows and an upstream "insufficient balance" is the pooled provider account — TERMINAL (hop at once).
// A plain upstream "Too many requests" is TRANSIENT (retry with backoff).
const OPENCODE_GO_429_TERMINAL_RE = /GoUsageLimitError|FreeUsageLimitError|usage limit reached|insufficient balance|limit exhausted/i;
function isTerminalOgo429(text) {
  return OPENCODE_GO_429_TERMINAL_RE.test(String(text || ""));
}
// Any OTHER 4xx but 401 also hops (forward's fallback4xx): MissingSessionID, the "requires Global regions"
// workspace setting, an unsupported model or content shape are lane policy, not a malformed request, and
// must not kill the subagent. 401 (a bad key) fails loudly instead of moving every lane onto Anthropic.
const OPENCODE_GO_429_RETRY = {
  maxAttempts: OPENCODE_GO_429_MAX_ATTEMPTS,
  shouldRetry: (text) => !isTerminalOgo429(text),
  fallback4xx: (status) => status !== 401,
};

function ogoBreakerRecord(ok) {
  if (ok) {
    if (ogoBreaker.openUntil || ogoBreaker.consecutiveFailures) {
      console.log("[BREAKER] opencode-go closed — probe succeeded");
    }
    ogoBreaker.consecutiveFailures = 0;
    ogoBreaker.openUntil = 0;
    ogoBreaker.lastFailure = null;
    // WO-N1: OpenCode Go is serving again, so requests waiting for an Anthropic fallback slot go back to OpenCode Go.
    fallbackBudgetDrainToOgo();
    return;
  }
  ogoBreaker.consecutiveFailures += 1;
  if (ogoBreaker.consecutiveFailures >= OPENCODE_GO_BREAKER_FAILS && Date.now() >= ogoBreaker.openUntil) {
    ogoBreaker.openUntil = Date.now() + OPENCODE_GO_BREAKER_COOLDOWN_MS;
    console.log(`[BREAKER] opencode-go OPEN for ${Math.round(OPENCODE_GO_BREAKER_COOLDOWN_MS / 1000)}s after ${ogoBreaker.consecutiveFailures} consecutive failures — routing straight to Anthropic`);
  }
}

// R5 (2026-10-10, wave-kill part 2): OpenCode Go egress concurrency cap. A parallel dispatch wave
// (6+ agents + the main lane) exceeds the account's concurrent-request ceiling; every over-
// limit request 429s, hops to a closed Anthropic window, and dies — retries then multiply the
// load (measured 02:03-02:04: sustained RETRY-429 storms, 502s on the main lane itself).
// Bound the in-flight OpenCode Go requests instead: excess requests queue FIFO (slot held for the
// whole streamed response, released on res close, incl. fallback hops) and time out into the
// normal fallback path. OPENCODE_GO_MAX_CONCURRENT=0 disables the cap.
const OPENCODE_GO_MAX_CONCURRENT = Number(process.env.OPENCODE_GO_MAX_CONCURRENT || 4);
const OPENCODE_GO_QUEUE_TIMEOUT_MS = Number(process.env.OPENCODE_GO_QUEUE_TIMEOUT_MS || 60000);
const ogoEgress = { active: 0, queue: [] };

// Returns a ticket: ticket.granted is true only while the caller HOLDS a slot. Only a granted
// ticket may call ogoEgressRelease(); a queued one is withdrawn with ogoEgressCancel() (client
// gone) or by the timeout (fn(err), never granted) — neither touches the active count.
// priority=true (the main lane) queues at the head so the CEO never waits behind a subagent wave.
function ogoEgressAcquire(fn, timeoutMs = OPENCODE_GO_QUEUE_TIMEOUT_MS, priority = false) {
  const job = { fn, granted: false, timer: null };
  if (!OPENCODE_GO_MAX_CONCURRENT || ogoEgress.active < OPENCODE_GO_MAX_CONCURRENT) {
    ogoEgress.active += 1;
    job.granted = true;
    fn();
    return job;
  }
  job.timer = setTimeout(() => {
    const i = ogoEgress.queue.indexOf(job);
    if (i === -1) return;
    ogoEgress.queue.splice(i, 1);
    console.log(`[OGO-QUEUE] timeout after ${timeoutMs}ms (depth ${ogoEgress.queue.length})`);
    runQueued(job, new Error("opencode_go_egress_queue_timeout"));
  }, timeoutMs);
  if (priority) ogoEgress.queue.unshift(job);
  else ogoEgress.queue.push(job);
  return job;
}

// A queued job runs from a timer or a close listener: a synchronous throw there would crash
// the router (only unhandledRejection is trapped), so contain it and free a granted slot.
function runQueued(job, err) {
  try { job.fn(err); } catch (e) {
    console.log(`[OGO-QUEUE] queued job threw: ${e && e.message}`);
    if (job.granted) ogoEgressRelease();
  }
}

function ogoEgressCancel(job) {
  const i = ogoEgress.queue.indexOf(job);
  if (i !== -1) ogoEgress.queue.splice(i, 1);
  clearTimeout(job.timer);
}

function ogoEgressRelease() {
  const job = ogoEgress.queue.shift();
  if (job) {
    clearTimeout(job.timer);
    job.granted = true;
    runQueued(job); // the slot transfers directly to the dequeued job
    return;
  }
  ogoEgress.active = Math.max(0, ogoEgress.active - 1);
}

// WO-N1 / M-002 (owner ruling 2026-10-10): Anthropic fallback budget for the OpenCode Go lanes. One drained
// OpenCode Go window must not drain the Anthropic window the main session needs, so at most
// FALLBACK_MAX_CONCURRENT (default 2; 0 = no subagent fallback) subagent/background requests ride the
// OpenCode Go -> Anthropic hop at once. Further ones wait FIFO until a fallback slot frees (then they hop) or
// OpenCode Go serves a request again, i.e. the breaker closes (then they go back to OpenCode Go). After
// FALLBACK_QUEUE_MAX_WAIT_MS (default 10 min, counted from the first queueing) a waiting request is
// answered with its original OpenCode Go error, never dropped. A granted slot covers the whole Anthropic
// stream and is freed on res close. The main-orchestrator lane never enters this gate.
const FALLBACK_MAX_CONCURRENT_DEFAULT = 2;
const FALLBACK_QUEUE_MAX_WAIT_MS_DEFAULT = 10 * 60 * 1000;
const fallbackBudget = { active: 0, queue: [] };

// Read per call (cheap): tests vary the knobs without reloading the module.
function fallbackBudgetConfig() {
  const rawCap = String(process.env.FALLBACK_MAX_CONCURRENT ?? "").trim();
  const cap = Number(rawCap);
  const wait = Number(process.env.FALLBACK_QUEUE_MAX_WAIT_MS);
  return {
    maxConcurrent: rawCap !== "" && Number.isInteger(cap) && cap >= 0 ? cap : FALLBACK_MAX_CONCURRENT_DEFAULT,
    maxWaitMs: Number.isFinite(wait) && wait > 0 ? wait : FALLBACK_QUEUE_MAX_WAIT_MS_DEFAULT,
  };
}

function fallbackBudgetLog(event, job, extra = "") {
  const { maxConcurrent } = fallbackBudgetConfig();
  console.log(`[FALLBACK-BUDGET] ${event} role=${job.role || "-"} waited_ms=${Date.now() - job.queuedAt} `
    + `active=${fallbackBudget.active}/${maxConcurrent} queued=${fallbackBudget.queue.length}${extra ? ` ${extra}` : ""}`);
}

// The replayed OpenCode Go error keeps only the headers that describe its bytes; Node recomputes framing.
function ogoErrorHeaders(h) {
  const out = { "content-type": (h && h["content-type"]) || "application/json" };
  if (h && h["content-encoding"]) out["content-encoding"] = h["content-encoding"];
  if (h && h["retry-after"]) out["retry-after"] = h["retry-after"];
  return out;
}

function opencodeGoErrorFrom(cause, detail) {
  const parsed = Number((/status=(\d{3})/.exec(String(cause || "")) || [])[1]) || 0;
  const status = Number(detail && detail.status) || parsed;
  const body = detail && Buffer.isBuffer(detail.body) && detail.body.length ? detail.body : null;
  return { status, cause: String(cause || ""), headers: ogoErrorHeaders(detail && detail.headers), body };
}

// Expiry answer: the original OpenCode Go response when its bytes were captured, else a proxy error
// carrying the original status and our own cause strings (never an upstream body).
function respondOgoError(res, waitedMs) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const err = res.ogoError;
  if (err && err.status && err.body) {
    res.writeHead(err.status, err.headers);
    res.end(err.body);
    return;
  }
  const causes = (res.fallbackCauses || []).join("; ") || "unknown";
  safeError(res, (err && err.status) || 502, `OpenCode Go unavailable (${causes}); Anthropic fallback budget wait expired after ${waitedMs}ms`);
}

// A job runs from a timer or a listener: a synchronous throw must not crash the router.
function fallbackBudgetRun(job, fn, what) {
  try { fn(); } catch (e) {
    console.log(`[FALLBACK-BUDGET] ${what} threw: ${e && e.message ? String(e.message).slice(0, 200) : "error"}`);
    if (job.state === "slot") fallbackBudgetFree(job);
    safeError(job.res, 502);
  }
}

function fallbackBudgetGrantSlot(job) {
  fallbackBudget.active += 1;
  job.state = "slot";
  fallbackBudgetLog("granted", job, "via=anthropic");
  fallbackBudgetRun(job, job.hop, "hop");
}

function fallbackBudgetFree(job) {
  if (job.released) return;
  job.released = true;
  fallbackBudget.active = Math.max(0, fallbackBudget.active - 1);
  fallbackBudgetPump();
}

// Hands free slots to the queue head, oldest first.
function fallbackBudgetPump() {
  const { maxConcurrent } = fallbackBudgetConfig();
  while (fallbackBudget.queue.length && fallbackBudget.active < maxConcurrent) {
    const job = fallbackBudget.queue.shift();
    clearTimeout(job.timer);
    if (job.res.destroyed || job.res.writableEnded) {
      job.state = "withdrawn";
      fallbackBudgetLog("withdrawn", job, "reason=client_gone");
      continue;
    }
    fallbackBudgetGrantSlot(job);
  }
}

function fallbackBudgetExpire(job) {
  clearTimeout(job.timer);
  job.state = "expired";
  const err = job.res.ogoError;
  fallbackBudgetLog("expired", job, `status=${(err && err.status) || 502}`);
  respondOgoError(job.res, Date.now() - job.queuedAt);
}

function fallbackBudgetClosed(job) {
  if (job.state === "queued") {
    const i = fallbackBudget.queue.indexOf(job);
    if (i !== -1) fallbackBudget.queue.splice(i, 1);
    clearTimeout(job.timer);
    job.state = "withdrawn";
    fallbackBudgetLog("withdrawn", job, "reason=client_gone");
  } else if (job.state === "slot") {
    fallbackBudgetFree(job);
  }
}

function fallbackBudgetGate({ res, role, cause, hop, retryOgo }) {
  const { maxConcurrent, maxWaitMs } = fallbackBudgetConfig();
  const now = Date.now();
  const job = { res, role, cause, hop, retryOgo, queuedAt: res.fallbackQueuedAt || now, state: "new", released: false, timer: null };
  if (res.destroyed || res.writableEnded) { // close already fired: never take a slot or a queue place
    job.state = "withdrawn";
    fallbackBudgetLog("withdrawn", job, "reason=client_gone");
    return undefined;
  }
  // One close listener per response (a drain -> OpenCode Go retry -> re-queue cycle reuses it).
  res.fallbackJob = job;
  if (!res.fallbackCloseHooked) {
    res.fallbackCloseHooked = true;
    res.once("close", () => fallbackBudgetClosed(res.fallbackJob));
  }
  if (!fallbackBudget.queue.length && fallbackBudget.active < maxConcurrent) return fallbackBudgetGrantSlot(job);
  // The wait is counted from the FIRST queueing: a request re-queued after a failed OpenCode Go retry
  // keeps both its deadline and its FIFO place.
  res.fallbackQueuedAt = job.queuedAt;
  const remaining = job.queuedAt + maxWaitMs - now;
  if (remaining <= 0) return fallbackBudgetExpire(job);
  job.state = "queued";
  let at = fallbackBudget.queue.length;
  while (at > 0 && fallbackBudget.queue[at - 1].queuedAt > job.queuedAt) at -= 1;
  fallbackBudget.queue.splice(at, 0, job);
  job.timer = setTimeout(() => {
    const i = fallbackBudget.queue.indexOf(job);
    if (i === -1) return;
    fallbackBudget.queue.splice(i, 1);
    fallbackBudgetExpire(job);
  }, remaining);
  if (typeof job.timer.unref === "function") job.timer.unref();
  fallbackBudgetLog("queued", job, `cause=${String(cause || "-").replace(/\s+/g, "_")} max_wait_ms=${maxWaitMs}`);
  fallbackBudgetPump();
  fallbackBudgetArmReprobe();
  return undefined;
}

// D5 (Review-A minor): queued jobs re-probe OpenCode Go on their own. Before this timer a queue only moved
// when an Anthropic slot freed or a NEW request happened to reach OpenCode Go after the breaker cooldown;
// with no fresh traffic every job sat out FALLBACK_QUEUE_MAX_WAIT_MS although OpenCode Go was back. The
// timer fires when the breaker cooldown ends (openUntil) — or one OPENCODE_GO_BREAKER_COOLDOWN_MS after
// arming while the breaker is closed (the jobs just failed on OpenCode Go) — and sends ONLY the oldest live
// job back to OpenCode Go as the probe. Success closes the breaker and drains the rest (ogoBreakerRecord);
// failure re-queues it at its FIFO place with its first-queueing deadline, and the timer re-arms.
let fallbackReprobeTimer = null;
const REPROBE_MIN_DELAY_MS = 100;

function fallbackBudgetDisarmReprobe() {
  if (fallbackReprobeTimer) clearTimeout(fallbackReprobeTimer);
  fallbackReprobeTimer = null;
}

function fallbackBudgetArmReprobe() {
  if (fallbackReprobeTimer || !fallbackBudget.queue.length) return;
  const now = Date.now();
  const at = ogoBreaker.openUntil > now ? ogoBreaker.openUntil : now + OPENCODE_GO_BREAKER_COOLDOWN_MS;
  // Floor the delay: a zero/negative/NaN cooldown must not turn the re-probe into a tight retry loop.
  const delay = at - now;
  fallbackReprobeTimer = setTimeout(fallbackBudgetReprobe, Number.isFinite(delay) ? Math.max(REPROBE_MIN_DELAY_MS, delay) : 1000);
  if (typeof fallbackReprobeTimer.unref === "function") fallbackReprobeTimer.unref();
}

function fallbackBudgetReprobe() {
  fallbackReprobeTimer = null;
  if (!fallbackBudget.queue.length) return;
  if (Date.now() < ogoBreaker.openUntil) return fallbackBudgetArmReprobe(); // breaker re-opened meanwhile
  while (fallbackBudget.queue.length) {
    const job = fallbackBudget.queue.shift();
    clearTimeout(job.timer);
    if (job.res.destroyed || job.res.writableEnded) {
      job.state = "withdrawn";
      fallbackBudgetLog("withdrawn", job, "reason=client_gone");
      continue;
    }
    job.state = "ogo";
    fallbackBudgetLog("granted", job, "via=ogo reprobe=1");
    fallbackBudgetRun(job, job.retryOgo, "ogo reprobe");
    break;
  }
  fallbackBudgetArmReprobe(); // whatever still waits keeps a probe scheduled
}

// Breaker closed (OpenCode Go served a request): every waiting request goes back to OpenCode Go, oldest first.
function fallbackBudgetDrainToOgo() {
  if (!fallbackBudget.queue.length) return;
  fallbackBudgetDisarmReprobe();
  const jobs = fallbackBudget.queue.splice(0);
  for (const job of jobs) {
    clearTimeout(job.timer);
    if (job.res.destroyed || job.res.writableEnded) {
      job.state = "withdrawn";
      fallbackBudgetLog("withdrawn", job, "reason=client_gone");
      continue;
    }
    job.state = "ogo";
    fallbackBudgetLog("granted", job, "via=ogo");
    fallbackBudgetRun(job, job.retryOgo, "ogo retry");
  }
}

// One stable OpenCode Go session id per conversation: the CLI session id, suffixed with the agent id for a
// subagent (each subagent is its own conversation and prompt cache); else a hash of the conversation head.
function opencodeGoSessionId(req, parsedBody) {
  const h = req.headers || {};
  const sessionId = String(h["x-claude-code-session-id"] || "").trim();
  const agentId = String(h["x-claude-code-agent-id"] || "").trim();
  if (sessionId) return agentId ? `${sessionId}:${agentId}` : sessionId;
  const first = Array.isArray(parsedBody?.messages) ? parsedBody.messages[0] : null;
  const seed = `${agentId}|${systemTextOf(parsedBody).slice(0, 2000)}|${JSON.stringify(first?.content || "").slice(0, 4000)}`;
  return "claude-router-" + require("crypto").createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function handleOpenCodeGo(req, res, rawBody, parsedBody, model, role = "", anthropicFallbackModel, anthropicFallbackEffort = null) {
  let releaseOgoSlot = () => {}; // bound below once a slot is requested
  const onFail = (cause, detail) => {
    ogoBreakerRecord(false);
    // WO-N1: keep the original OpenCode Go error so a budget-queue expiry can answer with it.
    res.ogoError = opencodeGoErrorFrom(cause, detail);
    ogoBreaker.lastFailure = res.ogoError;
    releaseOgoSlot(); // the Anthropic leg must not pin a OpenCode Go slot for its whole stream
    return fallbackToAnthropic(req, res, rawBody, parsedBody, model || DEEPSEEK_FLASH_MODEL, role, cause, anthropicFallbackModel, anthropicFallbackEffort);
  };
  const simulated = Number(process.env.OPENCODE_GO_SIMULATE_STATUS || 0);
  if (simulated) return onFail(`simulated status=${simulated}`, { status: simulated });

  // Breaker open: skip the doomed round-trip entirely. Not counted as a new failure.
  if (Date.now() < ogoBreaker.openUntil) {
    if (!res.ogoError && ogoBreaker.lastFailure) res.ogoError = ogoBreaker.lastFailure;
    return fallbackToAnthropic(req, res, rawBody, parsedBody, model || DEEPSEEK_FLASH_MODEL, role, "breaker_open", anthropicFallbackModel, anthropicFallbackEffort);
  }

  const key = process.env.OPENCODE_GO_API_KEY;
  if (!key) return onFail("opencode_go_not_configured");

  let outboundBody = parsedBody ? { ...parsedBody } : {};
  if (Array.isArray(outboundBody.tools) && outboundBody.tools.length === 0) {
    delete outboundBody.tools;
    delete outboundBody.tool_choice;
  }
  outboundBody.model = model || DEEPSEEK_FLASH_MODEL;

  // Summaries are background jobs (owner ruling 2026-10-10): same English directive and token floor.
  const isCompactionOrBg = role === "compaction" || role === "background" || role === "bg" || role === "summary";

  // Max effort on every OpenCode Go lane (owner 2026-10-11): adaptive thinking + output_config.effort "max"
  // (measured 200 on /zen/go/v1/messages with tools, 2026-10-07). Output ceiling: background 64k, else 128k.
  outboundBody.thinking = { type: "adaptive" };
  outboundBody.output_config = { ...(outboundBody.output_config || {}), effort: "max" };
  const tokenFloor = isCompactionOrBg ? 65536 : 131072;
  outboundBody.max_tokens = Math.min(131072, Math.max(outboundBody.max_tokens || 0, tokenFloor));

  // Strict English language invariant across all thinking and outputs (zero Chinese)
  let englishInvariant = "\n\nCRITICAL LANGUAGE INVARIANT: You MUST think, reason, and output EXCLUSIVELY in English. Under NO circumstances should Chinese or any other language be used in your thinking process (<thinking>) or in your final response. All reasoning, internal thoughts, code comments, and outputs must be 100% fluent English.";
  if (isCompactionOrBg) {
    englishInvariant += "\n\nCRITICAL BACKGROUND & TITLE DIRECTIVE: All generated session titles, conversation summaries, compacted context, notes, and task outputs MUST be written 100% in English only. Under NO circumstances output Chinese characters or words.";
  } else {
    englishInvariant += "\n\nDECISIVE THINKING DIRECTIVE: Think decisively and concisely. Focus your internal reasoning strictly on architectural correctness, logic invariants, and edge cases. Do not generate repetitive stream-of-consciousness monologues for routine file views, simple tool outputs, or mechanical steps.";
  }

  if (typeof outboundBody.system === "string") {
    outboundBody.system = outboundBody.system + englishInvariant;
  } else if (Array.isArray(outboundBody.system)) {
    outboundBody.system = [...outboundBody.system, { type: "text", text: englishInvariant.trim() }];
  } else {
    outboundBody.system = englishInvariant.trim();
  }

  // Suffix user message reminder for compaction/background jobs to anchor the model in English
  if (isCompactionOrBg && Array.isArray(outboundBody.messages) && outboundBody.messages.length > 0) {
    // Copy before replacing the last turn: the array is shared with parsedBody, and a request the
    // fallback budget sends back to OpenCode Go re-enters here (the reminder must not stack).
    outboundBody.messages = outboundBody.messages.slice();
    const lastIdx = outboundBody.messages.length - 1;
    const lastMsg = outboundBody.messages[lastIdx];
    if (lastMsg && lastMsg.role === "user") {
      const reminder = "\n\n[CRITICAL REQUIREMENT: Output and thinking must be 100% English only. Zero Chinese characters.]";
      if (typeof lastMsg.content === "string") {
        outboundBody.messages[lastIdx] = { ...lastMsg, content: lastMsg.content + reminder };
      } else if (Array.isArray(lastMsg.content)) {
        outboundBody.messages[lastIdx] = { ...lastMsg, content: [...lastMsg.content, { type: "text", text: reminder.trim() }] };
      }
    }
  }

  const body = Buffer.from(JSON.stringify(outboundBody), "utf8");
  const rawUa = req.headers["user-agent"] || "";
  const safeUserAgent = (!rawUa || /^python-urllib/i.test(rawUa) || rawUa === "claude-router/1.0") ? "claude-code/0.2.29" : rawUa;
  const headers = {
    host: OPENCODE_GO_HOST,
    "content-type": "application/json",
    accept: req.headers.accept || "application/json",
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
    "user-agent": safeUserAgent,
    "x-opencode-session": opencodeGoSessionId(req, parsedBody),
    "x-api-key": key,
    authorization: `Bearer ${key}`,
    "content-length": body.length,
  };
  if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = req.headers["anthropic-beta"];
  // Owner ruling 2026-10-11: this lane is served with the router-held OpenCode Go credential, which
  // also overwrites the credential an earlier Anthropic hop recorded on the same response.
  res.credential = "router";

  // R5: bounded OpenCode Go egress. A GRANTED slot covers the whole streamed response and is released
  // exactly once on connection close (success, error, or fallback hop — close covers all).
  // A request still queued when the client goes away is withdrawn, never released.
  if (res.destroyed || res.writableEnded) return; // client already gone: never take a slot
  let ogoTicket = null;
  let ogoDone = false;
  // D5 (Review-A minor): a fallback-budget drain -> OpenCode Go retry -> re-queue cycle re-enters handleOpenCodeGo
  // with the SAME res, so every listener added here must be removed once it has done its job, or
  // each cycle leaks one (MaxListenersExceededWarning after 10 cycles, closures pinning the body).
  const release = () => {
    if (ogoDone || !ogoTicket) return;
    ogoDone = true;
    res.removeListener("close", release);
    if (ogoTicket.granted) ogoEgressRelease();
    else ogoEgressCancel(ogoTicket);
  };
  releaseOgoSlot = release;
  res.on("close", release);
  ogoTicket = ogoEgressAcquire((queueErr) => {
    if (queueErr) {
      ogoDone = true; // never held a slot
      res.removeListener("close", release);
      // Local congestion, not a OpenCode Go failure: hop without feeding the OpenCode Go breaker.
      return fallbackToAnthropic(req, res, rawBody, parsedBody, model || DEEPSEEK_FLASH_MODEL, role, "opencode_go_egress_queue_timeout", anthropicFallbackModel, anthropicFallbackEffort);
    }
    forward(req, res, body, {
      hostname: OPENCODE_GO_HOST,
      port: 443,
      path: OPENCODE_GO_PATH,
      method: req.method,
      headers,
      family: 4,
    }, 1, onFail, OPENCODE_GO_429_RETRY);
  }, OPENCODE_GO_QUEUE_TIMEOUT_MS, role === "main-orchestrator");
  // One breaker-success listener per response, however often a retry re-enters handleOpenCodeGo.
  if (!res.ogoFinishHooked) {
    res.ogoFinishHooked = true;
    res.once("finish", () => {
      if (!res.fallbackModel && res.statusCode === 200) ogoBreakerRecord(true);
    });
  }
}

// ---------------------------------------------------------------------------
// WO-6 cost visibility: one usage line per served response in router-usage.jsonl.
// The scanner observes the SAME res.write/res.end wrap I9 uses for out_bytes, so it
// sees every serving path (proxied pipes, buffered 4xx replays, fallback hops)
// without touching forward(), any handler, cache_control handling or fallback
// logic. Chunks are only READ — response bytes reaching the client are identical.
// Fail-open by construction: every parse/write error is swallowed and the line is
// simply omitted; nothing here may block or alter a response.
const USAGE_LOG_DEFAULT = path.join(
  process.env.AI_SETUP_ROOT || path.resolve(__dirname, ".."),
  "state",
  "router-usage.jsonl",
);

// WO-7 REQ4: `upstream` must come from a fixed vocabulary so downstream
// aggregation never meets free-form model/provider strings. Only OpenCode Go and
// Anthropic remain (owner 2026-10-11); any other upstream logs as "OTHER".
const UPSTREAM_VOCAB = {
  OPENCODE_GO: "OPENCODE_GO",
  ANTHROPIC: "ANTHROPIC",
};

function normaliseUpstream(value) {
  const key = String(value ?? "").trim().toUpperCase();
  return UPSTREAM_VOCAB[key] ?? "OTHER";
}

// One-shot per process: enforce 0600 on a pre-existing log file (appendFile's
// mode option only applies at creation). Best-effort, errors swallowed.
let usageLogModeEnsured = false;

function __resetUsageModeCheck() { usageLogModeEnsured = false; }

function appendUsageLine(record) {
  try {
    const dest = process.env.ROUTER_USAGE_LOG || USAGE_LOG_DEFAULT;
    if (!usageLogModeEnsured) {
      usageLogModeEnsured = true;
      try { if (fs.existsSync(dest)) fs.chmodSync(dest, 0o600); } catch { /* best effort */ }
    }
    // Async append: never blocks the response thread; errors ignored on purpose.
    // mode 0600 applies when the file is first created.
    fs.appendFile(dest, JSON.stringify(record) + "\n", { mode: 0o600 }, () => {});
  } catch { /* bookkeeping must never break serving */ }
}

// Extracts usage numbers from a response body as it streams past. Handles the
// Anthropic wire format (SSE message_start / message_delta, non-streaming `usage`)
// and OpenAI-style shapes (usage.prompt_tokens / completion_tokens /
// prompt_tokens_details.cached_tokens, SSE final-chunk usage). Numbers are merged
// with max() because output_tokens in message_delta is cumulative.
// WO-6 fix 2026-10-11: a content-encoded response (the client's `accept-encoding: gzip, br` is
// forwarded verbatim to Anthropic, unlike the OpenCode Go lane which builds its own allowlist)
// arrives as opaque bytes. They are copied into a bounded side buffer and decoded ONCE on finish;
// the client's own bytes are still handed to origWrite/origEnd untouched.
const USAGE_ENCODED_TYPES = new Set(["gzip", "x-gzip", "br", "deflate", "zstd"]);
// Caps are fields (not bare constants) so a test can shrink them instead of allocating megabytes.
const USAGE_LIMITS = {
  encodedMaxBytes: 4 << 20, // compressed copy of one response
  decodeMaxBytes: 8 << 20, // inflated copy of one response (MemoryMax is 512M)
};

function createUsageScanner(res) {
  const st = {
    mode: null, tail: "", json: [], jsonBytes: 0, overflow: false,
    encoded: null, encChunks: [], encBytes: 0, encOverflow: false,
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, seen: false,
  };
  const note = (u) => {
    if (!u || typeof u !== "object") return;
    const num = (v) => (typeof v === "number" && v >= 0 ? v : null);
    const ptd = u.prompt_tokens_details;
    const vals = [
      ["input", num(u.input_tokens) !== null ? u.input_tokens : num(u.prompt_tokens)],
      ["output", num(u.output_tokens) !== null ? u.output_tokens : num(u.completion_tokens)],
      ["cacheRead", num(u.cache_read_input_tokens) !== null ? u.cache_read_input_tokens
        : ptd && num(ptd.cached_tokens) !== null ? ptd.cached_tokens : null],
      ["cacheCreation", num(u.cache_creation_input_tokens)],
    ];
    for (const [k, v] of vals) if (v !== null && v > st[k]) { st[k] = v; st.seen = true; }
  };
  const sseLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let ev;
    try { ev = JSON.parse(payload); } catch { return; }
    if (ev.type === "message_start") note(ev.message && ev.message.usage);
    else if (ev.type === "message_delta") note(ev.usage);
    else if (ev.type === "response.completed") note(ev.response && ev.response.usage);
    else note(ev.usage); // OpenAI chat-completions final SSE chunk carries usage directly
  };
  // Shared by both entries (plaintext as it streams, decoded copy at finish).
  const ingest = (text) => {
    if (st.mode === "sse") {
      st.tail += text;
      if (st.tail.length > 262144) st.tail = st.tail.slice(-262144); // bounded memory
      let nl;
      while ((nl = st.tail.indexOf("\n")) !== -1) {
        const line = st.tail.slice(0, nl);
        st.tail = st.tail.slice(nl + 1);
        sseLine(line.trimEnd());
      }
      return;
    }
    st.jsonBytes += text.length;
    if (st.jsonBytes <= 1572864) st.json.push(text);
    else st.overflow = true; // oversized JSON: give up rather than buffer unbounded
  };
  const toBuffer = (chunk, encoding) => (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
    ? Buffer.from(chunk) : Buffer.from(chunk, typeof encoding === "string" && encoding !== "utf8" ? encoding : undefined));
  return {
    feed(chunk, encoding) {
      try {
        if (chunk === null || chunk === undefined) return;
        if (st.mode === null) {
          // writeHead(status, headers) args are NOT visible to getHeader until flush
          // (Node applies them at storeHeader time), so the writeHead wrap below copies
          // the content-type onto res.__usageCt; setHeader-based paths stay readable.
          const read = (name, slot) => String(res[slot] || (res.getHeader && res.getHeader(name)) || "").toLowerCase();
          const ct = read("content-type", "__usageCt");
          if (ct.includes("text/event-stream")) st.mode = "sse";
          else if (ct.includes("application/json")) st.mode = "json";
          else st.mode = "off"; // content-type never arrives late; first write is post-writeHead
          const ce = read("content-encoding", "__usageCe");
          // Only an encoding we can actually inflate is worth a copy; zstd needs a runtime that has it.
          if (st.mode !== "off" && USAGE_ENCODED_TYPES.has(ce)
            && (ce !== "zstd" || typeof require("zlib").zstdDecompressSync === "function")) st.encoded = ce;
        }
        if (st.mode === "off") return;
        if (st.encoded) {
          if (st.encOverflow) return;
          const buf = toBuffer(chunk, encoding);
          st.encBytes += buf.length;
          if (st.encBytes > USAGE_LIMITS.encodedMaxBytes) { st.encOverflow = true; st.encChunks = []; return; }
          st.encChunks.push(buf);
          return;
        }
        ingest(typeof chunk === "string" ? chunk : toBuffer(chunk, encoding).toString("utf8"));
      } catch { /* scanner must never throw into the response path */ }
    },
    finish() {
      try {
        // Decode the side copy of an encoded body before looking for usage. decodeProxyBody caps
        // the inflation and swallows its own errors, so an undecodable stream simply yields no line.
        if (st.encoded && !st.encOverflow && st.encChunks.length) {
          ingest(decodeProxyBody(Buffer.concat(st.encChunks), { "content-encoding": st.encoded }, USAGE_LIMITS.decodeMaxBytes));
        }
        st.encChunks = []; // the copy is of no further use
        if (!st.seen && st.mode === "json" && !st.overflow) {
          let parsed;
          try { parsed = JSON.parse(st.json.join("")); } catch { parsed = null; }
          if (parsed) note(parsed.usage);
        }
      } catch { /* ignore */ }
      return st.seen ? st : null;
    },
  };
}

function routerRequestHandler(req, res) {

  if (req.method === "HEAD" || req.url === "/api/hello" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }
  // I9 (G1): count the response bytes streamed to the client so the [DONE] line can carry
  // out_bytes. Wrapping write/end sees every path — proxied pipes, buffered 4xx bodies and
  // locally generated errors alike — without touching any handler.
  let outBytes = 0;
  const addOutBytes = (chunk, encoding) => {
    if (typeof chunk === "string") outBytes += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8");
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) outBytes += chunk.length;
  };
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  // WO-6: the same wrap also feeds the usage scanner (read-only observation; the
  // bytes passed through to origWrite/origEnd are untouched).
  const usageScan = createUsageScanner(res);
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (...args) => {
    try {
      for (const a of args) {
        if (a && typeof a === "object") {
          const ct = a["content-type"] || a["Content-Type"];
          if (ct && !res.__usageCt) res.__usageCt = String(ct);
          // WO-6 fix 2026-10-11: the Anthropic leg relays the client's accept-encoding, so the
          // reply can be content-encoded. The scanner needs that label to treat the bytes it
          // observes as opaque and decode a bounded side copy instead of scanning them as text.
          const ce = a["content-encoding"] || a["Content-Encoding"];
          if (ce && !res.__usageCe) res.__usageCe = String(ce);
        }
      }
    } catch { /* observation only */ }
    return origWriteHead(...args);
  };
  res.write = (...args) => { addOutBytes(args[0], args[1]); usageScan.feed(args[0], args[1]); return origWrite(...args); };
  res.end = (...args) => { addOutBytes(args[0], args[1]); usageScan.feed(args[0], args[1]); return origEnd(...args); };
  const chunks = [];
  const startedAt = Date.now();
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks);
    let parsedBody = null;
    if (rawBody.length && req.headers["content-type"]?.includes("application/json")) {
      try { parsedBody = JSON.parse(rawBody.toString("utf8")); } catch { parsedBody = null; }
    }
    const route = classifyRequest(req, parsedBody || {});
    const headers = req.headers || {};
    const headerRole = String(headers["x-subagent-name"] || "").trim().toLowerCase();
    const headerTaskType = String(headers["x-claude-code-task-type"] || "").trim().toLowerCase();
    const effectiveRole = route.role || headerRole || (route.reason === "compaction" ? "compaction" : route.reason === "background" ? "background" : route.reason);
    const effectiveTaskType = headerTaskType || (route.reason === "compaction" ? "compaction" : route.reason === "background" ? "background" : "");

    if (parsedBody && Array.isArray(parsedBody.tools)) {
      parsedBody.tools = pruneTools(parsedBody.tools, effectiveRole, effectiveTaskType);
    }

    // Context shaping (D10 compaction pruning, D12 observation masking, D11 effort hint). All three
    // flags default OFF, so with no flag set applyContextShaping returns the identical body object.
    // It is fail-open by construction: on any throw the caller's parsedBody is forwarded unchanged.
    try {
      const shaping = await applyContextShaping(req, parsedBody, route, effectiveRole);
      parsedBody = shaping.body;
      if (shaping.effort) route.effort = shaping.effort;
    } catch (err) {
      console.error(`[SHAPING-ERROR] role=${effectiveRole} ${err && err.name ? err.name : "Error"} — forwarding unshaped body`);
    }
    if (route.target === "OPENCODE_GO" && route.effort && route.effort !== "max") {
      console.warn(`[OGO-EFFORT] role=${effectiveRole} plan effort=${route.effort} is not settable on the OpenCode Go path; sending max`);
    }

    console.log(`[ROUTE:${route.target}] model=${route.model} reason=${route.reason} role=${effectiveRole} tools=${parsedBody?.tools?.length ?? 0}`);
    res.usageUpstream = route.target; // fallback hops overwrite this to the serving provider
    res.on("finish", () => {
      console.log(`[DONE] role=${effectiveRole} model=${res.fallbackModel || route.model}${res.fallbackModel ? " fallback=1" : ""} status=${res.statusCode} ms=${Date.now() - startedAt} out_bytes=${outBytes}`);
      // R4 (2026-10-10, owner ask): make a fallback-served MAIN lane visible in the client UI.
      // The statusline badge reads this state file — Claude Code's own model label always shows
      // the SELECTED model, so the router is the only place that knows what actually served.
      // Main-orchestrator only: subagent/background fallbacks must not flip the CEO's badge.
      // Owner ruling 2026-10-11: the main lane no longer hops to another model, so its only
      // substitution left is the router ANTHROPIC_API_KEY retry: badge it as "<model>-api-key" so the
      // owner can tell a subscription-served turn from a pay-per-token one. The suffix passes the
      // statusline model allowlist (MODEL_RE in scripts/statusline.py).
      if (effectiveRole === "main-orchestrator" && res.statusCode === 200 && /^\/v1\/messages(\?|$)/.test(req.url || "")) {
        updateFallbackBadge(res.fallbackModel || (res.keyServedModel ? `${res.keyServedModel}-api-key` : null));
      }
      // WO-6: one jsonl line per served response that carried usage. No prompt or
      // response content, no headers — token counts and routing metadata only.
      try {
        const u = usageScan.finish();
        if (u && (u.input || u.output || u.cacheRead || u.cacheCreation)) {
          appendUsageLine({
            ts: new Date().toISOString(),
            role: effectiveRole,
            lane: route.reason || "",
            model: res.fallbackModel || route.model,
            upstream: normaliseUpstream(res.usageUpstream || route.target),
            credential: res.credential || "router", // owner ruling 2026-10-11: oauth | api_key | router
            fallback: res.fallbackModel ? 1 : 0, // WO-N1 (M-002): 1 = served by the one-hop fallback
            status: res.statusCode,
            ms: Date.now() - startedAt,
            input: u.input,
            output: u.output,
            cache_read: u.cacheRead,
            cache_creation: u.cacheCreation,
          });
        }
      } catch { /* usage logging is best-effort */ }
    });
    if (route.target === "OPENCODE_GO") handleOpenCodeGo(req, res, rawBody, parsedBody, route.model, effectiveRole, route.anthropicFallbackModel, route.anthropicFallbackEffort);
    else {
      // A swapped subagent lane falls back the other way: Anthropic -> OpenCode Go on 429/quota/5xx.
      const ogoFallback = route.fallback && route.fallback.target === "OPENCODE_GO"
        ? (cause) => {
            if (res.fallbackHop) return safeError(res, 502, "both providers unavailable");
            res.fallbackHop = 1;
            // OpenCode Go hop = max effort: handleOpenCodeGo always sends adaptive thinking + effort "max".
            console.log(`[FALLBACK] role=${effectiveRole} from=${route.model} to=${route.fallback.model} effort=max cause=${cause}`);
            res.fallbackModel = route.fallback.model;
            res.usageUpstream = route.fallback.target; // WO-6: who actually served
            handleOpenCodeGo(req, res, rawBody, parsedBody, route.fallback.model, effectiveRole);
          }
        : null;
      handleAnthropic(req, res, rawBody, parsedBody, route.model, {
        forceModel: !!route.forceModel,
        onFail: ogoFallback,
        effort: route.effort || null,
        role: effectiveRole,
        // Only the CEO's own primary Anthropic lane arms a keep-warm ping; compaction,
        // summary and background roles are Anthropic-bound but must never arm.
        keepWarmRole: effectiveRole === "main-orchestrator" ? "main-orchestrator" : null,
      });
    }

  });
}

const server = http.createServer(routerRequestHandler);

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Claude Code hybrid router listening on http://${HOST}:${PORT}`));

  // A throw in an async request handler must never take every in-flight stream down with it.
  process.on("unhandledRejection", (reason) => {
    console.error(`[UNHANDLED-REJECTION] ${reason && reason.name ? reason.name : typeof reason} ${reason && reason.message ? String(reason.message).slice(0, 200) : ""}`);
  });

  process.on("SIGTERM", () => {
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

// routerRequestHandler is exported so a running router can swap to new routing code in place
// (inspector hot-swap, 2026-09-23) without dropping in-flight streams.
// fallbackTargetFor is exported for tests.
// R5: test seam for the egress semaphore (counts reset; queued jobs' timers cleared).
const __ogoEgressTestHook = {
  acquire: ogoEgressAcquire,
  release: ogoEgressRelease,
  cancel: ogoEgressCancel,
  state: () => ({ active: ogoEgress.active, queued: ogoEgress.queue.length }),
  reset: () => {
    ogoEgress.queue.forEach((j) => clearTimeout(j.timer));
    ogoEgress.queue.length = 0;
    ogoEgress.active = 0;
  },
};
// WO-N1: test seam for the fallback budget (and the breaker it drains on).
const __fallbackBudgetTestHook = {
  config: fallbackBudgetConfig,
  state: () => ({ active: fallbackBudget.active, queued: fallbackBudget.queue.length }),
  breaker: ogoBreaker,
  reset: () => {
    fallbackBudget.queue.forEach((j) => clearTimeout(j.timer));
    fallbackBudget.queue.length = 0;
    fallbackBudget.active = 0;
    fallbackBudgetDisarmReprobe();
    ogoBreaker.consecutiveFailures = 0;
    ogoBreaker.openUntil = 0;
    ogoBreaker.lastFailure = null;
  },
};
module.exports = { classifyRequest, pruneTools, routerRequestHandler, buildAnthropicOutboundBody, DEFAULT_ROLE_PLAN, COMPACTION_PLAN, fallbackTargetFor, normaliseUpstream, composeBothProvidersError, anthropicHopViable, isTerminalOgo429, updateFallbackBadge, decodeProxyBody, USAGE_LIMITS, __ogoEgressTestHook, __fallbackBudgetTestHook, __resetUsageModeCheck };
