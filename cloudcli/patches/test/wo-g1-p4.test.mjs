// WO-G1 P4: /api/bg-tasks agents[], sessionWorking, agent tail, /active.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    bgTasksActiveRequest,
    bgTasksAgentTailRequest,
    bgTasksListRequest,
} from '../files/bg-tasks.service.js';

const SID = '12345678-1234-5678-8123-456789abcdef';
const PSID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-10-06T20:00:00.000Z');
const ROOT = `/var/tmp/claude/wo-g1-p4-${process.pid}-${Date.now()}`;
const AID1 = 'a1234567890abcdef';
const AID2 = 'a0fedcba987654321';
const AID3 = 'a00000000000000aa';

before(async () => {
    await fsp.mkdir(ROOT, { recursive: true });
});

after(async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
});

let seq = 0;
function tid() {
    seq += 1;
    return `tu${String(seq).padStart(4, '0')}`;
}

async function newProject(name) {
    const dir = path.join(ROOT, name);
    await fsp.mkdir(path.join(dir, PSID, 'subagents'), { recursive: true });
    return dir;
}

function useRow(id, name, input, timestamp) {
    return {
        type: 'assistant',
        uuid: `a-${id}`,
        timestamp,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    };
}

function resultRow(toolUseId, text, toolUseResult, timestamp) {
    return {
        type: 'user',
        uuid: `u-${toolUseId}`,
        timestamp,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
        toolUseResult,
    };
}

function textRow(text, timestamp) {
    return {
        type: 'user',
        uuid: `n-${Math.random()}`,
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text }] },
    };
}

function agentNotificationRow(toolUseId, status, timestamp) {
    return textRow(`<task-notification>\n  <tool-use-id>${toolUseId}</tool-use-id>\n  <status>${status}</status>\n</task-notification>`, timestamp);
}

async function writeParent(projectDir, rows, mtimeMs) {
    const file = path.join(projectDir, 'session.jsonl');
    await fsp.writeFile(file, rows.map((row) => JSON.stringify({ ...row, sessionId: PSID })).join('\n') + '\n');
    await fsp.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
    return file;
}

function agentToolRow(id, name, input, timestamp) {
    return {
        type: 'assistant',
        uuid: `sa-${id}`,
        timestamp,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    };
}

function agentTextRow(text, timestamp) {
    return {
        type: 'assistant',
        uuid: `st-${Math.random()}`,
        timestamp,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
    };
}

function agentThinkingRow(text, timestamp) {
    return {
        type: 'assistant',
        uuid: `sk-${Math.random()}`,
        timestamp,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
    };
}

function agentResultRow(toolUseId, timestamp) {
    return {
        type: 'user',
        uuid: `sr-${toolUseId}`,
        timestamp,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    };
}

async function writeAgent(projectDir, agentId, rows, { meta, mtimeMs } = {}) {
    const file = path.join(projectDir, PSID, 'subagents', `agent-${agentId}.jsonl`);
    await fsp.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await fsp.writeFile(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta ?? {}));
    await fsp.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
    return file;
}

function makeDeps(jsonlPath, overrides = {}) {
    return {
        getSession: async (sessionId) => (sessionId === SID
            ? { session_id: SID, provider_session_id: PSID, jsonl_path: jsonlPath }
            : null),
        resolveJsonlPath: async (sessionId) => (sessionId === SID ? jsonlPath : null),
        now: () => NOW,
        env: {},
        ...overrides,
    };
}

const T1 = '2026-10-06T19:59:30.000Z';
const T2 = '2026-10-06T19:59:40.000Z';
const T3 = '2026-10-06T19:59:50.000Z';

const SIMPLE_AGENT_ROWS = () => [
    agentThinkingRow('plan first', T1),
    agentToolRow('at-1', 'Bash', { command: 'ls -la /var/tmp', description: 'list temp' }, T2),
    agentResultRow('at-1', T2),
    agentTextRow('done', T3),
];

test('P4 list: async agent running via fresh transcript mtime, exact item shape', async () => {
    const project = await newProject('running');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'job one', subagent_type: 'implementer', run_in_background: true }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true, description: 'job one' }, T1),
    ], NOW - 60_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), {
        meta: { agentType: 'implementer', description: 'job one', toolUseId: tu },
        mtimeMs: NOW - 5_000,
    });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ['sessionWorking', 'lastWriteAt', 'tasks', 'agents']);
    assert.deepEqual(result.body.tasks, []);
    assert.equal(result.body.agents.length, 1);
    assert.deepEqual(result.body.agents[0], {
        id: AID1,
        agentType: 'implementer',
        description: 'job one',
        status: 'running',
        startedAt: T1,
        lastActivityAt: T3,
        steps: 3,
        currentStep: 'done',
    });
    assert.deepEqual(Object.keys(result.body.agents[0]),
        ['id', 'agentType', 'description', 'status', 'startedAt', 'lastActivityAt', 'steps', 'currentStep']);
    assert.equal(result.body.sessionWorking, true);
    assert.equal(result.body.lastWriteAt, new Date(NOW - 60_000).toISOString());
});

test('P4 list: async agent completed once the transcript mtime is stale', async () => {
    const project = await newProject('completed');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'old job', subagent_type: 'research' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 700_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 700_000 });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.body.agents[0].status, 'completed');
    assert.equal(result.body.sessionWorking, false);
});

test('P4 list: CLOUDCLI_SUBAGENT_LIVE_MS overrides the running window', async () => {
    const project = await newProject('window');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'w', subagent_type: 'research' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 5_000 });
    const deps = makeDeps(jsonl, { env: { CLOUDCLI_SUBAGENT_LIVE_MS: '1000' } });
    assert.equal((await bgTasksListRequest({ sessionId: SID }, deps)).body.agents[0].status, 'completed');
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 500 });
    assert.equal((await bgTasksListRequest({ sessionId: SID }, deps)).body.agents[0].status, 'running');
});

test('P4 list: notification beats a fresh transcript (failed)', async () => {
    const project = await newProject('notified');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'boom', subagent_type: 'qa' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
        agentNotificationRow(tu, 'error', T3),
    ], NOW - 60_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 1_000 });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.body.agents[0].status, 'failed');
});

test('P4 list: endedMidToolCall keeps an agent running despite a stale mtime', async () => {
    const project = await newProject('midtool');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'stuck', subagent_type: 'implementer' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    await writeAgent(project, AID1, [
        agentToolRow('at-9', 'Bash', { command: 'sleep 999' }, T3),
    ], { mtimeMs: NOW - 700_000 });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.body.agents[0].status, 'running');
    assert.equal(result.body.agents[0].currentStep, 'Bash: sleep 999');
});

test('P4 list: sync launch (no isAsync) is completed even while the transcript is fresh', async () => {
    const project = await newProject('syncdone');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'sync job', subagent_type: 'research' }, T1),
        resultRow(tu, 'all done', { agentId: AID1, description: 'sync job' }, T3),
    ], NOW - 60_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 1_000 });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.body.agents[0].status, 'completed');
});

test('P4 list: pending sync Agent call is bound via the meta toolUseId', async () => {
    const project = await newProject('pending');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'sync in flight', subagent_type: 'research' }, T2),
    ], NOW - 60_000);
    await writeAgent(project, AID2, [
        agentToolRow('at-2', 'Grep', { pattern: 'foo', path: '/x' }, T3),
    ], { meta: { agentType: 'research', description: 'sync in flight', toolUseId: tu }, mtimeMs: NOW - 2_000 });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.body.agents.length, 1);
    assert.deepEqual(result.body.agents[0], {
        id: AID2,
        agentType: 'research',
        description: 'sync in flight',
        status: 'running',
        startedAt: T2,
        lastActivityAt: T3,
        steps: 1,
        currentStep: 'Grep: foo',
    });
});

test('P4 list: agents newest first by startedAt, capped at 50', async () => {
    const project = await newProject('cap');
    const rows = [];
    for (let i = 0; i < 52; i += 1) {
        const tu = tid();
        const agentId = `a${i.toString(16).padStart(16, '0')}`;
        rows.push(useRow(tu, 'Agent', { description: `job ${i}` }, new Date(Date.parse('2026-10-06T18:00:00.000Z') + i * 1000).toISOString()));
        rows.push(resultRow(tu, 'launched', { agentId, isAsync: true }, T1));
    }
    const jsonl = await writeParent(project, rows, NOW - 60_000);
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.body.agents.length, 50);
    assert.equal(result.body.agents[0].description, 'job 51');
    assert.equal(result.body.agents[49].description, 'job 2');
});

test('P4 list: sessionWorking from JSONL mtime with no agents', async () => {
    const project = await newProject('fresh-jsonl');
    const jsonl = await writeParent(project, [], NOW - 1_000);
    const fresh = await bgTasksListRequest({ sessionId: SID }, makeDeps(jsonl));
    assert.equal(fresh.body.sessionWorking, true);
    assert.deepEqual(fresh.body.agents, []);

    const stale = await writeParent(project, [], NOW - 60_000);
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(stale));
    assert.equal(result.body.sessionWorking, false);
    assert.equal(result.body.lastWriteAt, new Date(NOW - 60_000).toISOString());
});

test('P4 list: resolveJsonlPath-only deps fall back to the JSONL sessionId', async () => {
    const project = await newProject('fallback');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'fallback job', subagent_type: 'implementer' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 5_000 });
    const deps = {
        resolveJsonlPath: async (sessionId) => (sessionId === SID ? jsonl : null),
        now: () => NOW,
        env: {},
    };
    const result = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.agents.length, 1);
    assert.equal(result.body.agents[0].id, AID1);
    assert.equal(result.body.agents[0].status, 'running');
});

test('P4 list: unreadable transcript returns 500', async () => {
    const project = await newProject('broken');
    const dirAsFile = path.join(project, 'not-a-file.jsonl');
    await fsp.mkdir(dirAsFile, { recursive: true });
    const result = await bgTasksListRequest({ sessionId: SID }, makeDeps(dirAsFile));
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'Failed to read session transcript' });
});

test('P4 agent tail: last N steps, kinds, sanitized labels, timestamps', async () => {
    const project = await newProject('tail');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'tailed', subagent_type: 'implementer' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    const rows = [
        agentThinkingRow('plan it out', T1),
        agentToolRow('at-1', 'Bash', { command: 'ls -la /var/tmp', description: 'list temp' }, T2),
        agentResultRow('at-1', T2),
        agentTextRow(`\u001b[31mmulti\nline\u001b[0m ${'x'.repeat(100)}`, T3),
    ];
    await writeAgent(project, AID1, rows, { mtimeMs: NOW - 5_000 });

    const full = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID }, makeDeps(jsonl));
    assert.equal(full.status, 200);
    assert.deepEqual(Object.keys(full.body), ['id', 'steps', 'truncated']);
    assert.equal(full.body.id, AID1);
    assert.equal(full.body.truncated, false);
    assert.deepEqual(full.body.steps, [
        { kind: 'text', label: 'plan it out', at: T1 },
        { kind: 'tool', label: 'Bash: list temp', at: T2 },
        { kind: 'text', label: `multi line ${'x'.repeat(100)}`.slice(0, 80), at: T3 },
    ]);

    const partial = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID, steps: '1' }, makeDeps(jsonl));
    assert.equal(partial.body.steps.length, 1);
    assert.equal(partial.body.steps[0].label, `multi line ${'x'.repeat(100)}`.slice(0, 80));
    assert.equal(partial.body.truncated, true);
});

test('P4 agent tail: default 20 steps, steps=100 boundary', async () => {
    const project = await newProject('tail-cap');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'many steps' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    const rows = [];
    for (let i = 1; i <= 101; i += 1) {
        rows.push(agentTextRow(`step ${String(i).padStart(3, '0')}`, new Date(Date.parse(T1) + i * 1000).toISOString()));
    }
    await writeAgent(project, AID1, rows, { mtimeMs: NOW - 5_000 });

    const defaulted = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID }, makeDeps(jsonl));
    assert.equal(defaulted.body.steps.length, 20);
    assert.equal(defaulted.body.steps[19].label, 'step 101');
    assert.equal(defaulted.body.truncated, true);

    const atCap = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID, steps: '100' }, makeDeps(jsonl));
    assert.equal(atCap.body.steps.length, 100);
    assert.equal(atCap.body.steps[0].label, 'step 002');
    assert.equal(atCap.body.truncated, true);

    const exact = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID, steps: '101' }, makeDeps(jsonl));
    assert.equal(exact.status, 400);
});

test('P4 agent tail negatives: bad agentId, bad steps, unknown session/agent, array query', async () => {
    const project = await newProject('tail-neg');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'neg' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    await writeAgent(project, AID1, SIMPLE_AGENT_ROWS(), { mtimeMs: NOW - 5_000 });
    const deps = makeDeps(jsonl);

    for (const badAgent of ['BADUPPER', '../escape', 'a1234', `a${'1'.repeat(25)}`, 'ag1234567890abcdef', '', 42, ['a1234567890abcdef']]) {
        const result = await bgTasksAgentTailRequest({ agentId: badAgent, sessionId: SID }, deps);
        assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(badAgent)}`);
        assert.deepEqual(result.body, { error: 'Invalid agentId' });
    }
    for (const badSteps of ['0', '101', 'abc', '-1', '1.5']) {
        const result = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID, steps: badSteps }, deps);
        assert.equal(result.status, 400, `expected 400 for steps=${badSteps}`);
        assert.deepEqual(result.body, { error: 'steps must be an integer between 1 and 100' });
    }
    const unknownSession = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: '00000000-0000-4000-8000-000000000000' }, deps);
    assert.equal(unknownSession.status, 404);
    assert.deepEqual(unknownSession.body, { error: 'Session not found' });
    const badSession = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: ['x'] }, deps);
    assert.equal(badSession.status, 400);
    const unreferenced = await bgTasksAgentTailRequest({ agentId: AID3, sessionId: SID }, deps);
    assert.equal(unreferenced.status, 404);
    assert.deepEqual(unreferenced.body, { error: 'Agent not found' });
});

test('P4 agent tail security: symlinked transcript escape is rejected', async () => {
    const project = await newProject('tail-symlink');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'evil' }, T1),
        resultRow(tu, 'launched', { agentId: AID3, isAsync: true }, T1),
    ], NOW - 60_000);
    const target = path.join(project, PSID, 'subagents', `agent-${AID3}.jsonl`);
    await fsp.symlink('/etc/passwd', target);
    const deps = makeDeps(jsonl);
    const tail = await bgTasksAgentTailRequest({ agentId: AID3, sessionId: SID }, deps);
    assert.equal(tail.status, 404);
    assert.deepEqual(tail.body, { error: 'Agent not found' });
    const list = await bgTasksListRequest({ sessionId: SID }, deps);
    assert.equal(list.status, 200);
    assert.equal(list.body.agents[0].steps, 0);
    assert.equal(list.body.agents[0].currentStep, '');
});

test('P4 agent tail: referenced agent with a missing transcript returns 404', async () => {
    const project = await newProject('tail-gone');
    const tu = tid();
    const jsonl = await writeParent(project, [
        useRow(tu, 'Agent', { description: 'gone' }, T1),
        resultRow(tu, 'launched', { agentId: AID1, isAsync: true }, T1),
    ], NOW - 60_000);
    const result = await bgTasksAgentTailRequest({ agentId: AID1, sessionId: SID }, makeDeps(jsonl));
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'Agent not found' });
});

test('P4 active: only fresh claude sessions, newest write first, capped at 200', async () => {
    const project = await newProject('active');
    const freshA = path.join(project, 'a.jsonl');
    const freshB = path.join(project, 'b.jsonl');
    const stale = path.join(project, 'c.jsonl');
    for (const [file, mtime] of [[freshA, NOW - 1_000], [freshB, NOW - 2_000], [stale, NOW - 60_000]]) {
        await fsp.writeFile(file, '{}\n');
        await fsp.utimes(file, new Date(mtime), new Date(mtime));
    }
    const deps = {
        listSessions: async () => [
            { sessionId: 'sid-a', jsonlPath: freshA },
            { sessionId: 'sid-b', jsonlPath: freshB },
            { sessionId: 'sid-c', jsonlPath: stale },
        ],
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    };
    const result = await bgTasksActiveRequest(deps);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
        sessions: [
            { sessionId: 'sid-a', working: true, lastWriteAt: new Date(NOW - 1_000).toISOString() },
            { sessionId: 'sid-b', working: true, lastWriteAt: new Date(NOW - 2_000).toISOString() },
        ],
    });
});

test('P4 active: cap at 200 rows for 201 fresh sessions', async () => {
    const project = await newProject('active-cap');
    const rows = [];
    for (let i = 0; i < 201; i += 1) {
        const file = path.join(project, `s${String(i).padStart(3, '0')}.jsonl`);
        await fsp.writeFile(file, '{}\n');
        await fsp.utimes(file, new Date(NOW - 1_000), new Date(NOW - 1_000));
        rows.push({ sessionId: `sid-${i}`, jsonlPath: file });
    }
    const result = await bgTasksActiveRequest({
        listSessions: async () => rows,
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.sessions.length, 200);
});

test('P4 active: 2 s cache serves the previous result inside the TTL', async () => {
    const project = await newProject('active-cache');
    const file = path.join(project, 'a.jsonl');
    await fsp.writeFile(file, '{}\n');
    await fsp.utimes(file, new Date(NOW - 1_000), new Date(NOW - 1_000));
    let current = [{ sessionId: 'sid-a', jsonlPath: file }];
    const deps = {
        listSessions: async () => current,
        now: () => NOW,
        env: {},
    };
    const first = await bgTasksActiveRequest(deps);
    assert.deepEqual(first.body.sessions.map((s) => s.sessionId), ['sid-a']);
    current = [];
    const cached = await bgTasksActiveRequest({ ...deps, now: () => NOW + 1_000 });
    assert.deepEqual(cached.body.sessions.map((s) => s.sessionId), ['sid-a']);
    const refreshed = await bgTasksActiveRequest({ ...deps, now: () => NOW + 2_500 });
    assert.deepEqual(refreshed.body.sessions, []);
});

test('P4 active: rows without ids or paths are skipped; listSessions throw -> 500', async () => {
    const skipped = await bgTasksActiveRequest({
        listSessions: async () => [{ sessionId: 'x' }, { jsonlPath: '/x' }, null, 7],
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    });
    assert.deepEqual(skipped.body, { sessions: [] });
    const failed = await bgTasksActiveRequest({
        listSessions: async () => {
            throw new Error('db down');
        },
        now: () => NOW,
        env: {},
        cacheTtlMs: 0,
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'Failed to list sessions' });
});
