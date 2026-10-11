import { readFileSync, existsSync } from "fs"
import { fileURLToPath } from "url"
import type { Plugin } from "@opencode-ai/plugin"
import type * as ParityModule from "../parity-hooks.ts"

// Setup root: AI_SETUP_ROOT wins (exported by the bin/ wrapper and .env); else the repo
// root this plugin lives in (<root>/opencode/plugin/sync-shared.ts).
const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))

if (existsSync(`${AI_SETUP_ROOT}/.env`)) {
  try {
    const envLines = readFileSync(`${AI_SETUP_ROOT}/.env`, "utf8").split("\n");
    for (const line of envLines) {
      const match = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

// WO-7 REQ2: parity is loaded through a guarded dynamic import so a load-time
// or evaluation failure in parity code can never disable the pre-existing
// local-decide / MCP behaviour in this plugin — one warning is logged and the
// plugin continues without parity features. PARITY_MODULE overrides the module
// specifier ONLY in tests (PARITY_TEST=1, WO-8 REQ3); production always loads
// the sibling parity-hooks.ts so a stray env var can never swap the parity
// implementation.
async function loadParity(): Promise<typeof ParityModule | null> {
  try {
    const specifier =
      process.env.PARITY_TEST === "1" && process.env.PARITY_MODULE
        ? process.env.PARITY_MODULE
        : "../parity-hooks.ts"
    return await import(specifier)
  } catch (e: any) {
    console.warn(`[sync-shared] parity module unavailable, continuing without parity features: ${e?.message ?? e}`)
    return null
  }
}

const SHARED_MCP = `${AI_SETUP_ROOT}/mcp/mcp_config.json`

// --- local-decide daemon (fail-open) --------------------------------------
// PRISTINE_FETCH is captured BEFORE the global retry/stream wrapper below
// replaces globalThis.fetch. That wrapper classifies an AbortSignal.timeout
// rejection as retryable (its message contains "timeout"), so a daemon call
// routed through it would burn 5 attempts plus backoff on every 1.5s budget
// expiry. Holding the pre-wrap reference keeps one call == one 1.5s budget.
const PRISTINE_FETCH = globalThis.fetch

const LOCAL_DECIDE_URL = process.env.LOCAL_DECIDE_URL ?? "http://127.0.0.1:11438"
const LOCAL_DECIDE_TIMEOUT_MS = 1500

// tool.execute.before: task -> D3/D4 (subagent routing), edit/write -> D7, bash -> D8.
// read/read_file: D17 (no whole-file read of a > 40 KB file), parity with Claude Code's PreToolUse Read
const DECIDE_BEFORE_RE = /^(task|edit|write|patch|multiedit|apply_patch|bash|shell|run_command|read|read_file)$/i
// tool.execute.after: D13 warns on untrusted text pulled in by these tools.
const READ_TOOL_RE = /^(webfetch|web_fetch|fetch|read|read_file|list|glob|grep)$/i
const EXA_TOOL_RE = /^exa[_.-]/i

function readField(body: any, keys: string[]): string {
  if (!body || typeof body !== "object") return ""
  for (const key of keys) {
    const value = body[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function readDecision(body: any): string {
  return readField(body, ["decision", "action"]).toLowerCase()
}

function partsText(parts: any): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
}

// A part pushed from chat.message must be complete: OpenCode >= 1.18.30 crashes the turn on a part
// without id/sessionID/messageID (EventV2.InvalidDurableEvent). The id copies OpenCode's own ascending
// format, "prt_" + 12 hex (ms * 4096 + counter) + 14 base62; the counter is maxed so the injected part
// sorts after every part OpenCode created in the same millisecond.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function partID(): string {
  const stamp = (BigInt(Date.now()) * 4096n + 4095n) & 0xffffffffffffn
  const rand = crypto.getRandomValues(new Uint8Array(14))
  return "prt_" + stamp.toString(16).padStart(12, "0") + Array.from(rand, (b) => BASE62[b % 62]).join("")
}

function textPart(input: any, output: any, text: string): any | null {
  const sessionID = output?.message?.sessionID ?? input?.sessionID
  const messageID = output?.message?.id ?? input?.messageID
  if (typeof sessionID !== "string" || typeof messageID !== "string") return null
  return { id: partID(), sessionID, messageID, type: "text", text, synthetic: true }
}

// One POST per hook event. Returns null on ANY problem (daemon down, non-2xx,
// unparseable body, timeout) so every caller falls through to allow / no-op.
async function localDecide(event: string, payload: unknown): Promise<any | null> {
  try {
    const res = await PRISTINE_FETCH(`${LOCAL_DECIDE_URL}/hook/opencode/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(LOCAL_DECIDE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const parsed = JSON.parse(await res.text())
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

// Active stream concurrency limiter for CamelAI (4 unlimited streams subscription)
const camelState = { v: 0 }
const MAX_CAMEL_CONCURRENT = 4
const camelQueue: Array<() => void> = []

// OpenCode Go concurrency cap: 4 parallel streams (host opencode.ai). The semaphore makes
// opencode main agents + background jobs queue instead of 429-storming each other into
// "Aborted" turns. History: the retired provider's key ceiling was ~2 streams (burst test
// 2026-09-12: 8 parallel -> 6x 429); raised to 4 on 2026-09-22 so title/summary jobs were
// no longer queued behind long primary streams.
const ogoState = { v: 0 }
const MAX_OGO_CONCURRENT = 4
const ogoQueue: Array<() => void> = []

function acquireSlot(max: number, state: { v: number }, queue: Array<() => void>): Promise<() => void> {
  if (state.v < max) {
    state.v++
    let released = false
    return Promise.resolve(() => {
      if (!released) {
        released = true
        state.v--
        const next = queue.shift()
        if (next) next()
      }
    })
  }
  return new Promise((resolve) => {
    queue.push(() => {
      state.v++
      let released = false
      resolve(() => {
        if (!released) {
          released = true
          state.v--
          const next = queue.shift()
          if (next) next()
        }
      })
    })
  })
}

function acquireCamelSlot(): Promise<() => void> {
  return acquireSlot(MAX_CAMEL_CONCURRENT, camelState, camelQueue)
}

function acquireOgoSlot(): Promise<() => void> {
  return acquireSlot(MAX_OGO_CONCURRENT, ogoState, ogoQueue)
}

// Install global fetch retry & stream protection wrapper once at module load
if (!(globalThis as any).__opencode_retry_installed__) {
  (globalThis as any).__opencode_retry_installed__ = true
  const originalFetch = globalThis.fetch

  function isRetryableFetchError(err: any, response?: Response): boolean {
    if (response) {
      if ([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(response.status)) {
        return true
      }
      return false
    }
    if (!err) return false
    const msg = (err.message || String(err)).toLowerCase()
    if (err.name === "AbortError" && !msg.includes("timeout") && !msg.includes("header")) {
      return false
    }
    return (
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("econnaborted") ||
      msg.includes("econnrefused") ||
      msg.includes("epipe") ||
      msg.includes("timeout") ||
      msg.includes("rate limit") ||
      msg.includes("service unavailable") ||
      msg.includes("overloaded") ||
      msg.includes("resource_exhausted") ||
      msg.includes("too many requests") ||
      msg.includes("socket hang up") ||
      msg.includes("premature close") ||
      msg.includes("bad gateway") ||
      msg.includes("gateway timeout") ||
      msg.includes("undici") ||
      msg.includes("networkerror") ||
      msg.includes("terminated") ||
      msg.includes("closed") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504")
    )
  }

  function getRetryDelay(attempt: number, response?: Response): number {
    if (response) {
      const retryAfter = response.headers.get("retry-after")
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10)
        if (!isNaN(secs) && secs > 0) {
          return Math.min(secs * 1000, 6000)
        }
        const dateMs = Date.parse(retryAfter)
        if (!isNaN(dateMs) && dateMs > Date.now()) {
          return Math.min(dateMs - Date.now(), 6000)
        }
      }
    }
    const base = Math.min(1000 * Math.pow(1.5, attempt - 1), 5000)
    const jitter = Math.random() * 500
    return Math.floor(base + jitter)
  }

  globalThis.fetch = async function retryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : (input as any)?.url || ""
    const isCamel = urlStr.includes("stream.camelai.com")
    const isOgo = urlStr.includes("opencode.ai")

    const MAX_ATTEMPTS = 5
    let lastError: any
    let lastResponse: Response | undefined

    let releaseCamelSlot: (() => void) | null = null
    if (isCamel) {
      releaseCamelSlot = await acquireCamelSlot()
    }
    let releaseOgoSlot: (() => void) | null = null
    if (isOgo) {
      releaseOgoSlot = await acquireOgoSlot()
    }

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await originalFetch(input, init)
          if (res.status === 401 || res.status === 403 || res.status === 402) {
            return res
          }
          if (isRetryableFetchError(null, res) && attempt < MAX_ATTEMPTS) {
            lastResponse = res
            const delay = getRetryDelay(attempt, res)
            console.warn(`[opencode-retry] HTTP ${res.status} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delay}ms...`)
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          }
          return res
        } catch (err: any) {
          lastError = err
          if (isRetryableFetchError(err) && attempt < MAX_ATTEMPTS) {
            const delay = getRetryDelay(attempt)
            console.warn(`[opencode-retry] Fetch error (${err?.message || err}) on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delay}ms...`)
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          }
          throw err
        }
      }
      if (lastResponse) return lastResponse
      throw lastError
    } finally {
      if (releaseCamelSlot) {
        releaseCamelSlot()
      }
      if (releaseOgoSlot) {
        releaseOgoSlot()
      }
    }
  }
}

type SharedServer = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  url?: string
  headers?: Record<string, string>
  timeout?: number
}

function convert(name: string, server: SharedServer) {
  if (server.command) {
    return {
      type: "local" as const,
      command: [server.command, ...(server.args ?? [])],
      environment: server.env ?? {},
      enabled: true,
    }
  }
  if (server.type === "http" && server.url) {
    return {
      type: "remote" as const,
      url: server.url,
      headers: server.headers,
      oauth: false as const,
      enabled: true,
      timeout: server.timeout ?? 600000,
    }
  }
  throw new Error(`unsupported shared MCP server: `)
}

export default (async (input: any) => {
  // WO-4 parity: keep a handle on the plugin client + directory for the
  // session-brief / session-summary / precompact adapters in parity-hooks.ts.
  // WO-7 REQ2: null parity = parity features silently off, everything else intact.
  const parity = await loadParity()
  const client = input?.client
  const pluginDirectory = input?.directory
  const summaryState = new Map<string, { lastRunMs: number; lastUserCount: number }>()
  return {
    config: async (cfg: any) => {
      const raw = readFileSync(SHARED_MCP, "utf8")
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, SharedServer> }
      if (!parsed.mcpServers) return
      const mcp: Record<string, unknown> = {}
      for (const [name, server] of Object.entries(parsed.mcpServers)) {
        mcp[name] = convert(name, server)
      }
      cfg.mcp = mcp
    },
    "permission.ask": async (input: any, output: any) => {
      output.status = "allow"
    },
    "chat.message": async (input: any, output: any) => {
      // D1/D2 -> append the decided context to the outgoing user message.
      try {
        const body = await localDecide("chat.message", {
          sessionID: input?.sessionID,
          agent: input?.agent,
          model: input?.model,
          messageID: input?.messageID,
          variant: input?.variant,
          text: partsText(output?.parts),
        })
        const text = readField(body, ["text", "inject", "context", "message"])
        const part = text && Array.isArray(output?.parts) ? textPart(input, output, text) : null
        if (part) output.parts.push(part)
      } catch {
        // fail-open
      }
    },
    "tool.execute.before": async (input: any, output: any) => {
      // D3/D4 (task), D7 (edit/write), D8 (bash). Throwing IS the deny mechanism.
      const tool = String(input?.tool ?? "")
      // WO-4 parity: secret-write-guard deny (throws) + gateguard warn (stashed
      // for tool.execute.after) on write-capable tools; WO-8: bash commands run
      // secret-write-guard + restart-guard (a deny from either throws).
      // 10 s timeout, fail open.
      // WO-7 REQ2: only a real deny (parityDeny marker) propagates; any other
      // parity failure logs one warning and local-decide continues below.
      if (parity) {
        try {
          await parity.applyWriteGuards(tool, output?.args ?? {}, input?.callID, input?.sessionID)
        } catch (e: any) {
          if (e?.parityDeny) throw e
          console.warn(`[sync-shared] parity guard failure (fail-open): ${e?.message ?? e}`)
        }
      }
      if (!DECIDE_BEFORE_RE.test(tool)) return
      let denyReason = ""
      try {
        const body = await localDecide("tool.execute.before", {
          tool,
          sessionID: input?.sessionID,
          callID: input?.callID,
          args: output?.args ?? {},
        })
        const decision = readDecision(body)
        if (decision === "deny" || decision === "block") {
          denyReason = readField(body, ["reason", "text"]) || `local-decide denied ${tool}`
        }
      } catch {
        denyReason = ""
      }
      if (denyReason) throw new Error(denyReason)
    },
    "tool.execute.after": async (input: any, output: any) => {
      // WO-4 parity: surface the gateguard warn-only nudge (stashed in
      // tool.execute.before) inside this tool result. Never throws.
      const gateWarn = parity ? parity.takeGateWarning(input?.callID) : null
      if (gateWarn && typeof output?.output === "string") {
        output.output = `${output.output}\n\n[gateguard] ${gateWarn}`
      }
      // D13 -> warn that text just pulled in from a web/read tool is untrusted.
      const tool = String(input?.tool ?? "")
      if (!READ_TOOL_RE.test(tool) && !EXA_TOOL_RE.test(tool)) return
      try {
        const body = await localDecide("tool.execute.after", {
          tool,
          sessionID: input?.sessionID,
          callID: input?.callID,
          args: input?.args ?? {},
          title: output?.title,
          output: typeof output?.output === "string" ? output.output.slice(0, 8000) : "",
        })
        const text = readField(body, ["text", "warning", "inject", "context", "message", "reason"])
        if (text) output.output = `${output?.output ?? ""}\n\n[local-decide] ${text}`
      } catch {
        // fail-open
      }
    },
    "experimental.session.compacting": async (input: any, output: any) => {
      // D10 -> retention guidance folded into the compaction context.
      try {
        const body = await localDecide("experimental.session.compacting", {
          sessionID: input?.sessionID,
          context: Array.isArray(output?.context) ? output.context.slice(-20) : [],
        })
        const text = readField(body, ["text", "inject", "context", "message"])
        if (text && Array.isArray(output?.context)) output.context.push(text)
      } catch {
        // fail-open
      }
      // WO-4 parity (PreCompact): precompact-recite.py text (template + ledger
      // tail) appended to the compaction context. Fail open.
      try {
        if (parity) {
          const recite = await parity.precompactParityText(client, input?.sessionID)
          if (recite && Array.isArray(output?.context)) output.context.push(recite)
        }
      } catch {
        // fail-open
      }
    },
    event: async ({ event }: { event: any }) => {
      // D6 -> log-only bookkeeping on idle.
      if (event?.type === "session.created") {
        // WO-4 parity (SessionStart): warm the session-brief cache for the new
        // session; injected once via experimental.chat.system.transform below.
        try {
          if (parity) {
            await parity.briefForSession(
              client,
              event.properties?.info?.id,
              event.properties?.info?.directory ?? pluginDirectory,
            )
          }
        } catch {
          // fail-open
        }
        return
      }
      if (event?.type === "session.deleted") {
        // File-lease parity: a deleted child session releases its leases (SessionEnd).
        try {
          if (typeof parity?.fileLeaseSessionEvent === "function") await parity.fileLeaseSessionEvent(event, client)
        } catch {
          // fail-open
        }
        return
      }
      if (event?.type !== "session.idle") return
      try {
        await localDecide("session.idle", {
          sessionID: event.properties?.sessionID ?? event.properties?.info?.id,
        })
      } catch {
        // fail-open
      }
      // WO-4 parity (Stop): export the session transcript to
      // /var/tmp/claude/opencode-<sid>.jsonl and spawn session-summary.py
      // detached. Debounced: >= 3 new user messages and >= 10 min since the
      // last run. SESSION_MEMORY=off skips both brief and summary.
      try {
        let directory: string | undefined
        const sid = event.properties?.sessionID
        try {
          const s = await client?.session?.get?.({ path: { id: sid } })
          directory = (s as any)?.data?.directory ?? (s as any)?.directory ?? undefined
        } catch {
          directory = undefined
        }
        await parity?.summarizeOnIdle(client, sid, summaryState, directory ?? pluginDirectory)
      } catch {
        // fail-open
      }
    },
    // WO-4 parity: the plugin API has no session.created context-injection hook,
    // so the session-brief additionalContext is appended to the system prompt
    // here, once per session (the only LLM-visible injection point that does
    // not fabricate message parts).
    "experimental.chat.system.transform": async (input: any, output: any) => {
      try {
        if (!parity) return
        const sid = input?.sessionID
        if (!sid || parity.briefAlreadyInjected(sid) || !Array.isArray(output?.system)) return
        const brief = await parity.briefForSession(client, sid, pluginDirectory)
        if (brief) output.system.push(brief)
        parity.markBriefInjected(sid)
      } catch {
        // fail-open
      }
    },
    "experimental.compaction.autocontinue": async (_input: any, output: any) => {
      output.enabled = true
    },
  }
}) satisfies Plugin
