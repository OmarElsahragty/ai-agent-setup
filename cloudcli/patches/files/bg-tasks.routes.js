// P2 (WO-E1) + P4 (WO-G1): read-only background-jobs & agents API routes,
// mounted at /api/bg-tasks behind authenticateToken. Thin express wiring over
// bg-tasks.service.js; all decision logic lives in the service so it can be
// unit-tested without express or the database.
import express from 'express';
import { sessionsDb } from '../database/index.js';
import {
    bgTasksActiveRequest,
    bgTasksAgentTailRequest,
    bgTasksListRequest,
    bgTasksTailRequest,
} from './bg-tasks.service.js';

function respond(result, response) {
    response.status(result.status).json(result.body);
}

export function createBgTasksRouter() {
    const router = express.Router();
    const deps = {
        resolveJsonlPath: (sessionId) => sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null,
        getSession: (sessionId) => sessionsDb.getSessionById(sessionId) ?? null,
        listSessions: () => sessionsDb
            .getAllSessions()
            .filter((row) => row.provider === 'claude'
                && typeof row.jsonl_path === 'string'
                && row.jsonl_path
                && typeof row.session_id === 'string'
                && row.session_id)
            .map((row) => ({ sessionId: row.session_id, jsonlPath: row.jsonl_path })),
    };
    router.get('/', async (request, response) => {
        respond(await bgTasksListRequest({ sessionId: request.query.sessionId }, deps), response);
    });
    router.get('/active', async (_request, response) => {
        respond(await bgTasksActiveRequest(deps), response);
    });
    router.get('/agents/:agentId/tail', async (request, response) => {
        respond(await bgTasksAgentTailRequest({
            agentId: request.params.agentId,
            sessionId: request.query.sessionId,
            steps: request.query.steps,
        }, deps), response);
    });
    router.get('/:taskId/tail', async (request, response) => {
        respond(await bgTasksTailRequest({
            taskId: request.params.taskId,
            sessionId: request.query.sessionId,
            lines: request.query.lines,
        }, deps), response);
    });
    return router;
}

export const bgTasksRoutes = createBgTasksRouter();
