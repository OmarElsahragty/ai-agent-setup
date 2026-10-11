// WO-VL-CTX: lib/session-history.mjs — REST history seeding: wrapper parsing,
// last-30 selection (tail pagination: offset=0 IS the newest page), caps
// (160 chars/line, 4 KB total), 10 s throttle + force, bearer header from
// localStorage, failure keeps the last good data, silent progress-log feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressLog } from '../lib/progress-log.mjs';
import { createSessionHistory, historyLine, collapseToolRuns, snapshotContext } from '../lib/session-history.mjs';

// --- fakes ------------------------------------------------------------------------

function makeStorage(token) {
  const store = token === null ? {} : { 'auth-token': token };
  return { getItem: (key) => (key in store ? store[key] : null) };
}

function msg(kind, role, content, extra = {}) {
  return { id: `m-${Math.random().toString(36).slice(2)}`, sessionId: 's-1', provider: 'claude', kind, role, content, ...extra };
}

function okResponse(messages, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { messages, total: messages.length, hasMore: false, offset: 0, limit: 30, ...extra } }),
  };
}

function makeHistory({ responses = [], token = 'tok-abc', progressLog = createProgressLog(), time = { now: 0 } } = {}) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const history = createSessionHistory({
    fetch: fetchImpl,
    localStorage: makeStorage(token),
    now: () => time.now,
    setTimeout: (fn) => {
      // timeout never fires in these tests; the race must resolve via fetch
    },
    progressLog,
  });
  return { history, calls, progressLog };
}

// --- request shape ------------------------------------------------------------------

test('fetches the history route with limit=30&offset=0, bearer from localStorage, credentials include', async () => {
  const { history, calls } = makeHistory({ responses: [okResponse([])] });
  await history.refresh('s-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/providers/sessions/s-1/messages?limit=30&offset=0');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-abc');
});

test('session ids are URL-encoded; odd ids never change the route shape', async () => {
  const { history, calls } = makeHistory({ responses: [okResponse([])] });
  await history.refresh('a b/c&d');
  assert.equal(calls[0].url, '/api/providers/sessions/a%20b%2Fc%26d/messages?limit=30&offset=0');
});

test('no auth-token in localStorage -> no Authorization header (omitted, not empty)', async () => {
  const { history, calls } = makeHistory({ responses: [okResponse([])], token: null });
  await history.refresh('s-1');
  assert.ok(!('Authorization' in calls[0].init.headers));
});

// --- wrapper parsing -----------------------------------------------------------------

test('parses the createApiSuccessResponse wrapper and builds history lines', async () => {
  const { history } = makeHistory({
    responses: [
      okResponse([
        msg('text', 'user', 'run the tests please'),
        msg('text', 'assistant', 'All tests passed.'),
        msg('tool_use', 'assistant', null, { toolName: 'Bash', toolInput: { command: 'npm test' } }),
      ]),
    ],
  });
  const data = await history.refresh('s-1');
  assert.deepEqual(data.lines, ['user: run the tests please', 'claude [back=1]: All tests passed.', 'tool: Bash npm test']);
  assert.equal(data.text, data.lines.join('\n'));
});

test('a bare FetchHistoryResult (unwrapped) is accepted too', async () => {
  const { history } = makeHistory({
    responses: [{ ok: true, status: 200, json: async () => ({ messages: [msg('text', 'user', 'hi')], total: 1, hasMore: false, offset: 0, limit: 30 }) }],
  });
  const data = await history.refresh('s-1');
  assert.deepEqual(data.lines, ['user: hi']);
});

test('non-success / garbage / http-error payloads return null without throwing', async () => {
  for (const bad of [
    { ok: true, status: 200, json: async () => ({ success: false, error: 'x' }) },
    { ok: true, status: 200, json: async () => 'not json' },
    { ok: false, status: 500, json: async () => ({}) },
  ]) {
    const { history } = makeHistory({ responses: [bad] });
    assert.equal(await history.refresh('s-1'), null);
  }
});

// --- last-30 (tail pagination) + snapshot seeding --------------------------------------

test('offset semantics: the server returns the NEWEST page at offset=0 and we request exactly that (no total probe)', async () => {
  const all = [];
  for (let i = 1; i <= 45; i += 1) all.push(msg('text', i % 2 ? 'user' : 'assistant', `message ${i}`));
  const serverPage = all.slice(-30); // sliceTailPage: offset=0,limit=30 -> newest 30, oldest-first
  const { history, calls } = makeHistory({ responses: [okResponse(serverPage, { total: 45, hasMore: true })] });
  const data = await history.refresh('s-1');
  assert.equal(calls.length, 1); // ONE request — no probe round trip
  assert.ok(data.text.startsWith('claude: message 16'), 'newest page starts at message 16 (of 45)');
  assert.ok(data.text.endsWith('user: message 45'));
  assert.equal(data.lines.length, 30);
});

test('seeding fills the progress-log snapshot (NEG CONTROL: unseeded snapshot stays empty)', async () => {
  const { history, progressLog } = makeHistory({
    responses: [
      okResponse([
        msg('text', 'user', 'please fix the bug'),
        msg('tool_use', 'assistant', null, { toolName: 'Bash', toolInput: { command: 'node --test' } }),
        msg('text', 'assistant', 'Fixed and verified.'),
        msg('complete', null, null),
      ]),
    ],
  });
  // NEG CONTROL — a progress log that never saw frames OR history:
  const fresh = createProgressLog();
  assert.equal(fresh.snapshot('s-1').state, 'idle');
  assert.deepEqual(fresh.snapshot('s-1').recent, []);
  assert.equal(fresh.snapshot('s-1').lastAssistantText, '');

  await history.refresh('s-1');
  const snapshot = progressLog.snapshot('s-1');
  assert.equal(snapshot.state, 'idle'); // the trailing complete frame landed
  assert.ok(snapshot.recent.length > 0, 'recent lines were noted');
  assert.ok(snapshot.lastAssistantText.startsWith('Fixed and verified'));
});

test('seeding is SILENT: history frames never fire the progress-log update events', async () => {
  const progressLog = createProgressLog();
  const events = [];
  progressLog.onUpdate((update) => events.push(update));
  const { history } = makeHistory({
    progressLog,
    responses: [
      okResponse([
        msg('text', 'assistant', 'working on it'),
        msg('complete', null, null),
        msg('permission_request', null, null, { toolName: 'Bash' }),
      ]),
    ],
  });
  await history.refresh('s-1');
  assert.deepEqual(events, [], 'no complete/permission event may leak into the live call');
});

// --- caps ------------------------------------------------------------------------------

test('one-line lines cap at 160 chars and the total at ~14 KB (newest lines kept)', async () => {
  const messages = [];
  for (let i = 1; i <= 100; i += 1) {
    // 150-char content -> a 156-char line; 100 user lines ≈ 15.7 KB -> the
    // 14 KB cap must drop the OLDEST lines and keep the newest whole.
    messages.push(msg('text', 'user', `${'y'.repeat(150 - String(i).length - 6)} tail ${i}`));
  }
  const lastLine = `user: ${'y'.repeat(150 - String(100).length - 6)} tail 100`;
  const { history } = makeHistory({ responses: [okResponse(messages)] });
  const data = await history.refresh('s-1');
  for (const line of data.lines) assert.ok(line.length <= 160, `line too long: ${line.length}`);
  assert.ok(data.text.length <= 14000, `total too big: ${data.text.length}`);
  assert.equal(data.lines[data.lines.length - 1], lastLine, 'the NEWEST message must survive the cap intact');
  assert.ok(data.lines.length < 100, `the 14 KB cap must have dropped the oldest lines (kept ${data.lines.length})`);
  assert.ok(data.lines.length >= 80, 'the cap must not over-drop');
});

test('code fences, paths and URLs are stripped from lines', async () => {
  const { history } = makeHistory({
    responses: [
      okResponse([
        msg('text', 'user', 'see ```code fence``` and ${AI_SETUP_ROOT}/voice.js plus https://example.com/x done'),
        msg('tool_use', 'assistant', null, { toolName: 'Read', toolInput: { file_path: '/etc/hosts' } }),
      ]),
    ],
  });
  const data = await history.refresh('s-1');
  assert.match(data.lines[0], /^user: see.*and.*plus.*done$/);
  assert.ok(!data.lines[0].includes('```') && !data.lines[0].includes('${AI_SETUP_ROOT}') && !data.lines[0].includes('https://'));
  assert.equal(data.lines[1], 'tool: Read'); // path target stripped -> name only
});

test('secrets are redacted from lines (bearer, API keys, JWT, user:pass@host)', async () => {
  const secrets = [
    'Bearer abcdefghijklmnop',
    'sk-ant-api03-ABCDEFGHIJKLMNOP',
    'ghp_ABCDEFGHIJKLMNOPQRSTUV',
    'AKIAABCDEFGHIJKLMNOP',
    'AIza' + 'A'.repeat(35),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    'admin:hunter2@db.local',
  ];
  const { history } = makeHistory({
    responses: [okResponse(secrets.map((secret) => msg('text', 'user', `key ${secret} end`)))],
  });
  const data = await history.refresh('s-1');
  assert.equal(data.lines.length, secrets.length);
  for (const [i, secret] of secrets.entries()) {
    assert.equal(data.lines[i], 'user: key end', `redacted: ${secret.slice(0, 6)}`);
  }
  // NEG CONTROL: ordinary words survive untouched
  const { history: plain } = makeHistory({ responses: [okResponse([msg('text', 'user', 'skip the tokenizer step')])] });
  assert.equal((await plain.refresh('s-1')).lines[0], 'user: skip the tokenizer step');
});

test('a refresh never re-feeds messages already fed (dedup by message id)', async () => {
  const a = msg('text', 'user', 'first');
  const b = msg('text', 'assistant', 'second');
  const c = msg('text', 'assistant', 'third');
  const progressLog = createProgressLog();
  const fedIds = [];
  const feed = progressLog.feed.bind(progressLog);
  progressLog.feed = (frame, opts) => {
    fedIds.push(frame.id);
    return feed(frame, opts);
  };
  const { history } = makeHistory({ responses: [okResponse([a, b]), okResponse([a, b, c])], progressLog });
  await history.refresh('s-1');
  await history.refresh('s-1', { force: true });
  assert.deepEqual(fedIds, [a.id, b.id, c.id]);
});

test('a hung fetch times out: refresh resolves null instead of hanging', async () => {
  const history = createSessionHistory({
    fetch: () => new Promise(() => {}), // never settles
    localStorage: makeStorage('tok'),
    setTimeout: (fn) => fn(), // the timeout fires at once
    progressLog: createProgressLog(),
  });
  assert.equal(await history.refresh('s-1'), null);
});

// --- throttle --------------------------------------------------------------------------

test('throttled to one fetch per session per 10 s; force and elapsed time bypass it', async () => {
  const time = { now: 0 };
  const { history, calls } = makeHistory({ responses: [okResponse([msg('text', 'user', 'hi')])], time });

  await history.refresh('s-1');
  await history.refresh('s-1'); // 0 s later — cached
  assert.equal(calls.length, 1);

  await history.refresh('s-1', { force: true }); // call-start seeding
  assert.equal(calls.length, 2);

  time.now = 9000;
  await history.refresh('s-1'); // still inside the window
  assert.equal(calls.length, 2);

  time.now = 10001;
  await history.refresh('s-1'); // window elapsed
  assert.equal(calls.length, 3);
});

test('the throttle is per session and one call site never throws for a null session', async () => {
  const { history } = makeHistory({ responses: [okResponse([])] });
  assert.equal(await history.refresh(null), null);
  assert.equal(await history.refresh(''), null);
});

// --- failure keeps the last good -------------------------------------------------------

test('a failed fetch (network or http) keeps the last good data and never throws', async () => {
  const { history, calls } = makeHistory({
    responses: [okResponse([msg('text', 'user', 'good data')]), new Error('network down')],
  });
  const first = await history.refresh('s-1');
  assert.deepEqual(first.lines, ['user: good data']);
  // force past the throttle so the second (failing) fetch really runs
  const second = await history.refresh('s-1', { force: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(second.lines, ['user: good data'], 'last good data survives the failure');
});

test('a failed first fetch returns null (no data yet), and a later success recovers', async () => {
  const time = { now: 0 };
  const calls = [];
  let fail = true;
  const history = createSessionHistory({
    fetch: async (url, init) => {
      calls.push(url);
      if (fail) throw new Error('offline');
      return okResponse([msg('text', 'user', 'back')]);
    },
    localStorage: makeStorage('t'),
    now: () => time.now,
    setTimeout: () => {},
    progressLog: createProgressLog(),
  });
  assert.equal(await history.refresh('s-1'), null);
  fail = false;
  time.now = 20000;
  const data = await history.refresh('s-1');
  assert.deepEqual(data.lines, ['user: back']);
});

test('history lines keep clock times but drop file:line references', () => {
  assert.equal(historyLine({ kind: 'text', role: 'assistant', content: 'Started at 16:10:18 per app.py:42.' }), 'claude: Started at 16:10:18 per .');
});

// Owner 2026-10-07 (call 170008): busy runs are mostly tool calls; shell
// commands must not drown Claude's own words in the voice briefing.
test('collapseToolRuns merges consecutive tool lines into one names-only line', () => {
  const out = collapseToolRuns([
    'user: fix it',
    'tool: Bash python3 - <<EOF import json',
    'tool: Bash grep -n foo',
    'tool: Read',
    'claude: Tests pass now.',
    'tool: Bash npm test',
  ]);
  assert.deepEqual(out, ['user: fix it', 'tool: Bash ×2, Read', 'claude: Tests pass now.', 'tool: Bash npm test']);
});

test('refresh briefing collapses tool runs', async () => {
  const messages = [
    { id: 'a', kind: 'text', role: 'user', content: 'go' },
    { id: 'b', kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls -la' } },
    { id: 'c', kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'cat x' } },
    { id: 'd', kind: 'text', role: 'assistant', content: 'Done.' },
  ];
  const history = createSessionHistory({
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: { messages, total: 4 } }) }),
  });
  const data = await history.refresh('s1', { force: true });
  assert.deepEqual(data.lines, ['user: go', 'tool: Bash ×2', 'claude [back=1]: Done.']);
});

test('snapshotContext builds a briefing from the live progress snapshot', () => {
  const text = snapshotContext({
    state: 'working',
    todos: [],
    recent: ['Gate command passed (exit 0).', 'Tool: Bash', 'Tool: Read', 'Now reading the main config files'],
    lastAssistantText: 'Now reading the main config files and the OpenCode side in parallel.',
  });
  assert.equal(
    text,
    [
      'state: working',
      'progress: Gate command passed (exit 0).',
      'tool: Bash, Read',
      'progress: Now reading the main config files',
      'claude (latest message): Now reading the main config files and the OpenCode side in parallel.',
    ].join('\n'),
  );
});

test('snapshotContext is empty for an empty or missing snapshot', () => {
  assert.equal(snapshotContext(null), '');
  assert.equal(snapshotContext({ state: 'idle', todos: [], recent: [], lastAssistantText: '' }), '');
  assert.equal(snapshotContext({ state: 'working', recent: [], lastAssistantText: '' }), '');
});

test('relays from earlier voice calls are labelled, not shown as the owner\'s words now', () => {
  assert.equal(historyLine({ kind: 'text', role: 'user', content: '(voice) راجع المحادثة' }), 'user (earlier voice call): راجع المحادثة');
  assert.equal(historyLine({ kind: 'text', role: 'user', content: "اعمل كذا\n\n[owner's exact words, auto-transcribed] اعمل" }).startsWith('user (earlier voice call): '), true);
  assert.equal(historyLine({ kind: 'text', role: 'user', content: 'typed text' }), 'user: typed text');
});

// --- owner 2026-10-07 (call 200133): Jimmy gets the CEO's real words ---------

test('the NEWEST 3 claude messages are kept in full; older claude lines stay one-line', async () => {
  const long = (n) => `Sentence ${n} about the real work done. `.repeat(150);
  const messages = [
    msg('text', 'assistant', long(1)),
    msg('text', 'user', 'go on'),
    msg('text', 'assistant', long(2)),
    msg('text', 'assistant', long(3)),
    msg('text', 'assistant', long(4)),
    msg('text', 'assistant', long(5)),
  ];
  const { history } = makeHistory({ responses: [okResponse(messages)] });
  const data = await history.refresh('s-1');
  const claudeLines = data.lines.filter((line) => line.startsWith('claude [back='));
  // Each CEO message is numbered for read_claude_message (newest = 1).
  assert.deepEqual(claudeLines.map((line) => line.match(/^claude \[back=(\d+)\]/)[1]), ['5', '4', '3', '2', '1']);
  assert.equal(claudeLines.length, 5);
  assert.ok(claudeLines[4].length > 160, 'newest kept in full');
  assert.ok(claudeLines[3].length > 160, '2nd newest kept in full');
  assert.ok(claudeLines[2].length > 160, '3rd newest kept in full');
  // NEG CONTROL: the expansion is bounded — older claude lines stay one-line.
  assert.ok(claudeLines[0].length <= 160 && claudeLines[1].length <= 160, 'older claude lines must stay one-line');
  assert.ok(claudeLines[4].includes('about the real work done'), 'the full text survives');
});

test('a full claude line clips at a sentence end near 3500 chars, never mid-word', async () => {
  const { history } = makeHistory({
    responses: [okResponse([msg('text', 'assistant', 'This is one full sentence about the work. '.repeat(300))])],
  });
  const data = await history.refresh('s-1');
  assert.equal(data.lines.length, 1);
  assert.ok(data.lines[0].length <= 3500, `too long: ${data.lines[0].length}`);
  assert.ok(data.lines[0].endsWith('. …'), data.lines[0].slice(-20));
  assert.ok(data.lines[0].startsWith('claude [back=1]: This is one full sentence'));
});

test('employee notices are labelled, never rendered as the owner\'s words (R2)', async () => {
  const { history } = makeHistory({
    responses: [
      okResponse([
        msg('text', 'user', '<task-notification>\n<summary>Background task 42 finished: all tests passed</summary>\n</task-notification>'),
        msg('text', 'user', '<system-reminder>Internal digest updated</system-reminder>'),
        msg('text', 'user', 'typed by the owner'),
      ]),
    ],
  });
  const data = await history.refresh('s-1');
  assert.equal(data.lines[0], 'notice (from an employee, not the owner): Background task 42 finished: all tests passed');
  assert.equal(data.lines[1], 'notice (from an employee, not the owner): Internal digest updated');
  assert.equal(data.lines[2], 'user: typed by the owner');
  // NEG CONTROL: no wrapper may ever reach the briefing as "user:".
  for (const line of data.lines) assert.ok(!line.startsWith('user: <'), `wrapper leaked: ${line}`);
});

test('AskUserQuestion renders each question with its option labels (+ answers when present)', () => {
  assert.equal(
    historyLine({
      kind: 'tool_use',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [
          { question: 'Which model?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
          { question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
    }),
    'Q: Which model? [A | B] ; Q: Continue? [Yes | No]',
  );
  assert.equal(
    historyLine({
      kind: 'tool_use',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{ question: 'Which model?', options: [{ label: 'A' }, { label: 'B' }] }],
        answers: { 'Which model?': 'A' },
      },
    }),
    'Q: Which model? [A | B] => A',
  );
});

// Owner 2026-10-07 (WO-VP-PLOG R7): the full plan lives in the message — the
// history line keeps only a 300-char head plus the read_claude_message pointer.
test('ExitPlanMode renders a 300-char head plus the read_claude_message pointer', () => {
  assert.equal(
    historyLine({ kind: 'tool_use', toolName: 'ExitPlanMode', toolInput: { plan: 'Step 1 do this. Step 2 do that.' } }),
    'plan waiting for approval: Step 1 do this. Step 2 do that. … (full plan: read_claude_message plan:true)',
  );
  assert.equal(
    historyLine({ kind: 'tool_use', toolName: 'ExitPlanMode', toolInput: {} }),
    'plan waiting for approval: (no plan text) … (full plan: read_claude_message plan:true)',
  );
  const long = historyLine({ kind: 'tool_use', toolName: 'ExitPlanMode', toolInput: { plan: 'A plan sentence. '.repeat(400) } });
  assert.ok(long.startsWith('plan waiting for approval: A plan sentence.'), long.slice(0, 60));
  assert.ok(long.endsWith('(full plan: read_claude_message plan:true)'), long.slice(-60));
  const head = long.slice('plan waiting for approval: '.length, long.indexOf(' … (full plan:'));
  assert.ok(head.length <= 302, `head too long: ${head.length}`);
});

test('refresh exposes claudeTexts newest-first, in full, capped at ~6000 (read_claude_message)', async () => {
  const { history } = makeHistory({
    responses: [
      okResponse([
        msg('text', 'assistant', 'first reply'),
        msg('text', 'user', 'and then?'),
        msg('text', 'assistant', 'second reply'),
      ]),
    ],
  });
  const data = await history.refresh('s-1');
  assert.deepEqual(data.claudeTexts, ['second reply', 'first reply']);
  const big = makeHistory({ responses: [okResponse([msg('text', 'assistant', 'word '.repeat(2000))])] });
  const capped = await big.history.refresh('s-1');
  assert.ok(capped.claudeTexts[0].length <= 6002, String(capped.claudeTexts[0].length));
});

test('a tool-heavy newest page is topped up with older CEO messages for read_claude_message', async () => {
  const toolHeavy = [msg('text', 'assistant', 'Newest short note.'), ...Array.from({ length: 29 }, () => msg('tool_use', 'assistant', ''))];
  toolHeavy.reverse(); // oldest-first page: tools, then the note
  const olderPage = [msg('text', 'assistant', 'The long summary of everything we did.'), msg('text', 'user', 'explain'), msg('text', 'assistant', 'Older plan.')];
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const page = url.includes('offset=0') ? toolHeavy : olderPage;
    return { ok: true, status: 200, json: async () => ({ success: true, data: { messages: page, total: 33 } }) };
  };
  const { createSessionHistory } = await import('../lib/session-history.mjs');
  const history = createSessionHistory({ fetch, limit: 30 });
  const data = await history.refresh('s-1', { force: true });
  assert.deepEqual(data.claudeTexts, ['Newest short note.', 'Older plan.', 'The long summary of everything we did.']);
  assert.ok(urls.some((url) => /limit=120&offset=30/.test(url)), urls.join(' '));
  // NEG CONTROL: a page that already holds enough CEO messages fetches nothing more.
  const full = Array.from({ length: 12 }, (_, i) => msg('text', 'assistant', `Message ${i + 1}.`));
  const urls2 = [];
  const history2 = createSessionHistory({
    fetch: async (url) => (urls2.push(url), { ok: true, status: 200, json: async () => ({ messages: full, total: 50 }) }),
  });
  await history2.refresh('s-2', { force: true });
  assert.equal(urls2.length, 1);
});
