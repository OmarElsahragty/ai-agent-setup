// R2 background jobs — pure model, API URL builders and a poll controller.
// No DOM here; voice-addon.js renders everything via createElement/textContent.
//
// API contract (WO-E1, coded exactly):
//   GET /api/bg-tasks?sessionId=<uuid>
//     -> {tasks:[{id,description,status:"running|completed|failed|killed",
//                startedAt,endedAt|null,outputBytes}]}
//   GET /api/bg-tasks/:taskId/tail?sessionId=<uuid>&lines=40
//     -> {id,text,truncated}

export const BG_TASK_STATUSES = ['running', 'completed', 'failed', 'killed'];
export const BG_TAIL_LINES = 40;

export function bgTasksUrl(sessionId) {
  return `/api/bg-tasks?sessionId=${encodeURIComponent(sessionId)}`;
}

export function bgTaskTailUrl(taskId, sessionId, lines = BG_TAIL_LINES) {
  return `/api/bg-tasks/${encodeURIComponent(taskId)}/tail?sessionId=${encodeURIComponent(sessionId)}&lines=${lines}`;
}

export function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!BG_TASK_STATUSES.includes(raw.status)) return null;
  if (!raw.id) return null;
  return {
    id: String(raw.id),
    description: typeof raw.description === 'string' ? raw.description : '',
    status: raw.status,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    outputBytes: Number.isFinite(raw.outputBytes) ? raw.outputBytes : 0,
  };
}

const STATUS_ORDER = { running: 0, completed: 1, failed: 2, killed: 3 };

/** Running jobs first, then most recently started first. */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    const byStart = Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '');
    if (byStart !== 0) return byStart;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function countRunning(tasks) {
  return tasks.filter((task) => task.status === 'running').length;
}

export function chipLabel(runningCount) {
  const n = Number(runningCount) || 0;
  if (n <= 0) return '';
  return `⏳ ${n} background job${n === 1 ? '' : 's'}`;
}

export function formatAge(startedAt, nowMs) {
  const start = Date.parse(startedAt ?? '');
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * State for the chip + panel. `noteStatus(404)` permanently disables the
 * feature for this page load (endpoint absent); 401 disables it too (the
 * authed fetch cannot succeed).
 */
export function createBgJobsModel({ now = () => Date.now() } = {}) {
  let tasks = [];
  let endpointDisabled = false;
  let selectedTaskId = null;
  let selectedTail = null;

  return {
    applyList(payload) {
      const raw = payload && Array.isArray(payload.tasks) ? payload.tasks : [];
      tasks = sortTasks(raw.map(normalizeTask).filter(Boolean));
      if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) {
        selectedTaskId = null;
        selectedTail = null;
      }
      return tasks;
    },
    applyTail(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (!selectedTaskId || String(payload.id) !== selectedTaskId) return;
      selectedTail = {
        id: String(payload.id),
        text: typeof payload.text === 'string' ? payload.text : '',
        truncated: payload.truncated === true,
      };
    },
    noteStatus(status) {
      if (status === 404 || status === 401) endpointDisabled = true;
    },
    select(taskId) {
      selectedTaskId = taskId ? String(taskId) : null;
      selectedTail = null;
    },
    get tasks() {
      return tasks;
    },
    get runningCount() {
      return countRunning(tasks);
    },
    get anyRunning() {
      return tasks.some((task) => task.status === 'running');
    },
    get disabled() {
      return endpointDisabled;
    },
    get selectedTaskId() {
      return selectedTaskId;
    },
    get selectedTail() {
      return selectedTail;
    },
    get selectedTaskRunning() {
      const task = tasks.find((entry) => entry.id === selectedTaskId);
      return task ? task.status === 'running' : false;
    },
    ageOf(task) {
      return formatAge(task && task.startedAt, now());
    },
  };
}

/**
 * One interval for the whole feature. It runs while the page is visible, the
 * flag is on, the endpoint is not known-absent and a session id is available.
 * Each tick updates the chip; the panel and tail re-render from the same data.
 */
export function createPollController({
  intervalMs = 5000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onTick = () => {},
} = {}) {
  let handle = null;

  function stop() {
    if (handle !== null) {
      try {
        clearIntervalFn(handle);
      } catch {
        // already cleared
      }
    }
    handle = null;
  }

  function start() {
    if (handle !== null) return;
    handle = setIntervalFn(() => {
      try {
        onTick();
      } catch {
        // tick failures are logged by the caller; never break the interval
      }
    }, intervalMs);
  }

  return {
    sync({ visible, enabled, disabled, sessionId }) {
      if (visible && enabled && !disabled && Boolean(sessionId)) start();
      else stop();
    },
    stop,
    get running() {
      return handle !== null;
    },
  };
}
