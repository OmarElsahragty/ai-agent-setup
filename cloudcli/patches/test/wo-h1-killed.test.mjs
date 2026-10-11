// WO-H1: a background task whose shell was killed with the CLI process (output
// tail "[killed]", no <task-notification>) must not stay "running" forever and
// pin sessionWorking; a "stopped" notification reads as killed, not failed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bgTasksListRequest } from '../files/bg-tasks.service.js';

const ROOT = '/var/tmp/claude';
const SID = '12345678-1234-5678-8123-456789abcdef';
let dir;
let deps;

before(async () => {
    dir = path.join(ROOT, `wo-h1-${process.pid}-${Date.now()}`);
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

function launchRow(taskId, toolUseId, timestamp) {
    return [
        {
            type: 'assistant',
            uuid: `a-${toolUseId}`,
            timestamp,
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 2700', run_in_background: true } }],
            },
        },
        {
            type: 'user',
            uuid: `u-${toolUseId}`,
            timestamp,
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath(taskId)}`,
                }],
            },
            toolUseResult: { backgroundTaskId: taskId },
        },
    ];
}

async function writeTranscript(rows) {
    const jsonlPath = path.join(dir, `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);
    await fsp.writeFile(jsonlPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await fsp.utimes(jsonlPath, stale, stale);
    deps = { resolveJsonlPath: async (sessionId) => (sessionId === SID ? jsonlPath : null) };
}

test('H1: "[killed]" tail with no notification => killed, session not working', async () => {
    const task = tid('kil');
    const killedAt = Date.now() - 45 * 60 * 1000;
    await fsp.writeFile(outputPath(task), '\n[killed]\n');
    await fsp.utimes(outputPath(task), new Date(killedAt), new Date(killedAt));
    await writeTranscript(launchRow(task, 'tu-h1-1', '2026-10-07T11:30:14.376Z'));
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks[0].status, 'killed');
    assert.equal(result.body.tasks[0].endedAt, new Date(killedAt).toISOString());
    assert.equal(result.body.sessionWorking, false);
});

test('H1 negative control: empty output (shell still open) stays running and keeps the session working', async () => {
    const task = tid('live');
    await fsp.writeFile(outputPath(task), '');
    await writeTranscript(launchRow(task, 'tu-h1-2', '2026-10-07T11:31:20.022Z'));
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'running');
    assert.equal(result.body.sessionWorking, true);
});

test('H1: "[killed]" echoed mid-output (not the tail) keeps the task running', async () => {
    const task = tid('echo');
    await fsp.writeFile(outputPath(task), 'grep result: [killed]\nstill streaming\n');
    await writeTranscript(launchRow(task, 'tu-h1-3', '2026-10-07T11:32:00.000Z'));
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.body.tasks[0].status, 'running');
});

test('H1: a "stopped" notification reads as killed, unknown statuses still fail closed', async () => {
    const stopped = tid('stop');
    const odd = tid('odd');
    await fsp.writeFile(outputPath(stopped), '');
    await fsp.writeFile(outputPath(odd), '');
    const note = (taskId, status, timestamp) => ({
        type: 'user',
        uuid: `n-${taskId}`,
        timestamp,
        message: {
            role: 'user',
            content: [{ type: 'text', text: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>` }],
        },
    });
    await writeTranscript([
        ...launchRow(stopped, 'tu-h1-4', '2026-10-07T12:00:00.000Z'),
        ...launchRow(odd, 'tu-h1-5', '2026-10-07T12:01:00.000Z'),
        note(stopped, 'stopped', '2026-10-07T12:26:50.000Z'),
        note(odd, 'exploded', '2026-10-07T12:27:00.000Z'),
    ]);
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    const byId = new Map(result.body.tasks.map((task) => [task.id, task]));
    assert.equal(byId.get(stopped).status, 'killed');
    assert.equal(byId.get(odd).status, 'failed');
    assert.equal(result.body.sessionWorking, false);
});
