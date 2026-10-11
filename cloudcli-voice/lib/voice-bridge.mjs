// WO-VL-UI: Gemini Live tool bridge to the open Claude Code session.
// Pure: everything (progress log, run tracker, session lookup, send, abort,
// delay) is injected. Semantics (fixed in state/wo/WO-VL-UI-spec.md):
//   send_to_claude: no open session -> {error:'no_session_open'}; busy without
//   `when` -> {result:'ask_owner'} (the front end must ask the owner);
//   busy + when='now' -> abort() first, wait until the run ends (F2/WO-3),
//   then insert+send; busy + when='after' -> one queue slot, latest wins, flushed
//   when the run completes; otherwise insert+send -> {result:'sent'}.
//   stop_claude -> abort -> {result:'stopped'} only when the Stop frame was
//   sent; abort() === false -> {error:'stop_failed'} and the gate is handed back.
// F8 prompt-injection gate: send_to_claude and stop_claude return
//   {error:'no_user_turn'} unless the owner spoke (markUserTurn, fed by the
//   Live inputTranscription via onUserSpeech) since the last proactive push
//   AND since the previous successful send/stop.
// WO-VP-BRIDGE (2026-10-07): read_claude_message plan:true reads a pending
//   ExitPlanMode plan in spoken parts (R1/R2); status shows plan part 1 only
//   (R3) and reuses one snapshot per session for 1500 ms (R5); a plan pending
//   changes the busy-relay ruling (R4); answers bind the owner's words to
//   every choice (R7) and never fire against a question Jimmy was not shown
//   (R6); resumeAfterNoise re-hands a part cut by a false barge-in (R8);
//   an open on-screen approval holds the relay like a busy run (R9); the
//   status carries live background tasks and a this-session-only scope (R10).
// WO-VP-WORDS (owner 2026-10-07): the owner-words relay window starts at
//   Jimmy's last spoken turn (noteJimmySpoke, fed by onTurnComplete
//   spoke:true) — unless an ask_owner relay still waits for the owner's
//   now/after choice; read_claude_message only:true hands out one part with
//   no auto-continue (R2).
// Proactive updates: progress-log update events fire the onComplete sink
// ONLY while a call is active (isCallActive), so nothing is pushed to a Live
// session that does not exist. 'complete' also flushes the after-queue.
// Owner 2026-10-07: a call belongs to ONE session — getSession() returns the
// call's pinned session, updates from any other session are never pushed,
// and the after-queue flushes only on its own session's 'complete'.
// WO-3 (owner rulings R1/R2/R7, 2026-10-09):
//   - no session on screen -> send/stop/answer answer {error:'no_session_open'}
//     (voice never starts a session; the note tells Jimmy what to say);
//   - send/stop/answer and the after-queue flush run one at a time (mutex);
//     the F8 gate is consumed synchronously at entry, so a concurrent call
//     sees it closed (it is handed back only when nothing was done);
//   - an identical order to the same session within DEDUPE_MS -> already_sent;
//   - when='now': abort, then wait until the run tracker shows the session
//     inactive (max NOW_WAIT_MS, else {error:'still_running'}) before ONE send;
//     a session busy only with background work is not 'held' -> plain send,
//     which P10 pushes into the running process (no abort, no spawn);
//   - a successful send clears the after-queue; callEnded() drops it (R2);
//   - insertAndSend may answer {error} (composer_busy / still_running /
//     no_session_open) — passed through to Jimmy;
//   - ordersNote() lists the orders this call already relayed, for the
//     briefing of a replacement Gemini session (live-call replacementNote).

const NOW_POLL_MS = 100; // when='now': run-tracker poll step after the abort
const NOW_WAIT_MS = 5000; // when='now': max wait for the aborted run to end
const DEDUPE_MS = 120000; // identical order to the same session -> already_sent
const ORDERS_NOTE_MAX = 8; // newest orders listed for a replacement session
const ORDER_NOTE_CHARS = 300;
const NO_SESSION_NOTE = 'No Claude session is open on screen. Voice never starts a session: tell the owner to open the session first (pick it in the sidebar), then ask again.';
const QUEUED_COMPOSER_BUSY = '[APP] The voice message that was waiting for Claude to finish was NOT sent: the chat box holds text the owner typed. Tell the owner; it is sent only if they ask again.';
// F8 bounded the injection surface at 300; owner ruling 2026-10-07 (call
// transcript showed Gemini answering from one truncated line) raises it.
const STATUS_TEXT_MAX = 4000;

const SELF_ABORT_WINDOW_MS = 15000; // the aborted run's 'complete' lands well inside this
const OWNER_WORDS_MAX = 4000; // newest chars of owner speech kept for one relay
const QUEUED_SEND_FAILED = '[APP] The voice message that was waiting for Claude to finish could not be delivered. Ask the owner to say it again.';
const STOP_FAILED_NOTE = 'The Stop did NOT reach Claude (the connection to the app is down), so Claude is still running. Tell the owner it was not stopped; they can press Stop on screen or ask again.';
// WO-VP-BRIDGE R5: repeated status calls inside this window reuse one snapshot
// (+ history) for the same session; send/stop/answer invalidate it.
const STATUS_CACHE_MS = 1500;
// WO-VP-BRIDGE R4: what "now"/"after" mean while a plan waits on screen.
const PLAN_PENDING_NOTE = 'now = closes the plan on screen and the CEO revises it; after = once the owner approves on screen and the run finishes';
// WO-VP-BRIDGE R9: same style for a pending on-screen question/tool approval.
const QUESTION_PENDING_NOTE = 'now = dismisses the question on screen and the CEO continues; after = once the owner answers on screen and the run finishes';
// WO-VP-BRIDGE R10: how many background task names the status may carry.
const BACKGROUND_NAMES_MAX = 5;
const BACKGROUND_NAME_MAX = 80;

import { stripLine } from './session-history.mjs';

const PART_MAX = 700; // about one spoken Live turn of Masri

/** Splits a CEO message into spoken-size parts at paragraph, then sentence,
 *  then word boundaries; every part is at most PART_MAX characters. */
const ANSWER_CONFIRM_MS = 3000;
const ANSWER_POLL_MS = 250;

/** What Jimmy may see of a pending approval: question and plan text are
 *  redacted like the history; a plain tool shows only its name. A plan is
 *  never shown whole (R3): part 1 only, plus how many parts and the tool
 *  that reads the rest. */
function publicPending(pending) {
  if (!pending || typeof pending !== 'object') return null;
  const name = pending.toolName || 'tool';
  if (name === 'ExitPlanMode' || name === 'exit_plan_mode') {
    const parts = planPartsOf(pending.planText);
    if (!parts.length) return { toolName: name };
    return { toolName: name, planText: parts[0], planParts: parts.length, readWith: 'read_claude_message plan:true' };
  }
  if (name !== 'AskUserQuestion') return { toolName: name };
  return {
    toolName: name,
    questions: (Array.isArray(pending.questions) ? pending.questions : []).map((question) => ({
      question: stripLine(question.question),
      options: (Array.isArray(question.options) ? question.options : []).map((label) => stripLine(label)),
      multiSelect: question.multiSelect === true,
    })),
  };
}

export function splitParts(text, max = PART_MAX) {
  const units = String(text || '')
    .split(/\n+/)
    .flatMap((para) => para.match(/[^.!?؟\n]+[.!?؟]*\s*/g) || [])
    .map((unit) => unit.trim())
    .filter(Boolean);
  const parts = [];
  let current = '';
  const push = () => {
    if (current) parts.push(current);
    current = '';
  };
  for (let unit of units) {
    while (unit.length > max) {
      push();
      const cut = unit.lastIndexOf(' ', max) > max / 2 ? unit.lastIndexOf(' ', max) : max;
      parts.push(unit.slice(0, cut).trim());
      unit = unit.slice(cut).trim();
    }
    if (current && current.length + 1 + unit.length > max) push();
    current = current ? `${current} ${unit}` : unit;
  }
  push();
  return parts.length ? parts : [String(text || '')];
}

/** Spoken parts of a waiting plan (R1): each line is redacted on its own
 *  (stripLine collapses whitespace, so it would eat the line breaks), then
 *  the cleaned text is split at paragraph/sentence boundaries. */
function planPartsOf(planText) {
  const cleaned = String(planText || '')
    .split('\n')
    .map((line) => stripLine(line))
    .filter(Boolean)
    .join('\n');
  return cleaned ? splitParts(cleaned) : [];
}

export function createVoiceBridge({
  progressLog,
  runTracker,
  getSession,
  insertAndSend,
  abort,
  isCallActive = () => false,
  getHistory = null, // WO-VL-CTX: async (sessionId) => {lines,[text],claudeTexts} | null (throttled by the caller)
  sendPermissionResponse = null, // owner 2026-10-07: async (frame) => boolean — page WS send
  getBackgroundTasks = null, // R10: () => {running:number, names:string[]} | null — live, best-effort
  delay = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  // A stop the front end itself caused (when=now / stop_claude) is not news:
  // its 'The run was stopped.' complete is never pushed back (owner 2026-10-07).
  let selfAbortAt = -Infinity;
  let queued = null;
  let sink = () => {};
  // F8: set by every proactive push / successful send or stop / read. Starts
  // set (wave-1 security): nothing mutates before the owner's first words.
  let needUserTurn = true;
  // Owner ruling 2026-10-07: Claude gets the owner's OWN words (the Live
  // inputTranscription, Arabic as spoken), never Gemini's translation. Every
  // fragment since the last relay accumulates here; a send/queue consumes it.
  let ownerWords = '';
  // WO-VP-WORDS R1 (owner 2026-10-07): an ask_owner relay is waiting for the
  // owner's now/after choice — Jimmy's question in between must not cut the
  // request out of the relay window.
  let askOwnerOpen = false;
  // Jimmy's spoken turns while the choice is open: the question itself and at
  // most one more; after that the owner moved on and the window restarts.
  let askOwnerTurns = 0;
  const ASK_OWNER_HOLD_TURNS = 2;
  // Owner 2026-10-07 ("I kept saying كمّل"): Live ends its turn after about
  // one paragraph, so a long CEO message is explained in parts and the app
  // hands Jimmy the next part once he finishes one. Owner speech cancels it.
  // WO-VP-BRIDGE R1: a waiting ExitPlanMode plan is explained the same way
  // ({ sessionId, plan:true, parts, next } — no back).
  let explain = null; // { sessionId, back?, plan?, parts, next }
  // R5: one cached status per session, dropped by send/stop/answer.
  let statusCache = null; // { sessionId, at, value }
  // R6: the requestId Jimmy last saw in a status — an answer against a
  // different pending question is never sent.
  let lastShownRequestId = null;
  // WO-3: every open/close of the F8 gate bumps the epoch, so a gate handed
  // back after a no-op call never reopens one a push closed meanwhile.
  let gateEpoch = 0;
  // WO-3: send/stop/answer and the after-queue flush run one at a time.
  let locked = false;
  const lockWaiters = [];
  // WO-3: per session, normalized order text -> when it was sent (DEDUPE_MS).
  const recentSends = new Map();
  // WO-3: orders this call relayed (instruction text), for ordersNote().
  let callOrders = [];

  function markUserTurn(fragment) {
    needUserTurn = false;
    gateEpoch += 1;
    explain = null;
    if (typeof fragment === 'string' && fragment) ownerWords = (ownerWords + fragment).slice(-OWNER_WORDS_MAX);
  }

  /** WO-3: runs fn after every earlier send/stop/answer/flush finished; starts
   *  synchronously when nothing else runs. */
  function exclusive(fn) {
    const run = async () => {
      try {
        return await fn();
      } finally {
        const next = lockWaiters.shift();
        if (next) next();
        else locked = false;
      }
    };
    if (!locked) {
      locked = true;
      return run();
    }
    return new Promise((resolve, reject) => {
      lockWaiters.push(() => run().then(resolve, reject));
    });
  }

  /** WO-3: F8 gate taken synchronously — a token, or null when closed. */
  function takeGate() {
    if (needUserTurn) return null;
    consumeUserTurn();
    return gateEpoch;
  }

  /** Hands the owner's turn back after a call that did nothing (no send,
   *  queue, abort or answer) — unless anything touched the gate since. */
  function restoreGate(token) {
    if (token === null || token !== gateEpoch) return;
    needUserTurn = false;
    gateEpoch += 1;
  }

  function orderKey(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
  }

  /** When this exact order last went to this session (within DEDUPE_MS), else null. */
  function sentRecently(sessionId, key) {
    const seen = recentSends.get(sessionId);
    if (!seen) return null;
    const t = now();
    for (const [k, at] of seen) if (t - at >= DEDUPE_MS) seen.delete(k);
    return seen.has(key) ? { at: seen.get(key) } : null;
  }

  function noteSent(sessionId, key, text) {
    let seen = recentSends.get(sessionId);
    if (!seen) {
      seen = new Map();
      recentSends.set(sessionId, seen);
    }
    seen.delete(key);
    seen.set(key, now());
    callOrders.push(String(text ?? ''));
    if (callOrders.length > ORDERS_NOTE_MAX * 2) callOrders = callOrders.slice(-ORDERS_NOTE_MAX);
  }

  /** insertAndSend answers true, false or {error}; anything else failed. */
  function sendOutcome(value) {
    if (value === true) return { ok: true };
    if (value && typeof value === 'object' && typeof value.error === 'string' && value.error) return { ok: false, error: value.error };
    return { ok: false, error: 'send_failed' };
  }

  function noSessionOpen() {
    return { error: 'no_session_open', note: NO_SESSION_NOTE };
  }

  // WO-VP-WORDS R1 (owner 2026-10-07, "since Jimmy last spoke"): Jimmy finished
  // a SPOKEN turn — the owner-words window restarts here, so a relay carries
  // only what the owner said around the current request. UNLESS a relay is
  // waiting for the owner's now/after choice (ask_owner): the request that
  // made Jimmy ask stays bound to the answer that follows.
  function noteJimmySpoke() {
    if (askOwnerOpen) {
      askOwnerTurns += 1;
      if (askOwnerTurns <= ASK_OWNER_HOLD_TURNS) return;
      askOwnerOpen = false; // the owner never answered now/after — dropped
    }
    ownerWords = '';
  }

  /** The text Claude receives: the front end's improved Arabic prompt plus,
   *  when transcribed, the owner's exact words since the last relay — so a
   *  dropped part is always recoverable (owner 2026-10-07). */
  function relayText(instruction) {
    const words = ownerWords.replace(/\s+/g, ' ').trim();
    return words ? `${instruction}\n\n[owner's exact words, auto-transcribed] ${words}` : instruction;
  }

  function consumeUserTurn() {
    needUserTurn = true;
    gateEpoch += 1;
  }

  function gate() {
    return needUserTurn ? { error: 'no_user_turn' } : null;
  }

  function sessionBusy(sessionId) {
    return Boolean(sessionId) && Boolean(runTracker) && runTracker.isActive(sessionId);
  }

  /** R9: the pending on-screen approval (plan, question or tool), if any. */
  function openPending(sessionId) {
    if (!progressLog || !sessionId) return null;
    const pending = progressLog.snapshot(sessionId).pendingQuestion;
    return pending && typeof pending === 'object' ? pending : null;
  }

  /** R4: an ExitPlanMode plan is waiting for the owner on screen. */
  function isPlanPending(pending) {
    return Boolean(pending) && (pending.toolName === 'ExitPlanMode' || pending.toolName === 'exit_plan_mode');
  }

  function flushQueue() {
    if (!queued) return;
    if (!isCallActive()) {
      queued = null; // R2 (owner 2026-10-09): an 'after' order never outlives the call
      return;
    }
    if (sessionBusy(queued.sessionId)) return; // a new run started — keep waiting
    void exclusive(async () => {
      const item = queued; // re-read: a send while waiting for the lock may have cleared it
      if (!item) return;
      if (!isCallActive()) {
        queued = null;
        return;
      }
      if (sessionBusy(item.sessionId)) return;
      queued = null;
      if (sentRecently(item.sessionId, item.key)) return; // the same order already went out
      // Owner 2026-10-07: Jimmy already said it was queued — a failed delivery
      // must be told, never dropped silently.
      const failed = (error) => {
        if (!isCallActive()) return;
        try {
          sink({ type: 'app', text: error === 'composer_busy' ? QUEUED_COMPOSER_BUSY : QUEUED_SEND_FAILED, sessionId: item.sessionId });
        } catch {
          // sink failure must never break the frame feed
        }
      };
      let outcome;
      try {
        outcome = sendOutcome(await insertAndSend(item.instruction, item.sessionId));
      } catch {
        outcome = { ok: false, error: 'send_failed' };
      }
      if (outcome.ok) noteSent(item.sessionId, item.key, item.text);
      else failed(outcome.error);
    }).catch(() => {});
  }

  if (progressLog && typeof progressLog.onUpdate === 'function') {
    progressLog.onUpdate((update) => {
      if (!update || typeof update !== 'object') return;
      const updateSession = update.sessionId ?? null;
      if (update.type === 'complete' && queued && updateSession === queued.sessionId) flushQueue();
      const selfStop = update.type === 'complete' && update.text === 'The run was stopped.' && now() - selfAbortAt < SELF_ABORT_WINDOW_MS;
      const callSession = typeof getSession === 'function' ? getSession() : null;
      // Another session's news never reaches this call (owner 2026-10-07).
      const ownSession = Boolean(callSession) && updateSession === callSession;
      if (isCallActive() && !selfStop && ownSession) {
        consumeUserTurn(); // F8: a proactive push goes out now — tool calls need fresh owner speech
        try {
          sink({ type: update.type, text: update.text, sessionId: update.sessionId ?? null });
        } catch {
          // sink failure must never break the frame feed
        }
      }
    });
  }

  return {
    tools: {
      get_claude_status: async () => {
        const sessionId = typeof getSession === 'function' ? getSession() : null;
        const busy = sessionBusy(sessionId); // live truth — never cached (R5)
        // R5: repeated calls inside the window reuse one snapshot + history
        // for the same session; send/stop/answer drop the cache.
        if (!(statusCache && statusCache.sessionId === sessionId && now() - statusCache.at <= STATUS_CACHE_MS)) {
          const snapshot = progressLog ? progressLog.snapshot(sessionId) : null;
          const pending = snapshot ? snapshot.pendingQuestion : null;
          // R6: remember which pending question Jimmy was shown.
          lastShownRequestId = pending && pending.requestId ? pending.requestId : null;
          const capped = snapshot
            ? { ...snapshot, lastAssistantText: stripLine(String(snapshot.lastAssistantText || '')).slice(0, STATUS_TEXT_MAX) }
            : null;
          if (capped) capped.pendingQuestion = publicPending(capped.pendingQuestion);
          const base = { ...(capped || {}) };
          // WO-VL-CTX: history is best-effort — a failure never breaks the status.
          // F8 intact: fetching history is a READ; it never counts as a user turn.
          if (sessionId && typeof getHistory === 'function') {
            try {
              const history = await getHistory(sessionId);
              if (history && Array.isArray(history.lines)) base.history = history.lines;
            } catch {
              // history fetch failed — status without it
            }
          }
          statusCache = { sessionId, at: now(), value: base };
        }
        const status = { ...statusCache.value, busy, sessionOpen: Boolean(sessionId), scope: 'this session only' };
        // R10: background tasks are live like busy — never cached — and
        // best-effort: a failure never breaks the status.
        if (typeof getBackgroundTasks === 'function') {
          try {
            const tasks = getBackgroundTasks();
            if (tasks && typeof tasks === 'object') {
              status.backgroundTasks = {
                running: Number(tasks.running) || 0,
                names: (Array.isArray(tasks.names) ? tasks.names : [])
                  .slice(0, BACKGROUND_NAMES_MAX)
                  .map((name) => stripLine(String(name ?? '')).slice(0, BACKGROUND_NAME_MAX)),
              };
            }
          } catch {
            // background tasks unavailable — status without them
          }
        }
        // The run tracker is the truth for busy; a 'working' left over in the
        // log after the run ended must not be reported (owner 2026-10-07).
        if (!busy && status.state === 'working') status.state = 'idle';
        return status;
      },

      send_to_claude: async ({ instruction, when } = {}) => {
        statusCache = null; // R5: an action was attempted — the status is stale
        // F8 + WO-3: the gate is checked first and consumed synchronously —
        // a concurrent duplicate call finds it closed (no_user_turn).
        const token = takeGate();
        if (token === null) return gate(); // a blocked call leaves an open ask_owner hold alone
        askOwnerOpen = false; // R1: this call ends any earlier ask_owner exchange
        const text = typeof instruction === 'string' ? instruction.trim() : '';
        if (!text) {
          restoreGate(token);
          return { error: 'no_instruction' };
        }
        const sessionId = typeof getSession === 'function' ? getSession() : null;
        if (!sessionId) {
          restoreGate(token);
          return noSessionOpen(); // R1: voice never starts a session
        }
        return exclusive(async () => {
          // The screen may have changed while an earlier action held the lock.
          if ((typeof getSession === 'function' ? getSession() : null) !== sessionId) {
            restoreGate(token);
            return noSessionOpen();
          }
          const key = orderKey(text);
          const recent = sentRecently(sessionId, key);
          if (recent) {
            ownerWords = ''; // the owner's words were about an order Claude already has
            return { result: 'already_sent', secondsAgo: Math.max(0, Math.round((now() - recent.at) / 1000)) };
          }
          const busy = sessionBusy(sessionId);
          // R9: an open on-screen approval (plan, question or plain tool) holds
          // the relay exactly like a busy run — a send would close it.
          const pending = openPending(sessionId);
          const held = busy || Boolean(pending);
          const planPendingNow = isPlanPending(pending); // R4
          if (held && when !== 'now' && when !== 'after') {
            // R4/R9 owner ruling: with something waiting on screen, the owner
            // must know what now/after would do to it before choosing.
            askOwnerOpen = true; // R1: the now/after choice is open across Jimmy's question
            askOwnerTurns = 0;
            // wave-1 security: the gate stays consumed — only the owner's spoken now/after answer may send
            if (planPendingNow) return { result: 'ask_owner', planPending: true, note: PLAN_PENDING_NOTE };
            if (pending) return { result: 'ask_owner', questionPending: true, note: QUESTION_PENDING_NOTE };
            return { result: 'ask_owner' };
          }
          if (held && when === 'after') {
            queued = { instruction: relayText(text), sessionId, key, text }; // one slot — latest wins
            ownerWords = '';
            askOwnerOpen = false; // R1: the queue consumed the words — the exchange is closed
            return planPendingNow ? { result: 'queued', planPending: true } : { result: 'queued' };
          }
          const interrupted = held && when === 'now';
          if (interrupted) {
            selfAbortAt = now();
            if (typeof abort === 'function') abort(); // F2: interrupt the run (and its approval) first
            // WO-3: never submit into a run that is still streaming (the
            // composer would queue it -> a second copy later): wait until the
            // run tracker shows the session inactive.
            let waited = 0;
            do {
              await delay(NOW_POLL_MS);
              waited += NOW_POLL_MS;
            } while (sessionBusy(sessionId) && waited < NOW_WAIT_MS);
            if (sessionBusy(sessionId)) return { error: 'still_running' }; // the abort was an action: gate stays consumed
          }
          const outcome = sendOutcome(await insertAndSend(relayText(text), sessionId));
          if (!outcome.ok) {
            if (!interrupted) restoreGate(token); // nothing reached Claude
            return { error: outcome.error };
          }
          ownerWords = '';
          askOwnerOpen = false; // R1: the relay consumed the words — the exchange is closed
          noteSent(sessionId, key, text);
          // WO-3: a successful send clears the after-queue (it never goes as a second copy).
          const queuedDropped = Boolean(queued) && queued.key !== key;
          queued = null;
          const result = planPendingNow ? { result: 'sent', planPending: true } : { result: 'sent' };
          if (queuedDropped) result.queuedDropped = true;
          return result;
        });
      },

      stop_claude: async () => {
        statusCache = null; // R5: an action was attempted — the status is stale
        const token = takeGate(); // F8: injected pushes must not stop runs either
        if (token === null) return gate();
        const sessionId = typeof getSession === 'function' ? getSession() : null;
        if (!sessionId) {
          restoreGate(token);
          return noSessionOpen();
        }
        return exclusive(async () => {
          // The screen may have changed while an earlier action held the lock.
          if ((typeof getSession === 'function' ? getSession() : null) !== sessionId) {
            restoreGate(token);
            return noSessionOpen();
          }
          // D4: report the real outcome. abort() answers false when the Stop
          // frame could not be sent (no call session, socket closed); then
          // nothing reached Claude, so the gate is handed back.
          const previousSelfAbortAt = selfAbortAt;
          selfAbortAt = now();
          const delivered = typeof abort === 'function' ? abort() : false;
          if (delivered === false) {
            selfAbortAt = previousSelfAbortAt;
            restoreGate(token);
            return { error: 'stop_failed', note: STOP_FAILED_NOTE };
          }
          return { result: 'stopped' }; // F8: one owner utterance powers one stop
        });
      },

      /** Owner 2026-10-07: the Nth-newest claude message of the pinned
       *  session, in full. READ-ONLY: no owner-turn gate (like history).
       *  WO-VP-BRIDGE R1: plan:true reads the pending ExitPlanMode plan in
       *  parts instead — `back` is not needed on that path.
       *  WO-VP-WORDS R2: only:true ("اقرا الجزء الأول بس") returns that one
       *  part and never arms the automatic continue. */
      read_claude_message: async ({ back, part, plan, only: onlyArg } = {}) => {
        const only = onlyArg === true; // locked schema: boolean
        const sessionId = typeof getSession === 'function' ? getSession() : null;
        if (!sessionId) return { error: 'no_session' };
        if (plan) {
          const pending = progressLog ? progressLog.snapshot(sessionId).pendingQuestion : null;
          const name = pending ? pending.toolName : null;
          if (!pending || (name !== 'ExitPlanMode' && name !== 'exit_plan_mode')) return { error: 'no_plan' };
          const parts = planPartsOf(pending.planText);
          if (!parts.length) return { error: 'no_plan' };
          const k = Math.min(Math.max(Number.parseInt(part, 10) || 1, 1), parts.length);
          explain = !only && k < parts.length ? { sessionId, plan: true, parts, next: k + 1 } : null; // R2: only:true never auto-continues
          consumeUserTurn(); // wave-1 security: read text is data — a send needs fresh owner words
          if (only) return { plan: true, only: true, part: k, parts: parts.length, text: parts[k - 1], more: k < parts.length };
          return k < parts.length
            ? { plan: true, part: k, parts: parts.length, text: parts[k - 1], more: true }
            : { plan: true, part: k, parts: parts.length, text: parts[k - 1], more: false, then: 'tell the owner to approve or reject the plan on screen' };
        }
        const n = Number.parseInt(back, 10);
        if (!Number.isInteger(n) || n < 1) return { error: 'bad_back' };
        if (typeof getHistory !== 'function') return { error: 'no_history' };
        let history = null;
        try {
          history = await getHistory(sessionId);
        } catch {
          return { error: 'no_history' };
        }
        const texts = history && Array.isArray(history.claudeTexts) ? history.claudeTexts : [];
        const text = texts[n - 1];
        if (typeof text !== 'string' || !text) return { error: 'no_message', available: texts.length };
        const parts = splitParts(text);
        const k = Math.min(Math.max(Number.parseInt(part, 10) || 1, 1), parts.length);
        explain = !only && k < parts.length ? { sessionId, back: n, parts, next: k + 1 } : null; // R2: only:true never auto-continues
        consumeUserTurn(); // wave-1 security: read text is data — a send needs fresh owner words
        if (only) return { back: n, of: texts.length, only: true, part: k, parts: parts.length, text: parts[k - 1], more: k < parts.length };
        return { back: n, of: texts.length, part: k, parts: parts.length, text: parts[k - 1], more: k < parts.length };
      },

      /** Owner 2026-10-07: answer Claude's on-screen AskUserQuestion with the
       *  owner's spoken choice. Gated exactly like send_to_claude (F8, pinned
       *  session, active call). Plan approval stays on screen. */
      answer_claude_question: async ({ answers } = {}) => {
        statusCache = null; // R5: an action was attempted — the status is stale
        const token = takeGate(); // F8 + WO-3: injected pushes must not answer for the owner; taken synchronously
        if (token === null) return gate();
        const sessionId = typeof getSession === 'function' ? getSession() : null;
        if (!sessionId) {
          restoreGate(token);
          return noSessionOpen();
        }
        if (!isCallActive()) {
          restoreGate(token);
          return { error: 'no_call' };
        }
        return exclusive(async () => {
          let acted = false; // nothing answered -> the owner's turn is handed back
          try {
            // The screen may have changed while an earlier action held the lock.
            if ((typeof getSession === 'function' ? getSession() : null) !== sessionId) return noSessionOpen();
            const snapshot = progressLog ? progressLog.snapshot(sessionId) : null;
            const pending = snapshot ? snapshot.pendingQuestion : null;
            if (!pending || !pending.requestId) return { result: 'not_pending' };
            if (pending.toolName === 'ExitPlanMode' || pending.toolName === 'exit_plan_mode') {
              return { result: 'approve_on_screen' }; // the plan is explained only; approval stays on screen
            }
            if (pending.toolName !== 'AskUserQuestion') return { result: 'not_pending' };
            // R6: Jimmy formulated the answer for the question he was SHOWN; if a
            // different one is pending now, nothing is sent — he is told instead.
            if (lastShownRequestId && pending.requestId !== lastShownRequestId) {
              return {
                result: 'question_changed',
                questions: (Array.isArray(pending.questions) ? pending.questions : []).map((question) => stripLine(question.question)),
              };
            }
            if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: 'no_answers' };
            const raw = Array.isArray(pending.questions) ? pending.questions : [];
            const labels = new Map(); // shown (redacted) or raw label -> raw label
            for (const question of raw) {
              for (const label of Array.isArray(question.options) ? question.options : []) {
                labels.set(label, label);
                labels.set(stripLine(label), label);
              }
            }
            // Jimmy saw redacted question text: map it back to the raw question.
            const rawQuestion = (key) => {
              const hit = raw.find((question) => question.question === key || stripLine(question.question) === key);
              if (hit) return hit.question;
              return raw.length === 1 ? raw[0].question : key;
            };
            const words = ownerWords.replace(/\s+/g, ' ').trim();
            const resolved = {};
            for (const [question, choice] of Object.entries(answers)) {
              const key = rawQuestion(String(question || '').trim());
              let value = String(choice ?? '').trim();
              if (!key || !value) continue;
              if (labels.has(value)) value = labels.get(value);
              // R7 owner ruling: whenever the owner's speech was transcribed,
              // EVERY answer — an exact option label included — carries it, so
              // Claude always sees what was really said; only empty speech
              // sends the bare label. (A relay must never add meaning.)
              resolved[key] = words ? `${value} [owner's exact words, auto-transcribed] ${words}` : value;
            }
            if (!Object.keys(resolved).length) {
              return {
                error: 'no_answers',
                questions: (pending.questions || []).map((question) => question.question),
              };
            }
            const input = pending.input && typeof pending.input === 'object' && !Array.isArray(pending.input) ? pending.input : {};
            // Byte-compatible with the stock client's own submit (verified in
            // dist/assets/index-*.js): {type:'chat.permission-response', requestId,
            // allow:true, updatedInput:{...input, answers}} — answers values are
            // option labels joined ', ' or free text.
            const ok = typeof sendPermissionResponse === 'function'
              ? await Promise.resolve(
                  sendPermissionResponse({ type: 'chat.permission-response', requestId: pending.requestId, allow: true, updatedInput: { ...input, answers: resolved } }),
                ).catch(() => false)
              : false;
            if (!ok) return { error: 'send_failed' };
            acted = true; // F8: one owner utterance powered this answer — the gate stays consumed
            ownerWords = '';
            askOwnerOpen = false; // R1: the words were consumed
            // Answered only when Claude Code confirms it (permission_resolved);
            // an already-closed question is silently ignored by the server.
            for (let waited = 0; waited < ANSWER_CONFIRM_MS; waited += ANSWER_POLL_MS) {
              const now = progressLog ? progressLog.snapshot(sessionId).pendingQuestion : null;
              if (!now || now.requestId !== pending.requestId) return { result: 'answered' };
              await delay(ANSWER_POLL_MS);
            }
            return { result: 'not_confirmed' };
          } finally {
            if (!acted) restoreGate(token);
          }
        });
      },
    },

    /** F8: the owner spoke (Live inputTranscription via onUserSpeech) —
     *  re-arm send_to_claude / stop_claude; the raw fragment is kept for relay. */
    markUserTurn,

    /** WO-VP-WORDS R1 (owner 2026-10-07): Jimmy finished a spoken turn — the
     *  owner-words window restarts at his last words, UNLESS a relay is still
     *  waiting for the owner's now/after choice (ask_owner). Fed by the
     *  add-on's onTurnComplete({spoke:true}); never touches the F8 gate. */
    noteJimmySpoke,

    /** A new call starts with no carried-over owner words and no order queued
     *  by an earlier call. */
    resetOwnerWords: () => {
      needUserTurn = true; // wave-1 security: a new call starts with the F8 gate closed
      gateEpoch += 1;
      ownerWords = '';
      askOwnerOpen = false; // R1: a new call closes any old ask_owner window
      queued = null;
      explain = null;
      callOrders = [];
    },

    /** R2 (owner 2026-10-09): hang-up drops the 'after' order — it never
     *  flushes once the call is over — and closes the F8 gate. The per-session
     *  dedupe memory (DEDUPE_MS) is kept. */
    callEnded: () => {
      queued = null;
      needUserTurn = true;
      gateEpoch += 1;
      ownerWords = '';
      askOwnerOpen = false;
      explain = null;
      callOrders = [];
    },

    /** WO-3: '[SESSION CONTEXT]' note of the orders this call already relayed
     *  (and the one waiting for the run to finish), for the briefing of a
     *  replacement Gemini session — '' when there are none. */
    ordersNote: () => {
      const clip = (value) => {
        const text = orderKey(value);
        return text.length > ORDER_NOTE_CHARS ? `${text.slice(0, ORDER_NOTE_CHARS)}…` : text;
      };
      const lines = callOrders.slice(-ORDERS_NOTE_MAX).map((text, i) => `${i + 1}) sent: ${clip(text)}`);
      if (queued && queued.text) lines.push(`${lines.length + 1}) queued, goes when the run finishes: ${clip(queued.text)}`);
      if (!lines.length) return '';
      return `[SESSION CONTEXT] Orders this call already relayed to Claude — Claude has them; never send them again:\n${lines.join('\n')}`;
    },

    /** The next part of the CEO message (or plan, R2) Jimmy is explaining, as
     *  an [APP] push, or null. Only for the call's own session; consumes the
     *  part. */
    nextExplainPart: () => {
      if (!explain || !isCallActive()) return null;
      const callSession = typeof getSession === 'function' ? getSession() : null;
      if (!callSession || callSession !== explain.sessionId) {
        explain = null;
        return null;
      }
      const { back, parts, next, plan } = explain;
      consumeUserTurn(); // F8: an app push re-arms the gate, like every other push
      const last = next >= parts.length;
      explain = last ? null : { ...explain, next: next + 1 };
      const head = plan
        ? `[APP] Part ${next} of ${parts.length} of the PLAN waiting for the owner's approval. Retell it now in plain Masri, continuing from the previous part without repeating it.`
        : `[APP] Part ${next} of ${parts.length} of the CEO message (back=${back}). Retell it now in plain Masri, continuing from the previous part without repeating it.`;
      const tail = last
        ? (plan
            ? ' This is the last part: after it, tell the owner to approve or reject the plan on the screen (never by voice) and ask if they want to discuss any point.'
            : ' This is the last part: after it, ask the owner in one short sentence if they want more detail on any point.')
        : '';
      return `${head}${tail}\n${parts[next - 1]}`;
    },

    /** R8: [APP] text after a false barge-in. Re-hands the part that was cut
     *  (explain kept, so the following parts still follow), or a generic
     *  continue-or-listen line. Null when no call is active. */
    resumeAfterNoise: () => {
      if (!isCallActive()) return null;
      const callSession = typeof getSession === 'function' ? getSession() : null;
      if (explain && (!callSession || callSession !== explain.sessionId)) explain = null;
      consumeUserTurn(); // F8: an app push re-arms the gate, like every other push
      if (!explain) {
        return '[APP] Noise cut you off. If you were in the middle of answering the owner, finish your answer from where you stopped; otherwise stay silent and listen.';
      }
      const { parts, next } = explain; // part next-1 was handed out and cut off
      const k = Math.max(next - 1, 1);
      return `[APP] Noise cut you off while you were telling part ${k} of ${parts.length}. Continue that part from where you stopped, without repeating what you already said.\n${parts[k - 1]}`;
    },

    /** Registers the proactive-update sink ({type, text, sessionId}); only
     *  invoked while isCallActive() is true. */
    onComplete(callback) {
      sink = typeof callback === 'function' ? callback : () => {};
    },
  };
}
