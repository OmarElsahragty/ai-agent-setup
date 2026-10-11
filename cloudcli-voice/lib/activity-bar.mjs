// G2 bottom activity bar — pure model, URL builders, poll-cadence decision,
// cadence poller and sidebar badge mapping. No DOM here; voice-addon.js
// renders everything via createElement/textContent.
//
// Extended /api/bg-tasks contract (WO-G1, coded exactly):
//   GET /api/bg-tasks?sessionId=<uuid>
//     -> {sessionWorking:bool, lastWriteAt:iso|null,
//         tasks:[{id,description,status,startedAt,endedAt|null,outputBytes}],
//         agents:[{id,agentType,description,status:"running|completed|failed",
//                  startedAt,lastActivityAt,steps:int,currentStep:string}]}
//   GET /api/bg-tasks/agents/:agentId/tail?sessionId=<uuid>&steps=20 (1..100)
//     -> {id, steps:[{kind:"tool|text", label, at}], truncated}
//   GET /api/bg-tasks/active -> {sessions:[{sessionId, working:true, lastWriteAt}]}

import { normalizeTask, sortTasks, formatAge } from './bg-jobs.mjs';

export const AGENT_STATUSES = ['running', 'completed', 'failed'];
export const AGENT_TAIL_STEPS = 20;
export const AGENT_TAIL_MIN_STEPS = 1;
export const AGENT_TAIL_MAX_STEPS = 100;
export const FADE_MS = 60000;
export const POLL_ACTIVE_MS = 3000;
export const POLL_IDLE_MS = 15000;

export function agentsTailUrl(agentId, sessionId, steps = AGENT_TAIL_STEPS) {
  const n = Number(steps);
  const clamped = Number.isFinite(n)
    ? Math.min(AGENT_TAIL_MAX_STEPS, Math.max(AGENT_TAIL_MIN_STEPS, Math.round(n)))
    : AGENT_TAIL_STEPS;
  return `/api/bg-tasks/agents/${encodeURIComponent(agentId)}/tail?sessionId=${encodeURIComponent(sessionId)}&steps=${clamped}`;
}

export function activeSessionsUrl() {
  return '/api/bg-tasks/active';
}

export function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!AGENT_STATUSES.includes(raw.status)) return null;
  if (!raw.id) return null;
  return {
    id: String(raw.id),
    agentType: typeof raw.agentType === 'string' ? raw.agentType : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status: raw.status,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    lastActivityAt: typeof raw.lastActivityAt === 'string' ? raw.lastActivityAt : null,
    steps: Number.isFinite(raw.steps) ? raw.steps : 0,
    currentStep: typeof raw.currentStep === 'string' ? raw.currentStep : '',
  };
}

/** Running agents first, then most recently started first. */
export function sortAgents(agents) {
  return [...agents].sort((a, b) => {
    const byStatus = (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1);
    if (byStatus !== 0) return byStatus;
    const byStart = Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '');
    if (byStart !== 0) return byStart;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Open session id from a sidebar link href (`/session/<id>`), null otherwise. */
export function sessionIdFromHref(href) {
  try {
    const raw = typeof href === 'string' ? href : '';
    if (!raw) return null;
    const path = raw.startsWith('http') ? new URL(raw).pathname : raw;
    const match = path.match(/\/session\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Set of sessionIds marked working in a /api/bg-tasks/active payload. */
export function activeSessionIds(payload) {
  const rows = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
  const ids = new Set();
  for (const row of rows) {
    if (row && typeof row.sessionId === 'string' && row.working === true) ids.add(row.sessionId);
  }
  return ids;
}

/**
 * Poll cadence per the G2 spec: 3 s while the tab is visible AND (bar expanded
 * OR anything running OR sessionWorking); 15 s otherwise; null = stopped
 * (hidden tab).
 */
export function decidePollMs({ visible, expanded = false, anythingRunning = false, sessionWorking = false } = {}) {
  if (!visible) return null;
  return expanded || anythingRunning || sessionWorking ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/** Coarse duration between two ISO timestamps (finished items stop counting). */
export function formatDurationMs(startedAt, endedAt) {
  const start = Date.parse(startedAt ?? '');
  if (!Number.isFinite(start)) return '';
  const end = Date.parse(endedAt ?? '');
  return formatAge(startedAt, Number.isFinite(end) ? end : start);
}

/**
 * State for the activity bar. Finished items keep rendering (with a ✓/✗ icon)
 * for `fadeMs` after they were first seen finished, then drop out. 404/401 on
 * the endpoint disables the feature for the page load.
 */
export function createActivityModel({ now = () => Date.now(), fadeMs = FADE_MS } = {}) {
  let tasks = [];
  let agents = [];
  let sessionWorking = false;
  let endpointDisabled = false;
  let expanded = false;
  let selected = null; // {kind:'agent'|'job', id}
  let agentTail = null;
  let jobTail = null;
  const finishedSeenAt = new Map(); // `${kind}:${id}` -> first-seen-finished ms

  function findSelected() {
    if (!selected) return null;
    if (selected.kind === 'agent') return agents.find((a) => a.id === selected.id) || null;
    return tasks.find((t) => t.id === selected.id) || null;
  }

  function trackFinished() {
    const present = new Set();
    for (const agent of agents) {
      const key = `agent:${agent.id}`;
      present.add(key);
      if (agent.status === 'running') finishedSeenAt.delete(key);
      else if (!finishedSeenAt.has(key)) finishedSeenAt.set(key, now());
    }
    for (const task of tasks) {
      const key = `job:${task.id}`;
      present.add(key);
      if (task.status === 'running') finishedSeenAt.delete(key);
      else if (!finishedSeenAt.has(key)) finishedSeenAt.set(key, now());
    }
    for (const key of [...finishedSeenAt.keys()]) {
      if (!present.has(key)) finishedSeenAt.delete(key);
    }
  }

  function recentFinishedCount(nowMs) {
    let count = 0;
    for (const seen of finishedSeenAt.values()) {
      if (nowMs - seen < fadeMs) count += 1;
    }
    return count;
  }

  return {
    apply(payload) {
      const rawTasks = payload && Array.isArray(payload.tasks) ? payload.tasks : [];
      const rawAgents = payload && Array.isArray(payload.agents) ? payload.agents : [];
      tasks = sortTasks(rawTasks.map(normalizeTask).filter(Boolean));
      agents = sortAgents(rawAgents.map(normalizeAgent).filter(Boolean));
      sessionWorking = Boolean(payload && payload.sessionWorking);
      trackFinished();
      if (selected && !findSelected()) {
        selected = null;
        agentTail = null;
        jobTail = null;
      }
      return this;
    },
    noteStatus(status) {
      if (status === 404 || status === 401) endpointDisabled = true;
    },
    select(kind, id) {
      if (!kind || !id) {
        selected = null;
      } else {
        selected = { kind, id: String(id) };
      }
      agentTail = null;
      jobTail = null;
    },
    setExpanded(value) {
      expanded = Boolean(value);
    },
    applyAgentTail(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (!selected || selected.kind !== 'agent' || String(payload.id) !== selected.id) return;
      const steps = Array.isArray(payload.steps)
        ? payload.steps
            .filter((step) => step && typeof step === 'object' && typeof step.label === 'string')
            .map((step) => ({
              kind: step.kind === 'text' ? 'text' : 'tool',
              label: step.label,
              at: typeof step.at === 'string' ? step.at : null,
            }))
        : [];
      agentTail = { id: String(payload.id), steps, truncated: payload.truncated === true };
    },
    applyJobTail(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (!selected || selected.kind !== 'job' || String(payload.id) !== selected.id) return;
      jobTail = {
        id: String(payload.id),
        text: typeof payload.text === 'string' ? payload.text : '',
        truncated: payload.truncated === true,
      };
    },
    summary() {
      const nowMs = now();
      const runningAgents = agents.filter((a) => a.status === 'running').length;
      const runningJobs = tasks.filter((t) => t.status === 'running').length;
      const working = runningAgents > 0 || runningJobs > 0 || sessionWorking;
      const recentFinished = recentFinishedCount(nowMs);
      if (!working && recentFinished === 0) return '';
      const parts = [];
      if (working) parts.push('Working');
      if (runningAgents > 0) parts.push(`${runningAgents} agent${runningAgents === 1 ? '' : 's'}`);
      if (runningJobs > 0) parts.push(`${runningJobs} background job${runningJobs === 1 ? '' : 's'}`);
      if (!working && recentFinished > 0) parts.push(`${recentFinished} finished`);
      return `● ${parts.join(' · ')} ${expanded ? '▼' : '▲'}`;
    },
    rows() {
      const nowMs = now();
      const out = [];
      for (const agent of agents) {
        if (agent.status !== 'running') continue;
        out.push({
          kind: 'agent',
          id: agent.id,
          status: 'running',
          icon: '⟳',
          title: agent.agentType || 'agent',
          description: agent.description,
          middle: agent.currentStep,
          elapsed: formatAge(agent.startedAt, nowMs),
        });
      }
      for (const task of tasks) {
        if (task.status !== 'running') continue;
        out.push({
          kind: 'job',
          id: task.id,
          status: 'running',
          icon: '⏳',
          title: 'shell',
          description: task.description,
          middle: task.status,
          elapsed: formatAge(task.startedAt, nowMs),
        });
      }
      const finished = [];
      const collect = (kind, item) => {
        const seen = finishedSeenAt.get(`${kind}:${item.id}`);
        if (seen === undefined || nowMs - seen >= fadeMs) return;
        finished.push({
          row: {
            kind,
            id: item.id,
            status: item.status,
            icon: item.status === 'completed' ? '✓' : '✗',
            title: kind === 'agent' ? item.agentType || 'agent' : 'shell',
            description: item.description,
            middle: kind === 'agent' ? item.currentStep : item.status,
            elapsed: formatDurationMs(item.startedAt, kind === 'agent' ? item.lastActivityAt : item.endedAt),
          },
          seenAt: seen,
          startedAt: item.startedAt,
          id: item.id,
        });
      };
      for (const agent of agents) {
        if (agent.status !== 'running') collect('agent', agent);
      }
      for (const task of tasks) {
        if (task.status !== 'running') collect('job', task);
      }
      finished.sort(
        (a, b) =>
          b.seenAt - a.seenAt ||
          Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '') ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      return out.concat(finished.map((entry) => entry.row));
    },
    get tasks() {
      return tasks;
    },
    get agents() {
      return agents;
    },
    get sessionWorking() {
      return sessionWorking;
    },
    get anythingRunning() {
      return agents.some((a) => a.status === 'running') || tasks.some((t) => t.status === 'running');
    },
    get disabled() {
      return endpointDisabled;
    },
    get expanded() {
      return expanded;
    },
    get selected() {
      return selected;
    },
    get selectedRunning() {
      const item = findSelected();
      return Boolean(item && item.status === 'running');
    },
    get tail() {
      if (!selected) return null;
      if (selected.kind === 'agent') {
        if (!agentTail) return null;
        const text = agentTail.steps
          .map((step) => (step.kind === 'text' ? step.label : `[${step.kind}] ${step.label}`))
          .join('\n');
        return { kind: 'agent', id: agentTail.id, text, truncated: agentTail.truncated };
      }
      if (!jobTail) return null;
      return { kind: 'job', id: jobTail.id, text: jobTail.text, truncated: jobTail.truncated };
    },
  };
}

/**
 * Self-rearming timer whose delay is re-decided before every arm, so the
 * cadence can switch between intervals (3 s / 15 s) and stop entirely
 * (decideMs -> null, e.g. hidden tab) without leaking timers.
 */
export function createCadencePoller({
  decideMs = () => null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onTick = () => {},
} = {}) {
  let timer = null;
  let stopped = true;

  function clear() {
    if (timer !== null) {
      try {
        clearTimeoutFn(timer);
      } catch {
        // already cleared
      }
    }
    timer = null;
  }

  function arm() {
    clear();
    let ms = null;
    try {
      ms = decideMs();
    } catch {
      ms = null;
    }
    if (ms === null || ms === undefined) {
      stopped = true;
      return;
    }
    timer = setTimeoutFn(() => {
      timer = null;
      if (stopped) return;
      try {
        onTick();
      } catch {
        // tick failures are logged by the caller; never break the loop
      }
      arm();
    }, ms);
  }

  return {
    sync() {
      stopped = false;
      arm();
    },
    stop() {
      stopped = true;
      clear();
    },
    // D7: tick right now (a session was just opened) and re-arm with the
    // current cadence, so the first poll never waits out the 15 s idle delay.
    pollNow() {
      stopped = false;
      clear();
      try {
        onTick();
      } catch {
        // tick failures are logged by the caller; never break the loop
      }
      if (!stopped) arm();
    },
    get running() {
      return timer !== null;
    },
  };
}

/**
 * D7: open-session change detector. onOpen(id) fires once per newly opened
 * session (route /session/:id or the tracked id), onClose() when no session
 * is open any more; repeated checks with the same id are no-ops.
 */
export function createOpenSessionWatcher({ onOpen = () => {}, onClose = () => {} } = {}) {
  let current = null;
  return {
    check(id) {
      const next = typeof id === 'string' && id ? id : null;
      if (next === current) return false;
      current = next;
      try {
        if (next) onOpen(next);
        else onClose();
      } catch {
        // caller callbacks must not break the watcher
      }
      return true;
    },
    get current() {
      return current;
    },
  };
}
