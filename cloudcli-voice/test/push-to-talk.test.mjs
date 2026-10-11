// Owner ruling Q9a (2026-10-10): optional push-to-talk for the Live call,
// DEFAULT OFF. OFF must be byte-identical to a call without the feature; ON
// forwards the mic only while the hold button / Space key is held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPushToTalk, isEditableTarget, isPttKeyEvent, FLAG_PUSH_TO_TALK, PTT_KEY_CODE } from '../lib/push-to-talk.mjs';
import { createAddonFlags } from '../lib/feature-flags.mjs';
import { createLiveCall } from '../lib/live-call.mjs';

const FLAG_KEY = `cloudcli-voice:flag:${FLAG_PUSH_TO_TALK}`;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function brokenStorage() {
  return {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
    removeItem() {},
  };
}

function spyCall(muted = false) {
  const calls = [];
  return {
    calls,
    muted,
    mute(value) {
      calls.push(Boolean(value));
      this.muted = Boolean(value);
    },
    isMuted() {
      return this.muted;
    },
  };
}

const body = { tagName: 'BODY' };
const space = (extra = {}) => ({ code: PTT_KEY_CODE, key: ' ', target: body, ...extra });

// --- setting -----------------------------------------------------------------

test('PTT setting defaults OFF: empty, corrupt and "false" storage all read OFF; only an explicit true enables it', () => {
  assert.equal(createPushToTalk({ flags: createAddonFlags(memoryStorage()) }).enabled(), false);
  assert.equal(createPushToTalk({ flags: createAddonFlags(memoryStorage({ [FLAG_KEY]: 'yes?' })) }).enabled(), false);
  assert.equal(createPushToTalk({ flags: createAddonFlags(memoryStorage({ [FLAG_KEY]: 'false' })) }).enabled(), false);
  assert.equal(createPushToTalk({ flags: createAddonFlags(memoryStorage({ [FLAG_KEY]: 'true' })) }).enabled(), true);
  assert.equal(createPushToTalk({ flags: createAddonFlags(brokenStorage()) }).enabled(), false);
  assert.equal(createPushToTalk().enabled(), false);
});

test('PTT setting persists to localStorage and still works in memory when storage throws', () => {
  const storage = memoryStorage();
  const ptt = createPushToTalk({ flags: createAddonFlags(storage) });
  assert.equal(ptt.setEnabled(true), true);
  assert.equal(storage.data.get(FLAG_KEY), 'true');
  assert.equal(createPushToTalk({ flags: createAddonFlags(storage) }).enabled(), true, 'remembered for the next call/page');
  ptt.setEnabled(false);
  assert.equal(storage.data.get(FLAG_KEY), 'false');
  const blind = createPushToTalk({ flags: createAddonFlags(brokenStorage()) });
  assert.equal(blind.setEnabled(true), true);
  assert.equal(blind.enabled(), true, 'private mode: the tab keeps the choice');
});

// --- OFF: never touches the call ----------------------------------------------

test('PTT OFF: attach/press/release/keys/blur never call mute and never consume a key', () => {
  const call = spyCall();
  const changes = [];
  const ptt = createPushToTalk({ flags: createAddonFlags(memoryStorage()), onChange: (s) => changes.push(s) });
  ptt.attach(call);
  assert.equal(ptt.press('pointer'), false);
  assert.equal(ptt.keyDown(space()), false);
  assert.equal(ptt.keyDown(space({ repeat: true })), false);
  assert.equal(ptt.keyUp(space()), false);
  assert.equal(ptt.release('pointer'), false);
  assert.equal(ptt.release(), false);
  ptt.detach();
  assert.deepEqual(call.calls, [], 'OFF must never mute/unmute the call');
  assert.ok(changes.every((s) => s.enabled === false && s.held === false));
});

// --- ON: closed until held ----------------------------------------------------

test('PTT ON: attach closes the mic; hold opens it once; the last release closes it again', () => {
  const call = spyCall();
  const ptt = createPushToTalk({ flags: createAddonFlags(memoryStorage({ [FLAG_KEY]: 'true' })) });
  ptt.attach(call);
  assert.deepEqual(call.calls, [true]);
  assert.equal(ptt.press('pointer'), true);
  assert.equal(ptt.press('key'), true); // a second source does not re-unmute
  assert.deepEqual(call.calls, [true, false]);
  assert.equal(ptt.release('pointer'), false, 'the key still holds');
  assert.deepEqual(call.calls, [true, false]);
  assert.equal(ptt.release('key'), true);
  assert.deepEqual(call.calls, [true, false, true]);
  ptt.press('pointer');
  ptt.press('key');
  assert.equal(ptt.release(), true, 'blur/hidden tab releases every source');
  assert.deepEqual(call.calls, [true, false, true, false, true]);
  assert.equal(ptt.isHeld(), false);
  ptt.detach();
  assert.equal(ptt.press('pointer'), false, 'no call: nothing to open');
  assert.deepEqual(call.calls, [true, false, true, false, true]);
});

test('PTT key: Space outside text fields talks; text fields, modifiers and other keys are never consumed', () => {
  const call = spyCall();
  const ptt = createPushToTalk({ flags: createAddonFlags(memoryStorage({ [FLAG_KEY]: 'true' })) });
  ptt.attach(call);
  const textarea = { tagName: 'TEXTAREA' };
  assert.equal(ptt.keyDown(space({ target: textarea })), false);
  assert.equal(ptt.keyDown(space({ target: { tagName: 'INPUT', type: 'text' } })), false);
  assert.equal(ptt.keyDown(space({ target: { tagName: 'DIV', isContentEditable: true } })), false);
  assert.equal(ptt.keyDown(space({ target: { tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'textbox' : null) } })), false);
  assert.equal(ptt.keyDown(space({ ctrlKey: true })), false);
  assert.equal(ptt.keyDown(space({ isComposing: true })), false);
  assert.equal(ptt.keyDown({ code: 'KeyA', target: body }), false);
  assert.deepEqual(call.calls, [true], 'none of those opened the mic');
  assert.equal(ptt.keyDown(space({ target: { tagName: 'INPUT', type: 'checkbox' } })), true, 'a checkbox is not a text field');
  assert.equal(ptt.keyDown(space({ repeat: true })), true, 'auto-repeat is consumed without re-unmuting');
  assert.deepEqual(call.calls, [true, false]);
  assert.equal(ptt.keyUp(space({ target: textarea })), true, 'keyup inside a text field still releases (no stuck mic)');
  assert.deepEqual(call.calls, [true, false, true]);
  assert.equal(ptt.keyUp(space()), false, 'no key hold: nothing to consume');
});

test('editable-target and key helpers', () => {
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true, 'missing type = text');
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isEditableTarget({ tagName: 'DIV', getAttribute: () => { throw new Error('x'); } }), false);
  assert.equal(isPttKeyEvent(null), false);
  assert.equal(isPttKeyEvent(space({ metaKey: true })), false);
  assert.equal(isPttKeyEvent(space({ altKey: true })), false);
  assert.equal(isPttKeyEvent(space({ shiftKey: true })), true);
});

test('PTT toggled mid-call: ON closes the mic, OFF restores the mute state the owner had before', () => {
  const storage = memoryStorage();
  const call = spyCall();
  const ptt = createPushToTalk({ flags: createAddonFlags(storage) });
  ptt.attach(call);
  ptt.setEnabled(true);
  assert.deepEqual(call.calls, [true]);
  ptt.press('pointer');
  ptt.setEnabled(false); // turned off while held: the hold is dropped
  assert.equal(ptt.isHeld(), false);
  assert.deepEqual(call.calls, [true, false, false]);
  assert.equal(call.isMuted(), false, 'open mic, as before PTT');
  call.mute(true); // the owner mutes by hand (OFF mode)
  call.calls.length = 0;
  ptt.setEnabled(true);
  ptt.setEnabled(false);
  assert.deepEqual(call.calls, [true, true], 'back to OFF keeps the manual mute');
  assert.equal(call.isMuted(), true);
  call.calls.length = 0;
  ptt.setEnabled(false); // no change: nothing touches the call
  assert.deepEqual(call.calls, []);
});

// --- another tab (window `storage` event) ---------------------------------------

/** Stands in for window: another tab writes storage, then the browser fires `storage` here. */
function storageEventTarget() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    fire(event) {
      for (const l of listeners) if (l.type === 'storage') l.fn(event);
    },
  };
}

function otherTabWrites(storage, tab, value) {
  const oldValue = storage.getItem(FLAG_KEY);
  storage.setItem(FLAG_KEY, value);
  tab.fire({ key: FLAG_KEY, oldValue, newValue: String(value) });
}

test('another tab turning PTT ON never changes a call attached with PTT OFF; button and next call follow after it', () => {
  const storage = memoryStorage();
  const tab = storageEventTarget();
  const changes = [];
  const ptt = createPushToTalk({ flags: createAddonFlags(storage), onChange: (s) => changes.push(s), storageEvents: tab });
  assert.equal(tab.listeners.filter((l) => l.type === 'storage').length, 1, 'one storage listener');
  const call = spyCall();
  ptt.attach(call);
  changes.length = 0;
  otherTabWrites(storage, tab, 'true');
  assert.equal(ptt.enabled(), false, 'the attached call keeps PTT OFF');
  assert.deepEqual(ptt.snapshot(), { enabled: false, held: false, attached: true }, 'the button shows the mode the call really has');
  assert.deepEqual(changes, [], 'nothing changed for this call');
  assert.equal(ptt.press('pointer'), false);
  assert.equal(ptt.keyDown(space()), false, 'Space is still a plain key: not consumed');
  assert.equal(ptt.keyUp(space()), false);
  assert.equal(ptt.release('pointer'), false);
  assert.equal(ptt.release(), false);
  assert.deepEqual(call.calls, [], 'the OFF call is never muted or unmuted');
  ptt.detach();
  assert.equal(ptt.enabled(), true, 'after the call: the other tab\'s setting');
  assert.equal(changes.at(-1).enabled, true, 'the button follows once the call ends');
  const next = spyCall();
  ptt.attach(next);
  assert.deepEqual(next.calls, [true], 'the next call starts in PTT mode');
});

test('another tab turning PTT OFF never strands a call attached with PTT ON: hold still opens and closes the mic', () => {
  const storage = memoryStorage({ [FLAG_KEY]: 'true' });
  const tab = storageEventTarget();
  const ptt = createPushToTalk({ flags: createAddonFlags(storage), storageEvents: tab });
  const call = spyCall();
  ptt.attach(call);
  otherTabWrites(storage, tab, 'false');
  assert.equal(ptt.enabled(), true);
  assert.equal(ptt.keyDown(space()), true);
  assert.equal(ptt.keyUp(space()), true);
  ptt.press('pointer');
  ptt.release();
  assert.deepEqual(call.calls, [true, false, true, false, true], 'same PTT behaviour as at attach');
  ptt.detach();
  assert.equal(ptt.enabled(), false);
  const next = spyCall();
  ptt.attach(next);
  assert.deepEqual(next.calls, [], 'the next call is a plain OFF call');
});

test('mid-call toggle in this tab after another tab\'s change flips the call from the mode the button shows', () => {
  const storage = memoryStorage();
  const tab = storageEventTarget();
  const ptt = createPushToTalk({ flags: createAddonFlags(storage), storageEvents: tab });
  const call = spyCall();
  ptt.attach(call);
  otherTabWrites(storage, tab, 'true');
  assert.equal(ptt.setEnabled(!ptt.enabled()), true, 'the click turns ON what the button showed as OFF');
  assert.deepEqual(call.calls, [true]);
  assert.equal(storage.data.get(FLAG_KEY), 'true');
  ptt.detach();
  assert.equal(ptt.enabled(), true);
});

test('no call attached: another tab\'s toggle re-renders at once and wins over this tab\'s older choice; other keys are ignored', () => {
  const storage = memoryStorage();
  const tab = storageEventTarget();
  const changes = [];
  const ptt = createPushToTalk({ flags: createAddonFlags(storage), onChange: (s) => changes.push(s), storageEvents: tab });
  ptt.setEnabled(true); // this tab's own choice
  changes.length = 0;
  storage.setItem('cloudcli-voice:flag:liveRefresh', 'false');
  tab.fire({ key: 'cloudcli-voice:flag:liveRefresh', oldValue: null, newValue: 'false' });
  assert.equal(ptt.storageChanged({ key: 'unrelated' }), false);
  assert.deepEqual(changes, [], 'an unrelated key changes nothing');
  otherTabWrites(storage, tab, 'false');
  assert.equal(ptt.enabled(), false, 'the newer write from the other tab wins');
  assert.deepEqual(changes, [{ enabled: false, held: false, attached: false }]);
  otherTabWrites(storage, tab, 'true');
  storage.data.clear();
  assert.equal(ptt.storageChanged({ key: null }), true, 'localStorage.clear() in another tab');
  assert.equal(ptt.enabled(), false, 'cleared storage = default OFF');
  assert.deepEqual(changes.map((s) => s.enabled), [false, true, false]);
});

test('the storage listener defaults to window in a browser; Node (no window) and an explicit null subscribe nothing', () => {
  const tab = storageEventTarget();
  globalThis.window = tab;
  try {
    createPushToTalk({ flags: createAddonFlags(memoryStorage()) });
    createPushToTalk({ flags: createAddonFlags(memoryStorage()), storageEvents: null });
  } finally {
    delete globalThis.window;
  }
  assert.equal(tab.listeners.filter((l) => l.type === 'storage').length, 1);
  assert.equal(typeof globalThis.window, 'undefined');
  assert.doesNotThrow(() => createPushToTalk({ storageEvents: { addEventListener() { throw new Error('denied'); } } }));
});

// --- integration with the real live call --------------------------------------

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }

  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  message(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
}

const tick = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function pcm(amplitude, samples = 1280) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return buf.toString('base64');
}

function callHarness({ storage = null, withPtt = false, storageEvents = null } = {}) {
  FakeWebSocket.instances.length = 0;
  const clock = { ms: 1000 };
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms: ms || 0 };
      pending.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const i = pending.indexOf(handle);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const audio = {
    mutedTo: [],
    playing: false,
    onChunk: null,
    async startMic() {},
    stopMic() {},
    setMuted(value) {
      this.mutedTo.push(value);
    },
    resume() {},
    play() {},
    flush() {
      this.playing = false;
    },
    close() {},
    isPlaying() {
      return this.playing;
    },
  };
  const events = [];
  const call = createLiveCall({
    onEvent: (name, n) => events.push([name, n]),
    deps: {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ token: 't', model: 'gemini-3.8-live', wsUrl: 'wss://live.example/ws', expiresAt: 1 }) }),
      WebSocket: FakeWebSocket,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      now: () => clock.ms,
      audio: (handlers) => {
        audio.onChunk = handlers.onChunk;
        return audio;
      },
    },
  });
  // The add-on attaches the controller after createLiveCall, before start().
  const ptt = withPtt ? createPushToTalk({ flags: createAddonFlags(storage || memoryStorage()), storageEvents }) : null;
  if (ptt) ptt.attach(call);
  call.start().catch(() => {});
  return {
    call,
    ptt,
    audio,
    events,
    clock,
    async live() {
      await tick();
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      ws.open();
      await tick();
      ws.message({ setupComplete: {} });
      await tick();
      return ws;
    },
    async runTimer(ms) {
      const i = pending.findIndex((h) => h.ms === ms);
      assert.ok(i >= 0, `no pending ${ms} ms timer`);
      const [handle] = pending.splice(i, 1);
      await handle.fn();
    },
    hasTimer: (ms) => pending.some((h) => h.ms === ms),
  };
}

const audioFrames = (ws) => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => m.realtimeInput.audio.data);
const streamEnds = (ws) => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd === true).length;
const isSilence = (data) => /^A+=*$/.test(data);

// One scripted call. `input` delivers the owner's PTT gestures; without a
// controller they go nowhere — exactly today's add-on. `midCall` runs once
// the call is live (e.g. another tab toggling the setting).
async function scriptedCall(h, { midCall = null } = {}) {
  const ws = await h.live();
  if (midCall) midCall();
  const input = (fn) => {
    if (h.ptt) fn(h.ptt);
  };
  const loud = pcm(12000);
  const quiet = pcm(200);
  h.audio.onChunk(quiet);
  h.audio.onChunk(loud);
  input((p) => p.keyDown(space()));
  h.audio.onChunk(loud);
  input((p) => p.keyDown(space({ repeat: true })));
  input((p) => p.keyUp(space()));
  input((p) => p.press('pointer'));
  h.audio.onChunk(loud);
  input((p) => p.release('pointer'));
  ws.message({ serverContent: { inputTranscription: { text: 'hello' } } });
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] } } });
  h.audio.playing = true;
  h.clock.ms += 2000;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(quiet);
  ws.message({ serverContent: { turnComplete: true } });
  h.audio.playing = false;
  h.clock.ms += 1000;
  input((p) => p.release());
  h.audio.onChunk(loud);
  await tick();
  return ws;
}

test('PTT OFF is byte-identical: the same call with the controller attached (OFF) sends exactly the same frames', async () => {
  const plain = callHarness();
  const wsPlain = await scriptedCall(plain);
  const withOff = callHarness({ withPtt: true, storage: memoryStorage() });
  assert.equal(withOff.ptt.enabled(), false, 'default OFF');
  const wsOff = await scriptedCall(withOff);
  assert.ok(audioFrames(wsPlain).length > 0, 'the scripted call forwards mic audio (non-vacuous)');
  assert.deepEqual(wsOff.sent, wsPlain.sent, 'every frame, in order, byte for byte');
  assert.deepEqual(withOff.audio.mutedTo, plain.audio.mutedTo);
  assert.deepEqual(withOff.events, plain.events);
  assert.equal(withOff.call.isMuted(), false);
});

test('PTT OFF stays byte-identical when another tab turns PTT ON mid-call', async () => {
  const plain = callHarness();
  const wsPlain = await scriptedCall(plain);
  const storage = memoryStorage();
  const tab = storageEventTarget();
  const h = callHarness({ withPtt: true, storage, storageEvents: tab });
  const ws = await scriptedCall(h, { midCall: () => otherTabWrites(storage, tab, 'true') });
  assert.equal(storage.data.get(FLAG_KEY), 'true', 'the other tab did turn it on (non-vacuous)');
  assert.ok(audioFrames(wsPlain).length > 0);
  assert.deepEqual(ws.sent, wsPlain.sent, 'every frame, in order, byte for byte');
  assert.deepEqual(h.audio.mutedTo, plain.audio.mutedTo);
  assert.deepEqual(h.events, plain.events);
  assert.equal(h.call.isMuted(), false);
});

test('PTT ON: the room never goes up unless held; holding forwards the mic verbatim; release ends the turn', async () => {
  const h = callHarness({ withPtt: true, storage: memoryStorage({ [FLAG_KEY]: 'true' }) });
  assert.equal(h.call.isMuted(), true, 'closed before the first chunk');
  const ws = await h.live();
  const loud = pcm(12000);
  h.audio.onChunk(loud);
  assert.ok(audioFrames(ws).every(isSilence), 'not held: only the zero-filled tail, never the room');
  await h.runTimer(2500); // MUTE_SILENCE_MS tail ends the server turn
  assert.equal(streamEnds(ws), 1);
  const beforeHold = ws.sent.length;
  h.audio.onChunk(loud);
  h.audio.onChunk(loud);
  assert.equal(ws.sent.length, beforeHold, 'after the tail nothing at all goes up');

  assert.equal(h.ptt.keyDown(space()), true);
  h.audio.onChunk(loud);
  const held = audioFrames(ws).slice(-1)[0];
  assert.equal(held, loud, 'held: the mic chunk is forwarded verbatim');
  assert.equal(h.ptt.keyUp(space()), true);
  const afterRelease = audioFrames(ws).length;
  h.audio.onChunk(loud);
  const tail = audioFrames(ws).slice(afterRelease);
  assert.equal(tail.length, 1);
  assert.ok(isSilence(tail[0]), 'released: silence, not the room');
  assert.ok(h.hasTimer(2500), 'release re-arms the silence tail');
  await h.runTimer(2500);
  assert.equal(streamEnds(ws), 2, 'release ends the owner turn');

  h.ptt.press('pointer');
  h.audio.onChunk(loud);
  assert.equal(audioFrames(ws).slice(-1)[0], loud, 'the hold button opens the mic too');
  h.ptt.release('pointer');
  assert.equal(h.call.isMuted(), true);
  const events = h.events.map(([name]) => name);
  assert.deepEqual(events.filter((n) => n === 'mute' || n === 'unmute'), ['mute', 'unmute', 'mute', 'unmute', 'mute']);
});

// --- the add-on's own wiring --------------------------------------------------

const src = readFileSync(new URL('../voice-addon.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name}() not found`);
  let depth = 0;
  // body brace = the first ') {' (parameter lists may hold `{ auto = false } = {}`)
  for (let i = src.indexOf(') {', start) + 2; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}()`);
}

test('add-on wiring: attach before start, detach on every teardown, keys consumed only when the controller says so', () => {
  assert.match(src, /import \{ createPushToTalk \} from '\.\/lib\/push-to-talk\.mjs';/);
  assert.match(src, /const ptt = createPushToTalk\(\{ flags, onChange: \(snapshot\) => safe\(\(\) => renderPtt\(snapshot\)\) \}\);/);
  const start = extractFunction('startCall');
  const attach = start.indexOf('ptt.attach(instance)');
  const begin = start.indexOf('await liveCallInstance.start()');
  assert.ok(attach > 0 && begin > attach, 'PTT must close the mic before the call starts sending');
  assert.match(start, /liveCallInstance = null;\s+safe\(\(\) => ptt\.detach\(\)\);/, 'failed start detaches');
  assert.match(extractFunction('endCall'), /liveCallInstance = null;\s+safe\(\(\) => ptt\.detach\(\)\);/);
  assert.match(src, /if \(callActive && safe\(\(\) => ptt\.keyDown\(event\), false\)\) event\.preventDefault\(\);/);
  assert.match(src, /if \(safe\(\(\) => ptt\.keyUp\(event\), false\)\) event\.preventDefault\(\);/);
  assert.match(src, /window\.addEventListener\('blur', \(\) => safe\(\(\) => ptt\.release\(\)\)\);/);
  assert.match(src, /if \(document\.visibilityState === 'hidden'\) safe\(\(\) => ptt\.release\(\)\);/);
  assert.match(extractFunction('handleCallState'), /liveCallInstance\.isMuted\(\)\) && !ptt\.enabled\(\);/);
  assert.match(extractFunction('showCallBar'), /elements\.mute\.hidden = stateName === 'unavailable' && !callActive;\s+renderPtt\(ptt\.snapshot\(\)\);/);
});

function button() {
  const attrs = {};
  return {
    hidden: false,
    title: '',
    textContent: '',
    captured: null,
    attrs,
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    setPointerCapture(id) {
      this.captured = id;
    },
  };
}

/** renderPtt / togglePushToTalk / pttPointerDown run verbatim in a vm against the real controller. */
function addonPttApi({ stored = null, callMuted = false, state = 'listening' } = {}) {
  const storage = memoryStorage(stored === null ? {} : { [FLAG_KEY]: stored });
  const call = spyCall(callMuted);
  const callUi = {
    pill: { dataset: { state } },
    state: { hidden: true, textContent: '' },
    mute: button(),
    hold: button(),
    pttToggle: button(),
  };
  callUi.hold.hidden = true;
  const ctx = vm.createContext({ callUi, liveCallInstance: call, callActive: true, lastCallState: state });
  ctx.CALL_STATE_WORDS = { connecting: 'c', unavailable: 'u' };
  ctx.MUTED_WORD = 'MUTED';
  ctx.ptt = createPushToTalk({ flags: createAddonFlags(storage), onChange: (s) => ctx.renderPtt(s) });
  vm.runInContext(
    `${['renderPtt', 'togglePushToTalk', 'pttPointerDown'].map(extractFunction).join('\n')}\nglobalThis.api = { renderPtt, togglePushToTalk, pttPointerDown };`,
    ctx,
  );
  return { ctx, call, callUi, storage };
}

test('add-on PTT bar, OFF (default): hold stays hidden and mute is exactly as showCallBar sets it', () => {
  const { ctx, call, callUi } = addonPttApi();
  ctx.api.renderPtt(ctx.ptt.snapshot());
  assert.equal(callUi.hold.hidden, true);
  assert.equal(callUi.mute.hidden, false);
  assert.equal(callUi.pttToggle.attrs['aria-pressed'], 'false');
  ctx.callActive = false;
  callUi.pill.dataset.state = 'unavailable';
  ctx.api.renderPtt(ctx.ptt.snapshot());
  assert.equal(callUi.mute.hidden, true, "same rule as showCallBar: 'unavailable' && !callActive");
  assert.deepEqual(call.calls, []);
});

test('add-on PTT bar: the toggle switches ON (hold replaces mute, no muted word) and back OFF (mute UI restored)', () => {
  const { ctx, call, callUi, storage } = addonPttApi();
  ctx.ptt.attach(call);
  callUi.state.hidden = false;
  callUi.state.textContent = 'MUTED';
  ctx.api.togglePushToTalk();
  assert.equal(storage.data.get(FLAG_KEY), 'true');
  assert.deepEqual(call.calls, [true]);
  assert.equal(callUi.hold.hidden, false);
  assert.equal(callUi.mute.hidden, true);
  assert.equal(callUi.pttToggle.attrs['aria-pressed'], 'true');
  assert.equal(callUi.state.hidden, true, 'PTT ON: the closed mic is normal — no muted word');

  let prevented = 0;
  ctx.api.pttPointerDown({ button: 0, pointerId: 7, preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 1);
  assert.equal(callUi.hold.captured, 7);
  assert.equal(callUi.hold.attrs['aria-pressed'], 'true');
  assert.deepEqual(call.calls, [true, false]);
  ctx.api.pttPointerDown({ button: 2, pointerId: 8, preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 1, 'a right click is ignored');
  ctx.ptt.release('pointer');
  assert.equal(callUi.hold.attrs['aria-pressed'], 'false');

  ctx.api.togglePushToTalk();
  assert.equal(storage.data.get(FLAG_KEY), 'false');
  assert.equal(call.isMuted(), false);
  assert.equal(callUi.hold.hidden, true);
  assert.equal(callUi.mute.hidden, false);
  assert.equal(callUi.mute.textContent, '🎙️');
  assert.equal(callUi.mute.attrs['aria-pressed'], 'false');
  assert.equal(callUi.state.hidden, true);
});
