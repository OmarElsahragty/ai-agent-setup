// P1 helper (WO-E1): decides whether an async subagent without a
// <task-notification> should still be rendered as "running".
// Extracted into its own dependency-free module so it stays unit-testable.
const DEFAULT_SUBAGENT_LIVE_MS = 10 * 60 * 1000;

export function subagentLiveWindowMs(env = process.env) {
    const parsed = parseInt(env?.CLOUDCLI_SUBAGENT_LIVE_MS, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SUBAGENT_LIVE_MS;
}

export function isSubagentStillLive(subagent, nowMs = Date.now(), env = process.env) {
    if (!subagent) {
        return false;
    }
    if (subagent.endedMidToolCall === true) {
        return true;
    }
    const transcriptMtime = Number(subagent.transcriptMtime) || 0;
    if (transcriptMtime <= 0) {
        return false;
    }
    return nowMs - transcriptMtime < subagentLiveWindowMs(env);
}
