// WO-E1 P2: /api/bg-tasks service contract, parsing, and security negatives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bgTasksListRequest, bgTasksTailRequest, stripAnsi } from '../files/bg-tasks.service.js';

const ROOT = '/var/tmp/claude';
const SID = '12345678-1234-5678-8123-456789abcdef';
let dir;
let deps;
let jsonlPath;

before(async () => {
    dir = path.join(ROOT, `wo-e1-p2-${process.pid}-${Date.now()}`);
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
        uuid: `n-${Math.random()}`,
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text }] },
    };
}

function notification(taskId, status, timestamp) {
    return userText(`<task-notification>\n  <task-id>${taskId}</task-id>\n  <status>${status}</status>\n</task-notification>`, timestamp);
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

test('P2 list: happy path with running and completed tasks, newest first', async () => {
    const running = tid('bash');
    const done = tid('bash');
    await fsp.writeFile(outputPath(running), 'x'.repeat(12));
    await fsp.writeFile(outputPath(done), 'y'.repeat(7));
    await writeTranscript([
        ...launchRow(done, 'tu-1', 'build widgets', '2026-10-06T10:00:00.000Z'),
        notification(done, 'completed', '2026-10-06T10:05:00.000Z'),
        ...launchRow(running, 'tu-2', 'run tests', '2026-10-06T11:00:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    // P4 (WO-G1) extended the body; key order is part of the frozen contract.
    assert.deepEqual(Object.keys(result.body), ['sessionWorking', 'lastWriteAt', 'tasks', 'agents']);
    assert.equal(result.body.tasks.length, 2);
    assert.deepEqual(result.body.tasks[0], {
        id: running,
        description: 'run tests',
        status: 'running',
        startedAt: '2026-10-06T11:00:00.000Z',
        endedAt: null,
        outputBytes: 12,
    });
    assert.deepEqual(result.body.tasks[1], {
        id: done,
        description: 'build widgets',
        status: 'completed',
        startedAt: '2026-10-06T10:00:00.000Z',
        endedAt: '2026-10-06T10:05:00.000Z',
        outputBytes: 7,
    });
});

test('P2 list: last notification wins for status and endedAt', async () => {
    const task = tid('bash');
    await writeTranscript([
        ...launchRow(task, 'tu-3', 'flaky job', '2026-10-06T12:00:00.000Z'),
        notification(task, 'failed', '2026-10-06T12:01:00.000Z'),
        notification(task, 'completed', '2026-10-06T12:02:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks[0].status, 'completed');
    assert.equal(result.body.tasks[0].endedAt, '2026-10-06T12:02:00.000Z');
});

test('P2 list: unknown notification status maps to failed', async () => {
    const task = tid('bash');
    await writeTranscript([
        ...launchRow(task, 'tu-4', 'odd job', '2026-10-06T12:30:00.000Z'),
        notification(task, 'zombie', '2026-10-06T12:31:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'failed');
});

test('P2 list: non-Bash launches (async agents) are excluded', async () => {
    const bashTask = tid('bash');
    const agentTask = tid('task');
    await writeTranscript([
        toolUse('tu-5', 'Task', { description: 'research thing', subagent_type: 'research' }, '2026-10-06T13:00:00.000Z'),
        toolResult('tu-5', 'agent launched', { backgroundTaskId: agentTask }, '2026-10-06T13:00:01.000Z'),
        ...launchRow(bashTask, 'tu-6', 'plain bash', '2026-10-06T13:01:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.tasks.map((task) => task.id), [bashTask]);
});

test('P2 list: capped at 50 newest tasks', async () => {
    const rows = [];
    for (let i = 0; i < 55; i += 1) {
        rows.push(...launchRow(tid('cap'), `tu-cap-${i}`, `job ${i}`, new Date(Date.parse('2026-10-06T14:00:00.000Z') + i * 1000).toISOString()));
    }
    await writeTranscript(rows);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks.length, 50);
    assert.equal(result.body.tasks[0].description, 'job 54');
    assert.equal(result.body.tasks[49].description, 'job 5');
});

test('P2 list: notification delivered as plain string user content is parsed', async () => {
    const task = tid('str');
    await writeTranscript([
        ...launchRow(task, 'tu-7', 'string notify', '2026-10-06T15:00:00.000Z'),
        {
            type: 'user',
            uuid: 'n-str',
            timestamp: '2026-10-06T15:01:00.000Z',
            message: { role: 'user', content: `<task-notification><task-id>${task}</task-id><status>failed</status></task-notification>` },
        },
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'failed');
});

test('P2 list negatives: bad UUID, traversal, array query value, unknown session', async () => {
    await writeTranscript([]);
    for (const badSession of ['not-a-uuid', '../../etc/passwd', '', 42, ['x']]) {
        const result = await bgTasksListRequest({ sessionId: badSession }, deps);
        assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(badSession)}`);
        assert.deepEqual(Object.keys(result.body), ['error']);
    }
    const unknown = await bgTasksListRequest({ sessionId: '00000000-0000-4000-8000-000000000000' }, deps);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'Session not found' });
});

test('P2 tail: returns the last N lines, strips ANSI, reports truncation', async () => {
    const task = tid('tail');
    const lines = [];
    for (let i = 1; i <= 45; i += 1) {
        lines.push(i === 45 ? `\u001b[31mline-${String(i).padStart(3, '0')}\u001b[0m` : `line-${String(i).padStart(3, '0')}`);
    }
    await fsp.writeFile(outputPath(task), lines.join('\n') + '\n');
    await writeTranscript(launchRow(task, 'tu-tail-1', 'tailed job', '2026-10-06T16:00:00.000Z'));

    const defaulted = await bgTasksTailRequest({ taskId: task, sessionId: SID }, deps);
    assert.equal(defaulted.status, 200);
    assert.deepEqual(Object.keys(defaulted.body), ['id', 'text', 'truncated']);
    assert.equal(defaulted.body.id, task);
    assert.equal(defaulted.body.text.split('\n').length, 40);
    assert.equal(defaulted.body.truncated, true);
    assert.match(defaulted.body.text.split('\n')[39], /^line-045$/);

    const short = await bgTasksTailRequest({ taskId: task, sessionId: SID, lines: '2' }, deps);
    assert.equal(short.body.text, 'line-044\nline-045');
    assert.equal(short.body.truncated, true);

    const all = await bgTasksTailRequest({ taskId: task, sessionId: SID, lines: '200' }, deps);
    assert.equal(all.body.text.split('\n').length, 45);
    assert.equal(all.body.truncated, false);
});

test('P2 tail negatives: bad taskId, bad lines, unknown task, unknown session', async () => {
    const task = tid('neg');
    await fsp.writeFile(outputPath(task), 'ok\n');
    await writeTranscript(launchRow(task, 'tu-neg-1', 'neg job', '2026-10-06T16:30:00.000Z'));

    for (const badTask of ['BADUPPER', '../escape', 'abc', 'abcdefghijklmnopq', 'has-dash', '']) {
        const result = await bgTasksTailRequest({ taskId: badTask, sessionId: SID, lines: '10' }, deps);
        assert.equal(result.status, 400, `expected 400 for taskId ${JSON.stringify(badTask)}`);
    }
    for (const badLines of ['0', '201', 'abc', '-1', '1.5']) {
        const result = await bgTasksTailRequest({ taskId: task, sessionId: SID, lines: badLines }, deps);
        assert.equal(result.status, 400, `expected 400 for lines ${badLines}`);
    }
    const unknownTask = await bgTasksTailRequest({ taskId: 'zzzz9999x', sessionId: SID }, deps);
    assert.equal(unknownTask.status, 404);
    assert.deepEqual(unknownTask.body, { error: 'Task not found' });
    const unknownSession = await bgTasksTailRequest({ taskId: task, sessionId: '00000000-0000-4000-8000-000000000000' }, deps);
    assert.equal(unknownSession.status, 404);
    const badSession = await bgTasksTailRequest({ taskId: task, sessionId: '%2e%2e%2f' }, deps);
    assert.equal(badSession.status, 400);
});

test('P2 security: symlinked output file escapes are rejected', async () => {
    const task = tid('sym');
    await fsp.symlink('/etc/passwd', outputPath(task));
    await writeTranscript(launchRow(task, 'tu-sym-1', 'symlink job', '2026-10-06T17:00:00.000Z'));
    const list = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(list.status, 200);
    assert.equal(list.body.tasks[0].outputBytes, 0);
    const tail = await bgTasksTailRequest({ taskId: task, sessionId: SID }, deps);
    assert.equal(tail.status, 404);
    assert.deepEqual(tail.body, { error: 'Task not found' });
});

test('P2 security: output path outside /var/tmp/claude is ignored', async () => {
    const task = tid('out');
    const outside = '/var/tmp/claude-evil-tasks/tasks/x.output'.replace('x', task);
    await writeTranscript([
        toolUse(`tu-out-1`, 'Bash', { command: 'x', description: 'evil path', run_in_background: true }, '2026-10-06T17:10:00.000Z'),
        toolResult('tu-out-1', `Output is being written to: ${outside}`, { backgroundTaskId: task }, '2026-10-06T17:10:01.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks[0].outputBytes, 0);
    const tail = await bgTasksTailRequest({ taskId: task, sessionId: SID }, deps);
    assert.equal(tail.status, 404);
});

test('P2 security: transcript path suffix that does not match the taskId is ignored', async () => {
    const task = tid('mm');
    const mismatch = outputPath(tid('other'));
    await writeTranscript([
        toolUse('tu-mm-1', 'Bash', { command: 'x', description: 'mismatch', run_in_background: true }, '2026-10-06T17:20:00.000Z'),
        toolResult('tu-mm-1', `Output is being written to: ${mismatch}`, { backgroundTaskId: task }, '2026-10-06T17:20:01.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks[0].outputBytes, 0);
});

test('P2 tail: output larger than 64 KB is windowed and never returns partial lines', async () => {
    const task = tid('big');
    const lines = [];
    for (let i = 1; i <= 8000; i += 1) {
        lines.push(`line${String(i).padStart(4, '0')}`);
    }
    await fsp.writeFile(outputPath(task), lines.join('\n') + '\n');
    await writeTranscript(launchRow(task, 'tu-big-1', 'big job', '2026-10-06T18:00:00.000Z'));
    const result = await bgTasksTailRequest({ taskId: task, sessionId: SID, lines: '200' }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.truncated, true);
    const returned = result.body.text.split('\n');
    assert.equal(returned.length, 200);
    for (const line of returned) {
        assert.match(line, /^line\d{4}$/, 'no partial first line may leak');
    }
    assert.equal(returned[returned.length - 1], 'line8000');
    assert.ok(Buffer.byteLength(result.body.text) <= 64 * 1024);
});

test('P2 tail: deleted output file returns 404 while list keeps the task', async () => {
    const task = tid('gone');
    await writeTranscript(launchRow(task, 'tu-gone-1', 'gone job', '2026-10-06T18:10:00.000Z'));
    const list = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(list.body.tasks[0].status, 'running');
    assert.equal(list.body.tasks[0].outputBytes, 0);
    const tail = await bgTasksTailRequest({ taskId: task, sessionId: SID }, deps);
    assert.equal(tail.status, 404);
});

test('P2 helper: stripAnsi removes color escapes', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain \u001b[2Ktext\u001b[1G'), 'red plain text');
});
