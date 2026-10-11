// M-137 (WO-N6): the read-only Gemini quota check. No test touches the
// network: fetch and WebSocket are injected fakes, and the CLI runs only in
// dry-run / no-key modes, which return before any request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runCheck,
  parseArgs,
  redact,
  classifyError,
  classifyClose,
  EXIT,
  DEFAULT_KEY_ENV,
  API_BASE,
  LIVE_URL,
} from '../tools/gemini-quota-check.mjs';

const FAKE = 'k-test-0001'; // placeholder, not a credential
// A Google-key-shaped value (prefix + 35 chars) assembled at runtime, so this
// file holds no key-shaped literal. It is synthetic, not a credential.
const SYNTH = [String.fromCharCode(65, 73, 122, 97), 'Q'.repeat(12), '-', 'x9'.repeat(11)].join('');
const TOOL = fileURLToPath(new URL('../tools/gemini-quota-check.mjs', import.meta.url));

function collect() {
  const lines = [];
  return { lines, print: (line) => lines.push(String(line)), text: () => lines.join('\n') };
}

function fetchSpy(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fn, calls };
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

function fakeSocketClass(script) {
  const made = [];
  class FakeSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      this.closed = 0;
      made.push(this);
      setImmediate(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
      setImmediate(() => script(this));
    }

    close() {
      this.closed += 1;
      this.readyState = 3;
    }
  }
  return { FakeSocket, made };
}

const env = { [DEFAULT_KEY_ENV]: FAKE };

test('dry run is the default: no request at all, key presence only, never the value', async () => {
  const out = collect();
  const spy = fetchSpy(jsonResponse(200, {}));
  let sockets = 0;
  const code = await runCheck({ argv: [], env, fetchFn: spy.fn, WebSocketCtor: function () { sockets += 1; }, print: out.print });
  assert.equal(code, EXIT.ok);
  assert.equal(spy.calls.length, 0);
  assert.equal(sockets, 0);
  assert.match(out.text(), /DRY RUN/);
  assert.match(out.text(), /key env: GEMINI_API_KEY \(set: yes; value never printed\)/);
  assert.ok(!out.text().includes(FAKE));
  const none = collect();
  assert.equal(await runCheck({ argv: [], env: {}, fetchFn: spy.fn, print: none.print }), EXIT.ok);
  assert.equal(spy.calls.length, 0);
  assert.match(none.text(), /set: no/);
});

test('usage: the key never comes from argv; env NAME, model, timeout and probe flags are validated', async () => {
  for (const argv of [['--key', FAKE], [`--key=${FAKE}`], ['--api-key', 'x'], ['--key-env', 'lower-case'], ['--model', 'Bad Model'], ['--timeout-ms', '5'], ['--live-probe'], ['--bogus']]) {
    const out = collect();
    const spy = fetchSpy(jsonResponse(200, {}));
    assert.equal(await runCheck({ argv, env, fetchFn: spy.fn, print: out.print }), EXIT.usage, argv.join(' '));
    assert.equal(spy.calls.length, 0);
    assert.ok(!out.text().includes(FAKE), 'a key passed on argv is never echoed');
  }
  assert.match(parseArgs(['--key', 'x']).error, /environment only/);
  assert.equal(parseArgs(['--key-env', 'GOOGLE_GENERATIVE_AI_API_KEY']).error, null);
  assert.equal(parseArgs(['--key-env', 'GOOGLE_GENERATIVE_AI_API_KEY']).keyEnv, 'GOOGLE_GENERATIVE_AI_API_KEY');
  assert.equal(parseArgs(['--key-env', 'GEMINI_API_KEY']).error, null);
});

test('--key-env allowlist: only GEMINI_* / GOOGLE_* names; any other secret is never read or sent', async () => {
  for (const name of ['VOICE_KEY', 'PATH', 'AWS_SECRET_ACCESS_KEY', 'GEMINI', 'GOOGLEX_KEY', 'GEMINI_api_key', 'XGEMINI_KEY', '']) {
    assert.match(String(parseArgs(['--key-env', name]).error), /GEMINI_\* or GOOGLE_\*/, `refused: "${name}"`);
  }
  const out = collect();
  const spy = fetchSpy(jsonResponse(200, {}));
  const secretEnv = { AWS_SECRET_ACCESS_KEY: FAKE, [DEFAULT_KEY_ENV]: FAKE };
  const code = await runCheck({ argv: ['--execute', '--key-env', 'AWS_SECRET_ACCESS_KEY'], env: secretEnv, fetchFn: spy.fn, print: out.print });
  assert.equal(code, EXIT.usage);
  assert.equal(spy.calls.length, 0, 'nothing is sent to Google');
  assert.ok(!out.text().includes(FAKE));
  assert.ok(!out.text().includes('AWS_SECRET_ACCESS_KEY'), 'the refused NAME is not echoed either');
});

test('argv values are never printed: positional key, --apikey=, --gemini-key=, --token, unknown --flag=value', async () => {
  const cases = [
    [[SYNTH], /usage error: unknown argument at position 1 \(value not shown\)/],
    [['--execute', SYNTH], /unknown argument at position 2 \(value not shown\)/],
    [['--execute', 'plain-secret-value'], /unknown argument at position 2 \(value not shown\)/],
    [[`--apikey=${SYNTH}`], /environment only/],
    [['--apikey', SYNTH], /environment only/],
    [[`--gemini-key=${SYNTH}`], /environment only/],
    [['--gemini-key', SYNTH], /environment only/],
    [[`--token=${SYNTH}`], /environment only/],
    [['--token', SYNTH], /environment only/],
    [[`--API-KEY=${SYNTH}`], /environment only/],
    [[`--secret=plain-secret-value`], /unknown flag --secret=\.\.\. at position 1 \(value not shown\)/],
    [['--model', 'gemini-3.8-live', `--Weird=${SYNTH}`], /unknown argument at position 3 \(value not shown\)/],
  ];
  for (const [argv, expected] of cases) {
    const out = collect();
    const spy = fetchSpy(jsonResponse(200, {}));
    const label = argv.map((a) => a.replace(SYNTH, '<synthetic>')).join(' ');
    assert.equal(await runCheck({ argv, env, fetchFn: spy.fn, print: out.print }), EXIT.usage, label);
    assert.equal(spy.calls.length, 0, label);
    assert.match(out.text(), expected, label);
    assert.ok(!out.text().includes(SYNTH.slice(4)), `${label}: not even the key body`);
    assert.ok(!out.text().includes('plain-secret-value'), `${label}: a non-key-shaped value is not printed either`);
  }
});

test('--execute without the key in the environment stops before any request', async () => {
  const out = collect();
  const spy = fetchSpy(jsonResponse(200, {}));
  assert.equal(await runCheck({ argv: ['--execute'], env: {}, fetchFn: spy.fn, print: out.print }), EXIT.usage);
  assert.equal(spy.calls.length, 0);
  assert.match(out.text(), /GEMINI_API_KEY is not set/);
});

test('--execute: one metadata GET, key only in the x-goog-api-key header, never in the URL or the output', async () => {
  const out = collect();
  const spy = fetchSpy(jsonResponse(200, { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] }, { 'x-gemini-service-tier': 'standard' }));
  const code = await runCheck({ argv: ['--execute'], env, fetchFn: spy.fn, print: out.print });
  assert.equal(code, EXIT.ok);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].url, `${API_BASE}/models/gemini-3.8-live`);
  assert.ok(!spy.calls[0].url.includes(FAKE));
  assert.equal(spy.calls[0].init.method, 'GET');
  assert.equal(spy.calls[0].init.redirect, 'error', 'a redirect never carries the key header elsewhere');
  assert.equal(spy.calls[0].init.headers['x-goog-api-key'], FAKE);
  assert.match(out.text(), /key OK, model gemini-3.8-live found \(HTTP 200\); Live API \(bidiGenerateContent\): yes/);
  assert.match(out.text(), /service tier header: standard/);
  assert.ok(!out.text().includes(FAKE));
});

test('429 RESOURCE_EXHAUSTED on a free-tier quota: exit 4, metric + retry delay printed, echoed key redacted', async () => {
  const out = collect();
  const body = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: `Quota exceeded for this project (key ${FAKE})`,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '50' }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
      ],
    },
  };
  const code = await runCheck({ argv: ['--execute'], env, fetchFn: fetchSpy(jsonResponse(429, body)).fn, print: out.print });
  assert.equal(code, EXIT.quota);
  assert.match(out.text(), /HTTP 429 RESOURCE_EXHAUSTED -> quota/);
  assert.match(out.text(), /metric=generativelanguage\.googleapis\.com\/generate_content_free_tier_requests id=GenerateRequestsPerDayPerProjectPerModel-FreeTier limit=50/);
  assert.match(out.text(), /retry after: 31s/);
  assert.match(out.text(), /FREE-TIER quota: the silent-session alternative cause is CONFIRMED/);
  assert.match(out.text(), /\[REDACTED\]/);
  assert.ok(!out.text().includes(FAKE));
});

test('an invalid key exits 3; a transport error exits 5 with the URL key redacted', async () => {
  const bad = { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } };
  const out = collect();
  assert.equal(await runCheck({ argv: ['--execute'], env, fetchFn: fetchSpy(jsonResponse(400, bad)).fn, print: out.print }), EXIT.keyInvalid);
  assert.match(out.text(), /reasons: API_KEY_INVALID/);
  const out2 = collect();
  const failing = fetchSpy(new Error(`connect ETIMEDOUT https://x.example/v1?key=${FAKE}&alt=json`));
  assert.equal(await runCheck({ argv: ['--execute'], env, fetchFn: failing.fn, print: out2.print }), EXIT.failure);
  assert.match(out2.text(), /\?key=\[REDACTED\]&alt=json/);
  assert.ok(!out2.text().includes(FAKE));
  const out3 = collect();
  assert.equal(await runCheck({ argv: ['--execute'], env, fetchFn: fetchSpy(jsonResponse(404, { error: { status: 'NOT_FOUND', message: 'no such model' } })).fn, print: out3.print }), EXIT.failure);
});

test('every printed line is redacted: status, reasons, quota metric/id/limit, retry delay and the tier header', async () => {
  const out = collect();
  const body = {
    error: {
      code: 429,
      status: `RESOURCE_EXHAUSTED ${FAKE}`,
      message: `m ${SYNTH}`,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: `R_${FAKE}` },
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaMetric: `metric/${SYNTH}`, quotaId: `id-${FAKE}`, quotaValue: `${FAKE}` }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${FAKE}s` },
      ],
    },
  };
  const spy = fetchSpy(jsonResponse(429, body, { 'x-gemini-service-tier': `tier-${FAKE}-${SYNTH}` }));
  assert.equal(await runCheck({ argv: ['--execute'], env, fetchFn: spy.fn, print: out.print }), EXIT.quota);
  const text = out.text();
  assert.ok(!text.includes(FAKE), 'the env key is redacted on every line');
  assert.ok(!text.includes(SYNTH.slice(4)), 'any AIza-shaped key is redacted on every line');
  assert.match(text, /service tier header: tier-\[REDACTED\]-\[REDACTED\]/);
  assert.match(text, /HTTP 429 RESOURCE_EXHAUSTED \[REDACTED\] -> quota/);
  assert.match(text, /reasons: R_\[REDACTED\]/);
  assert.match(text, /quota: metric=metric\/\[REDACTED\] id=id-\[REDACTED\] limit=\[REDACTED\]/);
  assert.match(text, /retry after: \[REDACTED\]s/);
});

test('one --timeout-ms deadline covers the request AND the answer body; the request is aborted', async () => {
  const stalledBody = fetchSpy({ ok: true, status: 200, json: () => new Promise(() => {}), headers: { get: () => null } });
  const stalledRequest = { calls: [], fn: (url, init) => (stalledRequest.calls.push({ url, init }), new Promise(() => {})) };
  const outBody = collect();
  const outRequest = collect();
  const started = Date.now();
  const [bodyCode, requestCode] = await Promise.all([
    runCheck({ argv: ['--execute', '--timeout-ms', '1000'], env, fetchFn: stalledBody.fn, print: outBody.print }),
    runCheck({ argv: ['--execute', '--timeout-ms', '1000'], env, fetchFn: stalledRequest.fn, print: outRequest.print }),
  ]);
  assert.ok(Date.now() - started < 10000, 'both settle at the deadline, not never');
  assert.equal(bodyCode, EXIT.failure);
  assert.match(outBody.text(), /HTTP 200 but the answer body did not arrive within 1000 ms/);
  assert.ok(!/key OK|not listed/.test(outBody.text()), 'a stalled body is a failure, never a verdict');
  assert.equal(stalledBody.calls[0].init.signal.aborted, true, 'the deadline aborts the request');
  assert.equal(requestCode, EXIT.failure);
  assert.match(outRequest.text(), /step 1: no answer within 1000 ms/);
  assert.equal(stalledRequest.calls[0].init.signal.aborted, true);
});

test('--live-probe: setup only (no audio), key in a header, socket closed at setupComplete', async () => {
  const out = collect();
  const { FakeSocket, made } = fakeSocketClass((sock) => sock.onmessage({ data: JSON.stringify({ setupComplete: {} }) }));
  const ok = jsonResponse(200, { supportedGenerationMethods: ['bidiGenerateContent'] });
  const code = await runCheck({ argv: ['--execute', '--live-probe'], env, fetchFn: fetchSpy(ok).fn, WebSocketCtor: FakeSocket, print: out.print });
  assert.equal(code, EXIT.ok);
  assert.equal(made.length, 1);
  assert.equal(made[0].url, LIVE_URL);
  assert.equal(made[0].options.headers['x-goog-api-key'], FAKE);
  assert.deepEqual(made[0].sent, [{ setup: { model: 'models/gemini-3.8-live' } }], 'one setup frame, never audio');
  assert.equal(made[0].closed, 1);
  assert.match(out.text(), /Live setupComplete/);
  assert.ok(!out.text().includes(FAKE));
});

test('--live-probe: a quota close before setupComplete exits 4 (the silent-call alternative cause)', async () => {
  const out = collect();
  const { FakeSocket } = fakeSocketClass((sock) => sock.onclose({ code: 1011, reason: `RESOURCE_EXHAUSTED: You exceeded your current quota (${FAKE})` }));
  const ok = jsonResponse(200, { supportedGenerationMethods: ['bidiGenerateContent'] });
  const code = await runCheck({ argv: ['--execute', '--live-probe'], env, fetchFn: fetchSpy(ok).fn, WebSocketCtor: FakeSocket, print: out.print });
  assert.equal(code, EXIT.quota);
  assert.match(out.text(), /code=1011 .* -> quota/);
  assert.ok(!out.text().includes(FAKE));
  const blocked = collect();
  assert.equal(await runCheck({ argv: ['--execute', '--live-probe'], env, fetchFn: fetchSpy(jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED' } })).fn, WebSocketCtor: FakeSocket, print: blocked.print }), EXIT.quota, 'a failed step 1 never opens a socket');
});

test('model found but bidiGenerateContent not listed: distinct documented exit 6, no Live socket', async () => {
  assert.equal(EXIT.liveNotListed, 6);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, 'every exit code is distinct');
  const header = readFileSync(TOOL, 'utf8').split('\nimport ')[0];
  assert.match(header, /\b6 key OK but the model\s*\/\/\s*does not list bidiGenerateContent/, 'exit 6 is documented in the tool header');
  for (const body of [{ supportedGenerationMethods: ['generateContent'] }, {}, null]) {
    const out = collect();
    let sockets = 0;
    const code = await runCheck({
      argv: ['--execute', '--live-probe'],
      env,
      fetchFn: fetchSpy(jsonResponse(200, body)).fn,
      WebSocketCtor: function () {
        sockets += 1;
      },
      print: out.print,
    });
    assert.equal(code, EXIT.liveNotListed, JSON.stringify(body));
    assert.equal(sockets, 0, 'step 2 is not run');
    assert.match(out.text(), /Live API \(bidiGenerateContent\): not listed/);
    assert.match(out.text(), /exit 6: the model lists no Live API; the Live probe \(step 2\) is not run/);
  }
});

test('helpers: classify and redact', () => {
  assert.equal(classifyClose(1011, 'quota exceeded'), 'quota');
  assert.equal(classifyClose(1008, 'policy'), 'keyInvalid');
  assert.equal(classifyClose(1006, ''), 'failure');
  assert.equal(classifyError(403, { error: { status: 'PERMISSION_DENIED' } }).kind, 'keyInvalid');
  assert.equal(classifyError(500, null).kind, 'failure');
  assert.equal(classifyError(429, {}).freeTier, false);
  assert.equal(redact(`a ${FAKE} b ${FAKE}`, FAKE), 'a [REDACTED] b [REDACTED]');
  assert.equal(redact('wss://h/ws?access_token=abc&x=1', ''), 'wss://h/ws?access_token=[REDACTED]&x=1');
  assert.equal(SYNTH.length, 39);
  assert.equal(redact(`x ${SYNTH} y ${SYNTH}`, ''), 'x [REDACTED] y [REDACTED]', 'any AIza... key, even without the env key');
  assert.equal(redact(`k=${SYNTH.slice(0, 30)}`, ''), `k=${SYNTH.slice(0, 30)}`, 'a shorter AIza prefix is left alone');
});

test('CLI: dry run exits 0 and prints no key; --execute without the key exits 2 (no request is made in either)', () => {
  const dry = spawnSync(process.execPath, [TOOL], { env: { PATH: process.env.PATH, [DEFAULT_KEY_ENV]: FAKE }, encoding: 'utf8', timeout: 20000 });
  assert.equal(dry.status, EXIT.ok, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, /set: yes/);
  assert.ok(!dry.stdout.includes(FAKE) && !dry.stderr.includes(FAKE));
  const nokey = spawnSync(process.execPath, [TOOL, '--execute'], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.equal(nokey.status, EXIT.usage, nokey.stderr);
  assert.match(nokey.stdout, /is not set/);
  const positional = spawnSync(process.execPath, [TOOL, '--execute', SYNTH], { env: { PATH: process.env.PATH, [DEFAULT_KEY_ENV]: FAKE }, encoding: 'utf8', timeout: 20000 });
  assert.equal(positional.status, EXIT.usage, positional.stderr);
  assert.match(positional.stdout, /unknown argument at position 2 \(value not shown\)/);
  assert.ok(![positional.stdout, positional.stderr].some((s) => s.includes(SYNTH.slice(4)) || s.includes(FAKE)), 'CLI never echoes an argv key');
  const otherSecret = spawnSync(process.execPath, [TOOL, '--execute', '--key-env', 'PATH'], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.equal(otherSecret.status, EXIT.usage, otherSecret.stderr);
  assert.match(otherSecret.stdout, /GEMINI_\* or GOOGLE_\*/);
});
