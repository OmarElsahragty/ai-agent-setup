// D4 item 3: apply.d/p13.sh is all-or-nothing and has --rollback.
// Tree: stock fixture + THIS patches dir's apply.sh with APPLY_P13 skipped by
// running apply.sh first on a patches copy without p13.sh, then p13.sh.
// Negative control: D4_P13_PATCHES=<pre-D4 patches dir> must FAIL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stockSrc } from './stock-src.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = process.env.D4_P13_PATCHES || path.dirname(HERE);
const D_REL = path.join('node_modules', '@cloudcli-ai', 'cloudcli', 'dist-server', 'server');
const TARGETS = [
    'modules/providers/list/claude/claude-session-synchronizer.provider.js',
    'modules/projects/services/projects-with-sessions-fetch.service.js',
    'modules/websocket/services/session-upsert-broadcast.service.js',
    'modules/websocket/services/chat-websocket.service.js',
    'index.js',
];
const MODULES = ['modules/providers/list/claude/p13-session-origin.js', 'modules/bg-tasks/p13-terminal-live.js'];
let work;
let baseRoot;

const run = (args, env = {}) => spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, ...env } });
function snapshot(root) {
    const out = {};
    for (const rel of [...TARGETS, ...MODULES]) {
        const file = path.join(root, D_REL, rel);
        out[rel] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    }
    return out;
}
function cloneRoot(name) {
    const root = path.join(work, name);
    fs.cpSync(baseRoot, root, { recursive: true });
    return root;
}
// A patches copy whose files/<module> is replaced (the source tree is never edited).
function patchesWith(name, moduleName, text) {
    const dir = path.join(work, name);
    fs.cpSync(PATCHES, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}test${path.sep}fixtures`) });
    fs.writeFileSync(path.join(dir, 'files', moduleName), text);
    return dir;
}

before(() => {
    work = `/var/tmp/claude/d4-p13-${process.pid}-${Date.now()}`;
    baseRoot = path.join(work, 'base');
    const pkg = path.join(baseRoot, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(stockSrc(), pkg, { recursive: true });
    // P0..P12 from a patches copy without p13.sh AND every later drop-in (apply.sh runs
    // apply.d/*.sh C-sorted; p14.sh needs P13), so the base tree is pre-P13.
    const pre = path.join(work, 'patches-pre13');
    fs.cpSync(PATCHES, pre, { recursive: true, filter: (src) => !src.includes(`${path.sep}test${path.sep}fixtures`) });
    for (const name of fs.readdirSync(path.join(pre, 'apply.d'))) {
        if (name.endsWith('.sh') && Buffer.compare(Buffer.from(name), Buffer.from('p13.sh')) >= 0) {
            fs.rmSync(path.join(pre, 'apply.d', name));
        }
    }
    const base = run([path.join(pre, 'apply.sh'), baseRoot]);
    assert.equal(base.status, 0, `apply.sh (pre-P13) failed:\n${base.stdout}\n${base.stderr}`);
});

after(() => {
    fs.rmSync(work, { recursive: true, force: true });
});

test('D4 p13: a module source that fails node --check writes NOTHING (index.js is not patched against a missing module)', () => {
    const root = cloneRoot('t-precheck');
    const before0 = snapshot(root);
    const broken = patchesWith('patches-broken', 'p13-terminal-live.js', 'export const p13TerminalActiveRoutes = (;\n');
    const r = run([path.join(broken, 'apply.d', 'p13.sh'), root]);
    assert.notEqual(r.status, 0, 'the apply fails');
    assert.deepEqual(snapshot(root), before0, `no target or module changed:\n${r.stdout}\n${r.stderr}`);
    assert.equal(fs.existsSync(path.join(root, D_REL, 'index.js.bak-pre-p13')), false, 'no backup made: nothing was written');
});

test('D4 p13: a write that fails mid-commit restores every file already written (all-or-nothing)', () => {
    const root = cloneRoot('t-commit');
    const before0 = snapshot(root);
    const r = run([path.join(PATCHES, 'apply.d', 'p13.sh'), root], { P13_TEST_FAIL_BEFORE: 'dist-server/server/index.js' });
    assert.notEqual(r.status, 0, 'the apply fails at index.js');
    assert.match(r.stderr, /restor/i);
    assert.deepEqual(snapshot(root), before0, 'modules removed again and every patched target restored byte-for-byte');
    for (const rel of [...TARGETS, ...MODULES]) {
        assert.equal(fs.existsSync(`${path.join(root, D_REL, rel)}.p13-tmp`), false, `no temp file left for ${rel}`);
    }
});

test('D4 p13: --rollback reverses every edit (byte-identical to pre-P13), removes the modules; re-apply and --check work again', () => {
    const root = cloneRoot('t-rollback');
    const before0 = snapshot(root);
    const p13 = path.join(PATCHES, 'apply.d', 'p13.sh');
    assert.equal(run([p13, root]).status, 0, 'apply');
    assert.equal(run([p13, '--check', root]).status, 0, 'check after apply');
    const rb = run([p13, '--rollback', root]);
    assert.equal(rb.status, 0, `rollback:\n${rb.stdout}\n${rb.stderr}`);
    assert.deepEqual(snapshot(root), before0, 'targets byte-identical to pre-P13, modules gone');
    assert.notEqual(run([p13, '--check', root]).status, 0, 'check fails after rollback');
    assert.equal(run([p13, '--rollback', root]).status, 0, 'a second rollback is a no-op');
    assert.equal(run([p13, root]).status, 0, 're-apply after rollback');
    assert.equal(run([p13, '--check', root]).status, 0, 'check after re-apply');
});

test('D4 p13: --rollback refuses (changes nothing) when a later edit altered P13 text', () => {
    const root = cloneRoot('t-rollback-drift');
    const p13 = path.join(PATCHES, 'apply.d', 'p13.sh');
    assert.equal(run([p13, root]).status, 0, 'apply');
    const index = path.join(root, D_REL, 'index.js');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('// P13 (M-122): /active also lists busy terminal-started CLIs; every other path falls through.', '// edited by a later patch'));
    const mid = snapshot(root);
    const rb = run([p13, '--rollback', root]);
    assert.notEqual(rb.status, 0, 'rollback refuses');
    assert.match(rb.stderr, /bak-pre-p13/);
    assert.deepEqual(snapshot(root), mid, 'nothing changed (all-or-nothing rollback)');
});

test('P13/P14 rollback chain: p13 --rollback refuses while P14 is applied; p14 then p13 rollback restores pre-P13 bytes', () => {
    const root = cloneRoot('t-chain');
    const p13 = path.join(PATCHES, 'apply.d', 'p13.sh');
    const p14 = path.join(PATCHES, 'apply.d', 'p14.sh');
    const REG = 'modules/websocket/services/chat-run-registry.service.js';
    const chainSnap = () => ({ ...snapshot(root), [REG]: fs.readFileSync(path.join(root, D_REL, REG), 'utf8') });
    const pre13 = chainSnap();
    assert.notEqual(run([p14, root]).status, 0, 'p14 refuses on a pre-P13 tree');
    assert.deepEqual(chainSnap(), pre13, 'the refused p14 apply wrote nothing');
    assert.equal(run([p13, root]).status, 0, 'p13 apply');
    const post13 = chainSnap();
    const a14 = run([p14, root]);
    assert.equal(a14.status, 0, `p14 apply:\n${a14.stdout}\n${a14.stderr}`);
    assert.equal(run([p14, '--check', root]).status, 0, 'p14 check');
    const post14 = chainSnap();
    const refused = run([p13, '--rollback', root]);
    assert.notEqual(refused.status, 0, 'p13 rollback refuses while P14 is applied');
    assert.match(refused.stderr, /roll back P14 first/);
    assert.deepEqual(chainSnap(), post14, 'the refused p13 rollback changed nothing');
    const rb14 = run([p14, '--rollback', root]);
    assert.equal(rb14.status, 0, `p14 rollback:\n${rb14.stdout}\n${rb14.stderr}`);
    assert.deepEqual(chainSnap(), post13, 'p14 rollback restores the post-P13 bytes');
    assert.notEqual(run([p14, '--check', root]).status, 0, 'p14 check fails after its rollback');
    const rb13 = run([p13, '--rollback', root]);
    assert.equal(rb13.status, 0, `p13 rollback:\n${rb13.stdout}\n${rb13.stderr}`);
    assert.deepEqual(chainSnap(), pre13, 'end state byte-identical to pre-P13 (registry included)');
});
