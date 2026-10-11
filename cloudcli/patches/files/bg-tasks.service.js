// P2 (WO-E1) + P4 (WO-G1): read-only background-jobs & agents API service.
// Parses a Claude session JSONL for background Bash launches and their
// <task-notification> outcomes, tails their output files under
// /var/tmp/claude/tasks/<taskId>.output, lists the session's launched
// subagents with a live "running" status (same rule as the provider's P1
// patch), tails an agent's own transcript, and reports which sessions are
// currently working. No writes, no process control.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const TASKS_ROOT = '/var/tmp/claude';
const MAX_TASKS = 50;
const MAX_TAIL_BYTES = 64 * 1024;
const DEFAULT_TAIL_LINES = 40;
const MAX_TAIL_LINES = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^[a-z0-9]{6,16}$/;
const AGENT_ID_RE = /^a[0-9a-f]{8,24}$/;
const OUTPUT_PATH_RE = /Output is being written to:\s*(\S+)/;
const EXIT_CODE_RE = /\[exited with code (\d+)\]\s*$/;
const KILLED_TAIL_RE = /\[killed\]\s*$/;
const EXIT_TAIL_BYTES = 4096;
const TASK_ID_TAG_RE = /<task-id>\s*([^\s<]+)\s*<\/task-id>/;
const TOOL_USE_ID_TAG_RE = /<tool-use-id>\s*([^\s<]+)\s*<\/tool-use-id>/;
const STATUS_TAG_RE = /<status>\s*([^\s<]+)\s*<\/status>/;
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
const ALLOWED_STATUSES = new Set(['running', 'completed', 'failed', 'killed']);
// A task stopped on purpose (TaskStop) is reported as "stopped"; show it as killed, not failed.
const TASK_STATUS_ALIASES = new Map([['stopped', 'killed']]);
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const MAX_AGENTS = 50;
const DEFAULT_AGENT_STEPS = 20;
const MAX_AGENT_STEPS = 100;
const AGENT_TRANSCRIPT_WINDOW_BYTES = 4 * 1024 * 1024;
const LABEL_MAX_CHARS = 80;
// Whitelisted tool-input keys used for the one-line "<Tool>: <short arg>"
// preview. Never env objects, file contents, or full prompts beyond the cap.
const TOOL_ARG_KEYS = ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'cmd', 'prompt'];
const MAX_ACTIVE_SESSIONS = 200;
const MAX_ACTIVE_SCAN = 1000;
const MAX_ACTIVE_SUBAGENTS = 200;
const MAX_SCAN_CACHE = 64;
const ACTIVE_CACHE_TTL_MS = 2000;
const MAX_META_SCAN = 200;
const DEFAULT_SESSION_LIVE_MS = 30 * 1000;
const DEFAULT_SUBAGENT_LIVE_MS = 10 * 60 * 1000;

export function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
}

function sessionLiveWindowMs(env = process.env) {
    const parsed = parseInt(env?.CLOUDCLI_SESSION_LIVE_MS, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SESSION_LIVE_MS;
}

// Mirrors modules/providers/list/claude/subagent-live.js (duplicated here so
// this module keeps zero non-builtin imports and stays unit-testable flat).
function subagentLiveWindowMs(env = process.env) {
    const parsed = parseInt(env?.CLOUDCLI_SUBAGENT_LIVE_MS, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SUBAGENT_LIVE_MS;
}

function nowOf(deps) {
    return typeof deps?.now === 'function' ? deps.now() : Date.now();
}

function envOf(deps) {
    return deps?.env ?? process.env;
}

function toolResultText(part) {
    const content = part?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');
    }
    return '';
}

function absorbNotification(text, timestamp, notifications, agentNotifications) {
    const taskMatch = TASK_ID_TAG_RE.exec(text);
    const statusMatch = STATUS_TAG_RE.exec(text);
    const toolUseMatch = TOOL_USE_ID_TAG_RE.exec(text);
    if (taskMatch && statusMatch) {
        notifications.set(taskMatch[1], { status: statusMatch[1].toLowerCase(), timestamp });
    }
    if (toolUseMatch && statusMatch) {
        agentNotifications.set(toolUseMatch[1], { status: statusMatch[1].toLowerCase(), timestamp });
    }
}

// F1: a <task-notification> delivered mid-turn is stored as a JSONL row with
// type "attachment" and attachment.type "queued_command"; the payload sits in
// attachment.prompt (string) in the pinned bundle, with attachment.content
// (string or array of {text} parts) accepted as the alternate carrier.
function attachmentText(attachment) {
    if (typeof attachment?.prompt === 'string') {
        return attachment.prompt;
    }
    const content = attachment?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');
    }
    return '';
}

async function scanTranscript(jsonlPath) {
    const toolUses = new Map();
    const launches = new Map();
    const notifications = new Map();
    const agentNotifications = new Map();
    const agentLaunches = new Map();
    const toolResultIds = new Set();
    let streamError = null;
    try {
        const rl = readline.createInterface({
            input: fs.createReadStream(jsonlPath),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim()) {
                continue;
            }
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            const message = row?.message;
            const timestamp = typeof row?.timestamp === 'string' ? row.timestamp : null;
            if (row?.type === 'attachment' && row?.attachment?.type === 'queued_command') {
                const text = attachmentText(row.attachment);
                if (text.includes('<task-notification>')) {
                    absorbNotification(text, timestamp, notifications, agentNotifications);
                }
            }
            if (message?.role === 'assistant' && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part?.type === 'tool_use' && typeof part.id === 'string') {
                        toolUses.set(part.id, {
                            id: part.id,
                            name: typeof part.name === 'string' ? part.name : '',
                            description: typeof part.input?.description === 'string' ? part.input.description : '',
                            subagentType: typeof part.input?.subagent_type === 'string' ? part.input.subagent_type : '',
                            timestamp,
                        });
                    }
                }
            }
            if (message?.role === 'user') {
                const backgroundTaskId = row?.toolUseResult?.backgroundTaskId;
                const agentId = row?.toolUseResult?.agentId;
                if (typeof message.content === 'string') {
                    if (message.content.includes('<task-notification>')) {
                        absorbNotification(message.content, timestamp, notifications, agentNotifications);
                    }
                }
                else if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part?.type === 'tool_result') {
                            if (typeof part.tool_use_id === 'string') {
                                toolResultIds.add(part.tool_use_id);
                            }
                            if (typeof backgroundTaskId === 'string' && backgroundTaskId) {
                                launches.set(backgroundTaskId, {
                                    taskId: backgroundTaskId,
                                    toolUseId: typeof part.tool_use_id === 'string' ? part.tool_use_id : null,
                                    resultText: toolResultText(part),
                                    rowTimestamp: timestamp,
                                });
                            }
                            else if (typeof agentId === 'string' && agentId) {
                                // One row per agent; a resumed agent overwrites.
                                agentLaunches.set(agentId, {
                                    agentId,
                                    toolUseId: typeof part.tool_use_id === 'string' ? part.tool_use_id : null,
                                    isAsync: row?.toolUseResult?.isAsync === true,
                                    description: typeof row?.toolUseResult?.description === 'string'
                                        ? row.toolUseResult.description
                                        : '',
                                    rowTimestamp: timestamp,
                                });
                            }
                        }
                        else if (part?.type === 'text' && typeof part.text === 'string'
                            && part.text.includes('<task-notification>')) {
                            absorbNotification(part.text, timestamp, notifications, agentNotifications);
                        }
                    }
                }
            }
        }
    }
    catch (error) {
        streamError = error;
    }
    return { toolUses, launches, notifications, agentNotifications, agentLaunches, toolResultIds, streamError };
}

// S6: transcripts are scanned once per (path, size, mtime); an unchanged
// JSONL is served from cache instead of being re-read. The cached scan is
// treated as immutable by every consumer. Bounded LRU, MAX_SCAN_CACHE entries.
const scanCache = new Map();

async function cachedScanTranscript(jsonlPath) {
    const stat = await fsp.stat(jsonlPath).catch(() => null);
    if (stat && stat.isFile()) {
        const hit = scanCache.get(jsonlPath);
        if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
            scanCache.delete(jsonlPath);
            scanCache.set(jsonlPath, hit);
            return hit.scan;
        }
    }
    const scan = await scanTranscript(jsonlPath);
    if (stat && stat.isFile()) {
        if (scanCache.size >= MAX_SCAN_CACHE) {
            scanCache.delete(scanCache.keys().next().value);
        }
        scanCache.set(jsonlPath, { size: stat.size, mtimeMs: stat.mtimeMs, scan });
    }
    return scan;
}

// The parsed output path must resolve exactly to
// /var/tmp/claude/**/tasks/<taskId>.output with no symlink anywhere on the
// way (realpath equality), which also rejects escapes outside TASKS_ROOT.
async function resolveTaskOutputPath(resultText, taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
        return null;
    }
    if (typeof resultText !== 'string') {
        return null;
    }
    const match = OUTPUT_PATH_RE.exec(stripAnsi(resultText));
    if (!match) {
        return null;
    }
    const expectedSuffix = `/tasks/${taskId}.output`;
    const normalized = path.resolve(match[1].replace(/[.,;'")]+$/, ''));
    if (!normalized.startsWith(TASKS_ROOT + path.sep) || !normalized.endsWith(expectedSuffix)) {
        return null;
    }
    let real;
    try {
        real = await fsp.realpath(normalized);
    }
    catch {
        return null;
    }
    if (real !== normalized) {
        return null;
    }
    return real;
}

function timeOf(iso) {
    const parsed = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function tasksFromScan({ toolUses, launches, notifications }) {
    const tasks = [];
    for (const launch of launches.values()) {
        const toolUse = launch.toolUseId ? toolUses.get(launch.toolUseId) : undefined;
        if (toolUse && toolUse.name !== 'Bash') {
            continue;
        }
        const notification = notifications.get(launch.taskId);
        const notifiedStatus = notification
            ? (TASK_STATUS_ALIASES.get(notification.status) ?? notification.status)
            : null;
        tasks.push({
            id: launch.taskId,
            description: toolUse?.description ?? '',
            resolvedOutputPath: null,
            resultText: launch.resultText,
            status: notifiedStatus
                ? (ALLOWED_STATUSES.has(notifiedStatus) ? notifiedStatus : 'failed')
                : 'running',
            startedAt: toolUse?.timestamp ?? launch.rowTimestamp,
            endedAt: notification?.timestamp ?? null,
        });
    }
    tasks.sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
    return tasks.slice(0, MAX_TASKS);
}

// F1 fallback: with no <task-notification> anywhere, a background task whose
// output file tail ends with "[exited with code N]" is finished — completed
// for 0, failed otherwise — and one ending with "[killed]" (the CLI process
// went away with the shell still open, so no notification was ever written)
// is killed. Reads at most the last EXIT_TAIL_BYTES, drops a partial first
// line when windowed, strips ANSI before matching.
async function finishedStatusFromTail(outputPath) {
    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat || !stat.isFile()) {
        return null;
    }
    const start = Math.max(0, stat.size - EXIT_TAIL_BYTES);
    const handle = await fsp.open(outputPath, 'r');
    try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        let text = stripAnsi(buffer.toString('utf8'));
        if (start > 0) {
            const nl = text.indexOf('\n');
            text = nl >= 0 ? text.slice(nl + 1) : '';
        }
        const match = EXIT_CODE_RE.exec(text);
        if (match) {
            return Number.parseInt(match[1], 10) === 0 ? 'completed' : 'failed';
        }
        return KILLED_TAIL_RE.test(text) ? 'killed' : null;
    }
    finally {
        await handle.close();
    }
}

export async function listBackgroundTasks(jsonlPath) {
    const scan = await cachedScanTranscript(jsonlPath);
    if (scan.streamError) {
        throw scan.streamError;
    }
    const tasks = [];
    for (const task of tasksFromScan(scan)) {
        const outputPath = await resolveTaskOutputPath(task.resultText, task.id);
        let outputBytes = 0;
        let endedAt = task.endedAt;
        let status = task.status;
        const stat = outputPath ? await fsp.stat(outputPath).catch(() => null) : null;
        if (stat) {
            outputBytes = stat.size;
        }
        if (status === 'running' && outputPath) {
            const finished = await finishedStatusFromTail(outputPath);
            if (finished !== null) {
                status = finished;
                endedAt = stat ? new Date(stat.mtimeMs).toISOString() : null;
            }
        }
        tasks.push({
            id: task.id,
            description: task.description,
            status,
            startedAt: task.startedAt,
            endedAt,
            outputBytes,
        });
    }
    return tasks;
}

function finishTail(taskId, rawText, byteTruncated, lines) {
    let all = stripAnsi(rawText).split('\n');
    if (byteTruncated) {
        all = all.slice(1);
    }
    if (all.length > 1 && all[all.length - 1] === '') {
        all = all.slice(0, -1);
    }
    const selected = all.length > lines ? all.slice(-lines) : all;
    return {
        id: taskId,
        text: selected.join('\n'),
        truncated: byteTruncated || all.length > selected.length,
    };
}

export async function readTaskTail(jsonlPath, taskId, lines) {
    const scan = await cachedScanTranscript(jsonlPath);
    if (scan.streamError) {
        throw scan.streamError;
    }
    const launch = scan.launches.get(taskId);
    if (!launch) {
        return null;
    }
    const outputPath = await resolveTaskOutputPath(launch.resultText, taskId);
    if (!outputPath) {
        return null;
    }
    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat || !stat.isFile()) {
        return null;
    }
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const handle = await fsp.open(outputPath, 'r');
    try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        return finishTail(taskId, buffer.toString('utf8'), start > 0, lines);
    }
    finally {
        await handle.close();
    }
}

// ---------------------------------------------------------------------------
// P4: agents
// ---------------------------------------------------------------------------

function sanitizeLabel(text) {
    const clean = stripAnsi(typeof text === 'string' ? text : '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > LABEL_MAX_CHARS ? clean.slice(0, LABEL_MAX_CHARS) : clean;
}

function toolArgPreview(input) {
    if (!input || typeof input !== 'object') {
        return '';
    }
    for (const key of TOOL_ARG_KEYS) {
        const value = input[key];
        if (typeof value === 'string' && value.trim()) {
            return value;
        }
    }
    return '';
}

function stepOf(part, timestamp) {
    if (part.type === 'tool_use') {
        const name = typeof part.name === 'string' ? part.name : 'Tool';
        const arg = toolArgPreview(part.input);
        return {
            kind: 'tool',
            label: sanitizeLabel(arg ? `${name}: ${arg}` : name),
            at: timestamp ?? null,
        };
    }
    const content = part.type === 'thinking' ? part.thinking : part.text;
    if (typeof content === 'string' && content.trim()) {
        return { kind: 'text', label: sanitizeLabel(content), at: timestamp ?? null };
    }
    return null;
}

// Streams an agent transcript and keeps only the LAST MAX_AGENT_STEPS steps
// (plus the exact total). Reads at most the last AGENT_TRANSCRIPT_WINDOW_BYTES
// of the file; a windowed read drops the partial first line and the reported
// step total then covers the window only.
async function parseAgentTranscript(transcriptPath) {
    const stat = await fsp.stat(transcriptPath).catch(() => null);
    if (!stat || !stat.isFile()) {
        return null;
    }
    const steps = [];
    let total = 0;
    let lastToolUseId = null;
    let lastToolResultSeen = false;
    let lastStepWasTool = false;
    const pushStep = (step) => {
        total += 1;
        if (steps.length >= MAX_AGENT_STEPS) {
            steps.shift();
        }
        steps.push(step);
    };
    const consumeLine = (line) => {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            return;
        }
        const message = entry?.message;
        const timestamp = typeof entry?.timestamp === 'string' ? entry.timestamp : undefined;
        if (message?.role === 'assistant' && Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === 'tool_use') {
                    const step = stepOf(part, timestamp);
                    if (step) {
                        pushStep(step);
                    }
                    lastToolUseId = typeof part.id === 'string' ? part.id : null;
                    lastToolResultSeen = false;
                    lastStepWasTool = true;
                }
                else if (part?.type === 'text' || part?.type === 'thinking') {
                    const step = stepOf(part, timestamp);
                    if (step) {
                        pushStep(step);
                    }
                    lastStepWasTool = false;
                }
            }
        }
        if (message?.role === 'user' && Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === 'tool_result'
                    && typeof part.tool_use_id === 'string'
                    && part.tool_use_id === lastToolUseId) {
                    lastToolResultSeen = true;
                }
            }
        }
    };
    if (stat.size > AGENT_TRANSCRIPT_WINDOW_BYTES) {
        const start = stat.size - AGENT_TRANSCRIPT_WINDOW_BYTES;
        const handle = await fsp.open(transcriptPath, 'r');
        try {
            const window = Buffer.alloc(AGENT_TRANSCRIPT_WINDOW_BYTES);
            await handle.read(window, 0, window.length, start);
            const lines = window.toString('utf8').split('\n');
            // Drop the (almost certainly partial) first line of the window.
            for (const line of lines.slice(1)) {
                consumeLine(line);
            }
        }
        finally {
            await handle.close();
        }
    }
    else {
        const rl = readline.createInterface({
            input: fs.createReadStream(transcriptPath),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            consumeLine(line);
        }
    }
    const last = steps[steps.length - 1] ?? null;
    return {
        steps,
        totalSteps: total,
        lastAt: last?.at ?? null,
        lastLabel: last?.label ?? '',
        endedMidToolCall: lastStepWasTool && !lastToolResultSeen,
    };
}

// Resolves where a subagent's transcript lives, using the same locator as the
// provider's P1 patch: <projectDir>/<providerSessionId>/subagents/agent-<id>.jsonl
// first, then the older sibling layout <projectDir>/agent-<id>.jsonl. The
// realpath of whatever is found must stay INSIDE the realpath of the project
// directory (rejects any symlink escape); the agentId regex already rules out
// path characters.
async function locateAgentTranscript(projectDir, providerSessionId, agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)
        || typeof projectDir !== 'string' || !projectDir) {
        return null;
    }
    const realProject = await fsp.realpath(projectDir).catch(() => null);
    if (!realProject) {
        return null;
    }
    const candidates = [];
    if (typeof providerSessionId === 'string' && providerSessionId) {
        candidates.push(path.join(projectDir, providerSessionId, 'subagents', `agent-${agentId}.jsonl`));
    }
    candidates.push(path.join(projectDir, `agent-${agentId}.jsonl`));
    for (const candidate of candidates) {
        const stat = await fsp.stat(candidate).catch(() => null);
        if (!stat?.isFile()) {
            continue;
        }
        const real = await fsp.realpath(candidate).catch(() => null);
        if (!real || !real.startsWith(realProject + path.sep)) {
            continue;
        }
        return { transcriptPath: real, metaPath: real.replace(/\.jsonl$/, '.meta.json') };
    }
    return null;
}

async function readAgentMeta(metaPath) {
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8').catch(() => 'null'));
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    return {
        agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
        description: typeof parsed.description === 'string' ? parsed.description : undefined,
        toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : undefined,
    };
}

// Binds a still-running synchronous Agent call (no tool_result row yet, hence
// no agentId in the parent JSONL) to its agentId via the toolUseId recorded in
// the sidecar meta files. Capped at MAX_META_SCAN meta reads.
async function scanAgentMetas(projectDir, providerSessionId) {
    const dirs = [];
    if (typeof providerSessionId === 'string' && providerSessionId) {
        dirs.push(path.join(projectDir, providerSessionId, 'subagents'));
    }
    dirs.push(projectDir);
    const found = new Map();
    for (const dir of dirs) {
        const names = await fsp.readdir(dir).catch(() => null);
        if (!Array.isArray(names)) {
            continue;
        }
        for (const name of names) {
            const match = /^agent-(a[0-9a-f]{8,24})\.meta\.json$/.exec(name);
            if (!match) {
                continue;
            }
            if (found.size >= MAX_META_SCAN) {
                return found;
            }
            const meta = await readAgentMeta(path.join(dir, name));
            if (meta) {
                found.set(match[1], { agentId: match[1], ...meta });
            }
        }
    }
    return found;
}

function agentStatus(launch, notification, parsed, mtimeMs, nowMs, env) {
    if (notification) {
        return notification.status === 'completed' ? 'completed' : 'failed';
    }
    // A sync launch row IS the agent's final result: it exists only once done.
    if (launch.isAsync !== true) {
        return 'completed';
    }
    if (!parsed) {
        return 'running';
    }
    if (parsed.endedMidToolCall) {
        return 'running';
    }
    return nowMs - mtimeMs < subagentLiveWindowMs(env) ? 'running' : 'completed';
}

async function buildAgents(scan, projectDir, providerSessionId, nowMs, env) {
    const agents = [];
    for (const launch of scan.agentLaunches.values()) {
        const toolUse = launch.toolUseId ? scan.toolUses.get(launch.toolUseId) : undefined;
        const notification = launch.toolUseId ? scan.agentNotifications.get(launch.toolUseId) : undefined;
        const located = await locateAgentTranscript(projectDir, providerSessionId, launch.agentId);
        let meta = null;
        let parsed = null;
        let mtimeMs = 0;
        if (located) {
            meta = await readAgentMeta(located.metaPath);
            const stat = await fsp.stat(located.transcriptPath).catch(() => null);
            mtimeMs = stat?.mtimeMs ?? 0;
            parsed = await parseAgentTranscript(located.transcriptPath);
        }
        const startedAt = toolUse?.timestamp ?? launch.rowTimestamp ?? null;
        agents.push({
            id: launch.agentId,
            agentType: meta?.agentType ?? toolUse?.subagentType ?? '',
            description: launch.description || meta?.description || toolUse?.description || '',
            status: agentStatus(launch, notification, parsed, mtimeMs, nowMs, env),
            startedAt,
            lastActivityAt: parsed?.lastAt
                ?? (mtimeMs > 0 ? new Date(mtimeMs).toISOString() : startedAt),
            steps: parsed?.totalSteps ?? 0,
            currentStep: parsed?.lastLabel ?? '',
        });
    }
    // Synchronous Agent calls that have not resolved yet: their agentId lives
    // only in the subagent meta sidecar, keyed by the pending tool_use id.
    const launchedToolUseIds = new Set([...scan.agentLaunches.values()]
        .map((launch) => launch.toolUseId)
        .filter(Boolean));
    const pending = [...scan.toolUses.values()].filter((toolUse) => AGENT_TOOL_NAMES.has(toolUse.name)
        && !scan.toolResultIds.has(toolUse.id)
        && !launchedToolUseIds.has(toolUse.id));
    if (pending.length > 0) {
        const metas = await scanAgentMetas(projectDir, providerSessionId);
        const byToolUseId = new Map([...metas.values()]
            .filter((meta) => typeof meta.toolUseId === 'string')
            .map((meta) => [meta.toolUseId, meta]));
        for (const toolUse of pending) {
            const meta = byToolUseId.get(toolUse.id);
            if (!meta) {
                // Cannot bind this pending call to an agentId; it appears once
                // its result row lands. Disclosed limitation.
                continue;
            }
            const located = await locateAgentTranscript(projectDir, providerSessionId, meta.agentId);
            const parsed = located ? await parseAgentTranscript(located.transcriptPath) : null;
            agents.push({
                id: meta.agentId,
                agentType: meta.agentType ?? toolUse.subagentType ?? '',
                description: meta.description ?? toolUse.description ?? '',
                status: 'running',
                startedAt: toolUse.timestamp ?? null,
                lastActivityAt: parsed?.lastAt ?? toolUse.timestamp ?? null,
                steps: parsed?.totalSteps ?? 0,
                currentStep: parsed?.lastLabel ?? '',
            });
        }
    }
    agents.sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
    return agents.slice(0, MAX_AGENTS);
}

// True agent membership in the session: either a launch row names the agent,
// or a pending synchronous call's meta sidecar binds it (the sidecar's
// toolUseId must be one of this session's still-open Agent calls, so an
// old-layout project-wide meta cannot vouch for a foreign session).
async function sessionReferencesAgent(scan, projectDir, providerSessionId, agentId) {
    if (scan.agentLaunches.has(agentId)) {
        return true;
    }
    const launchedToolUseIds = new Set([...scan.agentLaunches.values()]
        .map((launch) => launch.toolUseId)
        .filter(Boolean));
    const pending = [...scan.toolUses.values()].filter((toolUse) => AGENT_TOOL_NAMES.has(toolUse.name)
        && !scan.toolResultIds.has(toolUse.id)
        && !launchedToolUseIds.has(toolUse.id));
    if (pending.length === 0) {
        return false;
    }
    const pendingIds = new Set(pending.map((toolUse) => toolUse.id));
    const metas = await scanAgentMetas(projectDir, providerSessionId);
    for (const meta of metas.values()) {
        if (meta.agentId === agentId && typeof meta.toolUseId === 'string' && pendingIds.has(meta.toolUseId)) {
            return true;
        }
    }
    return false;
}

async function readFirstSessionId(jsonlPath) {
    try {
        const rl = readline.createInterface({
            input: fs.createReadStream(jsonlPath),
            crlfDelay: Infinity,
        });
        let seen = 0;
        for await (const line of rl) {
            seen += 1;
            if (seen > 50) {
                break;
            }
            if (!line.trim()) {
                continue;
            }
            try {
                const row = JSON.parse(line);
                if (typeof row?.sessionId === 'string' && row.sessionId) {
                    return row.sessionId;
                }
            }
            catch {
                // Keep scanning.
            }
        }
    }
    catch {
        // Fall through to null.
    }
    return null;
}

async function resolveSessionContext(deps, sessionId) {
    let row = null;
    if (typeof deps?.getSession === 'function') {
        try {
            row = await deps.getSession(sessionId);
        }
        catch {
            row = null;
        }
    }
    const jsonlPath = row && typeof row.jsonl_path === 'string' && row.jsonl_path
        ? row.jsonl_path
        : await resolveSessionJsonl(deps, sessionId);
    if (!jsonlPath) {
        return null;
    }
    let providerSessionId = row && typeof row.provider_session_id === 'string' && row.provider_session_id
        ? row.provider_session_id
        : null;
    if (!providerSessionId) {
        providerSessionId = await readFirstSessionId(jsonlPath);
    }
    if (!providerSessionId && row && typeof row.session_id === 'string' && row.session_id) {
        providerSessionId = row.session_id;
    }
    return { jsonlPath, projectDir: path.dirname(jsonlPath), providerSessionId, row };
}

function parseLineCount(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_TAIL_LINES;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return parsed >= 1 && parsed <= MAX_TAIL_LINES ? parsed : null;
}

function parseStepCount(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_AGENT_STEPS;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return parsed >= 1 && parsed <= MAX_AGENT_STEPS ? parsed : null;
}

async function resolveSessionJsonl(deps, sessionId) {
    try {
        const resolved = await deps.resolveJsonlPath(sessionId);
        return typeof resolved === 'string' && resolved ? resolved : null;
    }
    catch {
        return null;
    }
}

export async function bgTasksListRequest({ sessionId }, deps) {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return { status: 400, body: { error: 'Invalid sessionId' } };
    }
    const context = await resolveSessionContext(deps, sessionId);
    if (!context) {
        return { status: 404, body: { error: 'Session not found' } };
    }
    try {
        const nowMs = nowOf(deps);
        const env = envOf(deps);
        // C6: GET / builds tasks[] through the same listBackgroundTasks path
        // everything else uses; the second scan below is a cache hit.
        const tasks = await listBackgroundTasks(context.jsonlPath);
        const scan = await cachedScanTranscript(context.jsonlPath);
        if (scan.streamError) {
            throw scan.streamError;
        }
        const agents = await buildAgents(scan, context.projectDir, context.providerSessionId, nowMs, env);
        const stat = await fsp.stat(context.jsonlPath).catch(() => null);
        const lastWriteAt = stat ? new Date(stat.mtimeMs).toISOString() : null;
        const mtimeFresh = stat ? nowMs - stat.mtimeMs < sessionLiveWindowMs(env) : false;
        const anyRunning = tasks.some((task) => task.status === 'running')
            || agents.some((agent) => agent.status === 'running');
        return {
            status: 200,
            body: {
                sessionWorking: mtimeFresh || anyRunning,
                lastWriteAt,
                tasks,
                agents,
            },
        };
    }
    catch {
        return { status: 500, body: { error: 'Failed to read session transcript' } };
    }
}

export async function bgTasksTailRequest({ taskId, sessionId, lines }, deps) {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return { status: 400, body: { error: 'Invalid sessionId' } };
    }
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
        return { status: 400, body: { error: 'Invalid taskId' } };
    }
    const lineCount = parseLineCount(lines);
    if (lineCount === null) {
        return { status: 400, body: { error: 'lines must be an integer between 1 and 200' } };
    }
    const context = await resolveSessionContext(deps, sessionId);
    if (!context) {
        return { status: 404, body: { error: 'Session not found' } };
    }
    try {
        const tail = await readTaskTail(context.jsonlPath, taskId, lineCount);
        if (!tail) {
            return { status: 404, body: { error: 'Task not found' } };
        }
        return { status: 200, body: tail };
    }
    catch {
        return { status: 500, body: { error: 'Failed to read task output' } };
    }
}

export async function bgTasksAgentTailRequest({ agentId, sessionId, steps }, deps) {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return { status: 400, body: { error: 'Invalid sessionId' } };
    }
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
        return { status: 400, body: { error: 'Invalid agentId' } };
    }
    const stepCount = parseStepCount(steps);
    if (stepCount === null) {
        return { status: 400, body: { error: 'steps must be an integer between 1 and 100' } };
    }
    const context = await resolveSessionContext(deps, sessionId);
    if (!context) {
        return { status: 404, body: { error: 'Session not found' } };
    }
    try {
        const scan = await cachedScanTranscript(context.jsonlPath);
        if (scan.streamError) {
            throw scan.streamError;
        }
        const referenced = await sessionReferencesAgent(scan, context.projectDir, context.providerSessionId, agentId);
        if (!referenced) {
            return { status: 404, body: { error: 'Agent not found' } };
        }
        const located = await locateAgentTranscript(context.projectDir, context.providerSessionId, agentId);
        if (!located) {
            return { status: 404, body: { error: 'Agent not found' } };
        }
        const parsed = await parseAgentTranscript(located.transcriptPath);
        if (!parsed) {
            return { status: 404, body: { error: 'Agent not found' } };
        }
        const selected = parsed.totalSteps > stepCount ? parsed.steps.slice(-stepCount) : parsed.steps;
        return {
            status: 200,
            body: {
                id: agentId,
                steps: selected,
                truncated: parsed.totalSteps > selected.length,
            },
        };
    }
    catch {
        return { status: 500, body: { error: 'Failed to read agent transcript' } };
    }
}

let activeCache = null;

// F2: a terminal session waiting on subagents writes nothing to its own
// JSONL; the session still counts as working while any transcript under
// <projectDir>/<session>/subagents/ is fresh. stat-only, capped, returns the
// freshest in-window subagent mtime (null when none qualifies).
async function freshestSubagentMtimeMs(jsonlPath, nowMs, windowMs) {
    const base = path.basename(jsonlPath).replace(/\.jsonl$/, '');
    if (!base) {
        return null;
    }
    const dir = path.join(path.dirname(jsonlPath), base, 'subagents');
    const names = await fsp.readdir(dir).catch(() => null);
    if (!Array.isArray(names)) {
        return null;
    }
    let freshest = null;
    let scanned = 0;
    for (const name of names) {
        if (!name.endsWith('.jsonl')) {
            continue;
        }
        if (scanned >= MAX_ACTIVE_SUBAGENTS) {
            break;
        }
        scanned += 1;
        const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
        if (stat && nowMs - stat.mtimeMs < windowMs && (freshest === null || stat.mtimeMs > freshest)) {
            freshest = stat.mtimeMs;
        }
    }
    return freshest;
}

export async function bgTasksActiveRequest(deps) {
    const nowMs = nowOf(deps);
    const ttl = typeof deps?.cacheTtlMs === 'number' && Number.isFinite(deps.cacheTtlMs)
        ? deps.cacheTtlMs
        : ACTIVE_CACHE_TTL_MS;
    if (ttl > 0 && activeCache && nowMs - activeCache.at < ttl) {
        return activeCache.result;
    }
    let rows;
    try {
        if (typeof deps?.listSessions !== 'function') {
            throw new Error('listSessions not provided');
        }
        rows = await deps.listSessions();
    }
    catch {
        return { status: 500, body: { error: 'Failed to list sessions' } };
    }
    const windowMs = sessionLiveWindowMs(envOf(deps));
    const sessions = [];
    if (Array.isArray(rows)) {
        let scanned = 0;
        for (const row of rows) {
            if (scanned >= MAX_ACTIVE_SCAN) {
                break;
            }
            if (!row || typeof row.sessionId !== 'string' || !row.sessionId
                || typeof row.jsonlPath !== 'string' || !row.jsonlPath) {
                continue;
            }
            scanned += 1;
            const stat = await fsp.stat(row.jsonlPath).catch(() => null);
            if (!stat) {
                continue;
            }
            let lastWriteMs = stat.mtimeMs;
            let working = nowMs - stat.mtimeMs < windowMs;
            if (!working) {
                const subagentMs = await freshestSubagentMtimeMs(row.jsonlPath, nowMs, subagentLiveWindowMs(envOf(deps)));
                if (subagentMs !== null) {
                    working = true;
                    lastWriteMs = Math.max(lastWriteMs, subagentMs);
                }
            }
            if (working) {
                sessions.push({
                    sessionId: row.sessionId,
                    working: true,
                    lastWriteAt: new Date(lastWriteMs).toISOString(),
                });
            }
        }
    }
    sessions.sort((a, b) => timeOf(b.lastWriteAt) - timeOf(a.lastWriteAt));
    const result = { status: 200, body: { sessions: sessions.slice(0, MAX_ACTIVE_SESSIONS) } };
    if (ttl > 0) {
        activeCache = { at: nowMs, result };
    }
    return result;
}
