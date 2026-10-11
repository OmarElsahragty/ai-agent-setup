// Live call audio engine (WO-VL-LIVE) — mic capture and playback for the
// Gemini Live voice call on ${AI_SETUP_DOMAIN}. Pure and injectable: the
// AudioContext constructor, getUserMedia and the AudioWorkletNode constructor
// are passed in, so the whole pipeline is unit-testable with fakes.
//
// Capture:  getUserMedia({echoCancellation,noiseSuppression,autoGainControl,
//           channelCount:1}) -> AudioContext (native rate) -> AudioWorklet
//           (inline source, Blob URL) batching ~80 ms frames -> main thread
//           downsampleTo16k -> int16ToBase64 -> onChunk (per 40-100 ms chunk).
// Playback: separate 24 kHz AudioContext, AudioBufferSourceNodes scheduled
//           back-to-back (nextStartTime); flush() stops everything scheduled.
// Meters:   RMS mic/out levels, onLevel({mic,out}) 0..1 throttled to ~20 Hz.

const MIC_RATE = 16000;
const OUT_RATE = 24000;
// Jitter buffer: when the playback queue has run dry (first chunk of a reply,
// or a late chunk on a mobile network) start JITTER_LEAD_S ahead so the next
// few chunks queue behind it instead of each one playing with a gap.
const JITTER_LEAD_S = 0.12;
const CHUNK_MS = 80;
const LEVEL_INTERVAL_MS = 50;

// Inline AudioWorklet processor: merges 128-sample render quantums until
// chunkSamples, then posts one Float32Array (transferred) to the main thread.
export const WORKLET_PROCESSOR_SOURCE = [
  'class PcmChunkSender extends AudioWorkletProcessor {',
  '  constructor(options) {',
  '    super();',
  '    const opts = (options && options.processorOptions) || {};',
  '    this.chunkSamples = Math.max(128, opts.chunkSamples | 0);',
  '    this.pending = [];',
  '    this.pendingLength = 0;',
  '  }',
  '  process(inputs) {',
  '    const channel = inputs[0] && inputs[0][0];',
  '    if (!channel || !channel.length) return true;',
  '    this.pending.push(new Float32Array(channel));',
  '    this.pendingLength += channel.length;',
  '    if (this.pendingLength < this.chunkSamples) return true;',
  '    const merged = new Float32Array(this.pendingLength);',
  '    let offset = 0;',
  '    for (const part of this.pending) { merged.set(part, offset); offset += part.length; }',
  '    this.pending = [];',
  '    this.pendingLength = 0;',
  '    this.port.postMessage(merged, [merged.buffer]);',
  '    return true;',
  '  }',
  '}',
  "registerProcessor('pcm-chunk-sender', PcmChunkSender);",
].join('\n');

/** Linear-interpolation resample of a Float32Array to 16 kHz Int16 (LE samples). */
export function downsampleTo16k(input, inRate) {
  if (!input || !input.length || !Number.isFinite(inRate) || inRate <= 0) return new Int16Array(0);
  const outLength = Math.floor((input.length * MIC_RATE) / inRate);
  const out = new Int16Array(outLength);
  const step = inRate / MIC_RATE;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index];
    const b = index + 1 < input.length ? input[index + 1] : a;
    let value = a + (b - a) * frac;
    if (!Number.isFinite(value)) value = 0;
    if (value > 1) value = 1;
    if (value < -1) value = -1;
    out[i] = Math.round(value * 32767);
  }
  return out;
}

function bytesToBase64(bytes) {
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(base64) {
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(String(base64));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(String(base64), 'base64'));
}

/** Int16 samples -> base64 of the little-endian PCM16 bytes. */
export function int16ToBase64(samples) {
  if (!samples || !samples.length) return '';
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i], true);
  return bytesToBase64(bytes);
}

/** base64 of little-endian PCM16 bytes -> Float32Array in [-1, 1] (/32768). */
export function base64ToFloat32(base64) {
  if (!base64) return new Float32Array(0);
  const bytes = base64ToBytes(base64);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function rms(frames) {
  if (!frames || !frames.length) return 0;
  let sum = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const v = frames[i];
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / frames.length));
}

function stopTracks(stream) {
  try {
    const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (const track of tracks) if (track && typeof track.stop === 'function') track.stop();
  } catch {
    // already dead stream
  }
}

function makeModuleUrl() {
  try {
    return URL.createObjectURL(new Blob([WORKLET_PROCESSOR_SOURCE], { type: 'application/javascript' }));
  } catch {
    return WORKLET_PROCESSOR_SOURCE;
  }
}

// F3: browsers (notably iOS Safari) hand out AudioContexts in 'suspended'
// state unless unlocked inside a user gesture — always try to resume right
// after creation; a refusal is non-fatal.
function resumeIfSuspended(ctx) {
  if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    try {
      Promise.resolve(ctx.resume()).catch(() => {});
    } catch {
      // resume refused — capture/playback may stay silent, but never throw
    }
  }
}

/**
 * Audio engine for one call. All browser APIs are injected:
 *   {AudioContext, getUserMedia, onChunk(base64 pcm16 16k), onLevel({mic,out}),
 *    now()?, AudioWorkletNode?}
 * Returns {startMic(), stopMic(), setMuted(bool), play(base64Pcm24k), flush(),
 *          close(), isPlaying(), resume()}.
 */
export function createLiveAudio({ AudioContext, getUserMedia, onChunk, onLevel, now, AudioWorkletNode } = {}) {
  const nowFn = typeof now === 'function' ? now : () => Date.now();
  const WorkletNode = AudioWorkletNode || globalThis.AudioWorkletNode;
  let micCtx = null;
  let micStream = null;
  let micSource = null;
  let workletNode = null;
  let playCtx = null;
  let nextStartTime = 0;
  let moduleUrl = null;
  let muted = false;
  let closed = false;
  let micLevel = 0;
  let outLevel = 0;
  let lastLevelAt = null;
  const sources = new Set();

  function emitLevel() {
    if (typeof onLevel !== 'function') return;
    const t = nowFn();
    if (lastLevelAt !== null && t - lastLevelAt < LEVEL_INTERVAL_MS) return;
    lastLevelAt = t;
    onLevel({ mic: micLevel, out: outLevel });
  }

  function onFrames(frames) {
    // Muted (WO-VP-LIVE): the meter reports silence — the orb must not pulse
    // on room noise — and onChunk keeps its exact cadence with a zero-filled
    // chunk of the same length instead of nothing.
    micLevel = muted ? 0 : rms(frames);
    emitLevel();
    if (typeof onChunk !== 'function' || !micCtx) return;
    const pcm16 = downsampleTo16k(frames, micCtx.sampleRate);
    if (muted) pcm16.fill(0);
    onChunk(int16ToBase64(pcm16));
  }

  async function stopMic() {
    micSource = null;
    workletNode = null;
    stopTracks(micStream);
    micStream = null;
    const ctx = micCtx;
    micCtx = null;
    if (ctx && typeof ctx.close === 'function') {
      try {
        await ctx.close();
      } catch {
        // context already gone
      }
    }
  }

  async function startMic() {
    if (closed) return false;
    // F3: the AudioContext is created BEFORE any await so it happens inside
    // the caller's user-gesture task (the call-button click) — contexts
    // created after an await stay suspended on iOS Safari.
    const ctx = new AudioContext();
    resumeIfSuspended(ctx);
    const previousCtx = micCtx;
    micCtx = ctx;
    micSource = null;
    workletNode = null;
    stopTracks(micStream);
    micStream = null;
    if (previousCtx && previousCtx !== ctx && typeof previousCtx.close === 'function') {
      try {
        await previousCtx.close();
      } catch {
        // previous context already gone
      }
    }
    let stream;
    try {
      stream = await getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      await stopMic(); // never leak the just-created context
      throw error;
    }
    if (closed) {
      stopTracks(stream);
      await stopMic();
      return false;
    }
    micStream = stream;
    if (!micCtx.audioWorklet || !WorkletNode) throw new Error('AudioWorklet unavailable');
    const source = micCtx.createMediaStreamSource(stream);
    if (!moduleUrl) moduleUrl = makeModuleUrl();
    await micCtx.audioWorklet.addModule(moduleUrl);
    if (closed) {
      stopTracks(stream);
      await stopMic();
      return false;
    }
    const rate = micCtx.sampleRate || 48000;
    workletNode = new WorkletNode(micCtx, 'pcm-chunk-sender', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { chunkSamples: Math.max(128, Math.round((rate * CHUNK_MS) / 1000)) },
    });
    workletNode.port.onmessage = (event) => onFrames(event.data);
    source.connect(workletNode);
    workletNode.connect(micCtx.destination);
    micSource = source;
    return true;
  }

  function ensurePlayCtx() {
    if (playCtx || !AudioContext) return;
    playCtx = new AudioContext({ sampleRate: OUT_RATE });
    resumeIfSuspended(playCtx); // F3
    nextStartTime = playCtx.currentTime || 0;
  }

  function play(base64Pcm24k) {
    if (closed || typeof base64Pcm24k !== 'string' || !base64Pcm24k) return;
    ensurePlayCtx();
    if (!playCtx) return;
    const frames = base64ToFloat32(base64Pcm24k);
    if (!frames.length) return;
    outLevel = Math.max(outLevel, rms(frames));
    let buffer;
    let node;
    try {
      buffer = playCtx.createBuffer(1, frames.length, OUT_RATE);
      if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(frames, 0);
      else buffer.getChannelData(0).set(frames);
      node = playCtx.createBufferSource();
      node.buffer = buffer;
      node.connect(playCtx.destination);
    } catch {
      return;
    }
    const now = playCtx.currentTime || 0;
    const at = Math.max(now + (nextStartTime <= now ? JITTER_LEAD_S : 0), nextStartTime);
    try {
      node.start(at);
    } catch {
      return;
    }
    nextStartTime = at + frames.length / OUT_RATE;
    node.onended = () => {
      sources.delete(node);
      if (!sources.size) outLevel = 0;
      emitLevel();
    };
    sources.add(node);
    emitLevel();
  }

  function flush() {
    for (const node of sources) {
      try {
        node.onended = null;
        node.stop(0);
      } catch {
        // already finished
      }
    }
    sources.clear();
    if (playCtx) nextStartTime = playCtx.currentTime || 0;
    outLevel = 0;
  }

  function setMuted(value) {
    muted = !!value;
  }

  // R7 (WO-VP-LIVE): after an auto-started call iOS Safari may leave contexts
  // suspended until the first user gesture — the call layer calls this on the
  // first tap to resume BOTH capture and playback.
  function resume() {
    resumeIfSuspended(micCtx);
    resumeIfSuspended(playCtx);
  }

  function isPlaying() {
    return sources.size > 0;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await stopMic();
    flush();
    const ctx = playCtx;
    playCtx = null;
    if (ctx && typeof ctx.close === 'function') {
      try {
        await ctx.close();
      } catch {
        // context already gone
      }
    }
    // F4: release the worklet Blob URL (no leak when it fell back to a raw
    // source string, e.g. in non-browser environments).
    if (moduleUrl && moduleUrl.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(moduleUrl);
      } catch {
        // already revoked
      }
    }
    moduleUrl = null;
  }

  return { startMic, stopMic, setMuted, play, flush, close, isPlaying, resume };
}
