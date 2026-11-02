'use strict';

// In a squad project a worker task must run isolated: only isolated results reach
// the integrate gate, so a shared worker task would change the source without it.
// Pre-squad dual projects (no pipeline) keep their shared tasks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');

async function daemonFor(t, { pipeline }) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-isolation-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (pipeline) {
        fs.mkdirSync(path.join(root, '.omni', 'squad', 'roles'), { recursive: true });
        for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
            fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(root, '.omni', 'squad', 'roles', name));
        }
        fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), path.join(root, '.omni', 'squad', 'pipeline.yaml'));
    }
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws-iso', session_id: 'session-iso', plan_revision: 1, expected_baseline: { kind: 'git', id: 'c'.repeat(40) }, mode: 'auto' });
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    t.after(() => daemon.close());
    return createDaemonClient({ workspaceRoot: root, timeoutMs: 10_000 });
}

const task = (id, extra) => ({ task_id: id, title: id, goal: 'Do it', owner: 'worker', risk: 'low', complexity: 'low', category: 'feature',
    allowed_files: ['lib/a.js'], context_files: [], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'lib/a.js'], cwd: '.' }], ...extra });
const register = (client, tasks) => client.registerPlan('session-iso', { plan_path: 'plan.md', plan_sha256: 'b'.repeat(64), plan_revision: 1,
    acceptance_policy: { protocol_version: 1, checks: [], ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } }, tasks });
const codeOf = (promise) => promise.then(() => 'REGISTERED', (error) => error.code);

test('squad project: shared worker tasks are refused with their ids; isolated ones and orchestrator tasks are not', async (t) => {
    const client = await daemonFor(t, { pipeline: true });
    const refused = await register(client, [task('T-1', { execution_mode: 'shared' }), task('T-2', {}), task('T-3', { execution_mode: 'isolated' }),
        task('T-4', { owner: 'orchestrator' })]).then(() => null, (error) => error);
    assert.equal(refused.code, 'SQUAD_WORKER_TASK_NOT_ISOLATED');
    assert.match(refused.message, /T-1, T-2$/, 'missing execution_mode counts as shared');
    assert.notEqual(await codeOf(register(client, [task('T-3', { execution_mode: 'isolated' }), task('T-4', { owner: 'codex' })])),
        'SQUAD_WORKER_TASK_NOT_ISOLATED');
});

test('pre-squad dual project (no pipeline): shared worker tasks are not refused by this rule', async (t) => {
    const client = await daemonFor(t, { pipeline: false });
    assert.notEqual(await codeOf(register(client, [task('T-1', { execution_mode: 'shared', owner: 'agy' })])), 'SQUAD_WORKER_TASK_NOT_ISOLATED');
});
