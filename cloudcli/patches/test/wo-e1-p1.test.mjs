// WO-E1 P1: async-subagent "running" decision helper (patches/files/subagent-live.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubagentStillLive, subagentLiveWindowMs } from '../files/subagent-live.js';

const NOW = 1_800_000_000_000;

test('P1: endedMidToolCall alone marks the subagent live', () => {
    assert.equal(isSubagentStillLive({ endedMidToolCall: true, transcriptMtime: 0 }, NOW), true);
    assert.equal(isSubagentStillLive({ endedMidToolCall: true, transcriptMtime: NOW - 10_000_000 }, NOW), true);
});

test('P1: transcript touched within the live window is live', () => {
    assert.equal(isSubagentStillLive({ endedMidToolCall: false, transcriptMtime: NOW - 1_000 }, NOW), true);
    assert.equal(isSubagentStillLive({ endedMidToolCall: false, transcriptMtime: NOW }, NOW), true);
});

test('P1: transcript older than the window is not live', () => {
    assert.equal(isSubagentStillLive({ endedMidToolCall: false, transcriptMtime: NOW - 600_001 }, NOW), false);
});

test('P1: missing or zero mtime is not live (worker waiting on a background job has no transcript)', () => {
    assert.equal(isSubagentStillLive({ endedMidToolCall: false, transcriptMtime: 0 }, NOW), false);
    assert.equal(isSubagentStillLive({ endedMidToolCall: false }, NOW), false);
});

test('P1: null subagent is handled at the call site, helper returns false', () => {
    assert.equal(isSubagentStillLive(null, NOW), false);
    assert.equal(isSubagentStillLive(undefined, NOW), false);
});

test('P1: CLOUDCLI_SUBAGENT_LIVE_MS overrides the window', () => {
    const env = { CLOUDCLI_SUBAGENT_LIVE_MS: '1000' };
    assert.equal(isSubagentStillLive({ endedMidToolCall: false, transcriptMtime: NOW - 500 }, NOW, env), true);
    assert.equal(isSubagentStillLive({ endedMidToolCall: false, transcriptMtime: NOW - 2_000 }, NOW, env), false);
});

test('P1: invalid CLOUDCLI_SUBAGENT_LIVE_MS falls back to the 600000 default', () => {
    assert.equal(subagentLiveWindowMs({}), 600000);
    assert.equal(subagentLiveWindowMs({ CLOUDCLI_SUBAGENT_LIVE_MS: 'abc' }), 600000);
    assert.equal(subagentLiveWindowMs({ CLOUDCLI_SUBAGENT_LIVE_MS: '-5' }), 600000);
    assert.equal(subagentLiveWindowMs({ CLOUDCLI_SUBAGENT_LIVE_MS: '0' }), 0);
});

test('P1: default window is 600000 ms', () => {
    assert.equal(subagentLiveWindowMs({ CLOUDCLI_SUBAGENT_LIVE_MS: '120000' }), 120000);
});
