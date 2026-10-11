// WO-E1: apply.sh against a temp copy under /var/tmp/claude (live install untouched).
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
const SYNTAX_DIR = '/var/tmp/claude/wo-e1-apply-syntax';
let root;
let pkg;

function runApply(args) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8' });
}

function makeCopy() {
    fs.mkdirSync(path.join(root, 'node_modules', '@cloudcli-ai'), { recursive: true });
    fs.cpSync(SRC, pkg, { recursive: true });
}

before(async () => {
    root = `/var/tmp/claude/wo-e1-apply-${process.pid}-${Date.now()}`;
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(SYNTAX_DIR, { recursive: true });
});

after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(SYNTAX_DIR, { recursive: true, force: true });
});

test('apply.sh applies P1 and P2 to a temp copy and exits 0', () => {
    makeCopy();
    const result = runApply([root]);
    assert.equal(result.status, 0, `apply stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('P1 patched:') || result.stdout.includes('P1 already applied:'), result.stdout);
    assert.ok(result.stdout.includes('P2 patched:') || result.stdout.includes('P2 already applied:'), result.stdout);
});

test('apply.sh: P1 provider edits present, indented, in both trees', async () => {
    const dist = await fsp.readFile(path.join(pkg, 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js'), 'utf8');
    const ts = await fsp.readFile(path.join(pkg, 'server/modules/providers/list/claude/claude-sessions.provider.ts'), 'utf8');
    for (const [label, source] of [['dist', dist], ['ts', ts]]) {
        assert.ok(source.includes("import { isSubagentStillLive } from './subagent-live.js';"), `${label}: helper import`);
        assert.ok(/^ {12,}const transcriptMtime = await fsp\.stat\(/m.test(source) || /^ {6}const transcriptMtime = await fsp\.stat\(/m.test(source), `${label}: mtime capture is indented`);
        assert.ok(/\n\s+transcriptMtime,\n/m.test(source), `${label}: transcriptMtime plumbed into the map entry`);
        assert.ok(source.includes('&& (!subagent || subagent.endedMidToolCall || isSubagentStillLive(subagent));'), `${label}: live condition`);
    }
    assert.ok(ts.includes('transcriptMtime: number;'), 'ts: map value type extended');
});

test('apply.sh: P2 module files copied to both trees', async () => {
    for (const tree of ['dist-server/server', 'server']) {
        await assert.ok(fs.existsSync(path.join(pkg, tree, 'modules/bg-tasks/bg-tasks.service.js')), `${tree}: service`);
        await assert.ok(fs.existsSync(path.join(pkg, tree, 'modules/bg-tasks/bg-tasks.routes.js')), `${tree}: routes`);
    }
});

test('apply.sh: /api/bg-tasks mounted behind authenticateToken in both trees', async () => {
    const dist = await fsp.readFile(path.join(pkg, 'dist-server/server/index.js'), 'utf8');
    const ts = await fsp.readFile(path.join(pkg, 'server/index.ts'), 'utf8');
    for (const [label, source] of [['dist', dist], ['ts', ts]]) {
        assert.ok(source.includes("import { bgTasksRoutes } from './modules/bg-tasks/bg-tasks.routes.js';"), `${label}: import`);
        assert.ok(source.includes("app.use('/api/bg-tasks', authenticateToken, bgTasksRoutes);"), `${label}: mount`);
    }
});

test('apply.sh: patched JavaScript still parses as ESM', () => {
    const files = [
        'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js',
        'dist-server/server/modules/providers/list/claude/subagent-live.js',
        'dist-server/server/index.js',
        'dist-server/server/modules/bg-tasks/bg-tasks.service.js',
        'dist-server/server/modules/bg-tasks/bg-tasks.routes.js',
    ];
    for (const rel of files) {
        const target = path.join(SYNTAX_DIR, rel.replaceAll('/', '_') + '.check.mjs');
        fs.copyFileSync(path.join(pkg, rel), target);
        const check = spawnSync('node', ['--check', target], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${rel}: ${check.stderr}`);
    }
});

test('apply.sh is idempotent: second run changes nothing and exits 0', () => {
    const before = fs.readFileSync(path.join(pkg, 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js'), 'utf8');
    const result = runApply([root]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('P1 already applied'), result.stdout);
    assert.ok(result.stdout.includes('P2 already applied'), result.stdout);
    const after = fs.readFileSync(path.join(pkg, 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js'), 'utf8');
    assert.equal(after, before);
});

test('apply.sh --check exits 0 on a fully patched copy', () => {
    const result = runApply(['--check', root]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('check OK'), result.stdout);
});

test('apply.sh --check exits 1 when a patch is missing', () => {
    const fresh = `/var/tmp/claude/wo-e1-apply-fresh-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(fresh, 'node_modules', '@cloudcli-ai'), { recursive: true });
    try {
        fs.cpSync(SRC, path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
        // Knock the P1 marker out of the copy so the patch is really missing,
        // whatever state the live install is in.
        const target = path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli', 'dist-server', 'server', 'modules', 'providers', 'list', 'claude', 'claude-sessions.provider.js');
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('isSubagentStillLive', 'knockedOut'));
        const result = runApply(['--check', fresh]);
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes('MISSING: P1 ') && result.stderr.includes('claude-sessions.provider.js'), result.stderr);
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
