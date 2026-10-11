// Gemini Live call core (WO-VL-LIVE) — the browser half of the ${AI_SETUP_DOMAIN}
// voice call. Owns the WebSocket protocol lifecycle only; capture/playback live
// in live-audio.mjs and are injected as deps.audio, so this layer is fully
// unit-testable with a fake WebSocket, fake fetch and a fake audio factory.
//
// Protocol (setup LOCKED server-side in the ephemeral token from voice-gateway):
//   POST tokenUrl (credentials:'include') -> {token, model, wsUrl, expiresAt}
//   WS   `${wsUrl}?access_token=${encodeURIComponent(token)}`
//   ->   {setup:{model:'models/'+model, sessionResumption: handle?{handle}:{}}}
//   <-   setupComplete                    (mic audio flows only AFTER this)
//   ->   {realtimeInput:{audio:{data, mimeType:'audio/pcm;rate=16000'}}}
//   ->   {realtimeInput:{audioStreamEnd:true}}   (once per mute)
//   <-   serverContent.modelTurn.parts[].inlineData.data  (ALL parts played)
//   <-   serverContent.interrupted  -> flush playback (barge-in)
//   <-   serverContent.turnComplete -> idle; listening once playback drained
//   <-   toolCall.functionCalls[]   -> tools[name](args) -> {toolResponse:...}
//   <-   toolCallCancellation.ids[] -> drop those responses
//   <-   sessionResumptionUpdate.newHandle (resumable) -> stored for reconnect
//   <-   goAway -> fresh token + immediate reconnect WITH the handle; the mic
//        keeps running the whole time.
//   Unexpected close -> backoff 0.5/1/2/4 s (capped), max 5 attempts -> 'unavailable'.
//   Owner 2026-10-08 (call 20261008-191x, "keeps connecting"): Google closed
//   live sessions with 1011 seconds after setupComplete; resuming the handle
//   kept dying and the attempt reset at setupComplete looped forever. Now: the
//   close code is reported (live-drop), a 1011 or a second failure in a row
//   reconnects FRESH (no handle; the last briefing is re-sent), a socket with
//   no setupComplete after SETUP_TIMEOUT_MS is a failure, and MAX_DROPS live
//   sessions dying within DROP_WINDOW_MS end in 'unavailable' until retry()
//   (exhausted attempts too; 'error' stays the mic failure).
//   Owner 2026-10-08 (call 20261008-200644): a session can stay connected but
//   silent — the owner was transcribed, the nudge and the reply rescue got
//   nothing back. SILENT_SESSION_MS after the rescue with no model output the
//   session counts as dead (live-drop SILENT_SESSION_CODE): fresh reconnect,
//   and the owner's unanswered words are sent to the new session as text.
//   pushText while the model speaks/mid-turn is queued; sent after
//   turnComplete once playback has drained.
//   pushContext (WO-VL-CTX) sends a turnComplete:false briefing — silent
//   context for the model, never a spoken turn; queued until setupComplete.
//
// onEvent(name, n): live-open(1) / live-close(1) / live-error(attempts) /
//   mic-error(1) / tool-call(number of calls) / reconnect(attempt number) /
//   live-drop(close code; SETUP_TIMEOUT_CODE = no setupComplete) / live-retry(1).
// onUserSpeech(text) (F8, optional): fires with the trimmed server
//   inputTranscription text whenever the OWNER speaks — the prompt-injection
//   gate in voice-bridge consumes it.
// onTurnComplete({spoke}) (optional, WO-VP-LIVE): fires on EVERY
//   serverContent.turnComplete; spoke = model audio arrived during that turn
//   (false = silent turn, e.g. the muted-room case). Listener throws are
//   swallowed.
// pendingTools()/toolsSettled() (WO-VP-WORDS R3, owner 2026-10-07): tool fns
//   still awaiting — the add-on drains them before closing the transcript on
//   hang-up; a result that lands after stop() is still noted, never sent.

import { createLiveAudio } from './live-audio.mjs';

const BACKOFF_MS = [500, 1000, 2000, 4000];
const MAX_ATTEMPTS = 5;
const SETUP_TIMEOUT_MS = 10000;
const TOKEN_TIMEOUT_MS = 10000; // a hung token POST is a failed attempt, never an endless 'reconnecting'
const SETUP_TIMEOUT_CODE = 4408; // app-range close code reported for a setup timeout
const DROP_WINDOW_MS = 60000;
const MAX_DROPS = 3; // live sessions dying within DROP_WINDOW_MS before giving up
const SILENT_SESSION_MS = 6000;
const SILENT_SESSION_CODE = 4410; // app-range close code reported for a silent session
const OWNER_WORDS_MAX = 1000;
const DRAIN_POLL_MS = 100;
// Owner 2026-10-07: queued Claude updates wait until the owner has been quiet
// and Gemini has finished speaking for this long — never talk over either.
const UPDATE_QUIET_MS = 3000;
// One pushed update turn at a time: a second clientContent before the model
// answers the first interrupts it (the stutter). Give up waiting after this.
const REPLY_WAIT_MS = 10000;
// Echo guard (owner 2026-10-07, call 20261007-161216): on the phone speaker the
// browser's echo cancellation does not remove Gemini's own Web Audio playback,
// so Gemini heard itself ("Pati se", "Bater", "Amén"), barged in on itself and
// looped. The mic upload is paused while Gemini's audio plays and for
// ECHO_TAIL_MS after it ends (half-duplex: no talking over Gemini).
const ECHO_TAIL_MS = 400;
// Barge-in (owner 2026-10-07: "when I talk, you stop and listen"): while Gemini
// speaks, a voice clearly louder than the learned speaker echo for
// BARGE_CHUNKS chunks in a row stops playback at once, drops the rest of that
// reply, and reopens the mic so the server hears the owner.
// Retune 2026-10-07 from real-phone barge beacons (level x1000): false barges
// 65/85/134/150/155, the one likely-real barge 319, echo EMA 3-16 — the floor
// moved to 0.18 (above every false barge, below the real one) and a barge now
// needs 4 sustained chunks so a noise click never cuts Gemini off.
// Retune 2 (owner 23:4x, calls 233443/233655: "he keeps talking when I talk"):
// with 0.18 x 4-in-a-row NO barge fired in any call — the owner's voice dips
// between syllables and reset the run, and the echo EMA learned from the
// owner's own quieter chunks so the bar rose while they talked. Owner chose
// "sensitive": floor 0.06, 3 loud of the last 5 chunks, and after warmup/grace
// only echo-like chunks (<= ECHO_TRACK_FACTOR x baseline) move the baseline.
// A false barge costs a 3 s pause: the add-on's noise check resumes the part.
const BARGE_MIN_LEVEL = 0.06; // RMS 0..1 floor (owner voice beacons x1000: 56-319, echo 3-16)
const BARGE_ECHO_FACTOR = 3; // must beat the echo baseline by this much
const BARGE_WINDOW = 5; // ~400 ms of 80 ms chunks
const BARGE_LOUD = 3; // loud chunks within the window that make a barge
const ECHO_TRACK_FACTOR = 1.5; // after grace only echo-like chunks update the baseline
const ECHO_WARMUP_CHUNKS = 4; // learn the echo level before allowing barge-in
// R7 (owner 2026-10-07): transcript replays show false barges 0.3-2 s into
// Jimmy's OWN reply — the echo baseline was learned from only the warmup
// chunks while playback was still ramping up. No barge-in during the first
// BARGE_GRACE_MS of a reply's playback (anchored at the first audio chunk of
// a model turn); those chunks still feed the echo EMA.
const BARGE_GRACE_MS = 800; // retune 2: 1.5 s left every auto-continued part deaf at its start
// Owner 2026-10-07 ("sometimes it just doesn't answer"): if the owner spoke and
// the model shows no sign of answering this long after the last transcribed
// word, room noise is holding the server's turn open — end it explicitly.
const TURN_END_NUDGE_MS = 2500;
// Owner 2026-10-07 (calls 165538/165622/165631): after a tool result or a
// turn-nudge the model sometimes never speaks. One text nudge per owner turn.
const REPLY_RESCUE_MS = 5000;
const REPLY_RESCUE_TEXT = '[APP] The owner is waiting for your answer to what they just said. Answer them now.';
// Owner 2026-10-07 (WO-VP-LIVE mute bug): mute pressed after speaking left the
// server listening to room noise forever and Jimmy never answered. Mute now
// streams silence (never the room) for this long so the server VAD
// (silenceDurationMs ~1200 ms) closes the owner's turn, then ends the audio
// stream exactly once — nothing audio goes up after that until unmute.
const MUTE_SILENCE_MS = 2500;

/** RMS (0..1) of a base64 little-endian PCM16 chunk; 0 when undecodable. */
export function pcmLevel(base64) {
  try {
    const bin = globalThis.atob(base64);
    const n = bin.length >> 1;
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      sum += v * v;
    }
    return Math.sqrt(sum / n) / 32768;
  } catch {
    return 0;
  }
}

/**
 * One Live call. `tools` maps name -> async (args) => object; a throw becomes
 * {error: message}, an unknown name becomes {error: 'unknown_tool',
 * hint: 'app_outdated_refresh'} (a stale tool list means an old client), and
 * send_to_claude responses carry scheduling:'WHEN_IDLE' — except on an
 * extended-thinking model, which rejects response scheduling.
 * deps: {fetch, WebSocket, audio({onChunk,onLevel})->api, now, setTimeout,
 * clearTimeout} — every one injectable, fakes in tests.
 */
export function createLiveCall({ tokenUrl = '/voice/live-token', tools = {}, onState = null, onLevel = null, onEvent = null, onUserSpeech = null, onTranscript = null, onTurnComplete = null, replacementNote = null, deps = {} } = {}) {
  const d = {
    fetch: (url, init) => globalThis.fetch(url, init),
    WebSocket: globalThis.WebSocket,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    now: () => Date.now(),
    audio: ({ onChunk, onLevel: level }) =>
      createLiveAudio({
        AudioContext: globalThis.AudioContext,
        getUserMedia: (constraints) => globalThis.navigator?.mediaDevices?.getUserMedia(constraints),
        onChunk,
        onLevel: level,
      }),
    ...deps,
  };

  let state = 'ended';
  let stopped = true;
  let setupDone = false;
  let micStarted = false;
  let muted = false;
  let muteEndSent = false;
  let muteSilenceTimer = null;
  let muteHadOpenTurn = false;
  let modelTurnActive = false;
  let resumptionHandle = null;
  let attempts = 0;
  let ws = null;
  let audio = null;
  let reconnectTimer = null;
  let setupTimer = null;
  let dropTimes = []; // d.now() of live sessions that died, pruned to DROP_WINDOW_MS
  let freshSession = true; // the current socket was set up without a handle
  let everLive = false; // a session reached setupComplete in this call
  let lastContext = null; // last pushContext briefing, re-sent on a fresh reconnect
  let ordersNoteDue = false; // WO-3: a dropped send_to_claude result still has to be told
  let silentTimer = null;
  let ownerWords = ''; // owner transcription since the model last produced output
  let pendingOwnerWords = null; // carried into the session that replaces a silent one
  let drainTimer = null;
  let startPromise = null;
  let startResolve = null;
  let startReject = null;
  let startSettled = true;
  const textQueue = [];
  let lastOwnerSpeechAt = -Infinity;
  let awaitingReplySince = null;
  const contextQueue = []; // WO-VL-CTX: turnComplete:false briefings, flushed at setupComplete
  const cancelledToolIds = new Set();
  // Extended-thinking models: turnComplete no longer means idle; the server's
  // interactionStatus (IN_PROGRESS | IDLE) does. null = never reported.
  let serverStatus = null;
  let liveModel = '';

  function setState(next) {
    if (state === next) return;
    state = next;
    if (typeof onState === 'function') onState(next);
  }

  // Call transcript (owner ruling 2026-10-07): every spoken fragment, tool
  // call/result, briefing and update goes to onTranscript(role, text).
  function note(role, text) {
    if (typeof onTranscript !== 'function' || !text) return;
    try {
      onTranscript(role, String(text));
    } catch {
      // a transcript failure must never break the call
    }
  }

  function emitEvent(name, n) {
    if (typeof onEvent === 'function') onEvent(name, n);
  }

  function wsOpen() {
    return !!ws && ws.readyState === 1;
  }

  function send(obj) {
    if (wsOpen()) ws.send(JSON.stringify(obj));
  }

  // WO-3: only to `sock`, and only while it is still the call's open socket.
  function sendOn(sock, obj) {
    if (!sock || ws !== sock || sock.readyState !== 1) return false;
    sock.send(JSON.stringify(obj));
    return true;
  }

  // WO-3: the add-on's list of orders this call already relayed ('' = none).
  function ordersText() {
    if (typeof replacementNote !== 'function') return '';
    try {
      const text = replacementNote();
      return typeof text === 'string' ? text : '';
    } catch {
      return '';
    }
  }

  // WO-3: the session that asked for a send_to_claude is gone — tell the
  // current one what was relayed (now when live, else at its setupComplete).
  function briefOrdersNow() {
    if (stopped) return;
    if (setupDone && wsOpen()) {
      const orders = ordersText();
      if (orders) sendContext(orders);
      ordersNoteDue = false;
    } else {
      ordersNoteDue = true;
    }
  }

  function resolveStart() {
    if (!startSettled) {
      startSettled = true;
      startResolve();
    }
  }

  function rejectStart(error) {
    if (!startSettled) {
      startSettled = true;
      startReject(error);
    }
  }

  async function fetchToken() {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = d.setTimeout(() => reject(new Error('live token fetch timed out')), TOKEN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        (async () => {
          const resp = await d.fetch(tokenUrl, { method: 'POST', credentials: 'include' });
          if (!resp || !resp.ok) throw new Error(`live token fetch failed (${resp ? resp.status : 'no response'})`);
          return resp.json();
        })(),
        timeout,
      ]);
    } finally {
      d.clearTimeout(timer);
    }
  }

  function clearSetupTimer() {
    if (setupTimer) d.clearTimeout(setupTimer);
    setupTimer = null;
  }

  function connect(auth) {
    const sock = new d.WebSocket(`${auth.wsUrl}?access_token=${encodeURIComponent(auth.token)}`);
    ws = sock;
    serverStatus = null; // a new socket reports its own interactionStatus
    liveModel = String(auth.model || '');
    freshSession = !resumptionHandle;
    clearSetupTimer();
    setupTimer = d.setTimeout(() => {
      setupTimer = null;
      if (ws !== sock || stopped) return;
      ws = null; // the close event of this socket must not count twice
      try {
        sock.close();
      } catch {
        // already closed
      }
      onSocketClosed(SETUP_TIMEOUT_CODE);
    }, SETUP_TIMEOUT_MS);
    sock.onopen = () => {
      if (ws !== sock) return;
      send({
        setup: {
          model: `models/${auth.model}`,
          sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
        },
      });
    };
    sock.onmessage = (event) => {
      if (ws !== sock) return;
      void handleFrame(event.data, sock).catch(() => {});
    };
    sock.onclose = (event) => {
      if (ws !== sock) return;
      ws = null;
      onSocketClosed(Number(event && event.code) || 0);
    };
    sock.onerror = () => {
      // the close event that follows drives reconnect logic
    };
  }

  async function frameToText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (data && typeof data.arrayBuffer === 'function') {
      return new TextDecoder().decode(await data.arrayBuffer());
    }
    if (data && data.buffer instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return '';
  }

  async function handleFrame(data, sock = ws) {
    let msg = null;
    try {
      msg = JSON.parse(await frameToText(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const status = msg.interactionStatus || (msg.serverContent && msg.serverContent.interactionStatus);
    if (status === 'IN_PROGRESS' || status === 'IDLE') {
      serverStatus = status;
      if (status === 'IDLE') scheduleDrain();
    }
    if (msg.setupComplete) return onSetupComplete();
    if (msg.goAway) return onGoAway();
    if (msg.sessionResumptionUpdate) {
      const update = msg.sessionResumptionUpdate;
      if (update.newHandle && update.resumable !== false) resumptionHandle = update.newHandle;
      return;
    }
    if (msg.serverContent) return onServerContent(msg.serverContent);
    if (msg.toolCall) return void onToolCall(msg.toolCall, sock);
    if (msg.toolCallCancellation) {
      for (const id of msg.toolCallCancellation.ids || []) cancelledToolIds.add(id);
      return;
    }
  }

  function onSocketClosed(code) {
    clearSetupTimer();
    clearSilentWatchdog();
    const wasLive = setupDone;
    setupDone = false;
    modelTurnActive = false;
    awaitingReplySince = null; // a reply the closed socket owed never comes
    if (stopped) return;
    emitEvent('live-drop', code);
    note('event', `live-drop ${code}`);
    if (wasLive) {
      const now = d.now();
      dropTimes = dropTimes.filter((t) => now - t < DROP_WINDOW_MS);
      dropTimes.push(now);
      if (dropTimes.length >= MAX_DROPS) return giveUp();
    }
    // A resumed context can stay broken after a server 1011, so a 1011 or a
    // second failure in a row starts a fresh session instead.
    if (code === 1011 || dropTimes.length >= 2 || (!wasLive && attempts >= 1)) resumptionHandle = null;
    // F1: a pre-setup close schedules a reconnect; start() rejects only when
    // the attempts are exhausted (scheduleReconnect) or stop() is called.
    scheduleReconnect();
  }

  function giveUp() {
    if (reconnectTimer) d.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    resumptionHandle = null;
    setState('unavailable');
    emitEvent('live-error', dropTimes.length);
    rejectStart(new Error('live sessions keep dropping'));
  }

  function onSetupComplete() {
    clearSetupTimer();
    // A fresh session after a drop has no memory of the call: brief it again,
    // with the orders this call already relayed (WO-3: never sent twice).
    if (freshSession && everLive) {
      const parts = [];
      if (lastContext && !contextQueue.includes(lastContext)) parts.push(lastContext);
      const orders = ordersText();
      if (orders) parts.push(orders);
      if (parts.length) contextQueue.unshift(parts.join('\n\n'));
      ordersNoteDue = false;
    } else if (ordersNoteDue) {
      // a resumed session never got the result of a tool its old socket asked for
      const orders = ordersText();
      if (orders) contextQueue.push(orders);
      ordersNoteDue = false;
    }
    everLive = true;
    setupDone = true;
    attempts = 0;
    setState(modelTurnActive ? 'speaking' : 'listening');
    emitEvent('live-open', 1);
    while (contextQueue.length && wsOpen()) sendContext(contextQueue.shift());
    if (pendingOwnerWords && wsOpen()) {
      const words = pendingOwnerWords.replace(/["\u201c\u201d]/g, '');
      sendClientContent(`[APP] The previous connection dropped before you answered. The owner just said: "${words}" — answer them now.`);
      ownerWords = pendingOwnerWords; // still unanswered: a silent replacement carries them on
      pendingOwnerWords = null;
      armSilentWatchdog(); // this turn stands in for the rescue — a silent replacement is dead too
    }
    if (muted) armMuteSilence(); // muted across (re)connect: fresh silence tail on the new stream
    if (textQueue.length) scheduleDrain();
    resolveStart();
  }

  function onServerContent(content) {
    if (content.inputTranscription && typeof content.inputTranscription.text === 'string') {
      note('owner', content.inputTranscription.text);
      ownerWords = (ownerWords + content.inputTranscription.text).slice(-OWNER_WORDS_MAX);
    }
    if (content.outputTranscription && typeof content.outputTranscription.text === 'string') note('gemini', content.outputTranscription.text);
    const parts0 = content.modelTurn && Array.isArray(content.modelTurn.parts) ? content.modelTurn.parts : null;
    if ((parts0 && parts0.length) || (content.outputTranscription && content.outputTranscription.text)) modelAnswered();
    // F8: owner speech signal — non-empty transcription text re-arms tool calls.
    const spoken =
      content.inputTranscription && typeof content.inputTranscription.text === 'string'
        ? content.inputTranscription.text.trim()
        : '';
    if (spoken) {
      lastOwnerSpeechAt = d.now();
      rescueUsed = false;
      clearReplyRescue();
      if (!modelTurnActive) {
        ownerTurnOpen = true;
        armTurnNudge();
      }
    }
    if (spoken && typeof onUserSpeech === 'function') {
      try {
        onUserSpeech(spoken, content.inputTranscription.text); // raw keeps fragment spacing
      } catch {
        // listener failure must never break the frame feed
      }
    }
    const parts = content.modelTurn && Array.isArray(content.modelTurn.parts) ? content.modelTurn.parts : null;
    if (parts && parts.length) {
      modelTurnActive = true;
      awaitingReplySince = null;
      ownerTurnOpen = false;
      muteHadOpenTurn = false; // wave-1 review: answered during the silence tail — no rescue after it
      clearReplyRescue();
      setState('speaking');
      for (const part of parts) {
        const data = part && part.inlineData && part.inlineData.data;
        if (typeof data === 'string' && data) {
          turnSpoke = true; // onTurnComplete: model audio arrived this turn
          if (replyAudioStartedAt === null) replyAudioStartedAt = d.now(); // R7: grace anchor
        }
        if (typeof data === 'string' && data && audio && !dropReply) audio.play(data); // barge-in: the rest of a cut reply is dropped
      }
    }
    if (content.interrupted) {
      emitEvent('interrupted', 1); // barge-in (or echo) cut the reply — diagnosable in the journal
      note('event', 'interrupted');
      clearReplyRescue(); // the owner is talking — no 'answer now' nudge over them
      if (audio) audio.flush();
      modelTurnActive = false;
      awaitingReplySince = null;
      dropReply = false;
      ownerTurnOpen = false;
      replyAudioStartedAt = null; // R7: the next reply gets a fresh grace window
      reportVoicePeak();
      setState('listening');
      scheduleDrain();
    }
    if (content.turnComplete) {
      modelTurnActive = false;
      awaitingReplySince = null;
      dropReply = false;
      ownerTurnOpen = false;
      replyAudioStartedAt = null; // R7: the next reply gets a fresh grace window
      reportVoicePeak();
      fireTurnComplete();
      scheduleDrain();
    }
  }

  // WO-VP-WORDS R3 (owner 2026-10-07, hang-up during a send): tool fns
  // currently awaiting. pendingTools() counts them; toolsSettled() resolves
  // when the count reaches 0 (at once when 0), also after stop() — the result
  // is still noted, only its send is a no-op.
  let pendingToolsCount = 0;
  const toolSettleWaiters = [];

  function toolAwaitingStart() {
    pendingToolsCount += 1;
  }

  function toolAwaitingDone() {
    pendingToolsCount = Math.max(0, pendingToolsCount - 1);
    if (pendingToolsCount === 0) {
      const waiters = toolSettleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  function toolsSettled() {
    if (pendingToolsCount === 0) return Promise.resolve();
    return new Promise((resolve) => toolSettleWaiters.push(resolve));
  }

  async function onToolCall(toolCall, sock = ws) {
    ownerTurnOpen = false; // the model is answering
    modelAnswered();
    const calls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    emitEvent('tool-call', calls.length);
    const responses = [];
    for (const call of calls) {
      const id = call && call.id;
      const name = call && call.name;
      const args = (call && call.args) || {};
      note('tool-call', `${name} ${JSON.stringify(args)}`);
      let response;
      const fn = tools ? tools[name] : null;
      if (typeof fn !== 'function') {
        response = { error: 'unknown_tool', hint: 'app_outdated_refresh' }; // stale tool list = old client
      } else {
        toolAwaitingStart(); // R3: this call's fn is in flight
        try {
          response = { result: await fn(args) };
        } catch (error) {
          response = { error: String(error?.message || error) };
        } finally {
          toolAwaitingDone(); // R3: settles even after stop() — the result below is still noted
        }
      }
      if (name === 'send_to_claude' && !liveModel.includes('extended-thinking')) response.scheduling = 'WHEN_IDLE';
      note('tool-result', `${name} ${JSON.stringify(response)}`);
      if (!cancelledToolIds.delete(id)) responses.push({ id, name, response });
    }
    if (responses.length) {
      // WO-3: a toolResponse goes only to the socket that started the tool; a
      // replacement session never gets an answer to a call it did not make.
      if (sendOn(sock, { toolResponse: { functionResponses: responses } })) armReplyRescue();
      else {
        note('event', 'tool-response-dropped');
        if (responses.some((item) => item.name === 'send_to_claude')) briefOrdersNow();
      }
    }
  }

  function isModelBusy() {
    return modelTurnActive || serverStatus === 'IN_PROGRESS' || !!(audio && audio.isPlaying());
  }

  function sendClientContent(text) {
    awaitingReplySince = d.now();
    note('update', text);
    send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  // WO-VL-CTX: a silent briefing (session context) — same shape as
  // sendClientContent but turnComplete:false so the model never replies to it.
  function sendContext(text) {
    note('context', text);
    send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false } });
  }

  function scheduleDrain() {
    if (drainTimer || stopped) return;
    drainTimer = d.setTimeout(drainCheck, DRAIN_POLL_MS);
  }

  function drainCheck() {
    drainTimer = null;
    if (stopped) return;
    if (isModelBusy()) {
      if (audio && audio.isPlaying()) lastPlaybackAt = d.now();
      if (serverStatus === 'IN_PROGRESS' && !modelTurnActive && !(audio && audio.isPlaying())) {
        // Background reasoning: the IDLE status message re-arms the drain.
        if (state === 'speaking') setState('listening');
        return;
      }
      drainTimer = d.setTimeout(drainCheck, DRAIN_POLL_MS);
      return;
    }
    if (!wsOpen()) return;
    if (state === 'speaking') setState('listening');
    if (!textQueue.length) return;
    if (updatesMustWait()) {
      drainTimer = d.setTimeout(drainCheck, DRAIN_POLL_MS);
      return;
    }
    // Everything that piled up goes out as ONE turn, in order (owner ruling).
    sendClientContent(textQueue.splice(0).join('\n\n'));
  }

  function updatesMustWait() {
    const now = d.now();
    if (awaitingReplySince !== null && now - awaitingReplySince < REPLY_WAIT_MS) return true;
    return now - lastOwnerSpeechAt < UPDATE_QUIET_MS || now - lastPlaybackAt < UPDATE_QUIET_MS;
  }

  function reconnectNow() {
    reconnectTimer = null;
    if (stopped) return;
    (async () => {
      try {
        const auth = await fetchToken();
        if (stopped) return;
        connect(auth);
      } catch {
        scheduleReconnect();
      }
    })();
  }

  function scheduleReconnect() {
    if (stopped) return;
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
      setState('unavailable');
      emitEvent('live-error', attempts);
      rejectStart(new Error('reconnect attempts exhausted'));
      return;
    }
    setState('reconnecting');
    emitEvent('reconnect', attempts);
    const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    reconnectTimer = d.setTimeout(reconnectNow, delay);
  }

  function onGoAway() {
    if (stopped) return;
    attempts = 0;
    setState('reconnecting');
    emitEvent('reconnect', 1);
    clearSetupTimer();
    const sock = ws;
    ws = null; // the old socket's close event must not trigger the drop path
    try {
      if (sock) sock.close();
    } catch {
      // server already closed it
    }
    reconnectNow();
  }

  let lastPlaybackAt = -Infinity;
  let dropReply = false;
  let replyAudioStartedAt = null; // R7: grace anchor — first audio chunk of the current model turn
  let ownerTurnOpen = false;
  let nudgeTimer = null;

  function armTurnNudge() {
    if (nudgeTimer) d.clearTimeout(nudgeTimer);
    nudgeTimer = d.setTimeout(nudgeTurnEnd, TURN_END_NUDGE_MS);
  }

  function nudgeTurnEnd() {
    nudgeTimer = null;
    if (stopped || !ownerTurnOpen || modelTurnActive || !wsOpen()) return;
    ownerTurnOpen = false;
    send({ realtimeInput: { audioStreamEnd: true } }); // the next mic chunk reopens the stream
    emitEvent('turn-nudge', 1);
    note('event', 'turn-nudge');
    armReplyRescue();
  }

  // Owner 2026-10-07 (mute bug): after speaking, the owner muted the room
  // noise and Jimmy kept "listening" forever. Mute streams silence for
  // MUTE_SILENCE_MS (the server VAD then closes the owner's turn), ends the
  // audio stream exactly once, and afterwards nothing audio goes up until
  // unmute. If the owner's turn was still open at mute time, the reply rescue
  // still asks for an answer after the tail.
  function armMuteSilence() {
    if (muteSilenceTimer) d.clearTimeout(muteSilenceTimer);
    muteSilenceTimer = null;
    muteEndSent = false;
    // F6: no audioStreamEnd frame before setupComplete — the server has no
    // audio stream to end yet; onSetupComplete arms the tail instead.
    if (stopped || !setupDone || !wsOpen()) return;
    muteSilenceTimer = d.setTimeout(endMuteSilence, MUTE_SILENCE_MS);
  }

  function endMuteSilence() {
    muteSilenceTimer = null;
    if (stopped || !muted || !setupDone || !wsOpen()) return;
    muteEndSent = true;
    send({ realtimeInput: { audioStreamEnd: true } });
    if (muteHadOpenTurn) {
      muteHadOpenTurn = false;
      armReplyRescue(); // the muted owner still gets their answer
    }
  }

  // Cached all-zero PCM chunk with the exact decoded length of the incoming
  // chunk: base64 of zero bytes is 'A's with the same '=' padding, so the
  // server keeps seeing the same chunk cadence — just silent.
  const silenceCache = new Map();
  function silenceFor(data) {
    if (typeof data !== 'string' || !data) return data;
    let silence = silenceCache.get(data.length);
    if (!silence) {
      const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      silence = `${'A'.repeat(data.length - pad)}${'='.repeat(pad)}`;
      if (silenceCache.size >= 8) silenceCache.clear(); // mic chunks share one length; bound anyway
      silenceCache.set(data.length, silence);
    }
    return silence;
  }

  let turnSpoke = false;

  // onTurnComplete (WO-VP-LIVE): reports {spoke} on every serverContent
  // .turnComplete — spoke = model audio arrived during that turn (false =
  // silent turn, e.g. the muted-room case). A listener throw must never
  // break the call.
  function fireTurnComplete() {
    const spoke = turnSpoke;
    turnSpoke = false;
    if (typeof onTurnComplete !== 'function') return;
    try {
      onTurnComplete({ spoke });
    } catch {
      // listener failure must never break the frame feed
    }
  }

  let rescueTimer = null;
  let rescueUsed = false;

  function clearReplyRescue() {
    if (rescueTimer) d.clearTimeout(rescueTimer);
    rescueTimer = null;
  }

  function armReplyRescue() {
    if (rescueUsed || stopped) return;
    clearReplyRescue();
    rescueTimer = d.setTimeout(replyRescue, REPLY_RESCUE_MS);
  }

  function replyRescue() {
    rescueTimer = null;
    if (stopped || rescueUsed || isModelBusy() || !wsOpen()) return; // never over a reply still playing
    if (awaitingReplySince !== null) return; // a pushed turn is already waiting for its reply
    rescueUsed = true;
    note('event', 'reply-rescue');
    emitEvent('reply-rescue', 1);
    send({ clientContent: { turns: [{ role: 'user', parts: [{ text: REPLY_RESCUE_TEXT }] }], turnComplete: true } });
    armSilentWatchdog();
  }

  function clearSilentWatchdog() {
    if (silentTimer) d.clearTimeout(silentTimer);
    silentTimer = null;
  }

  function modelAnswered() {
    clearSilentWatchdog();
    ownerWords = '';
  }

  function armSilentWatchdog() {
    clearSilentWatchdog();
    const sock = ws;
    silentTimer = d.setTimeout(() => {
      silentTimer = null;
      if (stopped || !sock || ws !== sock) return;
      note('event', 'silent-session');
      const words = ownerWords.trim();
      if (words) pendingOwnerWords = words;
      ownerWords = '';
      resumptionHandle = null; // the silent context is not resumed
      ws = null; // this socket's close event must not count twice
      try {
        sock.close();
      } catch {
        // already closed
      }
      onSocketClosed(SILENT_SESSION_CODE);
    }, SILENT_SESSION_MS);
  }
  let echoLevel = 0;
  let echoChunks = 0;
  let bargeWindow = []; // the last BARGE_WINDOW chunks while Gemini plays: { data, loud }
  let quietPeak = 0; // loudest post-grace chunk that did not barge (voice-peak beacon)

  function learnEcho(level) {
    echoLevel = echoChunks === 0 ? level : echoLevel * 0.8 + level * 0.2;
    echoChunks += 1;
  }

  // Tuning data for the owner's real phone (number only): once per reply.
  function reportVoicePeak() {
    if (quietPeak > 0) emitEvent('voice-peak', Math.round(1000 * quietPeak));
    quietPeak = 0;
  }

  function sendAudio(data) {
    send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
  }

  function sendMicChunk(data) {
    if (stopped || !setupDone || !wsOpen()) return;
    if (muted) {
      // Muted: never forward the room. Silence of the same length goes up
      // during the MUTE_SILENCE_MS tail (armMuteSilence ends it); after the
      // tail nothing at all. Echo/barge logic never runs while muted.
      if (!muteEndSent) sendAudio(silenceFor(data));
      return;
    }
    if (audio && audio.isPlaying()) {
      lastPlaybackAt = d.now();
      // Echo guard: nothing goes up while Gemini speaks — unless the owner
      // talks over it (barge-in). R7 grace: during the first BARGE_GRACE_MS of
      // this reply's playback every chunk feeds the echo EMA — never a barge.
      const level = pcmLevel(data);
      const inBargeGrace = replyAudioStartedAt !== null && d.now() - replyAudioStartedAt < BARGE_GRACE_MS;
      if (inBargeGrace || echoChunks < ECHO_WARMUP_CHUNKS) {
        learnEcho(level);
        bargeWindow = [];
        return;
      }
      const loud = level >= Math.max(BARGE_MIN_LEVEL, echoLevel * BARGE_ECHO_FACTOR);
      if (!loud) {
        if (level <= echoLevel * ECHO_TRACK_FACTOR) learnEcho(level); // the owner's voice never raises it
        if (level > quietPeak) quietPeak = level;
      }
      bargeWindow.push({ data, loud });
      if (bargeWindow.length > BARGE_WINDOW) bargeWindow.shift();
      if (bargeWindow.filter((chunk) => chunk.loud).length >= BARGE_LOUD) bargeIn();
      return;
    }
    bargeWindow = [];
    if (d.now() - lastPlaybackAt < ECHO_TAIL_MS) return; // speaker/room tail
    sendAudio(data);
  }

  function bargeIn() {
    const first = Math.max(0, bargeWindow.findIndex((chunk) => chunk.loud));
    const held = bargeWindow.slice(first).map((chunk) => chunk.data); // from the first loud chunk, dips included
    bargeWindow = [];
    quietPeak = 0;
    // Only a reply still being generated is dropped; if the server already
    // finished it (playback lags), a stuck flag would mute the NEXT reply.
    dropReply = modelTurnActive;
    if (audio) audio.flush();
    lastPlaybackAt = -Infinity;
    // Tuning data for the owner's real phone: voice and echo levels (x1000).
    emitEvent('barge-in', Math.round(1000 * pcmLevel(held[held.length - 1] || '')));
    emitEvent('barge-echo', Math.round(1000 * echoLevel));
    note('event', 'barge-in');
    if (state === 'speaking') setState('listening');
    for (const chunk of held) sendAudio(chunk); // the owner's first words, not lost
  }

  function start() {
    if (startPromise) return startPromise;
    stopped = false;
    startSettled = false;
    setState('connecting');
    audio = d.audio({ onChunk: sendMicChunk, onLevel });
    if (muted && audio && typeof audio.setMuted === 'function') audio.setMuted(muted);
    startPromise = new Promise((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    if (!micStarted && audio) {
      // F3: start the mic inside the caller's user-gesture (click) task so the
      // AudioContext is created unlocked; chunks still only SEND after
      // setupComplete (sendMicChunk gate below).
      micStarted = true;
      const micFailed = () => {
        setState('error'); // F5: mic failure is a mic-error, never a live-error
        emitEvent('mic-error', 1);
      };
      try {
        Promise.resolve(audio.startMic()).catch(micFailed);
      } catch {
        micFailed();
      }
    }
    reconnectNow();
    return startPromise;
  }

  // Owner 2026-10-08: the call bar's retry button after a give-up — a fresh
  // session with a clean drop window; the mic kept running meanwhile.
  function retry() {
    if (stopped || state !== 'unavailable') return false;
    if (reconnectTimer) d.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    attempts = 0;
    dropTimes = [];
    resumptionHandle = null;
    pendingOwnerWords = null; // minutes may have passed: never replay them as "just said"
    ownerWords = '';
    setState('connecting');
    emitEvent('live-retry', 1);
    reconnectNow();
    return true;
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) d.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearSetupTimer();
    clearSilentWatchdog();
    if (drainTimer) d.clearTimeout(drainTimer);
    drainTimer = null;
    if (nudgeTimer) d.clearTimeout(nudgeTimer);
    nudgeTimer = null;
    if (muteSilenceTimer) d.clearTimeout(muteSilenceTimer);
    muteSilenceTimer = null;
    clearReplyRescue();
    const sock = ws;
    ws = null;
    try {
      if (sock) sock.close();
    } catch {
      // already closed
    }
    const engine = audio;
    audio = null;
    try {
      if (engine) engine.close();
    } catch {
      // engine already gone
    }
    setState('ended');
    emitEvent('live-close', 1);
    rejectStart(new Error('stopped before setupComplete'));
    // F7: reset so a restart on this instance behaves like a fresh call.
    startPromise = null;
    startSettled = true;
    micStarted = false;
    setupDone = false;
    attempts = 0;
    dropTimes = [];
    everLive = false;
    lastContext = null;
    ordersNoteDue = false;
    resumptionHandle = null;
    contextQueue.length = 0;
    ownerWords = '';
    pendingOwnerWords = null;
  }

  function mute(value) {
    const next = !!value;
    const changed = next !== muted;
    muted = next;
    bargeWindow = []; // review LOW: chunks from before a mute never count toward a barge after it
    if (audio && typeof audio.setMuted === 'function') audio.setMuted(muted);
    if (!changed) return; // idempotent: a repeated mute(true) restarts nothing
    emitEvent(muted ? 'mute' : 'unmute', 1);
    note('event', muted ? 'mute' : 'unmute');
    if (muted) {
      if (nudgeTimer) d.clearTimeout(nudgeTimer); // the mute tail ends the turn now, not the nudge
      nudgeTimer = null;
      muteHadOpenTurn = ownerTurnOpen; // answered by the reply rescue after the silence tail
      ownerTurnOpen = false;
      armMuteSilence();
    } else {
      muteHadOpenTurn = false;
      if (muteSilenceTimer) d.clearTimeout(muteSilenceTimer);
      muteSilenceTimer = null;
      muteEndSent = false; // a later mute ends the stream again
    }
  }

  // R7: the add-on calls this on the first tap after an auto-started call —
  // suspended AudioContexts (notably iOS Safari) resume for capture AND
  // playback. A missing engine method must never throw into the tap handler.
  function resumeAudio() {
    if (audio && typeof audio.resume === 'function') audio.resume();
  }

  return { start, stop, retry, mute, isMuted: () => muted, pushText, pushContext, isModelBusy, resumeAudio, pendingTools: () => pendingToolsCount, toolsSettled };

  function pushText(text) {
    const value = String(text ?? '');
    if (!value) return;
    if (setupDone && wsOpen() && !isModelBusy() && !textQueue.length && !updatesMustWait()) sendClientContent(value);
    else {
      textQueue.push(value);
      scheduleDrain();
    }
  }

  // WO-VL-CTX: silent context injection — sent immediately when the session is
  // up (regardless of model turn: it must not trigger a spoken reply), else
  // queued and flushed at the next setupComplete. Never uses the textQueue.
  function pushContext(text) {
    const value = String(text ?? '');
    if (!value) return;
    lastContext = value;
    if (setupDone && wsOpen()) sendContext(value);
    else contextQueue.push(value);
  }
}
