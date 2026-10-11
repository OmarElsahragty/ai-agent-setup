import test from 'node:test';
import assert from 'node:assert/strict';
import { createCadencePoller, createOpenSessionWatcher, decidePollMs, POLL_IDLE_MS } from '../lib/activity-bar.mjs';

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeoutFn: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn: (id) => pending.delete(id),
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire: () => {
      const [id, entry] = [...pending][0];
      pending.delete(id);
      entry.fn();
    },
  };
}

test('D7: opening a session polls immediately, then re-arms with the idle cadence', () => {
  const timers = fakeTimers();
  let ticks = 0;
  const poller = createCadencePoller({
    decideMs: () => decidePollMs({ visible: true }), // idle session -> 15 s cadence
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTick: () => {
      ticks += 1;
    },
  });
  const watcher = createOpenSessionWatcher({ onOpen: () => poller.pollNow(), onClose: () => poller.stop() });
  assert.equal(watcher.check('session-a'), true);
  assert.equal(ticks, 1); // no 15 s wait for the first poll
  assert.deepEqual(timers.delays(), [POLL_IDLE_MS]);
  // same session again: no extra poll
  assert.equal(watcher.check('session-a'), false);
  assert.equal(ticks, 1);
  // SPA navigation to another session: immediate poll again, still one timer
  assert.equal(watcher.check('session-b'), true);
  assert.equal(ticks, 2);
  assert.deepEqual(timers.delays(), [POLL_IDLE_MS]);
  // leaving the chat stops polling
  assert.equal(watcher.check(null), true);
  assert.deepEqual(timers.delays(), []);
  assert.equal(poller.running, false);
  assert.equal(watcher.current, null);
});

test('D7: pollNow on a hidden tab ticks once and stays stopped (decideMs null)', () => {
  const timers = fakeTimers();
  let ticks = 0;
  const poller = createCadencePoller({
    decideMs: () => decidePollMs({ visible: false }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTick: () => {
      ticks += 1;
    },
  });
  poller.pollNow();
  assert.equal(ticks, 1);
  assert.deepEqual(timers.delays(), []);
  assert.equal(poller.running, false);
});

test('D7: a tick that stops the poller is respected; a throwing tick still re-arms', () => {
  const timers = fakeTimers();
  let poller = null;
  poller = createCadencePoller({
    decideMs: () => 3000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTick: () => poller.stop(),
  });
  poller.pollNow();
  assert.deepEqual(timers.delays(), []);
  const throwing = createCadencePoller({
    decideMs: () => 3000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onTick: () => {
      throw new Error('tick failed');
    },
  });
  throwing.pollNow();
  assert.deepEqual(timers.delays(), [3000]);
});

test('open-session watcher ignores empty ids and survives throwing callbacks', () => {
  const opened = [];
  const watcher = createOpenSessionWatcher({
    onOpen: (id) => {
      opened.push(id);
      throw new Error('callback failed');
    },
  });
  assert.equal(watcher.check(''), false);
  assert.equal(watcher.check(undefined), false);
  assert.equal(watcher.check('s1'), true);
  assert.deepEqual(opened, ['s1']);
});
