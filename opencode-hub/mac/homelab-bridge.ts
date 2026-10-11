// homelab-bridge — local-decide decision hooks for a remote OpenCode client of this setup's server.
// Served by opencode-hub (/plugins/homelab-bridge-<version>.tgz) and loaded through the hub's
// /.well-known/opencode config. Hook logic is a byte-for-byte port of the server plugin
// ~/.config/opencode/plugin/sync-shared.ts on the server, except:
//   - the daemon is reached through the hub (HTTP over a private network): POST {HUB}/decide/hook/opencode/<event>;
//     the hub tags off-box calls "opencode-mac" (laptop profile: safety + work-memory recall)
//   - no shared-MCP config hook (the laptop's own mcp_config.json lists the hub MCPs)
//   - no permission.ask auto-allow (the laptop's own permission rules decide, even when the hub is down)
// The provider retry/concurrency wrapper below is copied verbatim; its global flag
// (__opencode_retry_installed__) makes it a no-op when another plugin already installed the same wrapper.
import type { Plugin } from "@opencode-ai/plugin"

const HUB_URL = (process.env.HOMELAB_HUB_URL ?? "__HUB_URL__").replace(/\/+$/, "")
const LOCAL_DECIDE_TIMEOUT_MS = 1500
// Captured before the retry wrapper below replaces globalThis.fetch: a decide call must never be retried
// (an AbortSignal.timeout counts as retryable there and would blow the 1.5 s budget five times over).
const PRISTINE_FETCH = globalThis.fetch

const DECIDE_BEFORE_RE = /^(task|edit|write|patch|multiedit|apply_patch|bash|shell|run_command)$/i
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

// One POST per hook event. Returns null on ANY problem (hub or daemon down, non-2xx,
// unparseable body, timeout) so every caller falls through to allow / no-op.
async function localDecide(event: string, payload: unknown): Promise<any | null> {
  try {
    const res = await PRISTINE_FETCH(`${HUB_URL}/decide/hook/opencode/${event}`, {
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
      if (releaseZaiSlot) {
        releaseZaiSlot()
      }
    }
  }
}

export default (async () => {
  return {
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
          // bounded: an oversized body is refused (413) and the recite would be silently lost
          context: Array.isArray(output?.context)
            ? output.context.slice(-20).map((c: any) => (typeof c === "string" ? c.slice(-4000) : c))
            : [],
        })
        const text = readField(body, ["text", "inject", "context", "message"])
        if (text && Array.isArray(output?.context)) output.context.push(text)
      } catch {
        // fail-open
      }
    },
    event: async ({ event }: { event: any }) => {
      // D6 -> log-only bookkeeping on idle.
      if (event?.type !== "session.idle") return
      try {
        await localDecide("session.idle", {
          sessionID: event.properties?.sessionID ?? event.properties?.info?.id,
        })
      } catch {
        // fail-open
      }
    },
    "experimental.compaction.autocontinue": async (_input: any, output: any) => {
      output.enabled = true
    },
  }
}) satisfies Plugin
