import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveAudio,
  downsampleTo16k,
  int16ToBase64,
  base64ToFloat32,
  WORKLET_PROCESSOR_SOURCE,
} from '../lib/live-audio.mjs';

// --- pure helpers ---------------------------------------------------------------

test('downsampleTo16k: integer-ratio decimation, passthrough, clamp, empty', () => {
  // 32k -> 16k picks every 2nd sample (pos hits integers exactly)
  assert.deepEqual(Array.from(downsampleTo16k(Float32Array.of(0.5, -0.5, 0.25, -0.25), 32000)), [16384, 8192]);
  // 48k -> 16k picks every 3rd sample
  assert.deepEqual(Array.from(downsampleTo16k(Float32Array.of(1, 0, 0, -1, 0, 0), 48000)), [32767, -32767]);
  // 16k passthrough is exact
  assert.deepEqual(Array.from(downsampleTo16k(Float32Array.of(1, -1, 0), 16000)), [32767, -32767, 0]);
  // out-of-range values clamp to [-1, 1]
  assert.deepEqual(Array.from(downsampleTo16k(Float32Array.of(2, -2), 16000)), [32767, -32767]);
  // non-integer ratio (44100) keeps a constant constant across the lerp
  const out = downsampleTo16k(new Float32Array(4410).fill(0.5), 44100);
  assert.equal(out.length, 1600);
  assert.ok(Array.from(out).every((v) => v === 16384));
  assert.equal(downsampleTo16k(new Float32Array(0), 48000).length, 0);
  assert.equal(downsampleTo16k(null, 48000).length, 0);
  assert.equal(downsampleTo16k(Float32Array.of(1), 0).length, 0);
});

test('int16ToBase64 / base64ToFloat32: exact little-endian PCM16 round trip', () => {
  const samples = Int16Array.of(0, 1, -1, 32767, -32768, 12345, -12345);
  const b64 = int16ToBase64(samples);
  assert.equal(b64, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64'));
  const floats = base64ToFloat32(b64);
  assert.equal(floats.length, samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    assert.ok(Math.abs(floats[i] - samples[i] / 32768) < 1e-9, `sample ${i}`);
  }
  assert.equal(int16ToBase64(new Int16Array(0)), '');
  assert.equal(base64ToFloat32('').length, 0);
});

test('inline worklet source batches render quanta to chunkSamples in order', () => {
  let Processor = null;
  const register = (name, cls) => {
    assert.equal(name, 'pcm-chunk-sender');
    Processor = cls;
  };
  const Base = class {};
  new Function('AudioWorkletProcessor', 'registerProcessor', WORKLET_PROCESSOR_SOURCE)(Base, register);
  const posted = [];
  const processor = new Processor({ processorOptions: { chunkSamples: 256 } });
  processor.port = { postMessage: (m) => posted.push(m) };
  const frames = (n) => [[new Float32Array(n).fill(0.5)]];
  processor.process(frames(128));
  processor.process(frames(128)); // 256 reached -> posts
  assert.equal(posted.length, 1);
  assert.equal(posted[0].length, 256);
  assert.equal(posted[0][0], 0.5);
  assert.equal(posted[0][255], 0.5);
  processor.process(frames(100)); // 100 pending
  assert.equal(posted.length, 1);
  processor.process(frames(128)); // 228 pending
  assert.equal(posted.length, 1);
  processor.process(frames(128)); // 356 -> posts merged 356
  assert.equal(posted.length, 2);
  assert.equal(posted[1].length, 356);
  assert.equal(processor.process([[]]), true); // no input: survives
});

// --- fakes ----------------------------------------------------------------------

class FakeMediaStreamSource {
  constructor(stream) {
    this.stream = stream;
    this.connectedTo = null;
  }
  connect(target) {
    this.connectedTo = target;
  }
  disconnect() {
    this.connectedTo = null;
  }
}

class FakeWorkletNode {
  constructor(ctx, name, options) {
    this.ctx = ctx;
    this.name = name;
    this.options = options;
    this.port = { onmessage: null, postMessages: [] };
    this.connectedTo = null;
    ctx.workletNodes.push(this);
  }
  connect(target) {
    this.connectedTo = target;
  }
  disconnect() {
    this.connectedTo = null;
  }
}

class FakeAudioContext {
  constructor(opts = {}) {
    this.opts = opts;
    this.sampleRate = opts.sampleRate || 48000;
    this.currentTime = 0;
    this.state = 'suspended';
    this.closed = false;
    this.destination = { destination: true };
    this.audioWorklet = { modules: [], addModule: async (url) => this.audioWorklet.modules.push(url) };
    this.workletNodes = [];
    this.streamSources = [];
    this.buffers = [];
    this.bufferSources = [];
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
  createMediaStreamSource(stream) {
    const source = new FakeMediaStreamSource(stream);
    this.streamSources.push(source);
    return source;
  }
  createBuffer(channels, length, sampleRate) {
    const buffer = {
      numberOfChannels: channels,
      length,
      sampleRate,
      data: new Float32Array(length),
      copyToChannel(frames, channel) {
        if (channel === 0) this.data.set(frames);
      },
      getChannelData() {
        return this.data;
      },
    };
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource() {
    const node = { buffer: null, connectedTo: null, starts: [], stops: [], onended: null, ended: false };
    node.connect = (target) => {
      node.connectedTo = target;
    };
    node.start = (t) => {
      node.starts.push(t);
      node.ended = false;
    };
    node.stop = (t) => {
      node.stops.push(t);
      node.ended = true;
    };
    this.bufferSources.push(node);
    return node;
  }
}

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { tracks: [track], getTracks: () => [track] };
}

function fill(length, value) {
  const out = new Float32Array(length);
  out.fill(value);
  return out;
}

// --- createLiveAudio ------------------------------------------------------------

test('startMic: exact constraints, worklet wiring, 16 kHz base64 chunks, RMS levels', async () => {
  const gumCalls = [];
  const contexts = [];
  const AudioCtor = class extends FakeAudioContext {
    constructor(opts) {
      super(opts);
      contexts.push(this);
    }
  };
  const chunks = [];
  const levels = [];
  const clock = { t: 0 };
  const stream = fakeStream();
  const audio = createLiveAudio({
    AudioContext: AudioCtor,
    getUserMedia: async (constraints) => {
      gumCalls.push(constraints);
      return stream;
    },
    onChunk: (b64) => chunks.push(b64),
    onLevel: (level) => levels.push(level),
    now: () => clock.t,
    AudioWorkletNode: FakeWorkletNode,
  });
  assert.equal(await audio.startMic(), true);
  assert.deepEqual(gumCalls, [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }]);
  const micCtx = contexts[0];
  assert.equal(micCtx.sampleRate, 48000); // native-rate capture context
  assert.equal(micCtx.audioWorklet.modules.length, 1);
  assert.equal(typeof micCtx.audioWorklet.modules[0], 'string');
  const node = micCtx.workletNodes[0];
  assert.equal(node.name, 'pcm-chunk-sender');
  assert.equal(node.options.processorOptions.chunkSamples, Math.round((48000 * 80) / 1000)); // ~80 ms
  assert.equal(micCtx.streamSources[0].connectedTo, node);
  assert.equal(node.connectedTo, micCtx.destination);

  // 4800 samples at 48 kHz of 0.25 -> 1600 int16 samples of 8192
  node.port.onmessage({ data: fill(4800, 0.25) });
  assert.equal(chunks.length, 1);
  const bytes = Buffer.from(chunks[0], 'base64');
  assert.equal(bytes.length, 3200);
  assert.equal(bytes.readInt16LE(0), 8192);
  assert.equal(bytes.readInt16LE(bytes.length - 2), 8192);

  // level meter: first frame emits immediately, next only after the 50 ms gate
  assert.equal(levels.length, 1);
  assert.ok(Math.abs(levels[0].mic - 0.25) < 1e-6);
  assert.ok(levels[0].out >= 0 && levels[0].out <= 1);
  clock.t += 100;
  node.port.onmessage({ data: fill(128, 0.5) });
  assert.equal(levels.length, 2);
  assert.ok(Math.abs(levels[1].mic - 0.5) < 1e-6);
});

test('setMuted: mic level 0 and zero-filled chunks of the same length while muted (WO-VP-LIVE)', async () => {
  const contexts = [];
  const AudioCtor = class extends FakeAudioContext {
    constructor(opts) {
      super(opts);
      contexts.push(this);
    }
  };
  const chunks = [];
  const levels = [];
  const clock = { t: 0 };
  const audio = createLiveAudio({
    AudioContext: AudioCtor,
    getUserMedia: async () => fakeStream(),
    onChunk: (b64) => chunks.push(b64),
    onLevel: (level) => levels.push(level),
    now: () => clock.t,
    AudioWorkletNode: FakeWorkletNode,
  });
  await audio.startMic();
  const node = contexts[0].workletNodes[0];
  node.port.onmessage({ data: fill(4800, 0.25) });
  assert.equal(chunks.length, 1);
  audio.setMuted(true);
  clock.t += 100;
  node.port.onmessage({ data: fill(4800, 0.25) });
  assert.equal(chunks.length, 2); // cadence kept: a chunk still arrives
  assert.equal(chunks[1].length, chunks[0].length); // exact same length
  assert.ok(Buffer.from(chunks[1], 'base64').every((b) => b === 0)); // but all-zero PCM
  assert.equal(levels.length, 2); // meter keeps running
  assert.equal(levels[1].mic, 0); // muted -> level 0: the orb never pulses on room noise
  audio.setMuted(false);
  clock.t += 100;
  node.port.onmessage({ data: fill(4800, 0.25) });
  assert.equal(chunks.length, 3);
  assert.equal(Buffer.from(chunks[2], 'base64').readInt16LE(0), 8192); // real audio again
});

test('R7 resume(): resumes suspended mic and playback contexts', async () => {
  const contexts = [];
  const AudioCtor = class extends FakeAudioContext {
    constructor(opts) {
      super(opts);
      contexts.push(this);
    }
  };
  const audio = createLiveAudio({ AudioContext: AudioCtor, getUserMedia: async () => fakeStream(), AudioWorkletNode: FakeWorkletNode });
  await audio.startMic();
  audio.play(int16ToBase64(new Int16Array(2400).fill(8192))); // lazy playback context
  contexts[0].state = 'suspended'; // as iOS Safari leaves them without a gesture
  contexts[1].state = 'suspended';
  audio.resume();
  assert.equal(contexts[0].state, 'running'); // mic context back
  assert.equal(contexts[1].state, 'running'); // playback context back
  audio.close();
  audio.resume(); // closed engine: a safe no-op
});

test('play: 24 kHz context, 120 ms jitter lead when dry, back-to-back scheduling, isPlaying, flush resets the clock', () => {
  const contexts = [];
  const AudioCtor = class extends FakeAudioContext {
    constructor(opts) {
      super(opts);
      contexts.push(this);
    }
  };
  const audio = createLiveAudio({ AudioContext: AudioCtor, getUserMedia: async () => fakeStream() });
  const chunk = int16ToBase64(new Int16Array(2400).fill(8192)); // 100 ms of 0.25 at 24 kHz
  audio.play(chunk);
  assert.equal(contexts.length, 1); // playback context is created lazily
  const playCtx = contexts[0];
  assert.deepEqual(playCtx.opts, { sampleRate: 24000 });
  assert.equal(playCtx.buffers.length, 1);
  const buffer = playCtx.buffers[0];
  assert.equal(buffer.length, 2400);
  assert.equal(buffer.sampleRate, 24000);
  assert.ok(Math.abs(buffer.data[0] - 0.25) < 1e-9);
  const first = playCtx.bufferSources[0];
  assert.deepEqual(first.starts, [0.12]); // queue dry -> jitter lead
  assert.equal(first.connectedTo, playCtx.destination);
  assert.equal(audio.isPlaying(), true);

  audio.play(chunk); // scheduled back-to-back after the first 100 ms
  const second = playCtx.bufferSources[1];
  assert.ok(Math.abs(second.starts[0] - 0.22) < 1e-9); // back-to-back, no extra lead
  first.onended();
  assert.equal(audio.isPlaying(), true); // second source still scheduled
  second.onended();
  assert.equal(audio.isPlaying(), false);

  audio.play(chunk);
  audio.play(chunk);
  const third = playCtx.bufferSources[2];
  const fourth = playCtx.bufferSources[3];
  assert.ok(Math.abs(third.starts[0] - 0.32) < 1e-9); // queue clock carried on
  assert.ok(Math.abs(fourth.starts[0] - 0.42) < 1e-9); // float error tolerated
  playCtx.currentTime = 5; // wall clock moves on
  audio.flush(); // barge-in
  assert.deepEqual(third.stops, [0]);
  assert.deepEqual(fourth.stops, [0]);
  assert.equal(audio.isPlaying(), false);
  audio.play(chunk);
  const fifth = playCtx.bufferSources[4];
  assert.ok(Math.abs(fifth.starts[0] - 5.12) < 1e-9); // resumes at currentTime + lead after flush
  assert.equal(audio.isPlaying(), true);
});

test('stopMic/close lifecycle: tracks stopped, contexts closed, play becomes a no-op', async () => {
  const contexts = [];
  const AudioCtor = class extends FakeAudioContext {
    constructor(opts) {
      super(opts);
      contexts.push(this);
    }
  };
  const gumCalls = [];
  const audio = createLiveAudio({
    AudioContext: AudioCtor,
    getUserMedia: async () => {
      gumCalls.push(1);
      return fakeStream();
    },
    AudioWorkletNode: FakeWorkletNode,
  });
  await audio.startMic();
  const [micCtx] = contexts;
  const track = micCtx.streamSources[0].stream.getTracks()[0];
  await audio.stopMic();
  assert.equal(track.stopped, true);
  assert.equal(micCtx.closed, true);
  assert.equal(await audio.startMic(), true); // restart creates a fresh context
  assert.equal(gumCalls.length, 2);
  assert.equal(contexts.length, 2);

  audio.play(int16ToBase64(new Int16Array(2400).fill(8192)));
  const playCtx = contexts[contexts.length - 1];
  assert.equal(audio.isPlaying(), true);
  await audio.close();
  assert.equal(audio.isPlaying(), false);
  assert.ok(contexts.every((ctx) => ctx.closed));
  const before = playCtx.bufferSources.length;
  audio.play(int16ToBase64(new Int16Array(2400).fill(8192)));
  assert.equal(playCtx.bufferSources.length, before); // closed engine ignores playback
});

// --- F3/F4 fixes ------------------------------------------------------------------

test('F3: suspended contexts are resumed; the mic context is created before any await (gesture path)', async () => {
  const contexts = [];
  const resumes = [];
  const AudioCtor = class extends FakeAudioContext {
    constructor(opts) {
      super(opts);
      contexts.push(this);
    }
    async resume() {
      resumes.push(this);
      return super.resume();
    }
  };
  const audio = createLiveAudio({
    AudioContext: AudioCtor,
    getUserMedia: async () => fakeStream(),
    AudioWorkletNode: FakeWorkletNode,
  });
  const starting = audio.startMic();
  assert.equal(contexts.length, 1); // created synchronously — inside the caller's click task
  await starting;
  assert.equal(contexts[0].state, 'running');
  assert.equal(resumes.filter((ctx) => ctx === contexts[0]).length, 1);
  audio.play(int16ToBase64(new Int16Array(2400).fill(8192)));
  assert.equal(contexts.length, 2); // playback context created lazily
  assert.equal(contexts[1].state, 'running');
  assert.equal(resumes.filter((ctx) => ctx === contexts[1]).length, 1); // play ctx resumed too
});

test('F4: close() revokes the worklet blob URL exactly once', async () => {
  const created = [];
  const revoked = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    created.push(blob);
    return 'blob:fake-worklet-url';
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const audio = createLiveAudio({
      AudioContext: FakeAudioContext,
      getUserMedia: async () => fakeStream(),
      AudioWorkletNode: FakeWorkletNode,
    });
    await audio.startMic();
    assert.deepEqual(revoked, []);
    await audio.close();
    assert.deepEqual(revoked, ['blob:fake-worklet-url']);
    await audio.close(); // idempotent
    assert.deepEqual(revoked, ['blob:fake-worklet-url']);
  } finally {
    if (originalCreate === undefined) delete URL.createObjectURL;
    else URL.createObjectURL = originalCreate;
    if (originalRevoke === undefined) delete URL.revokeObjectURL;
    else URL.revokeObjectURL = originalRevoke;
  }
});
