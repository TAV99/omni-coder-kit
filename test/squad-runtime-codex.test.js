'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codex = require('../lib/squad/runtimes/codex');
const { probeContext } = require('../lib/squad/runtimes/contract');
const { fakeSpawn, fakeFs } = require('./helpers/squad-fakes');

const resolved = { found: true, command: '/bin/codex', prefixArgs: [], path: '/bin/codex', source: 'candidate' };
const ctxWith = (spawnScript, files = {}, env = {}) => probeContext({
    platform: 'linux', homedir: '/home/me', env, resolved,
    spawnImpl: fakeSpawn(spawnScript), fsImpl: fakeFs(files),
});
const turn = { prompt: 'do the thing', cwd: '/work', model: 'gpt-5.6-sol', effort: 'high', permission: 'read-only', timeoutMs: 60_000 };

test('version parses codex-cli output', async () => {
    const v = await codex.version(ctxWith(() => ({ stdout: 'codex-cli 0.147.0\n' })));
    assert.deepEqual([v.ok, v.version], [true, '0.147.0']);
    const bad = await codex.version(ctxWith(() => ({ stdout: 'hello' })));
    assert.equal(bad.code, 'SQUAD_RUNTIME_PARSE_FAILED');
});

test('login status: signed in, signed out, unknown', async () => {
    const yes = await codex.authStatus(ctxWith(() => ({ stdout: 'Logged in using ChatGPT\n' })));
    assert.deepEqual([yes.state, yes.method], ['authenticated', 'ChatGPT']);
    const no = await codex.authStatus(ctxWith(() => ({ stdout: 'Not logged in\n', code: 1 })));
    assert.deepEqual([no.state, no.fix], ['unauthenticated', 'chạy: codex login']);
    const odd = await codex.authStatus(ctxWith(() => ({ stderr: 'boom', code: 2 })));
    assert.equal(odd.state, 'unknown');
});

test('models come from the cache with per-model efforts; hidden models are skipped', async () => {
    const cache = JSON.stringify({
        fetched_at: '2026-10-31T00:00:00Z', etag: 'x', client_version: '0.147.0',
        models: [
            { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', default_reasoning_level: 'low',
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
            { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
            { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' },
        ],
    });
    const r = await codex.listModels(ctxWith(() => ({}), { '/home/me/.codex/models_cache.json': cache }));
    assert.equal(r.source, 'cache');
    assert.deepEqual(r.models, [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', family: 'openai', efforts: ['low', 'ultra'], defaultEffort: 'low' },
        { id: 'gpt-5.5', label: 'GPT-5.5', family: 'openai', efforts: null, defaultEffort: null },
    ]);
});

test('CODEX_HOME moves the model cache', async () => {
    const cache = JSON.stringify({ models: [{ slug: 'gpt-5.5', visibility: 'list' }] });
    const r = await codex.listModels(ctxWith(() => ({}), { '/alt/models_cache.json': cache }, { CODEX_HOME: '/alt' }));
    assert.equal(r.models[0].id, 'gpt-5.5');
});

test('missing cache is not an error', async () => {
    const r = await codex.listModels(ctxWith(() => ({}), {}));
    assert.deepEqual([r.ok, r.source, r.models], [true, 'none', []]);
});

test('buildHeadless argv (golden)', () => {
    const inv = codex.buildHeadless({ ...turn, addDirs: ['/extra'], jsonSchemaPath: '/work/schema.json' }, { resolved });
    assert.equal(inv.command, '/bin/codex');
    assert.deepEqual(inv.args, [
        'exec', '--skip-git-repo-check', '--json', '-C', '/work', '-m', 'gpt-5.6-sol',
        '-c', 'model_reasoning_effort="high"', '-s', 'read-only', '--add-dir', '/extra',
        '--output-schema', '/work/schema.json', 'do the thing',
    ]);
    assert.equal(inv.cwd, '/work');
});

test('buildResume uses -c for the sandbox because exec resume has no -s/-C', () => {
    const inv = codex.buildResume('019a-abc', { ...turn, permission: 'workspace-write', addDirs: ['/extra'] }, { resolved });
    assert.deepEqual(inv.args, [
        'exec', 'resume', '--skip-git-repo-check', '019a-abc', 'do the thing', '--json', '-m', 'gpt-5.6-sol',
        '-c', 'model_reasoning_effort="high"', '-c', 'sandbox_mode="workspace-write"',
        '-c', 'sandbox_workspace_write.writable_roots=["/extra"]',
    ]);
    assert.ok(!inv.args.includes('-C') && !inv.args.includes('-s'));
    const auto = codex.buildResume('019a-abc', { ...turn, permission: 'full-auto', isolatedRoot: true }, { resolved });
    assert.ok(auto.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('interactiveCommand argv (golden)', () => {
    const inv = codex.interactiveCommand({ model: 'gpt-5.6-sol', effort: 'max', cwd: '/work' }, { resolved });
    assert.deepEqual(inv.args, ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="max"', '-C', '/work']);
});

test('unknown effort and bad session refs are rejected', () => {
    assert.throws(() => codex.buildHeadless({ ...turn, effort: 'turbo' }), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    assert.throws(() => codex.buildResume('bad id', turn), { code: 'SQUAD_RUNTIME_BAD_TURN' });
});
