// R1/R7 (owner 2026-10-09): the voice call is bound to exactly ONE Claude
// session, and that session comes ONLY from the `/session/<id>` route of the
// page. Pure: the page location is read through an injected function.
//   - No session id in the URL (New chat / project screen) -> no target: the
//     bridge's mutating tools answer {error:'no_session_open'} and the add-on
//     never types into or submits the New-chat composer (R1: voice never
//     starts a session; only the owner does, from the CloudCLI UI).
//   - A call started on such a screen binds to the first session the owner
//     opens while it runs (the screen watcher adopts it).
//   - The screen showing a DIFFERENT session than the bound one ends the call
//     (R7: one call <-> one session); a screen with no session keeps the call
//     but refuses every mutating tool until the bound session is back.
//   - There is no fallback: no last-seen socket session, no first-frame
//     capture (audit 2026-10-09, lane D F1: a stale fallback typed into the
//     New-chat composer and created session 070998b8).

import { openSessionFromLocation } from './live-refresh.mjs';

export const NO_SESSION_OPEN = 'no_session_open';

/** The `/session/<id>` route id, else null. Nothing else ever counts. */
export function urlSessionId(location) {
  const id = openSessionFromLocation(location);
  return typeof id === 'string' && id && id !== 'default' ? id : null;
}

/**
 * The call's session binding. readOpenSession() -> the URL's session id or null.
 *   begin()   call start: binds the session on screen (or none yet)
 *   end()     hang-up: no binding
 *   pinned()  the bound session id (null without a call or binding)
 *   current() the session a tool may touch NOW: the bound one, only while the
 *             screen shows it; null otherwise (never adopts by itself)
 *   sync()    screen watcher: 'idle' (no call) | 'keep' | 'adopted' (first
 *             session opened during the call) | 'end' (another session)
 */
export function createCallTarget({ readOpenSession } = {}) {
  let active = false;
  let bound = null;

  function open() {
    try {
      const id = typeof readOpenSession === 'function' ? readOpenSession() : null;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  return {
    begin() {
      active = true;
      bound = open();
      return bound;
    },
    end() {
      active = false;
      bound = null;
    },
    pinned() {
      return active ? bound : null;
    },
    current() {
      if (!active || !bound) return null;
      return open() === bound ? bound : null;
    },
    sync() {
      if (!active) return 'idle';
      const id = open();
      if (!id) return 'keep';
      if (!bound) {
        bound = id;
        return 'adopted';
      }
      return id === bound ? 'keep' : 'end';
    },
  };
}

/**
 * The add-on's check right before it types an order (pure decision):
 *   'no_session_open' the screen does not show the call's session (New chat,
 *                     project screen, another session)
 *   'composer_busy'   the composer holds text the add-on did not insert —
 *                     an order is never appended to the owner's draft (R2)
 *   'still_running'   the composer is in queue/stop mode (a run streams):
 *                     submitting would queue or abort, never send
 *   null              safe to insert and submit
 */
export function composerSendBlock({ openSession, target, composerText, composerIdle } = {}) {
  if (!target || !openSession || openSession !== target) return NO_SESSION_OPEN;
  if (String(composerText ?? '').trim()) return 'composer_busy';
  if (composerIdle === false) return 'still_running';
  return null;
}

/**
 * true when the composer is in plain send mode: CloudCLI 1.37.3 renders its
 * button as type=submit while idle and type=button (queue next / stop) while
 * a run streams (lib/chat-input.mjs). No form (Ctrl+Enter / legacy editor)
 * cannot be told apart and counts as idle — the run tracker gates those.
 */
export function composerIdleFrom({ hasForm, hasSubmitButton } = {}) {
  if (!hasForm) return true;
  return Boolean(hasSubmitButton);
}

/** How long a send waits for the composer to leave queue/stop mode. */
export const COMPOSER_IDLE_WAIT_MS = 2000;

/**
 * WO-3 item 6: true when `url` is the page's own origin (the chat socket),
 * false for a foreign socket (the Gemini Live socket, ...), which the add-on
 * then constructs untouched. Relative URLs resolve against the page. No page
 * location (unit tests) keeps the old wrap-everything behaviour.
 */
export function isSameOriginSocketUrl(url, location) {
  const host = location && typeof location.host === 'string' ? location.host : '';
  if (!host) return true;
  try {
    const base = typeof location.href === 'string' && location.href ? location.href : `https://${host}/`;
    return new URL(String(url), base).host === host;
  } catch {
    return false;
  }
}

function attempt(fn, fallback, ...args) {
  try {
    return typeof fn === 'function' ? fn(...args) : fallback;
  } catch {
    return fallback;
  }
}

function sessionOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * WO-3: the add-on's composer typing, pure over injected page operations.
 *   readComposer() -> {text, idle} | null  the composer on screen (null: none);
 *                     idle=false: queue/stop mode (a run streams)
 *   insertText(text) -> boolean            types the order the way React sees it
 *   removeText(text)                       takes that text back out
 *   submit(text) -> boolean | Promise      submits; true once the app took it
 *   settle() -> Promise                    lets React commit the inserted text
 *   waitFor(pred, ms) -> Promise           polls pred for up to ms
 * send(text, {target, readOpenSession}) -> true | false | {error}:
 *   - only while the screen shows `target`, else no_session_open (never the
 *     New-chat composer, R1);
 *   - only into an EMPTY composer, else composer_busy (an order is never
 *     appended to a draft the add-on did not insert, R2);
 *   - never submitted in queue/stop mode: waits up to idleWaitMs for plain
 *     send mode (else still_running) and checks again right before submit;
 *   - any failure after the insert takes the inserted text back out.
 */
export function createComposerSender({
  readComposer,
  insertText,
  removeText,
  submit,
  settle = null,
  waitFor = null,
  idleWaitMs = COMPOSER_IDLE_WAIT_MS,
} = {}) {
  function composer() {
    const state = attempt(readComposer, null);
    return state && typeof state === 'object' ? state : null;
  }

  function block(target, readOpenSession) {
    const state = composer();
    if (!state) return 'send_failed';
    return composerSendBlock({
      openSession: sessionOrNull(attempt(readOpenSession, null)),
      target,
      composerText: state.text,
      composerIdle: state.idle,
    });
  }

  async function send(text, { target = null, readOpenSession = null } = {}) {
    let why = block(target, readOpenSession);
    if (why === 'still_running' && typeof waitFor === 'function') {
      try {
        await waitFor(() => block(target, readOpenSession) !== 'still_running', idleWaitMs);
      } catch {
        // checked again below
      }
      why = block(target, readOpenSession);
    }
    if (why === 'send_failed') return false;
    if (why) return { error: why };
    const takeBack = () => attempt(removeText, undefined, text);
    if (!attempt(insertText, false, text)) {
      takeBack();
      return false;
    }
    if (typeof settle === 'function') {
      try {
        await settle();
      } catch {
        // checked below
      }
    }
    // The screen or the run state may have changed while React committed the text.
    if (sessionOrNull(attempt(readOpenSession, null)) !== target) {
      takeBack();
      return { error: NO_SESSION_OPEN };
    }
    const state = composer();
    if (!state || state.idle === false) {
      takeBack();
      return state ? { error: 'still_running' } : false;
    }
    let ok = false;
    try {
      ok = (await submit(text)) === true;
    } catch {
      ok = false;
    }
    if (!ok) takeBack();
    return ok;
  }

  return { send, block };
}

/**
 * WO-3 (R1/R7): the add-on's session-touching actions, bound to the call's
 * URL session — never a last-seen socket session, never the New-chat screen.
 *   callSession()  the call's session while the screen shows it, else null
 *   insertAndSendTo(text, sessionId?)  types + submits through `composer`,
 *                  into that session's own composer only; `sessionId` is the
 *                  session the bridge bound when the tool started (a send in
 *                  flight at hang-up still lands there, N3); no session on
 *                  screen -> {error:'no_session_open'}
 *   sendAbort()    {type:'chat.abort', sessionId} for the call's session only
 *   sendPermissionResponse(frame)  only while the call's session is on screen
 * deps: readOpenSession() -> URL session or null, callTarget
 * (createCallTarget), isCallActive(), getSocket() -> the page's chat socket,
 * composer (createComposerSender).
 */
export function createCallActions({ readOpenSession, callTarget, isCallActive, getSocket, composer } = {}) {
  const openNow = () => sessionOrNull(attempt(readOpenSession, null));

  function callSession() {
    if (!attempt(isCallActive, false)) return null;
    return sessionOrNull(attempt(() => callTarget.current(), null));
  }

  function sendFrame(frame) {
    const socket = attempt(getSocket, null);
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  async function insertAndSendTo(text, sessionId = null) {
    const target = sessionOrNull(sessionId) || callSession();
    if (!target || openNow() !== target) return { error: NO_SESSION_OPEN };
    if (!composer || typeof composer.send !== 'function') return false;
    return composer.send(text, { target, readOpenSession: openNow });
  }

  function sendAbort() {
    const sessionId = callSession();
    if (!sessionId) return false;
    return sendFrame({ type: 'chat.abort', sessionId });
  }

  function sendPermissionResponse(frame) {
    if (!callSession() || !frame || typeof frame !== 'object') return false;
    return sendFrame(frame);
  }

  return { callSession, insertAndSendTo, sendAbort, sendPermissionResponse };
}
