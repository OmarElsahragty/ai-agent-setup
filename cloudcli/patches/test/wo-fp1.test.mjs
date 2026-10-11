// WO-FP1 fix-pass regressions: F1 notification sources (user turn + attachment
// queued_command) with the exit-code tail fallback, F2 /active subagent
// freshness, S6 (path,size,mtime) scan cache, C6 GET / reuse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    bgTasksActiveRequest,
    bgTasksListRequest,
    listBackgroundTasks,
} from '../files/bg-tasks.service.js';

const ROOT = '/var/tmp/claude';
const SID = '12345678-1234-5678-8123-456789abcdef';
const PSID = '11111111-2222-4333-8444-555555555555';
const AID = 'a1234567890abcdef';
const NOW = Date.parse('2026-10-07T09:00:00.000Z');
let dir;
let deps;
let jsonlPath;

before(async () => {
    dir = path.join(ROOT, `wo-fp1-${process.pid}-${Date.now()}`);
    await fsp.mkdir(path.join(dir, 'tasks'), { recursive: true });
});

after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
});

let seq = 0;
function tid(name) {
    seq += 1;
    return `${name}${String(seq).padStart(4, '0')}x`;
}

function outputPath(taskId) {
    return path.join(dir, 'tasks', `${taskId}.output`);
}

function toolUse(id, name, input, timestamp) {
    return {
        type: 'assistant',
        uuid: `a-${id}`,
        timestamp,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    };
}

function toolResult(id, text, toolUseResult, timestamp) {
    return {
        type: 'user',
        uuid: `u-${id}`,
        timestamp,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
        toolUseResult,
    };
}

function userText(text, timestamp) {
    return {
        type: 'user',
        uuid: 'n-fixed-uuid',
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text }] },
    };
}

// Real-shaped attachment row (copied structure from a pinned-bundle JSONL row
// of commandMode "task-notification"; payloads replaced with benign fixture
// text). The notification payload rides in attachment.prompt; older/alternate
// builds may use attachment.content (string or content-part array).
function attachmentRow(payload, timestamp) {
    return {
        parentUuid: '19fb2e03-b06f-450b-a005-fc88dcf86eb4',
        isSidechain: false,
        attachment: {
            type: 'queued_command',
            ...payload,
            source_uuid: '0b5b8e28-f6e5-4022-ae94-c5072ad803ea',
            delivery_id: '78072d0d-60d4-4115-b523-1d11156457b8',
            commandMode: 'task-notification',
            origin: { kind: 'task-notification', producer: 'session-task' },
            timestamp,
        },
        type: 'attachment',
        uuid: 'eb2afe54-3ce2-4a00-80d8-5793bfc69474',
        timestamp,
        sessionId: '185eca10-4453-489d-b6ba-63a4cfb15865',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/root',
        version: '2.1.291',
        gitBranch: 'HEAD',
        slug: 'fixture-task-notification',
    };
}

function taskNotificationPrompt(taskId, toolUseId, status, summary) {
    return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n`
        + `<output-file>/var/tmp/claude/claude-0/-root/185eca10-4453-489d-b6ba-63a4cfb15865/tasks/${taskId}.output</output-file>\n`
        + `<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
}

function launchRow(taskId, toolUseId, description, timestamp) {
    return [
        toolUse(toolUseId, 'Bash', { command: 'sleep 60', description, run_in_background: true }, timestamp),
        toolResult(toolUseId,
            `Command running in background with PID 42\n\nOutput is being written to: ${outputPath(taskId)}.`,
            { backgroundTaskId: taskId },
            timestamp),
    ];
}

async function writeTranscript(rows) {
    jsonlPath = path.join(dir, `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);
    await fsp.writeFile(jsonlPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    deps = { resolveJsonlPath: async (sessionId) => (sessionId === SID ? jsonlPath : null) };
    return jsonlPath;
}

// ---------------------------------------------------------------------------
// F1: notification delivered as a queued_command attachment
// ---------------------------------------------------------------------------

test('F1: notification in an attachment row (prompt string) completes the task', async () => {
    const task = tid('att');
    await writeTranscript([
        ...launchRow(task, 'tu-f1-1', 'watchdog timer', '2026-10-07T08:00:00.000Z'),
        attachmentRow(
            { prompt: taskNotificationPrompt(task, 'toolu_01Fixture0000000000000000fix', 'completed', 'Background command "watchdog" completed (exit code 0)') },
            '2026-10-07T08:05:00.000Z',
        ),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks[0].status, 'completed');
    assert.equal(result.body.tasks[0].endedAt, '2026-10-07T08:05:00.000Z');
});

test('F1: attachment with content array (message-part shape) is parsed too', async () => {
    const task = tid('atc');
    await writeTranscript([
        ...launchRow(task, 'tu-f1-2', 'array carrier', '2026-10-07T08:10:00.000Z'),
        attachmentRow(
            { content: [{ type: 'text', text: taskNotificationPrompt(task, 'toolu_01Fixture0000000000000000fx2', 'failed', 'Background command "boom" failed (exit code 3)') }] },
            '2026-10-07T08:11:00.000Z',
        ),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'failed');
    assert.equal(result.body.tasks[0].endedAt, '2026-10-07T08:11:00.000Z');
});

test('F1: attachment with content string is parsed too', async () => {
    const task = tid('ats');
    await writeTranscript([
        ...launchRow(task, 'tu-f1-3', 'string carrier', '2026-10-07T08:15:00.000Z'),
        attachmentRow(
            { content: taskNotificationPrompt(task, 'toolu_01Fixture0000000000000000fx3', 'completed', 'done') },
            '2026-10-07T08:16:00.000Z',
        ),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'completed');
});

test('F1: non-queued_command attachments are ignored', async () => {
    const task = tid('ign');
    await writeTranscript([
        ...launchRow(task, 'tu-f1-4', 'not a notification', '2026-10-07T08:20:00.000Z'),
        attachmentRow(
            { prompt: `<task-notification>\n<task-id>${task}</task-id>\n<status>failed</status>\n</task-notification>` },
            '2026-10-07T08:21:00.000Z',
        ),
        // Real shape of a human queued prompt: same attachment type, no tags.
        attachmentRow({ prompt: 'please continue with the next step' }, '2026-10-07T08:22:00.000Z'),
        // Same tags but a different attachment.type: must NOT flip the status.
        {
            ...attachmentRow({ prompt: 'x' }, '2026-10-07T08:23:00.000Z'),
            attachment: {
                type: 'pasted_text',
                prompt: `<task-notification><task-id>${task}</task-id><status>completed</status></task-notification>`,
            },
        },
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'failed');
    assert.equal(result.body.tasks[0].endedAt, '2026-10-07T08:21:00.000Z');
});

test('F1: attachment notification also drives agents[] status', async () => {
    const proj = path.join(dir, 'f1-agents');
    await fsp.mkdir(proj, { recursive: true });
    const tu = 'tu-f1-ag1';
    const jsonl = path.join(proj, 'parent.jsonl');
    const rows = [
        toolUse(tu, 'Agent', { description: 'async job', subagent_type: 'implementer', run_in_background: true }, '2026-10-07T08:30:00.000Z'),
        toolResult(tu, 'launched', { agentId: AID, isAsync: true, description: 'async job' }, '2026-10-07T08:30:01.000Z'),
        attachmentRow(
            { prompt: taskNotificationPrompt('ignored0', tu, 'error', 'agent errored') },
            '2026-10-07T08:35:00.000Z',
        ),
    ];
    await fsp.writeFile(jsonl, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const agentDeps = {
        getSession: async (sessionId) => (sessionId === SID
            ? { session_id: SID, provider_session_id: PSID, jsonl_path: jsonl }
            : null),
        resolveJsonlPath: async (sessionId) => (sessionId === SID ? jsonl : null),
        now: () => NOW,
        env: {},
    };
    const result = await bgTasksListRequest({ sessionId: SID }, agentDeps);
    assert.equal(result.status, 200);
    assert.equal(result.body.agents.length, 1);
    assert.equal(result.body.agents[0].status, 'failed');
});

// ---------------------------------------------------------------------------
// F1 fallback: output tail "[exited with code N]"
// ---------------------------------------------------------------------------

test('F1 fallback: exit code 0 tail => completed, nonzero => failed, endedAt = output mtime', async () => {
    const ok = tid('ok0');
    const bad = tid('bad2');
    const okAt = NOW - 30_000;
    for (const [task, tail, mtime] of [
        [ok, 'step one\nstep two\n\n[exited with code 0]\n', okAt],
        [bad, '\u001b[31merror noise\u001b[0m\n\n[exited with code 2]\n', NOW - 25_000],
    ]) {
        await fsp.writeFile(outputPath(task), tail);
        await fsp.utimes(outputPath(task), new Date(mtime), new Date(mtime));
    }
    await writeTranscript([
        ...launchRow(ok, 'tu-f1-5', 'clean exit', '2026-10-07T08:40:00.000Z'),
        ...launchRow(bad, 'tu-f1-6', 'dirty exit', '2026-10-07T08:41:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    const byId = new Map(result.body.tasks.map((task) => [task.id, task]));
    assert.equal(byId.get(ok).status, 'completed');
    assert.equal(byId.get(ok).endedAt, new Date(okAt).toISOString());
    assert.equal(byId.get(bad).status, 'failed');
    assert.equal(byId.get(bad).endedAt, new Date(NOW - 25_000).toISOString());
});

test('F1 fallback: exit line found when the tail is byte-windowed past 4 KB', async () => {
    const task = tid('win');
    await fsp.writeFile(outputPath(task), `${'x'.repeat(6000)}\n[exited with code 1]\n`);
    await writeTranscript(launchRow(task, 'tu-f1-7', 'long output', '2026-10-07T08:45:00.000Z'));
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'failed');
});

test('F1 fallback: an exit line NOT at the end keeps the task running', async () => {
    const task = tid('mid');
    await fsp.writeFile(outputPath(task), 'echo start\n[exited with code 0]\nstill streaming output\n');
    await writeTranscript(launchRow(task, 'tu-f1-8', 'echoed exit', '2026-10-07T08:50:00.000Z'));
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'running');
});

test('F1: an explicit notification beats the tail fallback', async () => {
    const task = tid('pri');
    await fsp.writeFile(outputPath(task), '\n[exited with code 0]\n');
    await writeTranscript([
        ...launchRow(task, 'tu-f1-9', 'priority', '2026-10-07T08:55:00.000Z'),
        userText(`<task-notification>\n  <task-id>${task}</task-id>\n  <status>killed</status>\n</task-notification>`, '2026-10-07T08:56:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'killed');
    assert.equal(result.body.tasks[0].endedAt, '2026-10-07T08:56:00.000Z');
});

// ---------------------------------------------------------------------------
// F2: /active subagent freshness
// ---------------------------------------------------------------------------

async function activeProject(name, { jsonlMtime, subagentMtimes = [] }) {
    const proj = path.join(dir, name);
    const jsonl = path.join(proj, 'sess-1.jsonl');
    await fsp.mkdir(path.join(proj, 'sess-1', 'subagents'), { recursive: true });
    await fsp.writeFile(jsonl, '{}\n');
    await fsp.utimes(jsonl, new Date(jsonlMtime), new Date(jsonlMtime));
    for (const [index, mtime] of subagentMtimes.entries()) {
        const file = path.join(proj, 'sess-1', 'subagents', `agent-a${String(index).padStart(16, '0')}.jsonl`);
        await fsp.writeFile(file, '{}\n');
        await fsp.utimes(file, new Date(mtime), new Date(mtime));
    }
    return jsonl;
}

test('F2: stale JSONL with a fresh subagents/*.jsonl counts as working', async () => {
    const jsonl = await activeProject('f2-fresh', {
        jsonlMtime: NOW - 60_000,
        subagentMtimes: [NOW - 5_000, NOW - 50_000],
    });
    const result = await bgTasksActiveRequest({
        listSessions: async () => [{ sessionId: 'sid-1', jsonlPath: jsonl }],
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.sessions, [
        { sessionId: 'sid-1', working: true, lastWriteAt: new Date(NOW - 5_000).toISOString() },
    ]);
});

test('F2: everything stale => absent; fresh JSONL works without a subagents dir', async () => {
    const stale = await activeProject('f2-stale', {
        jsonlMtime: NOW - 60_000,
        subagentMtimes: [NOW - 700_000],
    });
    const absent = await bgTasksActiveRequest({
        listSessions: async () => [{ sessionId: 'sid-s', jsonlPath: stale }],
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    });
    assert.deepEqual(absent.body, { sessions: [] });

    const freshOnly = path.join(dir, 'f2-fresh-only', 'sess-2.jsonl');
    await fsp.mkdir(path.dirname(freshOnly), { recursive: true });
    await fsp.writeFile(freshOnly, '{}\n');
    await fsp.utimes(freshOnly, new Date(NOW - 1_000), new Date(NOW - 1_000));
    const present = await bgTasksActiveRequest({
        listSessions: async () => [{ sessionId: 'sid-f', jsonlPath: freshOnly }],
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    });
    assert.deepEqual(present.body.sessions.map((s) => s.sessionId), ['sid-f']);
});

test('F2: CLOUDCLI_SUBAGENT_LIVE_MS overrides the subagent window', async () => {
    const jsonl = await activeProject('f2-window', {
        jsonlMtime: NOW - 60_000,
        subagentMtimes: [NOW - 5_000],
    });
    const base = {
        listSessions: async () => [{ sessionId: 'sid-w', jsonlPath: jsonl }],
        now: () => NOW,
        cacheTtlMs: 0,
    };
    const tight = await bgTasksActiveRequest({ ...base, env: { CLOUDCLI_SUBAGENT_LIVE_MS: '1000' } });
    assert.deepEqual(tight.body, { sessions: [] });
    await activeProject('f2-window', {
        jsonlMtime: NOW - 60_000,
        subagentMtimes: [NOW - 500],
    });
    const loose = await bgTasksActiveRequest({ ...base, env: { CLOUDCLI_SUBAGENT_LIVE_MS: '1000' } });
    assert.deepEqual(loose.body.sessions.map((s) => s.sessionId), ['sid-w']);
});

// ---------------------------------------------------------------------------
// S6: scan cache keyed by (path, size, mtime)
// ---------------------------------------------------------------------------

function fitLine(makeRow, target) {
    let pad = 0;
    let line = JSON.stringify(makeRow(pad));
    let guard = 0;
    while (Buffer.byteLength(line) !== target && guard < 4) {
        pad = Math.max(0, pad + (target - Buffer.byteLength(line)));
        line = JSON.stringify(makeRow(pad));
        guard += 1;
    }
    assert.equal(Buffer.byteLength(line), target, 'fitLine could not reach the exact byte length');
    return line;
}

test('S6: same size+mtime reuses the cached scan; an mtime bump invalidates it', async () => {
    const task = tid('cch');
    const launchBlock = launchRow(task, 'tu-s6-1', 'cache job', '2026-10-07T09:10:00.000Z')
        .map((row) => JSON.stringify(row)).join('\n');
    const TARGET = 480;
    const filler = fitLine((pad) => userText(`filler ${'.'.repeat(pad)}`, '2026-10-07T09:10:02.000Z'), TARGET);
    const notif = fitLine((pad) => userText(
        `<task-notification>\n  <task-id>${task}</task-id>\n  <status>completed</status>\n  <pad>${'.'.repeat(pad)}</pad>\n</task-notification>`,
        '2026-10-07T09:10:03.000Z',
    ), TARGET);
    const MTIME = NOW - 10_000;

    await writeTranscript([]);
    await fsp.writeFile(jsonlPath, `${launchBlock}\n${filler}\n`);
    await fsp.utimes(jsonlPath, new Date(MTIME), new Date(MTIME));
    const first = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(first.body.tasks[0].status, 'running');

    // Same byte size, same mtime, different content: the cached scan must be
    // served without rescanning (the documented cache contract).
    await fsp.writeFile(jsonlPath, `${launchBlock}\n${notif}\n`);
    await fsp.utimes(jsonlPath, new Date(MTIME), new Date(MTIME));
    const cached = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(cached.body.tasks[0].status, 'running');

    // Touching the mtime invalidates and picks up the notification.
    await fsp.utimes(jsonlPath, new Date(MTIME + 4), new Date(MTIME + 4));
    const refreshed = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(refreshed.body.tasks[0].status, 'completed');
});

// ---------------------------------------------------------------------------
// C6: GET / reuses listBackgroundTasks
// ---------------------------------------------------------------------------

test('C6: GET / tasks deep-equal listBackgroundTasks on the same transcript', async () => {
    const running = tid('c6r');
    const silent = tid('c6d');
    await fsp.writeFile(outputPath(running), 'still streaming\n');
    await fsp.writeFile(outputPath(silent), 'log line\n\n[exited with code 0]\n');
    await fsp.utimes(outputPath(silent), new Date(NOW - 15_000), new Date(NOW - 15_000));
    await writeTranscript([
        ...launchRow(silent, 'tu-c6-1', 'silent finisher', '2026-10-07T09:20:00.000Z'),
        ...launchRow(running, 'tu-c6-2', 'chatty runner', '2026-10-07T09:21:00.000Z'),
    ]);
    const direct = await listBackgroundTasks(jsonlPath);
    const viaApi = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(viaApi.status, 200);
    assert.deepEqual(viaApi.body.tasks, direct);
    assert.deepEqual([...viaApi.body.tasks.map((t) => t.status)].sort(), ['completed', 'running']);
});
