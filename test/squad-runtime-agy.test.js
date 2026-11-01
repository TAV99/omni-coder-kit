'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('buildHeadless argv (golden): a suffixed model omits --effort', () => {
    const inv = agy.buildHeadless({ ...turn, effort: 'high', jsonSchemaPath: '/work/s.json' }, { resolved });
    assert.equal(inv.command, '/bin/agy');
    assert.deepEqual(inv.args, [
        '-p', 'look around', '--output-format', 'json', '--model', 'gemini-3.8-flash-high',
        '--mode', 'plan', '--add-dir', '/work', '--json-schema', '/work/s.json', '--print-timeout', '90s',
    ]);
});

// Live agy 1.4.12 behaviour (SPEC-SQUAD-P2 appendix V10): a mismatched --effort or
// any --effort on a Claude model makes agy exit 1, so the builder refuses first.
test('effort follows the model: suffix fixes it, Claude takes none, bare ids pass it', () => {
    const effortOf = (model, effort) => {
        const args = agy.buildHeadless({ ...turn, model, effort }).args;
        return args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null;
    };
    assert.equal(effortOf('gemini-3.8-flash-high', undefined), null);
    assert.equal(effortOf('gpt-oss-120b-medium', 'medium'), null);
    assert.throws(() => effortOf('gemini-3.8-flash-high', 'low'), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    assert.equal(effortOf('claude-sonnet-4-6', undefined), null);
    assert.throws(() => effortOf('claude-sonnet-4-6', 'high'), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    assert.equal(effortOf('gemini-3.8-flash', 'high'), 'high');
    assert.throws(() => agy.interactiveCommand({ model: 'gemini-3.8-flash-low', effort: 'high', cwd: '/work' }),
        { code: 'SQUAD_RUNTIME_BAD_TURN' });
});

test('listed models report the effort their id fixes', async () => {
    const r = await agy.listModels(ctxWith(() => ({ stdout: MODELS_TAB })));
    assert.deepEqual(r.models.map((m) => [m.id, m.efforts, m.defaultEffort]), [
        ['gemini-3.8-flash-high', ['high'], 'high'],
        ['claude-sonnet-4-6', null, null],
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

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', name), 'utf8');
const answerSchema = { safeParse: (v) => ({ success: typeof v.answer === 'string' && Number.isInteger(v.count) }) };

test('parseResult reads the real agy 1.4.12 envelope: payload, conversation, usage', () => {
    const r = agy.parseResult({ exitCode: 0, stdout: fixture('agy-json-schema.json') }, { phase: 'scout', expectedSchema: answerSchema });
    assert.equal(r.completion, 'succeeded');
    assert.deepEqual(r.payload, { answer: 'ok', count: 3 });
    assert.equal(r.sessionRef, 'a1adc6ae-af57-40b2-ad0f-72294469ac2a');
    assert.deepEqual(r.usage, { inputTokens: 17636, outputTokens: 6523, thinkingTokens: 6505 });
    assert.deepEqual([r.deniedActions, r.errorCode], [[], null]);
});

test('parseResult fails a SUCCESS turn whose tool calls were denied (top-level denied_actions, Q5)', () => {
    const r = agy.parseResult({ exitCode: 0, stdout: fixture('agy-json-schema-denied.json') }, {});
    assert.deepEqual([r.completion, r.errorCode], ['failed', 'SQUAD_RUNTIME_DENIED_ACTIONS']);
    assert.deepEqual(r.deniedActions, [{ action: 'command', display_name: 'RunCommand' }]);
    assert.equal(r.sessionRef, 'c0603b5e-43d0-4241-8fbb-f0d6ab9c1a7f', 'still resumable');
});

test('parseResult: provider error, missing or invalid payload, legacy nested denials', () => {
    const run = (envelope, opts = {}) => agy.parseResult({ exitCode: 0, stdout: JSON.stringify(envelope) }, opts);
    assert.equal(run({ status: 'ERROR', conversation_id: 'c1', response: 'quota' }).errorCode, 'SQUAD_RUNTIME_TURN_FAILED');
    assert.equal(run({ status: 'SUCCESS', response: '' }, { expectedSchema: answerSchema }).errorCode, 'SQUAD_RUNTIME_NO_PAYLOAD');
    assert.equal(run({ status: 'SUCCESS', response: '{"answer":1}' }, { expectedSchema: answerSchema }).errorCode, 'SQUAD_RUNTIME_PAYLOAD_INVALID');
    assert.deepEqual(run({ status: 'SUCCESS', response: '{"answer":"x","count":1}\n' }, { expectedSchema: answerSchema }).payload, { answer: 'x', count: 1 });
    assert.equal(run({ status: 'SUCCESS', usage: { denied_actions: ['RunCommand'] } }).errorCode, 'SQUAD_RUNTIME_DENIED_ACTIONS');
    assert.equal(run({ response: 'no status' }).completion, 'unknown');
});
