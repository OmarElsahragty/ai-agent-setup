// quota-wait (OpenCode Go): on an OpenCode Go usage-limit 429 (error.type
// GoUsageLimitError or FreeUsageLimitError; the 429 may carry a retry-after header in
// seconds, otherwise the message says "Resets in <n> day(s)/hour(s)/minute(s)"), make
// OpenCode wait until reset + 2 min and retry ONCE, but only when the reset is near
// (wait <= 5 h). A farther reset (weekly or monthly window) or an unreadable reset
// fails fast: the upstream 429 is replaced by a non-retryable 402 that carries a clear
// message, so there is neither a multi-hour sleep nor a retry storm. A quota error that
// is still present after the single retry also fails fast.
//
// MECHANISM (verified against OpenCode 1.18.35, /root/.opencode/bin/opencode):
// 1. Interception = a globalThis.fetch wrapper installed at module load, the pattern
//    also used by sync-shared.ts. OpenCode's provider fetch calls the GLOBAL fetch at
//    call time. Only host opencode.ai is touched; other hosts and every 2xx pass through.
// 2. The wait is NOT done inside fetch: OpenCode aborts provider requests with
//    HeaderTimeoutError after headerTimeout (opencode-go: 180000 ms in opencode.jsonc),
//    so a long in-fetch sleep would be killed and re-sent.
// 3. Instead the real 429 is returned with a `retry-after-ms` header. OpenCode's session
//    retry delay reads `retry-after-ms` first, sleeps abortably (ESC works, the TUI shows
//    the countdown) and retries, at most 5 times. Its retry check keys on the 429 status,
//    so the 402 fail-fast response is not retried by OpenCode.
// 4. While the wait is active, every opencode.ai request is answered locally with a
//    synthesized 429 (`retry-after-ms` + `retry-after` = the remaining wait) and never
//    reaches OpenCode Go. An already-aborted request still goes to fetch, which rejects it.
// 5. Composition with sync-shared.ts retryFetch, the other global fetch wrapper here.
//    Plugin files load in sorted order, so quota-wait.ts installs first as the INNER
//    wrapper: OpenCode -> retryFetch -> quota-wait -> fetch. retryFetch returns 401, 402
//    and 403 at once, so the fail-fast response is never retried by it.
// 6. A 429 body is parsed only when its declared content-length is at most 64 KB; at most
//    64 KB is read, from a clone whose unread rest is cancelled. OpenCode always gets the
//    original body, a local 429 during the wait, or the fail-fast 402.
// 7. Logs carry structured fields only (error type, durations, wait end as ISO). Upstream
//    message text is never logged; it is returned only inside the 402 body that OpenCode
//    shows to the user.
// 8. Hooks.event (observe-only) logs a quota error that escaped the fetch layer.
// 9. The plugin loader calls every module export as a plugin and throws on anything else,
//    so this module has exactly one export (default). Test hooks hang off it as a
//    non-enumerable `internals` property.
//
// Kill switch: OPENCODE_QUOTA_WAIT=0 in the OpenCode process environment.

import type { Plugin } from "@opencode-ai/plugin"

const QUOTA_ERROR_TYPES = new Set(["GoUsageLimitError", "FreeUsageLimitError"])
const MAX_WAIT_MS = 5 * 60 * 60 * 1000 // wait only when reset + buffer <= 5 h (the rolling window)
const RESET_BUFFER_MS = 120_000 // reset + 2 min
// A quota error arriving within this window after the wait ended is the result of the
// single retry (or of OpenCode's bounded retries after it): no second wait, fail fast.
const RETRY_GRACE_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 65_536 // 429 body parse limit
// 402 is outside the retryable set (429 and 5xx), so OpenCode and the SDK do not retry it.
const FAIL_FAST_STATUS = 402
const OGO_HOST = "opencode.ai"
const MAX_UPSTREAM_MESSAGE = 300

const RESET_CLAUSE_RE = /resets?\s+in\s+([^.;]*)/i
const DURATION_PART_RE = /(\d+)\s*(day|hour|hr|minute|min|second|sec)s?\b/gi
const UNIT_MS: Record<string, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  hr: 3_600_000,
  minute: 60_000,
  min: 60_000,
  second: 1_000,
  sec: 1_000,
}
const TYPE_IN_TEXT_RE = /GoUsageLimitError|FreeUsageLimitError/
const QUOTA_TEXT_RE = /usage limit reached|GoUsageLimitError|FreeUsageLimitError/i
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function safeType(type: string): string {
  return QUOTA_ERROR_TYPES.has(type) ? type : "unknown"
}

// "Resets in 1 day." / "Resets in 2 hours 13 minutes" -> ms; null when no duration is readable.
function parseResetIn(text: string): number | null {
  const clause = RESET_CLAUSE_RE.exec(text)?.[1]
  if (!clause) return null
  let total = 0
  let parts = 0
  for (const m of clause.matchAll(DURATION_PART_RE)) {
    total += parseInt(m[1] ?? "0", 10) * (UNIT_MS[(m[2] ?? "").toLowerCase()] ?? 0)
    parts++
  }
  return parts > 0 ? total : null
}

// A retry-after header in whole seconds, when present, is the authoritative remaining time.
function retryAfterMs(header: string | null): number | null {
  const v = (header ?? "").trim()
  return /^\d+$/.test(v) ? parseInt(v, 10) * 1000 : null
}

type QuotaErrorInfo = { type: string; resetInMs: number | null; message: string }

// Quota iff error.type is an OpenCode Go usage-limit type, or the message says "usage limit reached".
function parseQuotaError(bodyText: string, retryAfter: string | null): QuotaErrorInfo | null {
  if (!bodyText) return null
  const trimmed = bodyText.trim()
  let type = ""
  let message = trimmed
  if (trimmed.startsWith("{")) {
    try {
      const parsed: any = JSON.parse(trimmed)
      const holder = parsed && typeof parsed === "object" ? (parsed.error ?? parsed) : null
      if (holder && typeof holder === "object") {
        type = typeof holder.type === "string" ? holder.type : ""
        message = typeof holder.message === "string" ? holder.message : ""
      }
    } catch {
      message = trimmed
    }
  }
  if (!QUOTA_ERROR_TYPES.has(type) && !/usage limit reached/i.test(message)) return null
  return {
    type: safeType(type),
    resetInMs: retryAfterMs(retryAfter) ?? parseResetIn(message),
    message: message.slice(0, MAX_UPSTREAM_MESSAGE),
  }
}

// Wait length when the reset is near (reset + buffer <= 5 h); null means fail fast.
function computeWaitMs(resetInMs: number | null): number | null {
  if (resetInMs === null) return null
  const waitMs = resetInMs + RESET_BUFFER_MS
  return waitMs <= MAX_WAIT_MS ? waitMs : null
}

function isGoRequest(input: any): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? "")
  try {
    return new URL(raw).hostname === OGO_HOST
  } catch {
    return false
  }
}

function isAborted(input: any, init?: any): boolean {
  const signal = init?.signal !== undefined ? init.signal : input?.signal
  return signal?.aborted === true
}

function withRetryAfterMs(res: Response, waitMs: number): Response {
  const headers = new Headers(res.headers)
  headers.set("retry-after-ms", String(Math.max(0, Math.round(waitMs))))
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function localQuotaResponse(type: string, resetAtMs: number, remainingMs: number): Response {
  const waitMs = Math.max(0, Math.round(remainingMs))
  const message = `OpenCode Go usage limit (${type}, reset ${iso(resetAtMs)}); quota-wait answered locally without calling opencode.ai, retry in ${waitMs}ms`
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "content-type": "application/json",
      "retry-after-ms": String(waitMs),
      "retry-after": String(Math.ceil(waitMs / 1000)),
    },
  })
}

function failFastResponse(type: string, reason: string, upstreamMessage: string): Response {
  const message = `OpenCode Go usage limit (${type}): ${reason}. quota-wait fails fast (no wait, no retry). Upstream: ${upstreamMessage}`
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status: FAIL_FAST_STATUS,
    statusText: "Payment Required",
    headers: { "content-type": "application/json" },
  })
}

async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return ""
  const reader = body.getReader()
  const buf = new Uint8Array(maxBytes)
  let total = 0
  let finished = false
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        break
      }
      if (!(value instanceof Uint8Array)) throw new TypeError("non-byte body chunk")
      const n = Math.min(value.byteLength, maxBytes - total)
      buf.set(value.subarray(0, n), total)
      total += n
    }
  } finally {
    // Not awaited: on a cloned (tee'd) body it settles only when the other branch ends.
    if (!finished) reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(buf.subarray(0, total))
}

type QuotaWaitDeps = {
  fetchImpl?: (input: any, init?: any) => Promise<Response>
  now?: () => number
  log?: (line: string) => void
  env?: Record<string, string | undefined>
}

type Episode = {
  untilMs: number
  type: string
  resetAtMs: number
  localLogged: boolean
  joinLogged: boolean
  postLogged: boolean
}

function createQuotaWaitFetch(deps: QuotaWaitDeps = {}) {
  const doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.warn(line))
  const env = deps.env ?? process.env
  // One episode = one wait + one retry. Cleared by any 2xx opencode.ai response.
  let episode: Episode | null = null

  return async function quotaWaitFetch(input: any, init?: any): Promise<Response> {
    if (env.OPENCODE_QUOTA_WAIT === "0" || !isGoRequest(input)) return doFetch(input, init)
    const startedAt = now()
    if (episode && startedAt < episode.untilMs && !isAborted(input, init)) {
      const remaining = episode.untilMs - startedAt
      if (!episode.localLogged) {
        episode.localLogged = true
        log(`[quota-wait] request during the active wait answered locally (${episode.type}, no upstream call); retry in ${remaining}ms`)
      }
      return localQuotaResponse(episode.type, episode.resetAtMs, remaining)
    }
    const res = await doFetch(input, init) // network errors propagate untouched
    if (res.ok) {
      if (episode) log("[quota-wait] OpenCode Go request succeeded; quota episode cleared")
      episode = null
      return res
    }
    if (res.status !== 429) return res
    if (Number(res.headers.get("content-length")) > MAX_BODY_BYTES) return res
    let bodyText: string
    try {
      bodyText = await readBoundedText(res.clone().body, MAX_BODY_BYTES)
    } catch {
      return res
    }
    const q = parseQuotaError(bodyText, res.headers.get("retry-after"))
    if (!q) return res
    const t = now()
    if (episode && t >= episode.untilMs + RETRY_GRACE_MS) episode = null
    if (episode && t >= episode.untilMs) {
      if (!episode.postLogged) {
        episode.postLogged = true
        log(`[quota-wait] retry after the wait is still quota-limited (${q.type}); failing fast, no second wait`)
      }
      return failFastResponse(q.type, "still limited after the single wait", q.message)
    }
    if (episode) {
      // Sent before the wait began, answered during it.
      const remaining = episode.untilMs - t
      if (!episode.joinLogged) {
        episode.joinLogged = true
        log(`[quota-wait] in-flight request hit the quota during the active wait (${q.type}); it waits the remaining ${remaining}ms`)
      }
      return withRetryAfterMs(res, remaining)
    }
    const waitMs = computeWaitMs(q.resetInMs)
    if (waitMs === null || q.resetInMs === null) {
      const readable = q.resetInMs === null ? "unreadable" : `in ${q.resetInMs}ms`
      log(`[quota-wait] OpenCode Go ${q.type}: reset ${readable} is not within the ${MAX_WAIT_MS}ms wait cap; failing fast, no wait`)
      return failFastResponse(q.type, "reset is not near or cannot be read", q.message)
    }
    episode = {
      untilMs: t + waitMs,
      type: q.type,
      resetAtMs: t + q.resetInMs,
      localLogged: false,
      joinLogged: false,
      postLogged: false,
    }
    log(
      `[quota-wait] OpenCode Go ${q.type}: reset in ${q.resetInMs}ms; OpenCode waits ${waitMs}ms (until ${iso(t + waitMs)}) then retries once`,
    )
    return withRetryAfterMs(res, waitMs)
  }
}

if (!(globalThis as any).__opencode_quota_wait_installed__) {
  ;(globalThis as any).__opencode_quota_wait_installed__ = true
  globalThis.fetch = createQuotaWaitFetch() as typeof globalThis.fetch
}

const quotaWaitPlugin = (async () => ({
  event: async ({ event }: { event: any }) => {
    if (event?.type !== "session.error") return
    const err = event?.properties?.error
    const text = String(err?.data?.message ?? err?.message ?? "")
    if (!text || !QUOTA_TEXT_RE.test(text)) return
    const sid = String(event?.properties?.sessionID ?? "")
    const type = safeType(TYPE_IN_TEXT_RE.exec(text)?.[0] ?? "")
    const resetIn = parseResetIn(text)
    const readable = resetIn === null ? "unreadable" : `in ${resetIn}ms`
    console.warn(
      `[quota-wait] OpenCode Go quota error reached session ${SESSION_ID_RE.test(sid) ? sid : "?"}: type ${type}, reset ${readable}`,
    )
  },
})) satisfies Plugin

Object.defineProperty(quotaWaitPlugin, "internals", {
  enumerable: false,
  value: {
    QUOTA_ERROR_TYPES,
    MAX_WAIT_MS,
    RESET_BUFFER_MS,
    RETRY_GRACE_MS,
    MAX_BODY_BYTES,
    FAIL_FAST_STATUS,
    safeType,
    parseResetIn,
    parseQuotaError,
    computeWaitMs,
    isGoRequest,
    readBoundedText,
    localQuotaResponse,
    failFastResponse,
    createQuotaWaitFetch,
  },
})

export default quotaWaitPlugin
