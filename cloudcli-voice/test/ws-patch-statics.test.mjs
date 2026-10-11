// Regression: the WebSocket wrapper must keep the static readyState constants.
// CloudCLI 1.37.3 sends only when `socket.readyState === WebSocket.OPEN`; losing
// `OPEN` silently dropped every chat.send (QA-LIVE R1, 2026-10-07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isSameOriginSocketUrl } from '../lib/session-target.mjs';

const src = readFileSync(new URL('../voice-addon.js', import.meta.url), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}()`);
}

function extractPatchFn() {
  // WO-3: the wrapper consults lib/session-target.mjs isSameOriginSocketUrl
  // (same-origin sockets only) — the vm contexts below hand it in.
  return extractFn('patchWebSockets');
}

test('patched WebSocket keeps CONNECTING/OPEN/CLOSING/CLOSED and instanceof', () => {
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; }
    send(d) { this.sent.push(d); }
    addEventListener() {}
  }
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const window = { WebSocket: FakeWS };
  const ctx = vm.createContext({
    window, isSameOriginSocketUrl, safe: (fn) => { try { fn(); } catch (_) {} },
    runTracker: { noteOutgoing() {}, noteFrame() {} }, currentSession: null,
    noteSessionChanged() {}, maybeScheduleLiveRefresh() {}, handleCues() {}, feedHeadlines() {},
    watcher: { feed: () => [] }, headlineWatcher: { feed: () => [] },
    outgoingSendCount: 0, chatSocket: null, kindSocket: null,
  });
  vm.runInContext(`${extractPatchFn()}\npatchWebSockets();`, ctx);
  const WS = window.WebSocket;
  assert.notEqual(WS, FakeWS, 'wrapper installed');
  for (const [k, v] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    assert.equal(WS[k], v, `WebSocket.${k}`);
  }
  const s = new WS('ws://x/ws');
  assert.ok(s instanceof WS && s instanceof FakeWS);
  // the app's own send gate
  assert.equal(s.readyState === WS.OPEN, true);
  s.send(JSON.stringify({ type: 'chat.send', sessionId: 'abc', content: 'hi' }));
  assert.equal(s.sent.length, 1, 'frame forwarded');
});

// WO-3 (optional item 6): only the page's own sockets are wrapped, via
// Reflect.construct; the Gemini Live socket stays a plain WebSocket.
test('only same-origin sockets are wrapped; foreign sockets stay untouched (Reflect.construct)', () => {
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.listeners = 0; }
    send(d) { this.sent.push(d); }
    addEventListener() { this.listeners += 1; }
  }
  Object.assign(FakeWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const window = { WebSocket: FakeWS, location: { host: 'agent.example', href: 'https://agent.example/session/A' } };
  const ctx = vm.createContext({
    window, isSameOriginSocketUrl, safe: (fn) => { try { fn(); } catch (_) {} },
    runTracker: { noteOutgoing() {}, noteFrame() {} }, currentSession: null,
    noteSessionChanged() {}, maybeScheduleLiveRefresh() {}, progressLog: { feed() {} },
    outgoingSendCount: 0, chatSocket: null, kindSocket: null,
  });
  vm.runInContext(`${extractPatchFn()}\npatchWebSockets();`, ctx);
  const WS = window.WebSocket;
  const frame = JSON.stringify({ type: 'chat.send', sessionId: 'A', content: 'hi' });
  const page = new WS('wss://agent.example/ws');
  const relative = new WS('/ws');
  const gemini = new WS('wss://generativelanguage.googleapis.com/ws/live?access_token=x');
  for (const s of [page, relative, gemini]) assert.ok(s instanceof WS && s instanceof FakeWS);
  assert.equal(page.listeners, 1, 'page socket wrapped');
  assert.equal(relative.listeners, 1, 'relative URL = page origin, wrapped');
  assert.equal(gemini.listeners, 0, 'foreign socket not wrapped');
  assert.ok(Object.prototype.hasOwnProperty.call(page, 'send'), 'page send is intercepted');
  assert.ok(!Object.prototype.hasOwnProperty.call(gemini, 'send'), 'foreign send is the plain method');
  page.send(frame);
  gemini.send(frame);
  assert.equal(ctx.outgoingSendCount, 1, 'only the page socket counts chat sends');
  assert.equal(gemini.sent.length, 1, 'foreign frames still go out');
});
