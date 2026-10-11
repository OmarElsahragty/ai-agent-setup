// CloudCLI voice add-on — Gemini-Live-style call front end (WO-VL-UI + WO-VL-CTX).
// ONE call button opens a slim floating call bar at the top (small orb + mute +
// hang up only) so the chat underneath stays visible and interactive.
// Gemini Live tool calls run in the browser against the open Claude Code
// session: get_claude_status / send_to_claude / stop_claude (lib/voice-bridge.mjs).
// At call start the open session's last messages are seeded from CloudCLI's
// history API (lib/session-history.mjs) and pushed as a silent
// "[SESSION CONTEXT]" briefing (turnComplete:false) — the voice knows what the
// open session is about without the model speaking (WO-VL-CTX).
// The legacy voice pipeline (PTT, duplex, Silero/VAD/STT/TTS, headlines, cues,
// narrator, toggles, metrics) is gone. Kept from the old add-on: the WebSocket
// wrap + session tracking, live refresh, activity bar, background jobs,
// sidebar working badges, feature flags, and the /voice/event beacons.
// Owner ruling Q9a (2026-10-10): an OPTIONAL push-to-talk for the Live call
// (lib/push-to-talk.mjs, default OFF) gates only the call's mic; it is not the
// removed local-speech PTT.
import {
  locateChatInput,
  readInputText,
  appendTranscript,
  setTextareaValue,
  chooseSubmitStrategy,
  submitChatInput,
  findSubmitButton,
  planMount,
  applyMount,
  detachAll,
} from './lib/chat-input.mjs';
import {
  urlSessionId,
  createCallTarget,
  composerIdleFrom,
  isSameOriginSocketUrl,
  createComposerSender,
  createCallActions,
} from './lib/session-target.mjs';
import { createAddonFlags, FLAG_LIVE_REFRESH, FLAG_BG_JOBS } from './lib/feature-flags.mjs';
import { createPushToTalk } from './lib/push-to-talk.mjs';
import {
  createSessionRunTracker,
  shouldLiveRefresh,
  createRefreshScheduler,
  refreshBlockedByUnsentInput,
} from './lib/live-refresh.mjs';
import { bgTasksUrl, bgTaskTailUrl, createPollController, BG_TAIL_LINES } from './lib/bg-jobs.mjs';
import {
  createActivityModel,
  createCadencePoller,
  createOpenSessionWatcher,
  decidePollMs,
  activeSessionsUrl,
  agentsTailUrl,
  activeSessionIds,
  sessionIdFromHref,
  AGENT_TAIL_STEPS,
} from './lib/activity-bar.mjs';
import { createProgressLog } from './lib/progress-log.mjs';
import { createVoiceBridge } from './lib/voice-bridge.mjs';
import { createLiveCall } from './lib/live-call.mjs';
import { createSessionHistory, snapshotContext } from './lib/session-history.mjs';
import { createCallTranscript } from './lib/call-transcript.mjs';
import {
  AUTOCALL_KEY,
  RELOAD_KEY,
  versionFrom,
  decideCallStart,
  shouldAutoCall,
  fetchServedVersion,
} from './lib/addon-version.mjs';

const config = Object.assign(
  {
    tokenUrl: '/voice/live-token',
    eventUrl: '/voice/event',
    transcriptUrl: '/voice/transcript',
    healthUrl: '/voice/health',
  },
  window.__CLOUDCLI_VOICE__ || {},
);

let currentSession = null;
let chatSocket = null;
let outgoingSendCount = 0;
let mountScheduled = false;
const SEND_CONFIRM_MS = 1500;

// WO-E2/G2: live refresh + bottom activity bar + sidebar working badges.
const flags = createAddonFlags(window.localStorage);
// Owner ruling Q9a (2026-10-10): optional push-to-talk, default OFF.
const ptt = createPushToTalk({ flags, onChange: (snapshot) => safe(() => renderPtt(snapshot)) });
const runTracker = createSessionRunTracker();
const refreshScheduler = createRefreshScheduler({ debounceMs: 1500, minIntervalMs: 3000 });
const activityModel = createActivityModel();
let kindSocket = null;
let activityBar = null;
let activeIds = new Set();
let sidebarDisabled = false;
let expandedLoadedFor = null;
const activityPoll = createCadencePoller({
  decideMs: () =>
    safe(
      () =>
        decidePollMs({
          visible: !document.hidden,
          expanded: activityModel.expanded,
          anythingRunning: activityModel.anythingRunning,
          sessionWorking: activityModel.sessionWorking,
        }),
      null,
    ),
  onTick: () => safe(pollActivity),
});
const sidebarPoll = createPollController({ intervalMs: 5000, onTick: () => safe(pollActiveSessions) });

// --- Voice call state --------------------------------------------------------

const progressLog = createProgressLog();
// WO-VL-CTX: REST seeding of the open session's history (throttled 10 s per
// session; force-refreshed once at call start). Failures keep the last good
// data and never throw into the call.
const sessionHistory = createSessionHistory({
  fetch: (url, init) => window.fetch(url, init),
  localStorage: window.localStorage,
  now: () => Date.now(),
  progressLog,
});
let ui = null;
let liveCallInstance = null;
const TOOLS_SETTLE_MS = 4000; // endCall waits this long for in-flight tool calls
let callActive = false;
let callUi = null;
let wakeLock = null;
// The call button shows only while /voice/health reports live:true; sticky hide after two
// consecutive misses so one flaky poll never rips the button away.
let voiceLive = false;
let healthMisses = 0;

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (error) {
    console.warn('[cloudcli-voice]', error);
    return fallback;
  }
}

// --- WebSocket wrap + session tracking (kept verbatim from the old add-on) ---

// WO-3: only the page's own (same-origin) sockets are wrapped — the Gemini
// Live socket and any other foreign socket is constructed untouched
// (lib/session-target.mjs isSameOriginSocketUrl).
function patchWebSockets() {
  const OriginalWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const args = protocols !== undefined ? [url, protocols] : [url];
    const socket = Reflect.construct(OriginalWebSocket, args, new.target || PatchedWebSocket);
    if (!isSameOriginSocketUrl(url, window.location)) return socket;
    const originalSend = socket.send.bind(socket);
    socket.send = (data) => {
      safe(() => {
        if (typeof data === 'string') {
          const parsed = JSON.parse(data);
          if (parsed && (parsed.type === 'chat.send' || parsed.type === 'chat.edit-send')) outgoingSendCount += 1;
          if (parsed && (parsed.type === 'chat.send' || parsed.type === 'chat.edit-send') && parsed.sessionId) {
            runTracker.noteOutgoing(parsed);
            if (parsed.sessionId !== currentSession) {
              currentSession = parsed.sessionId;
              noteSessionChanged(parsed.sessionId);
            }
          }
        }
      });
      return originalSend(data);
    };
    socket.addEventListener('message', (event) => {
      safe(() => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data);
        if (!frame || typeof frame.kind !== 'string') return;
        chatSocket = socket;
        kindSocket = socket;
        runTracker.noteFrame(frame);
        maybeScheduleLiveRefresh(frame);
        progressLog.feed(frame);
      });
    });
    return socket;
  }
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  // The app gates every send on `readyState === WebSocket.OPEN`; a bare function
  // has no static constants, so inherit them (and keep explicit copies).
  Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try {
      Object.defineProperty(PatchedWebSocket, key, { value: OriginalWebSocket[key], enumerable: true });
    } catch (_) { /* already inherited */ }
  }
  window.WebSocket = PatchedWebSocket;
}

// --- Live refresh (R1) ------------------------------------------------------

// R1/R7 (owner 2026-10-09): the open session is the `/session/<id>` route and
// nothing else — no last-seen socket session, no first-frame capture.
function openSessionId() {
  return urlSessionId(window.location);
}

function maybeScheduleLiveRefresh(frame) {
  if (!frame || frame.kind !== 'session_upserted') return;
  if (
    !shouldLiveRefresh({
      frame,
      openSessionId: openSessionId(),
      runTracker,
      enabled: flags.isEnabled(FLAG_LIVE_REFRESH, true),
    })
  ) {
    return;
  }
  refreshScheduler.trigger();
}

// The app ignores session_upserted for the open chat, but it DOES have a
// native resync: on socket reopen it synthesizes {kind:"websocket_reconnected"}
// into its own frame bus, which refetches the open session's latest messages
// and resubscribes. Replaying exactly that frame through the app's onmessage
// handler reuses the app's refresh code (scroll-at-bottom handling included)
// without touching app code or the DOM tree.
function synthesizeReconnectFrame() {
  // Rule 2: while the chat input holds unsent text, never reload or replace
  // page state — skip this round; the next session_upserted re-triggers.
  if (refreshBlockedByUnsentInput(chatInputText())) return;
  const socket = kindSocket || chatSocket;
  if (!socket || socket.readyState !== 1) return;
  safe(() => {
    const payload = JSON.stringify({ kind: 'websocket_reconnected', timestamp: Date.now() });
    if (typeof socket.onmessage === 'function') {
      socket.onmessage({ data: payload });
    } else {
      socket.dispatchEvent(new MessageEvent('message', { data: payload }));
    }
  });
}

// --- Background jobs (R2) ---------------------------------------------------

function bgSessionId() {
  const id = openSessionId();
  return typeof id === 'string' && id && id !== 'default' ? id : null;
}

async function authedFetch(url) {
  const headers = { Accept: 'application/json' };
  const token = safe(() => window.localStorage.getItem('auth-token'), null);
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}

async function pollActivity() {
  const sessionId = bgSessionId();
  if (!sessionId || activityModel.disabled || !flags.isEnabled(FLAG_BG_JOBS, true)) return;
  let response;
  try {
    response = await authedFetch(bgTasksUrl(sessionId));
  } catch {
    return; // transient network failure — next tick retries
  }
  if (response.status === 404 || response.status === 401) {
    // Endpoint absent (or unreachable auth): hide the bar and stop polling.
    activityModel.noteStatus(response.status);
    renderActivityBar();
    syncActivityPolling();
    return;
  }
  if (!response.ok) return;
  let payload;
  try {
    payload = await response.json();
  } catch {
    return;
  }
  syncExpandedState(sessionId);
  activityModel.apply(payload);
  renderActivityBar();
  if (activityModel.selected && activityModel.selectedRunning) void fetchSelectedTail();
  syncActivityPolling(); // cadence may switch 3 s <-> 15 s with the new data
}

async function fetchSelectedTail() {
  const sessionId = bgSessionId();
  const selected = activityModel.selected;
  if (!sessionId || !selected || activityModel.disabled) return;
  const url =
    selected.kind === 'agent'
      ? agentsTailUrl(selected.id, sessionId, AGENT_TAIL_STEPS)
      : bgTaskTailUrl(selected.id, sessionId, BG_TAIL_LINES);
  let response;
  try {
    response = await authedFetch(url);
  } catch {
    return;
  }
  if (!response.ok) return;
  try {
    const payload = await response.json();
    if (selected.kind === 'agent') activityModel.applyAgentTail(payload);
    else activityModel.applyJobTail(payload);
  } catch {
    return;
  }
  renderActivityTail();
}

function expandedStateKey(sessionId) {
  return `cloudcli-voice:activitybar:expanded:${sessionId}`;
}

function loadExpandedState(sessionId) {
  try {
    return window.localStorage.getItem(expandedStateKey(sessionId)) === '1';
  } catch {
    return false;
  }
}

function saveExpandedState(sessionId, expanded) {
  try {
    window.localStorage.setItem(expandedStateKey(sessionId), expanded ? '1' : '0');
  } catch {
    // storage unavailable — expanded state stays per page load
  }
}

// Load the stored expanded/collapsed state once per session switch; later
// toggles stay in memory (and are persisted) without being overwritten.
function syncExpandedState(sessionId) {
  if (expandedLoadedFor === sessionId) return;
  expandedLoadedFor = sessionId;
  activityModel.setExpanded(loadExpandedState(sessionId));
}

function noteSessionChanged(sessionId) {
  activityModel.select(null);
  syncExpandedState(sessionId);
  syncActivityPolling();
  syncSidebarPolling();
  syncOpenSession();
}

// D7: the first activity poll of a freshly opened session runs immediately
// (the idle cadence would otherwise make it wait 15 s).
const openSessionWatcher = createOpenSessionWatcher({
  onOpen: (sessionId) => {
    activityModel.select(null);
    activityModel.apply({ tasks: [], agents: [], sessionWorking: false });
    syncExpandedState(sessionId);
    renderActivityBar();
    if (!activityModel.disabled && flags.isEnabled(FLAG_BG_JOBS, true)) activityPoll.pollNow();
  },
  onClose: () => activityPoll.stop(),
});

function syncOpenSession() {
  safe(() => openSessionWatcher.check(bgSessionId()));
  safe(checkCallSession);
}

function ensureActivityBar() {
  if (activityBar) return activityBar;
  const root = document.createElement('div');
  root.className = 'ccv-abar';
  root.hidden = true;
  const summary = document.createElement('button');
  summary.className = 'ccv-abar-summary';
  summary.type = 'button';
  summary.title = 'Activity: running subagents and background jobs';
  summary.setAttribute('aria-expanded', 'false');
  const rows = document.createElement('div');
  rows.className = 'ccv-abar-rows';
  rows.hidden = true;
  const tail = document.createElement('pre');
  tail.className = 'ccv-abar-tail';
  tail.hidden = true;
  summary.addEventListener('click', () => safe(toggleActivityBar));
  root.append(summary, rows, tail);
  activityBar = { root, summary, rows, tail };
  return activityBar;
}

// D1/D8: the activity bar and the single-call-button bar sit in the page flow
// directly above the chat form — never position:fixed, so they can never cover
// the input. No chat form on this screen (sign-in, project picker, pending
// AskUserQuestion) -> both bars are detached.
function syncMount() {
  buildUi();
  ensureActivityBar();
  if (!ui || !ui.bar) return;
  const nodes = [activityBar.root, ui.bar];
  const plan = planMount(locateChatInput(document));
  if (!plan) {
    detachAll(nodes);
    return;
  }
  applyMount(plan, nodes);
}

function scheduleMountCheck() {
  if (mountScheduled) return;
  mountScheduled = true;
  const run = () => {
    mountScheduled = false;
    safe(() => {
      syncMount();
      syncOpenSession();
      // React re-renders sidebar rows; keep working badges present while active.
      if (activeIds.size) renderSidebarBadges();
    });
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function toggleActivityBar() {
  const expanded = !activityModel.expanded;
  activityModel.setExpanded(expanded);
  saveExpandedState(bgSessionId() || 'default', expanded);
  renderActivityBar();
  if (expanded) void pollActivity();
  syncActivityPolling();
}

function renderActivityBar() {
  if (!activityBar) return;
  safe(() => {
    const label = activityModel.disabled ? '' : activityModel.summary();
    activityBar.root.hidden = !label;
    if (!label) return;
    activityBar.summary.textContent = label;
    activityBar.summary.setAttribute('aria-expanded', String(activityModel.expanded));
    activityBar.rows.hidden = !activityModel.expanded;
    if (!activityModel.expanded) {
      activityBar.tail.hidden = true;
      return;
    }
    activityBar.rows.replaceChildren();
    const rows = activityModel.rows();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'ccv-abar-empty';
      empty.textContent = 'Nothing running';
      activityBar.rows.append(empty);
    }
    for (const row of rows) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `ccv-abar-row${row.status === 'running' ? '' : ' ccv-finished'}`;
      const selected = activityModel.selected;
      if (selected && selected.kind === row.kind && selected.id === row.id) element.classList.add('selected');
      const icon = document.createElement('span');
      icon.className = 'ccv-abar-ico';
      icon.textContent = row.icon;
      const title = document.createElement('span');
      title.className = 'ccv-abar-type';
      title.textContent = row.title;
      const description = document.createElement('span');
      description.className = 'ccv-abar-desc';
      description.textContent = row.description;
      const middle = document.createElement('span');
      middle.className = 'ccv-abar-mid';
      middle.textContent = row.middle;
      const elapsed = document.createElement('span');
      elapsed.className = 'ccv-abar-elapsed';
      elapsed.textContent = row.elapsed;
      element.append(icon, title, description, middle, elapsed);
      element.addEventListener('click', () => {
        activityModel.select(row.kind, row.id);
        renderActivityBar();
        void fetchSelectedTail();
      });
      activityBar.rows.append(element);
    }
    renderActivityTail();
  });
}

function renderActivityTail() {
  if (!activityBar) return;
  safe(() => {
    const tail = activityModel.tail;
    if (!tail) {
      activityBar.tail.hidden = true;
      activityBar.tail.textContent = '';
      return;
    }
    activityBar.tail.hidden = false;
    activityBar.tail.textContent = tail.truncated ? `${tail.text}\n… (older output truncated)` : tail.text;
  });
}

function syncActivityPolling() {
  if (!bgSessionId() || activityModel.disabled || !flags.isEnabled(FLAG_BG_JOBS, true)) {
    activityPoll.stop();
  } else {
    activityPoll.sync(); // decideMs reads live state (visibility + cadence inputs)
  }
}

// --- Sidebar working badges --------------------------------------------------

async function pollActiveSessions() {
  if (sidebarDisabled) return;
  let response;
  try {
    response = await authedFetch(activeSessionsUrl());
  } catch {
    return; // transient — next tick retries
  }
  if (response.status === 404 || response.status === 401) {
    sidebarDisabled = true;
    activeIds = new Set();
    renderSidebarBadges();
    syncSidebarPolling();
    return;
  }
  if (!response.ok) return;
  try {
    activeIds = activeSessionIds(await response.json());
  } catch {
    return;
  }
  renderSidebarBadges();
}

// Sidebar rows are anchors with data-testid="recent-conversation-row" and
// href="/session/<id>" (bundle 1.37.3, grep-verified); fall back to any
// /session/ link. Fail-safe: no anchors found -> nothing happens.
function renderSidebarBadges() {
  safe(() => {
    let anchors = Array.from(document.querySelectorAll('a[data-testid="recent-conversation-row"]'));
    if (!anchors.length) anchors = Array.from(document.querySelectorAll('a[href^="/session/"]'));
    for (const anchor of anchors) {
      const sessionId = sessionIdFromHref(anchor.getAttribute('href'));
      if (!sessionId) continue;
      const existing = anchor.querySelector(':scope > .ccv-wbadge');
      if (activeIds.has(sessionId)) {
        if (existing) continue;
        const badge = document.createElement('span');
        badge.className = 'ccv-wbadge';
        badge.textContent = '⟳';
        badge.setAttribute('aria-label', 'Session working');
        anchor.appendChild(badge);
      } else if (existing) {
        existing.remove();
      }
    }
  });
}

function syncSidebarPolling() {
  sidebarPoll.sync({
    visible: !document.hidden,
    enabled: true,
    disabled: sidebarDisabled,
    sessionId: 'all',
  });
}

// --- Voice health gate -------------------------------------------------------

function applyVoiceGate() {
  if (!ui || !ui.bar) return;
  safe(() => {
    ui.bar.hidden = !voiceLive;
  });
}

async function checkVoiceHealth() {
  let live = false;
  try {
    const response = await fetch(config.healthUrl);
    if (response.ok) {
      const payload = await response.json();
      live = payload && payload.live === true;
    }
  } catch {
    live = false;
  }
  if (live) {
    healthMisses = 0;
    voiceLive = true;
    void refreshServedVersion();
  } else {
    healthMisses += 1;
    if (healthMisses >= 2) voiceLive = false; // sticky: one miss keeps the button
  }
  applyVoiceGate();
  maybeAutoCall();
}

// Owner 2026-10-07 (call 211015): an outdated tab reloads once at call start
// and the call then starts by itself. The served version is refreshed with
// every health check so the click handler can decide synchronously (the mic
// must start inside the click task); a fresh check also runs right after the
// call starts, for a deploy in the last 30 s. Every failure fails open.
const RUNNING_VERSION = versionFrom(import.meta.url);
let servedVersion = null;
// The flag time is kept: the age is checked again when the call would start
// (wave-1 review), so a gateway that comes back minutes later never auto-calls.
let autoCallPending = safe(() => {
  const flagAt = window.sessionStorage.getItem(AUTOCALL_KEY);
  window.sessionStorage.removeItem(AUTOCALL_KEY);
  return shouldAutoCall({ flagAt, now: Date.now() }) ? flagAt : null;
}, null);

async function refreshServedVersion() {
  const served = await fetchServedVersion((url, opts) => fetch(url, opts));
  if (served) servedVersion = served;
  return served;
}

function wouldReload(served) {
  const lastReloadAt = safe(() => window.sessionStorage.getItem(RELOAD_KEY), null);
  return decideCallStart({ running: RUNNING_VERSION, served, lastReloadAt, now: Date.now() }) === 'reload';
}

/** True when the page was sent to reload (the caller must stop). */
function reloadIfOutdated(served) {
  if (!wouldReload(served)) return false;
  const ok = safe(() => {
    window.sessionStorage.setItem(AUTOCALL_KEY, String(Date.now()));
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  }, false);
  if (!ok) return false; // no storage: never reload without the loop guard
  beacon('version-reload');
  window.location.reload();
  return true;
}

// A call started by itself after the reload has no user gesture behind it:
// the browser may keep its audio suspended, so the first tap anywhere resumes
// it (the call bar says so until then).
function armAudioUnlock() {
  const unlock = () => {
    for (const type of ['pointerdown', 'keydown', 'touchend']) document.removeEventListener(type, unlock, true);
    safe(() => {
      if (liveCallInstance && typeof liveCallInstance.resumeAudio === 'function') liveCallInstance.resumeAudio();
    });
  };
  for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, unlock, true);
}

function maybeAutoCall() {
  if (!autoCallPending || !voiceLive || callActive) return;
  const flagAt = autoCallPending;
  autoCallPending = null;
  if (!shouldAutoCall({ flagAt, now: Date.now() })) return;
  beacon('auto-call');
  void startCall({ auto: true });
}

// Call milestones to the gateway journal (allow-listed names, one number).
function beacon(name, n = 0) {
  safe(() => {
    const url = `${config.eventUrl}?e=${encodeURIComponent(name)}&n=${Math.round(n) || 0}`;
    if (!navigator.sendBeacon || !navigator.sendBeacon(url)) void fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  });
}

// --- Claude bridge (insert + submit + abort) ---------------------------------

// D1: every composer access goes through lib/chat-input.mjs (textarea first,
// CodeMirror fallback). Textarea: native value setter + bubbling input event,
// appended like the app's own voice handler (draft + space + transcript).
function insertIntoInput(text, { focus = true } = {}) {
  const found = locateChatInput(document);
  if (!found) return false;
  if (found.kind === 'textarea') {
    const textarea = found.element;
    const ok = safe(() => setTextareaValue(textarea, appendTranscript(textarea.value, text), window), false);
    if (ok && focus) safe(() => textarea.focus({ preventScroll: true }));
    return ok;
  }
  const editor = found.element;
  const content = found.content;
  if (!content) return false;
  safe(() => {
    editor.setAttribute('dir', 'auto');
    content.setAttribute('dir', 'auto');
  });
  content.focus();
  let inserted = safe(() => document.execCommand('insertText', false, text), false);
  if (!inserted) {
    safe(() => {
      content.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: text,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    inserted = true;
  }
  return inserted;
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (safe(predicate, false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// D1: submit the way the app expects — its send button while idle (type=submit;
// form.requestSubmit() while React has not enabled it yet), Ctrl+Enter when no
// form exists. Success = a chat.send left the socket or the app consumed the
// input. WO-3: the composer sender (lib/session-target.mjs) has already let
// React commit the text and re-checked the call's session + plain send mode.
async function submitComposer(sentText) {
  const found = locateChatInput(document);
  const strategy = chooseSubmitStrategy(found);
  if (!strategy) return false;
  // WO-3: never submit while the composer is in queue/stop mode (no type=submit
  // button: the app would queue the text — a second copy later — or abort).
  if (strategy === 'requestSubmit' && !findSubmitButton(found.form)) return false;
  const before = outgoingSendCount;
  if (!submitChatInput(found, strategy, window)) return false;
  if (strategy === 'legacy') return true;
  const needle = String(sentText || '').trim();
  return waitFor(
    () => outgoingSendCount > before || !needle || !chatInputText().includes(needle),
    SEND_CONFIRM_MS,
  );
}

/** Current composer text ('' when absent) — rule 2 input + send confirmation. */
function chatInputText() {
  return safe(() => readInputText(locateChatInput(document)), '');
}

// R1/R7 (owner 2026-10-09): every call belongs to ONE session, taken ONLY
// from the `/session/<id>` URL (lib/session-target.mjs). The session on
// screen at call start is bound; a call started on New chat / a project
// screen binds the first session the owner opens. The bridge reads, sends and
// aborts only while the screen shows that session; another session on screen
// hangs the call up. Voice never types into the New-chat composer.
const callTarget = createCallTarget({ readOpenSession: () => bgSessionId() });

// WO-3: every session-touching action of a call (type + submit, abort, the
// answer to an on-screen question) runs through lib/session-target.mjs,
// bound to the call's URL session; this file only supplies the page
// operations (composer reads/writes, submit, the page's chat socket).
const callActions = createCallActions({
  readOpenSession: () => bgSessionId(),
  callTarget,
  isCallActive: () => callActive,
  getSocket: () => chatSocket,
  composer: createComposerSender({
    readComposer,
    insertText: (text) => insertIntoInput(text),
    removeText: removeInsertedText,
    submit: submitComposer,
    settle: nextTask,
    waitFor,
  }),
});

function callSession() {
  if (!callActive) return null;
  return callActions.callSession();
}

function checkCallSession() {
  if (!callActive) return;
  const verdict = callTarget.sync();
  if (verdict === 'end') endCall();
  else if (verdict === 'adopted') void seedSessionContext(); // brief the session the owner just opened
}

function sendAbort() {
  return callActions.sendAbort();
}

/** WO-3: the composer as the sender sees it — its text and whether the app is
 *  in plain send mode (type=submit button) — or null when there is none. */
function readComposer() {
  const found = locateChatInput(document);
  if (!found) return null;
  const form = found.form || null;
  return {
    text: safe(() => readInputText(found), ''),
    idle: composerIdleFrom({ hasForm: Boolean(form), hasSubmitButton: Boolean(form && findSubmitButton(form)) }),
  };
}

/** WO-3: a failed send takes its own text back out of the composer — it is
 *  never left behind for a later send (or the app's queue) to carry. */
function removeInsertedText(text) {
  safe(() => {
    const found = locateChatInput(document);
    const needle = String(text || '').trim();
    if (!found || !needle) return;
    const current = readInputText(found);
    if (!current.includes(needle)) return;
    if (found.kind === 'textarea') {
      setTextareaValue(found.element, current.replace(needle, '').trim(), window);
    } else if (found.content) {
      found.content.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    }
  });
}

// The composer on screen must belong to the call's session; otherwise the
// text would land in another chat — or start a new one (R1). `sessionId` is
// the session the bridge bound when the tool started, so a send already in
// flight at hang-up still finishes (N3) — but only into that session's own
// composer; queued 'after' orders never get here once the call ended (R2).
// No session on screen -> {error:'no_session_open'}; an owner draft ->
// composer_busy; queue/stop mode -> still_running (lib/session-target.mjs).
function insertAndSendTo(text, sessionId) {
  return callActions.insertAndSendTo(text, sessionId);
}

// Owner 2026-10-07: Jimmy answers Claude's on-screen question by voice. The
// bridge builds the frame; this only puts it on the page's chat socket,
// byte-compatible with the stock client's own submit (no sessionId — the
// server resolves over the inbound socket, exactly like the stock send).
function sendPermissionResponse(frame) {
  return callActions.sendPermissionResponse(frame);
}

// --- Voice bridge wiring -----------------------------------------------------

const bridge = createVoiceBridge({
  progressLog,
  runTracker,
  getSession: () => callSession(),
  insertAndSend: insertAndSendTo,
  abort: sendAbort,
  isCallActive: () => callActive,
  getHistory: (sessionId) => sessionHistory.refresh(sessionId),
  sendPermissionResponse,
  // Owner 2026-10-07 (call 205456): Jimmy said "no background jobs" while an
  // agent was running — the status now carries what the activity bar shows.
  getBackgroundTasks: () => {
    if (activityModel.disabled) return null;
    const running = [...activityModel.agents, ...activityModel.tasks].filter((item) => item && item.status === 'running');
    return { running: running.length, names: running.map((item) => String(item.description || item.agentType || item.command || 'job')) };
  },
});

// Proactive '[CLAUDE UPDATE] ' pushes reach Gemini only while a call is up
// (the bridge gates on isCallActive; pushText queues while the model speaks).
// F8: the pushed payload is capped — a smaller injection surface for the model.
// App-made text echoed back as 'owner speech' must never re-arm the owner's tools.
const APP_TEXT_RE = /^\s*\[(APP|SESSION CONTEXT|CLAUDE UPDATE)\]/;
const PUSH_TEXT_MAX = 4100; // owner 2026-10-07: full substance; progress-log already clips at a sentence end
bridge.onComplete(({ type, text }) => {
  if (!callActive || !liveCallInstance) return;
  const label = type === 'app' ? '' : '[CLAUDE UPDATE] '; // app notices carry their own [APP] tag
  safe(() => liveCallInstance.pushText((label + text).slice(0, PUSH_TEXT_MAX)));
});

// --- Call overlay UI ---------------------------------------------------------

// Arabic state words exist ONLY for these four states; every other state is
// wordless (orb color/animation carries it). 'unavailable' (owner 2026-10-08):
// Google's live sessions kept dropping — the ↻ button retries.
const CALL_STATE_WORDS = {
  connecting: 'بيوصل…',
  reconnecting: 'بيرجع يتصل…',
  error: 'في مشكلة — اقفل وافتح تاني',
  unavailable: 'صوت جوجل واقع — دوس ↻',
};

function buildUi() {
  if (ui) return;
  const style = document.createElement('style');
  style.textContent = [
    // The app's [hidden] rule has the same specificity as these display rules
    // and loads earlier, so hidden must be forced explicitly (D8).
    '.ccv-bar[hidden],.ccv-abar[hidden],.ccv-bar [hidden],.ccv-abar [hidden]{display:none!important;}',
    '.ccv-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px;font:12px/1.4 system-ui,sans-serif;}',
    '.ccv-btn{min-width:44px;min-height:38px;padding:0 10px;border-radius:10px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:16px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;}',
    '.ccv-abar{display:flex;flex-direction:column;gap:4px;max-width:100%;margin:0 0 4px;font:12px/1.4 system-ui,sans-serif;}',
    '.ccv-abar-summary{display:flex;align-items:center;width:100%;box-sizing:border-box;padding:6px 16px;border:1px solid rgba(128,128,128,.45);border-radius:10px;background:rgba(18,18,22,.85);color:inherit;cursor:pointer;text-align:left;font-size:12px;}',
    '.ccv-abar-rows{display:flex;flex-direction:column;gap:2px;max-height:40vh;overflow:auto;padding:2px 0;}',
    '.ccv-abar-row{display:flex;align-items:baseline;gap:8px;min-width:0;box-sizing:border-box;width:100%;padding:5px 16px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-align:left;font:12px/1.4 system-ui,sans-serif;}',
    '.ccv-abar-row.selected{background:rgba(56,140,255,.15);}',
    '.ccv-abar-row.ccv-finished{opacity:.6;}',
    '.ccv-abar-empty{padding:5px 16px;opacity:.7;}',
    '.ccv-abar-ico{flex:0 0 auto;}',
    '.ccv-abar-type{flex:0 0 auto;font-weight:600;}',
    '.ccv-abar-desc{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ccv-abar-mid{flex:1 1 30%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75;}',
    '.ccv-abar-elapsed{flex:0 0 auto;opacity:.7;font-variant-numeric:tabular-nums;}',
    '.ccv-abar-tail{margin:4px 0 0;padding:8px;background:rgba(0,0,0,.35);border-radius:8px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;}',
    '.ccv-wbadge{flex-shrink:0;margin-left:4px;align-self:center;display:inline-block;color:#388cff;animation:ccv-wspin 1.2s linear infinite;}',
    '@keyframes ccv-wspin{to{transform:rotate(360deg)}}',
    '@media (max-width:640px){.ccv-abar-rows{max-height:30vh;}}',
    // Slim floating call bar (WO-VL-CTX): fixed top-center pill, ~48px tall,
    // translucent — the chat underneath stays visible, scrollable, clickable.
    // pointer-events land only on the pill itself (it is sized to content).
    '.ccv-callbar{position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;height:48px;box-sizing:border-box;max-width:min(92vw,520px);padding:0 8px 0 14px;border-radius:999px;background:rgba(6,7,10,.82);backdrop-filter:blur(6px);color:#e8eaed;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:auto;}',
    '.ccv-callbar[hidden]{display:none!important;}',
    '.ccv-callbar-orb{flex:0 0 auto;width:26px;height:26px;border-radius:50%;will-change:transform;transform:scale(calc(1 + var(--ccv-lvl,0)*.3));box-shadow:0 0 calc(4px + var(--ccv-lvl,0)*22px) calc(1px + var(--ccv-lvl,0)*6px) var(--ccv-glow,rgba(90,160,255,.5));background:radial-gradient(circle at 35% 32%,#9cc4ff,#2f6fd0 58%,#12305f);transition:box-shadow .1s linear,background .4s ease;}',
    '.ccv-callbar[data-state="speaking"] .ccv-callbar-orb{background:radial-gradient(circle at 35% 32%,#ffd08a,#e08a1e 58%,#6e3c05);--ccv-glow:rgba(240,169,0,.55);}',
    '.ccv-callbar[data-state="connecting"] .ccv-callbar-orb,.ccv-callbar[data-state="reconnecting"] .ccv-callbar-orb{animation:ccv-callbar-pulse 1.3s ease-in-out infinite;}',
    '@keyframes ccv-callbar-pulse{0%,100%{transform:scale(.85);}50%{transform:scale(1.15);}}',
    '.ccv-callbar-state{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;opacity:.85;direction:rtl;text-align:right;}',
    '.ccv-callbar-state[hidden]{display:none;}',
    '.ccv-callbar-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;}',
    '.ccv-callbtn{width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit;font-size:18px;line-height:1;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;}',
    '.ccv-callbtn[aria-pressed="true"]{background:rgba(56,140,255,.3);border-color:#388cff;}',
    '.ccv-callbtn.ccv-hangup{background:#e5484d;border-color:#e5484d;color:#fff;}',
    '.ccv-callbtn[hidden]{display:none!important;}',
    '.ccv-ptt-toggle{font-size:11px;font-weight:600;letter-spacing:.02em;}',
    '.ccv-ptt-hold{min-width:56px;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}',
    '@media (prefers-reduced-motion:reduce){.ccv-callbar-orb{animation:none!important;}}',
  ].join('');
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'ccv-bar';
  // Voice gate: the call button stays hidden until /voice/health says live:true.
  bar.hidden = true;

  const call = document.createElement('button');
  call.className = 'ccv-btn';
  call.type = 'button';
  call.title = 'Voice call';
  call.setAttribute('aria-label', 'Voice call');
  call.textContent = '📞';
  call.addEventListener('click', () => {
    void startCall();
  });

  bar.append(call);
  ui = { bar, call };
  applyVoiceGate();
}

function ensureCallUi() {
  if (callUi) return callUi;
  const pill = document.createElement('div');
  pill.className = 'ccv-callbar';
  pill.hidden = true;

  const orb = document.createElement('div');
  orb.className = 'ccv-callbar-orb';

  const state = document.createElement('div');
  state.className = 'ccv-callbar-state';
  state.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'ccv-callbar-actions';

  const mute = document.createElement('button');
  mute.className = 'ccv-callbtn';
  mute.type = 'button';
  mute.title = 'Mute';
  mute.setAttribute('aria-label', 'Mute microphone');
  mute.setAttribute('aria-pressed', 'false');
  mute.textContent = '🎙️';
  mute.addEventListener('click', () => safe(toggleMute));

  const hangup = document.createElement('button');
  hangup.className = 'ccv-callbtn ccv-hangup';
  hangup.type = 'button';
  hangup.title = 'Hang up';
  hangup.setAttribute('aria-label', 'Hang up');
  hangup.textContent = '☎';
  hangup.addEventListener('click', () => safe(endCall));

  const retry = document.createElement('button');
  retry.className = 'ccv-callbtn';
  retry.type = 'button';
  retry.title = 'Retry';
  retry.setAttribute('aria-label', 'Retry the call');
  retry.textContent = '↻';
  retry.hidden = true;
  retry.addEventListener('click', () => safe(retryCall));

  // Owner ruling Q9a (2026-10-10): the push-to-talk setting (default OFF,
  // remembered for the next calls) and its hold button, which replaces mute
  // only while the setting is ON.
  const pttToggle = document.createElement('button');
  pttToggle.className = 'ccv-callbtn ccv-ptt-toggle';
  pttToggle.type = 'button';
  pttToggle.title = 'Push-to-talk: off';
  pttToggle.setAttribute('aria-label', 'Push-to-talk setting');
  pttToggle.setAttribute('aria-pressed', 'false');
  pttToggle.textContent = 'PTT';
  pttToggle.addEventListener('click', () => safe(togglePushToTalk));

  const hold = document.createElement('button');
  hold.className = 'ccv-callbtn ccv-ptt-hold';
  hold.type = 'button';
  hold.title = 'Hold to talk (or hold Space)';
  hold.setAttribute('aria-label', 'Hold to talk');
  hold.setAttribute('aria-pressed', 'false');
  hold.textContent = '🗣️';
  hold.hidden = true;
  hold.addEventListener('pointerdown', (event) => safe(() => pttPointerDown(event)));
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
    hold.addEventListener(type, () => safe(() => ptt.release('pointer')));
  }
  hold.addEventListener('contextmenu', (event) => event.preventDefault());

  actions.append(retry, pttToggle, hold, mute, hangup);
  pill.append(orb, state, actions);
  callUi = { pill, orb, state, mute, hangup, retry, pttToggle, hold };
  renderPtt(ptt.snapshot());
  return callUi;
}

function showCallBar(stateName) {
  const elements = ensureCallUi();
  safe(() => {
    if (!elements.pill.isConnected) document.body.appendChild(elements.pill);
    elements.pill.dataset.state = stateName || 'connecting';
    const word = CALL_STATE_WORDS[stateName];
    elements.state.hidden = !word;
    elements.state.textContent = word || '';
    elements.retry.hidden = stateName !== 'unavailable';
    elements.mute.hidden = stateName === 'unavailable' && !callActive;
    renderPtt(ptt.snapshot());
    elements.pill.hidden = false;
  });
}

function hideCallBar() {
  safe(() => {
    if (callUi && callUi.pill.isConnected) callUi.pill.remove();
    if (callUi) callUi.pill.hidden = true;
  });
}

// Owner 2026-10-08: ↻ on the 'unavailable' bar — a live call retries in place
// (fresh Gemini session, mic kept); a call that never connected starts again.
function retryCall() {
  if (callActive && liveCallInstance) {
    safe(() => liveCallInstance.retry());
    return;
  }
  if (!callActive) void startCall();
}

// Owner 2026-10-07: a long explanation continues by itself — 3.5 s after
// Jimmy finishes a part (the owner silent meanwhile), the next part is pushed.
const EXPLAIN_GAP_MS = 3500;
let lastCallState = null;
let explainTimer = null;

function scheduleExplainPart(prev, stateName) {
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = null;
  if (prev !== 'speaking' || stateName !== 'listening') return;
  if (noiseTimer) return; // a barge-in is being checked: the noise path decides
  armExplainTimer();
}

function armExplainTimer(gapMs = EXPLAIN_GAP_MS) {
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = setTimeout(() => {
    explainTimer = null;
    if (!callActive || !liveCallInstance || lastCallState !== 'listening') return;
    if (safe(() => liveCallInstance.isModelBusy(), false)) return;
    const text = safe(() => bridge.nextExplainPart(), null);
    if (text) safe(() => liveCallInstance.pushText(text));
  }, gapMs);
}

// Owner 2026-10-07 (review LOW): a model turn with no speech (tool calls
// only) has no speaking->listening edge, so the next part must start here.
// A tool call itself ends a silent turn BEFORE Jimmy speaks the part the tool
// returned (smoke 2026-10-07), so this path waits longer; Jimmy starting to
// speak changes the call state, which clears the timer.
const SILENT_TURN_GAP_MS = 8000;
function scheduleExplainAfterSilentTurn(spoke) {
  if (spoke || noiseTimer || lastCallState !== 'listening') return;
  armExplainTimer(SILENT_TURN_GAP_MS);
}

// Owner 2026-10-07 (F3): room noise can still trip a barge-in and cut Jimmy
// off mid-part. When no owner words follow within NOISE_CHECK_MS, the app
// hands the cut part back so the explanation goes on instead of skipping it.
const NOISE_CHECK_MS = 3000;
let noiseTimer = null;

function clearNoiseTimer() {
  if (noiseTimer) clearTimeout(noiseTimer);
  noiseTimer = null;
}

function noteBargeIn() {
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = null;
  clearNoiseTimer();
  noiseTimer = setTimeout(() => {
    noiseTimer = null;
    if (!callActive || !liveCallInstance || lastCallState !== 'listening') return;
    const text = safe(() => bridge.resumeAfterNoise(), null);
    if (text) safe(() => liveCallInstance.pushText(text));
  }, NOISE_CHECK_MS);
}

const MUTED_WORD = '🔇 الصوت مقفول';

function handleCallState(stateName) {
  const prev = lastCallState;
  lastCallState = stateName;
  safe(() => scheduleExplainPart(prev, stateName));
  if (!callUi) return;
  safe(() => {
    callUi.pill.dataset.state = stateName || 'listening';
    // Q9a: with push-to-talk ON the closed mic is the normal state — no muted word.
    const muted = Boolean(liveCallInstance && liveCallInstance.isMuted()) && !ptt.enabled();
    const word = CALL_STATE_WORDS[stateName] || (muted ? MUTED_WORD : '');
    callUi.state.hidden = !word;
    callUi.state.textContent = word || '';
    callUi.retry.hidden = stateName !== 'unavailable';
    if (stateName === 'ended') endCall();
  });
}

function handleCallLevel({ mic, out } = {}) {
  if (!callUi) return;
  safe(() => {
    const level = Math.max(0, Math.min(1, Math.max(Number(mic) || 0, Number(out) || 0)));
    callUi.orb.style.setProperty('--ccv-lvl', level.toFixed(3));
  });
}

function toggleMute() {
  if (!liveCallInstance || !callUi) return;
  const next = !liveCallInstance.isMuted();
  safe(() => liveCallInstance.mute(next));
  callUi.mute.textContent = next ? '🔇' : '🎙️';
  if (!CALL_STATE_WORDS[lastCallState]) {
    callUi.state.hidden = !next;
    callUi.state.textContent = next ? MUTED_WORD : '';
  }
  callUi.mute.setAttribute('aria-pressed', String(next));
  callUi.mute.title = next ? 'Unmute' : 'Mute';
  callUi.mute.setAttribute('aria-label', next ? 'Unmute microphone' : 'Mute microphone');
}

// Owner ruling Q9a (2026-10-10): push-to-talk bar state. ON: the hold button
// replaces mute and no muted word is shown; OFF: hold hidden, mute exactly as
// showCallBar sets it.
function renderPtt(snapshot) {
  if (!callUi) return;
  const on = Boolean(snapshot && snapshot.enabled);
  callUi.pttToggle.setAttribute('aria-pressed', String(on));
  callUi.pttToggle.title = on ? 'Push-to-talk: on' : 'Push-to-talk: off';
  callUi.hold.setAttribute('aria-pressed', String(Boolean(snapshot && snapshot.held)));
  const noCall = callUi.pill.dataset.state === 'unavailable' && !callActive;
  callUi.hold.hidden = !on || noCall;
  callUi.mute.hidden = on || noCall;
  if (on && !CALL_STATE_WORDS[lastCallState]) {
    callUi.state.hidden = true;
    callUi.state.textContent = '';
  }
}

function togglePushToTalk() {
  const on = ptt.setEnabled(!ptt.enabled());
  if (on || !callUi || !liveCallInstance) return;
  // Back to OFF mid-call: the mute button shows the restored mute state.
  const muted = Boolean(liveCallInstance.isMuted());
  callUi.mute.textContent = muted ? '🔇' : '🎙️';
  callUi.mute.setAttribute('aria-pressed', String(muted));
  callUi.mute.title = muted ? 'Unmute' : 'Mute';
  callUi.mute.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  if (!CALL_STATE_WORDS[lastCallState]) {
    callUi.state.hidden = !muted;
    callUi.state.textContent = muted ? MUTED_WORD : '';
  }
}

function pttPointerDown(event) {
  if (event && typeof event.button === 'number' && event.button !== 0) return;
  if (event && typeof event.preventDefault === 'function') event.preventDefault(); // no focus, no text selection
  try {
    if (event && callUi && typeof callUi.hold.setPointerCapture === 'function') callUi.hold.setPointerCapture(event.pointerId);
  } catch {
    // capture refused: pointerup/pointerleave on the button still release
  }
  ptt.press('pointer');
}

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null; // denied or unsupported — the call continues anyway
  }
}

function releaseWakeLock() {
  safe(() => {
    if (wakeLock && typeof wakeLock.release === 'function') void wakeLock.release();
  });
  wakeLock = null;
}

// WO-VL-CTX: seed the model with the open session's recent history right
// after setupComplete — a silent "[SESSION CONTEXT]" briefing (turnComplete:
// false, so the model never speaks it). No session open → say exactly that.
// Never touches bridge.markUserTurn: context is data, not a user turn (F8).
const CONTEXT_PREFIX = '[SESSION CONTEXT] ';
// Owner 2026-10-07: the seed now carries the newest 3 claude messages whole
// (session-history total cap ~14k) — 160-char fragments left Jimmy nothing
// grounded to explain.
const CONTEXT_PUSH_MAX = 14400;
const CONTEXT_RETRY_MS = 15000;

// Owner 2026-10-07 (call 170008): a session started a minute before the call
// had no REST history yet, so the voice was told "no messages" while updates
// kept arriving. Fall back to the live progress snapshot, and when both are
// empty brief again once, 15 s later.
async function seedSessionContext(retry = false) {
  if (!liveCallInstance) return;
  const instance = liveCallInstance;
  let text = `${CONTEXT_PREFIX}no Claude session is open on screen (New chat or project screen). Nothing can be sent to Claude until the owner opens a session; voice never starts one.`;
  let body = '';
  const sessionId = callSession();
  if (sessionId) {
    try {
      const data = await sessionHistory.refresh(sessionId, { force: true });
      if (data && data.text) body = data.text;
    } catch {
      // history unavailable — the live snapshot below is the fallback
    }
    if (!body) body = safe(() => snapshotContext(progressLog.snapshot(sessionId)), '');
    if (body) text = (CONTEXT_PREFIX + body).slice(0, CONTEXT_PUSH_MAX);
    else {
      text = `${CONTEXT_PREFIX}the open session has no messages yet.`;
      if (!retry) {
        setTimeout(() => {
          if (liveCallInstance === instance) void seedSessionContext(true);
        }, CONTEXT_RETRY_MS);
      }
    }
  }
  if (retry && !body) return; // nothing new to brief
  if (liveCallInstance !== instance) return;
  safe(() => instance.pushContext(text));
}

let callTranscript = null;

// Sortable, unique per call: 20261007-161502-ab12cd34 (matches the gateway's
// [A-Za-z0-9-]{8,64} call-id rule).
function newCallId() {
  const t = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  const rand = (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 8);
  return `${stamp}-${rand}`;
}

async function startCall({ auto = false } = {}) {
  if (callActive) return;
  if (reloadIfOutdated(servedVersion)) return;
  callActive = true;
  if (auto) armAudioUnlock();
  callTarget.begin(); // R1/R7: the session on screen (URL only), or none yet
  beacon('call-start');
  // Owner ruling 2026-10-07: every call is recorded as a text transcript.
  safe(() => bridge.resetOwnerWords());
  callTranscript = safe(() => createCallTranscript({ url: config.transcriptUrl, callId: newCallId() }), null);
  const transcript = callTranscript; // bound per call: a tool result landing after hang-up is still recorded
  showCallBar('connecting');
  safe(() => {
    if (callUi) {
      callUi.mute.textContent = '🎙️'; // every call starts unmuted
      callUi.mute.setAttribute('aria-pressed', 'false');
    }
  });
  void acquireWakeLock();
  try {
    liveCallInstance = createLiveCall({
      tokenUrl: config.tokenUrl,
      tools: bridge.tools,
      onState: (stateName) => safe(() => handleCallState(stateName)),
      onLevel: (levels) => safe(() => handleCallLevel(levels)),
      onEvent: (name, n) => {
        beacon(name, n);
        if (name === 'barge-in') safe(noteBargeIn);
      },
      onTurnComplete: ({ spoke } = {}) => safe(() => {
        // Owner ruling 23:1x: the exact-words block starts after Jimmy last spoke.
        if (spoke) bridge.noteJimmySpoke();
        scheduleExplainAfterSilentTurn(spoke);
      }),
      onUserSpeech: (_spoken, raw) => safe(() => {
        if (APP_TEXT_RE.test(String(raw || ''))) return;
        clearNoiseTimer(); // the barge-in was the owner after all
        bridge.markUserTurn(raw); // F8: owner spoke — re-arm tool calls; raw words relayed to Claude
      }),
      onTranscript: (role, text) => safe(() => transcript && transcript.add(role, text)),
      // WO-3: a replacement Gemini session is told which orders already went out.
      replacementNote: () => safe(() => bridge.ordersNote(), ''),
    });
    const instance = liveCallInstance;
    safe(() => ptt.attach(instance)); // Q9a: PTT ON closes the mic before the first chunk
    void refreshServedVersion().then((served) => {
      if (callActive && liveCallInstance === instance && wouldReload(served)) {
        endCall();
        reloadIfOutdated(served);
      }
    });
    await liveCallInstance.start(); // resolves at setupComplete
    await seedSessionContext();
  } catch (error) {
    // F1: token/WS failures exhausted the retries — full teardown. If the owner
    // hung up during 'connecting', endCall() already tore everything down and
    // must stay torn down (no resurrected call bar).
    if (!callActive) return;
    callActive = false;
    callTarget.end();
    safe(() => bridge.callEnded()); // R2: nothing queued outlives the call
    const failed = liveCallInstance;
    safe(() => {
      if (failed) failed.stop();
    });
    liveCallInstance = null;
    safe(() => ptt.detach());
    releaseWakeLock();
    closeTranscriptAfterTools(failed, callTranscript);
    callTranscript = null;
    showCallBar('unavailable'); // owner 2026-10-08: say so and offer ↻, never vanish silently
    beacon('live-error');
    console.warn('[cloudcli-voice] call failed to start', error);
  }
}

// N3: a send_to_claude in flight at hang-up still finishes and its result is
// recorded — close the call's transcript once tools settle (max TOOLS_SETTLE_MS).
function closeTranscriptAfterTools(instance, transcript) {
  const settled = safe(() => instance && typeof instance.toolsSettled === 'function' ? instance.toolsSettled() : null, null);
  const closeTranscript = () => safe(() => {
    if (transcript) transcript.finish();
  });
  if (settled && typeof settled.then === 'function') {
    void Promise.race([settled, new Promise((resolve) => setTimeout(resolve, TOOLS_SETTLE_MS))]).then(closeTranscript, closeTranscript);
  } else {
    closeTranscript();
  }
}

function endCall() {
  if (!callActive) {
    hideCallBar(); // hang-up on the bar of a call that never connected
    return;
  }
  callActive = false;
  callTarget.end();
  safe(() => bridge.callEnded()); // R2 (owner 2026-10-09): an 'after' order is dropped on hang-up
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = null;
  clearNoiseTimer();
  lastCallState = null;
  const instance = liveCallInstance;
  liveCallInstance = null;
  safe(() => ptt.detach());
  safe(() => {
    if (instance) instance.stop();
  });
  releaseWakeLock();
  closeTranscriptAfterTools(instance, callTranscript);
  callTranscript = null;
  hideCallBar();
  beacon('call-end');
}

// Hang up / Escape both stop the call and remove the overlay (spec).
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (callActive || (callUi && !callUi.pill.hidden))) safe(endCall);
});

// Owner ruling Q9a: with push-to-talk ON during a call, holding Space outside a
// text field talks; keyup anywhere, a window blur or a hidden tab releases.
// OFF: nothing is consumed (keyDown/keyUp return false, release is a no-op).
document.addEventListener(
  'keydown',
  (event) => {
    if (callActive && safe(() => ptt.keyDown(event), false)) event.preventDefault();
  },
  true,
);
document.addEventListener(
  'keyup',
  (event) => {
    if (safe(() => ptt.keyUp(event), false)) event.preventDefault();
  },
  true,
);
window.addEventListener('blur', () => safe(() => ptt.release()));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') safe(() => ptt.release());
});

// R7 (owner 2026-10-09): closing the tab (or leaving the page) ends the call.
window.addEventListener('pagehide', () => {
  if (callActive) safe(endCall);
});

// Wake Lock is released by the browser on tab hide — re-acquire on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && callActive) void acquireWakeLock();
});

// --- Boot --------------------------------------------------------------------

function mountUi() {
  safe(syncMount);
}

// SPA navigation re-renders the composer: re-check the mount (and the open
// session for D7) once per frame after any DOM change.
const mountObserver = new MutationObserver(() => scheduleMountCheck());

function init() {
  patchWebSockets();
  mountUi();
  mountObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', () => scheduleMountCheck());
  refreshScheduler.onFire(synthesizeReconnectFrame);
  syncActivityPolling();
  syncSidebarPolling();
  syncOpenSession();
  void safe(checkVoiceHealth);
  safe(() => {
    window.setInterval(() => safe(checkVoiceHealth), 30000);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => safe(init));
} else {
  safe(init);
}
