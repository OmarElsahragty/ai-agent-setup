// Push-to-talk for the Gemini Live voice call (owner ruling Q9a, 2026-10-10):
// an optional, global add-on setting, DEFAULT OFF, persisted in localStorage.
//
// OFF: the controller never calls into the call. Every method is a no-op for
//      the call and no key event is consumed, so the call sends exactly what
//      it sends without this module.
// ON:  the call is muted through lib/live-call.mjs mute() (the room is never
//      forwarded: a zero-filled MUTE_SILENCE_MS tail lets the server close the
//      turn, then nothing goes up) except while the hold button or the PTT key
//      is held. Release mutes again, so the owner's turn ends and the reply
//      rescue still asks Gemini for an answer.
//
// One mode per call: attach() reads the setting ONCE and the attached call
// keeps that mode until setEnabled() in THIS tab. A toggle in another tab (the
// window `storage` event) never changes the mode of an attached call — the
// button keeps showing the mode the call really has, and the new setting
// applies once the call ends. With no call attached the button follows it at
// once.
//
// Pure and injectable: `flags` is lib/feature-flags.mjs createAddonFlags();
// the call is anything with mute(bool) and isMuted(); `storageEvents` is
// anything with addEventListener (default: window in a browser, none in Node).

export const FLAG_PUSH_TO_TALK = 'pushToTalk';
// Hold Space (Zoom's "hold to unmute" convention), never inside a text field.
export const PTT_KEY_CODE = 'Space';
// createAddonFlags stores a flag under `${namespace}:flag:${name}`.
const FLAG_KEY_SUFFIX = `:flag:${FLAG_PUSH_TO_TALK}`;

function defaultStorageEvents() {
  return typeof window !== 'undefined' && window && typeof window.addEventListener === 'function' ? window : null;
}

/** A storage event that may concern the PTT setting (key null = the storage was cleared). */
function isPttStorageEvent(event) {
  if (!event || event.key === null || event.key === undefined) return true;
  return String(event.key).endsWith(FLAG_KEY_SUFFIX);
}

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** True when a key event on this target types text (Space must stay a space). */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(String(target.type || 'text').toLowerCase());
  try {
    return typeof target.getAttribute === 'function' && target.getAttribute('role') === 'textbox';
  } catch {
    return false;
  }
}

/** A plain Space press outside a text field (no Ctrl/Alt/Meta, not composing). */
export function isPttKeyEvent(event) {
  if (!event || event.code !== PTT_KEY_CODE) return false;
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
  return !isEditableTarget(event.target);
}

/**
 * createPushToTalk({flags, onChange, storageEvents}) -> controller.
 *   enabled()            the mode in force (default OFF; only an explicit stored true
 *                        enables it): the attached call's mode, read ONCE at attach
 *   setEnabled(bool)     persist + apply to the attached call (ON: closed until held;
 *                        OFF: back to the mute state the owner had before ON)
 *   attach(call)/detach()  bind to the live call / forget it (holds cleared)
 *   press(source)/release(source?)  'pointer' | 'key'; release() clears every hold
 *   keyDown(event)/keyUp(event)  true = consumed (the caller prevents the default)
 *   storageChanged(event)  the window `storage` handler (subscribed automatically);
 *                        true = the shown setting followed another tab now
 *   snapshot()           {enabled, held, attached}; onChange(snapshot) after each change
 */
export function createPushToTalk({ flags = null, onChange = null, storageEvents = defaultStorageEvents() } = {}) {
  let choice = null; // this tab's own choice, in memory: storage may be unavailable (private mode)
  let callMode = null; // the attached call's mode, read ONCE at attach(); null = no call
  let call = null;
  let mutedBeforeOn = false;
  const holds = new Set();

  function stored() {
    try {
      return Boolean(flags && typeof flags.isEnabled === 'function' && flags.isEnabled(FLAG_PUSH_TO_TALK, false));
    } catch {
      return false;
    }
  }

  function enabled() {
    if (callMode !== null) return callMode;
    return choice !== null ? choice : stored();
  }

  function snapshot() {
    return { enabled: enabled(), held: holds.size > 0, attached: Boolean(call) };
  }

  function notify() {
    if (typeof onChange !== 'function') return;
    try {
      onChange(snapshot());
    } catch {
      // a UI failure must never break the call
    }
  }

  function setCallMuted(value) {
    if (call && typeof call.mute === 'function') call.mute(value);
  }

  function callMuted() {
    try {
      return Boolean(call && typeof call.isMuted === 'function' && call.isMuted());
    } catch {
      return false;
    }
  }

  function press(source = 'pointer') {
    if (!call || !enabled()) return false;
    const first = holds.size === 0;
    holds.add(source);
    if (first) {
      setCallMuted(false);
      notify();
    }
    return true;
  }

  function release(source = null) {
    if (!holds.size) return false;
    if (source === null) holds.clear();
    else holds.delete(source);
    if (holds.size) return false; // another source still holds the mic open
    if (enabled()) setCallMuted(true);
    notify();
    return true;
  }

  function attach(instance) {
    call = instance || null;
    holds.clear();
    mutedBeforeOn = false; // every call starts unmuted
    callMode = null;
    if (call) callMode = enabled(); // read ONCE: another tab never changes this call's mode
    if (call && callMode) setCallMuted(true);
    notify();
  }

  function detach() {
    call = null;
    callMode = null; // back to this tab's choice / the stored setting
    holds.clear();
    notify();
  }

  function setEnabled(value) {
    const next = Boolean(value);
    const was = enabled();
    choice = next;
    if (call) callMode = next; // this tab's own toggle does switch the attached call
    try {
      if (flags && typeof flags.setEnabled === 'function') flags.setEnabled(FLAG_PUSH_TO_TALK, next);
    } catch {
      // storage unavailable: the in-memory choice still applies to this tab
    }
    if (next !== was) {
      holds.clear();
      if (call) {
        if (next) {
          mutedBeforeOn = callMuted();
          setCallMuted(true);
        } else {
          setCallMuted(mutedBeforeOn);
        }
      }
    }
    notify();
    return next;
  }

  function keyDown(event) {
    if (!call || !enabled() || !isPttKeyEvent(event)) return false;
    if (!holds.has('key')) press('key');
    return true; // repeats while held are consumed too (no page scroll)
  }

  function keyUp(event) {
    // Released anywhere — even inside a text field — so a hold that started
    // outside one can never leave the mic open.
    if (!event || event.code !== PTT_KEY_CODE || !holds.has('key')) return false;
    release('key');
    return true;
  }

  function storageChanged(event) {
    if (!isPttStorageEvent(event)) return false;
    choice = null; // the newest stored value wins over this tab's older choice
    if (call) return false; // the attached call keeps its mode; the new one applies after it
    notify(); // no call: the toggle shows the new setting at once
    return true;
  }

  if (storageEvents && typeof storageEvents.addEventListener === 'function') {
    try {
      storageEvents.addEventListener('storage', storageChanged);
    } catch {
      // no storage events: this tab's own choice still applies
    }
  }

  return {
    enabled,
    setEnabled,
    attach,
    detach,
    press,
    release,
    keyDown,
    keyUp,
    storageChanged,
    snapshot,
    isHeld: () => holds.size > 0,
  };
}
