// Global (not per-session) add-on feature flags, persisted in localStorage.
// Only an explicit "false"/"0" disables a flag; missing or corrupt values fall
// back to the default, so a default-ON feature cannot be silently disabled by
// storage corruption.

export const FLAG_LIVE_REFRESH = 'liveRefresh';
export const FLAG_BG_JOBS = 'bgJobs';

function safeStorage(storage) {
  const noop = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  if (!storage || typeof storage.getItem !== 'function') return noop;
  return storage;
}

export function createAddonFlags(storage, namespace = 'cloudcli-voice') {
  const store = safeStorage(storage);

  function key(name) {
    return `${namespace}:flag:${name}`;
  }

  return {
    isEnabled(name, fallback = true) {
      try {
        const raw = store.getItem(key(name));
        if (raw === null || raw === undefined) return fallback;
        if (raw === 'false' || raw === '0') return false;
        if (raw === 'true' || raw === '1') return true;
        return fallback;
      } catch {
        return fallback;
      }
    },
    setEnabled(name, value) {
      try {
        store.setItem(key(name), value ? 'true' : 'false');
      } catch {
        // storage unavailable (private mode/quota) — flag stays in-memory default
      }
    },
  };
}
