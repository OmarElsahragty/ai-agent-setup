// WO-VL-UI NEG CONTROL: voice-addon.js must expose exactly ONE call control
// (📞) — no legacy voice controls, no legacy pipeline imports, no legacy
// gateway endpoints. Static source checks only (the module needs a browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { urlSessionId, createCallTarget, createCallActions, createComposerSender } from '../lib/session-target.mjs';

const src = readFileSync(new URL('../voice-addon.js', import.meta.url), 'utf8');

const ALLOWED_LIB_IMPORTS = new Set([
  'chat-input',
  'feature-flags',
  'live-refresh',
  'bg-jobs',
  'activity-bar',
  'progress-log',
  'call-transcript', // owner ruling 2026-10-07: call transcripts
  'voice-bridge',
  'live-call',
  'session-history',
  'addon-version', // owner 2026-10-07: outdated tab reloads once, then calls
  'session-target', // WO-3 (owner R1/R7 2026-10-09): the call's session comes from the URL only
  'push-to-talk', // owner ruling Q9a 2026-10-10: optional Live-call push-to-talk, default OFF
]);

function libImports() {
  const specifiers = [];
  for (const match of src.matchAll(/from\s+'\.\/lib\/([^']+)'\s*;/g)) specifiers.push(match[1].replace(/\.mjs$/, ''));
  return specifiers;
}

test('no legacy voice controls remain (mic PTT, speaker toggle, speech-language selector)', () => {
  assert.ok(!src.includes('🎤'), 'push-to-talk mic glyph must be gone');
  assert.ok(!src.includes('🔊'), 'speaker toggle glyph must be gone');
  assert.ok(!src.includes('lang:'), 'speech-language selector label must be gone');
});

test('exactly ONE 📞 button', () => {
  assert.equal(src.split('📞').length - 1, 1);
});

test('imports only the kept + new lib modules (none of the removed pipeline)', () => {
  const specifiers = libImports();
  assert.ok(specifiers.length > 0, 'lib imports not found');
  const removed = specifiers.filter((name) => !ALLOWED_LIB_IMPORTS.has(name));
  assert.deepEqual(removed, [], 'removed pipeline modules must not be imported');
  for (const required of ['progress-log', 'voice-bridge', 'live-call', 'session-history', 'call-transcript', 'session-target']) {
    assert.ok(specifiers.includes(required), `missing required import: ${required}`);
  }
});

test('no legacy voice gateway endpoints are called', () => {
  for (const endpoint of ['/voice/stt', '/voice/tts', '/voice/narrate']) {
    assert.ok(!src.includes(endpoint), `${endpoint} must be gone`);
  }
});

test('the Gemini call bar keeps only orb + mute + hang up', () => {
  assert.ok(src.includes('ccv-callbar-orb'), 'orb element missing');
  assert.ok(src.includes('ccv-hangup'), 'hang-up button missing');
  assert.ok(src.includes('toggleMute'), 'mute control missing');
  assert.ok(src.includes("'Escape'"), 'Escape must end the call');
  assert.ok(src.includes('wakeLock'), 'Wake Lock must be held during the call');
  assert.ok(src.includes("'[CLAUDE UPDATE] '"), 'proactive push prefix missing');
  assert.ok(src.includes("'[SESSION CONTEXT] '"), 'session context push prefix missing');
  assert.ok(src.includes('pushContext'), 'silent context push (turnComplete:false) wiring missing');
});

test('WO-VL-CTX: no full-screen call container — the chat must stay visible', () => {
  assert.ok(!src.includes('inset:0'), 'a full-cover call container crept back in');
  assert.ok(!src.includes('100vh'), 'viewport-height call UI crept back in');
  assert.ok(!src.includes('100vw'), 'viewport-width call UI crept back in');
  assert.ok(src.includes('position:fixed'), 'the floating call bar must be fixed-positioned');
  assert.ok(src.includes('env(safe-area-inset-top'), 'the call bar must respect the safe-area inset');
});

// Owner 2026-10-08 extends it: a third button, retry (↻), exists but is hidden
// except in the 'unavailable' state. Owner ruling Q9a (2026-10-10) adds the
// push-to-talk setting (PTT) and its hold button, hidden unless PTT is ON.
test('WO-VL-CTX: the call bar shows only mute + hang up; retry is hidden outside unavailable', () => {
  const start = src.indexOf('function ensureCallUi');
  const end = src.indexOf('function showCallBar');
  assert.ok(start >= 0 && end > start, 'ensureCallUi block not found');
  const block = src.slice(start, end);
  const buttons = block.match(/createElement\('button'\)/g) || [];
  assert.equal(buttons.length, 5, `expected mute + hang-up + retry + PTT setting + hold, got ${buttons.length}`);
  assert.ok(block.includes("mute.title = 'Mute'"));
  assert.ok(block.includes("hangup.title = 'Hang up'"));
  assert.ok(block.includes("retry.title = 'Retry'"));
  assert.ok(block.includes('retry.hidden = true;'), 'retry must start hidden');
  assert.ok(block.includes('hold.hidden = true;'), 'the hold button must start hidden (PTT default OFF)');
  assert.ok(block.includes("pttToggle.setAttribute('aria-pressed', 'false');"), 'the PTT setting must render OFF by default');
  assert.ok(block.includes("mute.addEventListener('click', () => safe(toggleMute));"), 'the mute button wiring is unchanged');
  assert.ok(src.includes("callUi.retry.hidden = stateName !== 'unavailable';"), 'retry visibility not tied to unavailable');
  assert.ok(src.includes("elements.retry.hidden = stateName !== 'unavailable';"));
  assert.ok(src.includes('.ccv-callbtn[hidden]{display:none!important;}'), 'hidden buttons must not render');
});

test('owner 2026-10-08: a call that never connects keeps the bar in unavailable (no silent vanish)', () => {
  const start = src.indexOf('async function startCall');
  const end = src.indexOf('function closeTranscriptAfterTools');
  const block = src.slice(start, end);
  assert.ok(block.includes("showCallBar('unavailable')"));
  assert.ok(!block.includes('callUi.pill.remove()'), 'start failure must not remove the bar');
  assert.ok(src.includes("unavailable: 'صوت جوجل واقع — دوس ↻'"));
});

// Owner 2026-10-07 (call 170008): an empty REST history must fall back to the
// live progress snapshot and retry once, never brief "no messages" while busy.
test('call-start context falls back to the live snapshot and retries once', () => {
  const start = src.indexOf('async function seedSessionContext');
  assert.ok(start > 0, 'seedSessionContext exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /snapshotContext\(progressLog\.snapshot\(sessionId\)\)/);
  assert.match(body, /seedSessionContext\(true\)/);
  assert.match(body, /CONTEXT_RETRY_MS/);
});

// Owner 2026-10-07: every call is pinned to the session open at call start;
// switching the screen to another session hangs it up.
test('the call is pinned to one session and hangs up on a session switch', () => {
  assert.match(src, /getSession: \(\) => callSession\(\)/);
  assert.match(src, /insertAndSend: insertAndSendTo/);
  // Owner 2026-10-07: after Jimmy finishes a part (speaking -> listening) the next part is pushed 3.5 s later,
  // only if he is still listening; a call end clears the timer.
  assert.match(src, /const EXPLAIN_GAP_MS = 3500;/);
  // wave-1 review: the auto-call flag age is checked again when the call would start
  assert.match(src, /const flagAt = autoCallPending;\s+autoCallPending = null;\s+if \(!shouldAutoCall\(\{ flagAt, now: Date\.now\(\) \}\)\) return;/);
  // reload loop guard + fail-open wiring: the pure decision decides, storage failure never reloads
  assert.match(src, /decideCallStart\(\{/);
  // a tool call ends a silent turn before Jimmy speaks the part it returned
  assert.match(src, /const SILENT_TURN_GAP_MS = 8000;\s+function scheduleExplainAfterSilentTurn\(spoke\) \{[^}]*armExplainTimer\(SILENT_TURN_GAP_MS\);/);
  assert.match(src, /if \(prev !== 'speaking' \|\| stateName !== 'listening'\) return;/);
  assert.match(src, /lastCallState !== 'listening'\) return;\s+if \(safe\(\(\) => liveCallInstance\.isModelBusy\(\), false\)\) return;\s+const text = safe\(\(\) => bridge\.nextExplainPart\(\), null\);\s+if \(text\) safe\(\(\) => liveCallInstance\.pushText\(text\)\);/);
  assert.match(src, /safe\(\(\) => scheduleExplainPart\(prev, stateName\)\);/);
  const endHead = src.slice(src.indexOf('function endCall'), src.indexOf('function endCall') + 400);
  assert.match(endHead, /if \(explainTimer\) clearTimeout\(explainTimer\);/);
  // (the re-check of the pin right before submit is the behavioural vm test
  // 'a send whose screen switches ...' below + lib/session-target.mjs tests)
  // App-made text echoed as owner speech never re-arms the owner's tools.
  assert.match(src, /if \(APP_TEXT_RE\.test\(String\(raw \|\| ''\)\)\) return;\s+clearNoiseTimer\(\);[^\n]*\n\s+bridge\.markUserTurn\(raw\)/);
  const check = src.slice(src.indexOf('function checkCallSession'), src.indexOf('function sendAbort'));
  assert.match(check, /if \(verdict === 'end'\) endCall\(\);/);
  assert.match(src, /function syncOpenSession\(\) \{[\s\S]*?safe\(checkCallSession\);/);
  // (the old "abort must follow the pinned session, never the last-seen one"
  // regexes are now the behavioural vm tests below)
  const end = src.slice(src.indexOf('function endCall'), src.indexOf('// Hang up / Escape'));
  assert.match(end, /callTarget\.end\(\);/);
  assert.match(end, /bridge\.callEnded\(\)/, 'R2: hang-up drops the after-queue');
  const seed = src.slice(src.indexOf('async function seedSessionContext'), src.indexOf('let callTranscript'));
  assert.match(seed, /const sessionId = callSession\(\);/);
});

// Owner 2026-10-07: Jimmy answers Claude's on-screen question by voice — the
// frame goes over the page's chat socket, pinned to the call's session.
test('the permission-response sender is wired into the bridge and follows the pinned session', () => {
  assert.match(src, /function sendPermissionResponse\(frame\)/);
  assert.match(src, /createVoiceBridge\(\{[\s\S]*?\n  sendPermissionResponse,\n[\s\S]*?\n\}\);/);
  // Owner 2026-10-07 (call 205456): status sees the activity bar's running jobs.
  assert.match(src, /getBackgroundTasks: \(\) => \{[\s\S]*?item\.status === 'running'/);
  // (the old "the sender must check the pinned call session" regexes are now
  // the behavioural vm tests below)
  // the seed now carries the fuller history (newest 3 claude messages whole)
  assert.match(src, /CONTEXT_PUSH_MAX = 14400/);
});

// Owner 23:1x: the exact-words block starts after Jimmy last spoke.
test('a spoken Jimmy turn closes the owner-words window', () => {
  assert.match(src, /onTurnComplete: \(\{ spoke \} = \{\}\) => safe\(\(\) => \{[\s\S]*?if \(spoke\) bridge\.noteJimmySpoke\(\);[\s\S]*?scheduleExplainAfterSilentTurn\(spoke\);/);
});

// N3 (call 210527): a send in flight at hang-up still finishes and is recorded.
test('endCall closes the transcript only after in-flight tools settle (max 4 s)', () => {
  const end = src.slice(src.indexOf('function endCall'), src.indexOf('// Hang up / Escape'));
  assert.match(src, /const TOOLS_SETTLE_MS = 4000;/);
  const stop = end.indexOf('instance.stop()');
  const close = end.indexOf('closeTranscriptAfterTools(instance, callTranscript)');
  assert.ok(stop > 0 && close > stop, 'stop → close after tools');
  const helper = src.slice(src.indexOf('function closeTranscriptAfterTools'), src.indexOf('function endCall'));
  assert.ok(helper.indexOf('instance.toolsSettled()') < helper.indexOf('transcript.finish()'), 'toolsSettled → finish');
  // the failed-start path uses the same helper
  assert.match(src, /closeTranscriptAfterTools\(failed, callTranscript\)/);
  assert.match(helper, /Promise\.race\(\[settled, new Promise\(\(resolve\) => setTimeout\(resolve, TOOLS_SETTLE_MS\)\)\]\)\.then\(closeTranscript, closeTranscript\)/);
  assert.ok(!/callTranscript\.finish\(\)/.test(end), 'endCall must not close the transcript before tools settle');
  // the per-call transcript stays bound to the call, so late tool results still land
  assert.match(src, /onTranscript: \(role, text\) => safe\(\(\) => transcript && transcript\.add\(role, text\)\)/);
});

// --- WO-3 (owner R1/R7 2026-10-09): behavioural checks of the add-on's OWN
// session code, run in a vm with a stale last-seen session present -----------

function extractFunction(name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name}() not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}()`);
}


/** A top-level `const name = ...;` statement of the add-on (balanced brackets). */
function extractConst(name) {
  const start = src.indexOf(`\nconst ${name} = `);
  assert.ok(start >= 0, `const ${name} not found`);
  let depth = 0;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return src.slice(start + 1, i + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

/**
 * The add-on's OWN session wiring (the callTarget + callActions statements
 * and the functions around them, extracted verbatim from voice-addon.js) run
 * in a vm against the real lib/session-target.mjs, with fake page operations
 * and a stale last-seen session present.
 */
function addonSessionApi() {
  const sent = [];
  const calls = { endCall: 0, seed: 0 };
  const composer = { text: '', idle: true, inserts: 0, submits: 0, submitOk: true, onSettle: null };
  const window = { location: { pathname: '/', host: 'agent.example' } };
  const ctx = vm.createContext({
    window,
    urlSessionId,
    createCallTarget,
    createCallActions,
    createComposerSender,
    safe: (fn, fallback) => {
      try {
        const value = fn();
        return value === undefined ? fallback : value;
      } catch {
        return fallback;
      }
    },
    currentSession: 'A', // what the removed first-frame capture would have left behind
    callActive: true,
    chatSocket: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
    endCall: () => { calls.endCall += 1; },
    seedSessionContext: async () => { calls.seed += 1; },
    // page operations (DOM in the browser): the app's composer + submit
    readComposer: () => ({ text: composer.text, idle: composer.idle }),
    insertIntoInput: (text) => {
      composer.inserts += 1;
      composer.text = composer.text ? `${composer.text} ${text}` : text;
      return true;
    },
    removeInsertedText: (text) => {
      composer.text = composer.text.replace(text, '').trim();
    },
    submitComposer: async () => {
      composer.submits += 1;
      if (!composer.submitOk) return false;
      const match = window.location.pathname.match(/\/session\/([^/?#]+)/);
      sent.push(match ? { type: 'chat.send', sessionId: match[1], content: composer.text } : { type: 'chat.send', content: composer.text });
      composer.text = '';
      return true;
    },
    nextTask: async () => {
      if (typeof composer.onSettle === 'function') composer.onSettle();
    },
    waitFor: async (predicate) => Boolean(predicate()),
  });
  const names = ['openSessionId', 'bgSessionId', 'callSession', 'checkCallSession', 'sendAbort', 'insertAndSendTo', 'sendPermissionResponse'];
  vm.runInContext(
    `${extractConst('callTarget')}\n${extractConst('callActions')}\n${names.map(extractFunction).join('\n')}\nglobalThis.api = { callTarget, callActions, ${names.join(', ')} };`,
    ctx,
  );
  return { api: ctx.api, window, sent, calls, composer, ctx };
}

test('R1: on the New-chat screen the add-on ignores a stale last-seen session (no type, no submit, no abort, no answer)', async () => {
  const { api, window, sent, composer } = addonSessionApi();
  window.location.pathname = '/';
  assert.equal(api.callTarget.begin(), null, 'a call started on New chat binds nothing');
  assert.equal(api.openSessionId(), null);
  assert.equal(api.callSession(), null);
  assert.deepEqual(await api.insertAndSendTo('run the tests'), { error: 'no_session_open' });
  assert.deepEqual(await api.insertAndSendTo('run the tests', 'A'), { error: 'no_session_open' }, 'a stale target is never typed');
  assert.equal(api.sendAbort(), false);
  assert.equal(api.sendPermissionResponse({ type: 'chat.permission-response' }), false);
  assert.equal(composer.inserts, 0, 'the New-chat composer is never typed into');
  assert.equal(composer.submits, 0, 'the New-chat composer is never submitted (no new session)');
  assert.deepEqual(sent, [], 'nothing may reach the chat socket without a session on screen');
});

test('R1/R7: /session/A binds A only; another session on screen ends the call; New chat refuses meanwhile', async () => {
  const { api, window, sent, calls } = addonSessionApi();
  window.location.pathname = '/';
  api.callTarget.begin();
  window.location.pathname = '/session/A';
  api.checkCallSession();
  assert.equal(calls.seed, 1, 'the session the owner opened is adopted and briefed');
  assert.equal(api.callSession(), 'A');
  assert.equal(api.sendAbort(), true);
  assert.equal(await api.insertAndSendTo('x'), true);
  assert.deepEqual(sent, [{ type: 'chat.abort', sessionId: 'A' }, { type: 'chat.send', sessionId: 'A', content: 'x' }]);
  window.location.pathname = '/';
  api.checkCallSession();
  assert.equal(calls.endCall, 0, 'a screen with no session keeps the call');
  assert.equal(api.callSession(), null, '...but nothing may be sent from it');
  assert.equal(api.sendAbort(), false);
  assert.deepEqual(await api.insertAndSendTo('y'), { error: 'no_session_open' });
  window.location.pathname = '/session/B';
  api.checkCallSession();
  assert.equal(calls.endCall, 1, 'another session on screen hangs up');
  assert.equal(sent.length, 2, 'B is never touched');
});

test('R7: a send whose screen switches while React commits the text never submits into the new session', async () => {
  const { api, window, sent, composer } = addonSessionApi();
  window.location.pathname = '/session/A';
  api.callTarget.begin();
  composer.onSettle = () => {
    window.location.pathname = '/session/B';
  };
  assert.deepEqual(await api.insertAndSendTo('x'), { error: 'no_session_open' });
  assert.equal(composer.submits, 0);
  assert.equal(composer.text, '', 'the inserted text was taken back out');
  assert.deepEqual(sent, []);
});

test('R2/WO-3: the add-on never appends to the owner draft, never submits in queue/stop mode, takes a failed send back', async () => {
  const { api, window, sent, composer } = addonSessionApi();
  window.location.pathname = '/session/A';
  api.callTarget.begin();
  composer.text = 'owner draft';
  assert.deepEqual(await api.insertAndSendTo('x'), { error: 'composer_busy' });
  assert.equal(composer.text, 'owner draft');
  composer.text = '';
  composer.idle = false;
  assert.deepEqual(await api.insertAndSendTo('x'), { error: 'still_running' });
  assert.equal(composer.inserts, 0);
  composer.idle = true;
  composer.submitOk = false;
  assert.equal(await api.insertAndSendTo('x'), false);
  assert.equal(composer.text, '', 'the failed text was removed');
  assert.deepEqual(sent, []);
});

test('WO-3: submitComposer refuses queue/stop mode (requestSubmit with no type=submit button)', async () => {
  const submits = [];
  const ctx = vm.createContext({
    document: {},
    window: {},
    outgoingSendCount: 0,
    SEND_CONFIRM_MS: 10,
    locateChatInput: () => ({ kind: 'textarea', form: {} }),
    chooseSubmitStrategy: () => 'requestSubmit',
    findSubmitButton: () => null,
    submitChatInput: (found, strategy) => {
      submits.push(strategy);
      return true;
    },
    waitFor: async () => true,
    chatInputText: () => '',
  });
  vm.runInContext(`${extractFunction('submitComposer')}\nglobalThis.submitComposer = submitComposer;`, ctx);
  assert.equal(await ctx.submitComposer('x'), false);
  assert.deepEqual(submits, [], 'queue/stop mode: nothing submitted');
  ctx.findSubmitButton = () => ({ disabled: true }); // idle form, React has not enabled the button yet
  assert.equal(await ctx.submitComposer('x'), true);
  assert.deepEqual(submits, ['requestSubmit']);
});

test('R1: the first-frame capture is gone; same-origin wrap and tab-close / replacement wiring stay', () => {
  const patch = extractFunction('patchWebSockets');
  assert.ok(!/currentSession === null/.test(patch), 'first-frame session capture must stay deleted');
  assert.match(patch, /Reflect\.construct\(OriginalWebSocket, args, new\.target \|\| PatchedWebSocket\)/);
  assert.match(patch, /if \(!isSameOriginSocketUrl\(url, window\.location\)\) return socket;/);
  assert.match(extractFunction('openSessionId'), /return urlSessionId\(window\.location\);/);
  assert.match(src, /window\.addEventListener\('pagehide', \(\) => \{\s+if \(callActive\) safe\(endCall\);/);
  assert.match(src, /replacementNote: \(\) => safe\(\(\) => bridge\.ordersNote\(\), ''\)/);
});
