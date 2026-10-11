// WO-G1 P3: apply.sh subagent-timeline patch (LAST 200 steps + subagentHiddenEarlier).
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
const SYNTAX_DIR = '/var/tmp/claude/wo-g1-apply-syntax';
let root;
let pkg;

function runApply(args) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8' });
}

before(async () => {
    root = `/var/tmp/claude/wo-g1-apply-${process.pid}-${Date.now()}`;
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

test('apply.sh applies P3 to a temp copy and exits 0', () => {
    const result = runApply([root]);
    assert.equal(result.status, 0, `apply stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('P3 patched:') || result.stdout.includes('P3 already applied:'), result.stdout);
    assert.ok(result.stdout.includes('P3 maptype patched:') || result.stdout.includes('P3 maptype already applied:'), result.stdout);
});

test('P3: provider keeps the LAST 200 activities and counts the hidden ones (both trees)', async () => {
    const files = [
        ['dist', path.join(pkg, 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js'), 16],
        ['ts', path.join(pkg, 'server/modules/providers/list/claude/claude-sessions.provider.ts'), 8],
    ];
    for (const [label, file, recordIndent] of files) {
        const source = await fsp.readFile(file, 'utf8');
        assert.ok(source.includes('.slice(-MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)'), `${label}: slice from the end`);
        assert.ok(!source.includes('.slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)'), `${label}: old head-slice gone`);
        const record = new RegExp(`^ {${recordIndent}}hiddenEarlier: Math\\.max\\(0, transcript\\.activity\\.length - MAX_TRANSMITTED_SUBAGENT_ACTIVITIES\\),$`, 'm');
        assert.ok(record.test(source), `${label}: hiddenEarlier on the map record at indent ${recordIndent}`);
    }
});

test('P3: subagentHiddenEarlier flows raw message -> toolResultMap -> normalized message (both trees)', async () => {
    const files = [
        ['dist', path.join(pkg, 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js'), { loop: 12, map: 28, msg: 16 }],
        ['ts', path.join(pkg, 'server/modules/providers/list/claude/claude-sessions.provider.ts'), { loop: 6, map: 14, msg: 8 }],
    ];
    for (const [label, file, { loop, map, msg }] of files) {
        const source = await fsp.readFile(file, 'utf8');
        assert.ok(new RegExp(`^ {${loop}}message\\.subagentHiddenEarlier = subagent\\?\\.hiddenEarlier \\?\\? 0;$`, 'm').test(source), `${label}: raw message field`);
        assert.ok(new RegExp(`^ {${map}}subagentHiddenEarlier: raw\\.subagentHiddenEarlier,$`, 'm').test(source), `${label}: toolResultMap carries it`);
        assert.ok(new RegExp(`^ {${msg}}msg\\.subagentHiddenEarlier = toolResult\\.subagentHiddenEarlier \\?\\? 0;$`, 'm').test(source), `${label}: normalized message field`);
    }
});

test('P3: TS type declarations extended', async () => {
    const provider = await fsp.readFile(path.join(pkg, 'server/modules/providers/list/claude/claude-sessions.provider.ts'), 'utf8');
    assert.ok(/^\s*hiddenEarlier: number;$/m.test(provider), 'provider.ts: map value type');
    assert.ok(/^\s*subagentHiddenEarlier\?: number;$/m.test(provider), 'provider.ts: ClaudeToolResult type');
    const types = await fsp.readFile(path.join(pkg, 'server/shared/types.ts'), 'utf8');
    assert.ok(/^\s*subagentHiddenEarlier\?: number;$/m.test(types), 'shared/types.ts: NormalizedMessage type');
});

test('P3: patched provider still parses as ESM', () => {
    const rel = 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js';
    const target = path.join(SYNTAX_DIR, rel.replaceAll('/', '_') + '.check.mjs');
    fs.copyFileSync(path.join(pkg, rel), target);
    const check = spawnSync('node', ['--check', target], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
});

test('apply.sh is idempotent for P3 and --check passes afterwards', async () => {
    const providerDist = path.join(pkg, 'dist-server/server/modules/providers/list/claude/claude-sessions.provider.js');
    const before = fs.readFileSync(providerDist, 'utf8');
    const result = runApply([root]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('P3 already applied:'), result.stdout);
    assert.equal(fs.readFileSync(providerDist, 'utf8'), before);
    const check = runApply(['--check', root]);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes('check OK'), check.stdout);
});

test('apply.sh --check exits 1 on a fresh copy (P3 missing)', () => {
    const fresh = `/var/tmp/claude/wo-g1-apply-fresh-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(fresh, 'node_modules', '@cloudcli-ai'), { recursive: true });
    try {
        fs.cpSync(SRC, path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
        // Knock the P3 marker out of the copy so the patch is really missing,
        // whatever state the live install is in.
        const target = path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli', 'dist-server', 'server', 'modules', 'providers', 'list', 'claude', 'claude-sessions.provider.js');
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('subagentHiddenEarlier', 'knockedOut'));
        const result = runApply(['--check', fresh]);
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes('MISSING: P3 ') && result.stderr.includes('claude-sessions.provider.js'), result.stderr);
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
