// FP-2 P5: apply.sh Cloudflare Access patch against a temp copy under /var/tmp/claude/fp2.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const PATCHES = `${AI_SETUP_ROOT}/cloudcli/patches`;
const SRC = `${AI_SETUP_ROOT}/cloudcli/node_modules/@cloudcli-ai/cloudcli`;
const MISSING_DEPS = fs.existsSync(SRC) ? false : `CloudCLI dependency dir missing: ${SRC} (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT to a full install)`;
const test = (name, fn) => nodeTest(name, { skip: MISSING_DEPS }, fn);
const SYNTAX_DIR = '/var/tmp/claude/fp2-syntax';
let root;
let pkg;

function runApply(args) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8' });
}

before(async () => {
    root = `/var/tmp/claude/fp2/apply-${process.pid}-${Date.now()}`;
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    if (MISSING_DEPS) return;
    fs.cpSync(SRC, pkg, { recursive: true });
    fs.mkdirSync(SYNTAX_DIR, { recursive: true });
});

after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(SYNTAX_DIR, { recursive: true, force: true });
});

test('apply.sh applies P5 to a temp copy and exits 0', () => {
    const result = runApply([root]);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('P5 copied:'), result.stdout);
    assert.ok(result.stdout.includes('P5 patched:') || result.stdout.includes('P5 already applied:'), result.stdout);
});

test('P5: access-jwt.js copied byte-identical to both trees', async () => {
    const canonical = fs.readFileSync(path.join(PATCHES, 'files/access-jwt.js'), 'utf8');
    for (const tree of ['dist-server/server', 'server']) {
        const target = path.join(pkg, tree, 'modules/auth/access-jwt.js');
        assert.ok(fs.existsSync(target), `${tree}: access-jwt.js present`);
        assert.equal(fs.readFileSync(target, 'utf8'), canonical, `${tree}: identical to patches/files`);
    }
});

test('P5: app-wide REST guard mounted BEFORE /health in both trees', async () => {
    const dist = await fsp.readFile(path.join(pkg, 'dist-server/server/index.js'), 'utf8');
    const ts = await fsp.readFile(path.join(pkg, 'server/index.ts'), 'utf8');
    for (const [label, source] of [['dist', dist], ['ts', ts]]) {
        assert.ok(source.includes("import { accessRestMiddleware } from './modules/auth/access-jwt.js';"), `${label}: import`);
        const guardPos = source.indexOf('app.use(accessRestMiddleware);');
        const healthPos = source.indexOf("app.get('/health'");
        assert.ok(guardPos !== -1, `${label}: guard mounted`);
        assert.ok(healthPos !== -1, `${label}: /health present`);
        assert.ok(guardPos < healthPos, `${label}: guard before /health (so every route is covered)`);
    }
});

test('P5: WS gateway verifyClient wrapped in both trees', async () => {
    const dist = await fsp.readFile(path.join(pkg, 'dist-server/server/modules/websocket/services/websocket-server.service.js'), 'utf8');
    const ts = await fsp.readFile(path.join(pkg, 'server/modules/websocket/services/websocket-server.service.ts'), 'utf8');
    assert.ok(dist.includes("import { guardAccessWebSocketUpgrade } from '../../auth/access-jwt.js';"), 'dist: import');
    assert.ok(dist.includes('verifyClient: ((info, cb) => guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),'), 'dist: wrapped one-liner');
    assert.ok(ts.includes("import { guardAccessWebSocketUpgrade } from '../../auth/access-jwt.js';"), 'ts: import');
    assert.ok(ts.includes(') => guardAccessWebSocketUpgrade(info, cb, () => verifyWebSocketClient(info, dependencies.verifyClient))),'), 'ts: wrapped body');
});

test('P5: patched files still parse as ESM', () => {
    const files = [
        'dist-server/server/index.js',
        'dist-server/server/modules/websocket/services/websocket-server.service.js',
        'dist-server/server/modules/auth/access-jwt.js',
    ];
    for (const rel of files) {
        const target = path.join(SYNTAX_DIR, rel.replaceAll('/', '_') + '.check.mjs');
        fs.copyFileSync(path.join(pkg, rel), target);
        const check = spawnSync('node', ['--check', target], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${rel}: ${check.stderr}`);
    }
});

test('apply.sh is idempotent for P5 and --check passes afterwards', () => {
    const indexDist = path.join(pkg, 'dist-server/server/index.js');
    const before = fs.readFileSync(indexDist, 'utf8');
    const result = runApply([root]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('P5 already applied:'), result.stdout);
    assert.equal(fs.readFileSync(indexDist, 'utf8'), before);
    const check = runApply(['--check', root]);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes('check OK'), check.stdout);
});

test('apply.sh --check exits 1 when only P5 is missing', () => {
    const target = path.join(pkg, 'dist-server/server/modules/auth/access-jwt.js');
    fs.rmSync(target);
    const check = runApply(['--check', root]);
    assert.equal(check.status, 1);
    assert.ok(check.stderr.includes('MISSING'), check.stderr);
});
