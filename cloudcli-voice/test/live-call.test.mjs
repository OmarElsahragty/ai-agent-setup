import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveCall } from '../lib/live-call.mjs';

// --- fakes ----------------------------------------------------------------------

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // 0 connecting, 1 open, 3 closed
    this.sent = []; // parsed messages in send order
    this.closeCalls = 0;
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
    this.closeCalls += 1;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }

  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  drop() {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1006 });
  }

  /** Deliver a server frame as 'string' (default), Blob or ArrayBuffer. */
  message(obj, form = 'string') {
    const raw = JSON.stringify(obj);
    let data = raw;
    if (form === 'blob') data = new Blob([raw]);
    else if (form === 'ab') data = new TextEncoder().encode(raw).buffer;
    if (this.onmessage) this.onmessage({ data });
  }
}

function fakeTimers() {
  const pending = [];
  const setTimeout = (fn, ms) => {
    const handle = { fn, ms: ms || 0, cleared: false };
    pending.push(handle);
    return handle;
  };
  const clearTimeout = (handle) => {
    if (!handle) return;
    handle.cleared = true;
    const i = pending.indexOf(handle);
    if (i >= 0) pending.splice(i, 1); // a cleared timer is gone, as in a real runtime
  };
  const runNext = async () => {
    const handle = pending.shift();
    if (!handle) return null;
    if (handle.cleared) return runNext();
    await handle.fn();
    return handle.ms;
  };
  return { pending, setTimeout, clearTimeout, runNext };
}

function fakeAudioFactory() {
  const api = {
    startCalls: 0,
    closeCalls: 0,
    mutedTo: [],
    plays: [],
    flushes: 0,
    playing: false,
    resumes: 0,
    onChunk: null,
    onLevel: null,
    async startMic() {
      this.startCalls += 1;
    },
    stopMic() {},
    setMuted(value) {
      this.mutedTo.push(value);
    },
    resume() {
      this.resumes += 1;
    },
    play(base64) {
      this.plays.push(base64);
    },
    flush() {
      this.flushes += 1;
      this.playing = false;
    },
    close() {
      this.closeCalls += 1;
    },
    isPlaying() {
      return this.playing;
    },
  };
  const factory = (handlers) => {
    api.onChunk = handlers.onChunk;
    api.onLevel = handlers.onLevel;
    return api;
  };
  return { api, factory };
}

const tick = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness({ tools = {}, token = 'tok-1', onUserSpeech = null, model = 'gemini-3.8-live', onTranscript = null, onTurnComplete = null, replacementNote = null } = {}) {
  const clock = { ms: 0 };
  FakeWebSocket.instances.length = 0;
  const fetches = [];
  const fetch = async (url, init) => {
    fetches.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ token, model, wsUrl: 'wss://live.example/ws', expiresAt: 1 }) };
  };
  const timers = fakeTimers();
  const audio = fakeAudioFactory();
  const states = [];
  const events = [];
  const call = createLiveCall({
    tools,
    onState: (s) => states.push(s),
    onEvent: (name, n) => events.push([name, n]),
    onUserSpeech,
    onTranscript,
    onTurnComplete,
    replacementNote,
    deps: { fetch, WebSocket: FakeWebSocket, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => clock.ms, audio: audio.factory },
  });
  const promise = call.start();
  promise.catch(() => {}); // tests that care await it explicitly
  return {
    clock,
    call,
    promise,
    fetches,
    timers,
    audio: audio.api,
    states,
    events,
    lastState: () => states[states.length - 1],
    lastSent: (ws) => ws.sent[ws.sent.length - 1],
    async openSocket() {
      await tick();
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      ws.open();
      await tick();
      return ws;
    },
    async completeSetup(ws, form = 'string') {
      ws.message({ setupComplete: {} }, form);
      await tick();
    },
  };
}

// --- handshake ------------------------------------------------------------------

test('handshake order: token POST, setup as first message, mic starts in the gesture path (F3)', async () => {
  const h = harness();
  assert.equal(h.lastState(), 'connecting');
  assert.equal(h.audio.startCalls, 1); // F3: mic starts inside start() — the click gesture task
  const ws = await h.openSocket();
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, '/voice/live-token');
  assert.equal(h.fetches[0].init.method, 'POST');
  assert.equal(h.fetches[0].init.credentials, 'include');
  assert.equal(ws.url, 'wss://live.example/ws?access_token=tok-1');
  assert.deepEqual(ws.sent, [{ setup: { model: 'models/gemini-3.8-live', sessionResumption: {} } }]);
  assert.equal(h.audio.startCalls, 1); // and NOT restarted at setupComplete
  await h.completeSetup(ws, 'blob'); // Blob frame decodes fine
  await h.promise; // start() resolves at setupComplete
  assert.equal(h.lastState(), 'listening');
  assert.ok(h.events.some(([name]) => name === 'live-open'));
  assert.equal(h.call.isModelBusy(), false);
});

test('token is URL-encoded into the access_token query parameter', async () => {
  const h = harness({ token: 't/1 &x' });
  const ws = await h.openSocket();
  assert.equal(ws.url, 'wss://live.example/ws?access_token=t%2F1%20%26x');
});

test('NEG CONTROL: no mic audio is sent before setupComplete', async () => {
  const h = harness();
  const ws = await h.openSocket();
  assert.deepEqual(ws.sent, [{ setup: { model: 'models/gemini-3.8-live', sessionResumption: {} } }]);
  h.audio.onChunk('AAAA'); // audio engine emits before the setup handshake ends
  assert.equal(ws.sent.length, 1); // only setup — nothing else went out
  await h.completeSetup(ws);
  h.audio.onChunk('AAAA');
  assert.deepEqual(h.lastSent(ws), { realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } });
});

test('echo guard: no mic upload while Gemini plays or within 400 ms after (stops the self-interrupt loop)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const micSent = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).length;
  h.audio.playing = true;
  h.clock.ms = 1000;
  h.audio.onChunk('ECHO');
  assert.equal(micSent(), 0); // Gemini's own voice from the speaker never goes back up
  h.audio.playing = false;
  h.clock.ms = 1300;
  h.audio.onChunk('TAIL');
  assert.equal(micSent(), 0); // room/speaker tail
  h.clock.ms = 1401;
  h.audio.onChunk('OWNER');
  assert.equal(micSent(), 1);
  assert.deepEqual(h.lastSent(ws), { realtimeInput: { audio: { data: 'OWNER', mimeType: 'audio/pcm;rate=16000' } } });
});

// --- server content --------------------------------------------------------------

test('ALL modelTurn parts are played (ArrayBuffer frames decode too)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message(
    { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }, { text: 'not audio' }, { inlineData: { data: 'BBBB' } }] } } },
    'ab',
  );
  await tick();
  assert.deepEqual(h.audio.plays, ['AAAA', 'BBBB']); // every inlineData part, in order
  assert.equal(h.lastState(), 'speaking');
  assert.equal(h.call.isModelBusy(), true);
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  await h.timers.runNext(); // drain check (playback already idle)
  assert.equal(h.lastState(), 'listening');
  assert.equal(h.call.isModelBusy(), false);
});

test('interrupted (barge-in) flushes playback and returns to listening', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true;
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  assert.equal(h.lastState(), 'speaking');
  ws.message({ serverContent: { interrupted: true } });
  await tick();
  assert.equal(h.audio.flushes, 1);
  assert.equal(h.audio.playing, false);
  assert.equal(h.lastState(), 'listening');
  assert.ok(h.events.some(([name, n]) => name === 'interrupted' && n === 1)); // beacon for diagnosis
  assert.equal(h.call.isModelBusy(), false);
});

// --- tools -----------------------------------------------------------------------

test('tool round trip: result / thrown error / unknown tool / WHEN_IDLE for send_to_claude', async () => {
  const tools = {
    get_claude_status: async () => ({ busy: false, headline: 'idle' }),
    send_to_claude: async (args) => {
      if (!args.when) throw new Error('ask_owner');
      return { queued: args.when === 'after' };
    },
  };
  const h = harness({ tools });
  const ws = await h.openSocket();
  await h.completeSetup(ws);

  ws.message({ toolCall: { functionCalls: [{ id: 't1', name: 'get_claude_status', args: {} }, { id: 't2', name: 'nope', args: {} }] } });
  await tick();
  assert.deepEqual(h.lastSent(ws), {
    toolResponse: {
      functionResponses: [
        { id: 't1', name: 'get_claude_status', response: { result: { busy: false, headline: 'idle' } } },
        { id: 't2', name: 'nope', response: { error: 'unknown_tool', hint: 'app_outdated_refresh' } },
      ],
    },
  });
  assert.ok(h.events.some(([name, n]) => name === 'tool-call' && n === 2));

  // send_to_claude without `when` -> ask_owner error, still scheduled WHEN_IDLE
  ws.message({ toolCall: { functionCalls: [{ id: 't3', name: 'send_to_claude', args: { instruction: 'run tests' } }] } });
  await tick();
  assert.deepEqual(h.lastSent(ws), {
    toolResponse: { functionResponses: [{ id: 't3', name: 'send_to_claude', response: { error: 'ask_owner', scheduling: 'WHEN_IDLE' } }] },
  });

  // with `when` -> result + WHEN_IDLE
  ws.message({ toolCall: { functionCalls: [{ id: 't4', name: 'send_to_claude', args: { instruction: 'run tests', when: 'after' } }] } });
  await tick();
  assert.deepEqual(h.lastSent(ws), {
    toolResponse: { functionResponses: [{ id: 't4', name: 'send_to_claude', response: { result: { queued: true }, scheduling: 'WHEN_IDLE' } }] },
  });
});

test('extended-thinking model: send_to_claude response carries NO scheduling (the model rejects it)', async () => {
  const h = harness({ tools: { send_to_claude: async () => ({ queued: true }) }, model: 'gemini-3.8-live-extended-thinking' });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ toolCall: { functionCalls: [{ id: 'x1', name: 'send_to_claude', args: { instruction: 'run tests', when: 'after' } }] } });
  await tick();
  assert.deepEqual(h.lastSent(ws), {
    toolResponse: { functionResponses: [{ id: 'x1', name: 'send_to_claude', response: { result: { queued: true } } }] },
  });
});

test('toolCallCancellation drops the pending responses for those ids', async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ tools: { get_claude_status: () => slow } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_claude_status', args: {} }] } });
  await tick();
  ws.message({ toolCallCancellation: { ids: ['c1'] } });
  release({ busy: true });
  await tick();
  await tick();
  assert.ok(!ws.sent.some((m) => m.toolResponse)); // cancelled id never answers
});

// --- resumption / reconnect ------------------------------------------------------

test('goAway: fresh token + reconnect WITH the stored handle; mic keeps running', async () => {
  let tokenCounter = 0;
  FakeWebSocket.instances.length = 0;
  const fetches = [];
  const fetch = async (url, init) => {
    tokenCounter += 1;
    fetches.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ token: `tok-${tokenCounter}`, model: 'gemini-3.8-live', wsUrl: 'wss://live.example/ws', expiresAt: 1 }) };
  };
  const timers = fakeTimers();
  const audio = fakeAudioFactory();
  const states = [];
  const events = [];
  const call = createLiveCall({
    onState: (s) => states.push(s),
    onEvent: (name, n) => events.push([name, n]),
    deps: { fetch, WebSocket: FakeWebSocket, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => 0, audio: audio.factory },
  });
  call.start().catch(() => {});
  await tick();
  const first = FakeWebSocket.instances[0];
  first.open();
  await tick();
  first.message({ setupComplete: {} });
  await tick();
  assert.equal(audio.api.startCalls, 1);

  first.message({ sessionResumptionUpdate: { newHandle: 'h-ignored', resumable: false } }); // non-resumable: not stored
  first.message({ sessionResumptionUpdate: { newHandle: 'h9', resumable: true } });
  await tick();
  first.message({ goAway: { timeLeft: '2s' } });
  await tick();
  assert.equal(fetches.length, 2); // fresh token
  assert.ok(events.some(([name, n]) => name === 'reconnect' && n === 1));
  assert.equal(states.includes('reconnecting'), true);
  assert.equal(first.closeCalls, 1); // client closed the old socket itself
  const second = FakeWebSocket.instances[1];
  second.open();
  await tick();
  assert.deepEqual(second.sent[0], { setup: { model: 'models/gemini-3.8-live', sessionResumption: { handle: 'h9' } } });
  second.message({ setupComplete: {} });
  await tick();
  assert.equal(audio.api.startCalls, 1); // mic never restarted
  assert.equal(audio.api.closeCalls, 0);
  assert.equal(states[states.length - 1], 'listening');
});

test('unexpected close: backoff 0.5/1/2/4/4 s, max 5 attempts, then unavailable', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.drop();
  assert.equal(h.lastState(), 'reconnecting');
  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    assert.equal(h.timers.pending.length, 1);
    delays.push(h.timers.pending[0].ms);
    await h.timers.runNext(); // fires reconnectNow -> token -> new socket
    await tick();
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    socket.drop(); // attempt fails again (never opened)
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 4000]);
  assert.equal(h.lastState(), 'unavailable');
  assert.ok(h.events.some(([name, n]) => name === 'live-error' && n === 6));
  assert.equal(h.timers.pending.length, 0); // no further retries scheduled
  assert.equal(h.audio.closeCalls, 0); // mic keeps running across reconnect attempts
});

// --- owner 2026-10-08: Google 1011 drops, setup timeout, give-up + retry ------------

const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

async function reconnectAfterDrop(h) {
  await h.timers.runNext(); // backoff -> token -> new socket
  return h.openSocket();
}

test('1011 drop: close code reported, reconnect is FRESH (no handle) and the last briefing is re-sent', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('[SESSION CONTEXT] brief');
  ws.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await tick();
  ws.readyState = 3;
  ws.onclose({ code: 1011, reason: 'Internal error encountered.' });
  assert.ok(h.events.some(([name, n]) => name === 'live-drop' && n === 1011));
  assert.equal(h.lastState(), 'reconnecting');
  const next = await reconnectAfterDrop(h);
  assert.deepEqual(next.sent[0], { setup: { model: 'models/gemini-3.8-live', sessionResumption: {} } });
  await h.completeSetup(next);
  assert.deepEqual(next.sent[1], { clientContent: { turns: [{ role: 'user', parts: [{ text: '[SESSION CONTEXT] brief' }] }], turnComplete: false } });
  assert.equal(h.lastState(), 'listening');
});

test('a single non-1011 drop resumes WITH the handle (no briefing re-sent); the second drop in a row goes fresh', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('brief');
  ws.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await tick();
  ws.drop(); // 1006
  const resumed = await reconnectAfterDrop(h);
  assert.deepEqual(resumed.sent[0].setup.sessionResumption, { handle: 'h1' });
  await h.completeSetup(resumed);
  assert.equal(resumed.sent.length, 1); // the resumed session still remembers the briefing
  resumed.message({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  await tick();
  h.clock.ms += 5000;
  resumed.drop();
  const fresh = await reconnectAfterDrop(h);
  assert.deepEqual(fresh.sent[0].setup.sessionResumption, {});
});

test('3 live sessions dying within 60 s -> unavailable, no further retries; retry() starts a fresh session', async () => {
  const h = harness();
  let ws = await h.openSocket();
  await h.completeSetup(ws);
  for (let i = 0; i < 2; i += 1) {
    h.clock.ms += 5000;
    ws.drop();
    ws = await reconnectAfterDrop(h);
    await h.completeSetup(ws); // live-open resets attempts — the old infinite loop
  }
  h.clock.ms += 5000;
  ws.drop();
  assert.equal(h.lastState(), 'unavailable');
  assert.ok(h.events.some(([name, n]) => name === 'live-error' && n === 3));
  assert.equal(h.timers.pending.length, 0);
  assert.equal(h.audio.closeCalls, 0); // the mic stays up for a retry
  const before = FakeWebSocket.instances.length;
  assert.equal(h.call.retry(), true);
  assert.equal(h.lastState(), 'connecting');
  assert.ok(h.events.some(([name]) => name === 'live-retry'));
  const again = await h.openSocket();
  assert.equal(FakeWebSocket.instances.length, before + 1);
  assert.deepEqual(again.sent[0].setup.sessionResumption, {});
  await h.completeSetup(again);
  assert.equal(h.lastState(), 'listening');
});

test('drops spread beyond 60 s never give up', async () => {
  const h = harness();
  let ws = await h.openSocket();
  await h.completeSetup(ws);
  for (let i = 0; i < 4; i += 1) {
    h.clock.ms += 61000;
    ws.drop();
    assert.equal(h.lastState(), 'reconnecting');
    ws = await reconnectAfterDrop(h);
    await h.completeSetup(ws);
  }
  assert.equal(h.lastState(), 'listening');
});

test('retry() is a no-op unless the call is unavailable', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  assert.equal(h.call.retry(), false);
  h.call.stop();
  assert.equal(h.call.retry(), false);
});

test('setup timeout: an open socket with no setupComplete after 10 s is closed and retried', async () => {
  const h = harness();
  const ws = await h.openSocket();
  assert.equal(h.timers.pending.length, 1);
  assert.equal(h.timers.pending[0].ms, 10000);
  await h.timers.runNext(); // setup timeout fires
  assert.equal(ws.closeCalls, 1);
  assert.ok(h.events.some(([name, n]) => name === 'live-drop' && n === 4408));
  assert.equal(h.lastState(), 'reconnecting');
  assert.equal(h.timers.pending.length, 1); // exactly one backoff — the old socket's close did not count twice
  assert.equal(h.timers.pending[0].ms, 500);
  const next = await reconnectAfterDrop(h);
  await h.completeSetup(next);
  assert.equal(h.lastState(), 'listening');
  await h.promise; // start() resolves on the retried session
  assert.equal(h.timers.pending.length, 0); // setup timer cleared at setupComplete
});

test('a hung token POST times out after 10 s and is retried — never stuck in reconnecting', async () => {
  FakeWebSocket.instances.length = 0;
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {}); // never resolves
    return { ok: true, status: 200, json: async () => ({ token: 't', model: 'gemini-3.8-live', wsUrl: 'wss://live.example/ws', expiresAt: 1 }) };
  };
  const timers = fakeTimers();
  const states = [];
  const call = createLiveCall({
    onState: (s) => states.push(s),
    deps: { fetch, WebSocket: FakeWebSocket, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => 0, audio: fakeAudioFactory().factory },
  });
  call.start().catch(() => {});
  await tick();
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, 10000);
  await timers.runNext(); // token timeout fires
  await tick();
  assert.equal(states[states.length - 1], 'reconnecting');
  await timers.runNext(); // backoff -> second token -> socket
  await tick();
  assert.equal(calls, 2);
  assert.equal(FakeWebSocket.instances.length, 1);
  call.stop();
});

test('stop() clears the resumption handle: a restarted instance sets up fresh', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ sessionResumptionUpdate: { newHandle: 'old', resumable: true } });
  await tick();
  h.call.stop();
  h.call.start().catch(() => {});
  const next = await h.openSocket();
  assert.deepEqual(next.sent[0].setup.sessionResumption, {});
  h.call.stop();
});

// --- pushText ----------------------------------------------------------------------

test('pushText: immediate when idle, queued while speaking until turnComplete + playback drained', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushText('idle text');
  await tick();
  assert.deepEqual(h.lastSent(ws), { clientContent: { turns: [{ role: 'user', parts: [{ text: 'idle text' }] }], turnComplete: true } });

  h.audio.playing = true; // model is speaking, audio queue busy
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  h.call.pushText('queued text');
  assert.ok(!ws.sent.some((m) => m.clientContent && m.clientContent.turns[0].parts[0].text === 'queued text'));

  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  assert.equal(h.timers.pending.length, 1); // drain check scheduled
  await h.timers.runNext(); // playback still active -> re-arms
  assert.equal(h.timers.pending.length, 1);
  h.audio.playing = false; // playback drained
  await h.timers.runNext(); // owner 2026-10-07: 3 s quiet after Gemini stops speaking
  assert.ok(!ws.sent.some((m) => m.clientContent && m.clientContent.turns[0].parts[0].text === 'queued text'));
  h.clock.ms += 3000;
  await h.timers.runNext();
  assert.deepEqual(h.lastSent(ws), { clientContent: { turns: [{ role: 'user', parts: [{ text: 'queued text' }] }], turnComplete: true } });
  assert.equal(h.lastState(), 'listening');
});

test('owner 2026-10-07: updates wait for 3 s of owner silence, go out as ONE turn in order, and never stack turns', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const updates = () => ws.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === true);
  h.clock.ms = 10000;
  ws.message({ serverContent: { inputTranscription: { text: 'أنا بتكلم' } } }); // the owner is talking
  await tick();
  h.call.pushText('[CLAUDE UPDATE] one');
  h.call.pushText('[CLAUDE UPDATE] two');
  await tick();
  assert.equal(updates().length, 0);
  h.clock.ms = 12999;
  await h.timers.runNext();
  assert.equal(updates().length, 0); // still inside the owner's quiet window
  h.clock.ms = 13000;
  await h.timers.runNext();
  assert.deepEqual(updates().map((m) => m.clientContent.turns[0].parts[0].text), ['[CLAUDE UPDATE] one\n\n[CLAUDE UPDATE] two']);
  h.call.pushText('[CLAUDE UPDATE] three'); // the model has not answered the first turn yet
  await tick();
  await h.timers.runNext();
  assert.equal(updates().length, 1); // a second turn now would interrupt the reply (stutter)
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  await h.timers.runNext();
  assert.equal(updates().length, 2);
});

test('interactionStatus (extended thinking): IN_PROGRESS holds pushText past turnComplete; IDLE releases it', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ interactionStatus: 'IN_PROGRESS', serverContent: { turnComplete: true } });
  await tick();
  assert.equal(h.call.isModelBusy(), true); // turnComplete alone no longer means idle
  h.call.pushText('[CLAUDE UPDATE] tests passed');
  await tick();
  while (h.timers.pending.length) await h.timers.runNext(); // background reasoning: no re-arm loop
  assert.ok(!ws.sent.some((m) => m.clientContent && m.clientContent.turns[0].parts[0].text === '[CLAUDE UPDATE] tests passed'));

  ws.message({ interactionStatus: 'IDLE' });
  await tick();
  assert.equal(h.call.isModelBusy(), false);
  while (h.timers.pending.length) await h.timers.runNext();
  assert.deepEqual(h.lastSent(ws), {
    clientContent: { turns: [{ role: 'user', parts: [{ text: '[CLAUDE UPDATE] tests passed' }] }], turnComplete: true },
  });
});

test('onTranscript: owner/gemini speech, tool call + result, context and updates are all recorded', async () => {
  const notes = [];
  const h = harness({ tools: { get_claude_status: async () => ({ busy: false }) }, onTranscript: (role, text) => notes.push([role, text]) });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('[SESSION CONTEXT] x');
  ws.message({ serverContent: { inputTranscription: { text: ' Claude بيعمل إيه' } } });
  ws.message({ toolCall: { functionCalls: [{ id: 'a', name: 'get_claude_status', args: {} }] } });
  await tick();
  ws.message({ serverContent: { outputTranscription: { text: 'فاضي دلوقتي.' }, modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  ws.message({ serverContent: { interrupted: true } });
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  h.call.pushText('[CLAUDE UPDATE] done');
  h.clock.ms += 3000; // owner 2026-10-07: updates wait for 3 s of owner silence
  while (h.timers.pending.length) await h.timers.runNext(); // drain (+ a no-op turn nudge)
  assert.deepEqual(notes, [
    ['context', '[SESSION CONTEXT] x'],
    ['owner', ' Claude بيعمل إيه'],
    ['tool-call', 'get_claude_status {}'],
    ['tool-result', 'get_claude_status {"result":{"busy":false}}'],
    ['gemini', 'فاضي دلوقتي.'],
    ['event', 'interrupted'],
    ['update', '[CLAUDE UPDATE] done'],
  ]);
});

test('onTranscript throwing never breaks the frame feed', async () => {
  const h = harness({ onTranscript: () => { throw new Error('boom'); } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { outputTranscription: { text: 'x' }, modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  assert.equal(h.lastState(), 'speaking');
});

// --- pushContext (WO-VL-CTX) --------------------------------------------------------

test('pushContext: sent immediately with turnComplete:false once setup is complete', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('[SESSION CONTEXT] user asked about the deploy');
  await tick();
  assert.deepEqual(h.lastSent(ws), {
    clientContent: { turns: [{ role: 'user', parts: [{ text: '[SESSION CONTEXT] user asked about the deploy' }] }], turnComplete: false },
  });
});

test('pushContext: NOT delayed by a speaking model turn (never rides the textQueue)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true; // model mid-turn
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  h.call.pushContext('[SESSION CONTEXT] briefing');
  await tick();
  assert.deepEqual(h.lastSent(ws), {
    clientContent: { turns: [{ role: 'user', parts: [{ text: '[SESSION CONTEXT] briefing' }] }], turnComplete: false },
  });
  // and it never reappears later as a spoken (turnComplete:true) turn
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  await h.timers.runNext();
  h.audio.playing = false;
  await h.timers.runNext();
  assert.ok(!ws.sent.some((m) => m.clientContent && m.clientContent.turnComplete === true && String(m.clientContent.turns[0].parts[0].text).includes('[SESSION CONTEXT]')));
});

test('pushContext before setupComplete is queued and flushed (turnComplete:false) at setupComplete, before any queued pushText', async () => {
  const h = harness();
  const ws = await h.openSocket(); // socket open, setup NOT complete
  h.call.pushText('queued spoken text');
  h.call.pushContext('[SESSION CONTEXT] seed');
  assert.ok(!ws.sent.some((m) => m.clientContent));
  await h.completeSetup(ws);
  await tick();
  const clientFrames = ws.sent.filter((m) => m.clientContent);
  assert.equal(clientFrames.length, 1); // only the context so far — drain pending
  assert.deepEqual(clientFrames[0], {
    clientContent: { turns: [{ role: 'user', parts: [{ text: '[SESSION CONTEXT] seed' }] }], turnComplete: false },
  });
  await h.timers.runNext(); // drain flushes the spoken text AFTER the context
  assert.deepEqual(h.lastSent(ws), { clientContent: { turns: [{ role: 'user', parts: [{ text: 'queued spoken text' }] }], turnComplete: true } });
});

// --- mute / stop -------------------------------------------------------------------

test('mute: silence of equal length for 2.5 s, ONE audioStreamEnd, nothing after, real audio on unmute (owner 2026-10-07)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.mute(true);
  assert.equal(h.call.isMuted(), true);
  assert.deepEqual(h.audio.mutedTo, [true]);
  assert.ok(h.events.some(([name, n]) => name === 'mute' && n === 1)); // R3 beacon
  const micData = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => m.realtimeInput.audio.data);
  const ends = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd === true).length;
  const noise = pcm(9000); // loud room noise — must go up as silence of the same length
  h.audio.onChunk(noise);
  h.audio.onChunk('CCCC');
  const sent = micData();
  assert.equal(sent.length, 2); // cadence kept
  assert.equal(sent[0].length, noise.length); // same encoded length -> same decoded length
  assert.ok(Buffer.from(sent[0], 'base64').every((b) => b === 0)); // all-zero PCM
  assert.equal(sent[1], 'AAAA'); // 'CCCC' (3 bytes) -> 3 zero bytes
  assert.equal(ends(), 0); // no audioStreamEnd yet — the silence tail is still running
  h.call.mute(true); // idempotent: the tail is NOT restarted
  h.clock.ms += 2500;
  await h.timers.runNext(); // the mute tail fires
  assert.equal(ends(), 1); // exactly one audioStreamEnd
  h.audio.onChunk('DDDD'); // after the tail: nothing at all goes up
  assert.equal(micData().length, 2);
  await h.timers.runNext(); // nothing else armed
  assert.equal(ends(), 1);
  h.call.mute(false);
  assert.deepEqual(h.audio.mutedTo, [true, true, false]);
  assert.ok(h.events.some(([name, n]) => name === 'unmute' && n === 1)); // R3 beacon
  h.audio.onChunk('CCCC');
  assert.deepEqual(h.lastSent(ws), { realtimeInput: { audio: { data: 'CCCC', mimeType: 'audio/pcm;rate=16000' } } });
  assert.equal(h.call.isMuted(), false);
});

test('mute/unmute are journaled as transcript events', async () => {
  const notes = [];
  const h = harness({ onTranscript: (role, text) => notes.push([role, text]) });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.mute(true);
  h.call.mute(true); // repeated: journalled once
  h.call.mute(false);
  assert.deepEqual(notes.filter(([role]) => role === 'event'), [
    ['event', 'mute'],
    ['event', 'unmute'],
  ]);
});

test('stop: closes ws + audio, state ended, live-close fired, no reconnect afterwards', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.stop();
  assert.equal(ws.closeCalls, 1);
  assert.equal(h.audio.closeCalls, 1);
  assert.equal(h.lastState(), 'ended');
  assert.ok(h.events.some(([name]) => name === 'live-close'));
  ws.drop(); // late close event must not resurrect the call
  await tick();
  assert.equal(h.lastState(), 'ended');
  assert.equal(h.timers.pending.length, 0);
});

// --- F1: pre-setup close must not fail the call -----------------------------------

test('F1: a pre-setup close schedules a reconnect and start() still resolves', async () => {
  const h = harness();
  const ws = await h.openSocket();
  ws.drop(); // server dropped before setupComplete
  assert.equal(h.lastState(), 'reconnecting'); // not 'error'
  await h.timers.runNext(); // backoff fires -> fresh token -> new socket
  await tick();
  const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  assert.notEqual(second, ws);
  second.open();
  await tick();
  await h.completeSetup(second);
  await h.promise; // resolves — the pre-setup close did NOT reject start()
  assert.equal(h.lastState(), 'listening');
});

test('F1+F7: stop during connecting rejects the start promise cleanly; a restart on the instance works', async () => {
  const h = harness();
  await h.openSocket(); // ws open, setup NOT complete
  h.call.stop();
  assert.equal(h.lastState(), 'ended');
  await assert.rejects(h.promise, /stopped before setupComplete/);
  assert.equal(h.timers.pending.length, 0); // no reconnect armed after stop
  // F7: stop() reset the engine — a fresh start() behaves like a new call
  const second = h.call.start();
  second.catch(() => {});
  assert.equal(h.audio.startCalls, 2); // mic restarts with the new session
  const ws2 = await h.openSocket();
  await h.completeSetup(ws2);
  await second; // resolves
  assert.equal(h.lastState(), 'listening');
});

// --- F6: no audioStreamEnd before setupComplete ------------------------------------

test('F6: mute before setupComplete sends no audio frame and no audioStreamEnd; the silence tail starts at setupComplete', async () => {
  const h = harness();
  const ws = await h.openSocket(); // socket open, setup NOT complete
  h.call.mute(true);
  h.audio.onChunk(pcm(9000));
  assert.ok(!ws.sent.some((m) => m.realtimeInput)); // nothing before setupComplete — F6 kept
  await h.completeSetup(ws); // muted at setup: the tail arms now
  h.audio.onChunk(pcm(9000));
  const sent = ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio);
  assert.equal(sent.length, 1); // silence streams once setup is done
  assert.ok(Buffer.from(sent[0].realtimeInput.audio.data, 'base64').every((b) => b === 0));
  h.clock.ms += 2500;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd).length, 1); // exactly one end
  h.call.mute(false);
  h.call.mute(true); // a fresh mute ends the stream again — exactly once more
  h.clock.ms += 2500;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd).length, 2);
});

// --- F8: owner speech signal --------------------------------------------------------

test('F8: non-empty inputTranscription fires onUserSpeech with trimmed text', async () => {
  const heard = [];
  const raws = [];
  const h = harness({ onUserSpeech: (text, raw) => (heard.push(text), raws.push(raw)) });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { inputTranscription: { text: '  stop everything  ' } } });
  ws.message({ serverContent: { inputTranscription: { text: '' } } }); // empty: ignored
  ws.message({ serverContent: { inputTranscription: { text: '   ' } } }); // blank: ignored
  ws.message({ serverContent: { inputTranscription: {} } }); // no text field: ignored
  await tick();
  assert.deepEqual(heard, ['stop everything']);
  assert.deepEqual(raws, ['  stop everything  ']); // raw fragment keeps its spacing for the relay
});

function pcm(amplitude, samples = 1280) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return buf.toString('base64');
}

// --- onTurnComplete (WO-VP-LIVE R6) --------------------------------------------------

test('onTurnComplete: spoke=true only when model audio arrived in that turn; fires on EVERY turnComplete', async () => {
  const turns = [];
  const h = harness({ onTurnComplete: (info) => turns.push({ ...info }) });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { turnComplete: true } }); // empty turn
  await tick();
  ws.message({ serverContent: { modelTurn: { parts: [{ text: 'text only' }] } } }); // no audio part
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }, { text: 'and text' }] } } });
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  assert.deepEqual(turns, [{ spoke: false }, { spoke: false }, { spoke: true }]);
});

test('onTurnComplete throwing never breaks the call', async () => {
  const h = harness({ onTurnComplete: () => { throw new Error('boom'); } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  await h.timers.runNext(); // drain -> listening despite the throwing listener
  assert.equal(h.lastState(), 'listening');
});

test('owner 2026-10-07: barge-in — a voice louder than the echo stops Gemini, sends the held words, drops the rest of the reply', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const mic = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => m.realtimeInput.audio.data);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  h.audio.playing = true;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800)); // speaker echo (~0.024): learned, never sent
  assert.equal(mic().length, 0);
  assert.equal(h.audio.flushes, 0);
  h.clock.ms = 2000; // past the R7 barge grace (the reply started at t=0)
  const loud = [pcm(9000), pcm(9100), pcm(9200)]; // the owner talks over Gemini (retune 2: 3 of 5)
  h.audio.onChunk(loud[0]);
  h.audio.onChunk(loud[1]);
  assert.equal(h.audio.flushes, 0); // two loud chunks are not enough
  h.audio.onChunk(loud[2]);
  assert.equal(h.audio.flushes, 1);
  assert.deepEqual(mic(), loud); // the owner's first words reach the server
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'LATE' } }] } } });
  await tick();
  assert.ok(!h.audio.plays.includes('LATE')); // the cut reply never resumes
  h.audio.onChunk(pcm(9000));
  assert.equal(mic().length, 4); // mic stays open while the owner talks
  ws.message({ serverContent: { interrupted: true } });
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'NEXT' } }] } } });
  await tick();
  assert.ok(h.audio.plays.includes('NEXT')); // the next reply plays again
});

test('barge-in never fires on steady speaker echo, even loud echo', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true;
  for (let i = 0; i < 40; i += 1) h.audio.onChunk(pcm(6000)); // loud but steady echo (~0.18)
  assert.equal(h.audio.flushes, 0);
  assert.equal(ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).length, 0);
});

test('owner 2026-10-07: the owner spoke and nothing answers for 2.5 s -> the turn is ended explicitly (once)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const ends = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd === true).length;
  const before = ends();
  ws.message({ serverContent: { inputTranscription: { text: 'انت سامعني؟' } } });
  await tick();
  h.clock.ms += 2500;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(ends(), before + 1);
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(ends(), before + 1); // once per owner turn
});

test('no turn nudge when the model answers in time', async () => {
  const h = harness({ tools: { get_claude_status: async () => ({ busy: false }) } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const before = ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd).length;
  ws.message({ serverContent: { inputTranscription: { text: 'كلود بيعمل ايه' } } });
  ws.message({ toolCall: { functionCalls: [{ id: 'a', name: 'get_claude_status', args: {} }] } });
  await tick();
  h.clock.ms += 5000;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd).length, before);
});

test('a barge-in after the server already finished the reply never mutes the NEXT reply', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  ws.message({ serverContent: { turnComplete: true } }); // server done; playback still running locally
  await tick();
  h.audio.playing = true;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800));
  for (let i = 0; i < 4; i += 1) h.audio.onChunk(pcm(9000)); // the owner talks over the tail (retune: 4 chunks)
  assert.equal(h.audio.flushes, 1);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'NEXT' } }] } } });
  await tick();
  assert.ok(h.audio.plays.includes('NEXT'));
});

// Owner 2026-10-07 (calls 165538/165622/165631): after a tool result the model
// sometimes never speaks — one text nudge per owner turn rescues the reply.
test('reply rescue: silence after a tool result gets ONE nudge; a spoken reply cancels it', async () => {
  const rescues = (ws) => ws.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === true && /owner is waiting/.test(m.clientContent.turns[0].parts[0].text));
  const h = harness({ tools: { get_claude_status: async () => ({ busy: false }) } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { inputTranscription: { text: 'الـCEO بيعمل إيه؟' } } });
  ws.message({ toolCall: { functionCalls: [{ id: 'r1', name: 'get_claude_status', args: {} }] } });
  await tick();
  await tick();
  h.clock.ms += 6000;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(rescues(ws).length, 1);
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(rescues(ws).length, 1, 'never more than one nudge per owner turn');

  const h2 = harness({ tools: { get_claude_status: async () => ({ busy: false }) } });
  const ws2 = await h2.openSocket();
  await h2.completeSetup(ws2);
  ws2.message({ serverContent: { inputTranscription: { text: 'سؤال' } } });
  ws2.message({ toolCall: { functionCalls: [{ id: 'r2', name: 'get_claude_status', args: {} }] } });
  await tick();
  await tick();
  ws2.message({ serverContent: { modelTurn: { parts: [{ text: 'فاضي' }] } } });
  await tick();
  h2.clock.ms += 6000;
  while (h2.timers.pending.length) await h2.timers.runNext();
  assert.equal(rescues(ws2).length, 0);
});

// Owner 2026-10-08 (call 20261008-200644): connected but silent — owner
// transcribed, nudge + rescue unanswered.
async function silentSessionScenario(h, ws) {
  ws.message({ serverContent: { inputTranscription: { text: 'انت سامعني؟' } } });
  await tick();
  await h.timers.runNext(); // turn nudge (2.5 s) -> arms the rescue
  await h.timers.runNext(); // reply rescue (5 s) -> arms the silent watchdog
  assert.equal(h.timers.pending.length, 1);
  assert.equal(h.timers.pending[0].ms, 6000);
}

test('silent session: 6 s after the rescue with no model output -> fresh reconnect, briefing + owner words re-sent', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('[SESSION CONTEXT] brief');
  ws.message({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await silentSessionScenario(h, ws);
  await h.timers.runNext(); // watchdog fires
  assert.equal(ws.closeCalls, 1);
  assert.ok(h.events.some(([name, n]) => name === 'live-drop' && n === 4410));
  assert.equal(h.events.filter(([name]) => name === 'live-drop').length, 1); // the closed socket did not count twice
  assert.equal(h.lastState(), 'reconnecting');
  const next = await reconnectAfterDrop(h);
  assert.deepEqual(next.sent[0].setup.sessionResumption, {}); // never resume the silent context
  await h.completeSetup(next);
  assert.equal(next.sent[1].clientContent.turnComplete, false);
  assert.equal(next.sent[1].clientContent.turns[0].parts[0].text, '[SESSION CONTEXT] brief');
  const words = next.sent[2].clientContent;
  assert.equal(words.turnComplete, true);
  assert.match(words.turns[0].parts[0].text, /The owner just said: "انت سامعني؟" — answer them now\./);
  assert.equal(next.sent.length, 3); // the words are sent once
});

test('silent session watchdog: any model output after the rescue (speech, transcription or a tool call) cancels it', async () => {
  for (const answer of [
    { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } },
    { serverContent: { outputTranscription: { text: 'أيوه' } } },
    { toolCall: { functionCalls: [{ id: 't1', name: 'get_claude_status', args: {} }] } },
  ]) {
    const h = harness({ tools: { get_claude_status: async () => ({ busy: false }) } });
    const ws = await h.openSocket();
    await h.completeSetup(ws);
    await silentSessionScenario(h, ws);
    ws.message(answer);
    await tick();
    assert.ok(!h.timers.pending.some((t) => t.ms === 6000), 'watchdog still armed');
    while (h.timers.pending.length) await h.timers.runNext();
    assert.equal(ws.closeCalls, 0);
    assert.ok(!h.events.some(([name]) => name === 'live-drop'));
    h.call.stop();
  }
});

test('silent sessions back to back: each replacement carries the words and is watched; the third goes unavailable', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  await silentSessionScenario(h, ws);
  await h.timers.runNext(); // silent #1
  for (let n = 2; n <= 3; n += 1) {
    const next = await reconnectAfterDrop(h);
    await h.completeSetup(next);
    const words = next.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === true);
    assert.equal(words.length, 1);
    assert.match(words[0].clientContent.turns[0].parts[0].text, /"انت سامعني؟"/); // carried on
    assert.ok(h.timers.pending.some((t) => t.ms === 6000), `replacement ${n} is not watched`);
    h.clock.ms += 7000;
    await h.timers.runNext(); // silent #n
  }
  assert.deepEqual(h.events.filter(([name]) => name === 'live-drop').map(([, n]) => n), [4410, 4410, 4410]);
  assert.equal(h.lastState(), 'unavailable');
  assert.equal(h.timers.pending.length, 0);
  assert.equal(h.call.retry(), true);
  const fresh = await h.openSocket();
  await h.completeSetup(fresh);
  assert.ok(!fresh.sent.some((m) => m.clientContent && m.clientContent.turnComplete === true), 'retry must not replay old words');
});

test('owner words are sent without double quotes (framing stays intact)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { inputTranscription: { text: 'قول "أهلا"' } } });
  await tick();
  await h.timers.runNext();
  await h.timers.runNext();
  await h.timers.runNext(); // silent
  const next = await reconnectAfterDrop(h);
  await h.completeSetup(next);
  const text = next.sent.find((m) => m.clientContent && m.clientContent.turnComplete === true).clientContent.turns[0].parts[0].text;
  assert.match(text, /said: "قول أهلا" — answer/);
});

test('silent session watchdog: stop() during it leaves no timer and no reconnect', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  await silentSessionScenario(h, ws);
  h.call.stop();
  assert.equal(h.timers.pending.length, 0);
  assert.ok(!h.events.some(([name]) => name === 'live-drop'));
});

test('reply rescue: an interrupt (owner barges in) cancels the armed nudge; audio still playing blocks it', async () => {
  const rescues = (ws) => ws.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === true && /owner is waiting/.test(m.clientContent.turns[0].parts[0].text));
  const h = harness({ tools: { get_claude_status: async () => ({ busy: false }) } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { inputTranscription: { text: 'سؤال' } } });
  ws.message({ toolCall: { functionCalls: [{ id: 'i1', name: 'get_claude_status', args: {} }] } });
  await tick();
  await tick();
  ws.message({ serverContent: { interrupted: true } });
  await tick();
  h.clock.ms += 6000;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(rescues(ws).length, 0, 'no "answer now" nudge after an interrupt');

  const h2 = harness({ tools: { get_claude_status: async () => ({ busy: false }) } });
  const ws2 = await h2.openSocket();
  await h2.completeSetup(ws2);
  ws2.message({ serverContent: { inputTranscription: { text: 'سؤال' } } });
  ws2.message({ toolCall: { functionCalls: [{ id: 'i2', name: 'get_claude_status', args: {} }] } });
  await tick();
  await tick();
  h2.audio.playing = true; // a reply tail is still playing locally
  h2.clock.ms += 6000;
  while (h2.timers.pending.length) await h2.timers.runNext();
  assert.equal(rescues(ws2).length, 0, 'never nudge over a reply that is still playing');
});

// --- WO-VP-LIVE: mute fix + barge retune (owner 2026-10-07) --------------------------

test('mute after speaking: all-zero PCM up, ONE audioStreamEnd after 2.5 s, then the reply rescue answers (owner bug 2026-10-07)', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const rescues = (w) => w.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === true && /owner is waiting/.test(m.clientContent.turns[0].parts[0].text));
  const ends = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd === true).length;
  const micData = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => m.realtimeInput.audio.data);
  ws.message({ serverContent: { inputTranscription: { text: 'انت سامعني؟' } } }); // the owner speaks...
  await tick();
  h.call.mute(true); // ...then mutes the room noise
  h.audio.onChunk(pcm(9000)); // loud room noise
  h.audio.onChunk(pcm(9000));
  assert.equal(micData().length, 2); // cadence kept, but
  assert.ok(micData().every((d) => Buffer.from(d, 'base64').every((b) => b === 0))); // all-zero PCM only — never the room
  h.clock.ms += 2500;
  while (h.timers.pending.length) await h.timers.runNext(); // mute tail ends the stream; the armed rescue fires
  assert.equal(ends(), 1); // exactly one audioStreamEnd (the pending turn-nudge was absorbed by the mute tail)
  assert.equal(rescues(ws).length, 1); // Jimmy still answers despite the mute
  assert.ok(micData().every((d) => Buffer.from(d, 'base64').every((b) => b === 0))); // still never the room
});

test('muted: no barge-in and no room audio while Gemini speaks — silence only', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  h.audio.playing = true;
  h.call.mute(true);
  for (let i = 0; i < 8; i += 1) h.audio.onChunk(pcm(9000)); // loud room noise over Gemini's voice
  const sent = ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => m.realtimeInput.audio.data);
  assert.equal(sent.length, 8); // cadence kept
  assert.ok(sent.every((d) => Buffer.from(d, 'base64').every((b) => b === 0))); // silence, never the noise
  assert.equal(h.audio.flushes, 0); // never barges on room noise while muted
});

// Retune 2 (owner 23:4x: "he keeps talking when I talk"; 0.18 x 4-in-a-row never fired in a real call).
test('retune 2: the owner\'s voice at 0.15 (the old "false" band) barges; steady echo never does', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true;
  for (let i = 0; i < 40; i += 1) h.audio.onChunk(pcm(1000)); // steady echo ~0.03
  assert.equal(h.audio.flushes, 0);
  for (let i = 0; i < 3; i += 1) h.audio.onChunk(pcm(5000)); // the owner, ~0.15
  assert.equal(h.audio.flushes, 1);
});

test('retune 2: 3 loud of the last 5 chunks barge — syllable dips no longer reset it; the dips are sent too', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const mic = () => ws.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio).map((m) => m.realtimeInput.audio.data);
  h.audio.playing = true;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800)); // echo baseline ~0.024
  const words = [pcm(4000), pcm(900), pcm(4100), pcm(950), pcm(4200)]; // loud, dip, loud, dip, loud (~0.12)
  for (const chunk of words.slice(0, 4)) h.audio.onChunk(chunk);
  assert.equal(h.audio.flushes, 0); // two loud so far
  h.audio.onChunk(words[4]);
  assert.equal(h.audio.flushes, 1); // the old 4-in-a-row gate never fired here
  assert.deepEqual(mic(), words); // from the first loud chunk, dips included
});

test('retune 2: two loud clicks in a window are not a barge', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800));
  for (const level of [6000, 800, 800, 800, 6000, 800, 800, 800, 800, 6000]) h.audio.onChunk(pcm(level));
  assert.equal(h.audio.flushes, 0); // never 3 loud within 5 chunks
});

test('retune 2: the owner\'s quieter chunks never raise the echo baseline', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800)); // echo ~0.024
  // 0.05: below the 0.06 floor (not loud) but 2x the echo — the old EMA learned these
  // and drifted toward 3 x 0.05 = 0.15, so a 0.12 voice could never barge again.
  for (let i = 0; i < 40; i += 1) h.audio.onChunk(pcm(1650));
  for (let i = 0; i < 3; i += 1) h.audio.onChunk(pcm(4000)); // the owner ~0.12
  assert.equal(h.audio.flushes, 1);
});

test('retune 2: one voice-peak beacon per reply with the loudest chunk that did not barge', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
  await tick();
  h.audio.playing = true;
  h.clock.ms = 1000; // past the grace
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800));
  h.audio.onChunk(pcm(1500)); // ~0.046: the loudest non-barging chunk
  h.audio.onChunk(pcm(800));
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  const peaks = h.events.filter(([name]) => name === 'voice-peak');
  assert.equal(peaks.length, 1);
  assert.ok(peaks[0][1] >= 44 && peaks[0][1] <= 48, String(peaks[0][1]));
  ws.message({ serverContent: { turnComplete: true } });
  await tick();
  assert.equal(h.events.filter(([name]) => name === 'voice-peak').length, 1); // nothing new -> no beacon
});

test('R7 barge grace: no barge-in during the first 0.8 s of a reply — the echo baseline is still ramping', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } }); // reply playback begins (grace anchor)
  await tick();
  h.audio.playing = true;
  for (let i = 0; i < 4; i += 1) h.audio.onChunk(pcm(1500)); // early low echo (~0.046): warmup baseline
  for (let i = 0; i < 4; i += 1) h.audio.onChunk(pcm(9000)); // playback ramps up (~0.27) at t=0 — a would-be barge
  assert.equal(h.audio.flushes, 0); // grace: suppressed, the chunks feed the echo EMA instead
  h.clock.ms = 700;
  for (let i = 0; i < 4; i += 1) h.audio.onChunk(pcm(9000));
  assert.equal(h.audio.flushes, 0); // still inside the 0.8 s grace
  h.clock.ms = 800; // grace over — the baseline is learned
  for (let i = 0; i < 4; i += 1) h.audio.onChunk(pcm(30000)); // clearly above the learned baseline
  assert.equal(h.audio.flushes, 1); // barge-in works again after the grace
});

test('R7 resumeAudio(): forwards to the audio engine; safe after stop', async () => {
  const h = harness();
  await h.openSocket();
  assert.equal(h.audio.resumes, 0);
  h.call.resumeAudio();
  assert.equal(h.audio.resumes, 1);
  h.call.stop();
  h.call.resumeAudio(); // engine gone: a no-op, never a throw
  assert.equal(h.audio.resumes, 1);
});

// Wave-1 review (2026-10-07): when Jimmy already answers during the 2.5 s
// silence tail, the tail never arms a second "owner is waiting" rescue.
test('mute: a reply that arrives during the silence tail gets no extra rescue', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  const rescues = () => ws.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === true && /owner is waiting/.test(m.clientContent.turns[0].parts[0].text));
  ws.message({ serverContent: { inputTranscription: { text: 'انت سامعني؟' } } });
  await tick();
  h.call.mute(true);
  h.clock.ms += 1200; // server VAD closes the turn on the streamed silence...
  ws.message({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm(100) } }] } } });
  ws.message({ serverContent: { turnComplete: true } }); // ...and Jimmy answers before the tail ends
  await tick();
  h.clock.ms += 1300;
  while (h.timers.pending.length) await h.timers.runNext();
  assert.equal(rescues().length, 0);
});

// WO-VP-WORDS R3 (call 210527): a hang-up during send_to_claude must let the
// send finish and its result be recorded before the transcript closes.
test('R3: pendingTools counts an awaiting tool; toolsSettled resolves after stop() and the result is still noted', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const notes = [];
  const h = harness({
    tools: { send_to_claude: async () => { await gate; return { result: 'sent' }; } },
    onTranscript: (role, text) => notes.push([role, text]),
  });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  assert.equal(h.call.pendingTools(), 0);
  await h.call.toolsSettled(); // nothing in flight: resolves at once
  ws.message({ toolCall: { functionCalls: [{ id: 's1', name: 'send_to_claude', args: { instruction: 'x' } }] } });
  await tick();
  assert.equal(h.call.pendingTools(), 1);
  let settled = false;
  const done = h.call.toolsSettled().then(() => { settled = true; });
  h.call.stop(); // the owner hung up mid-send
  await tick();
  assert.equal(settled, false, 'must wait for the send');
  release();
  await done;
  assert.equal(h.call.pendingTools(), 0);
  assert.ok(notes.some(([, text]) => /send_to_claude .*sent/.test(text)), 'the result is recorded after stop()');
});

test('R3: toolsSettled waits for EVERY in-flight tool (two at once)', async () => {
  const gates = [];
  const tool = async () => { await new Promise((resolve) => gates.push(resolve)); return { ok: true }; };
  const h = harness({ tools: { a: tool, b: tool } });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ toolCall: { functionCalls: [{ id: '1', name: 'a', args: {} }] } });
  ws.message({ toolCall: { functionCalls: [{ id: '2', name: 'b', args: {} }] } });
  await tick();
  assert.equal(h.call.pendingTools(), 2);
  let settled = false;
  const done = h.call.toolsSettled().then(() => { settled = true; });
  gates[0]();
  await tick();
  assert.equal(settled, false, 'one of two finished — still waiting');
  assert.equal(h.call.pendingTools(), 1);
  gates[1]();
  await done;
  assert.equal(h.call.pendingTools(), 0);
});

test('review LOW: loud chunks from before a mute never count toward a barge after it', async () => {
  const h = harness();
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.audio.playing = true;
  for (let i = 0; i < 6; i += 1) h.audio.onChunk(pcm(800));
  h.audio.onChunk(pcm(9000));
  h.audio.onChunk(pcm(9000)); // two loud
  h.call.mute(true);
  h.call.mute(false);
  h.audio.onChunk(pcm(9000)); // one loud after unmute: not a barge
  assert.equal(h.audio.flushes, 0);
  h.audio.onChunk(pcm(9000));
  h.audio.onChunk(pcm(9000));
  assert.equal(h.audio.flushes, 1); // three fresh loud chunks are
});

// --- WO-3 (2026-10-09): replacement sessions never re-send an order ----------

const toolResponses = (ws) => ws.sent.filter((m) => m.toolResponse);
const contextTexts = (ws) => ws.sent.filter((m) => m.clientContent && m.clientContent.turnComplete === false).map((m) => m.clientContent.turns[0].parts[0].text);

test('WO-3: a replacement session briefing = last briefing + the orders already sent', async () => {
  const orders = [];
  const h = harness({ replacementNote: () => (orders.length ? `[SESSION CONTEXT] Orders: ${orders.join(' | ')}` : '') });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('[SESSION CONTEXT] brief');
  orders.push('run the tests');
  ws.readyState = 3;
  ws.onclose({ code: 1011, reason: 'Internal error encountered.' });
  const next = await reconnectAfterDrop(h);
  await h.completeSetup(next);
  assert.deepEqual(contextTexts(next), ['[SESSION CONTEXT] brief\n\n[SESSION CONTEXT] Orders: run the tests']);
});

test('WO-3: no orders -> the replacement briefing is the last briefing only (unchanged)', async () => {
  const h = harness({ replacementNote: () => '' });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  h.call.pushContext('[SESSION CONTEXT] brief');
  ws.readyState = 3;
  ws.onclose({ code: 1011 });
  const next = await reconnectAfterDrop(h);
  await h.completeSetup(next);
  assert.deepEqual(contextTexts(next), ['[SESSION CONTEXT] brief']);
});

test('WO-3: a toolResponse goes only to the socket that started the tool; the replacement is told the order instead', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const orders = [];
  const tools = {
    send_to_claude: async ({ instruction }) => {
      await gate; // the send is in flight while the Live socket dies
      orders.push(instruction);
      return { result: 'sent' };
    },
  };
  const h = harness({ tools, replacementNote: () => (orders.length ? `[SESSION CONTEXT] Orders: ${orders.join(' | ')}` : '') });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ toolCall: { functionCalls: [{ id: 'o1', name: 'send_to_claude', args: { instruction: 'راجع' } }] } });
  await tick();
  ws.readyState = 3;
  ws.onclose({ code: 1011 });
  const next = await reconnectAfterDrop(h);
  await h.completeSetup(next);
  release();
  await tick();
  assert.equal(toolResponses(ws).length, 0, 'the dead socket gets nothing');
  assert.equal(toolResponses(next).length, 0, 'the replacement never gets an answer to a call it did not make');
  assert.deepEqual(contextTexts(next), ['[SESSION CONTEXT] Orders: راجع'], 'the replacement learns the order went out');
  assert.equal(h.call.pendingTools(), 0);
});

test('WO-3: the same socket still gets its toolResponse (normal path unchanged)', async () => {
  const h = harness({ tools: { send_to_claude: async () => ({ result: 'sent' }) }, replacementNote: () => 'x' });
  const ws = await h.openSocket();
  await h.completeSetup(ws);
  ws.message({ toolCall: { functionCalls: [{ id: 'n1', name: 'send_to_claude', args: { instruction: 'go' } }] } });
  await tick();
  assert.equal(toolResponses(ws).length, 1);
  assert.equal(toolResponses(ws)[0].toolResponse.functionResponses[0].id, 'n1');
  assert.deepEqual(contextTexts(ws), [], 'no orders note on the live socket that got its answer');
});
