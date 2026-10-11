// P6 + P7: OpenCode top-level-only sync listing; Claude title precedence
// (custom-title > ai-title > last-prompt anywhere in the scanned tail).
// Negative controls: the same behaviour probes run against the UNPATCHED
// source files and must show the OLD behaviour, proving the patched
// assertions below cannot pass on an unpatched copy.
import { test, before, after } from 'node:test';
import { stockSrc } from './stock-src.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The patch set this test file belongs to (live: ${AI_SETUP_ROOT}/cloudcli/patches).
const PATCHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = stockSrc();
const INSTALL_MODULES = path.resolve(PATCHES, '..', 'node_modules');
const SKIP_NO_DEPS = fs.existsSync(INSTALL_MODULES) ? false : `better-sqlite3 unavailable: ${INSTALL_MODULES} missing (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT to a full install)`;
const Database = SKIP_NO_DEPS ? null : (await import('better-sqlite3')).default;
const OC_SYNC_REL = 'dist-server/server/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
const CL_SYNC_REL = 'dist-server/server/modules/providers/list/claude/claude-session-synchronizer.provider.js';
const OC_SYNC_TS_REL = 'server/modules/providers/list/opencode/opencode-session-synchronizer.provider.ts';
const CL_SYNC_TS_REL = 'server/modules/providers/list/claude/claude-session-synchronizer.provider.ts';
let root;
let pkg;

function runApply(args) {
    return spawnSync('bash', [path.join(PATCHES, 'apply.sh'), ...args], { encoding: 'utf8' });
}

// The synchronizeRows listing query, extracted verbatim from a file.
async function extractSyncSql(file) {
    const source = await fsp.readFile(file, 'utf8');
    const match = source.match(/db\.prepare\(`([\s\S]*?)`\)\.all/);
    assert.ok(match, `listing query found in ${file}`);
    return match[1].replace(/\$\{limitClause\}/g, '');
}

// Minimal opencode.db-shaped store: one project, a parent session, a subagent
// child (newer, so ordering alone cannot hide it), and an archived session.
function makeOpencodeDb(file) {
    fs.rmSync(file, { force: true });
    const db = new Database(file);
    db.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_id TEXT,
            directory TEXT,
            title TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            time_archived INTEGER
        );
        INSERT INTO project VALUES ('p1', '/wt');
        INSERT INTO session VALUES ('parent', 'p1', NULL, '/wt', 'Parent', 200, 200, NULL);
        INSERT INTO session VALUES ('child', 'p1', 'parent', '/wt', 'Child', 300, 300, NULL);
        INSERT INTO session VALUES ('archived', 'p1', NULL, '/wt', 'Old', 100, 100, 1);
    `);
    return db;
}

// Load ClaudeSessionSynchronizer from a copy of the dist file with the two
// app-relative imports stripped; extractSessionAiTitleFromEnd only needs
// readFile, so the class loads without the app database. The stripped copy is
// always written under the temp root (never next to the source file, which
// may be the live install). P13 (apply.d/p13.sh) adds a sibling import of
// ./p13-session-origin.js (self-contained, node:fs only); when the source
// carries it, that module is copied from next to the source file into the
// temp root, so the patched file loads with only the two imports above
// stripped. A patched tree that lacks the module still fails loudly here.
async function loadClaudeSync(file) {
    const source = await fsp.readFile(file, 'utf8');
    const stripped = source
        .replace(/^import \{ sessionsDb \}.*$/m, '')
        .replace(/^import \{ buildLookupMap.*$/m, '');
    if (/^import [^\n]* from '\.\/p13-session-origin\.js';$/m.test(stripped)) {
        await fsp.copyFile(path.join(path.dirname(file), 'p13-session-origin.js'), path.join(root, 'p13-session-origin.js'));
    }
    const target = path.join(root, `claude-sync-${path.basename(file)}-${Math.random().toString(36).slice(2)}.mjs`);
    await fsp.writeFile(target, stripped);
    const mod = await import(target);
    return new mod.ClaudeSessionSynchronizer();
}

async function writeJsonl(lines) {
    const file = path.join(root, `tail-${Math.random().toString(36).slice(2)}.jsonl`);
    await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
}

before(async () => {
    root = `/var/tmp/claude/p6-p7-apply-${process.pid}-${Date.now()}`;
    pkg = path.join(root, 'node_modules', '@cloudcli-ai', 'cloudcli');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.cpSync(SRC, pkg, { recursive: true });
});

after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
});

test('apply.sh applies P6 + P7 to a temp copy and exits 0', () => {
    const result = runApply([root]);
    assert.equal(result.status, 0, `apply stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('P6 patched:'), result.stdout);
    assert.ok(result.stdout.includes('P7 patched:'), result.stdout);
});

test('P6: patched listing SQL returns only the top-level session', { skip: SKIP_NO_DEPS }, async () => {
    const db = makeOpencodeDb(path.join(root, 'oc.db'));
    try {
        const sql = await extractSyncSql(path.join(pkg, OC_SYNC_REL));
        const rows = db.prepare(sql).all(null, null);
        assert.deepEqual(rows.map((r) => r.id), ['parent'], `rows: ${JSON.stringify(rows)}`);
        assert.ok(sql.includes('s.parent_id IS NULL'), 'filter present in the extracted SQL');
    }
    finally {
        db.close();
    }
});

test('P6 negative control: unpatched listing SQL still returns the subagent child', { skip: SKIP_NO_DEPS }, async () => {
    const db = makeOpencodeDb(path.join(root, 'oc-unpatched.db'));
    try {
        const sql = await extractSyncSql(path.join(SRC, OC_SYNC_REL));
        const ids = db.prepare(sql).all(null, null).map((r) => r.id);
        assert.ok(ids.includes('child'), `unpatched SQL must include the child, got: ${JSON.stringify(ids)}`);
        assert.ok(!sql.includes('parent_id IS NULL'), 'unpatched SQL has no parent filter');
    }
    finally {
        db.close();
    }
});

test('P7: ai-title anywhere in the tail beats a later last-prompt', async () => {
    const sync = await loadClaudeSync(path.join(pkg, CL_SYNC_REL));
    const file = await writeJsonl([
        { type: 'ai-title', sessionId: 's1', aiTitle: 'AI Title' },
        { type: 'last-prompt', sessionId: 's1', lastPrompt: 'later prompt' },
    ]);
    assert.equal(await sync.extractSessionAiTitleFromEnd(file, 's1'), 'AI Title');
});

test('P7: custom-title anywhere in the tail beats a later ai-title', async () => {
    const sync = await loadClaudeSync(path.join(pkg, CL_SYNC_REL));
    const file = await writeJsonl([
        { type: 'custom-title', sessionId: 's1', customTitle: 'Renamed' },
        { type: 'ai-title', sessionId: 's1', aiTitle: 'AI Title' },
    ]);
    assert.equal(await sync.extractSessionAiTitleFromEnd(file, 's1'), 'Renamed');
});

test('P7: last-prompt stays the fallback (most recent one wins)', async () => {
    const sync = await loadClaudeSync(path.join(pkg, CL_SYNC_REL));
    const file = await writeJsonl([
        { type: 'last-prompt', sessionId: 's1', lastPrompt: 'prompt one' },
        { type: 'last-prompt', sessionId: 's1', lastPrompt: 'prompt two' },
    ]);
    assert.equal(await sync.extractSessionAiTitleFromEnd(file, 's1'), 'prompt two');
});

test('P7: unrelated session ids are ignored', async () => {
    const sync = await loadClaudeSync(path.join(pkg, CL_SYNC_REL));
    const file = await writeJsonl([
        { type: 'ai-title', sessionId: 'other', aiTitle: 'Not Mine' },
        { type: 'last-prompt', sessionId: 's1', lastPrompt: 'mine' },
    ]);
    assert.equal(await sync.extractSessionAiTitleFromEnd(file, 's1'), 'mine');
});

test('P7 negative control: unpatched extractor returns the later last-prompt', async () => {
    const sync = await loadClaudeSync(path.join(SRC, CL_SYNC_REL));
    const file = await writeJsonl([
        { type: 'ai-title', sessionId: 's1', aiTitle: 'AI Title' },
        { type: 'last-prompt', sessionId: 's1', lastPrompt: 'later prompt' },
    ]);
    assert.equal(await sync.extractSessionAiTitleFromEnd(file, 's1'), 'later prompt');
});

// Fresh package copy under /var/tmp for doctoring the P7 target file.
function freshCopy(tag) {
    const fresh = `/var/tmp/claude/p7-${tag}-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(fresh, 'node_modules', '@cloudcli-ai'), { recursive: true });
    fs.cpSync(SRC, path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
    return fresh;
}

test('P7: a decoy non-exact "return undefined;" line is left alone (anchored sed)', () => {
    const fresh = freshCopy('decoy');
    try {
        const dist = path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli', CL_SYNC_REL);
        const exact = '        return undefined;';
        const source = fs.readFileSync(dist, 'utf8');
        assert.ok(source.includes(exact), 'dist carries the exact final-return line');
        fs.writeFileSync(dist, source.replace(exact, '        return undefined; // decoy\n' + exact));
        const result = runApply([fresh]);
        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        const patched = fs.readFileSync(dist, 'utf8');
        assert.ok(patched.includes('        return undefined; // decoy'), 'decoy untouched');
        const count = patched.split('return bestAiTitle || bestLastPrompt || undefined;').length - 1;
        assert.equal(count, 1, `only the exact-line occurrence changes, got ${count}`);
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});

test('P7: two exact "return undefined;" lines fail the patch loudly', () => {
    const fresh = freshCopy('dup');
    try {
        const dist = path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli', CL_SYNC_REL);
        const exact = '        return undefined;';
        const source = fs.readFileSync(dist, 'utf8');
        fs.writeFileSync(dist, source.replace(exact, exact + '\n' + exact));
        const result = runApply([fresh]);
        assert.equal(result.status, 1, `must fail, stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.match(result.stderr, /P7 PATCH FAILED/, 'loud failure, not a silent double rewrite');
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});

test('P6 + P7 markers present in the TS sources', async () => {
    const oc = await fsp.readFile(path.join(pkg, OC_SYNC_TS_REL), 'utf8');
    assert.match(oc, /AND s\.parent_id IS NULL/, 'opencode ts: parent filter');
    const cl = await fsp.readFile(path.join(pkg, CL_SYNC_TS_REL), 'utf8');
    assert.match(cl, /let bestAiTitle;/, 'claude ts: collect var');
    assert.match(cl, /return bestAiTitle \|\| bestLastPrompt \|\| undefined;/, 'claude ts: precedence return');
});

test('P6 + P7 patched dist files still parse as ESM', () => {
    for (const rel of [OC_SYNC_REL, CL_SYNC_REL]) {
        const target = path.join(root, rel.replaceAll('/', '_') + '.check.mjs');
        fs.copyFileSync(path.join(pkg, rel), target);
        const check = spawnSync('node', ['--check', target], { encoding: 'utf8' });
        assert.equal(check.status, 0, `${rel}: ${check.stderr}`);
    }
});

test('apply.sh is idempotent for P6/P7 and --check passes afterwards', async () => {
    const dist = path.join(pkg, CL_SYNC_REL);
    const before = fs.readFileSync(dist, 'utf8');
    const again = runApply([root]);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.includes('P6 already applied:'), again.stdout);
    assert.ok(again.stdout.includes('P7 already applied:'), again.stdout);
    assert.equal(fs.readFileSync(dist, 'utf8'), before);
    const check = runApply(['--check', root]);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes('check OK'), check.stdout);
});

test('apply.sh --check exits 1 on a fresh copy (P6/P7 missing)', () => {
    const fresh = `/var/tmp/claude/p6-p7-apply-fresh-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(fresh, 'node_modules', '@cloudcli-ai'), { recursive: true });
    try {
        fs.cpSync(SRC, path.join(fresh, 'node_modules', '@cloudcli-ai', 'cloudcli'), { recursive: true });
        const result = runApply(['--check', fresh]);
        assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.ok(result.stderr.includes('MISSING'), result.stderr);
        assert.ok(result.stderr.includes('P6'), result.stderr);
        assert.ok(result.stderr.includes('P7'), result.stderr);
    }
    finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
