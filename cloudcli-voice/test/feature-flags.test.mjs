import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddonFlags, FLAG_LIVE_REFRESH, FLAG_BG_JOBS } from '../lib/feature-flags.mjs';

function memoryStorage(initial = new Map()) {
  return {
    getItem: (k) => (initial.has(k) ? initial.get(k) : null),
    setItem: (k, v) => initial.set(k, String(v)),
    removeItem: (k) => initial.delete(k),
    _dump: initial,
  };
}

test('flags default to ON and only explicit values override', () => {
  const flags = createAddonFlags(memoryStorage());
  assert.equal(flags.isEnabled(FLAG_LIVE_REFRESH, true), true);
  assert.equal(flags.isEnabled(FLAG_BG_JOBS, true), true);
  flags.setEnabled(FLAG_LIVE_REFRESH, false);
  assert.equal(flags.isEnabled(FLAG_LIVE_REFRESH, true), false);
  assert.equal(flags.isEnabled(FLAG_BG_JOBS, true), true);
});

test('legacy truthy "1" and falsy "0" encodings round-trip', () => {
  const storage = memoryStorage(new Map([['cloudcli-voice:flag:bgJobs', '0'], ['cloudcli-voice:flag:liveRefresh', '1']]));
  const flags = createAddonFlags(storage);
  assert.equal(flags.isEnabled(FLAG_BG_JOBS, true), false);
  assert.equal(flags.isEnabled(FLAG_LIVE_REFRESH, true), true);
});

test('corrupt values fall back to the default instead of silently disabling', () => {
  const storage = memoryStorage(new Map([['cloudcli-voice:flag:liveRefresh', 'yes']]));
  const flags = createAddonFlags(storage);
  assert.equal(flags.isEnabled(FLAG_LIVE_REFRESH, true), true);
  assert.equal(flags.isEnabled(FLAG_LIVE_REFRESH, false), false);
});

test('throwing or missing storage never crashes', () => {
  const exploding = {
    getItem: () => {
      throw new Error('quota');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  const flags = createAddonFlags(exploding);
  assert.equal(flags.isEnabled(FLAG_LIVE_REFRESH, true), true);
  assert.doesNotThrow(() => flags.setEnabled(FLAG_LIVE_REFRESH, false));
  assert.equal(flags.isEnabled(null), true);
  assert.equal(createAddonFlags(null).isEnabled(FLAG_BG_JOBS, true), true);
});

test('flag keys live under the add-on namespace', () => {
  const storage = memoryStorage();
  const flags = createAddonFlags(storage);
  flags.setEnabled(FLAG_LIVE_REFRESH, false);
  assert.ok(storage._dump.has('cloudcli-voice:flag:liveRefresh'));
});
