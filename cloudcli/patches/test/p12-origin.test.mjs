// P12 origin hardening (WO-4; findings F5, F12, F13). Every path resolves relative to this
// file, so the suite tests the patches/ directory it lives in. The tree under test is the
// stock fixture after apply.sh and apply.d/p12.sh; the real patched modules run in sandboxes
// whose relative imports are replaced by stubs generated from each module's own import list.
//   - CLOUDCLI_ALLOWED_ORIGINS: bad/missing-Origin WS upgrade -> 403 before any handler;
//     non-GET/HEAD REST without an allowed Origin -> 403 JSON; GET /health needs no Origin;
//     one log line per rejection, never tokens or cookies; unset -> stock behaviour.
//   - CF_ACCESS_EMAIL pin (case-insensitive) -> mismatch is 401 for REST and WS.
//   - chat.permission-response is accepted only for a requestId pending on a session the
//     connection sent to or subscribed to; anything else is warned and ignored.
//   - "Session synchronization triggered" logs only with CLOUDCLI_DEBUG_SYNC=1.
//   - apply.d/p12.sh: idempotent, --check, .bak-pre-p12, node --check, partial-apply completion.
// Negative control: P12_APPLY=0 skips apply.sh and p12.sh and runs every case against the tree
// as copied (default source: the stock fixture, which has no P12) -> the suite must exit 1.
// P12_TREE=<package dir> replaces the stock fixture as the source tree.
import { test as nodeTest, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stockSrc } from './stock-src.mjs';

const PATCHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_ROOT = path.dirname(PATCHES);
const INSTALL_MODULES = path.join(INSTALL_ROOT, 'node_modules');
const requireFromInstall = createRequire(path.join(INSTALL_ROOT, 'package.json'));
const MISSING_DEPS = fs.existsSync(INSTALL_MODULES) ? false : `CloudCLI dependency dir missing: ${INSTALL_MODULES} (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT to a full install)`;
const WebSocket = MISSING_DEPS ? null : requireFromInstall('ws');
const express = MISSING_DEPS ? null : requireFromInstall('express');
const test = (name, fn) => nodeTest(name, { skip: MISSING_DEPS }, fn);
const P12_SCRIPT = path.join(PATCHES, 'apply.d', 'p12.sh');
const APPLY = process.env.P12_APPLY !== '0';

const ALLOWED = 'https://agent.example.test';
const SECOND = 'https://second.example.test';
const EVIL = 'https://evil.example.test';
const AUD = 'p12-test-audience';
const TEAM = 'p12-test-team.example.test';
const KID = 'p12-test-key';
const SECRET_QUERY = 'p12-query-token-must-not-be-logged';
const SECRET_COOKIE = 'p12-cookie-must-not-be-logged';
const ENV_KEYS = ['CLOUDCLI_ALLOWED_ORIGINS', 'CF_ACCESS_AUD', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_EMAIL', 'CLOUDCLI_DEBUG_SYNC'];

const REL = {
    access: 'server/modules/auth/access-jwt.js',
    index: 'server/index.js',
    wsServer: 'server/modules/websocket/services/websocket-server.service.js',
    chat: 'server/modules/websocket/services/chat-websocket.service.js',
    watcher: 'server/modules/providers/services/sessions-watcher.service.js',
};
const TS_REL = {
    index: 'server/index.ts',
    wsServer: 'server/modules/websocket/services/websocket-server.service.ts',
    chat: 'server/modules/websocket/services/chat-websocket.service.ts',
    watcher: 'server/modules/providers/services/sessions-watcher.service.ts',
};
const P5_VERIFY_LINE = 'verifyClient: ((info, cb) => guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),';
const SYNC_GATE = "if (process.env.CLOUDCLI_DEBUG_SYNC === '1') console.debug(`Session synchronization triggered";

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const realFetch = globalThis.fetch;
const realWarn = console.warn;

let root;
let pkg;
let distRoot;
let access;
let warnings = [];
const sandboxLinks = [];
const wsState = { verifyCalls: 0, chatConnections: 0, shellConnections: 0 };
const stubCalls = {};
let wsModulePromise = null;
let chatModulePromise = null;

function recorder(name, overrides = {}) {
    const calls = (stubCalls[name] ??= []);
    const fn = function stub(...args) {
        calls.push(args);
        return undefined;
    };
    return new Proxy(fn, {
        get(target, prop) {
            if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
                return overrides[prop];
            }
            if (prop === 'then' || typeof prop === 'symbol') {
                return undefined;
            }
            return recorder(`${name}.${String(prop)}`);
        },
    });
}

const stubValues = {
    verifyWebSocketClient: () => {
        wsState.verifyCalls += 1;
        return true;
    },
    handleChatConnection: () => {
        wsState.chatConnections += 1;
    },
    handleShellConnection: () => {
        wsState.shellConnections += 1;
    },
    parseIncomingJsonObject: (raw) => {
        try {
            const value = JSON.parse(String(raw));
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        }
        catch {
            return null;
        }
    },
    WS_OPEN_STATE: 1,
    connectedClients: new Set(),
    chatRunRegistry: recorder('chatRunRegistry', {
        getRun: () => undefined,
        isProcessing: () => false,
        attachConnection: () => false,
        replayEvents: () => [],
        startRun: () => null,
    }),
    sessionsDb: recorder('sessionsDb', { getSessionById: () => null }),
    normalizeAttachmentDescriptors: () => [],
    isImageAttachmentDescriptor: () => false,
    getGlobalImageAssetsDir: () => '/nonexistent-p12-assets',
};
globalThis.__p12stub = {
    value(name) {
        return Object.prototype.hasOwnProperty.call(stubValues, name) ? stubValues[name] : recorder(name);
    },
};

function runScript(script, args) {
    return spawnSync('bash', [script, ...args], { encoding: 'utf8' });
}

function treeFile(rel) {
    return path.join(distRoot, rel);
}

function srcFile(rel) {
    return path.join(pkg, rel);
}

function sha(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function captureWarnings() {
    warnings = [];
    console.warn = (...args) => {
        warnings.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
}

function assertNoSecrets(lines) {
    for (const line of lines) {
        assert.ok(!line.includes(SECRET_QUERY), `query token leaked into a log line: ${line}`);
        assert.ok(!line.includes(SECRET_COOKIE), `cookie leaked into a log line: ${line}`);
        assert.ok(!line.includes('eyJ'), `JWT-like value leaked into a log line: ${line}`);
    }
}

function buildSandbox(name, moduleRel, realRels = []) {
    const sb = path.join(root, name);
    fs.mkdirSync(sb, { recursive: true });
    fs.writeFileSync(path.join(sb, 'package.json'), JSON.stringify({ type: 'module' }));
    const link = path.join(sb, 'node_modules');
    fs.symlinkSync(INSTALL_MODULES, link, 'dir');
    sandboxLinks.push(link);
    const real = new Set();
    for (const rel of [moduleRel, ...realRels]) {
        const target = path.join(sb, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(treeFile(rel), target);
        real.add(target);
    }
    const entry = path.join(sb, moduleRel);
    const source = fs.readFileSync(entry, 'utf8');
    const stubs = new Map();
    for (const match of source.matchAll(/^[ \t]*import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
        const [, clause, spec] = match;
        if (!spec.startsWith('.')) {
            continue;
        }
        const target = path.resolve(path.dirname(entry), spec);
        if (real.has(target)) {
            continue;
        }
        const stub = stubs.get(target) ?? { names: new Set(), hasDefault: false };
        const braced = /\{([\s\S]*)\}/.exec(clause);
        if (braced) {
            for (const part of braced[1].split(',')) {
                const exported = part.trim().split(/\s+as\s+/)[0].trim();
                if (exported === 'default') {
                    stub.hasDefault = true;
                }
                else if (exported) {
                    stub.names.add(exported);
                }
            }
        }
        const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
        if (head && !head.startsWith('*')) {
            stub.hasDefault = true;
        }
        stubs.set(target, stub);
    }
    for (const match of source.matchAll(/^[ \t]*import\s+['"](\.[^'"]+)['"]/gm)) {
        const target = path.resolve(path.dirname(entry), match[1]);
        if (!real.has(target) && !stubs.has(target)) {
            stubs.set(target, { names: new Set(), hasDefault: false });
        }
    }
    for (const [target, stub] of stubs) {
        const lines = ['const S = globalThis.__p12stub;'];
        for (const exported of stub.names) {
            lines.push(`export const ${exported} = S.value(${JSON.stringify(exported)});`);
        }
        if (stub.hasDefault) {
            lines.push(`export default S.value(${JSON.stringify(`default:${path.basename(target)}`)});`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${lines.join('\n')}\n`);
    }
    return entry;
}

function loadWsModule() {
    wsModulePromise ??= import(pathToFileURL(buildSandbox('sb-ws', REL.wsServer, [REL.access])).href);
    return wsModulePromise;
}

function loadChatModule() {
    chatModulePromise ??= import(pathToFileURL(buildSandbox('sb-chat', REL.chat)).href);
    return chatModulePromise;
}

async function startWsGateway() {
    const mod = await loadWsModule();
    const server = http.createServer((req, res) => {
        res.statusCode = 404;
        res.end();
    });
    const wss = mod.createWebSocketServer(server, { verifyClient: {}, chat: {}, shell: {}, getPluginPort: () => 0 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        async close() {
            for (const client of wss.clients) {
                client.terminate();
            }
            await new Promise((resolve) => wss.close(() => resolve()));
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

function connect(port, { origin, urlPath = `/ws?token=${SECRET_QUERY}`, headers = {} } = {}) {
    return new Promise((resolve) => {
        const options = { headers: { cookie: `session=${SECRET_COOKIE}`, 'user-agent': 'p12-ws-agent', ...headers } };
        if (origin) {
            options.origin = origin;
        }
        const client = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, options);
        let settled = false;
        const done = (value) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        client.on('open', () => {
            done({ opened: true, status: 101 });
            client.close();
        });
        client.on('error', (error) => {
            const match = /Unexpected server response: (\d+)/.exec(error.message);
            done({ opened: false, status: match ? Number(match[1]) : null, error: error.message });
        });
    });
}

async function startRestApp() {
    const app = express();
    app.use(express.json());
    app.use(access.accessRestMiddleware);
    app.use(access.originRestMiddleware);
    const hits = { health: 0, post: 0 };
    app.get('/health', (req, res) => {
        hits.health += 1;
        res.json({ status: 'ok' });
    });
    app.post('/api/echo', (req, res) => {
        hits.post += 1;
        res.json({ ok: true });
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        hits,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

function request(port, { method = 'GET', urlPath = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { connection: 'close', ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                text += chunk;
            });
            res.on('end', () => {
                let json = null;
                try {
                    json = text ? JSON.parse(text) : null;
                }
                catch {
                    json = null;
                }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
}

function b64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken(payload = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ typ: 'JWT', alg: 'RS256', kid: KID });
    const body = b64url({ iss: `https://${TEAM}`, sub: 'p12@test', aud: [AUD], exp: now + 600, nbf: now - 10, ...payload });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

function enableAccess(email) {
    process.env.CF_ACCESS_AUD = AUD;
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
    if (email !== undefined) {
        process.env.CF_ACCESS_EMAIL = email;
    }
    access.resetAccessStateForTesting();
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: KID, n: jwk.n, e: jwk.e }] }),
    });
}

function fakeSocket() {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.sent = [];
    ws.send = (payload) => {
        ws.sent.push(JSON.parse(payload));
    };
    return ws;
}

async function sendFrame(ws, frame) {
    ws.emit('message', Buffer.from(JSON.stringify(frame)));
    for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

before(async () => {
    if (MISSING_DEPS) return;
    fs.mkdirSync('/var/tmp/claude', { recursive: true });
    root = fs.mkdtempSync('/var/tmp/claude/p12-test-');
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    distRoot = path.join(pkg, 'dist-server');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(process.env.P12_TREE || stockSrc(), pkg, { recursive: true });
    if (APPLY) {
        const base = runScript(path.join(PATCHES, 'apply.sh'), [root]);
        assert.equal(base.status, 0, `apply.sh stdout:\n${base.stdout}\nstderr:\n${base.stderr}`);
        const p12 = runScript(P12_SCRIPT, [root]);
        assert.equal(p12.status, 0, `p12.sh stdout:\n${p12.stdout}\nstderr:\n${p12.stderr}`);
        assert.match(p12.stdout, /P12 apply OK/);
    }
    access = await import(pathToFileURL(treeFile(REL.access)).href);
});

after(() => {
    if (MISSING_DEPS) return;
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    for (const link of sandboxLinks) {
        fs.unlinkSync(link);
    }
    fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    if (MISSING_DEPS) return;
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
    access.resetAccessStateForTesting();
    wsState.verifyCalls = 0;
    wsState.chatConnections = 0;
    wsState.shellConnections = 0;
    captureWarnings();
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
    console.warn = realWarn;
    globalThis.fetch = realFetch;
});

test('P12 WS: bad or missing Origin -> 403 before the Access guard, auth and every connection handler; one clean log line each', async () => {
    process.env.CLOUDCLI_ALLOWED_ORIGINS = ALLOWED;
    const gateway = await startWsGateway();
    try {
        const bad = await connect(gateway.port, { origin: EVIL });
        assert.equal(bad.opened, false);
        assert.equal(bad.status, 403, bad.error);
        const none = await connect(gateway.port, {});
        assert.equal(none.status, 403, none.error);
        const shell = await connect(gateway.port, { origin: 'null', urlPath: '/shell' });
        assert.equal(shell.status, 403, shell.error);
        assert.equal(wsState.chatConnections, 0, 'chat handler must not run');
        assert.equal(wsState.shellConnections, 0, 'shell handler must not run');
        assert.equal(wsState.verifyCalls, 0, 'rejected before the app verifyClient');
    }
    finally {
        await gateway.close();
    }
    const lines = warnings.filter((line) => line.includes('[origin-allowlist] rejected websocket upgrade'));
    assert.equal(lines.length, 3, warnings.join('\n'));
    assert.match(lines[0], /method="GET" path="\/ws" origin="https:\/\/evil\.example\.test" peer="(::ffff:)?127\.0\.0\.1" cfip=- ua="p12-ws-agent"/);
    assert.match(lines[1], /path="\/ws" origin=- /);
    assert.match(lines[2], /path="\/shell" origin="null"/);
    assertNoSecrets(warnings);
});

test('P12 WS: an allowed Origin passes through the P5 guard and the app verifyClient to the handler', async () => {
    process.env.CLOUDCLI_ALLOWED_ORIGINS = ` ${SECOND} , ${ALLOWED}/ `;
    const gateway = await startWsGateway();
    try {
        const good = await connect(gateway.port, { origin: ALLOWED });
        assert.equal(good.opened, true, good.error);
        const defaultPort = await connect(gateway.port, { origin: 'https://AGENT.example.test:443' });
        assert.equal(defaultPort.opened, true, defaultPort.error);
        assert.equal(wsState.verifyCalls, 2);
        assert.equal(wsState.chatConnections, 2);
    }
    finally {
        await gateway.close();
    }
    assert.equal(warnings.length, 0, warnings.join('\n'));
});

test('P12 REST: missing or bad Origin on POST/DELETE -> 403 JSON; allowed Origins pass; GET is exempt', async () => {
    process.env.CLOUDCLI_ALLOWED_ORIGINS = `${ALLOWED},${SECOND}`;
    const app = await startRestApp();
    const secretHeaders = { 'content-type': 'application/json', cookie: `CF_Authorization=${SECRET_COOKIE}`, 'user-agent': 'p12-rest-agent' };
    try {
        const missing = await request(app.port, { method: 'POST', urlPath: `/api/echo?token=${SECRET_QUERY}`, headers: secretHeaders, body: '{}' });
        assert.equal(missing.status, 403);
        assert.deepEqual(missing.json, { error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
        const bad = await request(app.port, { method: 'POST', urlPath: '/api/echo', headers: { ...secretHeaders, origin: EVIL }, body: '{}' });
        assert.equal(bad.status, 403);
        const del = await request(app.port, { method: 'DELETE', urlPath: '/api/echo' });
        assert.equal(del.status, 403);
        const good = await request(app.port, { method: 'POST', urlPath: '/api/echo', headers: { ...secretHeaders, origin: ALLOWED }, body: '{}' });
        assert.equal(good.status, 200);
        const second = await request(app.port, { method: 'POST', urlPath: '/api/echo', headers: { ...secretHeaders, origin: SECOND }, body: '{}' });
        assert.equal(second.status, 200);
        const getWithBadOrigin = await request(app.port, { urlPath: '/health', headers: { origin: EVIL } });
        assert.equal(getWithBadOrigin.status, 200);
        assert.equal(app.hits.post, 2, 'only allowed-Origin POSTs reach the route');
    }
    finally {
        await app.close();
    }
    const lines = warnings.filter((line) => line.includes('[origin-allowlist] rejected request'));
    assert.equal(lines.length, 3, warnings.join('\n'));
    assert.match(lines[0], /method="POST" path="\/api\/echo" origin=- peer="(::ffff:)?127\.0\.0\.1" cfip=- ua="p12-rest-agent"/);
    assert.match(lines[1], /origin="https:\/\/evil\.example\.test"/);
    assert.match(lines[2], /method="DELETE" path="\/api\/echo"/);
    assertNoSecrets(warnings);
});

test('P12 REST: GET and HEAD /health without an Origin are allowed while the allowlist is active', async () => {
    process.env.CLOUDCLI_ALLOWED_ORIGINS = ALLOWED;
    const app = await startRestApp();
    try {
        const get = await request(app.port, { urlPath: '/health' });
        assert.equal(get.status, 200);
        assert.deepEqual(get.json, { status: 'ok' });
        const head = await request(app.port, { method: 'HEAD', urlPath: '/health' });
        assert.equal(head.status, 200);
    }
    finally {
        await app.close();
    }
    assert.equal(warnings.length, 0, warnings.join('\n'));
});

test('P12 allowlist set but without one valid origin fails closed (all writes and upgrades rejected)', async () => {
    process.env.CLOUDCLI_ALLOWED_ORIGINS = 'not-an-origin, ftp://files.example.test, https://agent.example.test/path';
    assert.equal(access.isOriginAllowlistEnabled(), true);
    const app = await startRestApp();
    try {
        const post = await request(app.port, { method: 'POST', urlPath: '/api/echo', headers: { origin: ALLOWED, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(post.status, 403);
    }
    finally {
        await app.close();
    }
    assert.ok(warnings.some((line) => line.includes('CLOUDCLI_ALLOWED_ORIGINS has 0 valid origin(s)')), warnings.join('\n'));
});

test('P12 env unset -> stock behaviour: no Origin needed, any email accepted, no rejection logs', async () => {
    assert.equal(access.isOriginAllowlistEnabled(), false);
    process.env.CLOUDCLI_ALLOWED_ORIGINS = '   ';
    assert.equal(access.isOriginAllowlistEnabled(), false, 'blank value means unset');
    const gateway = await startWsGateway();
    try {
        const none = await connect(gateway.port, {});
        assert.equal(none.opened, true, none.error);
        const evil = await connect(gateway.port, { origin: EVIL });
        assert.equal(evil.opened, true, evil.error);
        assert.equal(wsState.chatConnections, 2);
    }
    finally {
        await gateway.close();
    }
    const app = await startRestApp();
    try {
        const post = await request(app.port, { method: 'POST', urlPath: '/api/echo', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(post.status, 200);
        enableAccess();
        const anyEmail = await request(app.port, { urlPath: '/health', headers: { 'cf-access-jwt-assertion': makeToken({ email: 'someone@else.test' }) } });
        assert.equal(anyEmail.status, 200, 'without CF_ACCESS_EMAIL any valid assertion passes (P5 unchanged)');
    }
    finally {
        await app.close();
    }
    assert.equal(warnings.length, 0, warnings.join('\n'));
});

test('P12 CF_ACCESS_EMAIL pin: mismatch or missing email -> 401 (REST and WS); case-insensitive match passes; reject lines carry reason/path/peer only', async () => {
    enableAccess(' Owner@Example.TEST ');
    const owner = makeToken({ email: 'owner@example.test' });
    const ownerUpper = makeToken({ email: 'OWNER@example.test' });
    const other = makeToken({ email: 'intruder@example.test' });
    const noEmail = makeToken({ common_name: 'service-token' });
    const app = await startRestApp();
    try {
        const mismatch = await request(app.port, { urlPath: `/api/echo?token=${SECRET_QUERY}`, headers: { 'cf-access-jwt-assertion': other } });
        assert.equal(mismatch.status, 401);
        assert.deepEqual(mismatch.json, { error: 'Cloudflare Access validation failed', code: 'CF_ACCESS_DENIED' });
        const missing = await request(app.port, { urlPath: '/health', headers: { cookie: `CF_Authorization=${noEmail}` } });
        assert.equal(missing.status, 401);
        const ok = await request(app.port, { urlPath: '/health', headers: { 'cf-access-jwt-assertion': ownerUpper } });
        assert.equal(ok.status, 200);
        const absent = await request(app.port, { urlPath: '/health' });
        assert.equal(absent.status, 401);
    }
    finally {
        await app.close();
    }
    const gateway = await startWsGateway();
    try {
        const wsMismatch = await connect(gateway.port, { headers: { 'cf-access-jwt-assertion': other } });
        assert.equal(wsMismatch.status, 401, wsMismatch.error);
        assert.equal(wsState.verifyCalls, 0, 'Access rejection happens before the app verifyClient');
        const wsOwner = await connect(gateway.port, { headers: { 'cf-access-jwt-assertion': owner } });
        assert.equal(wsOwner.opened, true, wsOwner.error);
        assert.equal(wsState.chatConnections, 1);
    }
    finally {
        await gateway.close();
    }
    const rest = warnings.filter((line) => line.includes('[cloudflare-access] rejected request'));
    assert.equal(rest.length, 3, warnings.join('\n'));
    assert.match(rest[0], /reason="access assertion email mismatch" method="GET" path="\/api\/echo" peer="(::ffff:)?127\.0\.0\.1"/);
    assert.match(rest[1], /reason="access assertion email mismatch" method="GET" path="\/health"/);
    assert.match(rest[2], /reason="missing access assertion" method="GET" path="\/health"/);
    const ws = warnings.filter((line) => line.includes('[cloudflare-access] rejected websocket upgrade'));
    assert.equal(ws.length, 1, warnings.join('\n'));
    assert.match(ws[0], /reason="access assertion email mismatch" method="GET" path="\/ws" peer=/);
    assertNoSecrets(warnings);
});

test('P12 permission: a foreign, unknown, unbound or mis-claimed requestId is warned and ignored; an owned pending one resolves', async () => {
    const chat = await loadChatModule();
    const pending = [
        { requestId: 'req-A', sessionId: 'sess-A', toolName: 'Bash' },
        { requestId: 'req-B', sessionId: 'sess-B', toolName: 'Bash' },
    ];
    const resolved = [];
    const dependencies = {
        runtime: {
            getPendingApprovalsForSession: (sessionId) => pending.filter((item) => item.sessionId === sessionId),
            resolveToolApproval: (requestId, decision) => resolved.push({ requestId, decision }),
            hasRuntime: () => true,
        },
    };
    const owner = fakeSocket();
    const other = fakeSocket();
    chat.handleChatConnection(owner, { user: { id: 1 } }, dependencies);
    chat.handleChatConnection(other, { user: { id: 1 } }, dependencies);
    await sendFrame(owner, { type: 'chat.subscribe', sessions: [{ sessionId: 'sess-A', lastSeq: 0 }] });
    await sendFrame(owner, { type: 'chat.permission-response', requestId: 'req-B', allow: true });
    await sendFrame(owner, { type: 'chat.permission-response', requestId: 'req-unknown', allow: true });
    await sendFrame(other, { type: 'chat.permission-response', requestId: 'req-A', allow: true });
    await sendFrame(owner, { type: 'chat.permission-response', requestId: 'req-A', sessionId: 'sess-B', allow: true });
    assert.deepEqual(resolved, [], 'nothing outside the connection\'s own pending requests may resolve');
    const ignored = warnings.filter((line) => line.includes('Ignoring chat.permission-response'));
    assert.equal(ignored.length, 4, warnings.join('\n'));
    await sendFrame(owner, { type: 'chat.permission-response', requestId: 'req-A', allow: true, updatedInput: { answers: { q: 'yes' } } });
    assert.deepEqual(resolved.map((item) => item.requestId), ['req-A']);
    assert.equal(resolved[0].decision.allow, true);
    assert.deepEqual(resolved[0].decision.updatedInput, { answers: { q: 'yes' } });
    await sendFrame(other, { type: 'chat.send', sessionId: 'sess-B', content: 'continue' });
    await sendFrame(other, { type: 'chat.permission-response', requestId: 'req-B', allow: false, message: 'no' });
    assert.deepEqual(resolved.map((item) => item.requestId), ['req-A', 'req-B'], 'chat.send binds the session to the connection');
    assert.equal(resolved[1].decision.allow, false);
    await sendFrame(owner, { type: 'chat.permission-response', requestId: '', allow: true });
    assert.equal(warnings.filter((line) => line.includes('Ignoring chat.permission-response')).length, 4, 'an empty requestId stays silent (stock)');
});

test('P12 sync log: "Session synchronization triggered" only with CLOUDCLI_DEBUG_SYNC=1 (dist statement executed; TS gated the same)', () => {
    const dist = fs.readFileSync(treeFile(REL.watcher), 'utf8');
    const start = dist.indexOf(SYNC_GATE);
    assert.notEqual(start, -1, 'dist watcher log line is gated');
    const statement = dist.slice(start, dist.indexOf('});', start) + 3);
    const run = new Function('process', 'console', 'eventType', 'provider', 'filePath', 'result', statement);
    const make = () => {
        const calls = [];
        const record = (level) => (...args) => calls.push([level, ...args]);
        return { calls, console: { log: record('log'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') } };
    };
    const quiet = make();
    run({ env: {} }, quiet.console, 'change', 'claude', '/x.jsonl', { sessionId: 's1' });
    run({ env: { CLOUDCLI_DEBUG_SYNC: 'true' } }, quiet.console, 'change', 'claude', '/x.jsonl', { sessionId: 's1' });
    assert.equal(quiet.calls.length, 0);
    const loud = make();
    run({ env: { CLOUDCLI_DEBUG_SYNC: '1' } }, loud.console, 'change', 'claude', '/x.jsonl', { sessionId: 's1' });
    assert.equal(loud.calls.length, 1);
    assert.equal(loud.calls[0][0], 'debug');
    assert.equal(loud.calls[0][1], 'Session synchronization triggered by change event for provider "claude"');
    assert.deepEqual(loud.calls[0][2], { filePath: '/x.jsonl', sessionId: 's1' });
    const ts = fs.readFileSync(srcFile(TS_REL.watcher), 'utf8');
    assert.ok(ts.includes(SYNC_GATE), 'TS watcher log line is gated');
    for (const source of [dist, ts]) {
        assert.ok(!source.includes('console.log(`Session synchronization triggered'), 'no ungated sync log remains');
    }
});

test('P12 wiring: index mounts originRestMiddleware right after the P5 guard; WS options wrapped; P5 lines byte-identical (dist + TS)', () => {
    for (const file of [treeFile(REL.index), srcFile(TS_REL.index)]) {
        const source = fs.readFileSync(file, 'utf8');
        assert.ok(source.includes("import { accessRestMiddleware } from './modules/auth/access-jwt.js';\nimport { originRestMiddleware } from './modules/auth/access-jwt.js';"), `${file}: import`);
        const mount = source.indexOf('app.use(accessRestMiddleware);\napp.use(originRestMiddleware);\n');
        assert.ok(mount !== -1, `${file}: origin guard right after the Access guard`);
        assert.ok(mount < source.indexOf("app.get('/health'"), `${file}: before /health`);
    }
    const wsDist = fs.readFileSync(treeFile(REL.wsServer), 'utf8');
    assert.ok(wsDist.includes(P5_VERIFY_LINE), 'dist: P5 verifyClient one-liner unchanged');
    assert.match(wsDist, /new WebSocketServer\(withWebSocketOriginGuard\(\{\n\s+server,\n\s+verifyClient: \(\(info, cb\) => guardAccessWebSocketUpgrade[^\n]+\n\s+\}\)\);/);
    const wsTs = fs.readFileSync(srcFile(TS_REL.wsServer), 'utf8');
    assert.ok(wsTs.includes(') => guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),'), 'ts: P5 body unchanged');
    assert.ok(wsTs.includes('new WebSocketServer(withWebSocketOriginGuard({'), 'ts: wrapped');
    for (const file of [treeFile(REL.chat), srcFile(TS_REL.chat)]) {
        const source = fs.readFileSync(file, 'utf8');
        assert.ok(source.includes('handlePermissionResponse(data, dependencies, ws);'), `${file}: call passes ws`);
        assert.ok(source.includes('p12NoteConnectionSessions(ws, messageType, data);'), `${file}: binding`);
        assert.ok(source.includes('if (!p12PermissionResponseAllowed(ws, data, dependencies)) {'), `${file}: guard`);
    }
});

test('P12 patched dist files pass node --check and patched TS files parse', () => {
    const scratch = path.join(root, 'syntax');
    fs.mkdirSync(scratch, { recursive: true });
    for (const rel of Object.values(REL)) {
        const target = path.join(scratch, `${rel.replaceAll('/', '_')}.check.mjs`);
        fs.copyFileSync(treeFile(rel), target);
        const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${rel}: ${check.stderr}`);
    }
    let ts = null;
    try {
        ts = requireFromInstall('typescript');
    }
    catch {
        ts = null;
    }
    if (ts) {
        for (const rel of Object.values(TS_REL)) {
            const out = ts.transpileModule(fs.readFileSync(srcFile(rel), 'utf8'), {
                fileName: rel,
                reportDiagnostics: true,
                compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
            });
            assert.equal((out.diagnostics ?? []).length, 0, `${rel}: TS syntax diagnostics`);
        }
    }
});

test('p12.sh: idempotent re-run, --check OK, one .bak-pre-p12 per edited file, apply.sh --check still OK', () => {
    const edited = [...Object.values(REL).filter((rel) => rel !== REL.access).map(treeFile), ...Object.values(TS_REL).map(srcFile)];
    const before = edited.map(sha);
    const rerun = runScript(P12_SCRIPT, [root]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.doesNotMatch(rerun.stdout, /P12 (patched|copied):/, rerun.stdout);
    assert.equal((rerun.stdout.match(/P12 already applied:/g) ?? []).length, 8, rerun.stdout);
    assert.deepEqual(edited.map(sha), before, 'a second apply changes nothing');
    const check = runScript(P12_SCRIPT, ['--check', root]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /P12 check OK/);
    const base = runScript(path.join(PATCHES, 'apply.sh'), ['--check', root]);
    assert.equal(base.status, 0, base.stderr);
    for (const file of edited) {
        const backup = `${file}.bak-pre-p12`;
        assert.ok(fs.existsSync(backup), `${backup} exists`);
        const saved = fs.readFileSync(backup, 'utf8');
        assert.ok(!/p12NoteConnectionSessions|p12PermissionResponseAllowed|withWebSocketOriginGuard|originRestMiddleware|CLOUDCLI_DEBUG_SYNC/.test(saved), `${backup} holds the pre-P12 state`);
    }
});

test('p12.sh: --check exits 1 on a partially reverted tree and a re-run completes the partial apply', () => {
    const target = treeFile(REL.chat);
    const patched = fs.readFileSync(target, 'utf8');
    fs.copyFileSync(`${target}.bak-pre-p12`, target);
    const check = runScript(P12_SCRIPT, ['--check', root]);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /MISSING: P12 .*chat-websocket\.service\.js \(permission helpers, permission guard, permission call passes ws, connection session binding\)/);
    const rerun = runScript(P12_SCRIPT, [root]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /P12 patched: .*dist-server\/server\/modules\/websocket\/services\/chat-websocket\.service\.js/);
    // apply.sh runs every apply.d drop-in in C order: the drop-ins after p12 (p13+) also edit this file, so a
    // real apply.sh re-run re-applies them on top; do the same before comparing with the fully patched file.
    const later = fs.readdirSync(path.join(PATCHES, 'apply.d')).filter((f) => /^p\d+\.sh$/.test(f) && f > 'p12.sh').sort();
    for (const f of later) {
        const r = runScript(path.join(PATCHES, 'apply.d', f), [root]);
        assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
    assert.equal(fs.readFileSync(target, 'utf8'), patched, 're-run reproduces the identical patched file');
    const after = runScript(P12_SCRIPT, ['--check', root]);
    assert.equal(after.status, 0, after.stderr);
});
