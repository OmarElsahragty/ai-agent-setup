// R1 live refresh — pure decision + scheduling logic, no DOM.
//
// The CloudCLI chat view ignores `session_upserted` frames for the open
// session, so terminal writes never reach the visible transcript. The add-on
// watches those frames and, when the open session changed and no web-initiated
// run is active for it, asks the app to resync through the app's own
// reconnect path (see voice-addon.js: synthesized `websocket_reconnected`).

/** Tracks which sessions have a web-initiated run in flight. */
const RUNNING_KINDS = new Set(['text', 'tool_use', 'tool_result', 'thinking']);

export function createSessionRunTracker() {
  const active = new Set();

  function noteOutgoing(message) {
    if (!message || typeof message !== 'object') return;
    if ((message.type === 'chat.send' || message.type === 'chat.edit-send') && message.sessionId) {
      active.add(message.sessionId);
    }
  }

  function noteFrame(frame) {
    if (!frame || typeof frame.kind !== 'string') return;
    const sessionId = frame.sessionId ?? null;
    if (frame.kind === 'chat_subscribed') {
      if (!sessionId) return;
      if (frame.isProcessing === true) active.add(sessionId);
      else if (frame.isProcessing === false) active.delete(sessionId);
      return;
    }
    if (!sessionId) return;
    // A late 'complete' from an aborted run can clear the flag of the run that
    // replaced it; streaming output proves the session is running again.
    if (RUNNING_KINDS.has(frame.kind) && !(frame.kind === 'text' && frame.role === 'user')) active.add(sessionId);
    if (frame.kind === 'complete' || frame.kind === 'error' || frame.kind === 'protocol_error') {
      active.delete(sessionId);
    }
  }

  return {
    noteOutgoing,
    noteFrame,
    isActive: (sessionId) => active.has(sessionId),
  };
}

/** true iff this frame should trigger a refresh of the visible chat. */
export function shouldLiveRefresh({ frame, openSessionId, runTracker = null, enabled = true }) {
  if (!enabled) return false;
  if (!frame || frame.kind !== 'session_upserted') return false;
  if (!openSessionId || !frame.sessionId) return false;
  if (frame.sessionId !== openSessionId) return false;
  if (runTracker && runTracker.isActive(frame.sessionId)) return false;
  return true;
}

/**
 * Rule 2: a refresh that reloads or replaces page state must be skipped while
 * the chat input holds unsent text. True means "blocked — do not refresh".
 */
export function refreshBlockedByUnsentInput(inputText) {
  return typeof inputText === 'string' && inputText.trim() !== '';
}

/** Open session id from the app route `/session/:sessionId`, null otherwise. */
export function openSessionFromLocation(location) {
  try {
    if (!location || typeof location.pathname !== 'string') return null;
    const match = location.pathname.match(/\/session\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Trailing-debounce + rate-limited refresh scheduler.
 * Bursts collapse into one fire `debounceMs` after the last trigger, and never
 * more often than once per `minIntervalMs`. Timer functions are injectable so
 * tests can drive a fake clock.
 */
export function createRefreshScheduler({
  now = () => Date.now(),
  debounceMs = 1500,
  minIntervalMs = 3000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let timer = null;
  let fireAt = null;
  let lastFiredAt = -Infinity;
  let onFire = () => {};

  function cancel() {
    if (timer !== null) {
      try {
        clearTimeoutFn(timer);
      } catch {
        // timer already gone
      }
    }
    timer = null;
    fireAt = null;
  }

  return {
    trigger() {
      const at = Math.max(now() + debounceMs, lastFiredAt + minIntervalMs);
      cancel();
      fireAt = at;
      timer = setTimeoutFn(
        () => {
          timer = null;
          fireAt = null;
          lastFiredAt = now();
          try {
            onFire();
          } catch {
            // refresh callback failure must not break the loop
          }
        },
        Math.max(0, at - now()),
      );
    },
    cancel,
    onFire(callback) {
      onFire = typeof callback === 'function' ? callback : () => {};
    },
    get pending() {
      return timer !== null;
    },
    get scheduledFor() {
      return fireAt;
    },
    get lastFiredAt() {
      return lastFiredAt;
    },
  };
}
