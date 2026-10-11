// Owner 2026-10-07 (call 211015): an outdated tab reloads once, then calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  versionFrom,
  decideCallStart,
  shouldAutoCall,
  fetchServedVersion,
  RELOAD_GUARD_MS,
  AUTOCALL_MAX_AGE_MS,
} from '../lib/addon-version.mjs';

const PAGE = '<script type="module" src="/voice-addon/v/ba24e7a3a550/voice-addon.js"></script>';

test('versionFrom reads the hash from the module URL and from the served page', () => {
  assert.equal(versionFrom('https://${AI_SETUP_DOMAIN}/voice-addon/v/da064617bd74/voice-addon.js'), 'da064617bd74');
  assert.equal(versionFrom(PAGE), 'ba24e7a3a550');
  assert.equal(versionFrom('<html>no add-on</html>'), null);
  assert.equal(versionFrom(undefined), null);
});

test('decideCallStart reloads only on a known, different version', () => {
  const now = 1_000_000;
  assert.equal(decideCallStart({ running: 'aaa111', served: 'bbb222', lastReloadAt: null, now }), 'reload');
  assert.equal(decideCallStart({ running: 'aaa111', served: 'aaa111', lastReloadAt: null, now }), 'call');
  assert.equal(decideCallStart({ running: 'aaa111', served: null, lastReloadAt: null, now }), 'call'); // fail open
  assert.equal(decideCallStart({ running: null, served: 'bbb222', lastReloadAt: null, now }), 'call');
});

test('decideCallStart never reloads twice within a minute (loop guard)', () => {
  const now = 1_000_000;
  assert.equal(decideCallStart({ running: 'aaa111', served: 'bbb222', lastReloadAt: now - 5000, now }), 'call');
  assert.equal(decideCallStart({ running: 'aaa111', served: 'bbb222', lastReloadAt: now - RELOAD_GUARD_MS, now }), 'reload');
  assert.equal(decideCallStart({ running: 'aaa111', served: 'bbb222', lastReloadAt: 'junk', now }), 'reload');
});

test('shouldAutoCall honours only a fresh flag', () => {
  const now = 2_000_000;
  assert.equal(shouldAutoCall({ flagAt: String(now - 3000), now }), true);
  assert.equal(shouldAutoCall({ flagAt: now - AUTOCALL_MAX_AGE_MS, now }), false);
  assert.equal(shouldAutoCall({ flagAt: null, now }), false);
  assert.equal(shouldAutoCall({ flagAt: now + 5000, now }), false); // clock skew
});

test('fetchServedVersion asks for a no-store copy and fails open', async () => {
  let seen = null;
  const ok = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, text: async () => PAGE };
  };
  assert.equal(await fetchServedVersion(ok), 'ba24e7a3a550');
  assert.equal(seen.url, '/');
  assert.equal(seen.opts.cache, 'no-store');
  assert.equal(await fetchServedVersion(async () => ({ ok: false, text: async () => PAGE })), null);
  assert.equal(await fetchServedVersion(async () => { throw new Error('offline'); }), null);
  assert.equal(await fetchServedVersion(null), null);
});

test('fetchServedVersion gives up on a hung request', async () => {
  const hung = () => new Promise(() => {});
  const fakeTimer = (fn) => { fn(); return 1; };
  assert.equal(await fetchServedVersion(hung, '/', { setTimer: fakeTimer, clearTimer: () => {} }), null);
});
