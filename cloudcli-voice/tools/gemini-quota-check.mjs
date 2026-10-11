#!/usr/bin/env node
// M-137 (WO-N6): read-only check of the Gemini API key behind the voice call.
// Silent-but-connected calls were recorded as Google-side degradation; the
// alternative cause — a FREE-TIER key whose quota is exhausted (the 2026-08-08
// "apparent hang" precedent) — was never checked. This script checks it.
//
// Usage:
//   node tools/gemini-quota-check.mjs [--execute] [--live-probe] [--key-env NAME] [--model NAME] [--timeout-ms N]
//
//   (default)     DRY RUN: prints the plan (key env NAME, whether it is set,
//                 the requests it would make) and exits 0. No network.
//   --execute     GET models/<model> (metadata only: no generation, no quota
//                 spend) — proves the key is valid and the model supports the
//                 Live API; 4xx answers are classified (invalid key, denied,
//                 RESOURCE_EXHAUSTED with the QuotaFailure metric/id and retry delay).
//   --live-probe  (with --execute) one Live session setup, no audio, closed at
//                 setupComplete. An exhausted key fails HERE (close reason
//                 RESOURCE_EXHAUSTED / "quota"). Costs one session start, no tokens.
//
// The key is read ONLY from process.env[NAME] (default GEMINI_API_KEY, the
// voice-gateway's own fallback name). NAME must match ^(GEMINI|GOOGLE)_[A-Z0-9_]*$
// so no other secret can ever be sent to Google. The key is never accepted on
// the command line (--key, --api-key, --apikey, --gemini-key, --token are
// refused) and no argument value is ever printed (an unknown argument is
// reported by position, plus the flag name for --flag=value). It is sent only
// as the x-goog-api-key header, redirects are refused, and EVERY printed line
// is redacted (the key itself, any AIza... Google key, key=/access_token= URL
// values). One --timeout-ms deadline covers the request AND the answer body.
//
// Exit codes: 0 ok/dry run, 2 usage or no key, 3 key invalid/denied,
// 4 quota exhausted, 5 other failure (incl. timeouts), 6 key OK but the model
// does not list bidiGenerateContent (no Live API for it; step 2 is not run).

import { pathToFileURL } from 'node:url';

export const DEFAULT_KEY_ENV = 'GEMINI_API_KEY';
export const DEFAULT_MODEL = 'gemini-3.8-live';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const EXIT = { ok: 0, usage: 2, keyInvalid: 3, quota: 4, failure: 5, liveNotListed: 6 };

// Only Gemini/Google key variables: --key-env can never point at another secret.
const KEY_ENV_RE = /^(?:GEMINI|GOOGLE)_[A-Z0-9_]*$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/;
// Any attempt to pass the key itself as a flag, with or without =value.
const KEY_FLAG_RE = /^--(?:key|api-?key|gemini-key|token)(?:=|$)/i;
// `--flag=value`: the flag name may be printed, the value never.
const FLAG_NAME_RE = /^(--[a-z][a-z0-9-]{0,31})=/;
const TIMED_OUT = Symbol('timed out');

/** An unknown argument is reported by position (and flag name for --flag=value), never by value. */
function unknownArgument(arg, index) {
  const flag = FLAG_NAME_RE.exec(arg);
  const where = `at position ${index + 1} (value not shown)`;
  return flag ? `unknown flag ${flag[1]}=... ${where}` : `unknown argument ${where}`;
}

export function parseArgs(argv = []) {
  const opts = { execute: false, liveProbe: false, keyEnv: DEFAULT_KEY_ENV, model: DEFAULT_MODEL, timeoutMs: 15000, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--live-probe') opts.liveProbe = true;
    else if (arg === '--key-env') opts.keyEnv = String(argv[++i] ?? '');
    else if (arg === '--model') opts.model = String(argv[++i] ?? '');
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (KEY_FLAG_RE.test(arg)) opts.error = 'the key is read from the environment only (--key-env NAME), never from the command line';
    else opts.error = unknownArgument(arg, i);
    if (opts.error) break;
  }
  if (!opts.error && !KEY_ENV_RE.test(opts.keyEnv)) opts.error = '--key-env must name a GEMINI_* or GOOGLE_* environment variable, like GEMINI_API_KEY';
  if (!opts.error && !MODEL_RE.test(opts.model)) opts.error = '--model must be a bare model id like gemini-3.8-live';
  if (!opts.error && !(Number.isInteger(opts.timeoutMs) && opts.timeoutMs >= 1000 && opts.timeoutMs <= 120000)) {
    opts.error = '--timeout-ms must be an integer 1000..120000';
  }
  if (!opts.error && opts.liveProbe && !opts.execute) opts.error = '--live-probe needs --execute';
  return opts;
}

/** The key from an allow-listed GEMINI_* / GOOGLE_* variable only ('' otherwise). */
function readKey(env, name) {
  if (!KEY_ENV_RE.test(String(name)) || !env || typeof env[name] !== 'string') return '';
  return env[name].trim();
}

/** Replace the key, any Google API key (AIza...) and any key/access_token query value in text. */
export function redact(text, key) {
  let out = String(text ?? '');
  if (key && key.length >= 4) out = out.split(key).join('[REDACTED]');
  out = out.replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED]');
  return out.replace(/([?&](?:key|access_token)=)[^&\s'"]+/gi, '$1[REDACTED]');
}

/** Classify a Google error body ({error:{code,status,message,details}}). */
export function classifyError(httpStatus, body) {
  const error = (body && typeof body === 'object' && body.error) || {};
  const status = String(error.status || '');
  const details = Array.isArray(error.details) ? error.details : [];
  const reasons = details.map((d) => (d && d.reason) || '').filter(Boolean);
  const quota = [];
  let retryDelay = null;
  for (const detail of details) {
    const type = String((detail && detail['@type']) || '');
    if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(detail.violations)) {
      for (const v of detail.violations) {
        quota.push({ metric: v.quotaMetric || null, id: v.quotaId || null, value: v.quotaValue || null, dimensions: v.quotaDimensions || null });
      }
    }
    if (type.endsWith('google.rpc.RetryInfo') && detail.retryDelay) retryDelay = String(detail.retryDelay);
  }
  let kind = 'failure';
  if (httpStatus === 429 || status === 'RESOURCE_EXHAUSTED') kind = 'quota';
  else if (reasons.includes('API_KEY_INVALID') || status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED' || httpStatus === 401 || httpStatus === 403) kind = 'keyInvalid';
  else if (httpStatus === 404 || status === 'NOT_FOUND') kind = 'modelNotFound';
  const freeTier = quota.some((q) => /free_tier/i.test(`${q.metric || ''} ${q.id || ''}`));
  return { kind, httpStatus, status: status || null, message: String(error.message || ''), reasons, quota, retryDelay, freeTier };
}

/** Classify a Live socket close (code + reason text). */
export function classifyClose(code, reason) {
  const text = String(reason || '');
  if (/RESOURCE_EXHAUSTED|quota|rate limit|exceeded/i.test(text)) return 'quota';
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text) || code === 1008) return 'keyInvalid';
  return 'failure';
}

function exitFor(kind) {
  if (kind === 'quota') return EXIT.quota;
  if (kind === 'keyInvalid') return EXIT.keyInvalid;
  return EXIT.failure;
}

export function buildPlan(opts, keySet) {
  const lines = [
    `mode: ${opts.execute ? 'EXECUTE' : 'DRY RUN (no network; add --execute to run)'}`,
    `key env: ${opts.keyEnv} (set: ${keySet ? 'yes' : 'no'}; value never printed)`,
    `step 1: GET ${API_BASE}/models/${opts.model} with header x-goog-api-key (metadata only, no quota spend)`,
  ];
  lines.push(
    opts.liveProbe
      ? `step 2: one Live setup on ${LIVE_URL} (no audio, closed at setupComplete; costs one session start)`
      : 'step 2: skipped (add --live-probe to test a Live session setup)',
  );
  return lines;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function checkModel({ fetchFn, key, opts, print }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  // One deadline for the request AND the body read; it also aborts the request.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
      if (controller) controller.abort();
    }, opts.timeoutMs);
  });
  try {
    let res;
    try {
      res = await Promise.race([
        fetchFn(`${API_BASE}/models/${opts.model}`, {
          method: 'GET',
          headers: { 'x-goog-api-key': key, accept: 'application/json' },
          redirect: 'error', // a redirect must never carry the key header to another URL
          signal: controller ? controller.signal : undefined,
        }),
        deadline,
      ]);
    } catch (error) {
      print(`step 1: request failed: ${error && error.message}`);
      return EXIT.failure;
    }
    if (res === TIMED_OUT) {
      print(`step 1: no answer within ${opts.timeoutMs} ms`);
      return EXIT.failure;
    }
    const body = await Promise.race([readJson(res), deadline]);
    if (body === TIMED_OUT) {
      print(`step 1: HTTP ${res.status} but the answer body did not arrive within ${opts.timeoutMs} ms`);
      return EXIT.failure;
    }
    const tier = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-gemini-service-tier') : null;
    if (tier) print(`service tier header: ${tier}`);
    if (res.ok) {
      const methods = (body && Array.isArray(body.supportedGenerationMethods) && body.supportedGenerationMethods) || [];
      const live = methods.includes('bidiGenerateContent');
      print(`step 1: key OK, model ${opts.model} found (HTTP ${res.status}); Live API (bidiGenerateContent): ${live ? 'yes' : 'not listed'}`);
      if (live) return EXIT.ok;
      print(`  exit ${EXIT.liveNotListed}: the model lists no Live API${opts.liveProbe ? '; the Live probe (step 2) is not run' : ''}`);
      return EXIT.liveNotListed;
    }
    const verdict = classifyError(res.status, body);
    print(`step 1: HTTP ${res.status} ${verdict.status || ''} -> ${verdict.kind}`.replace(/ +->/, ' ->'));
    if (verdict.message) print(`  message: ${verdict.message}`);
    if (verdict.reasons.length) print(`  reasons: ${verdict.reasons.join(', ')}`);
    for (const q of verdict.quota) print(`  quota: metric=${q.metric} id=${q.id}${q.value ? ` limit=${q.value}` : ''}`);
    if (verdict.retryDelay) print(`  retry after: ${verdict.retryDelay}`);
    if (verdict.freeTier) print('  FREE-TIER quota: the silent-session alternative cause is CONFIRMED for this key');
    return verdict.kind === 'modelNotFound' ? EXIT.failure : exitFor(verdict.kind);
  } finally {
    clearTimeout(timer);
  }
}

function liveProbe({ WebSocketCtor, key, opts, print }) {
  return new Promise((resolve) => {
    let socket;
    let done = false;
    let timer = null;
    const finish = (code, line) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (line) print(line);
      try {
        if (socket && socket.readyState === 1) socket.close(1000, 'probe done');
      } catch {
        // already closed
      }
      resolve(code);
    };
    timer = setTimeout(() => finish(EXIT.failure, `step 2: no setupComplete within ${opts.timeoutMs} ms`), opts.timeoutMs);
    try {
      socket = new WebSocketCtor(LIVE_URL, { headers: { 'x-goog-api-key': key } });
    } catch (error) {
      finish(EXIT.failure, `step 2: could not open the Live socket: ${error && error.message}`);
      return;
    }
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ setup: { model: `models/${opts.model}` } }));
      } catch (error) {
        finish(EXIT.failure, `step 2: setup send failed: ${error && error.message}`);
      }
    };
    socket.onmessage = async (event) => {
      let text = event && event.data;
      try {
        if (text && typeof text !== 'string' && typeof text.text === 'function') text = await text.text();
        else if (text && typeof text !== 'string') text = Buffer.from(text).toString('utf8');
        const msg = JSON.parse(text);
        if (msg && msg.setupComplete) finish(EXIT.ok, 'step 2: Live setupComplete — the key can open Live sessions now');
      } catch {
        // non-JSON frame: keep waiting for setupComplete or close
      }
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      const code = event && event.code;
      const reason = String((event && event.reason) || '');
      const kind = classifyClose(code, reason);
      finish(exitFor(kind), `step 2: Live socket closed before setupComplete: code=${code} reason=${reason || '(none)'} -> ${kind}`);
    };
  });
}

/** Testable entry: everything external is injected. Returns the exit code. */
export async function runCheck({ argv = [], env = {}, fetchFn = null, WebSocketCtor = null, print = (line) => console.log(line) } = {}) {
  let key = '';
  // Every printed line goes through redact(): the key (once read), any AIza... key, URL key values.
  const say = (line) => print(redact(line, key));
  const opts = parseArgs(argv);
  if (opts.error) {
    say(`usage error: ${opts.error}`);
    return EXIT.usage;
  }
  key = readKey(env, opts.keyEnv);
  for (const line of buildPlan(opts, Boolean(key))) say(line);
  if (!opts.execute) return EXIT.ok;
  if (!key) {
    say(`no key: environment variable ${opts.keyEnv} is not set (see README "Gemini quota check")`);
    return EXIT.usage;
  }
  if (typeof fetchFn !== 'function') {
    say('no fetch implementation available');
    return EXIT.failure;
  }
  const first = await checkModel({ fetchFn, key, opts, print: say });
  if (first !== EXIT.ok || !opts.liveProbe) return first;
  if (typeof WebSocketCtor !== 'function') {
    say('step 2: no WebSocket implementation available (Node >= 22 has one built in)');
    return EXIT.failure;
  }
  return liveProbe({ WebSocketCtor, key, opts, print: say });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const key = opts.error ? '' : readKey(process.env, opts.keyEnv);
  runCheck({ argv, env: process.env, fetchFn: globalThis.fetch, WebSocketCtor: globalThis.WebSocket }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`unexpected failure: ${redact(error && error.message, key)}`);
      process.exit(EXIT.failure);
    },
  );
}
