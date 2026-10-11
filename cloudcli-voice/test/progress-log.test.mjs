// WO-VL-UI: lib/progress-log.mjs — frame classification moved from the old
// headlines/cues pipeline into the call-bridge snapshot + update events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressLog } from '../lib/progress-log.mjs';

test('user text starts a working run; complete returns it to idle', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'go', seq: 1 });
  assert.equal(log.snapshot('s1').state, 'working');
  log.feed({ kind: 'complete', sessionId: 's1', seq: 2 });
  assert.equal(log.snapshot('s1').state, 'idle');
});

test('unknown session snapshot is the idle default', () => {
  const log = createProgressLog();
  assert.deepEqual(log.snapshot('nope'), {
    state: 'idle',
    todos: [],
    recent: [],
    lastAssistantText: '',
    lastAssistantAt: null, // WO-VP-PLOG R6
    toolsSinceLastText: 0,
    pendingQuestion: null,
  });
  assert.deepEqual(log.snapshot(null), {
    state: 'idle',
    todos: [],
    recent: [],
    lastAssistantText: '',
    lastAssistantAt: null,
    toolsSinceLastText: 0,
    pendingQuestion: null,
  });
});

test('lastAssistantText keeps the latest assistant reply, fences and paths stripped', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'First', seq: 1 });
  log.feed({
    kind: 'text',
    role: 'assistant',
    sessionId: 's1',
    seq: 2,
    content: 'Done. See ```js\nx=1\n``` and ${AI_SETUP_ROOT}/cloudcli-voice/voice-addon.js for details.',
  });
  const snapshot = log.snapshot('s1');
  assert.equal(snapshot.lastAssistantText, 'Done. See and for details.');
  assert.ok(snapshot.recent.length >= 1);
});

test('lastAssistantText is capped at 4000 chars, cut between words', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', seq: 1, content: 'word '.repeat(1600) });
  const text = log.snapshot('s1').lastAssistantText;
  assert.ok(text.length <= 4002 && text.length > 3900, String(text.length));
  assert.ok(text.endsWith('word …'));
});

test('a user/tool-result frame keeps the last reply readable but never re-announces it on complete', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'old answer', seq: 1 });
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'again', seq: 2 });
  assert.equal(log.snapshot('s1').lastAssistantText, 'old answer'); // get_claude_status still sees it mid-turn
  log.feed({ kind: 'complete', sessionId: 's1', seq: 3 });
  const done = events.filter((event) => event.type === 'complete').pop();
  assert.equal(done.text, 'Turn finished.'); // the stale reply is not pushed as new
});

test('TodoWrite frames become todos with statuses', () => {
  const log = createProgressLog();
  log.feed({
    kind: 'tool_use',
    sessionId: 's1',
    seq: 1,
    toolName: 'TodoWrite',
    toolInput: { todos: [{ content: 'first task', status: 'completed' }, { activeForm: 'doing the second', status: 'in_progress' }] },
  });
  const todos = log.snapshot('s1').todos;
  assert.deepEqual(todos, [
    { text: 'first task', status: 'completed' },
    { text: 'doing the second', status: 'in_progress' },
  ]);
});

test('permission_request sets waiting_permission and fires permission/question events', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 1, toolName: 'Bash' });
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 2, toolName: 'AskUserQuestion' });
  assert.equal(log.snapshot('s1').state, 'waiting_permission');
  assert.deepEqual(
    events.map((event) => event.type),
    ['permission', 'question'],
  );
  assert.equal(events[0].text, 'Approval needed for Bash.');
});

test('complete fires the complete event with the last reply, or stop/fail wording', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'All tests pass.', seq: 1 });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 2 });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 3, aborted: true });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 4, success: false });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 5 });
  assert.deepEqual(events.map((event) => [event.type, event.text]), [
    ['progress', 'All tests pass.'], // owner 2026-10-07: told while Claude works
    ['complete', 'Claude finished.'], // ...so the complete never repeats it
    ['complete', 'The run was stopped.'],
    ['complete', 'The run failed.'],
    ['complete', 'Turn finished.'],
  ]);
});

test('a reply seeded silently (history) is still told in full on complete', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'Seeded reply.', seq: 1 }, { silent: true });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 2 });
  assert.deepEqual(events.map((event) => [event.type, event.text]), [['complete', 'Seeded reply.']]);
});

test('an error frame ends the run as a failed complete', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'go', seq: 1 });
  log.feed({ kind: 'error', sessionId: 's1', seq: 2, content: 'boom at /x/y.js:12' });
  assert.equal(log.snapshot('s1').state, 'idle');
  assert.equal(events[0].type, 'complete');
  assert.equal(events[0].text, 'The run failed.');
});

// Owner 2026-10-07 (WO-VP-PLOG R4): complete/error now DROP the seq watermark
// (the next run restarts seq at 1), so the replay check uses mid-run frames.
test('replayed frames (same or lower seq) never re-classify', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'one', seq: 7 });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'one', seq: 7 });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'one', seq: 3 });
  assert.equal(events.length, 1);
});

test('snapshot recent is capped at 15 short strings', () => {
  const log = createProgressLog({ max: 40 });
  for (let i = 1; i <= 30; i++) {
    log.feed({ kind: 'tool_use', sessionId: 's1', seq: i, toolName: `Tool${i}` });
  }
  const recent = log.snapshot('s1').recent;
  assert.equal(recent.length, 15);
  assert.equal(recent[0], 'Tool: Tool16');
  assert.equal(recent[14], 'Tool: Tool30');
});

test('update text is stripped (never paths or fences) but keeps its full substance', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({
    kind: 'text',
    role: 'assistant',
    sessionId: 's1',
    seq: 1,
    content: 'Fixed ${AI_SETUP_ROOT}/cloudcli-voice/lib/voice-bridge.mjs and ran the suite, everything passed, more words follow here to overflow',
  });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 2 });
  assert.equal(events[0].text, 'Fixed and ran the suite, everything passed, more words follow here to overflow'); // no 12-word cut
  assert.ok(!events[0].text.includes('/'), 'paths must be stripped from update text');
});

test('sessions are tracked independently', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'user', sessionId: 'a', content: 'go', seq: 1 });
  log.feed({ kind: 'complete', sessionId: 'b', seq: 9 });
  assert.equal(log.snapshot('a').state, 'working');
  assert.equal(log.snapshot('b').state, 'idle');
});

// --- WO-VL-CTX: silent REST-history seeding -------------------------------------------

test('WO-VL-CTX: silent feed updates the snapshot but fires no update events', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((update) => events.push(update));
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'fixed it', seq: 1 }, { silent: true });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 2 }, { silent: true });
  log.feed({ kind: 'permission_request', sessionId: 's1', toolName: 'Bash', seq: 3 }, { silent: true });
  assert.deepEqual(events, [], 'history seeding must never leak events into the live call');
  const snapshot = log.snapshot('s1');
  assert.equal(snapshot.state, 'waiting_permission'); // the permission frame classified silently
  assert.ok(snapshot.lastAssistantText.startsWith('fixed it'));
});

test('WO-VL-CTX: seq-less history frames are never treated as stale', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((update) => events.push(update));
  // Owner 2026-10-07 (WO-VP-PLOG R4): a live tool frame arms seq tracking (a
  // complete would DROP the watermark, and its silent replay would classify).
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 5, toolName: 'Bash', toolId: 'live-1' });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'from history', seq: 5 }, { silent: true }); // stale replay: dropped
  assert.equal(log.snapshot('s1').lastAssistantText, '');
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'also history' }, { silent: true }); // no seq at all -> R1 fill
  const snapshot = log.snapshot('s1');
  assert.ok(snapshot.lastAssistantText.startsWith('also history'), 'seq-less frames must classify');
  assert.deepEqual(events, [], 'silent history rows never fire events');
});

test('clock times survive stripping; file:line references do not', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', seq: 1, content: 'Recording started at 16:10:18, see app.py:42 and lib/x.mjs:7:3 now.' });
  assert.equal(log.snapshot('s1').lastAssistantText, 'Recording started at 16:10:18, see and now.');
});

test('long replies are cut at a sentence end, never mid-word; markdown marks are dropped', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  const sentence = 'The fix is live and tested. ';
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', seq: 1, content: '## Done\n**Bold** part. ' + sentence.repeat(300) });
  const text = events[0].text;
  assert.ok(text.length <= 4002, `too long: ${text.length}`);
  assert.ok(text.endsWith('tested. …') || text.endsWith('tested. …'.trim()), text.slice(-30));
  assert.ok(text.startsWith('Done Bold part.'), text.slice(0, 30));
});

// Owner 2026-10-07 (call 171321): a question already waiting when the page
// opened arrives only in chat_subscribed.pendingPermissions.
test('chat_subscribed with pending permissions marks the session waiting; resolve clears it', () => {
  const log = createProgressLog();
  log.feed({ kind: 'chat_subscribed', sessionId: 's1', isProcessing: true, pendingPermissions: [{ requestId: 'q1', toolName: 'AskUserQuestion' }] });
  assert.equal(log.snapshot('s1').state, 'waiting_permission');
  log.feed({ kind: 'permission_resolved', sessionId: 's1', requestId: 'q1' });
  assert.equal(log.snapshot('s1').state, 'working');
  log.feed({ kind: 'chat_subscribed', sessionId: 's2', isProcessing: false, pendingPermissions: [] });
  assert.equal(log.snapshot('s2').state, 'idle');
});

// --- owner 2026-10-07: the pending on-screen question is kept whole (R3) ----

test('permission_request keeps the pending AskUserQuestion: requestId, toolName, questions+labels, input', () => {
  const log = createProgressLog();
  log.feed({
    kind: 'permission_request',
    sessionId: 's1',
    seq: 1,
    requestId: 'req-7',
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Which arm?', options: [{ label: 'BASE' }, { label: 'ONR' }], multiSelect: true }] },
  });
  const pending = log.snapshot('s1').pendingQuestion;
  assert.equal(pending.requestId, 'req-7');
  assert.equal(pending.toolName, 'AskUserQuestion');
  assert.deepEqual(pending.questions, [{ question: 'Which arm?', options: ['BASE', 'ONR'], multiSelect: true }]);
  assert.deepEqual(pending.input, { questions: [{ question: 'Which arm?', options: [{ label: 'BASE' }, { label: 'ONR' }], multiSelect: true }] });
});

test('an ExitPlanMode pending keeps the plan text (approval itself stays on screen)', () => {
  const log = createProgressLog();
  log.feed({
    kind: 'permission_request',
    sessionId: 's1',
    seq: 1,
    requestId: 'req-8',
    toolName: 'ExitPlanMode',
    input: { plan: 'Step 1 do this.\nStep 2 verify everything.' },
  });
  const pending = log.snapshot('s1').pendingQuestion;
  assert.equal(pending.requestId, 'req-8');
  // WO-VP-PLOG R5: line breaks survive (no more whitespace collapse).
  assert.equal(pending.planText, 'Step 1 do this.\nStep 2 verify everything.');
  assert.ok(!Array.isArray(pending.questions));
});

test('chat_subscribed.pendingPermissions restores an already-waiting question with its input', () => {
  const log = createProgressLog();
  log.feed({
    kind: 'chat_subscribed',
    sessionId: 's1',
    isProcessing: true,
    pendingPermissions: [
      { requestId: 'p-bash', toolName: 'Bash', input: { command: 'ls' } },
      { requestId: 'q9', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Retry?', options: [{ label: 'Yes' }, { label: 'No' }] }] } },
    ],
  });
  const pending = log.snapshot('s1').pendingQuestion;
  assert.equal(pending.requestId, 'q9', 'a question outranks a plain tool approval');
  assert.deepEqual(pending.questions, [{ question: 'Retry?', options: ['Yes', 'No'], multiSelect: false }]);
});

test('resolved / cancelled / complete clear the pending question', () => {
  const log = createProgressLog();
  const ask = { kind: 'permission_request', sessionId: 's1', requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [] } };
  log.feed({ ...ask, seq: 1 });
  assert.ok(log.snapshot('s1').pendingQuestion);
  log.feed({ kind: 'permission_resolved', sessionId: 's1', requestId: 'r1', seq: 2 });
  assert.equal(log.snapshot('s1').pendingQuestion, null);
  log.feed({ ...ask, seq: 3 });
  log.feed({ kind: 'permission_cancelled', sessionId: 's1', requestId: 'r1', seq: 4 });
  assert.equal(log.snapshot('s1').pendingQuestion, null);
  log.feed({ ...ask, seq: 5 });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 6 });
  assert.equal(log.snapshot('s1').pendingQuestion, null);
});

test('NEG CONTROL: plain tool permissions carry no questions, and ordinary frames leave pendingQuestion null', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'go', seq: 1 });
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 2, toolName: 'Bash', toolInput: { command: 'ls' } });
  assert.equal(log.snapshot('s1').pendingQuestion, null, 'no question without a permission_request');
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 3, requestId: 'r2', toolName: 'Bash', input: { command: 'ls' } });
  const pending = log.snapshot('s1').pendingQuestion;
  assert.deepEqual(pending.questions, []);
  assert.ok(!('planText' in pending));
});

// --- Owner 2026-10-07 WO-VP-PLOG: R1-R7 + the incident -------------------

// R1: silent REST-history replay after a live frame never clobbers the
// snapshot; it can only fill an EMPTY lastAssistantText.
test('R1: silent feeds after a live frame never touch state/question/todos/recent, only fill empty lastAssistantText', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'go', seq: 1 }); // live
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 2, toolName: 'Grep', toolId: 't1' });
  const before = log.snapshot('s1');
  log.feed({ kind: 'permission_request', sessionId: 's1', requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [] } }, { silent: true });
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Write', toolId: 't9' }, { silent: true }); // REST row, no seq
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'REST history reply' }, { silent: true });
  const after = log.snapshot('s1');
  assert.equal(after.state, before.state, 'silent replay must not change state');
  assert.equal(after.pendingQuestion, null, 'silent replay must not set a question');
  assert.deepEqual(after.recent, before.recent, 'silent replay must not add recent lines');
  assert.deepEqual(after.todos, before.todos);
  assert.equal(after.lastAssistantText, 'REST history reply', 'empty lastAssistantText may be filled');
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'a later REST row' }, { silent: true });
  assert.equal(log.snapshot('s1').lastAssistantText, 'REST history reply', 'a filled lastAssistantText is never overwritten');
});

// R2: dedupe tool_use by toolId across REST rows and live frames.
test('R2: an already-seen toolId is ignored entirely (no duplicate recent, no counter bump)', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'working', seq: 1 });
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Write', toolId: 'toolu_1', seq: 2 });
  const before = log.snapshot('s1');
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Write', toolId: 'toolu_1' }); // REST replay, no seq
  const after = log.snapshot('s1');
  assert.deepEqual(after.recent, before.recent, 'replayed toolId must not duplicate recent');
  assert.equal(after.toolsSinceLastText, before.toolsSinceLastText, 'replayed toolId must not bump the tool counter');
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Grep', toolId: 'toolu_2' }); // a different id classifies
  assert.ok(log.snapshot('s1').recent.includes('Tool: Grep'));
});

test('R2: the toolId dedupe window is bounded to the last 500 ids', () => {
  const log = createProgressLog();
  for (let i = 0; i <= 500; i++) log.feed({ kind: 'tool_use', sessionId: 's1', toolName: `T${i}`, toolId: `id-${i}` });
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'T0', toolId: 'id-0' }); // id-0 evicted -> classifies again
  assert.equal(log.snapshot('s1').recent.at(-1), 'Tool: T0');
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'T500', toolId: 'id-500' }); // still remembered
  assert.equal(log.snapshot('s1').recent.at(-1), 'Tool: T0');
});

// R3: a waiting plan/question is never clobbered.
test('R3: while a question waits, tool_use and user text never move state off waiting_permission', () => {
  const log = createProgressLog();
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 1, requestId: 'r1', toolName: 'ExitPlanMode', input: { plan: 'Step 1.' } });
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 2, toolName: 'Write', toolId: 't1' });
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', seq: 3, content: 'tool result row' });
  const snapshot = log.snapshot('s1');
  assert.equal(snapshot.state, 'waiting_permission');
  assert.equal(snapshot.pendingQuestion.requestId, 'r1');
});

test('R3: resolve/cancel for a DIFFERENT requestId never clears the question; equal or missing requestId does', () => {
  const log = createProgressLog();
  const ask = { kind: 'permission_request', sessionId: 's1', toolName: 'ExitPlanMode', input: { plan: 'The plan.' } };
  log.feed({ ...ask, seq: 1, requestId: 'plan-1' });
  log.feed({ kind: 'permission_resolved', sessionId: 's1', seq: 2, requestId: 'other-9' });
  assert.equal(log.snapshot('s1').state, 'waiting_permission');
  assert.equal(log.snapshot('s1').pendingQuestion.requestId, 'plan-1');
  log.feed({ kind: 'permission_cancelled', sessionId: 's1', seq: 3, requestId: 'other-9' });
  assert.equal(log.snapshot('s1').pendingQuestion.requestId, 'plan-1');
  log.feed({ kind: 'permission_resolved', sessionId: 's1', seq: 4, requestId: 'plan-1' }); // the real answer
  assert.equal(log.snapshot('s1').pendingQuestion, null);
  assert.equal(log.snapshot('s1').state, 'working');
  log.feed({ ...ask, seq: 5, requestId: 'plan-2' });
  log.feed({ kind: 'permission_cancelled', sessionId: 's1', seq: 6 }); // no requestId -> back-compat clear
  assert.equal(log.snapshot('s1').pendingQuestion, null);
});

test('R3: complete and error release the waiting question', () => {
  const log = createProgressLog();
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 1, requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [] } });
  log.feed({ kind: 'error', sessionId: 's1', seq: 2 });
  assert.equal(log.snapshot('s1').pendingQuestion, null);
  assert.equal(log.snapshot('s1').state, 'idle');
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 3, requestId: 'r2', toolName: 'AskUserQuestion', input: { questions: [] } });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 4 });
  assert.equal(log.snapshot('s1').pendingQuestion, null);
});

// R4: the server restarts seq at 1 per run — the watermark must reset.
test('R4: complete resets the seq watermark, so run 2 (seq restarting at 1) is fully applied', () => {
  const log = createProgressLog();
  const events = [];
  log.onUpdate((event) => events.push(event));
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'run 1', seq: 1 });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'first reply', seq: 2 });
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Bash', toolId: 'a1', seq: 3 });
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Grep', toolId: 'a2', seq: 4 });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 5 });
  log.feed({ kind: 'text', role: 'user', sessionId: 's1', content: 'run 2', seq: 1 });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'second reply', seq: 2 });
  log.feed({ kind: 'complete', sessionId: 's1', seq: 3 });
  assert.deepEqual(events.map((event) => [event.type, event.text]), [
    ['progress', 'first reply'],
    ['complete', 'Claude finished.'],
    ['progress', 'second reply'],
    ['complete', 'Claude finished.'],
  ]);
});

test('R4: chat_subscribed with a lower numeric lastSeq resets the watermark (new run after reload)', () => {
  const log = createProgressLog();
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'old run tail', seq: 9 });
  log.feed({ kind: 'chat_subscribed', sessionId: 's1', isProcessing: true, lastSeq: 2 });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', content: 'new run line', seq: 3 });
  assert.equal(log.snapshot('s1').lastAssistantText, 'new run line');
});

// R5: plans keep their line breaks; 3+ newlines collapse to one blank line.
test('R5: planText keeps line breaks, collapses space/tab runs, clips only at 60000', () => {
  const log = createProgressLog();
  const plan = ['Step 1   do this.', '\tStep 2  verify.', '', '', 'Step 3 report.'].join('\n');
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 1, requestId: 'p1', toolName: 'ExitPlanMode', input: { plan } });
  assert.equal(log.snapshot('s1').pendingQuestion.planText, 'Step 1 do this.\nStep 2 verify.\n\nStep 3 report.');
  log.feed({
    kind: 'permission_request',
    sessionId: 's1',
    seq: 2,
    requestId: 'p2',
    toolName: 'ExitPlanMode',
    input: { plan: 'A plan line. '.repeat(6000) }, // ~72k chars — must clip, not truncate silently
  });
  const clipped = log.snapshot('s1').pendingQuestion.planText;
  assert.ok(clipped.length <= 60002, `too long: ${clipped.length}`);
  assert.ok(clipped.endsWith('…'), clipped.slice(-20));
});

// R6: snapshot clock bookkeeping with an injectable now().
test('R6: lastAssistantAt and toolsSinceLastText with an injectable clock', () => {
  let clock = 1000;
  const log = createProgressLog({ now: () => clock });
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 1, toolName: 'Bash', toolId: 't1' });
  let snapshot = log.snapshot('s1');
  assert.equal(snapshot.lastAssistantAt, null);
  assert.equal(snapshot.toolsSinceLastText, 1); // live tool_use before any text
  clock = 2000;
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', seq: 2, content: 'Working on it.' });
  snapshot = log.snapshot('s1');
  assert.equal(snapshot.lastAssistantAt, 2000);
  assert.equal(snapshot.toolsSinceLastText, 0); // reset on new live text
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 3, toolName: 'Grep', toolId: 't2' });
  log.feed({ kind: 'tool_use', sessionId: 's1', seq: 4, toolName: 'Grep', toolId: 't2' }); // deduped -> not counted
  assert.equal(log.snapshot('s1').toolsSinceLastText, 1);
});

// The incident itself: ExitPlanMode waiting, then get_claude_status ->
// session-history.refresh replays the freshly persisted Write + ExitPlanMode
// rows silently into the log.
test('INCIDENT: silent REST Write + ExitPlanMode rows never clobber the waiting plan', () => {
  const log = createProgressLog();
  log.feed({
    kind: 'permission_request',
    sessionId: 's1',
    seq: 1,
    requestId: 'pl-1',
    toolName: 'ExitPlanMode',
    input: { plan: 'Step 1 fix.\nStep 2 test.' },
  });
  const before = log.snapshot('s1');
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'Write', toolId: 'row-1', toolInput: { file_path: '/x/y.mjs' } }, { silent: true });
  log.feed({ kind: 'tool_use', sessionId: 's1', toolName: 'ExitPlanMode', toolId: 'row-2', toolInput: { plan: 'Step 1 fix.' } }, { silent: true });
  const after = log.snapshot('s1');
  assert.equal(after.state, 'waiting_permission');
  assert.equal(after.pendingQuestion.requestId, 'pl-1');
  assert.equal(after.pendingQuestion.planText, 'Step 1 fix.\nStep 2 test.');
  assert.deepEqual(after.recent, before.recent, 'no duplicate recent lines from the replay');
});

// Wave-1 review (2026-10-07): a replayed LIVE assistant frame (reload
// subscribe replay, seq reset) never flips a waiting plan to working.
test('a live assistant frame while a plan waits keeps waiting_permission', () => {
  const log = createProgressLog();
  log.feed({ kind: 'permission_request', sessionId: 's1', seq: 1, requestId: 'req-9', toolName: 'ExitPlanMode', input: { plan: 'Step 1.' } });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', seq: 2, content: 'Here is the plan.' });
  const snap = log.snapshot('s1');
  assert.equal(snap.state, 'waiting_permission');
  assert.equal(snap.pendingQuestion.requestId, 'req-9');
  assert.equal(snap.lastAssistantText, 'Here is the plan.');
  log.feed({ kind: 'permission_resolved', sessionId: 's1', seq: 3, requestId: 'req-9' });
  log.feed({ kind: 'text', role: 'assistant', sessionId: 's1', seq: 4, content: 'Implementing now.' });
  assert.equal(log.snapshot('s1').state, 'working');
});
