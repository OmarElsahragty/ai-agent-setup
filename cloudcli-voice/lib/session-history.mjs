// WO-VL-CTX: REST history seeding for the Gemini-Live call bridge.
// Pure: fetch / localStorage / now / timers are all injectable. Fetches the
// CloudCLI conversation-history route for the open session and (a) feeds the
// NormalizedMessages SILENTLY through progress-log (REST frames carry no seq,
// and history complete/error events must never fire the proactive push sink
// into the live call) so get_claude_status has a real snapshot even for a
// session opened long before the page loaded, and (b) builds a compact
// `history` briefing for the model: last ≤30 turns, one line each (≤160
// chars, code fences/paths/URLs stripped), ≤4 KB total.
//
// Pagination contract (server/shared/utils.ts sliceTailPage): items are
// oldest-first and offset counts BACK from the newest message — offset=0 with
// limit=N returns the most recent N messages. So the "last 30" is a single
// request: ?limit=30&offset=0 (no total probe needed).
//
// Throttle: at most one fetch per session per 10 s (refresh(sessionId,
// {force:true}) bypasses it — used once at call start). Failures keep the
// last good data and never throw.

const LINE_MAX = 160;
// Owner 2026-10-07 (call 200133, "Jimmy was making things up"): the newest
// claude messages reach the voice WHOLE — one-line 160-char fragments left
// nothing grounded to explain. Older lines stay one-line.
const FULL_CLAUDE_COUNT = 3;
const FULL_LINE_MAX = 3500;
const QUESTION_LINE_MAX = 1200;
const HISTORY_MAX = 14000;
// read_claude_message: one full claude message, a little longer than the seed.
const READ_MESSAGE_MAX = 6000;
const READ_KEEP = 10;
const OLDER_PAGE = 120; // one extra page of older messages for read_claude_message
const FETCH_TIMEOUT_MS = 5000;

// Tool-input keys that usually name the target of the call, in preference
// order; the first string value found becomes the short target.
const TARGET_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'file',
  'command',
  'cmd',
  'pattern',
  'url',
  'query',
  'description',
  'name',
  'title',
];

export function stripLine(raw) {
  let text = String(raw || '');
  text = text.replace(/```[\s\S]*?(```|$)/g, ' ');
  text = text.replace(/~~~[\s\S]*?(~~~|$)/g, ' ');
  text = text.replace(/`[^`\n]*`/g, ' ');
  // Secrets never reach the voice model: bearer/API keys, AWS/Google keys,
  // JWTs and user:pass@host credentials are dropped before anything else.
  text = text.replace(
    /\b(Bearer\s+\S+|(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|github_pat_|xox[baprs]-)[A-Za-z0-9._+=-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|[\w.+-]+:[\w.-]+@\S+)/g,
    ' ',
  );
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(/\bwww\.\S+/g, ' ');
  text = text.replace(/\b[\w.$/-]*[A-Za-z_.$/-][\w.$/-]*:\d+(:\d+)?\b/g, ' ');
  text = text.replace(/\S*[\\/]\S*/g, (token) => (token.length >= 5 ? ' ' : token));
  return text.replace(/\s+/g, ' ').trim();
}

function capTo(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function capLine(text) {
  return capTo(text, LINE_MAX);
}

/** Cuts long text at the last sentence end before `max` (never mid-word). */
function clipSentence(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf('؟ '));
  return `${end > max / 2 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(' '))} …`;
}

// Owner 2026-10-07 (R2): employee notices ride the user role but are NOT the
// owner's words — <task-notification>/<system-reminder>/other XML-ish system
// wrappers become a labelled notice, never "user:".
function systemNotice(raw) {
  const text = String(raw || '').trim();
  const wrapper = /^<([A-Za-z][\w-]*)>[\s\S]*<\/\1>$/.exec(text);
  if (!wrapper) return null;
  const summaries = [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
    .map((match) => stripLine(match[1]))
    .filter(Boolean);
  if (summaries.length) return summaries.join(' ');
  return stripLine(text.replace(/^<([A-Za-z][\w-]*)>/, '').replace(/<\/[A-Za-z][\w-]*>$/, ''));
}

// Owner 2026-10-07 (R3): Jimmy must see the on-screen questions and their
// choices, not just the tool name. The stock client merges the owner's answers
// into toolInput.answers once they are given on screen.
function questionLine(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions.filter(Boolean) : [];
  const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : null;
  if (!questions.length) return capTo('tool: AskUserQuestion (questions not captured)', LINE_MAX);
  const parts = questions.map((question) => {
    const labels = (Array.isArray(question.options) ? question.options : [])
      .map((option) => (typeof option === 'string' ? option : option && typeof option.label === 'string' ? option.label : ''))
      .filter(Boolean)
      .map((label) => stripLine(label))
      .filter(Boolean);
    let part = `Q: ${stripLine(question.question)}`;
    if (labels.length) part += ` [${labels.join(' | ')}]`;
    const answer = answers ? answers[question.question] : undefined;
    if (typeof answer === 'string' && answer.trim()) part += ` => ${stripLine(answer)}`;
    return part;
  });
  return capTo(parts.join(' ; '), QUESTION_LINE_MAX);
}

// Owner 2026-10-07 (WO-VP-PLOG R7): the plan itself is the question — approval
// stays on screen, so the history line carries only a 300-char head and points
// at read_claude_message for the full plan (no more 3500-char clipping).
function planLine(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const head = clipSentence(stripLine(input.plan), 300).replace(/\s*…\s*$/, '');
  return capTo(`plan waiting for approval: ${head || '(no plan text)'} … (full plan: read_claude_message plan:true)`, FULL_LINE_MAX + 32);
}

function shortTarget(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  for (const key of TARGET_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) return stripLine(value);
  }
  return '';
}

/** One compact line per message; unknown kinds produce no line. AskUserQuestion
 *  and ExitPlanMode tool_use lines carry the questions/plan (owner 2026-10-07). */
export function historyLine(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.kind === 'text') {
    const content = stripLine(message.content);
    if (!content) return null;
    if (message.role !== 'user') return capLine(`claude: ${content}`);
    // Owner 2026-10-07: a relay from an EARLIER call is not what the owner
    // just said in this one.
    if (/^\(voice\)/.test(content) || content.includes("[owner's exact words")) {
      return capLine(`user (earlier voice call): ${content.replace(/^\(voice\)\s*/, '')}`);
    }
    const notice = systemNotice(message.content);
    if (notice !== null) {
      if (!notice) return null;
      return capLine(`notice (from an employee, not the owner): ${notice}`);
    }
    return capLine(`user: ${content}`);
  }
  if (message.kind === 'tool_use') {
    const name = stripLine(message.toolName) || 'tool';
    if (name === 'AskUserQuestion') return questionLine(message.toolInput);
    if (name === 'ExitPlanMode') return planLine(message.toolInput);
    const target = shortTarget(message.toolInput);
    return capLine(target ? `tool: ${name} ${target}` : `tool: ${name}`);
  }
  return null;
}

/** The line form of one of the NEWEST claude messages: stripLine still applied,
 *  clipped at a sentence end (owner 2026-10-07 — no 160-char fragments). */
export function fullClaudeLine(message, prefix = 'claude') {
  if (!message || typeof message !== 'object') return null;
  const content = stripLine(message.content);
  if (!content) return null;
  return capTo(`${prefix}: ${clipSentence(content, FULL_LINE_MAX - prefix.length - 2)}`, FULL_LINE_MAX);
}

/** Owner 2026-10-07: a busy run is mostly tool calls, and shell commands are
 *  noise to the voice. A run of 2+ consecutive tool lines becomes one
 *  names-only line ("tool: Bash ×3, Read") so the briefing keeps Claude's
 *  own words; a lone tool line keeps its short target. */
export function collapseToolRuns(lines) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) {
      const counts = new Map();
      for (const line of run) {
        const name = line.slice('tool: '.length).split(' ')[0] || 'tool';
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
      out.push(capLine(`tool: ${names.join(', ')}`));
    }
    run = [];
  };
  for (const line of lines) {
    if (line.startsWith('tool: ')) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

const SNAPSHOT_REPLY_MAX = 2000;

/** Fallback briefing from the live progress-log snapshot (owner 2026-10-07,
 *  call 170008: a session started a minute before the call has no REST
 *  history yet, but the page saw every frame of it). '' when there is none. */
export function snapshotContext(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const lines = [];
  for (const item of Array.isArray(snapshot.recent) ? snapshot.recent : []) {
    const text = stripLine(item);
    if (!text) continue;
    lines.push(capLine(/^Tool: /.test(text) ? `tool: ${text.slice('Tool: '.length)}` : `progress: ${text}`));
  }
  const reply = stripLine(snapshot.lastAssistantText);
  if (reply) {
    const clipped = reply.length <= SNAPSHOT_REPLY_MAX ? reply : `${reply.slice(0, SNAPSHOT_REPLY_MAX - 1)}…`;
    lines.push(`claude (latest message): ${clipped}`);
  }
  if (!lines.length) return '';
  if (snapshot.state && snapshot.state !== 'idle') lines.unshift(`state: ${snapshot.state}`);
  return capHistory(collapseToolRuns(lines)).join('\n');
}

/** Newest-first budgeting: keep the most recent lines that fit in the total
 *  cap, then restore chronological order. */
export function capHistory(lines) {
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const cost = line.length + (kept.length ? 1 : 0); // + '\n' join separator
    if (size + cost > HISTORY_MAX) break;
    kept.push(line);
    size += cost;
  }
  return kept.reverse();
}

export function createSessionHistory({
  fetch: fetchImpl = null,
  localStorage: storage = null,
  now = () => Date.now(),
  setTimeout: scheduleTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  progressLog = null,
  limit = 30,
  throttleMs = 10000,
} = {}) {
  const cache = new Map(); // sessionId -> { at, data }
  const pending = new Map(); // sessionId -> in-flight promise
  const fed = new Map(); // sessionId -> Set of message ids already fed

  function bearerToken() {
    try {
      const token = storage ? storage.getItem('auth-token') : null;
      return typeof token === 'string' && token ? token : null;
    } catch {
      return null;
    }
  }

  async function fetchPage(sessionId, { pageLimit = limit, offset = 0 } = {}) {
    const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages?limit=${pageLimit}&offset=${offset}`;
    const headers = { Accept: 'application/json' };
    const token = bearerToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const timer = new Promise((resolve) => scheduleTimer(() => resolve(null), FETCH_TIMEOUT_MS));
    const response = await Promise.race([
      fetchImpl(url, { headers, credentials: 'include' }),
      timer,
    ]);
    if (!response) throw new Error('history fetch timeout');
    if (!response.ok) throw new Error(`history fetch failed (${response.status})`);
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') return null;
    // createApiSuccessResponse wrapper ({success:true,data:{...}}); a bare
    // FetchHistoryResult shape is accepted too (both unambiguous).
    const data =
      payload.data && typeof payload.data === 'object' && Array.isArray(payload.data.messages)
        ? payload.data
        : Array.isArray(payload.messages)
          ? payload
          : null;
    return data;
  }

  async function refresh(sessionId, { force = false } = {}) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    const key = sessionId;
    const cached = cache.get(key);
    const age = cached ? now() - cached.at : Infinity;
    if (cached && !force && age < throttleMs) return cached.data;
    if (pending.has(key)) return pending.get(key);

    const task = (async () => {
      try {
        const data = await fetchPage(key);
        if (!data || !Array.isArray(data.messages)) throw new Error('bad history payload');
        // Oldest-first page: feed in order, silently (history events must
        // never fire the proactive-push sink into the live call).
        // Each message is fed once per session: throttled refreshes re-fetch
        // the same tail, and re-feeding it would duplicate `recent` lines and
        // could flip the run state back to an older one.
        if (progressLog && typeof progressLog.feed === 'function') {
          const seen = fed.get(key) || new Set();
          const firstSeed = !fed.has(key);
          fed.set(key, seen);
          for (const message of data.messages) {
            const id = message && message.id;
            if (id ? seen.has(id) : !firstSeed) continue;
            if (id) seen.add(id);
            try {
              progressLog.feed(message, { silent: true });
            } catch {
              // one bad row must never break the seed
            }
          }
        }
        // Owner 2026-10-07: the NEWEST claude text messages are kept in full
        // (each capped at a sentence end near 3500); everything else stays
        // one-line. claudeTexts (newest-first) powers read_claude_message.
        const entries = [];
        const claudeTexts = [];
        for (let i = data.messages.length - 1; i >= 0; i -= 1) {
          const message = data.messages[i];
          const isClaudeText = message && message.kind === 'text' && message.role !== 'user';
          let back = 0;
          if (isClaudeText && claudeTexts.length < READ_KEEP) {
            const full = clipSentence(stripLine(message.content), READ_MESSAGE_MAX);
            if (full) {
              claudeTexts.push(full);
              back = claudeTexts.length;
            }
          }
          let line = historyLine(message);
          if (line === null) continue;
          // Owner 2026-10-07: each CEO message carries its read_claude_message
          // number, so Jimmy reads the message that answers the owner.
          const prefix = back ? `claude [back=${back}]` : 'claude';
          if (back) line = capLine(line.replace(/^claude: /, `${prefix}: `));
          const full = entries.filter((e) => e.full).length < FULL_CLAUDE_COUNT && isClaudeText ? fullClaudeLine(message, prefix) : null;
          entries.push({ line, full });
        }
        entries.reverse();
        // A tool-heavy run can leave few CEO messages in the newest page: one
        // older page tops claudeTexts up (best-effort; lines stay as they are).
        if (claudeTexts.length < READ_KEEP && Number(data.total) > data.messages.length) {
          try {
            const older = await fetchPage(key, { pageLimit: OLDER_PAGE, offset: data.messages.length });
            const olderMessages = older && Array.isArray(older.messages) ? older.messages : [];
            for (let i = olderMessages.length - 1; i >= 0 && claudeTexts.length < READ_KEEP; i -= 1) {
              const message = olderMessages[i];
              if (!message || message.kind !== 'text' || message.role === 'user') continue;
              const full = clipSentence(stripLine(message.content), READ_MESSAGE_MAX);
              if (full) claudeTexts.push(full);
            }
          } catch {
            // the newest page is enough to answer
          }
        }
        const lines = capHistory(collapseToolRuns(entries.map((entry) => entry.full || entry.line)));
        const fresh = { sessionId: key, lines, text: lines.join('\n'), total: data.total ?? lines.length, claudeTexts };
        cache.set(key, { at: now(), data: fresh });
        return fresh;
      } catch {
        // Failure keeps the last good data; never throws to the caller.
        return cached ? cached.data : null;
      } finally {
        pending.delete(key);
      }
    })();

    pending.set(key, task);
    return task;
  }

  return { refresh };
}
