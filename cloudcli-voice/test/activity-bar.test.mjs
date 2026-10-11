import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentsTailUrl,
  activeSessionsUrl,
  normalizeAgent,
  sortAgents,
  sessionIdFromHref,
  activeSessionIds,
  decidePollMs,
  createActivityModel,
  createCadencePoller,
  AGENT_TAIL_STEPS,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
} from '../lib/activity-bar.mjs';

const T0 = Date.parse('2026-10-06T12:00:00Z');

function agent(overrides = {}) {
  return {
    id: 'a1b2c3d4e5',
    agentType: 'implementer',
    description: 'Fix the login flow',
    status: 'running',
    startedAt: '2026-10-06T11:59:00Z',
    lastActivityAt: '2026-10-06T11:59:50Z',
    steps: 12,
    currentStep: 'Edit: src/login.ts',
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: 't1',
    description: 'npm test',
    status: 'running',
    startedAt: '2026-10-06T11:59:30Z',
    endedAt: null,
    outputBytes: 1024,
    ...overrides,
  };
}

test('agent tail url codes exactly to the contract and clamps steps 1..100', () => {
  assert.equal(AGENT_TAIL_STEPS, 20);
  assert.equal(
    agentsTailUrl('a1b2c3d4e5', 'u 1'),
    '/api/bg-tasks/agents/a1b2c3d4e5/tail?sessionId=u%201&steps=20',
  );
  assert.equal(agentsTailUrl('a1', 'u1', 5), '/api/bg-tasks/agents/a1/tail?sessionId=u1&steps=5');
  assert.equal(agentsTailUrl('a1', 'u1', 0), '/api/bg-tasks/agents/a1/tail?sessionId=u1&steps=1');
  assert.equal(agentsTailUrl('a1', 'u1', 500), '/api/bg-tasks/agents/a1/tail?sessionId=u1&steps=100');
  assert.equal(agentsTailUrl('a 1', 'u1'), '/api/bg-tasks/agents/a%201/tail?sessionId=u1&steps=20');
  assert.equal(activeSessionsUrl(), '/api/bg-tasks/active');
});

test('normalizeAgent keeps contract statuses and drops bad rows', () => {
  assert.deepEqual(normalizeAgent(agent()), agent());
  assert.equal(normalizeAgent(agent({ status: 'weird' })), null);
  assert.equal(normalizeAgent(agent({ status: 'killed' })), null);
  assert.equal(normalizeAgent({ status: 'running' }), null);
  assert.equal(normalizeAgent(null), null);
  const minimal = normalizeAgent({ id: 7, status: 'failed' });
  assert.deepEqual(minimal, {
    id: '7',
    agentType: '',
    description: '',
    status: 'failed',
    startedAt: null,
    lastActivityAt: null,
    steps: 0,
    currentStep: '',
  });
});

test('sortAgents puts running first then newest startedAt first', () => {
  const sorted = sortAgents([
    agent({ id: 'done-old', status: 'completed', startedAt: '2026-10-06T10:00:00Z' }),
    agent({ id: 'run-old', startedAt: '2026-10-06T11:00:00Z' }),
    agent({ id: 'run-new', startedAt: '2026-10-06T11:59:00Z' }),
  ]);
  assert.deepEqual(
    sorted.map((a) => a.id),
    ['run-new', 'run-old', 'done-old'],
  );
});

test('summary line matches the spec text and hides with nothing running/recent', () => {
  const model = createActivityModel({ now: () => T0 });
  assert.equal(model.summary(), '');
  model.apply({ sessionWorking: true });
  assert.equal(model.summary(), '● Working ▲');
  model.setExpanded(true);
  assert.equal(model.summary(), '● Working ▼');
  model.setExpanded(false);
  model.apply({ agents: [agent(), agent({ id: 'a2233c4455' })], tasks: [job()] });
  assert.equal(model.summary(), '● Working · 2 agents · 1 background job ▲');
  model.apply({ agents: [agent()], tasks: [job()] });
  assert.equal(model.summary(), '● Working · 1 agent · 1 background job ▲');
  model.apply({ agents: [], tasks: [] });
  assert.equal(model.summary(), '');
});

test('summary keeps recently finished items visible, then hides after the fade window', () => {
  let nowMs = T0;
  const model = createActivityModel({ now: () => nowMs });
  model.apply({ agents: [agent({ status: 'completed' })] });
  assert.equal(model.summary(), '● 1 finished ▲');
  nowMs = T0 + 59_999;
  assert.equal(model.summary(), '● 1 finished ▲');
  nowMs = T0 + 60_001;
  assert.equal(model.summary(), '');
});

test('rows order: running agents, running jobs, then recently finished newest-first', () => {
  const model = createActivityModel({ now: () => T0 });
  model.apply({
    agents: [agent({ id: 'a-done', status: 'failed' }), agent({ id: 'a-run', currentStep: 'Read: spec.md' })],
    tasks: [job({ id: 't-done', status: 'completed', endedAt: '2026-10-06T11:59:40Z' }), job({ id: 't-run' })],
  });
  const rows = model.rows();
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.id}`),
    ['agent:a-run', 'job:t-run', 'job:t-done', 'agent:a-done'],
  );
  assert.deepEqual(
    rows.map((r) => r.icon),
    ['⟳', '⏳', '✓', '✗'],
  );
  assert.deepEqual(
    rows.map((r) => r.title),
    ['implementer', 'shell', 'shell', 'implementer'],
  );
  assert.deepEqual(
    rows.map((r) => r.middle),
    ['Read: spec.md', 'running', 'completed', 'Edit: src/login.ts'],
  );
  // running elapsed counts from startedAt (1m for the agent started 11:59)
  assert.equal(rows[0].elapsed, '1m');
  assert.equal(rows[1].elapsed, '30s');
  // finished elapsed freezes at the end timestamp (11:59:00 -> 11:59:50 = 50s)
  assert.equal(rows[3].elapsed, '50s');
});

test('finished rows fade out after 60 s (kept at 59,999 ms, dropped at 60,001 ms)', () => {
  let nowMs = T0;
  const model = createActivityModel({ now: () => nowMs });
  model.apply({ agents: [agent({ status: 'completed' })], tasks: [job({ status: 'failed' })] });
  assert.equal(model.rows().length, 2);
  nowMs = T0 + 59_999;
  assert.equal(model.rows().length, 2);
  nowMs = T0 + 60_001;
  assert.equal(model.rows().length, 0);
});

test('a finished item that starts running again loses its fade clock', () => {
  let nowMs = T0;
  const model = createActivityModel({ now: () => nowMs });
  model.apply({ agents: [agent({ status: 'completed' })] });
  nowMs = T0 + 30_000;
  model.apply({ agents: [agent()] });
  assert.equal(model.rows().length, 1);
  assert.equal(model.rows()[0].status, 'running');
  nowMs = T0 + 45_000;
  model.apply({ agents: [agent({ status: 'completed' })] });
  assert.equal(model.rows()[0].icon, '✓'); // fresh 60 s window from T0+45s
});

test('selection and tail guards for agent and job rows', () => {
  const model = createActivityModel({ now: () => T0 });
  model.apply({ agents: [agent()], tasks: [job({ id: 't9' })] });
  assert.equal(model.selected, null);
  assert.equal(model.selectedRunning, false);

  model.select('agent', 'a1b2c3d4e5');
  assert.equal(model.selectedRunning, true);
  model.applyAgentTail({
    id: 'a1b2c3d4e5',
    steps: [{ kind: 'tool', label: 'Bash: ls', at: '2026-10-06T11:59:50Z' }, { kind: 'text', label: 'hello' }, { label: 5 }],
    truncated: true,
  });
  assert.equal(model.tail.text, '[tool] Bash: ls\nhello');
  assert.equal(model.tail.truncated, true);
  // tail for another agent is ignored
  model.applyAgentTail({ id: 'b999999999', steps: [{ kind: 'tool', label: 'x' }] });
  assert.equal(model.tail.text, '[tool] Bash: ls\nhello');

  model.select('job', 't9');
  assert.equal(model.tail, null);
  model.applyJobTail({ id: 't9', text: 'ok\nlines', truncated: false });
  assert.deepEqual(model.tail, { kind: 'job', id: 't9', text: 'ok\nlines', truncated: false });

  model.select(null);
  assert.equal(model.selected, null);
  assert.equal(model.tail, null);

  // selection cleared when the item disappears from the next list
  model.select('job', 't9');
  model.apply({ agents: [], tasks: [] });
  assert.equal(model.selected, null);
});

test('model disables permanently on 404 or 401', () => {
  const model = createActivityModel({ now: () => T0 });
  assert.equal(model.disabled, false);
  model.noteStatus(500);
  assert.equal(model.disabled, false);
  model.noteStatus(404);
  assert.equal(model.disabled, true);

  const other = createActivityModel({ now: () => T0 });
  other.noteStatus(401);
  assert.equal(other.disabled, true);
});

test('model tolerates malformed payloads', () => {
  const model = createActivityModel({ now: () => T0 });
  model.apply(null);
  assert.deepEqual(model.tasks, []);
  assert.deepEqual(model.agents, []);
  assert.equal(model.sessionWorking, false);
  model.apply({ agents: [{ status: 'running' }, agent()], tasks: 'nope' });
  assert.deepEqual(model.agents.map((a) => a.id), ['a1b2c3d4e5']);
  assert.equal(model.anythingRunning, true);
});

test('poll cadence decision follows the spec (3 s active / 15 s idle / null hidden)', () => {
  assert.equal(POLL_ACTIVE_MS, 3000);
  assert.equal(POLL_IDLE_MS, 15000);
  assert.equal(decidePollMs({ visible: false, expanded: true, anythingRunning: true, sessionWorking: true }), null);
  assert.equal(decidePollMs({ visible: true }), POLL_IDLE_MS);
  assert.equal(decidePollMs({ visible: true, expanded: false, anythingRunning: false, sessionWorking: false }), POLL_IDLE_MS);
  assert.equal(decidePollMs({ visible: true, expanded: true, anythingRunning: false, sessionWorking: false }), POLL_ACTIVE_MS);
  assert.equal(decidePollMs({ visible: true, expanded: false, anythingRunning: true, sessionWorking: false }), POLL_ACTIVE_MS);
  assert.equal(decidePollMs({ visible: true, expanded: false, anythingRunning: false, sessionWorking: true }), POLL_ACTIVE_MS);
});

function manualTimeout() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, ms });
      return seq;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    fire: () => {
      for (const [id, timer] of timers) {
        timers.delete(id);
        timer.fn();
        return true;
      }
      return false;
    },
    size: () => timers.size,
    delayOf: () => (timers.size ? [...timers.values()][0].ms : null),
  };
}

test('cadence poller re-arms at the decided interval and stops on null', () => {
  const timers = manualTimeout();
  let ticks = 0;
  let delay = 3000;
  const poller = createCadencePoller({
    decideMs: () => delay,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTick: () => {
      ticks += 1;
    },
  });
  assert.equal(poller.running, false);
  poller.sync();
  assert.equal(poller.running, true);
  assert.equal(timers.size(), 1);
  assert.equal(timers.delayOf(), 3000);

  // cadence change takes effect on the next sync: old timer cleared, one armed
  delay = 15000;
  poller.sync();
  assert.equal(timers.size(), 1);
  assert.equal(timers.delayOf(), 15000);

  timers.fire();
  assert.equal(ticks, 1);
  assert.equal(timers.delayOf(), 15000);

  delay = null; // hidden tab
  timers.fire();
  assert.equal(ticks, 2);
  assert.equal(poller.running, false);
  assert.equal(timers.size(), 0);

  delay = 3000;
  poller.sync();
  assert.equal(poller.running, true);
  poller.stop();
  assert.equal(poller.running, false);
  assert.equal(timers.size(), 0);
});

test('cadence poller survives a throwing tick and keeps re-arming', () => {
  const timers = manualTimeout();
  const poller = createCadencePoller({
    decideMs: () => 3000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTick: () => {
      throw new Error('network down');
    },
  });
  poller.sync();
  assert.doesNotThrow(() => timers.fire());
  assert.equal(poller.running, true);
  assert.equal(timers.delayOf(), 3000);
});

test('sidebar badge mapping extracts link ids and working session ids', () => {
  assert.equal(sessionIdFromHref('/session/abc-123'), 'abc-123');
  assert.equal(sessionIdFromHref('/session/abc%20def?x=1'), 'abc def');
  assert.equal(sessionIdFromHref('https://${AI_SETUP_DOMAIN}/session/s1'), 's1');
  assert.equal(sessionIdFromHref('/projects'), null);
  assert.equal(sessionIdFromHref(''), null);
  assert.equal(sessionIdFromHref(null), null);

  const ids = activeSessionIds({
    sessions: [
      { sessionId: 's1', working: true, lastWriteAt: '2026-10-06T11:59:00Z' },
      { sessionId: 's2', working: false },
      { sessionId: 's3' },
      { broken: true },
    ],
  });
  assert.equal(ids.size, 1);
  assert.equal(ids.has('s1'), true);
  assert.deepEqual(activeSessionIds(null), new Set());
  assert.deepEqual(activeSessionIds({}), new Set());
});
