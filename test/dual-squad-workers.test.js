'use strict';

// P5b (SPEC-SQUAD-P5 §3): several bound workers; a plan task names the worker
// that runs it, and that worker's runtime/model/effort/capability follow it.

require('./helpers/auto-approve-gates');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
    resolveConfiguredWorkerRuntime, resolveConfiguredWorkerModel, resolveConfiguredWorkerEffort, boundWorker, workerCapability,
} = require('../lib/dual/agy-model');
const { writeBinding, engineSupport } = require('../lib/squad/bindings');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');

const WORKERS = [
    { id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
    { id: 'worker-2', runtime: 'claude', model: 'sonnet', effort: 'low' },
    { id: 'worker-3', runtime: 'codex', model: 'gpt-6-luna' },
];

function project(t, { git = false } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-squad-workers-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (git) {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        fs.writeFileSync(path.join(root, 'README.md'), '# Test\n');
        fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
        fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root });
    }
    fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ workerRuntime: 'agy', workerModel: 'gemini-3.8-flash-high', workerEffort: 'high' }));
    writeBinding(root, { schema_version: 1, preset: 'squad', updated_at: '2026-11-01T00:00:00Z',
        roles: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' }, worker: WORKERS, reviewer: null } });
    return root;
}

test('a named worker brings its own runtime, model and effort; task fields still win; unnamed keeps worker-1', (t) => {
    const root = project(t);
    assert.deepEqual([resolveConfiguredWorkerRuntime(root, { worker: 'worker-2' }), resolveConfiguredWorkerModel(root, { worker: 'worker-2' }),
        resolveConfiguredWorkerEffort(root, { worker: 'worker-2' })], ['claude', 'sonnet', 'low']);
    assert.equal(resolveConfiguredWorkerEffort(root, { worker: 'worker-3' }), null, 'no effort is not inherited from worker-1');
    assert.equal(resolveConfiguredWorkerModel(root, { worker: 'worker-2', model: 'opus' }), 'opus', 'task.model overrides the binding');
    assert.deepEqual([resolveConfiguredWorkerRuntime(root), resolveConfiguredWorkerModel(root)], ['agy', 'gemini-3.8-flash-high']);
    assert.equal(boundWorker(root, 'worker-9'), null);
    assert.equal(resolveConfiguredWorkerRuntime(root, { worker: 'worker-9' }), 'agy', 'an unbound name falls back (registration rejects it)');
});

test('capability: extra workers read details.workers, the primary keeps agy_*', () => {
    const details = { agy_version: '1.4.12', agy_model: 'gemini-3.8-flash-high',
        workers: { 'worker-2': { runtime: 'claude', version: '2.1.316', model: 'sonnet' } } };
    assert.deepEqual(workerCapability(details, 'worker-2'), { version: '2.1.316', model: 'sonnet' });
    assert.deepEqual(workerCapability(details, undefined), { version: '1.4.12', model: 'gemini-3.8-flash-high' });
    assert.deepEqual(workerCapability(details, 'worker-1'), { version: '1.4.12', model: 'gemini-3.8-flash-high' });
});

test('engine supports several workers of any core runtime', () => {
    assert.deepEqual(engineSupport({ roles: { orchestrator: { runtime: 'codex', model: 'x' }, worker: WORKERS, reviewer: null } }),
        { supported: true, reasons: [] });
});

async function daemon(t, root, calls) {
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    const server = await startDaemonServer({ workspaceRoot: root, authorityStore: store,
        preflightRunner: async (_root, options) => {
            calls.push({ worker: options.worker, model: options.workerModel, effort: options.workerEffort });
            return { status: 'PASSED', to_state: 'CAPABILITY_SAFE', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
                details: { agy_model: options.workerModel, agy_version: options.worker === 'worker-2' ? '2.1.316' : '1.4.12' } };
        },
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }) });
    t.after(() => server.close());
    return { store, client: createDaemonClient({ workspaceRoot: root, timeoutMs: 10000 }) };
}

const POLICY = { protocol_version: 1, checks: [], ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } };
const task = (id, extra = {}) => ({ task_id: id, title: id, owner: 'worker', execution_mode: 'isolated', goal: `Do ${id}`,
    category: 'feature', complexity: 'low', risk: 'low', allowed_files: [`src/${id}.js`], context_files: [], deny_patterns: [],
    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }], ...extra });

test('registration pins each task to its worker and probes every distinct worker once', async (t) => {
    const root = project(t, { git: true });
    const calls = [];
    const { store, client } = await daemon(t, root, calls);
    const session = await client.beginSession({ workspace_root: root, mode: 'auto' });
    const result = await client.registerPlan(session.session_id, { plan_path: 'plan.md', plan_sha256: 'a'.repeat(64), acceptance_policy: POLICY,
        tasks: [task('A'), task('B', { worker: 'worker-2' }), task('C', { worker: 'worker-2' })] });
    assert.equal(result.registered, true);
    assert.deepEqual(calls, [{ worker: undefined, model: 'gemini-3.8-flash-high', effort: 'high' },
        { worker: 'worker-2', model: 'sonnet', effort: 'low' }]);
    const derived = store.derive();
    assert.deepEqual(derived.capability.details.workers, { 'worker-2': { runtime: 'claude', version: '2.1.316', model: 'sonnet' } });
    assert.deepEqual(['A', 'B', 'C'].map((id) => [derived.tasks[id].worker, derived.tasks[id].model, derived.tasks[id].effort]),
        [[undefined, 'gemini-3.8-flash-high', 'high'], ['worker-2', 'sonnet', 'low'], ['worker-2', 'sonnet', 'low']]);
});

test('registration rejects an unbound worker and a worker name on an orchestrator task', async (t) => {
    const root = project(t, { git: true });
    const { client } = await daemon(t, root, []);
    const session = await client.beginSession({ workspace_root: root, mode: 'auto' });
    await assert.rejects(client.registerPlan(session.session_id, { plan_path: 'plan.md', plan_sha256: 'b'.repeat(64), acceptance_policy: POLICY,
        tasks: [task('A', { worker: 'worker-7' })] }), (error) => error.code === 'DUAL_PLAN_INVALID' && /worker-7/.test(error.message));
    await assert.rejects(client.registerPlan(session.session_id, { plan_path: 'plan.md', plan_sha256: 'c'.repeat(64), acceptance_policy: POLICY,
        tasks: [task('A', { owner: 'orchestrator', worker: 'worker-2' })] }), (error) => error.code === 'DUAL_PLAN_INVALID');
});
