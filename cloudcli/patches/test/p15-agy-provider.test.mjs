// P15: Antigravity (agy) CLI provider unit tests
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const PKG_ROOT = `${AI_SETUP_ROOT}/cloudcli/node_modules/@cloudcli-ai/cloudcli`;
const MISSING_DEPS = fs.existsSync(PKG_ROOT) ? false : `CloudCLI dependency dir missing: ${PKG_ROOT} (this export ships no cloudcli/node_modules; set AI_SETUP_ROOT to a full install)`;
const test = (name, fn) => nodeTest(name, { skip: MISSING_DEPS }, fn);

test('P15: providerRegistry resolves agy provider', async () => {
    const { providerRegistry } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/provider.registry.js'));
    const agy = providerRegistry.resolveProvider('agy');
    assert.ok(agy, 'agy provider must be resolved');
    assert.equal(agy.id, 'agy', 'provider id must be agy');
    assert.ok(agy.runtime, 'agy runtime must be defined');
    assert.ok(agy.models, 'agy models must be defined');
    assert.ok(agy.auth, 'agy auth must be defined');
    assert.ok(agy.sessions, 'agy sessions must be defined');
    assert.ok(agy.sessionSynchronizer, 'agy synchronizer must be defined');
});

test('P15: providerCapabilitiesService includes agy capability matrix', async () => {
    const { providerCapabilitiesService } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/services/provider-capabilities.service.js'));
    const caps = providerCapabilitiesService.getProviderCapabilities('agy');
    assert.ok(caps, 'agy capabilities must be present');
    assert.equal(caps.provider, 'agy');
    assert.deepEqual(caps.permissionModes, ['default', 'acceptEdits', 'bypassPermissions', 'plan']);
    assert.equal(caps.supportsImages, true);
    assert.equal(caps.supportsFiles, true);
    assert.equal(caps.supportsAbort, true);
    assert.equal(caps.supportsTokenUsage, true);
    assert.equal(caps.supportsEffort, true);
});

test('P15: AgyProviderAuth reports installation and authentication', async () => {
    const { AgyProviderAuth } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/list/agy/agy-auth.provider.js'));
    const auth = new AgyProviderAuth();
    assert.equal(auth.checkInstalled(), true, 'agy CLI must be installed and executable');
    const status = await auth.getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.provider, 'agy');
    assert.equal(status.authenticated, true);
});

test('P15: AgyProviderModels catalog includes gemini-3.8-flash-high default', async () => {
    const { AgyProviderModels } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/list/agy/agy-models.provider.js'));
    const models = new AgyProviderModels();
    const catalog = await models.getSupportedModels();
    assert.equal(catalog.DEFAULT, 'gemini-3.8-flash-high');
    const values = catalog.OPTIONS.map(o => o.value);
    assert.ok(values.includes('gemini-3.8-flash-high'), 'gemini-3.8-flash-high must be present');
    assert.ok(values.includes('gemini-3.7-flash-high'), 'gemini-3.7-flash-high must be present');
    assert.ok(values.includes('claude-sonnet-4-6'), 'claude-sonnet-4-6 must be present');
});

test('P15: resolveAgyPermissionOptions and resolveAgyEffort map correctly', async () => {
    const { resolveAgyPermissionOptions, resolveAgyEffort } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/list/agy/agy-runtime.provider.js'));
    assert.deepEqual(resolveAgyPermissionOptions('plan'), { args: ['--mode', 'plan'], env: {} });
    assert.deepEqual(resolveAgyPermissionOptions('acceptEdits'), { args: ['--mode', 'accept-edits'], env: {} });
    assert.deepEqual(resolveAgyPermissionOptions('bypassPermissions'), { args: ['--dangerously-skip-permissions'], env: {} });
    assert.deepEqual(resolveAgyPermissionOptions('auto'), { args: ['--dangerously-skip-permissions'], env: {} });
    assert.deepEqual(resolveAgyPermissionOptions('default'), { args: [], env: {} });

    assert.equal(resolveAgyEffort('high'), 'high');
    assert.equal(resolveAgyEffort('MAX'), 'max');
    assert.equal(resolveAgyEffort('invalid'), undefined);
});

test('P15: AgySessionsProvider parses transcript and calculates token usage', async () => {
    const { AgySessionsProvider } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/list/agy/agy-sessions.provider.js'));
    const provider = new AgySessionsProvider();
    const result = await provider.getSessionMessages('da939083-0a0b-48d4-9960-f34580369844');
    assert.ok(result.total >= 2, 'must parse at least user input and assistant response');
    assert.ok(Array.isArray(result.messages), 'messages must be an array');
    const userMsg = result.messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'user message must be present');
    assert.equal(userMsg.content || userMsg.text, 'say hello in one word');

    const usage = await provider.getTokenUsage('da939083-0a0b-48d4-9960-f34580369844');
    assert.ok(usage, 'token usage must be calculated');
    assert.ok(usage.used > 0, 'token usage must be positive');
});

test('P15: AgySessionSynchronizer reads metadata from transcript', async () => {
    const { AgySessionSynchronizer } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/list/agy/agy-session-synchronizer.provider.js'));
    const synchronizer = new AgySessionSynchronizer();
    const transcriptPath = path.join(process.env.HOME, '.gemini/antigravity-cli/brain/da939083-0a0b-48d4-9960-f34580369844/.system_generated/logs/transcript.jsonl');
    const meta = await synchronizer.readSessionMetadata(transcriptPath);
    assert.equal(meta.prompt, 'say hello in one word');
});

test('P15: AgyRuntimeProvider abort handles nonexistent sessions safely', async () => {
    const { AgyRuntimeProvider } = await import(path.join(PKG_ROOT, 'dist-server/server/modules/providers/list/agy/agy-runtime.provider.js'));
    const runtime = new AgyRuntimeProvider();
    assert.equal(await runtime.abort('nonexistent-session-id'), false);
    assert.equal(await runtime.abort(null), false);
});
