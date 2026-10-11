import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bgTasksUrl,
  bgTaskTailUrl,
  normalizeTask,
  sortTasks,
  countRunning,
  chipLabel,
  formatAge,
  createBgJobsModel,
  createPollController,
} from '../lib/bg-jobs.mjs';

const T0 = Date.parse('2026-10-06T12:00:00Z');

function task(overrides = {}) {
  return {
    id: 't1',
    description: 'npm test',
    status: 'running',
    startedAt: '2026-10-06T11:59:00Z',
    endedAt: null,
    outputBytes: 1024,
    ...overrides,
  };
}

test('urls code exactly to the bg-tasks contract', () => {
  assert.equal(bgTasksUrl('u 1'), '/api/bg-tasks?sessionId=u%201');
  assert.equal(bgTaskTailUrl('t/1', 'u1'), '/api/bg-tasks/t%2F1/tail?sessionId=u1&lines=40');
  assert.equal(bgTaskTailUrl('t1', 'u1', 10), '/api/bg-tasks/t1/tail?sessionId=u1&lines=10');
});

test('normalizeTask keeps contract statuses and drops bad rows', () => {
  assert.deepEqual(normalizeTask(task()), task());
  assert.equal(normalizeTask(task({ status: 'weird' })), null);
  assert.equal(normalizeTask({ status: 'running' }), null);
  assert.equal(normalizeTask(null), null);
  const minimal = normalizeTask({ id: 7, status: 'completed', startedAt: 123 });
  assert.deepEqual(minimal, {
    id: '7',
    description: '',
    status: 'completed',
    startedAt: null,
    endedAt: null,
    outputBytes: 0,
  });
});

test('sortTasks puts running first then newest startedAt first', () => {
  const sorted = sortTasks([
    task({ id: 'old-done', status: 'completed', startedAt: '2026-10-06T10:00:00Z' }),
    task({ id: 'run-old', startedAt: '2026-10-06T11:00:00Z' }),
    task({ id: 'run-new', startedAt: '2026-10-06T11:59:00Z' }),
    task({ id: 'new-done', status: 'completed', startedAt: '2026-10-06T11:58:00Z' }),
  ]);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['run-new', 'run-old', 'new-done', 'old-done'],
  );
});

test('chip label counts running jobs and hides at zero', () => {
  assert.equal(countRunning([task(), task({ id: 't2', status: 'completed' })]), 1);
  assert.equal(chipLabel(1), '⏳ 1 background job');
  assert.equal(chipLabel(2), '⏳ 2 background jobs');
  assert.equal(chipLabel(0), '');
  assert.equal(chipLabel(-3), '');
});

test('formatAge renders coarse ages clamped at zero', () => {
  assert.equal(formatAge('2026-10-06T11:59:45Z', T0), '15s');
  assert.equal(formatAge('2026-10-06T11:55:00Z', T0), '5m');
  assert.equal(formatAge('2026-10-06T09:30:00Z', T0), '2h 30m');
  assert.equal(formatAge('2026-10-04T12:00:00Z', T0), '2d 0h');
  assert.equal(formatAge('2099-01-01T00:00:00Z', T0), '0s');
  assert.equal(formatAge('not-a-date', T0), '');
  assert.equal(formatAge(null, T0), '');
});

test('model tracks counts, selection and stale tail guards', () => {
  const model = createBgJobsModel({ now: () => T0 });
  model.applyList({ tasks: [task(), task({ id: 't2', status: 'completed', startedAt: '2026-10-06T11:59:30Z' })] });
  assert.equal(model.runningCount, 1);
  assert.equal(model.anyRunning, true);
  assert.equal(model.ageOf(model.tasks[0]), '1m');

  model.select('t2');
  assert.equal(model.selectedTaskId, 't2');
  model.applyTail({ id: 't2', text: 'line1\nline2', truncated: false });
  assert.deepEqual(model.selectedTail, { id: 't2', text: 'line1\nline2', truncated: false });
  // tail for another job is ignored
  model.applyTail({ id: 't1', text: 'stale' });
  assert.equal(model.selectedTail.text, 'line1\nline2');

  // selection cleared when the job disappears from the next list
  model.applyList({ tasks: [task()] });
  assert.equal(model.selectedTaskId, null);
  assert.equal(model.selectedTail, null);
  assert.equal(model.selectedTaskRunning, false);
});

test('model applyList tolerates malformed payloads', () => {
  const model = createBgJobsModel();
  assert.deepEqual(model.applyList(null), []);
  assert.deepEqual(model.applyList({}), []);
  assert.deepEqual(model.applyList({ tasks: [{ status: 'running' }, task()] }).map((t) => t.id), ['t1']);
});

test('model disables permanently on 404 or 401', () => {
  const model = createBgJobsModel();
  assert.equal(model.disabled, false);
  model.noteStatus(500);
  assert.equal(model.disabled, false);
  model.noteStatus(404);
  assert.equal(model.disabled, true);

  const other = createBgJobsModel();
  other.noteStatus(401);
  assert.equal(other.disabled, true);
});

test('selectedTaskRunning follows list updates', () => {
  const model = createBgJobsModel();
  model.applyList({ tasks: [task({ id: 't9' })] });
  model.select('t9');
  assert.equal(model.selectedTaskRunning, true);
  model.applyList({ tasks: [task({ id: 't9', status: 'completed', endedAt: '2026-10-06T12:00:01Z' })] });
  assert.equal(model.selectedTaskRunning, false);
});

function manualInterval() {
  let handle = 0;
  const timers = new Map();
  return {
    setIntervalFn: (fn, ms) => {
      handle += 1;
      timers.set(handle, { fn, ms });
      return handle;
    },
    clearIntervalFn: (id) => timers.delete(id),
    fire: () => {
      for (const { fn } of timers.values()) fn();
    },
    size: () => timers.size,
    intervalOf: () => (timers.size ? [...timers.values()][0].ms : null),
  };
}

test('poll controller runs only while visible, enabled and session-bound', () => {
  const timers = manualInterval();
  let ticks = 0;
  const controller = createPollController({
    intervalMs: 5000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    onTick: () => {
      ticks += 1;
    },
  });
  controller.sync({ visible: false, enabled: true, disabled: false, sessionId: 's1' });
  assert.equal(controller.running, false);
  controller.sync({ visible: true, enabled: true, disabled: false, sessionId: 's1' });
  assert.equal(controller.running, true);
  assert.equal(timers.intervalOf(), 5000);
  controller.sync({ visible: true, enabled: true, disabled: false, sessionId: 's1' });
  assert.equal(timers.size(), 1);
  timers.fire();
  assert.equal(ticks, 1);
  controller.sync({ visible: false, enabled: true, disabled: false, sessionId: 's1' });
  assert.equal(controller.running, false);
  assert.equal(timers.size(), 0);
  controller.sync({ visible: true, enabled: false, disabled: false, sessionId: 's1' });
  assert.equal(controller.running, false);
  controller.sync({ visible: true, enabled: true, disabled: true, sessionId: 's1' });
  assert.equal(controller.running, false);
  controller.sync({ visible: true, enabled: true, disabled: false, sessionId: null });
  assert.equal(controller.running, false);
  controller.sync({ visible: true, enabled: true, disabled: false, sessionId: 's1' });
  controller.stop();
  assert.equal(controller.running, false);
});

test('poll controller keeps ticking when a tick throws', () => {
  const timers = manualInterval();
  let ticks = 0;
  const controller = createPollController({
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    onTick: () => {
      ticks += 1;
      throw new Error('network down');
    },
  });
  controller.sync({ visible: true, enabled: true, disabled: false, sessionId: 's1' });
  assert.doesNotThrow(() => timers.fire());
  assert.equal(ticks, 1);
  assert.equal(controller.running, true);
});
