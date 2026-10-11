// FP-2 P5: Cloudflare Access JWT validation unit tests (local RSA key + stubbed JWKS fetch).
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const MODULE_URL = pathToFileURL(`${AI_SETUP_ROOT}/cloudcli/patches/files/access-jwt.js`).href;
const AUD = 'fp2-test-audience';
const TEAM = 'fp2-test-team.example.com';
const KID = 'fp2-test-key-1';
const AMBIENT_ACCESS_EMAIL = process.env.CF_ACCESS_EMAIL;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

const realFetch = globalThis.fetch;
let fetchUrls = [];
let fetchHandler = null;

function stubFetch(handler) {
    fetchUrls = [];
    fetchHandler = handler;
}

globalThis.fetch = async (url, options) => {
    fetchUrls.push(String(url));
    if (!fetchHandler) {
        throw new Error('no fetch handler installed');
    }
    return fetchHandler(String(url), options);
};

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function defaultJwks() {
    return jsonResponse({ keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: KID, n: jwk.n, e: jwk.e }] });
}

function b64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken({ header = {}, payload = {}, signKey = privateKey, alg = 'RS256' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const encHeader = b64url({ typ: 'JWT', alg, kid: KID, ...header });
    const encPayload = b64url({
        iss: `https://${TEAM}`,
        sub: 'fp2@test',
        aud: [AUD],
        exp: now + 600,
        nbf: now - 10,
        ...payload,
    });
    let signature = '';
    if (alg !== 'none') {
        const signer = createSign('RSA-SHA256');
        signer.update(`${encHeader}.${encPayload}`);
        signature = signer.sign(signKey).toString('base64url');
    }
    return `${encHeader}.${encPayload}.${signature}`;
}

function mockRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

async function waitFor(predicate, ms = 2000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
}

async function runRest(headers) {
    const res = mockRes();
    let nexted = false;
    await mod.accessRestMiddleware({ headers: headers ?? {} }, res, () => { nexted = true; });
    return { res, nexted };
}

async function runWs(headers, fallbackResult = true) {
    let call = null;
    let fallbackRuns = 0;
    const result = mod.guardAccessWebSocketUpgrade(
        { req: { headers: headers ?? {} } },
        (...args) => { call = args; },
        () => { fallbackRuns += 1; return fallbackResult; },
    );
    assert.equal(result, undefined, 'enabled mode must hand the decision to the ws callback');
    assert.ok(await waitFor(() => call !== null), 'ws callback must be invoked');
    return { call, fallbackRuns };
}

let mod;

before(async () => {
    mod = await import(MODULE_URL);
});

beforeEach(() => {
    mod.resetAccessStateForTesting();
    delete process.env.CF_ACCESS_EMAIL;
    process.env.CF_ACCESS_AUD = AUD;
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
    stubFetch(() => defaultJwks());
});

afterEach(() => {
    delete process.env.CF_ACCESS_AUD;
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    fetchHandler = null;
});

after(() => {
    globalThis.fetch = realFetch;
    if (AMBIENT_ACCESS_EMAIL !== undefined) {
        process.env.CF_ACCESS_EMAIL = AMBIENT_ACCESS_EMAIL;
    }
});

test('valid assertion passes REST middleware and WS guard', async () => {
    const token = makeToken();
    const rest = await runRest({ 'cf-access-jwt-assertion': token });
    assert.equal(rest.nexted, true);
    assert.equal(rest.res.statusCode, 200);
    assert.equal(rest.res.body, undefined);

    const ws = await runWs({ 'cf-access-jwt-assertion': token });
    assert.deepEqual(ws.call, [true]);
    assert.equal(ws.fallbackRuns, 1, 'original verifyClient still runs (sets request.user)');
});

test('valid assertion via CF_Authorization cookie fallback', async () => {
    const token = makeToken();
    const rest = await runRest({ cookie: `other=1; CF_Authorization=${token}; x=2` });
    assert.equal(rest.nexted, true);
    const ws = await runWs({ cookie: `CF_Authorization=${token}` });
    assert.deepEqual(ws.call, [true]);
});

test('string aud (not array) is accepted when equal', async () => {
    const rest = await runRest({ 'cf-access-jwt-assertion': makeToken({ payload: { aud: AUD } }) });
    assert.equal(rest.nexted, true);
});

test('team domain is normalized (scheme, case, trailing slash)', async () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = `https://${TEAM.toUpperCase()}/`;
    const rest = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(rest.nexted, true);
});

for (const [name, headers] of [
    ['missing assertion', {}],
    ['malformed assertion', { 'cf-access-jwt-assertion': 'not-a-jwt' }],
]) {
    test(`${name}: REST 401 JSON, WS rejected before fallback`, async () => {
        const rest = await runRest(headers);
        assert.equal(rest.nexted, false);
        assert.equal(rest.res.statusCode, 401);
        assert.equal(rest.res.body.code, 'CF_ACCESS_DENIED');
        const ws = await runWs(headers);
        assert.deepEqual(ws.call, [false, 401, 'Unauthorized']);
        assert.equal(ws.fallbackRuns, 0);
    });
}

test('bad signature is rejected for REST and WS', async () => {
    const token = makeToken({ signKey: otherPair.privateKey });
    const rest = await runRest({ 'cf-access-jwt-assertion': token });
    assert.equal(rest.nexted, false);
    assert.equal(rest.res.statusCode, 401);
    const ws = await runWs({ 'cf-access-jwt-assertion': token });
    assert.deepEqual(ws.call, [false, 401, 'Unauthorized']);
    assert.equal(ws.fallbackRuns, 0);
});

test('tampered payload is rejected', async () => {
    const token = makeToken();
    const [h, , s] = token.split('.');
    const tamperedPayload = b64url({ iss: `https://${TEAM}`, aud: [AUD], sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600, nbf: Math.floor(Date.now() / 1000) - 10 });
    const rest = await runRest({ 'cf-access-jwt-assertion': `${h}.${tamperedPayload}.${s}` });
    assert.equal(rest.nexted, false);
    assert.equal(rest.res.statusCode, 401);
});

for (const [name, tokenOpts] of [
    ['wrong audience', { payload: { aud: ['someone-elses-app'] } }],
    ['wrong issuer', { payload: { iss: 'https://evil.example.com' } }],
    ['expired', { payload: { exp: Math.floor(Date.now() / 1000) - 3600, nbf: Math.floor(Date.now() / 1000) - 7200 } }],
    ['not yet valid (nbf beyond skew)', { payload: { nbf: Math.floor(Date.now() / 1000) + 3600 } }],
    ['alg none', { alg: 'none' }],
    ['alg HS256', { alg: 'HS256' }],
    ['missing exp', { payload: { exp: undefined } }],
]) {
    test(`${name}: REST 401 and WS 401 rejection`, async () => {
        const token = makeToken(tokenOpts);
        const rest = await runRest({ 'cf-access-jwt-assertion': token });
        assert.equal(rest.nexted, false);
        assert.equal(rest.res.statusCode, 401);
        assert.equal(rest.res.body.code, 'CF_ACCESS_DENIED');
        const ws = await runWs({ 'cf-access-jwt-assertion': token });
        assert.deepEqual(ws.call, [false, 401, 'Unauthorized']);
        assert.equal(ws.fallbackRuns, 0);
    });
}

test('unknown kid triggers exactly one refetch and then passes', async () => {
    let calls = 0;
    stubFetch(() => {
        calls += 1;
        return calls === 1
            ? jsonResponse({ keys: [{ kty: 'RSA', kid: 'rotated-away', n: jwk.n, e: jwk.e }] })
            : defaultJwks();
    });
    const rest = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(rest.nexted, true);
    assert.equal(calls, 2, 'one cached fetch + one forced refetch');
    assert.ok(fetchUrls[0].endsWith('/cdn-cgi/access/certs'), fetchUrls[0]);
});

test('certs are cached: second validation does not refetch', async () => {
    const first = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(first.nexted, true);
    const second = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(second.nexted, true);
    assert.equal(fetchUrls.length, 1);
});

test('certs fetch failure fails closed (REST and WS)', async () => {
    stubFetch(() => { throw new Error('network down'); });
    const rest = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(rest.nexted, false);
    assert.equal(rest.res.statusCode, 401);
    const ws = await runWs({ 'cf-access-jwt-assertion': makeToken() });
    assert.deepEqual(ws.call, [false, 401, 'Unauthorized']);
});

test('certs endpoint non-200 fails closed', async () => {
    stubFetch(() => jsonResponse({ keys: [] }, 503));
    const rest = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(rest.nexted, false);
    assert.equal(rest.res.statusCode, 401);
});

test('legacy public_certs (PEM) shape is accepted', async () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    stubFetch(() => jsonResponse({ public_certs: [{ kid: KID, cert: pem }] }));
    const rest = await runRest({ 'cf-access-jwt-assertion': makeToken() });
    assert.equal(rest.nexted, true);
});

test('disabled mode (env unset): REST passes through unchanged', async () => {
    delete process.env.CF_ACCESS_AUD;
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    assert.equal(mod.isAccessAuthEnabled(), false);
    const rest = await runRest({});
    assert.equal(rest.nexted, true);
    assert.equal(rest.res.statusCode, 200);
    assert.equal(fetchUrls.length, 0, 'no certs fetch when disabled');
});

test('disabled mode: WS guard forwards the original sync decision via callback', async () => {
    delete process.env.CF_ACCESS_AUD;
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    // The patched arrow has arity 2, so ws 8.x always uses callback mode:
    // the wrapper must invoke the callback with the original decision.
    for (const fallbackResult of [true, false]) {
        let call = null;
        let fallbackRuns = 0;
        const result = mod.guardAccessWebSocketUpgrade(
            { req: { headers: {} } },
            (...args) => { call = args; },
            () => { fallbackRuns += 1; return fallbackResult; },
        );
        assert.equal(result, fallbackResult, 'sync return preserved for direct callers');
        assert.equal(fallbackRuns, 1);
        if (fallbackResult) {
            assert.deepEqual(call, [true]);
        }
        else {
            assert.deepEqual(call, [false, 401, 'Unauthorized']);
        }
    }
});

test('enabled + valid assertion but original verifyClient false => WS still rejected', async () => {
    const ws = await runWs({ 'cf-access-jwt-assertion': makeToken() }, false);
    assert.deepEqual(ws.call, [false, 401, 'Unauthorized']);
    assert.equal(ws.fallbackRuns, 1);
});

test('verifyAssertion returns the decoded payload', async () => {
    const payload = await mod.verifyAssertion(makeToken({ payload: { sub: 'someone@example.com' } }));
    assert.equal(payload.sub, 'someone@example.com');
});
