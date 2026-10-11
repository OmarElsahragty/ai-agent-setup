import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunTracker,
  shouldLiveRefresh,
  openSessionFromLocation,
  createRefreshScheduler,
  refreshBlockedByUnsentInput,
} from '../lib/live-refresh.mjs';

function createFakeClock(startAt = 0) {
  let current = startAt;
  let jobs = [];
  let seq = 0;
  return {
    now: () => current,
    setTimeoutFn: (fn, ms) => {
      const id = ++seq;
      jobs.push({ id, at: current + ms, fn });
      return id;
    },
    clearTimeoutFn: (id) => {
      jobs = jobs.filter((job) => job.id !== id);
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = jobs.filter((job) => job.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        jobs = jobs.filter((job) => job.id !== due.id);
        current = due.at;
        due.fn();
      }
      current = target;
    },
    pendingCount: () => jobs.length,
  };
}

test('run tracker marks a session active on chat.send and clears on complete', () => {
  const tracker = createSessionRunTracker();
  tracker.noteOutgoing({ type: 'chat.send', sessionId: 's1' });
  assert.equal(tracker.isActive('s1'), true);
  assert.equal(tracker.isActive('s2'), false);
  tracker.noteFrame({ kind: 'complete', sessionId: 's1' });
  assert.equal(tracker.isActive('s1'), false);
});

test('run tracker: streaming output after a late complete (aborted run) marks the session busy again', () => {
  const tracker = createSessionRunTracker();
  tracker.noteOutgoing({ type: 'chat.send', sessionId: 's1' }); // the replacement run
  tracker.noteFrame({ kind: 'complete', sessionId: 's1' }); // late complete of the aborted run
  tracker.noteFrame({ kind: 'text', role: 'user', sessionId: 's1', content: 'echo' });
  assert.equal(tracker.isActive('s1'), false); // the owner's own echoed message is not output
  tracker.noteFrame({ kind: 'tool_use', sessionId: 's1' });
  assert.equal(tracker.isActive('s1'), true);
  tracker.noteFrame({ kind: 'complete', sessionId: 's1' });
  tracker.noteFrame({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'more' });
  assert.equal(tracker.isActive('s1'), true);
});

test('run tracker also tracks chat.edit-send and clears on error/protocol_error', () => {
  const tracker = createSessionRunTracker();
  tracker.noteOutgoing({ type: 'chat.edit-send', sessionId: 's1' });
  assert.equal(tracker.isActive('s1'), true);
  tracker.noteFrame({ kind: 'error', sessionId: 's1' });
  assert.equal(tracker.isActive('s1'), false);
  tracker.noteOutgoing({ type: 'chat.send', sessionId: 's1' });
  tracker.noteFrame({ kind: 'protocol_error', sessionId: 's1' });
  assert.equal(tracker.isActive('s1'), false);
});

test('chat_subscribed isProcessing overrides run state from the server', () => {
  const tracker = createSessionRunTracker();
  tracker.noteFrame({ kind: 'chat_subscribed', sessionId: 's1', isProcessing: true });
  assert.equal(tracker.isActive('s1'), true);
  tracker.noteFrame({ kind: 'chat_subscribed', sessionId: 's1', isProcessing: false });
  assert.equal(tracker.isActive('s1'), false);
});

test('frames without sessionId never flip another session state', () => {
  const tracker = createSessionRunTracker();
  tracker.noteOutgoing({ type: 'chat.send', sessionId: 's1' });
  tracker.noteFrame({ kind: 'complete' });
  tracker.noteFrame({ kind: 'chat_subscribed', isProcessing: false });
  assert.equal(tracker.isActive('s1'), true);
});

test('shouldLiveRefresh fires only for the open idle session on session_upserted', () => {
  const tracker = createSessionRunTracker();
  const frame = { kind: 'session_upserted', sessionId: 's1' };
  assert.equal(shouldLiveRefresh({ frame, openSessionId: 's1', runTracker: tracker }), true);
  assert.equal(shouldLiveRefresh({ frame, openSessionId: 's2', runTracker: tracker }), false);
  assert.equal(shouldLiveRefresh({ frame, openSessionId: null, runTracker: tracker }), false);
  assert.equal(
    shouldLiveRefresh({ frame: { kind: 'text', sessionId: 's1' }, openSessionId: 's1', runTracker: tracker }),
    false,
  );
  assert.equal(shouldLiveRefresh({ frame: {}, openSessionId: 's1', runTracker: tracker }), false);
});

test('shouldLiveRefresh skips when a web run is active or the flag is off', () => {
  const tracker = createSessionRunTracker();
  tracker.noteOutgoing({ type: 'chat.send', sessionId: 's1' });
  const frame = { kind: 'session_upserted', sessionId: 's1' };
  assert.equal(shouldLiveRefresh({ frame, openSessionId: 's1', runTracker: tracker }), false);
  tracker.noteFrame({ kind: 'complete', sessionId: 's1' });
  assert.equal(shouldLiveRefresh({ frame, openSessionId: 's1', runTracker: tracker }), true);
  assert.equal(shouldLiveRefresh({ frame, openSessionId: 's1', runTracker: tracker, enabled: false }), false);
});

test('scheduler debounces a burst into one fire 1.5s after the last trigger', () => {
  const clock = createFakeClock(0);
  const scheduler = createRefreshScheduler({
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const fired = [];
  scheduler.onFire(() => fired.push(clock.now()));
  scheduler.trigger();
  clock.advance(500);
  scheduler.trigger();
  clock.advance(500);
  scheduler.trigger();
  assert.equal(scheduler.pending, true);
  assert.equal(scheduler.scheduledFor, 2500);
  clock.advance(1499);
  assert.deepEqual(fired, []);
  clock.advance(1);
  assert.deepEqual(fired, [2500]);
  assert.equal(scheduler.pending, false);
  clock.advance(10000);
  assert.deepEqual(fired, [2500]);
});

test('scheduler rate limits to one fire per 3s', () => {
  const clock = createFakeClock(0);
  const scheduler = createRefreshScheduler({
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const fired = [];
  scheduler.onFire(() => fired.push(clock.now()));
  scheduler.trigger();
  clock.advance(1500);
  assert.deepEqual(fired, [1500]);
  // new write right after the refresh: earliest allowed fire is 1500+3000
  scheduler.trigger();
  assert.equal(scheduler.scheduledFor, 4500);
  clock.advance(2999);
  assert.deepEqual(fired, [1500]);
  clock.advance(1);
  assert.deepEqual(fired, [1500, 4500]);
});

test('scheduler cancel drops a pending refresh', () => {
  const clock = createFakeClock(0);
  const scheduler = createRefreshScheduler({
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const fired = [];
  scheduler.onFire(() => fired.push(clock.now()));
  scheduler.trigger();
  scheduler.cancel();
  assert.equal(scheduler.pending, false);
  clock.advance(10000);
  assert.deepEqual(fired, []);
});

test('scheduler swallows a throwing onFire callback', () => {
  const clock = createFakeClock(0);
  const scheduler = createRefreshScheduler({
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  scheduler.onFire(() => {
    throw new Error('boom');
  });
  scheduler.trigger();
  clock.advance(2000);
  assert.equal(scheduler.lastFiredAt, 1500);
});

test('refreshBlockedByUnsentInput blocks only non-blank input text (rule 2)', () => {
  assert.equal(refreshBlockedByUnsentInput(''), false);
  assert.equal(refreshBlockedByUnsentInput('   \n\t '), false);
  assert.equal(refreshBlockedByUnsentInput(null), false);
  assert.equal(refreshBlockedByUnsentInput(undefined), false);
  assert.equal(refreshBlockedByUnsentInput(42), false);
  assert.equal(refreshBlockedByUnsentInput('draft the reply'), true);
  assert.equal(refreshBlockedByUnsentInput(' تم '), true);
});

test('openSessionFromLocation reads the /session/:id route and tolerates junk', () => {
  assert.equal(openSessionFromLocation({ pathname: '/session/abc-123' }), 'abc-123');
  assert.equal(openSessionFromLocation({ pathname: '/session/abc/extra' }), 'abc');
  assert.equal(openSessionFromLocation({ pathname: '/' }), null);
  assert.equal(openSessionFromLocation({ pathname: '/session/' }), null);
  assert.equal(openSessionFromLocation(null), null);
  assert.equal(
    openSessionFromLocation({
      get pathname() {
        throw new Error('no location');
      },
    }),
    null,
  );
});
