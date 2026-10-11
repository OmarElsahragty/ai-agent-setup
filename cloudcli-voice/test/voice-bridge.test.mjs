// WO-VL-UI: lib/voice-bridge.mjs — Gemini tool semantics against the open
// Claude Code session: no_session / ask_owner / queued+flush / sent / stopped,
// and proactive pushes ONLY while a call is active.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressLog } from '../lib/progress-log.mjs';
import { createVoiceBridge as createRawBridge, splitParts } from '../lib/voice-bridge.mjs';

// Wave-1 security: the F8 gate now starts closed. Most tests model a call in
// which the owner already spoke; the gate's own start is pinned below.
function createVoiceBridge(deps) {
  const bridge = createRawBridge(deps);
  bridge.markUserTurn('');
  return bridge;
}

function makeDeps({ session = 's1', busySessions = new Set(), active = false, abortStops = false } = {}) {
  const sent = [];
  const aborted = [];
  const delays = [];
  const order = [];
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: (id) => busySessions.has(id) },
    getSession: () => session,
    insertAndSend: async (text) => {
      sent.push(text);
      order.push('send');
      return true;
    },
    abort: () => {
      aborted.push('abort');
      order.push('abort');
      if (abortStops) busySessions.clear(); // the aborted run ends (its 'complete' lands)
    },
    delay: async (ms) => {
      delays.push(ms);
      order.push(`delay:${ms}`);
    },
    isCallActive: () => active, // R2: an after-queue flushes only inside a live call
  });
  return { bridge, progressLog, sent, aborted, delays, order, busySessions };
}

test('R1: send_to_claude with no open session returns no_session_open + what to tell the owner', async () => {
  const { bridge, sent } = makeDeps({ session: null });
  const result = await bridge.tools.send_to_claude({ instruction: 'run the tests' });
  assert.equal(result.error, 'no_session_open');
  assert.match(result.note, /open the session first/);
  assert.equal(sent.length, 0);
});

test('send_to_claude while busy without `when` asks the owner', async () => {
  const { bridge, sent } = makeDeps({ busySessions: new Set(['s1']) });
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'run the tests' }), { result: 'ask_owner' });
  // wave-1 security: the question consumed the owner's turn — only a spoken answer may act
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'run the tests', when: 'now' }), { error: 'no_user_turn' });
  bridge.markUserTurn('مش فاهم');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'run the tests', when: 'later' }), { result: 'ask_owner' });
  assert.equal(sent.length, 0);
});

test('send_to_claude while idle inserts and sends', async () => {
  const { bridge, sent } = makeDeps();
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) run the tests' }), { result: 'sent' });
  assert.deepEqual(sent, ['(voice) run the tests']);
});

test('F2/WO-3: send_to_claude when=now while busy aborts first, waits until the run ended, then sends', async () => {
  const { bridge, sent, aborted, delays, order } = makeDeps({ busySessions: new Set(['s1']), abortStops: true });
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'stop and restart', when: 'now' }), { result: 'sent' });
  assert.deepEqual(sent, ['stop and restart']);
  assert.deepEqual(aborted, ['abort']);
  assert.deepEqual(delays, [100]);
  assert.deepEqual(order, ['abort', 'delay:100', 'send']); // abort BEFORE the new send
});

test('empty instruction is rejected', async () => {
  const { bridge } = makeDeps();
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '   ' }), { error: 'no_instruction' });
});

test('busy when=after queues; the next complete flushes it', async () => {
  const { bridge, progressLog, sent, busySessions } = makeDeps({ busySessions: new Set(['s1']), active: true });
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'after it finishes', when: 'after' }), { result: 'queued' });
  assert.equal(sent.length, 0);
  busySessions.delete('s1'); // the run completes
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'done', seq: 1 });
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 2 });
  assert.deepEqual(sent, ['after it finishes']);
});

test('the queue holds ONE slot — the latest instruction wins', async () => {
  const { bridge, progressLog, sent, busySessions } = makeDeps({ busySessions: new Set(['s1']), active: true });
  await bridge.tools.send_to_claude({ instruction: 'first idea', when: 'after' });
  bridge.markUserTurn(); // F8: one utterance powers one action — the owner spoke again
  await bridge.tools.send_to_claude({ instruction: 'second idea', when: 'after' });
  busySessions.delete('s1');
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 });
  assert.deepEqual(sent, ['second idea']);
});

test('a queued instruction is NOT flushed while the session is still busy', async () => {
  const { bridge, progressLog, sent } = makeDeps({ busySessions: new Set(['s1']) });
  await bridge.tools.send_to_claude({ instruction: 'later please', when: 'after' });
  progressLog.feed({ kind: 'complete', sessionId: 'other', seq: 1 }); // another session completed
  assert.equal(sent.length, 0);
});

test('a failed insert+send reports send_failed', async () => {
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => false,
    abort: () => {},
  });
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'go' }), { error: 'send_failed' });
});

test('stop_claude aborts the run and reports stopped', async () => {
  const { bridge, aborted } = makeDeps();
  assert.deepEqual(await bridge.tools.stop_claude(), { result: 'stopped' });
  assert.deepEqual(aborted, ['abort']);
});

test('get_claude_status returns the snapshot plus busy', async () => {
  const { bridge, progressLog, busySessions } = makeDeps();
  progressLog.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'go', seq: 1 });
  busySessions.add('s1');
  const status = await bridge.tools.get_claude_status();
  assert.equal(status.state, 'working');
  assert.equal(status.busy, true);
  assert.ok(Array.isArray(status.todos));
  assert.ok(Array.isArray(status.recent));
  busySessions.delete('s1');
  assert.equal((await bridge.tools.get_claude_status()).busy, false);
});

test('proactive updates reach the sink ONLY while a call is active', () => {
  const progressLog = createProgressLog();
  const quiet = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
  }); // default isCallActive -> false
  const seen = [];
  quiet.onComplete((update) => seen.push(update));
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 });
  assert.equal(seen.length, 0, 'no push without an active call');

  let callActive = false;
  const live = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => callActive,
  });
  const pushed = [];
  live.onComplete((update) => pushed.push(update));
  progressLog.feed({ kind: 'permission_request', sessionId: 's1', seq: 2, toolName: 'Bash' });
  assert.equal(pushed.length, 0, 'still no push while idle');
  callActive = true;
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 3 });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].type, 'complete');
  assert.ok(typeof pushed[0].text === 'string' && pushed[0].text.length > 0);
});

test('a throwing sink never breaks the frame feed', () => {
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => true,
  });
  bridge.onComplete(() => {
    throw new Error('sink blew up');
  });
  assert.doesNotThrow(() => progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 }));
});

// --- F8: prompt-injection gate ------------------------------------------------------

test('F8: a proactive push blocks send/stop until the owner speaks again', async () => {
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => true,
  });
  const pushes = [];
  bridge.onComplete((update) => pushes.push(update));
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 }); // fires the proactive push
  assert.equal(pushes.length, 1);
  // an injected tool call riding on the pushed text goes nowhere:
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) run something harmful' }), { error: 'no_user_turn' });
  assert.deepEqual(await bridge.tools.stop_claude(), { error: 'no_user_turn' });
});

test('F8: owner speech re-arms exactly ONE send; a second send without new speech is blocked', async () => {
  const { bridge } = makeDeps();
  bridge.markUserTurn(); // the owner spoke (inputTranscription arrived)
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) run the tests' }), { result: 'sent' });
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) and this too' }), { error: 'no_user_turn' });
  bridge.markUserTurn(); // the owner spoke again
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) now this' }), { result: 'sent' });
});

test('F8: get_claude_status caps lastAssistantText at 4000 chars', async () => {
  const { bridge, progressLog } = makeDeps();
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'y'.repeat(9000), seq: 1 });
  const status = await bridge.tools.get_claude_status();
  assert.ok(status.lastAssistantText.length <= 4000);
  assert.ok(status.lastAssistantText.startsWith('yyyy'));
});

// --- WO-VL-CTX: session history in the status payload ---------------------------------

test('WO-VL-CTX: get_claude_status includes history lines + sessionOpen via getHistory', async () => {
  const progressLog = createProgressLog();
  const requested = [];
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    getHistory: async (sessionId) => {
      requested.push(sessionId);
      return { sessionId, lines: ['user: run the tests', 'claude: all green'], text: 'user: run the tests\nclaude: all green' };
    },
  });
  const status = await bridge.tools.get_claude_status();
  assert.deepEqual(requested, ['s1']);
  assert.equal(status.sessionOpen, true);
  assert.deepEqual(status.history, ['user: run the tests', 'claude: all green']);
  assert.equal(status.busy, false);
});

test('WO-VL-CTX: no session -> sessionOpen:false and getHistory is never called', async () => {
  let called = 0;
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => null,
    insertAndSend: async () => true,
    abort: () => {},
    getHistory: async () => {
      called += 1;
      return { lines: [] };
    },
  });
  const status = await bridge.tools.get_claude_status();
  assert.equal(called, 0);
  assert.equal(status.sessionOpen, false);
  assert.ok(!('history' in status));
});

test('WO-VL-CTX: a throwing or null getHistory never breaks get_claude_status', async () => {
  const progressLog = createProgressLog();
  const base = {
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
  };
  const failing = createVoiceBridge({ ...base, getHistory: async () => { throw new Error('offline'); } });
  const empty = createVoiceBridge({ ...base, getHistory: async () => null });
  const okThrow = await failing.tools.get_claude_status();
  assert.equal(okThrow.sessionOpen, true);
  assert.ok(!('history' in okThrow));
  const okNull = await empty.tools.get_claude_status();
  assert.ok(!('history' in okNull));
});

test('WO-VL-CTX NEG CONTROL: history and context fetches NEVER count as a user turn (F8 intact)', async () => {
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => true, // as during a live call with context flowing in
    getHistory: async () => ({ lines: ['user: do X', 'tool: Bash npm test'] }),
  });
  // arm the gate the honest way: a proactive push goes out (needs owner speech again)
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 });
  // context was fetched mid-call (status refresh) — it must NOT disarm the gate:
  await bridge.tools.get_claude_status();
  await bridge.tools.get_claude_status();
  // ...and none of it powers a send or a stop:
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) run something' }), { error: 'no_user_turn' });
  assert.deepEqual(await bridge.tools.stop_claude(), { error: 'no_user_turn' });
  // only real owner speech does:
  bridge.markUserTurn();
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) run the tests' }), { result: 'sent' });
});

test('owner ruling 2026-10-07: Claude gets the improved prompt plus the owner\'s exact transcribed words', async () => {
  const { bridge, sent } = makeDeps();
  bridge.markUserTurn('قول لكلود');
  bridge.markUserTurn('  يشغل   التستات');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) Run the tests' }), { result: 'sent' });
  bridge.markUserTurn(); // spoke, but no transcription text arrived
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) fallback' }), { result: 'sent' });
  assert.deepEqual(sent, ["(voice) Run the tests\n\n[owner's exact words, auto-transcribed] قول لكلود يشغل التستات", '(voice) fallback']); // words consumed by the first send
});

test('owner words survive ask_owner, feed the after-queue, and reset per call', async () => {
  const { bridge, sent, busySessions, progressLog } = makeDeps({ active: true });
  busySessions.add('s1');
  bridge.markUserTurn('خليه يراجع المكالمة');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'ask_owner' });
  bridge.markUserTurn(' بعد ما يخلص');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x', when: 'after' }), { result: 'queued' });
  busySessions.delete('s1');
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'done', seq: 1 });
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 2 });
  assert.deepEqual(sent, ["x\n\n[owner's exact words, auto-transcribed] خليه يراجع المكالمة بعد ما يخلص"]);
  bridge.markUserTurn('كلام قديم');
  bridge.resetOwnerWords();
  bridge.markUserTurn('جديد');
  // WO-3: 'x' itself went out <120 s ago (per-session dedupe) — a new order here
  await bridge.tools.send_to_claude({ instruction: 'x2' });
  assert.equal(sent[1], "x2\n\n[owner's exact words, auto-transcribed] جديد");
});

test('owner 2026-10-07: a stop the front end caused is not pushed back as news; a real stop is', async () => {
  const pushed = [];
  let clock = 0;
  const busySessions = new Set(['s1']);
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: (id) => busySessions.has(id) },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    delay: async () => {},
    now: () => clock,
    isCallActive: () => true,
  });
  bridge.onComplete((update) => pushed.push(update.text));
  bridge.markUserTurn('قاطعه');
  await bridge.tools.send_to_claude({ instruction: 'x', when: 'now' });
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1, aborted: true });
  assert.deepEqual(pushed, []);
  clock = 60000; // much later: a stop the owner did not cause through the call
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 2, aborted: true });
  assert.deepEqual(pushed, ['The run was stopped.']);
});

test('owner 2026-10-07: a leftover "working" is reported idle once the run tracker says the run ended', async () => {
  const { bridge, progressLog, busySessions } = makeDeps();
  progressLog.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'go', seq: 1 });
  busySessions.add('s1');
  assert.equal((await bridge.tools.get_claude_status()).state, 'working');
  busySessions.delete('s1');
  const status = await bridge.tools.get_claude_status();
  assert.equal(status.state, 'idle');
  assert.equal(status.busy, false);
});

// Owner 2026-10-07: a call belongs to ONE session — another session's news,
// sends and queue flushes never cross into it.
function pinnedBridge(pinned) {
  const progressLog = createProgressLog();
  const sent = [];
  const seen = [];
  const busy = new Set();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: (id) => busy.has(id) },
    getSession: () => pinned,
    insertAndSend: async (text, sessionId) => {
      sent.push({ text, sessionId });
      return true;
    },
    abort: () => {},
    isCallActive: () => true,
  });
  bridge.onComplete((update) => seen.push(update));
  return { bridge, progressLog, sent, seen, busy };
}

test('another session\'s updates are never pushed into the call', () => {
  const { progressLog, seen } = pinnedBridge('A');
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 'B', content: 'B is reading config files.', seq: 1 });
  progressLog.feed({ kind: 'complete', sessionId: 'B', seq: 2 });
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: null, content: 'unlabelled frame', seq: 3 });
  assert.equal(seen.length, 0);
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 'A', content: 'A tests pass.', seq: 4 });
  assert.deepEqual(seen.map((u) => u.sessionId), ['A']);
});

test('get_claude_status and send use only the pinned session', async () => {
  const { bridge, progressLog, sent } = pinnedBridge('A');
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 'B', content: 'Session B reply.', seq: 1 });
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 'A', content: 'Session A reply.', seq: 2 });
  const status = await bridge.tools.get_claude_status();
  assert.equal(status.lastAssistantText, 'Session A reply.');
  bridge.markUserTurn('ابعت');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'راجع' }), { result: 'sent' });
  assert.equal(sent[0].sessionId, 'A');
});

test('the after-queue flushes only on its own session\'s complete, to that session', async () => {
  const { bridge, progressLog, sent, busy } = pinnedBridge('A');
  busy.add('A');
  bridge.markUserTurn('بعد ما يخلص');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'اعمل كذا', when: 'after' }), { result: 'queued' });
  busy.delete('A');
  progressLog.feed({ kind: 'complete', sessionId: 'B', seq: 1 });
  assert.equal(sent.length, 0, 'session B finishing must not flush A\'s order');
  progressLog.feed({ kind: 'complete', sessionId: 'A', seq: 2 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'A');
});

test('a queued order that fails to deliver is told to the call, never dropped silently', async () => {
  const progressLog = createProgressLog();
  const seen = [];
  const busy = new Set(['A']);
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: (id) => busy.has(id) },
    getSession: () => 'A',
    insertAndSend: async () => false,
    abort: () => {},
    isCallActive: () => true,
  });
  bridge.onComplete((update) => seen.push(update));
  bridge.markUserTurn('بعد ما يخلص');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'راجع', when: 'after' }), { result: 'queued' });
  busy.delete('A');
  progressLog.feed({ kind: 'complete', sessionId: 'A', seq: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seen.some((u) => u.type === 'app' && /^\[APP\] .*could not be delivered/.test(u.text)), JSON.stringify(seen));
});

test('an order queued in one call never flushes into the next call', async () => {
  const { bridge, progressLog, sent, busy } = pinnedBridge('A');
  busy.add('A');
  bridge.markUserTurn('بعد ما يخلص');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'اعمل كذا', when: 'after' }), { result: 'queued' });
  bridge.resetOwnerWords(); // a new call starts
  busy.delete('A');
  progressLog.feed({ kind: 'complete', sessionId: 'A', seq: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
});

// --- owner 2026-10-07: read_claude_message + answer_claude_question ----------

function questionBridge({ pending, active = true, sentFrames = null, confirm = true } = {}) {
  const progressLog = createProgressLog();
  if (pending) progressLog.feed(pending);
  const frames = sentFrames === null ? [] : sentFrames;
  const sentTexts = [];
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async (text) => {
      sentTexts.push(text);
      return true;
    },
    abort: () => {},
    isCallActive: () => active,
    getHistory: async () => ({ lines: [], claudeTexts: ['newest full text', 'older full text'] }),
    sendPermissionResponse: async (frame) => {
      frames.push(frame);
      // Claude Code confirms on the run stream (permission_resolved).
      if (confirm) progressLog.feed({ kind: 'permission_resolved', sessionId: 's1', requestId: frame.requestId });
      return true;
    },
    delay: async () => {},
  });
  return { bridge, progressLog, frames, sentTexts };
}

const ASK = {
  kind: 'permission_request',
  sessionId: 's1',
  requestId: 'req-1',
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
};

test('read_claude_message returns the Nth newest claude message in full', async () => {
  const { bridge } = questionBridge();
  assert.deepEqual(await bridge.tools.read_claude_message({ back: 1 }), { back: 1, of: 2, part: 1, parts: 1, text: 'newest full text', more: false });
  assert.deepEqual(await bridge.tools.read_claude_message({ back: 2 }), { back: 2, of: 2, part: 1, parts: 1, text: 'older full text', more: false });
  assert.deepEqual(await bridge.tools.read_claude_message({ back: 3 }), { error: 'no_message', available: 2 });
  assert.deepEqual(await bridge.tools.read_claude_message({ back: 0 }), { error: 'bad_back' });
  assert.deepEqual(await bridge.tools.read_claude_message(), { error: 'bad_back' });
});

test('read_claude_message: no session -> no_session; a throwing history -> no_history', async () => {
  const progressLog = createProgressLog();
  const make = (getSession, getHistory) =>
    createVoiceBridge({ progressLog, runTracker: { isActive: () => false }, getSession, insertAndSend: async () => true, abort: () => {}, getHistory });
  assert.deepEqual(await make(() => null, async () => ({})).tools.read_claude_message({ back: 1 }), { error: 'no_session' });
  assert.deepEqual(
    await make(() => 's1', async () => { throw new Error('offline'); }).tools.read_claude_message({ back: 1 }),
    { error: 'no_history' },
  );
});

test('NEG CONTROL: read_claude_message is read-only — it works right after a proactive push (no F8 gate)', async () => {
  const { bridge, progressLog } = questionBridge();
  const pushed = [];
  bridge.onComplete((update) => pushed.push(update));
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 }); // proactive push arms the gate
  assert.equal(pushed.length, 1);
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) x' }), { error: 'no_user_turn' });
  assert.deepEqual(await bridge.tools.read_claude_message({ back: 1 }), { back: 1, of: 2, part: 1, parts: 1, text: 'newest full text', more: false });
});

test('answer_claude_question sends the stock permission frame; R7 binds the words to the exact label too', async () => {
  const { bridge, frames } = questionBridge({ pending: ASK });
  bridge.markUserTurn('اختار الأول');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { result: 'answered' });
  assert.deepEqual(frames, [
    {
      type: 'chat.permission-response',
      requestId: 'req-1',
      allow: true,
      updatedInput: {
        questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
        answers: { 'Which?': "A [owner's exact words, auto-transcribed] اختار الأول" },
      },
    },
  ]);
});

test('a free-text answer carries the owner\'s exact words, and the words are consumed', async () => {
  const { bridge, frames, sentTexts } = questionBridge({ pending: ASK });
  bridge.markUserTurn('الأحمر اللي على الشمال');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which?': 'the red one' } }), { result: 'answered' });
  assert.equal(frames[0].updatedInput.answers['Which?'], "the red one [owner's exact words, auto-transcribed] الأحمر اللي على الشمال");
  // the answer consumed the words: speech with no new transcription attached
  // to the next relay carries nothing stale.
  bridge.markUserTurn();
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'كمل' }), { result: 'sent' });
  assert.deepEqual(sentTexts, ['كمل']);
});

test('an ExitPlanMode pending returns approve_on_screen and sends nothing', async () => {
  const { bridge, frames } = questionBridge({
    pending: { kind: 'permission_request', sessionId: 's1', requestId: 'req-9', toolName: 'ExitPlanMode', input: { plan: 'Do it.' } },
  });
  bridge.markUserTurn('وافق');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'plan': 'yes' } }), { result: 'approve_on_screen' });
  assert.deepEqual(frames, []);
});

test('no pending question, a stale one, or a plain tool approval -> not_pending / no send', async () => {
  const none = questionBridge();
  assert.deepEqual(await none.bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { result: 'not_pending' });
  assert.deepEqual(none.frames, []);

  const bash = questionBridge({
    pending: { kind: 'permission_request', sessionId: 's1', requestId: 'req-b', toolName: 'Bash', input: { command: 'ls' } },
  });
  bash.bridge.markUserTurn('وافق');
  // NEG CONTROL: a Bash permission is never answered by voice.
  assert.deepEqual(await bash.bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { result: 'not_pending' });
  assert.deepEqual(bash.frames, []);

  const stale = questionBridge({ pending: ASK });
  stale.progressLog.feed({ kind: 'permission_resolved', sessionId: 's1', requestId: 'req-1' });
  stale.bridge.markUserTurn('جاوب');
  assert.deepEqual(await stale.bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { result: 'not_pending' });
  assert.deepEqual(stale.frames, []);
});

test('F8: a proactive push blocks answer_claude_question until the owner speaks', async () => {
  const { bridge, progressLog, frames } = questionBridge({ pending: ASK });
  progressLog.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'waiting', seq: 1 }); // pushed -> gate armed
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { error: 'no_user_turn' });
  bridge.markUserTurn('اختار B');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which?': 'B' } }), { result: 'answered' });
  assert.equal(frames.length, 1);
});

test('no active call or bad answers reject answer_claude_question', async () => {
  const idle = questionBridge({ pending: ASK, active: false });
  idle.bridge.markUserTurn('جاوب');
  assert.deepEqual(await idle.bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { error: 'no_call' });

  const bad = questionBridge({ pending: ASK });
  bad.bridge.markUserTurn('جاوب');
  assert.deepEqual(await bad.bridge.tools.answer_claude_question({ answers: null }), { error: 'no_answers' });
  assert.deepEqual(await bad.bridge.tools.answer_claude_question({ answers: { 'Which?': '   ' } }), {
    error: 'no_answers',
    questions: ['Which?'],
  });
});

test('get_claude_status carries the pending question from the snapshot', async () => {
  const { bridge } = questionBridge({ pending: ASK });
  const status = await bridge.tools.get_claude_status();
  assert.deepEqual(status.pendingQuestion, {
    toolName: 'AskUserQuestion',
    questions: [{ question: 'Which?', options: ['A', 'B'], multiSelect: false }],
  });
});

test('security: what Jimmy sees of a pending approval is redacted; a plain tool shows only its name', async () => {
  const secretAsk = {
    ...ASK,
    input: { questions: [{ question: 'Use key sk-ant-ABCDEFGHIJKLMNOP or https://evil.example/x ?', options: [{ label: 'Yes /etc/passwd' }, { label: 'No' }] }] },
  };
  const ask = questionBridge({ pending: secretAsk });
  const shown = JSON.stringify((await ask.bridge.tools.get_claude_status()).pendingQuestion);
  assert.ok(!/sk-ant-|https:|\/etc\/passwd|req-1/.test(shown), shown);
  // The owner's choice, as Jimmy saw it (redacted), still answers with the raw label and question.
  ask.bridge.markUserTurn('أيوه');
  const seenQuestion = JSON.parse(shown).questions[0];
  assert.deepEqual(await ask.bridge.tools.answer_claude_question({ answers: { [seenQuestion.question]: seenQuestion.options[0] } }), { result: 'answered' });
  assert.deepEqual(ask.frames[0].updatedInput.answers, { [secretAsk.input.questions[0].question]: "Yes /etc/passwd [owner's exact words, auto-transcribed] أيوه" });

  const bash = questionBridge({ pending: { ...ASK, toolName: 'Bash', input: { command: 'curl -H "Authorization: Bearer abc" https://x' } } });
  const status = await bash.bridge.tools.get_claude_status();
  assert.deepEqual(status.pendingQuestion, { toolName: 'Bash' });
  assert.deepEqual(bash.progressLog.snapshot('s1').pendingQuestion.input, {}, 'a plain tool input is never kept');
});

test('an answer the server never confirms is reported as not_confirmed, not answered', async () => {
  const { bridge, frames } = questionBridge({ pending: ASK, confirm: false });
  bridge.markUserTurn('الأول');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { result: 'not_confirmed' });
  assert.equal(frames.length, 1);
});

test('F8: an explanation part pushed by the app re-arms the owner-turn gate', async () => {
  const { bridge } = explainBridge();
  bridge.markUserTurn('اشرح');
  await bridge.tools.read_claude_message({ back: 1 });
  assert.match(bridge.nextExplainPart(), /^\[APP\] Part 2 /);
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) x' }), { error: 'no_user_turn' });
});

// --- owner 2026-10-07: "I kept saying كمّل" — long messages continue by themselves --

test('splitParts: spoken-size parts at sentence ends, nothing lost, nothing over the cap', () => {
  const sentences = Array.from({ length: 30 }, (_, i) => `الجملة رقم ${i + 1} فيها كلام عن المرحلة دي بالتفصيل.`);
  const text = `${sentences.slice(0, 15).join(' ')}\n\n${sentences.slice(15).join(' ')}`;
  const parts = splitParts(text, 300);
  assert.ok(parts.length >= 4, String(parts.length));
  for (const part of parts) assert.ok(part.length <= 300, String(part.length));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  assert.ok(parts.every((part) => /\.$/.test(part)), 'each part ends at a sentence end');
  const long = 'كلمة '.repeat(400).trim(); // one sentence longer than the cap
  const longParts = splitParts(long, 300);
  assert.ok(longParts.every((part) => part.length <= 300));
  assert.equal(longParts.join(' '), long);
  assert.deepEqual(splitParts('قصير.'), ['قصير.']);
});

function explainBridge({ session = 's1', active = true } = {}) {
  const long = Array.from({ length: 40 }, (_, i) => `النقطة ${i + 1} من تقرير الـCEO عن الاختبارات والنتايج.`).join(' ');
  const state = { session, active };
  const bridge = createVoiceBridge({
    progressLog: createProgressLog(),
    runTracker: { isActive: () => false },
    getSession: () => state.session,
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => state.active,
    getHistory: async () => ({ lines: [], claudeTexts: [long] }),
  });
  return { bridge, state, long };
}

test('read_claude_message hands out part 1, then nextExplainPart gives every later part once, in order', async () => {
  const { bridge, long } = explainBridge();
  const first = await bridge.tools.read_claude_message({ back: 1 });
  assert.equal(first.part, 1);
  assert.ok(first.parts >= 2 && first.more === true);
  const told = [first.text];
  for (let k = 2; k <= first.parts; k += 1) {
    const push = bridge.nextExplainPart();
    assert.match(push, new RegExp(`^\\[APP\\] Part ${k} of ${first.parts} of the CEO message \\(back=1\\)`));
    told.push(push.split('\n').slice(1).join('\n'));
    if (k === first.parts) assert.match(push, /This is the last part/);
  }
  assert.equal(bridge.nextExplainPart(), null, 'nothing after the last part');
  assert.equal(told.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '), 'the whole message is told');
});

test('owner speech, a new call, or another session stops the automatic parts; part=N resumes', async () => {
  const { bridge, state } = explainBridge();
  await bridge.tools.read_claude_message({ back: 1 });
  bridge.markUserTurn('استنى');
  assert.equal(bridge.nextExplainPart(), null, 'owner talked: stop and listen');

  const resumed = await bridge.tools.read_claude_message({ back: 1, part: 2 });
  assert.equal(resumed.part, 2);
  assert.match(bridge.nextExplainPart(), /^\[APP\] Part 3 /);

  await bridge.tools.read_claude_message({ back: 1 });
  bridge.resetOwnerWords();
  assert.equal(bridge.nextExplainPart(), null, 'a new call starts clean');

  await bridge.tools.read_claude_message({ back: 1 });
  state.session = 's2';
  assert.equal(bridge.nextExplainPart(), null, 'never another session\'s message');

  state.session = 's1';
  await bridge.tools.read_claude_message({ back: 1 });
  state.active = false;
  assert.equal(bridge.nextExplainPart(), null, 'no call, no push');
});

// --- WO-VP-BRIDGE 2026-10-07: plan reading + review LOWs (R1-R8) ------------------
// The progress-log contract is owned by a parallel change; these fakes pin it
// (snapshot shape + pendingQuestion) instead of importing the real module.

function fakeProgressLog(pending) {
  const log = {
    current: pending,
    snapshot: () => ({
      state: 'idle',
      todos: [],
      recent: [],
      lastAssistantText: '',
      lastAssistantAt: null,
      toolsSinceLastText: 0,
      pendingQuestion: log.current,
    }),
    onUpdate: () => {},
    set: (next) => {
      log.current = next;
    },
  };
  return log;
}

const PLAN_PENDING = (planText) => ({ requestId: 'p1', toolName: 'ExitPlanMode', input: {}, planText });
const ASK_PENDING = (requestId, question, options = ['Red', 'Blue']) => ({
  requestId,
  toolName: 'AskUserQuestion',
  input: { questions: [{ question, options: options.map((label) => ({ label })) }] },
  questions: [{ question, options, multiSelect: false }],
});

function planBridge({ pending, busy = false, active = true } = {}) {
  const sent = [];
  const frames = [];
  const aborted = [];
  const log = fakeProgressLog(pending);
  const bridge = createVoiceBridge({
    progressLog: log,
    runTracker: { isActive: () => busy },
    getSession: () => 's1',
    insertAndSend: async (text) => {
      sent.push(text);
      return true;
    },
    abort: () => {
      aborted.push('abort');
      busy = false; // WO-3: the aborted run ends before the 'now' order is sent
    },
    delay: async () => {},
    isCallActive: () => active,
    sendPermissionResponse: async (frame) => {
      frames.push(frame);
      log.set(null);
      return true;
    },
  });
  return { bridge, sent, frames, aborted, log };
}

const LONG_PLAN = Array.from({ length: 180 }, (_, i) => `الخطة فيها خطوة رقم ${i + 1} وشرح وافي للمرحلة دي بالتفصيل المطلوب.`).join('\n');

test('R1: read_claude_message plan:true reads the waiting plan in parts; the last part carries then', async () => {
  assert.ok(LONG_PLAN.length >= 9000, String(LONG_PLAN.length));
  const { bridge } = planBridge({ pending: PLAN_PENDING(LONG_PLAN) });
  const first = await bridge.tools.read_claude_message({ plan: true }); // back not needed
  assert.equal(first.plan, true);
  assert.equal(first.part, 1);
  assert.ok(first.parts >= 2 && first.more === true);
  const told = [first.text];
  let read = first;
  while (read.more) {
    read = await bridge.tools.read_claude_message({ plan: true, part: read.part + 1 });
    told.push(read.text);
  }
  assert.equal(read.then, 'tell the owner to approve or reject the plan on screen');
  assert.equal(read.more, false);
  assert.equal(told.join(' ').replace(/\s+/g, ' '), LONG_PLAN.replace(/\s+/g, ' '), 'the whole plan is read, in order');
  // no ExitPlanMode waiting -> no_plan (nothing pending, or a different tool)
  const none = planBridge({ pending: null });
  assert.deepEqual(await none.bridge.tools.read_claude_message({ plan: true }), { error: 'no_plan' });
  const ask = planBridge({ pending: ASK_PENDING('q1', 'Which?') });
  assert.deepEqual(await ask.bridge.tools.read_claude_message({ plan: true }), { error: 'no_plan' });
});

test('R2: nextExplainPart auto-continues a plan with the PLAN wording and approval tail', async () => {
  const { bridge } = planBridge({ pending: PLAN_PENDING(LONG_PLAN) });
  const first = await bridge.tools.read_claude_message({ plan: true });
  assert.ok(first.parts >= 2, 'the long plan is explained in parts');
  for (let k = 2; k <= first.parts; k += 1) {
    const push = bridge.nextExplainPart();
    assert.ok(
      push.startsWith(`[APP] Part ${k} of ${first.parts} of the PLAN waiting for the owner's approval. Retell it now in plain Masri, continuing from the previous part without repeating it.`),
      push,
    );
    assert.ok(!push.includes('(back='), 'a plan part never cites back=N');
    if (k === first.parts) {
      assert.match(push, /This is the last part: after it, tell the owner to approve or reject the plan on the screen \(never by voice\) and ask if they want to discuss any point\./);
    }
  }
  assert.equal(bridge.nextExplainPart(), null, 'nothing after the last part');
});

test('R3: status shows a waiting plan as redacted part 1 with the readWith hint, never the whole plan', async () => {
  const { bridge } = planBridge({ pending: PLAN_PENDING(LONG_PLAN) });
  const status = await bridge.tools.get_claude_status();
  assert.deepEqual(Object.keys(status.pendingQuestion).sort(), ['planParts', 'planText', 'readWith', 'toolName']);
  assert.equal(status.pendingQuestion.toolName, 'ExitPlanMode');
  assert.equal(status.pendingQuestion.readWith, 'read_claude_message plan:true');
  assert.ok(status.pendingQuestion.planText.length <= 700, String(status.pendingQuestion.planText.length));
  const read = await bridge.tools.read_claude_message({ plan: true });
  assert.equal(status.pendingQuestion.planParts, read.parts);
  assert.equal(status.pendingQuestion.planText, read.text, 'status shows exactly part 1');
  const shown = JSON.stringify(status.pendingQuestion);
  assert.ok(!shown.includes('رقم 179'), 'later plan lines never reach the status');
  assert.ok(shown.length < LONG_PLAN.length);
});

test('R4: a busy relay while a plan waits explains now/after and tags planPending', async () => {
  const { bridge } = planBridge({ pending: PLAN_PENDING(LONG_PLAN), busy: true });
  bridge.markUserTurn('ابعتله');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'راجع' }), {
    result: 'ask_owner',
    planPending: true,
    note: 'now = closes the plan on screen and the CEO revises it; after = once the owner approves on screen and the run finishes',
  });
  bridge.markUserTurn('دلوقتي');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'راجع', when: 'now' }), { result: 'sent', planPending: true });
  bridge.markUserTurn('بعدين');
  // WO-3: the identical order went out <120 s ago — never a second copy
  assert.equal((await bridge.tools.send_to_claude({ instruction: 'راجع', when: 'after' })).result, 'already_sent');
  bridge.markUserTurn('بعدين');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'راجع الخطة تاني', when: 'after' }), { result: 'queued', planPending: true });
});

test('R5: get_claude_status reuses one snapshot per session for 1500 ms; send invalidates it', async () => {
  let clock = 0;
  let snapshotCalls = 0;
  let historyCalls = 0;
  const state = { session: 's1' };
  const bridge = createVoiceBridge({
    progressLog: { snapshot: () => { snapshotCalls += 1; return { state: 'idle', todos: [], recent: [], lastAssistantText: `x${snapshotCalls}`, pendingQuestion: null }; }, onUpdate: () => {} },
    runTracker: { isActive: () => false },
    getSession: () => state.session,
    insertAndSend: async () => true,
    abort: () => {},
    getHistory: async () => { historyCalls += 1; return { lines: ['a'] }; },
    now: () => clock,
  });
  const a = await bridge.tools.get_claude_status();
  assert.deepEqual(await bridge.tools.get_claude_status(), a);
  assert.equal(snapshotCalls, 1, 'the second call inside the window is served from the cache');
  assert.equal(historyCalls, 1);
  clock = 1500; // the boundary itself is still inside the window
  assert.deepEqual(await bridge.tools.get_claude_status(), a);
  assert.equal(snapshotCalls, 1);
  clock = 1501; // expired
  await bridge.tools.get_claude_status();
  assert.equal(snapshotCalls, 2);
  state.session = 's2'; // another session never reuses s1's entry
  await bridge.tools.get_claude_status();
  assert.equal(snapshotCalls, 3);
  state.session = 's1';
  clock = 1600;
  await bridge.tools.get_claude_status();
  assert.equal(snapshotCalls, 4);
  bridge.markUserTurn();
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  const after = await bridge.tools.get_claude_status();
  assert.equal(after.lastAssistantText, 'x6', 'the status after a send is a fresh snapshot, not the cached one');
  assert.ok(snapshotCalls >= 6, 'a send invalidates the cache immediately');
  // wave-1 tester gap: a stop invalidates it too (clock unchanged)
  const beforeStop = snapshotCalls;
  await bridge.tools.get_claude_status(); // cache hit
  assert.equal(snapshotCalls, beforeStop);
  bridge.markUserTurn('وقّفه');
  assert.deepEqual(await bridge.tools.stop_claude({}), { result: 'stopped' });
  await bridge.tools.get_claude_status();
  assert.ok(snapshotCalls > beforeStop, 'a stop invalidates the cache immediately');
});

// Wave-1 security (2026-10-07): the last reply goes to Google only through
// the same secret filter as the seed (stripLine), not the log-only strip.
test('get_claude_status redacts secrets in lastAssistantText', async () => {
  const bridge = createVoiceBridge({
    progressLog: { snapshot: () => ({ state: 'idle', todos: [], recent: [], lastAssistantText: 'Key is AIza' + 'A'.repeat(35) + ' and Bearer abc.def done', pendingQuestion: null }), onUpdate: () => {} },
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
  });
  const status = await bridge.tools.get_claude_status();
  assert.ok(!/AIza|Bearer|abc\.def/.test(status.lastAssistantText), status.lastAssistantText);
  assert.match(status.lastAssistantText, /^Key is and done$/);
});

test('R6: an answer against a question Jimmy was not shown is refused as question_changed', async () => {
  const frames = [];
  const log = fakeProgressLog(ASK_PENDING('req-1', 'Which colour?'));
  const bridge = createVoiceBridge({
    progressLog: log,
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => true,
    sendPermissionResponse: async (frame) => {
      frames.push(frame);
      log.set(null);
      return true;
    },
    delay: async () => {},
  });
  // NEG CONTROL: without any status shown, today's behaviour holds — the answer goes through.
  bridge.markUserTurn('الأحمر');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which colour?': 'Red' } }), { result: 'answered' });
  assert.equal(frames.length, 1);
  // shown req-2, but req-3 is pending now -> nothing is sent
  log.set(ASK_PENDING('req-2', 'Which size?'));
  await bridge.tools.get_claude_status(); // records req-2 as shown
  log.set(ASK_PENDING('req-3', 'Which shape?'));
  bridge.markUserTurn('الكبير');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which shape?': 'Big' } }), {
    result: 'question_changed',
    questions: ['Which shape?'],
  });
  assert.equal(frames.length, 1, 'nothing was sent for a question Jimmy never saw');
  // the shown question answered directly still goes through
  log.set(ASK_PENDING('req-2', 'Which size?'));
  bridge.markUserTurn('الكبير');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which size?': 'Big' } }), { result: 'answered' });
  assert.equal(frames.length, 2);
  assert.equal(frames[1].requestId, 'req-2');
});

test('R7: transcribed words bind to EVERY answer; a bare label only when nothing was transcribed', async () => {
  const words = planBridge({ pending: ASK_PENDING('req-1', 'Which colour?') });
  words.bridge.markUserTurn('الأحمر اللي على الشمال');
  assert.deepEqual(await words.bridge.tools.answer_claude_question({ answers: { 'Which colour?': 'Red' } }), { result: 'answered' });
  assert.equal(words.frames[0].updatedInput.answers['Which colour?'], "Red [owner's exact words, auto-transcribed] الأحمر اللي على الشمال");

  const quiet = planBridge({ pending: ASK_PENDING('req-1', 'Which colour?') });
  quiet.bridge.markUserTurn(); // spoke, but no transcription arrived
  assert.deepEqual(await quiet.bridge.tools.answer_claude_question({ answers: { 'Which colour?': 'Red' } }), { result: 'answered' });
  assert.deepEqual(quiet.frames[0].updatedInput.answers, { 'Which colour?': 'Red' });
});

test('R8: resumeAfterNoise re-hands the cut part, else the generic continue-or-listen line', async () => {
  const state = { active: true };
  const long = Array.from({ length: 40 }, (_, i) => `النقطة ${i + 1} من تقرير الـCEO عن الاختبارات والنتايج.`).join(' ');
  const bridge = createVoiceBridge({
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    isCallActive: () => state.active,
    getHistory: async () => ({ lines: [], claudeTexts: [long] }),
  });
  const first = await bridge.tools.read_claude_message({ back: 1 });
  const resume = bridge.resumeAfterNoise();
  assert.ok(
    resume.startsWith(`[APP] Noise cut you off while you were telling part 1 of ${first.parts}. Continue that part from where you stopped, without repeating what you already said.\n`),
    resume,
  );
  assert.ok(resume.endsWith(first.text), 'the cut part is re-handed');
  assert.match(bridge.nextExplainPart(), new RegExp(`^\\[APP\\] Part 2 of ${first.parts} `), 'the following parts still follow');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { error: 'no_user_turn' }, 'an app push re-arms the F8 gate');

  // nothing in progress -> the generic line; no call -> null
  bridge.markUserTurn('استنى');
  assert.equal(
    bridge.resumeAfterNoise(),
    '[APP] Noise cut you off. If you were in the middle of answering the owner, finish your answer from where you stopped; otherwise stay silent and listen.',
    'owner speech cancelled the parts — the generic line applies',
  );
  state.active = false;
  assert.equal(bridge.resumeAfterNoise(), null, 'no call, no push');
});

test('R9: an open on-screen approval holds the relay like a busy run, even when the tracker is idle', async () => {
  const plan = planBridge({ pending: PLAN_PENDING(LONG_PLAN), busy: false });
  plan.bridge.markUserTurn('ابعتله');
  assert.deepEqual(await plan.bridge.tools.send_to_claude({ instruction: 'راجع' }), {
    result: 'ask_owner',
    planPending: true,
    note: 'now = closes the plan on screen and the CEO revises it; after = once the owner approves on screen and the run finishes',
  });

  const ask = planBridge({ pending: ASK_PENDING('req-9', 'Which size?'), busy: false });
  ask.bridge.markUserTurn('ابعتله');
  assert.deepEqual(await ask.bridge.tools.send_to_claude({ instruction: 'راجع' }), {
    result: 'ask_owner',
    questionPending: true,
    note: 'now = dismisses the question on screen and the CEO continues; after = once the owner answers on screen and the run finishes',
  });

  const tool = planBridge({ pending: { requestId: 'rb', toolName: 'Bash', input: {} }, busy: false });
  tool.bridge.markUserTurn('وافق');
  assert.deepEqual(await tool.bridge.tools.send_to_claude({ instruction: 'راجع' }), {
    result: 'ask_owner',
    questionPending: true,
    note: 'now = dismisses the question on screen and the CEO continues; after = once the owner answers on screen and the run finishes',
  });

  // when=now still sends — aborting first closes the waiting approval; the
  // words from the earlier ask_owner round survive and ride the relay.
  ask.bridge.markUserTurn(); // the owner chose; no new transcription attached
  assert.deepEqual(await ask.bridge.tools.send_to_claude({ instruction: 'راجع', when: 'now' }), { result: 'sent' });
  assert.deepEqual(ask.aborted, ['abort']);
  assert.deepEqual(ask.sent, ["راجع\n\n[owner's exact words, auto-transcribed] ابعتله"]);
});

test('R10: status carries live background tasks (capped, redacted) and the this-session-only scope', async () => {
  const long = 't'.repeat(120);
  const state = { tasks: { running: 7, names: ['deploy job', 'watch /var/run/thing', 'a', 'b', 'c', 'd', 'e', long] } };
  let clock = 0;
  const bridge = createVoiceBridge({
    progressLog: { snapshot: () => ({ state: 'idle', todos: [], recent: [], lastAssistantText: '', pendingQuestion: null }), onUpdate: () => {} },
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    now: () => clock,
    getBackgroundTasks: () => state.tasks,
  });
  const a = await bridge.tools.get_claude_status();
  assert.equal(a.scope, 'this session only');
  assert.deepEqual(a.backgroundTasks, {
    running: 7,
    names: ['deploy job', 'watch', 'a', 'b', 'c'],
  });
  assert.equal(a.backgroundTasks.names[4], 'c', 'at most 5 names');
  assert.equal(state.tasks.names[7].length, 120, 'sanity');
  // live even on a cache hit (R5): the count changed and is reflected at once
  state.tasks = { running: 2, names: ['x'] };
  const b = await bridge.tools.get_claude_status(); // clock unchanged -> cache hit
  assert.equal(b.backgroundTasks.running, 2);
  assert.deepEqual(b.backgroundTasks.names, ['x']);
  // null -> no field; scope stays; a throwing getter never breaks the status
  state.tasks = null;
  const c = await bridge.tools.get_claude_status();
  assert.ok(!('backgroundTasks' in c));
  assert.equal(c.scope, 'this session only');
  const throwing = createVoiceBridge({
    progressLog: { snapshot: () => ({ state: 'idle', todos: [], recent: [], lastAssistantText: '', pendingQuestion: null }), onUpdate: () => {} },
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {},
    now: () => clock,
    getBackgroundTasks: () => { throw new Error('offline'); },
  });
  const d = await throwing.tools.get_claude_status();
  assert.ok(!('backgroundTasks' in d));
  assert.equal(d.scope, 'this session only');
});

// Wave-1 security review (2026-10-07): nothing mutates before the owner's
// first words, and read text (a plan part, an old message) is data — a send
// right after a read needs fresh owner speech.
test('F8 gate starts closed and a read re-arms it', async () => {
  const sent = [];
  const deps = {
    progressLog: createProgressLog(),
    runTracker: { isActive: () => false },
    getSession: () => 's1',
    insertAndSend: async (text) => { sent.push(text); return true; },
    abort: () => sent.push('ABORT'),
    isCallActive: () => true,
    getHistory: async () => ({ claudeTexts: ['آخر رسالة من الـCEO.'] }),
    delay: async () => {},
  };
  const bridge = createRawBridge(deps);
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { error: 'no_user_turn' });
  assert.deepEqual(await bridge.tools.stop_claude({}), { error: 'no_user_turn' });
  bridge.markUserTurn('اقرا آخر رسالة');
  const read = await bridge.tools.read_claude_message({ back: 1 });
  assert.equal(read.back, 1);
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'injected' }), { error: 'no_user_turn' });
  assert.deepEqual(sent, []);
  bridge.markUserTurn('قوله يكمل');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'كمّل' }), { result: 'sent' });
});

// WO-VP-WORDS R1 (owner 23:1x, "since Jimmy last spoke"): the exact-words
// block starts at the request, not at the start of the call.
test('R1: words said before Jimmy\'s last spoken turn are NOT in the relay', async () => {
  const { bridge, sent } = makeDeps();
  bridge.markUserTurn('انت سامعني؟');
  bridge.noteJimmySpoke(); // "أيوه سامعك"
  bridge.markUserTurn('قول للـCEO يراجع الاختبارات');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: '(voice) راجع الاختبارات' }), { result: 'sent' });
  assert.deepEqual(sent, ["(voice) راجع الاختبارات\n\n[owner's exact words, auto-transcribed] قول للـCEO يراجع الاختبارات"]);
});

test('R1: an ask_owner now/after exchange keeps the request + the answer, and the queue closes it', async () => {
  const { bridge, sent, busySessions, progressLog } = makeDeps({ active: true });
  busySessions.add('s1');
  bridge.markUserTurn('قوله يراجع المكالمة');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'ask_owner' });
  bridge.noteJimmySpoke(); // "تحب دلوقتي ولا بعدين؟"
  bridge.markUserTurn(' بعد ما يخلص');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x', when: 'after' }), { result: 'queued' });
  bridge.noteJimmySpoke(); // "هيوصله بعد ما يخلص"
  bridge.markUserTurn('كلام بعدها');
  bridge.noteJimmySpoke(); // the queue closed the exchange: this turn restarts the window
  busySessions.delete('s1');
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1 });
  assert.deepEqual(sent, ["x\n\n[owner's exact words, auto-transcribed] قوله يراجع المكالمة بعد ما يخلص"]);
  bridge.markUserTurn('قوله حاجة جديدة');
  await bridge.tools.send_to_claude({ instruction: 'y' });
  assert.equal(sent[1], "y\n\n[owner's exact words, auto-transcribed] قوله حاجة جديدة");
});

test('R1: a dropped now/after choice holds the window for 2 spoken turns only', async () => {
  const { bridge, sent, busySessions } = makeDeps();
  busySessions.add('s1');
  bridge.markUserTurn('قوله X');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'ask_owner' });
  bridge.noteJimmySpoke(); // the now/after question
  bridge.markUserTurn(' خلاص سيبك');
  bridge.noteJimmySpoke(); // "تمام"
  bridge.markUserTurn(' اشرحلي الخطة');
  bridge.noteJimmySpoke(); // third turn: the owner moved on — window restarts
  busySessions.delete('s1');
  bridge.markUserTurn('قوله Y');
  await bridge.tools.send_to_claude({ instruction: 'y' });
  assert.deepEqual(sent, ["y\n\n[owner's exact words, auto-transcribed] قوله Y"]);
});

test('R1: answer_claude_question uses the same window', async () => {
  const { bridge, frames } = questionBridge({ pending: ASK });
  bridge.markUserTurn('كلام قديم');
  bridge.noteJimmySpoke();
  bridge.markUserTurn('اختار الأول');
  assert.deepEqual(await bridge.tools.answer_claude_question({ answers: { 'Which?': 'A' } }), { result: 'answered' });
  assert.equal(frames[0].updatedInput.answers['Which?'], "A [owner's exact words, auto-transcribed] اختار الأول");
});

// WO-VP-WORDS R2: "اقرا الجزء الأول بس" reads that part only — no auto-continue.
test('R2: read_claude_message only:true hands out one plan part and never continues', async () => {
  const { bridge } = planBridge({ pending: PLAN_PENDING(LONG_PLAN) });
  const one = await bridge.tools.read_claude_message({ plan: true, part: 1, only: true });
  assert.equal(one.only, true);
  assert.equal(one.part, 1);
  assert.equal(one.more, true);
  assert.ok(one.parts >= 2 && one.text.length > 0);
  assert.equal(bridge.nextExplainPart(), null);
  const all = await bridge.tools.read_claude_message({ plan: true });
  assert.equal(all.only, undefined);
  assert.match(bridge.nextExplainPart(), /^\[APP\] Part 2 /); // without only the flow still continues
});

// Wave-1 fix pass (tester gaps + security MEDIUM).
test('R2: only:true on a CEO message (back=N) reads one part and never continues', async () => {
  const progressLog = createProgressLog();
  const long = Array.from({ length: 120 }, (_, i) => `دي الجملة رقم ${i + 1} في رسالة الـCEO الطويلة.`).join(' ');
  const bridge = createVoiceBridge({
    progressLog, runTracker: { isActive: () => false }, getSession: () => 's1', insertAndSend: async () => true, abort: () => {}, isCallActive: () => true,
    getHistory: async () => ({ lines: [], claudeTexts: [long] }),
  });
  const one = await bridge.tools.read_claude_message({ back: 1, part: 1, only: true });
  assert.equal(one.only, true);
  assert.equal(one.back, 1);
  assert.ok(one.parts >= 2 && one.more === true);
  assert.equal(bridge.nextExplainPart(), null);
  const str = await bridge.tools.read_claude_message({ back: 1, only: 'false' }); // not boolean true -> normal flow
  assert.equal(str.only, undefined);
  assert.match(bridge.nextExplainPart(), /^\[APP\] Part 2 /);
});

test('security: a new call starts with the F8 gate closed (resetOwnerWords)', async () => {
  const { bridge, sent } = makeDeps();
  bridge.markUserTurn('كلام من المكالمة اللي فاتت'); // the gate is open when the call ends
  bridge.resetOwnerWords(); // the next call starts
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { error: 'no_user_turn' });
  bridge.markUserTurn('قوله x');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'sent' });
  assert.equal(sent.length, 1);
});

test('review: a blocked send leaves an open ask_owner hold alone', async () => {
  const { bridge, sent, busySessions } = makeDeps({ abortStops: true });
  busySessions.add('s1');
  bridge.markUserTurn('قوله يراجع');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x' }), { result: 'ask_owner' });
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x', when: 'now' }), { error: 'no_user_turn' }); // a guess
  bridge.noteJimmySpoke(); // the now/after question
  bridge.markUserTurn(' دلوقتي');
  assert.deepEqual(await bridge.tools.send_to_claude({ instruction: 'x', when: 'now' }), { result: 'sent' });
  assert.deepEqual(sent, ["x\n\n[owner's exact words, auto-transcribed] قوله يراجع دلوقتي"]);
});
