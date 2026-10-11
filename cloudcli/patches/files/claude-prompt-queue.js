/**
 * Pushable prompt stream for the Claude SDK's streaming-input mode (P9).
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted
 * (and immediately on `result` for string prompts). The CLI reads that EOF as
 * the end of the run and kills anything still going in the background, so the
 * iterable has to stay pending until we actually want the process gone.
 *
 * The original held stream could only carry the messages it was created with.
 * This queue keeps that behaviour exactly when nothing is pushed (yield the
 * seed messages in order, then park until release()) and adds push(): messages
 * pushed later are yielded after the seeds, in push order, so a follow-up turn
 * can be delivered into the SAME live CLI process instead of spawning a new
 * one. release() always wins: once released the iterable ends without yielding
 * anything further (stdin closes).
 *
 * computeSpawnFingerprint() fingerprints the configuration a spawned CLI
 * keeps for its lifetime: the user/project/local settings files (by
 * path:size:mtime) and the resolved MCP server set (by sha256 only) — a reused
 * process would keep its spawn-time configuration, so any change must force a
 * fresh spawn. ~/.claude.json itself is NOT stat'ed: every Claude Code process
 * on the host rewrites it (startup counters, caches), which would defeat reuse;
 * its MCP-relevant part arrives here already parsed. P9r: per-start VOLATILE
 * values inside the MCP set are normalised away before hashing (env entries
 * whose KEY looks credential-like contribute only their key name, header maps
 * contribute only their header names, URL/serverUrl query strings are dropped),
 * so a rotating minted token or cache-busting query can never break reuse;
 * structural changes (a server added/removed, command/args, url PATH, a
 * non-volatile env value) still alter the fingerprint. No file or MCP CONTENT,
 * token, or URL is ever placed in the fingerprint or logged — only the sha256.
 *
 * Unit-tested from patches/test/p9-one-process.test.mjs and
 * patches/test/p9r-one-process.test.mjs.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {Array<Object>} messages - SDKUserMessage records to seed the queue with
 * @returns {{ stream: AsyncIterable, release: () => void, push: (more: Array<Object>) => void, isReleased: () => boolean }}
 */
export function createPushablePromptStream(messages) {
    const queue = Array.isArray(messages) ? messages.slice() : [];
    let released = false;
    let resolveRelease;
    const held = new Promise((resolve) => { resolveRelease = resolve; });
    // Wakes the parked generator when the queue state changed. Null whenever
    // nobody is parked; every wake re-checks the queue from the loop head, so
    // a ring while the generator is suspended at a yield is a harmless no-op.
    let doorbell = null;
    const ring = () => {
        if (doorbell) {
            const wake = doorbell;
            doorbell = null;
            wake();
        }
    };
    const push = (more) => {
        if (Array.isArray(more)) {
            queue.push(...more);
        }
        ring();
    };
    const release = () => {
        released = true;
        resolveRelease();
        ring();
    };
    const stream = (async function* () {
        while (!released) {
            if (queue.length > 0) {
                yield queue.shift();
                continue;
            }
            // Empty queue — park until new messages arrive or release() fires.
            await Promise.race([held, new Promise((resolve) => { doorbell = resolve; })]);
        }
    })();
    return { stream, release, push, isReleased: () => released };
}

// JSON with object keys sorted at every level, so the hash does not depend on
// key order in the source file.
function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

// Env KEY names whose VALUES are minted per start (tokens, keys, ...). The
// value a reused process was spawned with stays valid for its lifetime, so a
// rotation must NOT defeat reuse; the KEY itself is still fingerprinted, and a
// non-volatile env value change still forces a fresh spawn. Key NAMES only are
// matched here — no value is ever inspected, hashed, or logged.
// P10: widened to _KEY/KEY, PASS (PASSWORD, PASSWD, PASSPHRASE, DB_PASS), PAT,
// OTP, SALT, CERT and COOKIE; PAT/OTP/KEY need a name boundary so PATH,
// PATTERN or MONKEY stay non-volatile.
// D4: PASS and CERT need the same name boundary, so BYPASS, COMPASS or
// NODE_EXTRA_CA_CERTS stay non-volatile; PASSWORD/PASSWD/PASSPHRASE still
// match anywhere (PGPASSWORD) and *_CERT_KEY still matches (CERT and KEY).
const VOLATILE_ENV_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|(?:^|_)KEYS?(?:_|$)|PRIVATE|JWT|NONCE|SESSION|SIGNATURE|BEARER|AUTH|COOKIE|SALT|(?:^|_)(?:PASS|CERT|PAT|OTP)(?:_|$)/i;

const stripUrlVolatile = (url) => (typeof url === 'string' ? url.replace(/[?#].*$/, '') : url ?? null);

// One MCP server entry with per-start volatile values normalised away:
// env -> {name: value | '*'} (volatile names contribute a placeholder),
// headers -> sorted header NAMES only (values are credentials), url/serverUrl
// -> query/fragment stripped. Every other field is kept verbatim, so real
// config changes (command, args, type, url path, non-volatile env, an entry
// added or removed) still change the fingerprint.
function canonicalMcpEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return entry ?? null;
    }
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
        if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
            const env = {};
            for (const envKey of Object.keys(value).sort()) {
                env[envKey] = VOLATILE_ENV_KEY_RE.test(envKey) ? '*' : value[envKey] ?? null;
            }
            out[key] = env;
        }
        else if (key === 'headers' && value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = Object.keys(value).sort();
        }
        else if ((key === 'url' || key === 'serverUrl')) {
            out[key] = stripUrlVolatile(value);
        }
        else {
            out[key] = value ?? null;
        }
    }
    return out;
}

export function canonicalMcpSet(mcpServers) {
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
        return mcpServers ?? null;
    }
    const out = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
        out[name] = canonicalMcpEntry(entry);
    }
    return out;
}

/**
 * Fingerprint of the configuration the spawned CLI keeps: the user/project/
 * local settings files as path:size:mtime (missing files contribute a stable
 * "absent" marker) plus a sha256 of the resolved MCP server set, so it only
 * changes when a settings file is created, modified, or removed, or the MCP
 * set itself changes.
 *
 * @param {string} cwd - Project cwd (project/local settings live under it)
 * @param {Object|null} mcpServers - The MCP set passed to the SDK (loadMcpConfig)
 * @returns {Promise<string>}
 */
export async function computeSpawnFingerprint(cwd, mcpServers = null) {
    const files = [
        path.join(os.homedir(), '.claude', 'settings.json'),
    ];
    if (typeof cwd === 'string' && cwd) {
        files.push(path.join(cwd, '.claude', 'settings.json'));
        files.push(path.join(cwd, '.claude', 'settings.local.json'));
    }
    const parts = [];
    for (const file of files) {
        try {
            const stat = await fsp.stat(file);
            parts.push(`${file}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
        }
        catch {
            parts.push(`${file}:-`);
        }
    }
    parts.push(`mcp:${createHash('sha256').update(canonicalJson(canonicalMcpSet(mcpServers))).digest('hex')}`);
    return parts.join('|');
}

/**
 * P10: CONTENT fingerprint of the same configuration (used by the P10
 * provider instead of computeSpawnFingerprint). Each settings file contributes
 * the sha256 of its canonical JSON (key order and whitespace do not matter),
 * or of its raw bytes when it does not parse; a missing file contributes a
 * stable "absent" marker. A rewrite with identical content (a touch, or
 * sync-claude-config.py re-saving the same settings) therefore keeps the
 * fingerprint, so the live process is still reused; a real content change
 * forces the respawn-after-exit path. Only hashes are kept: no settings
 * content is ever placed in the fingerprint or logged.
 *
 * @param {string} cwd - Project cwd (project/local settings live under it)
 * @param {Object|null} mcpServers - The MCP set passed to the SDK (loadMcpConfig)
 * @returns {Promise<string>}
 */
export async function computeContentFingerprint(cwd, mcpServers = null) {
    const files = [
        path.join(os.homedir(), '.claude', 'settings.json'),
    ];
    if (typeof cwd === 'string' && cwd) {
        files.push(path.join(cwd, '.claude', 'settings.json'));
        files.push(path.join(cwd, '.claude', 'settings.local.json'));
    }
    const parts = [];
    for (const file of files) {
        let raw;
        try {
            raw = await fsp.readFile(file);
        }
        catch {
            parts.push(`${file}:-`);
            continue;
        }
        let canonical = null;
        try {
            canonical = canonicalJson(JSON.parse(raw.toString('utf8')));
        }
        catch {
            canonical = null;
        }
        const digest = createHash('sha256').update(canonical === null ? raw : `json:${canonical}`).digest('hex');
        parts.push(`${file}:${digest}`);
    }
    parts.push(`mcp:${createHash('sha256').update(canonicalJson(canonicalMcpSet(mcpServers))).digest('hex')}`);
    return parts.join('|');
}
