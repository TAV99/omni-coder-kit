'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { createAuthorityStore } = require('../lib/dual/authority-store');

const bin = path.resolve(__dirname, '../bin/omni.js');

function acceptancePolicy() {
    return {
        protocol_version: 1,
        checks: [{
            id: 'accept-1',
            requirement_id: 'requirement-1',
            phase: 'session',
            kind: 'command',
            required: true,
            command: { program: 'node', args: ['--version'], cwd: '.' },
        }],
    };
}

function cli(root, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [bin, 'dual', ...args], {
            cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function fixture(t, { owner = 'codex', orchestrator, executionMode, extraTasks = [] } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-authority-routing-')));
    const planDir = path.join(root, '.omni', 'sdlc');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(planDir, 'setup.json'), JSON.stringify({ schema_version: 1, actions: [] }));
    fs.writeFileSync(path.join(planDir, 'dual-plan.json'), JSON.stringify({
        schema_version: 1, plan_revision: 1, acceptance_policy: acceptancePolicy(), tasks: [{
            task_id: 'TASK-1', title: 'Task one', goal: 'Update value', owner,
            ...(executionMode ? { execution_mode: executionMode } : {}),
            category: 'feature', complexity: 'low', risk: 'low', allowed_files: ['index.js'],
            context_files: [], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }],
        }, ...extraTasks],
    }));
    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    const daemon = await startDaemonServer({
        workspaceRoot: root, authorityStore: store, orchestrator,
        workerModel: 'gemini-3.7-flash-high', workerEffort: 'high',
        capabilityPreflight: async () => ({
            status: 'PASSED', to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.7-flash-high' },
        }),
    });
    t.after(async () => {
        await daemon.close();
        // root is a canonical, uniquely created fixture; never a user workspace.
        fs.rmSync(root, { recursive: true, force: true });
    });
    const bootstrap = await cli(root, ['bootstrap', '--json']);
    assert.equal(bootstrap.code, 0, bootstrap.stdout + bootstrap.stderr);
    return { root, store, authorityDir, client: createDaemonClient({ workspaceRoot: root }) };
}

test('bootstrap Codex task uses the same authority for status, run and resume without legacy writes', async (t) => {
    const { root, store } = await fixture(t);
    const before = store.verifyIntegrity().lastHash;
    for (const action of ['status', 'run', 'resume']) {
        const result = await cli(root, [action, 'TASK-1']);
        assert.equal(result.code, 0, `${action}: ${result.stderr}`);
        assert.match(result.stdout, /ROUTED/);
        assert.match(result.stdout, /Codex thực hiện task/);
        assert.doesNotMatch(result.stdout, /hoàn tất cho task/);
    }
    assert.equal(store.verifyIntegrity().lastHash, before);
    assert.equal(fs.existsSync(path.join(root, '.omni', 'codex-gemini', 'runs', 'TASK-1')), false);
});

test('bootstrap authority refuses legacy phase execution and unknown tasks without changing ledger', async (t) => {
    const { root, store } = await fixture(t);
    const before = store.verifyIntegrity().lastHash;
    const phase = await cli(root, ['phase', 'implement', 'TASK-1']);
    assert.equal(phase.code, 1);
    assert.match(phase.stderr, /DUAL_AUTHORITY_PHASE_MANAGED/);
    const missing = await cli(root, ['run', 'UNKNOWN']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /DUAL_TASK_NOT_FOUND/);
    assert.equal(store.verifyIntegrity().lastHash, before);
});

test('bootstrap active AGY run and resume observe the existing worker instead of duplicate dispatch', async (t) => {
    let calls = 0, release;
    const running = new Promise((resolve) => { release = resolve; });
    const { root, store } = await fixture(t, {
        owner: 'agy',
        orchestrator: { async runTask() { calls++; await running; } },
    });
    try {
        store.acquireLease('TASK-1', 'agy');
        for (const action of ['run', 'resume', 'run']) {
            const result = await cli(root, [action, 'TASK-1']);
            assert.equal(result.code, 0, result.stderr);
            assert.match(result.stdout, /AGY_IN_PROGRESS/);
            assert.doesNotMatch(result.stdout, /hoàn tất cho task/);
        }
        assert.equal(calls, 1);
    } finally {
        release();
        await running;
    }
});

test('targeted authority resume rejects unknown tasks and stale plan revisions before dispatch', async (t) => {
    let calls = 0;
    const { client, store } = await fixture(t, { orchestrator: { async runTask() { calls++; } } });
    const derived = store.derive();
    const before = calls;
    await assert.rejects(() => client.resumeSession({
        session_id: derived.sessionId, task_id: 'UNKNOWN', plan_revision: derived.planRevision,
    }), (error) => error.code === 'DUAL_TASK_NOT_FOUND');
    await assert.rejects(() => client.resumeSession({
        session_id: derived.sessionId, task_id: 'TASK-1', plan_revision: derived.planRevision + 1,
    }), (error) => error.code === 'DUAL_PLAN_REVISION_MISMATCH');
    assert.equal(calls, before);
});

test('run dispatches an eligible bootstrapped AGY task through the existing daemon', async (t) => {
    let calls = 0;
    const { root, store } = await fixture(t, { owner: 'agy', orchestrator: {
        async runTask(derived) {
            calls++;
            assert.deepEqual(Object.keys(derived.tasks), ['TASK-1']);
        },
    } });
    assert.equal(calls, 1, 'bootstrap dispatched once');
    const sessionId = store.derive().sessionId;
    const result = await cli(root, ['run', 'TASK-1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls, 2, 'explicit run reached the authority runner');
    assert.equal(store.derive().sessionId, sessionId);
    assert.equal(fs.existsSync(path.join(root, '.omni', 'codex-gemini', 'runs', 'TASK-1')), false);
});

test('typed bootstrap retains isolated execution selection through the daemon ledger', async (t) => {
    const { store } = await fixture(t, { owner: 'agy', executionMode: 'isolated',
        orchestrator: { async runTask() {} } });
    assert.equal(store.derive().tasks['TASK-1'].execution_mode, 'isolated');
    assert.equal(store.readEvents().find((event) => event.type === 'plan.registered').tasks[0].execution_mode, 'isolated');
});

test('typed bootstrap registers multiple isolated tasks with dependencies and exposes dependency wait', async (t) => {
    const { root, store } = await fixture(t, { owner: 'agy', executionMode: 'isolated',
        orchestrator: { async runTask() {} }, extraTasks: [{
            task_id: 'TASK-2', title: 'Second task', goal: 'Use integrated output', owner: 'agy', execution_mode: 'isolated',
            depends_on: ['TASK-1'], category: 'feature', complexity: 'low', risk: 'low', allowed_files: ['second.js'],
            context_files: ['index.js'], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        }] });
    assert.deepEqual(store.derive().tasks['TASK-2'].depends_on, ['TASK-1']);
    const output = await cli(root, ['status', 'TASK-2']);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /WAITING_FOR_DEPENDENCY/);
});
