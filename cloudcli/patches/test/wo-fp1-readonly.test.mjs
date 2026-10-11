// WO-FP1 rule 1: /api/bg-tasks is strictly read-only. Proves with the REAL
// express router (mounted exactly like dist index.js mounts it, minus the
// token check) that POST/PUT/DELETE/PATCH on every route fall through to a
// 404/405 without touching the sessions DB, plus a static no-writes sweep of
// the service source. The '../database/index.js' import of the routes module
// only exists in a patched install, so a module-resolution hook redirects it
// to a counting stub (node:module, no extra deps).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STUB_SRC = 'globalThis.__fp1StubCalls = { getSessionById: 0, getAllSessions: 0 };\n'
    + 'export const sessionsDb = {\n'
    + '  getSessionById() { globalThis.__fp1StubCalls.getSessionById += 1; return null; },\n'
    + '  getAllSessions() { globalThis.__fp1StubCalls.getAllSessions += 1; return []; },\n'
    + '};\n';
const HOOK_SRC = 'export async function resolve(specifier, context, next) {\n'
    + `  if (specifier === '../database/index.js') {\n`
    + `    return { url: 'data:text/javascript,${encodeURIComponent(STUB_SRC)}', shortCircuit: true };\n`
    + '  }\n'
    + '  return next(specifier, context);\n'
    + '}\n';
register(`data:text/javascript,${encodeURIComponent(HOOK_SRC)}`, import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATHS = ['/', '/active', '/agents/a1234567890abcdef/tail', '/zzzz9999x/tail'];
const SID = '12345678-1234-5678-8123-456789abcdef';

// express comes from the CloudCLI install (cloudcli/node_modules); a fresh clone has none until
// `npm install` runs there, so the router test skips instead of failing.
let MISSING_EXPRESS = false;
try { import.meta.resolve('express'); } catch { MISSING_EXPRESS = 'express not installed (run npm install in cloudcli/)'; }

let app;
let server;
let baseUrl;
let snapshot;

before(async () => {
    if (MISSING_EXPRESS) return;
    const express = (await import('express')).default;
    const { bgTasksRoutes } = await import('../files/bg-tasks.routes.js');
    app = express();
    app.use('/api/bg-tasks', (_req, _res, next) => next(), bgTasksRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/bg-tasks`;

    // Sanity: the router is mounted and GET wiring works before the sweep.
    const active = await fetch(`${baseUrl}/active`);
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { sessions: [] });
    const list = await fetch(`${baseUrl}/?sessionId=${SID}`);
    assert.equal(list.status, 404);
    assert.deepEqual(await list.json(), { error: 'Session not found' });
    snapshot = { ...globalThis.__fp1StubCalls };
    assert.ok(snapshot.getSessionById >= 1 && snapshot.getAllSessions >= 1, 'sanity GETs must hit the stub');
});

after(async () => {
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});

test('rule 1: POST/PUT/DELETE/PATCH on every bg-tasks route => 404/405, nothing touched', { skip: MISSING_EXPRESS }, async () => {
    for (const routePath of ROUTE_PATHS) {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
            const response = await fetch(`${baseUrl}${routePath}`, {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: SID, lines: '40', steps: '20' }),
            });
            assert.ok(
                response.status === 404 || response.status === 405,
                `${method.toUpperCase()} ${routePath} must be 404/405, got ${response.status}`,
            );
            const text = await response.text();
            assert.ok(!text.startsWith('{'), `${method} ${routePath} must not run a handler`);
        }
    }
    assert.deepEqual(globalThis.__fp1StubCalls, snapshot);
});

test('rule 1: static sweep — service module never calls a mutating fs API', async () => {
    const source = await fsp.readFile(path.join(HERE, '../files/bg-tasks.service.js'), 'utf8');
    const used = new Set();
    for (const match of source.matchAll(/\bfsp\.([a-zA-Z]+)/g)) {
        used.add(match[1]);
    }
    for (const match of source.matchAll(/\bfs\.([a-zA-Z]+)/g)) {
        used.add(`fs.${match[1]}`);
    }
    const allowed = new Set(['stat', 'realpath', 'readFile', 'readdir', 'open', 'fs.createReadStream']);
    for (const name of used) {
        assert.ok(allowed.has(name), `unexpected fs API in service: ${name}`);
    }
    // fsp.open is only ever used in read mode.
    for (const match of source.matchAll(/fsp\.open\(([^)]*)\)/g)) {
        assert.match(match[1], /'r'/);
    }
    for (const banned of ['child_process', 'createWriteStream', 'worker_threads', 'node:net', 'node:dgram']) {
        assert.equal(source.includes(banned), false, `service source must not contain ${banned}`);
    }
});
