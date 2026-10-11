// P13 (WO-13 / WO-N5 d, M-122): the activity bar's GET /api/bg-tasks/active
// also lists sessions whose CLI was started in a terminal and is busy right
// now. Claude Code writes ~/.claude/sessions/<pid>.json for every live CLI
// ({pid, sessionId, kind, entrypoint, status: busy|idle, statusUpdatedAt, procStart, ...});
// a busy entry whose pid is alive marks its session as working even when
// its transcript has been quiet for longer than CLOUDCLI_SESSION_LIVE_MS.
// Mounted in front of the stock bg-tasks router (index.js), so P2/P4's
// bg-tasks.service.js / bg-tasks.routes.js stay byte-identical. Only
// sessions that are visible in the sidebar (not archived) are added.
// Aliveness = /proc/<pid> exists AND its stat field 22 matches the recorded
// procStart, a string or a number (a recycled pid would otherwise look alive).
// Unreadable stat files fail open.
// Fails open: any error returns the stock /active body unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { sessionsDb } from '../database/index.js';
import { bgTasksActiveRequest } from './bg-tasks.service.js';

const MAX_PID_FILES = 200;

function sessionsDir(env = process.env) {
    return env.CLOUDCLI_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
}

/** /proc/<pid>/stat starttime (field 22, clock ticks since boot), null when unreadable. */
function procStartTime(pid, procRoot) {
    try {
        const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        return rest.length > 19 ? rest[19] : null;
    }
    catch {
        return null;
    }
}

function pidAlive(pid, procRoot, procStart) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        if (!fs.existsSync(path.join(procRoot, String(pid)))) {
            return false;
        }
    }
    catch {
        return false;
    }
    // A recycled pid reuses the /proc dir but gets a new starttime: when the
    // pid file records a procStart that differs from the live field 22, the
    // entry is stale -> dead. An unreadable stat fails open (legacy behavior).
    // procStart may be recorded as a string or a number; both compare as the
    // decimal string (like p10's marker check). Any other value is ignored.
    const recorded = typeof procStart === 'number' ? String(procStart) : typeof procStart === 'string' ? procStart.trim() : '';
    if (/^\d+$/.test(recorded)) {
        const current = procStartTime(pid, procRoot);
        return current === null ? true : current === recorded;
    }
    return true;
}

/** Live CLI processes from <dir>/<pid>.json (alive pid only). */
export function p13ReadLiveCliSessions({ dir = sessionsDir(), procRoot = '/proc' } = {}) {
    let names = [];
    try {
        names = fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)).slice(0, MAX_PID_FILES);
    }
    catch {
        return [];
    }
    const live = [];
    for (const name of names) {
        try {
            const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (!entry || typeof entry !== 'object' || typeof entry.sessionId !== 'string' || !entry.sessionId) {
                continue;
            }
            const pid = typeof entry.pid === 'number' ? entry.pid : Number.parseInt(name, 10);
            if (!pidAlive(pid, procRoot, entry.procStart)) {
                continue;
            }
            const updatedAtMs = [entry.statusUpdatedAt, entry.updatedAt].find((value) => typeof value === 'number' && Number.isFinite(value)) ?? null;
            live.push({
                pid,
                providerSessionId: entry.sessionId,
                status: typeof entry.status === 'string' ? entry.status : null,
                kind: typeof entry.kind === 'string' ? entry.kind : null,
                entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : null,
                updatedAtMs,
            });
        }
        catch {
            // A malformed or vanished pid file never blocks the list.
        }
    }
    return live;
}

function timeOf(iso) {
    const ms = Date.parse(iso ?? '');
    return Number.isFinite(ms) ? ms : 0;
}

/**
 * Adds every busy live CLI whose session resolves to a sidebar-visible app
 * session id and is not already listed. Returns a NEW body (the stock body
 * object is cached by bg-tasks.service.js and must not be mutated).
 */
export function p13MergeTerminalLive(body, live, resolveVisibleSessionId, nowMs = Date.now()) {
    const sessions = Array.isArray(body?.sessions) ? body.sessions.slice() : [];
    const listed = new Set(sessions.map((entry) => entry?.sessionId));
    for (const entry of Array.isArray(live) ? live : []) {
        if (!entry || entry.status !== 'busy') {
            continue;
        }
        const sessionId = resolveVisibleSessionId(entry.providerSessionId);
        if (!sessionId || listed.has(sessionId)) {
            continue;
        }
        listed.add(sessionId);
        sessions.push({
            sessionId,
            working: true,
            lastWriteAt: new Date(entry.updatedAtMs ?? nowMs).toISOString(),
            source: 'terminal',
        });
    }
    sessions.sort((a, b) => timeOf(b.lastWriteAt) - timeOf(a.lastWriteAt));
    return { ...(body && typeof body === 'object' ? body : {}), sessions };
}

/** App session id for a provider id, only when the row is not archived. */
export function p13VisibleSessionResolver(db = sessionsDb) {
    return (providerSessionId) => {
        try {
            const row = db.getSessionByProviderSessionId(providerSessionId) ?? db.getSessionById(providerSessionId);
            return row && !row.isArchived ? row.session_id : null;
        }
        catch {
            return null;
        }
    };
}

function stockDeps() {
    return {
        listSessions: () => sessionsDb
            .getAllSessions()
            .filter((row) => row.provider === 'claude'
                && typeof row.jsonl_path === 'string'
                && row.jsonl_path
                && typeof row.session_id === 'string'
                && row.session_id)
            .map((row) => ({ sessionId: row.session_id, jsonlPath: row.jsonl_path })),
    };
}

export function createP13TerminalActiveRouter(deps = {}) {
    const router = express.Router();
    router.get('/active', async (_request, response) => {
        const base = await bgTasksActiveRequest(deps.bgDeps ?? stockDeps());
        if (base.status !== 200) {
            response.status(base.status).json(base.body);
            return;
        }
        let body = base.body;
        try {
            body = p13MergeTerminalLive(body, p13ReadLiveCliSessions(deps.live ?? {}), deps.resolve ?? p13VisibleSessionResolver());
        }
        catch {
            body = base.body;
        }
        response.status(200).json(body);
    });
    return router;
}

export const p13TerminalActiveRoutes = createP13TerminalActiveRouter();
