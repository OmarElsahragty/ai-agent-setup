// Owner 2026-10-07 (call 211015): a tab opened before a deploy kept running the
// old add-on, so the gateway's new tools came back {error:'unknown_tool'} and
// Jimmy could not read a waiting plan. At call start the running version (the
// content hash in this module's own URL) is compared with the one the server
// serves now; a mismatch reloads the page once and the call starts by itself
// after the reload. Pure helpers — the add-on injects fetch, storage and clock.

export const AUTOCALL_KEY = 'voice-autocall';
export const RELOAD_KEY = 'voice-reloaded-at';
export const RELOAD_GUARD_MS = 60000; // never reload twice within a minute
export const AUTOCALL_MAX_AGE_MS = 60000; // a stale flag never starts a call
const VERSION_FETCH_TIMEOUT_MS = 3000;

const VERSION_RE = /\/voice-addon\/v\/([0-9a-f]{6,64})\//;

/** The content hash in a /voice-addon/v/<hash>/ URL or page, else null. */
export function versionFrom(text) {
  const match = VERSION_RE.exec(String(text || ''));
  return match ? match[1] : null;
}

/** 'reload' only when both versions are known, differ, and no reload happened
 *  in the last minute (loop guard); everything else starts the call. */
export function decideCallStart({ running, served, lastReloadAt, now }) {
  if (!running || !served || running === served) return 'call';
  const last = Number(lastReloadAt);
  if (Number.isFinite(last) && now - last >= 0 && now - last < RELOAD_GUARD_MS) return 'call';
  return 'reload';
}

/** True when the page was reloaded for a call less than a minute ago. */
export function shouldAutoCall({ flagAt, now }) {
  const at = Number(flagAt);
  return Number.isFinite(at) && now - at >= 0 && now - at < AUTOCALL_MAX_AGE_MS;
}

/** The version the server serves now (index.html is no-store), or null on any
 *  failure — a failed check never blocks the call (fail open). */
export async function fetchServedVersion(fetchFn, url = '/', { setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (typeof fetchFn !== 'function') return null;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve(null), VERSION_FETCH_TIMEOUT_MS);
    });
    const request = (async () => {
      const response = await fetchFn(url, { cache: 'no-store', credentials: 'same-origin' });
      if (!response || !response.ok) return null;
      return versionFrom(await response.text());
    })().catch(() => null);
    return await Promise.race([request, timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimer(timer);
  }
}
