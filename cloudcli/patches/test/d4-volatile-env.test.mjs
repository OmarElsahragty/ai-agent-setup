// D4 item 2: VOLATILE_ENV_KEY_RE name boundaries for PASS and CERT.
// The regex is private; it is observed through canonicalMcpSet (volatile env
// names are fingerprinted as '*', every other name keeps its value).
// Negative control: D4_PROMPT_QUEUE=<pre-D4 claude-prompt-queue.js> must FAIL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = process.env.D4_PROMPT_QUEUE || path.join(HERE, '..', 'files', 'claude-prompt-queue.js');
const { canonicalMcpSet } = await import(pathToFileURL(MODULE).href);

function volatile(name) {
    const out = canonicalMcpSet({ srv: { command: 'x', env: { [name]: 'value' } } });
    return out.srv.env[name] === '*';
}

test('D4: names with PASS/CERT as a bounded part, or PASSWORD/PASSWD/PASSPHRASE anywhere, stay volatile', () => {
    for (const name of ['PASS', 'DB_PASS', 'SMTP_PASS_FILE', 'PASSWORD', 'DB_PASSWORD', 'PGPASSWORD', 'PASSWD', 'PASSPHRASE', 'GPG_PASSPHRASE',
        'CERT', 'CLIENT_CERT', 'TLS_CERT_KEY', 'SSL_CERT_FILE', 'cert_key', 'GITHUB_PAT', 'OTP', 'API_KEY', 'GITHUB_TOKEN']) {
        assert.equal(volatile(name), true, `${name} must be volatile`);
    }
});

test('D4: BYPASS, COMPASS, PASSTHROUGH, NODE_EXTRA_CA_CERTS, CERTBOT_DIR stay non-volatile (their values are fingerprinted)', () => {
    for (const name of ['BYPASS', 'BYPASS_CACHE', 'COMPASS_URL', 'PASSTHROUGH', 'NODE_EXTRA_CA_CERTS', 'CERTBOT_DIR', 'PATH', 'PATTERN', 'MONKEY', 'NODE_ENV']) {
        assert.equal(volatile(name), false, `${name} must NOT be volatile`);
    }
});

test('D4: a NODE_EXTRA_CA_CERTS change changes the canonical MCP set (forces a respawn); a token rotation does not', () => {
    const a = canonicalMcpSet({ s: { command: 'x', env: { NODE_EXTRA_CA_CERTS: '/a.pem', GITHUB_TOKEN: 't1' } } });
    const b = canonicalMcpSet({ s: { command: 'x', env: { NODE_EXTRA_CA_CERTS: '/b.pem', GITHUB_TOKEN: 't1' } } });
    const c = canonicalMcpSet({ s: { command: 'x', env: { NODE_EXTRA_CA_CERTS: '/a.pem', GITHUB_TOKEN: 't2' } } });
    assert.notDeepEqual(a, b);
    assert.deepEqual(a, c);
});
