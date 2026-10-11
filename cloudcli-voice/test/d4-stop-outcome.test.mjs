// D4 item 4: stop_claude reports the REAL outcome of the abort.
// Negative control: D4_VOICE_BRIDGE=<pre-D4 lib/voice-bridge.mjs> must FAIL.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProgressLog } from '../lib/progress-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = process.env.D4_VOICE_BRIDGE || path.join(HERE, '..', 'lib', 'voice-bridge.mjs');
const { createVoiceBridge } = await import(pathToFileURL(MODULE).href);

function makeBridge(abortResult) {
  const calls = [];
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => true },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => {
      calls.push('abort');
      return abortResult;
    },
    delay: async () => {},
    isCallActive: () => true,
  });
  bridge.markUserTurn('');
  return { bridge, calls, progressLog };
}

test('D4: stop_claude answers stop_failed (not stopped) when the abort frame was not sent', async () => {
  const { bridge, calls } = makeBridge(false);
  const out = await bridge.tools.stop_claude();
  assert.deepEqual(calls, ['abort']);
  assert.equal(out.result, undefined, 'never claims stopped');
  assert.equal(out.error, 'stop_failed');
  assert.match(out.note, /NOT reach Claude/);
});

test('D4: a failed stop hands the owner-turn gate back (the same utterance may retry once)', async () => {
  const { bridge, calls } = makeBridge(false);
  assert.equal((await bridge.tools.stop_claude()).error, 'stop_failed');
  assert.equal((await bridge.tools.stop_claude()).error, 'stop_failed', 'gate restored: second attempt reaches abort, not no_user_turn');
  assert.deepEqual(calls, ['abort', 'abort']);
});

test('D4: a delivered abort reports stopped and consumes the gate', async () => {
  const { bridge, calls } = makeBridge(true);
  assert.deepEqual(await bridge.tools.stop_claude(), { result: 'stopped' });
  assert.deepEqual(await bridge.tools.stop_claude(), { error: 'no_user_turn' }, 'one utterance powers one stop');
  assert.deepEqual(calls, ['abort']);
});

test('D4: after a failed stop, a later aborted complete is NOT treated as self-caused (it is still news)', async () => {
  const pushed = [];
  const progressLog = createProgressLog();
  const bridge = createVoiceBridge({
    progressLog,
    runTracker: { isActive: () => true },
    getSession: () => 's1',
    insertAndSend: async () => true,
    abort: () => false,
    delay: async () => {},
    isCallActive: () => true,
  });
  bridge.onComplete((update) => pushed.push(update));
  bridge.markUserTurn('');
  assert.equal((await bridge.tools.stop_claude()).error, 'stop_failed');
  progressLog.feed({ kind: 'complete', sessionId: 's1', seq: 1, aborted: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pushed.filter((u) => u.type === 'complete').length, 1, 'an abort the bridge did not send is reported to the call');
});
