// WO-3 (owner rulings R1/R2/R7, 2026-10-09): Jimmy is bound to exactly the
// open session (URL only), never starts a session, drops 'after' orders on
// hang-up, and never sends an order twice. Behavioural: the real bridge
// (lib/voice-bridge.mjs) driven through the real session binding, call
// actions and composer sender (lib/session-target.mjs) against a fake
// CloudCLI page whose submit emits chat.send rows the way the app does.
// Acceptance (plan AC3/AC7) -> tests:
//   a voice 'now' order sends exactly 1 row ........ 'AC now', 'AC after+now'
//   an 'after' order with hang-up sends nothing ...... 'AC hang-up'
//   concurrent sends -> 1 ............................ 'AC concurrent'
//   New chat (no session open) is refused ............ 'AC New chat'
//   voice words never create a session ............... 'AC never creates'
//   a call stays pinned across a UI session switch ... 'AC pinned', 'AC pinned in flight'
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressLog } from '../lib/progress-log.mjs';
import { createVoiceBridge } from '../lib/voice-bridge.mjs';
import {
  NO_SESSION_OPEN,
  COMPOSER_IDLE_WAIT_MS,
  urlSessionId,
  createCallTarget,
  composerSendBlock,
  composerIdleFrom,
  isSameOriginSocketUrl,
  createComposerSender,
  createCallActions,
} from '../lib/session-target.mjs';

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A fake CloudCLI page + a live call wired exactly like voice-addon.js:
 * createCallTarget -> createCallActions -> createComposerSender ->
 * createVoiceBridge. The page's submit behaves like the app:
 *   - plain send mode: one chat.send row for the URL session; with no
 *     session in the URL the server would START a new session (newSessions);
 *   - queue/stop mode (a run streams): the app queues the text (appQueued) —
 *     a second copy later. WO-3 must never get there.
 * A chat.abort ends the run after `abortLatencyMs` of bridge waiting (null =
 * never), like the server's late 'complete'.
 */
function harness({ path = '/', abortLatencyMs = 300, insertAndSend = null } = {}) {
  const page = {
    location: { pathname: path },
    // What the removed first-frame capture / last-seen socket session would
    // hold: a stale session from an earlier chat. It must never be a target.
    currentSession: 'STALE',
    composer: { text: '', idle: true },
    rows: [],
    appQueued: [],
    newSessions: 0,
    frames: [],
    submitOk: true,
    onSettle: null,
  };
  const busy = new Set();
  const progressLog = createProgressLog();
  const call = { active: false, ended: 0 };
  const abortsDue = new Map(); // sessionId -> fake clock when the aborted run ends
  let clock = 0;
  let seq = 1000; // above the seq of frames a test feeds by hand (the progress log drops older ones)

  function onScreen() {
    return urlSessionId(page.location);
  }
  function startRun(sessionId) {
    busy.add(sessionId);
    if (onScreen() === sessionId) page.composer.idle = false;
  }
  function complete(sessionId) {
    busy.delete(sessionId);
    abortsDue.delete(sessionId);
    if (onScreen() === sessionId) page.composer.idle = true;
    seq += 1;
    progressLog.feed({ kind: 'complete', sessionId, seq });
  }

  const socket = {
    readyState: 1,
    send(raw) {
      const frame = JSON.parse(raw);
      page.frames.push(frame);
      if (frame.type === 'chat.abort' && busy.has(frame.sessionId) && abortLatencyMs !== null) {
        abortsDue.set(frame.sessionId, clock + abortLatencyMs);
      }
      if (frame.type === 'chat.permission-response') {
        seq += 1;
        progressLog.feed({ kind: 'permission_resolved', sessionId: onScreen(), requestId: frame.requestId, seq });
      }
    },
  };

  // NEGATIVE-CONTROL HOOK: the page's session reader — URL only, no fallback (R1).
  const readOpenSession = () => urlSessionId(page.location);
  const target = createCallTarget({ readOpenSession });
  const composer = createComposerSender({
    readComposer: () => ({ text: page.composer.text, idle: page.composer.idle }),
    insertText: (text) => {
      page.composer.text = page.composer.text ? `${page.composer.text} ${text}` : text;
      return true;
    },
    removeText: (text) => {
      page.composer.text = page.composer.text.replace(text, '').trim();
    },
    submit: async () => {
      if (!page.submitOk) return false;
      const content = page.composer.text;
      page.composer.text = '';
      if (!page.composer.idle) {
        page.appQueued.push(content);
        return true;
      }
      const sessionId = onScreen();
      page.rows.push(sessionId ? { type: 'chat.send', sessionId, content, busyAtSubmit: busy.has(sessionId) } : { type: 'chat.send', content });
      if (!sessionId) page.newSessions += 1;
      return true;
    },
    settle: async () => {
      if (typeof page.onSettle === 'function') page.onSettle();
    },
    waitFor: async (predicate) => Boolean(predicate()),
  });
  const actions = createCallActions({
    readOpenSession,
    callTarget: target,
    isCallActive: () => call.active,
    getSocket: () => socket,
    composer,
  });
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: (id) => busy.has(id) },
    getSession: () => actions.callSession(),
    insertAndSend: insertAndSend || ((text, sessionId) => actions.insertAndSendTo(text, sessionId)),
    abort: () => actions.sendAbort(),
    isCallActive: () => call.active,
    sendPermissionResponse: async (frame) => actions.sendPermissionResponse(frame),
    delay: async (ms) => {
      clock += ms;
      for (const [sessionId, at] of [...abortsDue]) if (clock >= at) complete(sessionId);
    },
    now: () => clock,
  });

  const api = {
    page,
    target,
    actions,
    progressLog,
    busy,
    bridge,
    call,
    startRun,
    complete,
    rows: (sessionId) => page.rows.filter((row) => sessionId === undefined || row.sessionId === sessionId),
    aborts: () => page.frames.filter((frame) => frame.type === 'chat.abort'),
    startCall() {
      call.active = true;
      target.begin();
      bridge.resetOwnerWords();
    },
    endCall() {
      call.active = false;
      call.ended += 1;
      target.end();
      if (typeof bridge.callEnded === 'function') bridge.callEnded();
    },
    navigate(pathname) {
      page.location.pathname = pathname;
      page.composer.idle = !busy.has(onScreen());
      if (call.active && target.sync() === 'end') api.endCall();
    },
  };
  return api;
}

const ASK = (requestId = 'q1') => ({
  kind: 'permission_request',
  sessionId: 'A',
  requestId,
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which colour?', options: ['Red', 'Blue'] }] },
});

// --- R1: no session on screen ------------------------------------------------

test('AC New chat: a no-session screen (New chat / project) refuses every mutating tool, even with a stale last-seen session', async () => {
  for (const path of ['/', '/projects${AI_SETUP_ROOT}', '/session/default']) {
    const h = harness({ path });
    h.startCall();
    h.bridge.markUserTurn('ابعتله');
    const sent = await h.bridge.tools.send_to_claude({ instruction: 'run the tests' });
    assert.equal(sent.error, NO_SESSION_OPEN, path);
    assert.match(sent.note, /open the session first/);
    assert.equal((await h.bridge.tools.send_to_claude({ instruction: 'run the tests', when: 'now' })).error, NO_SESSION_OPEN);
    assert.equal((await h.bridge.tools.send_to_claude({ instruction: 'run the tests', when: 'after' })).error, NO_SESSION_OPEN);
    assert.equal((await h.bridge.tools.stop_claude()).error, NO_SESSION_OPEN);
    assert.equal((await h.bridge.tools.answer_claude_question({ answers: { 'Which colour?': 'Red' } })).error, NO_SESSION_OPEN);
    // the add-on's own actions refuse too, even when handed the stale session
    assert.deepEqual(await h.actions.insertAndSendTo('x', 'STALE'), { error: NO_SESSION_OPEN });
    assert.equal(h.actions.sendAbort(), false);
    assert.equal(h.actions.sendPermissionResponse({ type: 'chat.permission-response', requestId: 'q1' }), false);
    assert.deepEqual(h.page.rows, [], 'nothing typed into the New-chat composer');
    assert.deepEqual(h.page.frames, [], 'no abort and no answer left the page');
    assert.equal(h.page.composer.text, '');
    const status = await h.bridge.tools.get_claude_status();
    assert.equal(status.sessionOpen, false);
  }
});

test('AC never creates: voice words never create a session — the New-chat composer is never typed into or submitted', async () => {
  const h = harness({ path: '/' });
  h.page.composer.text = 'owner draft';
  h.startCall();
  for (const when of [undefined, 'now', 'after']) {
    h.bridge.markUserTurn('اعمل شات جديد وابعتله');
    assert.equal((await h.bridge.tools.send_to_claude({ instruction: 'start a new chat and fix it', when })).error, NO_SESSION_OPEN);
  }
  h.complete('A');
  await settle();
  assert.equal(h.page.newSessions, 0, 'no chat.send without a session id');
  assert.deepEqual(h.page.rows, []);
  assert.deepEqual(h.page.appQueued, []);
  assert.equal(h.page.composer.text, 'owner draft', 'the New-chat composer is untouched');
  assert.equal(h.target.pinned(), null, 'nothing bound');
});

test('R1: a refused tool hands the owner turn back (nothing was done)', async () => {
  const h = harness({ path: '/' });
  h.startCall();
  h.bridge.markUserTurn('ابعتله');
  assert.equal((await h.bridge.tools.send_to_claude({ instruction: 'x' })).error, NO_SESSION_OPEN);
  h.navigate('/session/A'); // the owner opens the session
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  assert.equal(h.rows('A').length, 1);
  assert.equal(h.page.newSessions, 0);
});

// --- R1/R7: one call <-> one session ------------------------------------------

test('R7: /session/A -> the call reads, sends, stops and answers A only', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  assert.equal(h.target.pinned(), 'A');
  h.progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 'B', content: 'B reply', seq: 1 });
  h.progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 'A', content: 'A reply', seq: 2 });
  assert.equal((await h.bridge.tools.get_claude_status()).lastAssistantText, 'A reply');
  h.bridge.markUserTurn('ابعت');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'راجع' }), { result: 'sent' });
  assert.deepEqual(h.page.rows.map((row) => row.sessionId), ['A']);
  h.bridge.markUserTurn('وقفه');
  assert.deepEqual(await h.bridge.tools.stop_claude(), { result: 'stopped' });
  assert.deepEqual(h.aborts(), [{ type: 'chat.abort', sessionId: 'A' }]);
  h.progressLog.feed({ ...ASK('q1'), seq: 3 });
  h.bridge.markUserTurn('الأحمر');
  assert.deepEqual(await h.bridge.tools.answer_claude_question({ answers: { 'Which colour?': 'Red' } }), { result: 'answered' });
  const answers = h.page.frames.filter((frame) => frame.type === 'chat.permission-response');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].requestId, 'q1');
});

test('AC pinned: switching the screen to another session ends the call; B is never touched or adopted', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.navigate('/session/B');
  assert.equal(h.call.active, false);
  assert.equal(h.call.ended, 1);
  assert.equal(h.target.pinned(), null, 'the call never follows the screen to B');
  h.bridge.markUserTurn('ابعت');
  assert.equal((await h.bridge.tools.send_to_claude({ instruction: 'x' })).error, NO_SESSION_OPEN);
  assert.equal((await h.bridge.tools.stop_claude()).error, NO_SESSION_OPEN);
  // an order bound to A while B is on screen never lands in B's composer
  assert.deepEqual(await h.actions.insertAndSendTo('x', 'A'), { error: NO_SESSION_OPEN });
  assert.deepEqual(h.page.rows, []);
  assert.deepEqual(h.page.frames, []);
});

test('AC pinned in flight: a send whose screen switches before the submit never lands in the new session', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.page.onSettle = () => {
    h.page.onSettle = null;
    h.navigate('/session/B'); // the owner clicks another session while React commits the text
  };
  h.bridge.markUserTurn('ابعت');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'راجع الكود' }), { error: NO_SESSION_OPEN });
  assert.deepEqual(h.page.rows, [], 'nothing submitted into B');
  assert.equal(h.page.composer.text, '', 'the inserted text was taken back out');
  assert.equal(h.call.active, false, 'the switch hung the call up');
});

test('R7: New chat in between keeps the call but refuses; back on A works again; a new session B ends it', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.navigate('/');
  assert.equal(h.call.active, true);
  h.bridge.markUserTurn('ابعت');
  assert.equal((await h.bridge.tools.send_to_claude({ instruction: 'x' })).error, NO_SESSION_OPEN);
  h.navigate('/session/A');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  h.navigate('/');
  h.navigate('/session/B'); // e.g. the owner started a new chat by hand
  assert.equal(h.call.active, false);
  assert.deepEqual(h.page.rows.map((row) => row.sessionId), ['A']);
  assert.equal(h.page.newSessions, 0);
});

test('R1: a call started on New chat binds the first session the owner opens, then only that one', () => {
  const target = createCallTarget({ readOpenSession: (() => {
    const seq = [null, null, 'A', 'A', 'B'];
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)];
  })() });
  assert.equal(target.begin(), null);
  assert.equal(target.sync(), 'keep');
  assert.equal(target.sync(), 'adopted');
  assert.equal(target.current(), 'A');
  assert.equal(target.sync(), 'end');
  target.end();
  assert.equal(target.current(), null);
  assert.equal(target.sync(), 'idle');
});

// --- R2: 'after' orders do not survive hang-up --------------------------------

test('AC hang-up: queue -> endCall -> complete sends nothing', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('بعد ما يخلص');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'اعمل كذا', when: 'after' }), { result: 'queued' });
  h.endCall();
  h.complete('A');
  await settle();
  assert.deepEqual(h.page.rows, []);
  assert.deepEqual(h.page.appQueued, []);
  assert.equal(h.page.composer.text, '');
  if (typeof h.bridge.ordersNote === 'function') assert.equal(h.bridge.ordersNote(), '', 'the dropped order is not listed either');
});

test('R2: even without callEnded, a flush never happens outside a live call', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('بعد ما يخلص');
  await h.bridge.tools.send_to_claude({ instruction: 'اعمل كذا', when: 'after' });
  h.call.active = false; // the page lost the call without the hang-up path
  h.complete('A');
  h.call.active = true;
  h.complete('A');
  await settle();
  assert.deepEqual(h.page.rows, [], 'the dropped order never comes back');
});

test('R2: queued text is never appended to the owner draft (composer_busy) and Jimmy is told', async () => {
  const pushes = [];
  const h = harness({ path: '/session/A' });
  h.bridge.onComplete((update) => pushes.push(update));
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('بعد ما يخلص');
  await h.bridge.tools.send_to_claude({ instruction: 'اعمل كذا', when: 'after' });
  h.page.composer.text = 'owner draft'; // the owner types while the run streams
  h.complete('A');
  await settle();
  assert.ok(pushes.some((u) => u.type === 'app' && /NOT sent: the chat box holds text the owner typed/.test(u.text)), JSON.stringify(pushes));
  assert.equal(h.page.composer.text, 'owner draft', 'the draft is untouched');
  assert.deepEqual(h.page.rows, []);
  h.bridge.markUserTurn('ابعته');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'حاجة تانية' }), { error: 'composer_busy' });
  assert.equal(h.page.composer.text, 'owner draft');
});

// --- concurrency + dedupe -----------------------------------------------------

test('AC concurrent: two concurrent sends through the page -> exactly ONE row', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.bridge.markUserTurn('ابعتله');
  const [first, second] = await Promise.all([
    h.bridge.tools.send_to_claude({ instruction: 'شغّل التستات' }),
    h.bridge.tools.send_to_claude({ instruction: 'شغّل التستات' }),
  ]);
  assert.deepEqual(first, { result: 'sent' });
  assert.deepEqual(second, { error: 'no_user_turn' });
  assert.equal(h.rows('A').length, 1);
  assert.deepEqual(h.page.appQueued, []);
});

test('two concurrent sends -> ONE insertAndSend (gate taken synchronously)', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const inserts = [];
  const h = harness({
    path: '/session/A',
    insertAndSend: async (text) => {
      inserts.push(text);
      await slow;
      return true;
    },
  });
  h.startCall();
  h.bridge.markUserTurn('ابعتله');
  const first = h.bridge.tools.send_to_claude({ instruction: 'شغّل التستات' });
  const second = h.bridge.tools.send_to_claude({ instruction: 'شغّل التستات' });
  release();
  assert.deepEqual(await first, { result: 'sent' });
  assert.deepEqual(await second, { error: 'no_user_turn' });
  assert.equal(inserts.length, 1);
});

test('the owner speaking again mid-send cannot double it: mutex + 120 s dedupe -> already_sent', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let inFlight = 0;
  let maxInFlight = 0;
  const inserts = [];
  const h = harness({
    path: '/session/A',
    insertAndSend: async (text) => {
      inserts.push(text);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await slow;
      inFlight -= 1;
      return true;
    },
  });
  h.startCall();
  h.bridge.markUserTurn('ابعتله');
  const first = h.bridge.tools.send_to_claude({ instruction: 'شغّل التستات' });
  h.bridge.markUserTurn(' يلا'); // more owner speech re-arms the gate meanwhile
  const second = h.bridge.tools.send_to_claude({ instruction: 'شغّل  التستات ' });
  release();
  assert.deepEqual(await first, { result: 'sent' });
  assert.equal((await second).result, 'already_sent');
  assert.equal(inserts.length, 1);
  assert.equal(maxInFlight, 1, 'never two inserts into the composer at once');
});

test('a different order after the dedupe window and a different text both go out', async () => {
  let clock = 0;
  const progressLog = createProgressLog();
  const sent = [];
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 'A',
    insertAndSend: async (text) => {
      sent.push(text);
      return true;
    },
    abort: () => {},
    isCallActive: () => true,
    now: () => clock,
  });
  bridge.markUserTurn('1');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  clock += 119000;
  bridge.markUserTurn('2');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'already_sent', secondsAgo: 119 });
  bridge.markUserTurn('3');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'y' }), { result: 'sent' });
  clock += 2000;
  bridge.markUserTurn('4');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  assert.equal(sent.length, 3);
});

test('a failed submit takes the text back, hands the turn back and is not remembered as sent', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.page.submitOk = false;
  h.bridge.markUserTurn('ابعتله');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x' }), { error: 'send_failed' });
  assert.equal(h.page.composer.text, '', 'the inserted text was removed');
  assert.deepEqual(h.page.rows, []);
  h.page.submitOk = true;
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  assert.equal(h.rows('A').length, 1);
});

// --- when='now' -----------------------------------------------------------------

test('AC now: a now order during a run -> abort, wait until inactive, exactly ONE row', async () => {
  const h = harness({ path: '/session/A', abortLatencyMs: 700 });
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('قاطعه');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'وقف واعمل كذا', when: 'now' }), { result: 'sent' });
  await settle();
  assert.equal(h.aborts().length, 1);
  assert.equal(h.rows('A').length, 1);
  assert.equal(h.rows('A')[0].busyAtSubmit, false, 'submitted only after the run ended');
  assert.deepEqual(h.page.appQueued, [], 'never submitted in queue/stop mode');
});

test('now during a run -> abort, then ONE submit only after the tracker shows the session inactive', async () => {
  const progressLog = createProgressLog();
  const busy = new Set(['A']);
  const order = [];
  let polls = 0;
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: (id) => busy.has(id) },
    getSession: () => 'A',
    insertAndSend: async () => {
      order.push(`send(busy=${busy.has('A')})`);
      return true;
    },
    abort: () => order.push('abort'),
    isCallActive: () => true,
    delay: async (ms) => {
      polls += 1;
      order.push(`wait:${ms}`);
      if (polls === 3) busy.delete('A'); // the aborted run's complete lands
    },
  });
  bridge.markUserTurn('قاطعه');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'وقف واعمل كذا', when: 'now' }), { result: 'sent' });
  assert.deepEqual(order, ['abort', 'wait:100', 'wait:100', 'wait:100', 'send(busy=false)']);
});

test('now: a run that does not stop within 5 s -> still_running, nothing typed or submitted', async () => {
  const h = harness({ path: '/session/A', abortLatencyMs: null });
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('قاطعه');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x', when: 'now' }), { error: 'still_running' });
  assert.deepEqual(h.page.rows, []);
  assert.deepEqual(h.page.appQueued, []);
  assert.equal(h.page.composer.text, '');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x', when: 'now' }), { error: 'no_user_turn' }, 'the abort was an action');
});

test('now: the tracker says idle but the composer is still in queue/stop mode -> still_running, never queued by the app', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.page.composer.idle = false; // React has not left stop mode
  h.bridge.markUserTurn('ابعت');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'x' }), { error: 'still_running' });
  assert.deepEqual(h.page.appQueued, []);
  assert.deepEqual(h.page.rows, []);
  assert.equal(h.page.composer.text, '', 'nothing was inserted');
});

test('AC after+now: an after order, then now -> exactly ONE row (the abort completion cannot flush a second copy)', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('بعد ما يخلص');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'راجع الكود', when: 'after' }), { result: 'queued' });
  h.bridge.markUserTurn('لا دلوقتي');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'راجع الكود', when: 'now' }), { result: 'sent' });
  await settle();
  h.startRun('A'); // Claude works on it ...
  h.complete('A'); // ... and finishes: nothing may flush now
  await settle();
  assert.equal(h.rows('A').length, 1, JSON.stringify(h.page.rows));
  assert.equal(h.rows('A')[0].busyAtSubmit, false);
  assert.deepEqual(h.page.appQueued, []);
});

test('a now-send replacing a DIFFERENT queued order clears it and says so', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  h.startRun('A');
  h.bridge.markUserTurn('بعدين');
  await h.bridge.tools.send_to_claude({ instruction: 'order one', when: 'after' });
  h.bridge.markUserTurn('دلوقتي');
  assert.deepEqual(await h.bridge.tools.send_to_claude({ instruction: 'order two', when: 'now' }), { result: 'sent', queuedDropped: true });
  h.complete('A');
  await settle();
  assert.deepEqual(h.page.rows.map((row) => row.content.split('\n')[0]), ['order two']);
});

test('P10: busy only with background work (no run) -> now is a plain send: no abort', async () => {
  const progressLog = createProgressLog();
  const aborts = [];
  const sent = [];
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 'A',
    insertAndSend: async (text) => {
      sent.push(text);
      return true;
    },
    abort: () => aborts.push('abort'),
    isCallActive: () => true,
    getBackgroundTasks: () => ({ running: 2, names: ['agent', 'build'] }),
    delay: async () => {},
  });
  bridge.markUserTurn('دلوقتي');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x', when: 'now' }), { result: 'sent' });
  assert.deepEqual(aborts, []);
  assert.equal(sent.length, 1);
});

test('stop: a screen that changed while an earlier action held the lock -> no_session_open, no abort', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const h = harness({
    path: '/session/A',
    insertAndSend: async () => {
      await slow;
      return true;
    },
  });
  h.startCall();
  h.bridge.markUserTurn('ابعت');
  const send = h.bridge.tools.send_to_claude({ instruction: 'x' });
  h.bridge.markUserTurn('وقفه');
  const stop = h.bridge.tools.stop_claude();
  h.navigate('/'); // New chat while the send holds the lock
  release();
  assert.deepEqual(await send, { result: 'sent' });
  assert.equal((await stop).error, NO_SESSION_OPEN);
  assert.deepEqual(h.aborts(), []);
});

// --- reconnect briefing ---------------------------------------------------------

test('ordersNote lists this call\'s sent orders and the queued one; a new call starts empty', async () => {
  const h = harness({ path: '/session/A' });
  h.startCall();
  assert.equal(h.bridge.ordersNote(), '');
  h.bridge.markUserTurn('1');
  await h.bridge.tools.send_to_claude({ instruction: 'first order' });
  h.startRun('A');
  h.bridge.markUserTurn('2');
  await h.bridge.tools.send_to_claude({ instruction: 'second order', when: 'after' });
  const note = h.bridge.ordersNote();
  assert.match(note, /^\[SESSION CONTEXT\] Orders this call already relayed to Claude/);
  assert.match(note, /1\) sent: first order/);
  assert.match(note, /2\) queued, goes when the run finishes: second order/);
  assert.ok(!/owner's exact words/.test(note), 'only the order text, never the raw owner words');
  h.endCall();
  h.startCall();
  assert.equal(h.bridge.ordersNote(), '');
});

// --- pure units ---------------------------------------------------------------

test('composer guard: never the New-chat composer, never the owner draft, never queue/stop mode', () => {
  const base = { openSession: 'A', target: 'A', composerText: '', composerIdle: true };
  assert.equal(composerSendBlock(base), null);
  assert.equal(composerSendBlock({ ...base, openSession: null }), NO_SESSION_OPEN);
  assert.equal(composerSendBlock({ ...base, target: null }), NO_SESSION_OPEN);
  assert.equal(composerSendBlock({ ...base, openSession: 'B' }), NO_SESSION_OPEN);
  assert.equal(composerSendBlock({ ...base, composerText: '  owner draft ' }), 'composer_busy');
  assert.equal(composerSendBlock({ ...base, composerText: '   ' }), null);
  assert.equal(composerSendBlock({ ...base, composerIdle: false }), 'still_running');
  assert.equal(composerIdleFrom({ hasForm: true, hasSubmitButton: true }), true);
  assert.equal(composerIdleFrom({ hasForm: true, hasSubmitButton: false }), false, 'type=button = queue/stop mode');
  assert.equal(composerIdleFrom({ hasForm: false, hasSubmitButton: false }), true);
});

test('urlSessionId: only the /session/<id> route counts', () => {
  assert.equal(urlSessionId({ pathname: '/session/abc-123' }), 'abc-123');
  assert.equal(urlSessionId({ pathname: '/session/abc/' }), 'abc');
  assert.equal(urlSessionId({ pathname: '/' }), null);
  assert.equal(urlSessionId({ pathname: '/session/default' }), null);
  assert.equal(urlSessionId({ pathname: '/projects/x' }), null);
  assert.equal(urlSessionId(null), null);
});

test('isSameOriginSocketUrl: only the page origin is the chat socket', () => {
  const location = { host: 'agent.example', href: 'https://agent.example/session/A' };
  assert.equal(isSameOriginSocketUrl('wss://agent.example/ws', location), true);
  assert.equal(isSameOriginSocketUrl('/ws', location), true, 'relative = page origin');
  assert.equal(isSameOriginSocketUrl('https://agent.example/ws', location), true);
  assert.equal(isSameOriginSocketUrl(new URL('wss://agent.example/ws?x=1'), location), true);
  assert.equal(isSameOriginSocketUrl('wss://generativelanguage.googleapis.com/ws/live', location), false);
  assert.equal(isSameOriginSocketUrl('https://evil.example/ws', location), false);
  assert.equal(isSameOriginSocketUrl('wss://agent.example:8443/ws', location), false, 'another port is another origin');
  assert.equal(isSameOriginSocketUrl('wss://agent.example/ws', { host: 'agent.example' }), true, 'no href: host only');
  assert.equal(isSameOriginSocketUrl('wss://anything/ws', null), true, 'no page location keeps the old wrap-all');
});

function fakeComposer({ text = '', idle = true, submitResult = true } = {}) {
  const state = { text, idle, submits: 0, inserts: 0, waits: [] };
  const sender = createComposerSender({
    readComposer: () => (state.gone ? null : { text: state.text, idle: state.idle }),
    insertText: (value) => {
      state.inserts += 1;
      state.text = state.text ? `${state.text} ${value}` : value;
      return true;
    },
    removeText: (value) => {
      state.text = state.text.replace(value, '').trim();
    },
    submit: async () => {
      state.submits += 1;
      if (typeof submitResult === 'function') return submitResult(state);
      if (submitResult === true) state.text = '';
      return submitResult;
    },
    settle: async () => {
      if (typeof state.onSettle === 'function') state.onSettle(state);
    },
    waitFor: async (predicate, ms) => {
      state.waits.push(ms);
      return Boolean(predicate());
    },
  });
  return { state, sender };
}

test('createComposerSender: types only into an empty composer of the target session and submits once', async () => {
  const open = () => 'A';
  const ok = fakeComposer();
  assert.equal(await ok.sender.send('x', { target: 'A', readOpenSession: open }), true);
  assert.equal(ok.state.submits, 1);
  const draft = fakeComposer({ text: 'owner draft' });
  assert.deepEqual(await draft.sender.send('x', { target: 'A', readOpenSession: open }), { error: 'composer_busy' });
  assert.equal(draft.state.inserts, 0);
  assert.equal(draft.state.text, 'owner draft');
  const other = fakeComposer();
  assert.deepEqual(await other.sender.send('x', { target: 'A', readOpenSession: () => 'B' }), { error: NO_SESSION_OPEN });
  assert.deepEqual(await other.sender.send('x', { target: 'A', readOpenSession: () => null }), { error: NO_SESSION_OPEN });
  assert.deepEqual(await other.sender.send('x', { target: null, readOpenSession: () => null }), { error: NO_SESSION_OPEN });
  assert.equal(other.state.inserts, 0);
  const none = fakeComposer();
  none.state.gone = true;
  assert.equal(await none.sender.send('x', { target: 'A', readOpenSession: open }), false);
  assert.equal(none.state.inserts, 0);
});

test('createComposerSender: waits up to 2 s for plain send mode, re-checks after React commits, takes the text back on failure', async () => {
  const open = () => 'A';
  const stuck = fakeComposer({ idle: false });
  assert.deepEqual(await stuck.sender.send('x', { target: 'A', readOpenSession: open }), { error: 'still_running' });
  assert.deepEqual(stuck.state.waits, [COMPOSER_IDLE_WAIT_MS]);
  assert.equal(COMPOSER_IDLE_WAIT_MS, 2000);
  assert.equal(stuck.state.inserts, 0);
  const flips = fakeComposer();
  flips.state.onSettle = (state) => {
    state.idle = false; // a run started between the insert and the submit
  };
  assert.deepEqual(await flips.sender.send('x', { target: 'A', readOpenSession: open }), { error: 'still_running' });
  assert.equal(flips.state.submits, 0, 'never submitted in queue/stop mode');
  assert.equal(flips.state.text, '', 'the inserted text was taken back');
  const fails = fakeComposer({ submitResult: false });
  assert.equal(await fails.sender.send('x', { target: 'A', readOpenSession: open }), false);
  assert.equal(fails.state.text, '');
  const throws = fakeComposer({
    submitResult: () => {
      throw new Error('boom');
    },
  });
  assert.equal(await throws.sender.send('x', { target: 'A', readOpenSession: open }), false);
  assert.equal(throws.state.text, '');
});

test('createCallActions: abort and answers only for the call session on screen; a closed socket sends nothing', async () => {
  const frames = [];
  const socket = { readyState: 1, send: (raw) => frames.push(JSON.parse(raw)) };
  let path = '/session/A';
  let active = true;
  const readOpenSession = () => urlSessionId({ pathname: path });
  const target = createCallTarget({ readOpenSession });
  target.begin();
  const actions = createCallActions({
    readOpenSession,
    callTarget: target,
    isCallActive: () => active,
    getSocket: () => socket,
    composer: null,
  });
  assert.equal(actions.callSession(), 'A');
  assert.equal(actions.sendAbort(), true);
  assert.equal(actions.sendPermissionResponse({ type: 'chat.permission-response', requestId: 'q' }), true);
  path = '/';
  assert.equal(actions.callSession(), null);
  assert.equal(actions.sendAbort(), false);
  assert.equal(actions.sendPermissionResponse({ type: 'chat.permission-response', requestId: 'q' }), false);
  assert.deepEqual(await actions.insertAndSendTo('x'), { error: NO_SESSION_OPEN });
  path = '/session/A';
  assert.equal(await actions.insertAndSendTo('x'), false, 'no composer -> not sent');
  socket.readyState = 3;
  assert.equal(actions.sendAbort(), false);
  socket.readyState = 1;
  active = false;
  assert.equal(actions.callSession(), null, 'no call -> no session');
  assert.equal(actions.sendAbort(), false);
  assert.deepEqual(frames, [
    { type: 'chat.abort', sessionId: 'A' },
    { type: 'chat.permission-response', requestId: 'q' },
  ]);
});
