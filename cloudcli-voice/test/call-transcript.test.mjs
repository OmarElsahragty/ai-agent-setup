// Call transcript recorder (owner ruling 2026-10-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallTranscript } from '../lib/call-transcript.mjs';

function harness() {
  const posts = [];
  const timers = [];
  let clock = 1000;
  const rec = createCallTranscript({
    callId: '20261007-161502-ab12cd34',
    deps: {
      fetch: async (url, init) => posts.push({ url, init, body: JSON.parse(init.body) }),
      now: () => (clock += 10),
      setTimeout: (fn) => (timers.push(fn), timers.length),
      clearTimeout: () => {},
    },
  });
  const fire = () => {
    const fn = timers.shift();
    if (fn) fn();
  };
  return { rec, posts, fire };
}

test('merges spoken fragments per speaker, keeps tool/update entries separate, posts to the call url', () => {
  const h = harness();
  h.rec.add('context', '[SESSION CONTEXT] user: deploy');
  h.rec.add('owner', ' قول');
  h.rec.add('owner', ' لكلود');
  h.rec.add('tool-call', 'get_claude_status {}');
  h.rec.add('gemini', 'تمام،');
  h.rec.add('gemini', ' قلتله.');
  h.rec.add('owner', 'شكرا');
  h.rec.finish();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].url, '/voice/transcript?call=20261007-161502-ab12cd34');
  assert.equal(h.posts[0].init.keepalive, true); // final flush survives page unload
  assert.equal(h.posts[0].init.credentials, 'include');
  assert.deepEqual(
    h.posts[0].body.entries.map((e) => [e.role, e.text]),
    [
      ['context', '[SESSION CONTEXT] user: deploy'],
      ['owner', 'قول لكلود'],
      ['tool-call', 'get_claude_status {}'],
      ['gemini', 'تمام، قلتله.'],
      ['owner', 'شكرا'],
    ],
  );
  assert.ok(h.posts[0].body.entries.every((e) => typeof e.t === 'number'));
});

test('a periodic flush keeps the still-open spoken entry for the next batch (no split sentences)', () => {
  const h = harness();
  h.rec.add('tool-call', 'stop_claude {}');
  h.rec.add('gemini', 'خلاص');
  h.fire(); // periodic flush
  assert.deepEqual(h.posts[0].body.entries.map((e) => e.role), ['tool-call']);
  h.rec.add('gemini', ' وقفته.');
  h.rec.finish();
  assert.deepEqual(h.posts[1].body.entries.map((e) => [e.role, e.text]), [['gemini', 'خلاص وقفته.']]);
});

test('finish is idempotent and nothing is recorded after it; empty batches never post', () => {
  const h = harness();
  h.rec.finish();
  assert.equal(h.posts.length, 0);
  h.rec.add('owner', 'late');
  h.rec.finish();
  assert.equal(h.posts.length, 0);
});

test('a failing fetch never throws into the call', () => {
  const rec = createCallTranscript({
    callId: 'abcdefgh',
    deps: { fetch: () => { throw new Error('offline'); }, now: () => 1, setTimeout: () => 1, clearTimeout: () => {} },
  });
  rec.add('owner', 'x');
  assert.doesNotThrow(() => rec.finish());
});
