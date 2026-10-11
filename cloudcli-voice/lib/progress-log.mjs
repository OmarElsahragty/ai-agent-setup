// WO-VL-UI: session progress log for the Gemini-Live call bridge.
// Pure frame classifier (moved from lib/headlines.mjs + lib/cues.mjs): keeps a
// per-session snapshot (state / todos / recent lines / last assistant text)
// and fires update events for complete / question / permission so the call
// front end can speak a short proactive summary. No DOM, no imports — the old
// speech-text helpers will be deleted with the legacy voice pipeline.

const RECENT_SNAPSHOT_MAX = 15;
const LAST_ASSISTANT_MAX = 4000;
// Owner 2026-10-07 (R3): the pending on-screen question is kept whole so
// get_claude_status can read the questions and choices aloud.
// Owner 2026-10-07 (WO-VP-PLOG R5): real plans run 9k-25k chars — the old
// 3500 cap plus whitespace collapse clipped the plan; line breaks now survive.
const PENDING_PLAN_MAX = 60000;
// Owner 2026-10-07 (WO-VP-PLOG R2): bounded tool_use dedupe window per session.
const TOOL_ID_MEMORY = 500;

/** Owner 2026-10-07 (WO-VP-PLOG R5): keeps the plan's line breaks — collapse
 *  spaces/tabs inside lines, 3+ newlines become one blank line, lines trimmed. */
function normalizePlanText(raw) {
  return String(raw ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** Normalized pending question for the snapshot: AskUserQuestion keeps its
 *  questions/option labels, ExitPlanMode keeps the plan text, anything else
 *  keeps just {requestId, toolName, input} (never answered by voice). */
function pendingQuestionOf({ requestId, toolName, input } = {}) {
  const name = toolName || 'tool';
  const safeInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // Only a question's own input is needed (to answer it); a plain tool's
  // command, file body or URL is never kept, so it can never reach the voice.
  const isQuestion = name === 'AskUserQuestion';
  const pending = { requestId: requestId ?? null, toolName: name, input: isQuestion ? safeInput : {} };
  if (name === 'ExitPlanMode' || name === 'exit_plan_mode') {
    pending.planText = clip(normalizePlanText(safeInput.plan), PENDING_PLAN_MAX);
    return pending;
  }
  pending.questions = (Array.isArray(safeInput.questions) ? safeInput.questions : [])
    .filter((question) => question && typeof question === 'object')
    .map((question) => ({
      question: String(question.question ?? ''),
      options: (Array.isArray(question.options) ? question.options : [])
        .map((option) => (typeof option === 'string' ? option : option && typeof option.label === 'string' ? option.label : ''))
        .filter(Boolean),
      multiSelect: question.multiSelect === true,
    }));
  return pending;
}

/** Cuts long text at the last sentence end before `max` (never mid-word). */
function clip(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf('؟ '));
  return `${end > max / 2 ? head.slice(0, end + 1) : head.slice(0, head.lastIndexOf(' '))} …`;
}

// Fences, inline code and path-like tokens are never spoken or shown.
function stripForLog(raw) {
  let text = String(raw || '');
  text = text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__/g, ''); // markdown marks are never spoken
  text = text.replace(/```[\s\S]*?(```|$)/g, ' ');
  text = text.replace(/~~~[\s\S]*?(~~~|$)/g, ' ');
  text = text.replace(/`[^`\n]*`/g, ' ');
  text = text.replace(/\b[\w.$/-]*[A-Za-z_.$/-][\w.$/-]*:\d+(:\d+)?\b/g, ' ');
  text = text.replace(/\S*[\\/]\S*/g, (token) => (token.length >= 5 ? ' ' : token));
  return text.replace(/\s+/g, ' ').trim();
}

function firstWords(text, maxWords) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

function shortText(raw, maxWords = 12) {
  return firstWords(stripForLog(raw), maxWords);
}

export function createProgressLog({ max = 40, now = () => Date.now() } = {}) {
  const cap = Math.max(5, Math.floor(max) || 40);
  const sessions = new Map();
  const lastSeqBySession = new Map();
  let listener = () => {};

  const emptySnapshot = () => ({
    state: 'idle',
    todos: [],
    recent: [],
    lastAssistantText: '',
    lastAssistantAt: null,
    toolsSinceLastText: 0,
    pendingQuestion: null,
  });

  function entry(sessionId) {
    const key = sessionId ?? '_';
    let current = sessions.get(key);
    if (!current) {
      current = emptySnapshot();
      current.pendingReply = false;
      // Owner 2026-10-07 (WO-VP-PLOG R1/R2/R6): per-session live marker,
      // tool_use dedupe window and text/tool clock bookkeeping (internal).
      current.live = false;
      current.toolIds = new Set();
      current.toolIdOrder = [];
      sessions.set(key, current);
    }
    return current;
  }

  // Owner 2026-10-07 (WO-VP-PLOG R2): REST history rows and live frames carry
  // the same toolId; an id already seen for the session is ignored entirely
  // (bounded to the last TOOL_ID_MEMORY ids).
  function seenToolId(current, toolId) {
    if (typeof toolId !== 'string' || !toolId) return false;
    if (current.toolIds.has(toolId)) return true;
    current.toolIds.add(toolId);
    current.toolIdOrder.push(toolId);
    if (current.toolIdOrder.length > TOOL_ID_MEMORY) current.toolIds.delete(current.toolIdOrder.shift());
    return false;
  }

  // Replayed frames (chat.subscribe resends) must not re-classify.
  function stale(frame) {
    if (typeof frame.seq !== 'number') return false;
    const sessionId = frame.sessionId ?? '_';
    const last = lastSeqBySession.get(sessionId);
    const isStale = typeof last === 'number' && frame.seq <= last;
    if (!isStale) lastSeqBySession.set(sessionId, frame.seq);
    return isStale;
  }

  function note(sessionId, text) {
    const clean = shortText(text);
    if (!clean) return;
    const current = entry(sessionId);
    current.recent.push(clean);
    if (current.recent.length > cap) current.recent.splice(0, current.recent.length - cap);
  }

  function emit(type, text, sessionId, quiet) {
    // Full substance, not the 12-word recent-list cap (owner 2026-10-07: the
    // cap cut every spoken update mid-sentence).
    const clean = clip(firstWords(stripForLog(text), Infinity), LAST_ASSISTANT_MAX);
    if (!clean) return;
    if (quiet) return; // WO-VL-CTX: REST history seeding updates the snapshot silently
    try {
      listener({ type, text: clean, sessionId: sessionId ?? null });
    } catch {
      // listener failure must never break the frame feed
    }
  }

  function feed(frame, { silent = false } = {}) {
    if (!frame || typeof frame !== 'object') return;
    if (stale(frame)) return;
    const sessionId = frame.sessionId ?? null;
    const current = entry(sessionId);

    // Owner 2026-10-07 (WO-VP-PLOG R1): once any live frame was seen for the
    // session, silent REST-history replay may only fill an EMPTY
    // lastAssistantText — it must never clobber live state, the pending
    // question, todos or recent lines. Before the first live frame, silent
    // seeding works as it always did.
    if (silent && current.live) {
      if (frame.kind === 'text' && frame.role === 'assistant' && typeof frame.content === 'string' && frame.content.trim()) {
        const stripped = stripForLog(frame.content);
        if (stripped && !current.lastAssistantText) current.lastAssistantText = clip(stripped, LAST_ASSISTANT_MAX);
      }
      return;
    }
    if (!silent) current.live = true;

    switch (frame.kind) {
      case 'text': {
        if (frame.role === 'user') {
          // Keep Claude's last reply readable until a new one arrives (owner
          // 2026-10-07: tool results arrive as user frames, so clearing here left
          // get_claude_status empty mid-turn and Gemini invented the answer).
          current.pendingReply = false;
          // Owner 2026-10-07 (WO-VP-PLOG R3): tool results never flip the state
          // away from a waiting question/plan.
          if (!current.pendingQuestion) current.state = 'working';
          break;
        }
        if (frame.role === 'assistant' && typeof frame.content === 'string' && frame.content.trim()) {
          const stripped = stripForLog(frame.content);
          if (stripped) {
            current.lastAssistantText = clip(stripped, LAST_ASSISTANT_MAX);
            // Owner 2026-10-07 (WO-VP-PLOG R6): clock + live tool counter.
            current.lastAssistantAt = now();
            current.toolsSinceLastText = 0;
          }
          current.pendingReply = true;
          // Wave-1 review: a replayed assistant frame (reload subscribe replay,
          // seq reset) never flips a waiting question/plan either.
          if (!current.pendingQuestion) current.state = 'working';
          note(sessionId, frame.content);
          // Owner 2026-10-07: every progress message is told while Claude works;
          // the final 'complete' then only says Claude finished (never twice).
          if (stripped) {
            emit('progress', stripped, sessionId, silent);
            current.toldReply = !silent;
          }
        }
        break;
      }
      case 'tool_use': {
        // Owner 2026-10-07 (WO-VP-PLOG R2): a toolId already seen for the
        // session (REST row replaying a live tool, or the reverse) is ignored
        // entirely — no duplicate recent line, no counter bump.
        if (seenToolId(current, frame.toolId)) break;
        current.toolsSinceLastText += 1;
        // Owner 2026-10-07 (WO-VP-PLOG R3): a tool frame never flips the state
        // away from a waiting question/plan.
        if (!current.pendingQuestion) current.state = 'working';
        if (frame.toolName === 'TodoWrite') {
          const todos = Array.isArray(frame.toolInput?.todos) ? frame.toolInput.todos : [];
          current.todos = todos
            .filter(Boolean)
            .map((todo) => ({
              text: shortText(todo.activeForm || todo.content || '', 10),
              status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
            }));
          const active = current.todos.filter((todo) => todo.status === 'in_progress').pop();
          if (active) note(sessionId, active.text);
          break;
        }
        note(sessionId, `Tool: ${frame.toolName || 'tool'}`);
        break;
      }
      case 'permission_request': {
        current.state = 'waiting_permission';
        const toolName = frame.toolName || 'a tool';
        current.pendingQuestion = pendingQuestionOf(frame);
        if (toolName === 'AskUserQuestion') emit('question', 'Claude has a question.', sessionId, silent);
        else emit('permission', `Approval needed for ${toolName}.`, sessionId, silent);
        break;
      }
      // Owner 2026-10-07: a question or approval already waiting when the page
      // opened arrives only inside chat_subscribed.pendingPermissions.
      case 'chat_subscribed': {
        // Owner 2026-10-07 (WO-VP-PLOG R4): the server restarts seq at 1 for
        // every run; a numeric lastSeq BELOW the stored watermark means a new
        // run — reset the watermark so the new run's frames are not dropped.
        if (typeof frame.lastSeq === 'number') {
          const stored = lastSeqBySession.get(sessionId ?? '_');
          if (typeof stored === 'number' && frame.lastSeq < stored) lastSeqBySession.set(sessionId ?? '_', 0);
        }
        const pending = Array.isArray(frame.pendingPermissions) ? frame.pendingPermissions : [];
        if (pending.length) {
          current.state = 'waiting_permission';
          // A question outranks a plain tool approval when both wait.
          const entry =
            pending.find((item) => item && (item.toolName === 'AskUserQuestion' || item.toolName === 'ExitPlanMode')) ||
            pending.find((item) => item && typeof item === 'object') ||
            null;
          current.pendingQuestion = entry ? pendingQuestionOf(entry) : null;
        } else {
          current.pendingQuestion = null; // nothing waits anymore — it was answered elsewhere
          if (current.state === 'waiting_permission') current.state = frame.isProcessing ? 'working' : 'idle';
        }
        break;
      }
      case 'permission_resolved':
      case 'permission_cancelled': {
        // Owner 2026-10-07 (WO-VP-PLOG R3): only the answer to THE waiting
        // request clears it; a resolution for a different requestId must never
        // clobber the pending plan/question. A frame with no requestId still
        // clears (back-compat).
        const pending = current.pendingQuestion;
        const requestId = frame.requestId ?? null;
        if (!pending || requestId === null || pending.requestId === requestId) {
          current.pendingQuestion = null;
          if (current.state === 'waiting_permission') current.state = 'working';
        }
        break;
      }
      case 'complete': {
        // Owner 2026-10-07 (WO-VP-PLOG R4): the run ended — drop the seq
        // watermark so the next run (seq restarts at 1) classifies fully.
        lastSeqBySession.delete(sessionId ?? '_');
        current.pendingQuestion = null;
        current.state = 'idle';
        // The reply stays in the snapshot for status questions, but a bare
        // second complete (no new assistant text) falls back to the wording.
        if (frame.aborted === true) emit('complete', 'The run was stopped.', sessionId, silent);
        else if (frame.success === false) emit('complete', 'The run failed.', sessionId, silent);
        else if (current.pendingReply && current.toldReply) emit('complete', 'Claude finished.', sessionId, silent);
        else emit('complete', current.pendingReply ? current.lastAssistantText || 'Turn finished.' : 'Turn finished.', sessionId, silent);
        current.pendingReply = false;
        current.toldReply = false;
        break;
      }
      case 'error': {
        // Owner 2026-10-07 (WO-VP-PLOG R3/R4): a failed run releases the
        // waiting question and the seq watermark.
        lastSeqBySession.delete(sessionId ?? '_');
        current.pendingQuestion = null;
        current.state = 'idle';
        emit('complete', 'The run failed.', sessionId, silent);
        break;
      }
      default:
        break;
    }
  }

  return {
    feed,
    snapshot(sessionId) {
      const current = sessions.get(sessionId ?? '_');
      if (!current) return emptySnapshot();
      return {
        state: current.state,
        todos: current.todos.slice(),
        recent: current.recent.slice(-RECENT_SNAPSHOT_MAX),
        lastAssistantText: current.lastAssistantText,
        // Owner 2026-10-07 (WO-VP-PLOG R6): when the live answer arrived, and
        // how many live tool calls happened since (0 right after new text).
        lastAssistantAt: current.lastAssistantAt ?? null,
        toolsSinceLastText: current.toolsSinceLastText ?? 0,
        pendingQuestion: current.pendingQuestion || null,
      };
    },
    onUpdate(callback) {
      listener = typeof callback === 'function' ? callback : () => {};
    },
  };
}
