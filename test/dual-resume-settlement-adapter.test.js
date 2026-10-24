'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createDualOrchestrator } = require('../lib/dual/orchestrator');
const { createStateStore } = require('../lib/dual/state-store');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');

function fixture(t, { terminal = false, busy = false } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-resume-adapter-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const taskId = 'RESUME-SHARED';
    const task = { owner: 'agy', state: 'ROUTED', execution_mode: 'shared', risk: 'low',
        goal: 'Keep current value', model: 'gemini-3.7-flash-high', effort: 'high',
        allowed_files: ['index.js'], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] };
    const derived = { sessionId: 'session-resume', workspaceId: 'workspace-resume', planRevision: 1,
        currentBaseline: snapshot.identity, tasks: { [taskId]: task }, capability: {
            status: 'PASSED', to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: { agy_version: '1.1.20', agy_model: task.model },
        } };
    writeInitialSnapshot({ authorityDir: path.join(root, '.omni/runs/dual-authority'),
        sessionId: derived.sessionId, workspaceId: derived.workspaceId, workspaceRoot: root,
        identity: snapshot.identity, manifest: snapshot.manifest });
    createDualOrchestrator({ cwd: root, backend: 'snapshot', initialSnapshot: snapshot,
        workerModel: task.model, workerEffort: task.effort }).newTask(taskId);
    const runDir = path.join(root, '.omni/codex-gemini/runs', taskId);
    const state = createStateStore(runDir, { taskId, expectedBaseline: snapshot.identity });
    state.append({ type: 'phase.started', phase: 'preflight', attempt: 1 });
    if (terminal) state.append({ type: 'phase.failed', phase: 'preflight', attempt: 1,
        error_code: 'DUAL_AGY_TIMEOUT', retryable: false });
    let turns = 0;
    const releases = [];
    const authorityStore = { derive: () => derived,
        acquireLease() {
            if (busy) throw new Error('lease busy');
            return { lease_id: 'test-lease' };
        },
        renewLease() {}, releaseLease(id, reason) { releases.push({ id, reason }); } };
    const adapter = createOrchestratorAdapter({ workspaceRoot: root, authorityStore,
        operationWriter: {}, setIntervalFn: () => null, clearIntervalFn() {},
        discussion: { enabled: true, async sessionResolver() {
            turns++;
            throw Object.assign(new Error('Observed resumed provider entry'), { code: 'TEST_PROVIDER_ENTRY' });
        } },
        processRunner: async () => { throw new Error('Cold-start provider must not dispatch'); },
    });
    return { adapter, derived, state, runDir, releases, turns: () => turns };
}

test('regular shared run retains active attempt and refuses provider dispatch', async t => {
    const f = fixture(t);
    const before = f.state.readEvents();
    await assert.rejects(() => f.adapter.runTask(f.derived), { code: 'DUAL_ATTEMPT_SEQUENCE' });
    assert.deepEqual(f.state.readEvents(), before);
    assert.equal(f.turns(), 0);
    assert.equal(fs.existsSync(path.join(f.runDir, 'raw/preflight.1.failure.json')), false);
});

test('explicit shared resume settles before re-entering phases and reaches discussion transport', async t => {
    const f = fixture(t);
    await assert.rejects(() => f.adapter.runTask(f.derived, { resume: true }), { code: 'TEST_PROVIDER_ENTRY' });
    const events = f.state.readEvents();
    const settlement = events.find(e => e.error_code === 'DUAL_OWNER_DEAD');
    assert.equal(settlement.attempt, 1);
    assert.equal(settlement.retryable, true);
    assert.ok(events.some(e => e.type === 'phase.completed' && e.phase === 'preflight' && e.attempt === 2));
    assert.equal(f.state.countProviderFailures('preflight'), 0);
    assert.equal(f.turns(), 1);
    assert.equal(f.releases.length, 1);
});

test('resume cannot settle terminal-failed shared task', async t => {
    const f = fixture(t, { terminal: true });
    const before = f.state.readEvents();
    await assert.rejects(() => f.adapter.runTask(f.derived, { resume: true }), /terminal-failed/);
    assert.deepEqual(f.state.readEvents(), before);
    assert.equal(f.turns(), 0);
});

test('resume cannot settle orphan until exclusive task lease is acquired', async t => {
    const f = fixture(t, { busy: true });
    const before = f.state.readEvents();
    const result = await f.adapter.runTask(f.derived, { resume: true });
    assert.equal(result[0].skipped, true);
    assert.deepEqual(f.state.readEvents(), before);
    assert.equal(f.turns(), 0);
});
