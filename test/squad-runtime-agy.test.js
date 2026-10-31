'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agy = require('../lib/squad/runtimes/agy');
const { createRegistry } = require('../lib/squad/runtimes/registry');
const { probeContext } = require('../lib/squad/runtimes/contract');
const { fakeSpawn, fakeFs } = require('./helpers/squad-fakes');

const resolved = { found: true, command: '/bin/agy', prefixArgs: [], path: '/bin/agy', source: 'candidate' };
const MODELS_TAB = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
const ctxWith = (script, env = {}) => probeContext({ platform: 'linux', homedir: '/home/me', env, resolved, spawnImpl: fakeSpawn(script) });
const turn = { prompt: 'look around', cwd: '/work', model: 'gemini-3.8-flash-high', permission: 'read-only', timeoutMs: 120_000 };

test('models: tab listing, skipping the progress line, family by model vendor', async () => {
    const r = await agy.listModels(ctxWith(() => ({ stdout: MODELS_TAB })));
    assert.deepEqual(r.models.map((m) => [m.id, m.label, m.family]), [
        ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'google'],
        ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)', 'anthropic'],
    ]);
});

test('models: JSON listing', async () => {
    const r = await agy.listModels(ctxWith(() => ({ stdout: JSON.stringify({ models: [{ id: 'gemini-x', display_name: 'X' }, 'gpt-oss-120b'] }) })));
    assert.deepEqual(r.models.map((m) => [m.id, m.family]), [['gemini-x', 'google'], ['gpt-oss-120b', 'openai-oss']]);
});

test('auth is inferred from agy models', async () => {
    const ok = await agy.authStatus(ctxWith(() => ({ stdout: MODELS_TAB })));
    assert.deepEqual([ok.state, ok.method], ['authenticated', 'inferred:models']);
    const key = await agy.authStatus(ctxWith(() => ({ stdout: MODELS_TAB }), { GEMINI_API_KEY: 'k' }));
    assert.equal(key.method, 'api-key');
    const out = await agy.authStatus(ctxWith(() => ({
        code: 1, stderr: 'Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n',
    })));
    assert.equal(out.state, 'unauthenticated');
    assert.match(out.fix, /đăng nhập/);
    const locked = await agy.authStatus(ctxWith(() => ({ code: 1, stderr: 'Error: failed to retrieve token: secret keyring is locked' })));
    assert.deepEqual([locked.state, locked.fix], ['unknown', 'mở khóa keyring của hệ điều hành']);
});

test('probe shares one `agy models` spawn between auth and model listing', async () => {
    const spawnImpl = fakeSpawn((cmd, args) => (args[0] === '--version' ? { stdout: '1.4.12\n' } : { stdout: MODELS_TAB }));
    const registry = createRegistry({ runtimes: [agy] });
    const fsImpl = fakeFs({ '/home/me/.local/bin/agy': '' });
    const report = await registry.probe('agy', { platform: 'linux', homedir: '/home/me', env: {}, fsImpl, spawnImpl });
    assert.equal(report.ready, true);
    assert.equal(spawnImpl.calls.filter((c) => c.args[0] === 'models').length, 1);
});

test('buildHeadless argv (golden)', () => {
    const inv = agy.buildHeadless({ ...turn, effort: 'high', jsonSchemaPath: '/work/s.json' }, { resolved });
    assert.equal(inv.command, '/bin/agy');
    assert.deepEqual(inv.args, [
        '-p', 'look around', '--output-format', 'json', '--model', 'gemini-3.8-flash-high', '--effort', 'high',
        '--mode', 'plan', '--add-dir', '/work', '--json-schema', '/work/s.json', '--print-timeout', '90s',
    ]);
});

test('print-timeout always ends before the OS timeout', () => {
    for (const timeoutMs of [5_000, 30_000, 59_000, 60_000, 120_000, 1_800_000]) {
        const inv = agy.buildHeadless({ ...turn, timeoutMs });
        const secs = Number(inv.args[inv.args.indexOf('--print-timeout') + 1].replace('s', ''));
        assert.ok(secs >= 1 && secs * 1000 < timeoutMs, `${timeoutMs} → ${secs}s`);
    }
});

test('workspace-write is unsupported headless; full-auto needs an isolated root', () => {
    assert.throws(() => agy.buildHeadless({ ...turn, permission: 'workspace-write' }), { code: 'SQUAD_RUNTIME_PERMISSION_UNSUPPORTED' });
    assert.throws(() => agy.buildHeadless({ ...turn, permission: 'full-auto' }), { code: 'SQUAD_RUNTIME_UNSAFE_PERMISSION' });
    const inv = agy.buildHeadless({ ...turn, permission: 'full-auto', isolatedRoot: true });
    assert.deepEqual(inv.args.slice(6, 9), ['--mode', 'accept-edits', '--dangerously-skip-permissions']);
});

test('resume appends --conversation and keeps the prompt redacted', () => {
    const inv = agy.buildResume('d7ab268b-095d', turn, { resolved });
    assert.deepEqual(inv.args.slice(-2), ['--conversation', 'd7ab268b-095d']);
    assert.ok(!inv.redactedArgs.includes('look around'));
});
