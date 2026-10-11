// Call transcript recorder (owner ruling 2026-10-07): everything said in a
// voice call — the owner's words, Gemini's words, tool calls/results, the
// session-context briefing and Claude updates — is batched and POSTed to the
// gateway (/voice/transcript?call=<id>), which appends it as JSONL so Claude
// can review the call afterwards.
//
// Live transcription arrives in fragments; consecutive owner/gemini fragments
// are merged into one entry until the speaker changes. Other roles are always
// their own entry. Batches flush every FLUSH_MS and on finish() (keepalive).

const FLUSH_MS = 4000;
const MERGED_ROLES = new Set(['owner', 'gemini']);

/**
 * deps: {fetch, now, setTimeout, clearTimeout} — injectable for tests.
 * Returns {add(role, text), finish()}.
 */
export function createCallTranscript({ url = '/voice/transcript', callId, deps = {} } = {}) {
  const d = {
    fetch: deps.fetch || globalThis.fetch.bind(globalThis),
    now: deps.now || (() => Date.now()),
    setTimeout: deps.setTimeout || globalThis.setTimeout.bind(globalThis),
    clearTimeout: deps.clearTimeout || globalThis.clearTimeout.bind(globalThis),
  };
  const target = `${url}?call=${encodeURIComponent(callId)}`;
  const pending = [];
  let open = null; // the owner/gemini entry still receiving fragments
  let timer = null;
  let finished = false;

  function add(role, text) {
    if (finished || typeof text !== 'string' || !text) return;
    if (MERGED_ROLES.has(role)) {
      if (open && open.role === role) {
        open.text += text;
      } else {
        open = { t: d.now(), role, text };
        pending.push(open);
      }
    } else {
      open = null;
      pending.push({ t: d.now(), role, text });
    }
    if (!timer) timer = d.setTimeout(() => flush(false), FLUSH_MS);
  }

  function flush(final) {
    if (timer) d.clearTimeout(timer);
    timer = null;
    // An open spoken entry may still grow; keep it for the next batch unless final.
    const keep = !final && open && pending[pending.length - 1] === open ? pending.pop() : null;
    const batch = pending.splice(0, pending.length).map((e) => ({ t: e.t, role: e.role, text: e.role === 'owner' || e.role === 'gemini' ? e.text.trim() : e.text }));
    if (keep) {
      pending.push(keep);
      timer = d.setTimeout(() => flush(false), FLUSH_MS);
    } else {
      open = null;
    }
    const entries = batch.filter((e) => e.text);
    if (!entries.length) return;
    try {
      void Promise.resolve(
        d.fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries }),
          credentials: 'include',
          keepalive: !!final,
        }),
      ).catch(() => {});
    } catch {
      // transcript loss must never break the call
    }
  }

  function finish() {
    if (finished) return;
    flush(true);
    finished = true;
  }

  return { add, finish };
}
