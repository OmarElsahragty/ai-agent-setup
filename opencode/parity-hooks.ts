import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

// WO-4: OpenCode parity adapters for the Claude Code hook layer.
// Library module only — deliberately NOT placed in plugin/ because OpenCode
// auto-discovers every *.ts/*.js there as a plugin module.
// All entry points fail open: any error -> allow / no-op, never a thrown error
// out of a caller that does not expect one. The ONLY throwing function is
// applyWriteGuards, and only on an explicit deny from secret-write-guard,
// restart-guard, poll-guard, agent-claude-launch-guard or file-lease.

// Setup root: AI_SETUP_ROOT wins (exported by the bin/ wrapper and .env); else the repo
// root this module lives in (<root>/opencode/parity-hooks.ts). resolvePath drops the
// trailing slash fileURLToPath keeps.
const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? resolvePath(fileURLToPath(new URL("..", import.meta.url)))

export const DEFAULT_HOOKS_DIR = `${AI_SETUP_ROOT}/scripts/hooks`
export const TMP_DIR = "/var/tmp/claude"
export const GUARD_TIMEOUT_MS = 10_000
// WO-7 REQ3: payloads with content below this length cannot carry a credential,
// so the two guard spawns are skipped entirely.
export const GUARD_MIN_CONTENT_CHARS = 8
export const SUMMARY_MIN_INTERVAL_MS = 10 * 60_000
export const SUMMARY_MIN_NEW_USER_MSGS = 3
const TRANSCRIPT_STALE_MS = 30 * 60_000
const MAX_PATCH_CHARS = 200_000

export function hooksDir(): string {
  return process.env.PARITY_HOOKS_DIR || DEFAULT_HOOKS_DIR
}

export function sessionMemoryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.SESSION_MEMORY ?? "").toLowerCase() !== "off"
}

// ---------------------------------------------------------------- runScript
// Never rejects. stderr is discarded so no script output can ever leak into logs.
export function runScript(
  scriptPath: string,
  stdinData: string,
  timeoutMs: number = GUARD_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ""
    let done = false
    const finish = (r: { ok: boolean; stdout: string; error?: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "ignore"] })
    } catch (e: any) {
      resolve({ ok: false, stdout: "", error: String(e?.message ?? e) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
      finish({ ok: false, stdout: "", error: "timeout" })
    }, timeoutMs)
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < 2_000_000) stdout += d.toString("utf-8")
    })
    child.on("error", (err: Error) => finish({ ok: false, stdout: "", error: err.message }))
    child.on("close", (code: number | null) => finish({ ok: code === 0, stdout }))
    child.stdin?.on("error", () => {})
    child.stdin?.end(stdinData)
  })
}

// ------------------------------------------- OpenCode tool -> Claude hook JSON
// OpenCode built-ins (checked against the 1.18.33 binary):
//   write  {filePath, content}
//   edit   {filePath, oldString, newString}
//   apply_patch / patch {patchText}  (V4A "*** Update File: path" / "+line" format)
//   bash   {command}
function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v
  return ""
}

function patchFilePath(patch: string): string {
  const m = patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)
  return m ? m[1].trim() : ""
}

function patchAddedLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n")
}

export function mapToClaudeHookJson(tool: string, args: unknown): { tool_name: string; tool_input: any } | null {
  if (!args || typeof args !== "object") return null
  const a = args as Record<string, any>
  const t = String(tool).toLowerCase()
  const filePath = firstString(a.filePath, a.file_path, a.path, a.filename)
  if (t === "write") {
    return { tool_name: "Write", tool_input: { file_path: filePath, content: String(a.content ?? "") } }
  }
  if (t === "edit") {
    return {
      tool_name: "Edit",
      tool_input: { file_path: filePath, new_string: String(a.newString ?? a.new_string ?? "") },
    }
  }
  if (t === "patch" || t === "apply_patch") {
    const patch = String(a.patchText ?? a.patch ?? a.diff ?? "").slice(0, MAX_PATCH_CHARS)
    if (!patch) return null
    return {
      tool_name: "Write",
      tool_input: { file_path: filePath || patchFilePath(patch), content: patchAddedLines(patch) },
    }
  }
  if (t === "multiedit" && Array.isArray(a.edits)) {
    return { tool_name: "MultiEdit", tool_input: { file_path: filePath, edits: a.edits } }
  }
  // WO-8 REQ1: OpenCode bash {command} -> Claude Bash form for the guard layer.
  if (t === "bash") {
    return { tool_name: "Bash", tool_input: { command: String(a.command ?? "") } }
  }
  return null
}

// WO-7 REQ3: cheap pre-check. Returns false when the mapped payload has no
// file path AND no content, or its content is shorter than 8 chars — nothing
// the guards could flag, so both python spawns are skipped entirely.
// WO-8 REQ2: Bash is judged on its command alone; even a short command can
// trip restart-guard, so only an empty command is unworthy.
export function guardScanWorthy(mapped: { tool_name: string; tool_input: any } | null): boolean {
  if (!mapped) return false
  const ti = mapped.tool_input ?? {}
  if (mapped.tool_name === "Bash") {
    return typeof ti.command === "string" && ti.command.trim().length > 0
  }
  const filePath = typeof ti.file_path === "string" ? ti.file_path.trim() : ""
  let content = ""
  if (typeof ti.content === "string") content = ti.content
  else if (typeof ti.new_string === "string") content = ti.new_string
  else if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e === "object") content += `\n${String(e.new_string ?? e.newString ?? "")}`
    }
  }
  if (!filePath && !content.trim()) return false
  return content.length >= GUARD_MIN_CONTENT_CHARS
}

// ------------------------------------------------------------ guard adapters
// secret-write-guard.py: deny -> reason string; allow/fail-open -> null.
// The tool input (content/new_string) is passed on stdin only, never logged.
export async function secretWriteGuardCheck(tool: string, args: unknown): Promise<string | null> {
  try {
    const mapped = mapToClaudeHookJson(tool, args)
    if (!guardScanWorthy(mapped)) return null
    const res = await runScript(`${hooksDir()}/secret-write-guard.py`, JSON.stringify(mapped), GUARD_TIMEOUT_MS)
    if (!res.ok || !res.stdout.trim()) return null
    const parsed = JSON.parse(res.stdout)
    const hso = parsed?.hookSpecificOutput
    if (hso?.permissionDecision === "deny") {
      const reason = String(hso.permissionDecisionReason ?? "secret-write-guard denied the write")
      return reason.includes("\n") ? reason.split("\n")[0].trim() : reason.trim()
    }
    return null
  } catch {
    return null
  }
}

// restart-guard.py (WO-8 REQ1): deny/ask -> reason string; allow/fail-open -> null.
// Bash only — raw restarts/kills of the cloudcli unit kill every running
// Claude session (see the script docstring). The script may answer "ask"
// (owner confirmation, e.g. safe-restart.sh cloudcli --now); OpenCode has no
// owner prompt here, so "ask" is treated exactly like "deny".
export async function restartGuardCheck(tool: string, args: unknown): Promise<string | null> {
  try {
    const mapped = mapToClaudeHookJson(tool, args)
    if (!mapped || mapped.tool_name !== "Bash" || !guardScanWorthy(mapped)) return null
    const res = await runScript(`${hooksDir()}/restart-guard.py`, JSON.stringify(mapped), GUARD_TIMEOUT_MS)
    if (!res.ok || !res.stdout.trim()) return null
    const parsed = JSON.parse(res.stdout)
    const hso = parsed?.hookSpecificOutput
    if (hso?.permissionDecision === "deny" || hso?.permissionDecision === "ask") {
      const reason = String(hso.permissionDecisionReason ?? "restart-guard denied the command")
      return reason.includes("\n") ? reason.split("\n")[0].trim() : reason.trim()
    }
    return null
  } catch {
    return null
  }
}

// poll-guard.py (M-045) + agent-claude-launch-guard.py (GAP-8), 2026-10-10: same contract as
// restart-guard (Bash only; deny -> reason string; allow/fail-open -> null). The OpenCode
// session id is passed so poll-guard keys its 10-minute window per session, and cwd (the
// bash workdir resolved against the session directory, see toolCwd) so it counts per
// working directory; an unknown cwd is left out (poll-guard then counts per session only).
// A poll-guard deny carries the OpenCode remedy instead of Claude's run_in_background one.
export async function bashScriptGuardCheck(
  script: string,
  tool: string,
  args: unknown,
  sessionID?: string,
  cwd?: string,
): Promise<string | null> {
  try {
    const mapped = mapToClaudeHookJson(tool, args)
    if (!mapped || mapped.tool_name !== "Bash" || !guardScanWorthy(mapped)) return null
    const payload: Record<string, unknown> = { ...mapped }
    if (sessionID) payload.session_id = `opencode-${sessionID}`
    const dir = cwd || toolCwd(args)
    if (dir) payload.cwd = dir
    const res = await runScript(`${hooksDir()}/${script}`, JSON.stringify(payload), GUARD_TIMEOUT_MS)
    if (!res.ok || !res.stdout.trim()) return null
    const hso = JSON.parse(res.stdout)?.hookSpecificOutput
    if (hso?.permissionDecision === "deny" || hso?.permissionDecision === "ask") {
      const raw = String(hso.permissionDecisionReason ?? `${script} denied the command`)
      const reason = raw.includes("\n") ? raw.split("\n")[0].trim() : raw.trim()
      return script === "poll-guard.py" ? openCodePollReason(reason) : reason
    }
    return null
  } catch {
    return null
  }
}

// poll-guard's remedy names Claude Code's run_in_background=true, which the OpenCode bash
// tool does not have: every sentence mentioning it is replaced by one bounded foreground wait.
export const OPENCODE_POLL_REMEDY = "OpenCode: use one foreground `timeout N bash -c 'until <cond>; do sleep 5; done'`"

export function openCodePollReason(reason: string): string {
  const parts = String(reason ?? "").split(/\.\s+/)
  const sentences = parts.map((s, i) => (i < parts.length - 1 ? `${s}.` : s)).filter((s) => s.trim())
  const out: string[] = []
  let placed = false
  for (const s of sentences) {
    if (!/run_in_background/i.test(s)) out.push(s)
    else if (!placed) {
      out.push(`${OPENCODE_POLL_REMEDY}.`)
      placed = true
    }
  }
  if (!placed) out.push(`${OPENCODE_POLL_REMEDY}.`)
  return out.join(" ")
}

// gateguard.py: warn-only; returns the additionalContext nudge or null. Never denies.
// WO-8 REQ1: gateguard is never run for bash payloads.
export async function gateGuardCheck(tool: string, args: unknown, transcriptPath?: string): Promise<string | null> {
  try {
    const mapped = mapToClaudeHookJson(tool, args)
    if (!mapped || mapped.tool_name === "Bash") return null
    if (!guardScanWorthy(mapped)) return null
    const payload: Record<string, unknown> = { ...mapped }
    if (transcriptPath) payload.transcript_path = transcriptPath
    const res = await runScript(`${hooksDir()}/gateguard.py`, JSON.stringify(payload), GUARD_TIMEOUT_MS)
    if (!res.ok || !res.stdout.trim()) return null
    const parsed = JSON.parse(res.stdout)
    const text = parsed?.hookSpecificOutput?.additionalContext
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 2000) : null
  } catch {
    return null
  }
}

// -------------------------------------------------- session brief (SessionStart parity)
// session-brief.py prints Claude SessionStart JSON; we extract additionalContext.
export async function sessionBriefText(directory: string): Promise<string | null> {
  try {
    const res = await runScript(`${hooksDir()}/session-brief.py`, JSON.stringify({ cwd: directory }))
    if (!res.ok || !res.stdout.trim()) return null
    const parsed = JSON.parse(res.stdout)
    const text = parsed?.hookSpecificOutput?.additionalContext
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 16_000) : null
  } catch {
    return null
  }
}

// ---------------------------------------------- precompact-recite (PreCompact parity)
// Plain-text stdout (template + ledger tails); empty transcript_path still
// yields the fixed template, so this never returns null when the script runs.
export async function precompactReciteText(transcriptPath: string): Promise<string | null> {
  try {
    const res = await runScript(`${hooksDir()}/precompact-recite.py`, JSON.stringify({ transcript_path: transcriptPath }))
    return res.ok && res.stdout.trim() ? res.stdout.trim().slice(0, 60_000) : null
  } catch {
    return null
  }
}

// ------------------------------------------------ transcript export (Claude JSONL)
// Shape parsed by memlib.parse_conversation / gateguard / precompact-recite:
//   {"type":"user"|"assistant","message":{"role":..,"content":string|blocks[]}}
// Assistant tool activity is emitted as tool_use blocks so gateguard sees Read/Bash.
export type ExportedTranscript = { path: string; userCount: number }

function sanitizeSid(sid: string): string {
  return String(sid || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "nosid"
}

const CLAUDE_TOOL_NAME: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  task: "Task",
  webfetch: "WebFetch",
}

// Claude arg names for the tools downstream parsers (gateguard) understand.
function claudeToolInput(name: string, raw: any): any {
  const i = raw && typeof raw === "object" ? raw : {}
  const fp = i.filePath ?? i.file_path ?? i.path ?? i.filename
  switch (name) {
    case "Read":
      return { file_path: fp }
    case "Bash":
      return { command: i.command ?? "" }
    case "Write":
      return { file_path: fp, content: i.content ?? "" }
    case "Edit":
      return { file_path: fp, old_string: i.oldString ?? "", new_string: i.newString ?? "" }
    default:
      return i
  }
}

function toolUseBlock(p: any): any | null {
  const name = CLAUDE_TOOL_NAME[String(p?.tool ?? "").toLowerCase()] ?? String(p?.tool ?? "tool")
  const input = claudeToolInput(name, p?.state?.input ?? p?.input ?? {})
  return { type: "tool_use", name, input }
}

export async function fetchSessionMessages(client: any, sessionID: string): Promise<Array<{ info: any; parts: any[] }>> {
  const res = await client?.session?.messages?.({ path: { id: sessionID } })
  const list = (res as any)?.data ?? res
  return Array.isArray(list) ? list : []
}

export function countUserTextMessages(messages: Array<{ info: any; parts: any[] }>): number {
  let n = 0
  for (const m of messages) {
    if (m?.info?.role !== "user") continue
    const text = (m.parts ?? [])
      .filter((p: any) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
      .map((p: any) => p.text)
      .join("\n")
      .trim()
    if (text) n++
  }
  return n
}

const transcriptPaths = new Map<string, { path: string; ts: number }>()

// WO-8 REQ4: transcript exports are per-session scratch files; anything in the
// target dir matching opencode-*.jsonl older than 24 h (mtime) is stale.
// Best-effort: every error is swallowed — the export must never fail over the
// sweep (missing dir, racy unlink, perms, ...).
const TRANSCRIPT_SWEEP_MS = 24 * 60 * 60_000

function sweepStaleTranscripts(targetDir: string, nowMs: number): void {
  try {
    for (const name of readdirSync(targetDir)) {
      if (!name.startsWith("opencode-") || !name.endsWith(".jsonl")) continue
      const p = join(targetDir, name)
      try {
        const st = statSync(p)
        if (st.isFile() && nowMs - st.mtimeMs > TRANSCRIPT_SWEEP_MS) unlinkSync(p)
      } catch {}
    }
  } catch {}
}

export function transcriptPathFor(sessionID: string, nowMs: number = Date.now()): string | undefined {
  const e = transcriptPaths.get(sessionID)
  return e && nowMs - e.ts < TRANSCRIPT_STALE_MS ? e.path : undefined
}

export function exportSessionTranscript(
  messages: Array<{ info: any; parts: any[] }>,
  sessionID: string,
  targetDir: string = TMP_DIR,
  nowMs: number = Date.now(),
): ExportedTranscript {
  const lines: string[] = []
  let userCount = 0
  for (const m of messages) {
    const role = m?.info?.role === "assistant" ? "assistant" : m?.info?.role === "user" ? "user" : null
    if (!role) continue
    const text = (m.parts ?? [])
      .filter((p: any) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
      .map((p: any) => p.text)
      .join("\n")
      .trim()
    const toolParts = (m.parts ?? []).filter((p: any) => p?.type === "tool")
    if (role === "user") {
      if (text) {
        lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }))
        userCount++
      }
      continue
    }
    const blocks: any[] = []
    if (text) blocks.push({ type: "text", text })
    for (const p of toolParts) {
      const b = toolUseBlock(p)
      if (b) blocks.push(b)
    }
    if (blocks.length) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } }))
  }
  // Tool parts living on user turns (OpenCode mirrors results there) still become
  // assistant tool_use lines so downstream parsers see them as model actions.
  for (const m of messages) {
    if (m?.info?.role === "assistant") continue
    const blocks = (m.parts ?? []).filter((p: any) => p?.type === "tool").map(toolUseBlock).filter(Boolean)
    if (blocks.length) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } }))
  }
  const path = `${targetDir}/opencode-${sanitizeSid(sessionID)}.jsonl`
  mkdirSync(targetDir, { recursive: true })
  sweepStaleTranscripts(targetDir, nowMs)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 })
  renameSync(tmp, path)
  transcriptPaths.set(sessionID, { path, ts: nowMs })
  return { path, userCount }
}

export async function exportViaClient(client: any, sessionID: string): Promise<ExportedTranscript | null> {
  try {
    const messages = await fetchSessionMessages(client, sessionID)
    return exportSessionTranscript(messages, sessionID)
  } catch {
    return null
  }
}

// ------------------------------------------------------ session summary (Stop parity)
export type SummaryState = Map<string, { lastRunMs: number; lastUserCount: number }>

export function shouldSummarize(
  state: SummaryState,
  sessionID: string,
  userCount: number,
  nowMs: number,
  minIntervalMs: number = SUMMARY_MIN_INTERVAL_MS,
  minNewUserMsgs: number = SUMMARY_MIN_NEW_USER_MSGS,
): boolean {
  const prev = state.get(sessionID)
  if (!prev) return userCount >= minNewUserMsgs
  return nowMs - prev.lastRunMs >= minIntervalMs && userCount - prev.lastUserCount >= minNewUserMsgs
}

export function recordSummaryRun(state: SummaryState, sessionID: string, userCount: number, nowMs: number): void {
  state.set(sessionID, { lastRunMs: nowMs, lastUserCount: userCount })
}

// session-summary.py re-detaches itself; this spawn returns immediately.
// Env carries SESSION_ID (script fallback) and PWD (project naming).
export function spawnSummaryScript(transcriptPath: string, sessionID: string, directory?: string): boolean {
  try {
    const child = spawn("python3", [`${hooksDir()}/session-summary.py`, transcriptPath], {
      cwd: directory || undefined,
      env: { ...process.env, SESSION_ID: sessionID, PWD: directory || process.env.PWD },
      stdio: "ignore",
      detached: true,
    })
    child.on("error", () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

export async function summarizeOnIdle(
  client: any,
  sessionID: string,
  state: SummaryState,
  directory?: string,
  nowMs: number = Date.now(),
): Promise<void> {
  rememberSessionContext(client, sessionID, directory)
  // file-lease (independent of SESSION_MEMORY): a CHILD session going idle has
  // finished its task and releases its leases; a root session's idle never does.
  if (sessionID) void fileLeaseSessionEvent({ type: "session.idle", properties: { sessionID } })
  if (!sessionMemoryEnabled() || !sessionID) return
  try {
    const messages = await fetchSessionMessages(client, sessionID)
    const userCount = countUserTextMessages(messages)
    if (!shouldSummarize(state, sessionID, userCount, nowMs)) return
    const exp = exportSessionTranscript(messages, sessionID)
    if (!spawnSummaryScript(exp.path, sessionID, directory)) return
    recordSummaryRun(state, sessionID, userCount, nowMs)
  } catch {
    // fail open
  }
}

// ------------------------------------------------------------ session brief cache
const briefCache = new Map<string, { promise: Promise<string | null>; injected: boolean }>()

async function computeBrief(client: any, sessionID: string, fallbackDir?: string): Promise<string | null> {
  let dir = fallbackDir
  if (!dir) {
    try {
      const s = await client?.session?.get?.({ path: { id: sessionID } })
      dir = (s as any)?.data?.directory ?? (s as any)?.directory ?? undefined
    } catch {}
  }
  return sessionBriefText(dir || process.env.PWD || process.cwd())
}

export function briefForSession(client: any, sessionID: string, fallbackDir?: string): Promise<string | null> {
  // sync-shared calls this on session.created (with the session's own directory)
  // and before a session's first LLM call, so every session's client is known
  // to the file-lease lookups before its first tool call.
  rememberSessionContext(client, sessionID, fallbackDir)
  if (!sessionMemoryEnabled() || !sessionID) return Promise.resolve(null)
  let entry = briefCache.get(sessionID)
  if (!entry) {
    entry = { promise: computeBrief(client, sessionID, fallbackDir), injected: false }
    briefCache.set(sessionID, entry)
  }
  return entry.promise
}

export function markBriefInjected(sessionID: string): void {
  const e = briefCache.get(sessionID)
  if (e) e.injected = true
}

export function briefAlreadyInjected(sessionID: string): boolean {
  return briefCache.get(sessionID)?.injected === true
}

// ------------------------------------------------------- write guards (entry point)
export const WRITE_GUARD_TOOL_RE = /^(write|edit|patch|apply_patch|multiedit)$/i
export const BASH_GUARD_TOOL_RE = /^bash$/i

const GATE_WARNINGS_MAX = 200
const gateWarnings = new Map<string, string>()

// gateguard + file-lease warnings of one call, joined; surfaced by takeGateWarning.
function stashWarning(callID: string | undefined, text: string | null): void {
  if (!callID || !text) return
  const prev = gateWarnings.get(callID)
  if (prev === undefined && gateWarnings.size >= GATE_WARNINGS_MAX) {
    const oldest = gateWarnings.keys().next().value
    if (oldest !== undefined) gateWarnings.delete(oldest)
  }
  gateWarnings.set(callID, prev ? `${prev}\n${text}` : text)
}

// tool.execute.after (sync-shared) calls this for EVERY tool: it returns the
// call's stashed gateguard / file-lease warning (or null) and flushes the call's
// file-lease PostToolUse record (fire-and-forget; awaitable via flushLeaseRecords).
export function takeGateWarning(callID: string | undefined): string | null {
  if (!callID) return null
  const lease = leaseCalls.get(callID)
  if (lease !== undefined) {
    leaseCalls.delete(callID)
    void fileLeaseRecord(lease.tool, lease.args, undefined, lease.actor)
  }
  const w = gateWarnings.get(callID)
  if (w !== undefined) gateWarnings.delete(callID)
  return w ?? null
}

// ------------------------------------------------------- OpenCode session context
// The plugin client is created per OpenCode instance (directory). sync-shared
// hands it to briefForSession / summarizeOnIdle / precompactParityText, which
// record it here per session (plus the last one seen as a fallback) with a
// directory hint, for the file-lease parentID / directory lookups.
export const SESSION_LOOKUP_TIMEOUT_MS = 1_500
const SESSION_CHAIN_MAX = 8
const SESSION_CACHE_MAX = 1_000
const SESSION_RETRY_MS = 60_000

type SessionLink = { rootID?: string; directory?: string }
type SessionLinkEntry = { at: number; ok: boolean; promise: Promise<SessionLink> }

const sessionClients = new Map<string, any>()
const sessionDirHints = new Map<string, string>()
const sessionLinks = new Map<string, SessionLinkEntry>()
let fallbackClient: any = null

function capSet<V>(m: Map<string, V>, key: string, value: V): void {
  if (!m.has(key) && m.size >= SESSION_CACHE_MAX) {
    const oldest = m.keys().next().value
    if (oldest !== undefined) m.delete(oldest)
  }
  m.set(key, value)
}

export function rememberSessionContext(client: any, sessionID?: string, directory?: string): void {
  try {
    if (client && typeof client === "object") {
      fallbackClient = client
      if (sessionID && sessionClients.get(sessionID) !== client) {
        capSet(sessionClients, sessionID, client)
        // a lookup that failed before this session's own client was known is retried
        if (sessionLinks.get(sessionID)?.ok === false) sessionLinks.delete(sessionID)
      }
    }
    if (sessionID && typeof directory === "string" && isAbsolute(directory) && !sessionDirHints.has(sessionID)) {
      capSet(sessionDirHints, sessionID, directory)
    }
  } catch {
    // fail open
  }
}

// One client.session.get bounded by SESSION_LOOKUP_TIMEOUT_MS; null on any
// failure (SDK error response, timeout, throw, foreign id, no data).
async function getSessionInfo(client: any, id: string): Promise<{ parentID?: string; directory?: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const call = client?.session?.get?.({ path: { id } })
    if (!call || typeof call.then !== "function") return null
    const res: any = await Promise.race([
      call,
      new Promise((done) => {
        timer = setTimeout(() => done(null), SESSION_LOOKUP_TIMEOUT_MS)
      }),
    ])
    if (!res || typeof res !== "object" || res.error) return null
    const info = "data" in res ? res.data : res
    if (!info || typeof info !== "object") return null
    const sameSession = typeof info.id === "string" ? info.id === id : typeof info.directory === "string"
    if (!sameSession) return null
    return {
      parentID: typeof info.parentID === "string" && info.parentID ? info.parentID : undefined,
      directory: typeof info.directory === "string" && isAbsolute(info.directory) ? info.directory : undefined,
    }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Walks the parentID chain to the root session. A cached ancestor short-cuts
// the walk, and every ancestor walked through is cached too, so each session
// id is looked up at most once.
async function resolveSessionLink(sessionID: string): Promise<{ link: SessionLink; ok: boolean; noClient: boolean }> {
  const client = sessionClients.get(sessionID) ?? fallbackClient
  if (!client) return { link: {}, ok: false, noClient: true }
  let directory: string | undefined
  let cur = sessionID
  const walked: Array<{ id: string; directory?: string }> = []
  const done = (rootID: string) => {
    for (const w of walked) {
      if (!sessionLinks.get(w.id)?.ok) {
        const link: SessionLink = { rootID, directory: w.directory }
        capSet(sessionLinks, w.id, { at: Date.now(), ok: true, promise: Promise.resolve(link) })
      }
    }
    return { link: { rootID, directory }, ok: true, noClient: false }
  }
  const seen = new Set<string>()
  for (let depth = 0; depth < SESSION_CHAIN_MAX && !seen.has(cur); depth++) {
    seen.add(cur)
    const known = depth > 0 ? sessionLinks.get(cur) : undefined
    if (known?.ok) {
      const ancestor = await known.promise
      if (ancestor.rootID) return done(ancestor.rootID)
    }
    const info = await getSessionInfo(sessionClients.get(cur) ?? client, cur)
    if (!info) break
    if (depth === 0) directory = info.directory
    else walked.push({ id: cur, directory: info.directory })
    if (!info.parentID) return done(cur)
    cur = info.parentID
  }
  return { link: { directory }, ok: false, noClient: false }
}

// Cached per session: a resolved chain forever, a failed one for SESSION_RETRY_MS,
// "no client known yet" not at all; concurrent callers share one lookup.
function sessionLink(sessionID: string): Promise<SessionLink> {
  const now = Date.now()
  const hit = sessionLinks.get(sessionID)
  if (hit && (hit.ok || now - hit.at < SESSION_RETRY_MS)) return hit.promise
  const entry: SessionLinkEntry = { at: now, ok: false, promise: Promise.resolve({}) }
  entry.promise = resolveSessionLink(sessionID).then(
    (r) => {
      entry.ok = r.ok
      if (r.noClient && sessionLinks.get(sessionID) === entry) sessionLinks.delete(sessionID)
      return r.link
    },
    () => ({}),
  )
  capSet(sessionLinks, sessionID, entry)
  return entry.promise
}

// The directory OpenCode runs a tool in: the bash / apply_patch `workdir`
// resolved against the session directory (path.resolve), else the session
// directory itself. undefined when unknown — never process.cwd(), which is the
// OpenCode server's own directory, not the session's.
export function toolCwd(args: unknown, sessionDirectory?: string): string | undefined {
  const base = typeof sessionDirectory === "string" && isAbsolute(sessionDirectory) ? sessionDirectory : undefined
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
  const workdir = typeof a.workdir === "string" ? a.workdir.trim() : ""
  if (workdir) {
    if (isAbsolute(workdir)) return resolvePath(workdir)
    return base ? resolvePath(base, workdir) : undefined
  }
  return base ? resolvePath(base) : undefined
}

export type LeaseActor = { session: string; agent: string; cwd: string; isChild: boolean }

// Never rejects; any failure gives the pre-2026-10-10 actor "oc:<sessionID>" / "main".
export async function resolveLeaseActor(sessionID?: string, args?: unknown): Promise<LeaseActor> {
  const sid = sanitizeSid(sessionID ?? "")
  try {
    const link: SessionLink = sessionID ? await sessionLink(sessionID) : {}
    const directory = link.directory ?? (sessionID ? sessionDirHints.get(sessionID) : undefined)
    const cwd = toolCwd(args, directory) ?? ""
    if (link.rootID && link.rootID !== sessionID) {
      return { session: `oc:${sanitizeSid(link.rootID)}`, agent: sid, cwd, isChild: true }
    }
    return { session: `oc:${sid}`, agent: "main", cwd, isChild: false }
  } catch {
    return { session: `oc:${sid}`, agent: "main", cwd: "", isChild: false }
  }
}

// ------------------------------------------------------------ file-lease parity
// file-lease.py (lease per actor, stale-content check; see its docstring).
// OpenCode actor, mirroring Claude Code's session_id + agent_id:
//   root session  -> session "oc:<sessionID>",     agent "main"
//   child session -> session "oc:<rootSessionID>", agent "<childSessionID>"
// (parentID chain resolved once per session via client.session.get and cached;
// a failed lookup falls back to "oc:<sessionID>" / "main"), so the main thread
// may take over its own subagent's lease while sibling subagents stay
// serialized. cwd = toolCwd ("" when unknown: relative targets are then not
// leased). lease_pid = this OpenCode process, so a dead process frees its
// leases. PreToolUse runs from applyWriteGuards only after every other guard
// allowed: deny -> thrown, additionalContext (takeover / half-applied note) ->
// stashed per callID. PostToolUse (takeGateWarning) and the child SessionEnd
// release (fileLeaseSessionEvent) are fire-and-forget, tracked for
// flushLeaseRecords. Nothing here ever throws or rejects.
export const LEASE_TIMEOUT_MS = 5_000
export const LEASE_READ_TOOL_RE = /^(read|read_file)$/i
const LEASE_STASH_MAX = 200
const LEASE_FLUSH_ROUNDS = 10
const leaseCalls = new Map<string, { tool: string; args: unknown; actor: Promise<LeaseActor> }>()
const pendingLease = new Set<Promise<void>>()

function patchFilePaths(patch: string): string[] {
  const out: string[] = []
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patch)) !== null) out.push(m[1].trim())
  return out
}

export function mapLeasePayload(tool: string, args: unknown): { tool_name: string; tool_input: any } | null {
  if (!args || typeof args !== "object") return null
  const a = args as Record<string, any>
  const t = String(tool ?? "").toLowerCase()
  if (LEASE_READ_TOOL_RE.test(t)) {
    const fp = firstString(a.filePath, a.file_path, a.path, a.filename)
    return fp ? { tool_name: "Read", tool_input: { file_path: fp } } : null
  }
  const mapped = mapToClaudeHookJson(t, args)
  if (!mapped) return null
  if (mapped.tool_name === "Bash") return mapped
  const input: Record<string, unknown> = { file_path: mapped.tool_input?.file_path ?? "" }
  if (t === "patch" || t === "apply_patch") {
    input.file_paths = patchFilePaths(String(a.patchText ?? a.patch ?? a.diff ?? "").slice(0, MAX_PATCH_CHARS))
  }
  return { tool_name: mapped.tool_name, tool_input: input }
}

export function leaseHookPayload(
  event: "PreToolUse" | "PostToolUse",
  mapped: { tool_name: string; tool_input: any },
  actor: LeaseActor,
): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: actor.session,
    agent_id: actor.agent,
    tool_name: mapped.tool_name,
    tool_input: mapped.tool_input,
    cwd: actor.cwd,
    lease_pid: process.pid,
  }
}

type LeaseVerdict = { deny: string | null; warn: string | null }
const LEASE_ALLOW: LeaseVerdict = { deny: null, warn: null }

// PreToolUse: deny -> reason; additionalContext -> warn; allow/fail-open -> neither.
async function fileLeasePre(tool: string, args: unknown, actor: LeaseActor): Promise<LeaseVerdict> {
  try {
    const mapped = mapLeasePayload(tool, args)
    if (!mapped || mapped.tool_name === "Read") return LEASE_ALLOW
    if (mapped.tool_name === "Bash" && !guardScanWorthy(mapped)) return LEASE_ALLOW
    const payload = JSON.stringify(leaseHookPayload("PreToolUse", mapped, actor))
    const res = await runScript(`${hooksDir()}/file-lease.py`, payload, LEASE_TIMEOUT_MS)
    if (!res.ok || !res.stdout.trim()) return LEASE_ALLOW
    const hso = JSON.parse(res.stdout)?.hookSpecificOutput
    if (hso?.permissionDecision === "deny") {
      const reason = String(hso.permissionDecisionReason ?? "file-lease denied the write")
      return { deny: reason.includes("\n") ? reason.split("\n")[0].trim() : reason.trim(), warn: null }
    }
    const note = typeof hso?.additionalContext === "string" ? hso.additionalContext.trim() : ""
    return { deny: null, warn: note ? note.slice(0, 2000) : null }
  } catch {
    return LEASE_ALLOW
  }
}

// Standalone adapter (same contract as the other *Check functions): deny ->
// reason, else null; a warning is only logged here (applyWriteGuards stashes it).
export async function fileLeaseCheck(tool: string, args: unknown, sessionID?: string): Promise<string | null> {
  try {
    const verdict = await fileLeasePre(tool, args, await resolveLeaseActor(sessionID, args))
    if (verdict.warn) console.warn(`[file-lease] ${verdict.warn}`)
    return verdict.deny
  } catch {
    return null
  }
}

function trackLease(work: Promise<unknown>): Promise<void> {
  const tracked: Promise<void> = work
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      pendingLease.delete(tracked)
    })
  pendingLease.add(tracked)
  return tracked
}

// Awaitable seam (tests, shutdown): resolves once every lease record / release
// started so far, and any started while waiting, has finished. Never rejects.
export async function flushLeaseRecords(): Promise<void> {
  for (let round = 0; round < LEASE_FLUSH_ROUNDS && pendingLease.size > 0; round++) {
    await Promise.allSettled([...pendingLease])
  }
}

// PostToolUse record: what this actor saw (Read) or wrote. Fire-and-forget;
// the returned promise is tracked and never rejects.
export function fileLeaseRecord(
  tool: string,
  args: unknown,
  sessionID?: string,
  actor?: LeaseActor | Promise<LeaseActor>,
): Promise<void> {
  try {
    const mapped = mapLeasePayload(tool, args)
    if (!mapped || (mapped.tool_name === "Bash" && !guardScanWorthy(mapped))) return Promise.resolve()
    const script = `${hooksDir()}/file-lease.py`
    const who = actor ? Promise.resolve(actor) : resolveLeaseActor(sessionID, args)
    return trackLease(
      who.then((a) => runScript(script, JSON.stringify(leaseHookPayload("PostToolUse", mapped, a)), LEASE_TIMEOUT_MS)),
    )
  } catch {
    return Promise.resolve()
  }
}

// OpenCode session events -> file-lease release (Claude Code SubagentStop /
// SessionEnd parity). A CHILD session that goes idle (its task finished) or is
// deleted releases its leases at once with a SessionEnd for its own agent; a
// root session never releases here. summarizeOnIdle routes session.idle here;
// session.deleted needs the plugin event hook to call this. Never rejects.
export function fileLeaseSessionEvent(event: any, client?: any): Promise<void> {
  try {
    const type = event?.type
    const props = event?.properties ?? {}
    let sid: unknown
    let parentID: unknown
    if (type === "session.idle") sid = props.sessionID
    else if (type === "session.deleted") {
      sid = props.info?.id ?? props.sessionID
      parentID = props.info?.parentID
    } else return Promise.resolve()
    if (typeof sid !== "string" || !sid) return Promise.resolve()
    if (client) rememberSessionContext(client, sid)
    return releaseChildLease(sid, typeof parentID === "string" && parentID ? parentID : undefined)
  } catch {
    return Promise.resolve()
  }
}

function releaseChildLease(sessionID: string, parentID?: string): Promise<void> {
  const script = `${hooksDir()}/file-lease.py`
  // PostToolUse records still in flight would re-take the holder after the release.
  const earlier = [...pendingLease]
  return trackLease(
    (async () => {
      const actor = await childActor(sessionID, parentID)
      if (!actor) return
      await Promise.allSettled(earlier)
      const payload = {
        hook_event_name: "SessionEnd",
        session_id: actor.session,
        agent_id: actor.agent,
        lease_pid: process.pid,
      }
      await runScript(script, JSON.stringify(payload), LEASE_TIMEOUT_MS)
    })(),
  )
}

// The child actor of a session, or null for a root / unresolvable session. A
// deleted session cannot be looked up any more: its event's parentID is used.
async function childActor(sessionID: string, parentID?: string): Promise<LeaseActor | null> {
  if (parentID && !sessionLinks.get(sessionID)?.ok) {
    const parent = await sessionLink(parentID)
    if (!parent.rootID) return null
    return { session: `oc:${sanitizeSid(parent.rootID)}`, agent: sanitizeSid(sessionID), cwd: "", isChild: true }
  }
  const actor = await resolveLeaseActor(sessionID)
  return actor.isChild ? actor : null
}

function stashLeaseCall(callID: string | undefined, tool: string, args: unknown, actor: Promise<LeaseActor>): void {
  if (!callID) return
  if (leaseCalls.size >= LEASE_STASH_MAX) {
    const oldest = leaseCalls.keys().next().value
    if (oldest !== undefined) leaseCalls.delete(oldest)
  }
  leaseCalls.set(callID, { tool, args, actor })
}

function dropLeaseCall(callID: string | undefined): void {
  if (callID) leaseCalls.delete(callID)
}

// Throws ONLY on an explicit guard deny (the deny mechanism for OpenCode
// plugins); the thrown error carries .parityDeny = true so the plugin wrapper
// can tell a deny from a parity runtime failure.
// - Write tools: secret-write-guard + gateguard (warn-only) run concurrently
//   (WO-7 REQ1), each on its own 10 s timeout.
// - Bash (WO-8 REQ1, 2026-10-10): secret-write-guard + restart-guard +
//   poll-guard + agent-claude-launch-guard run concurrently; gateguard never
//   runs for bash; an empty command skips every spawn.
// - Only when all of those allowed does file-lease PreToolUse run (5 s), so a
//   denied call never takes a lease.
// gateguard and file-lease warnings are stashed per callID (surfaced by
// takeGateWarning in tool.execute.after) and logged with console.warn.
// Read/write/bash calls are stashed for their PostToolUse lease record; a
// denied call's stash is dropped.
function parityDenyError(reason: string): Error {
  const err = new Error(reason)
  ;(err as any).parityDeny = true
  return err
}

function denyIf(callID: string | undefined, reason: string | null): void {
  if (!reason) return
  dropLeaseCall(callID)
  throw parityDenyError(reason)
}

export async function applyWriteGuards(
  tool: string,
  args: unknown,
  callID?: string,
  sessionID?: string,
): Promise<void> {
  const t = String(tool ?? "")
  const isBash = BASH_GUARD_TOOL_RE.test(t)
  const isWrite = WRITE_GUARD_TOOL_RE.test(t)
  if (!isBash && !isWrite && !LEASE_READ_TOOL_RE.test(t)) return
  // file-lease actor (cached per session, never rejects); the call is stashed
  // for its PostToolUse record, flushed by takeGateWarning.
  const actor = resolveLeaseActor(sessionID, args)
  stashLeaseCall(callID, t, args, actor)
  if (!isBash && !isWrite) return
  let gateWarn: string | null = null
  if (isBash) {
    const [secretDeny, restartDeny, pollDeny, launchDeny] = await Promise.all([
      secretWriteGuardCheck(t, args),
      restartGuardCheck(t, args),
      actor.then((a) => bashScriptGuardCheck("poll-guard.py", t, args, sessionID, a.cwd)),
      actor.then((a) => bashScriptGuardCheck("agent-claude-launch-guard.py", t, args, sessionID, a.cwd)),
    ])
    denyIf(callID, secretDeny || restartDeny || pollDeny || launchDeny)
  } else {
    const [secretDeny, warn] = await Promise.all([
      secretWriteGuardCheck(t, args),
      gateGuardCheck(t, args, sessionID ? transcriptPathFor(sessionID) : undefined),
    ])
    denyIf(callID, secretDeny)
    gateWarn = warn
  }
  const lease = await fileLeasePre(t, args, await actor)
  denyIf(callID, lease.deny)
  if (gateWarn) {
    stashWarning(callID, gateWarn)
    console.warn(`[gateguard] ${gateWarn}`)
  }
  if (lease.warn) {
    stashWarning(callID, lease.warn)
    console.warn(`[file-lease] ${lease.warn}`)
  }
}

// precompact parity entry: export transcript, then run precompact-recite.py.
export async function precompactParityText(client: any, sessionID: string): Promise<string | null> {
  rememberSessionContext(client, sessionID)
  try {
    const exp = await exportViaClient(client, sessionID)
    return await precompactReciteText(exp?.path ?? "")
  } catch {
    return precompactReciteText("")
  }
}
