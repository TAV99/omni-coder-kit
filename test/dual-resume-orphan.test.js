'use strict';

// RED-REPRO for the dual daemon crash-recovery gap (coordinator brief, 2026-10-25).
//
// BUG 1 (this worker's fix): the daemon is killed mid-implement. The AGY lease
// expires, the controller operation is never settled, and no handoff or
// lastOutcome exists. On the next session.resume the authority layer answers
// NEEDS_LEASE_RECOVERY forever instead of re-dispatching implement in the
// SAME authority attempt with the SAME binding/baseline/allowed_files.
//
// BUG 2 (NOT fixed here; owned by the sibling worker): after the same kill,
// task.correct is rejected with DUAL_INTEGRITY_CORRUPT because correction
// requires a recorded lastOutcome and a fully released attempt, neither of
// which a killed turn ever produces. The test below pins that exact rejection
// so the BUG 1 fix cannot silently change correction semantics.
//
// Safety invariants (must hold on base AND after the fix):
//   - a lease that has NOT expired still means AGY_IN_PROGRESS: no re-dispatch.
//   - an expired lease with a provably LIVE tracked worker process must NOT
//     re-dispatch (duplicate workers writing one workspace is forbidden).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { runIsolatedTask: runRealIsolatedTask } = require('../lib/dual/isolated-runner');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter: createRealOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
const { requestTaskCorrection } = require('../lib/dual/task-correction');

const { createDiscussionStub } = require('./helpers/dual-discussion-stub');

function discussionForWorker(worker, hooks = {}) {
    return createDiscussionStub({
        ...hooks,
        async turn({ workerRoot, phase, taskId, env, spawnImpl }) {
            const runDir = path.join(workerRoot, '.omni/codex-gemini/runs', taskId);
            const prompt = fs.readFileSync(path.join(runDir, `raw/${phase}.1.input.md`), 'utf8');
            const result = await worker({ cwd: workerRoot, transport: 'discussion', args: [`-p=Execute the ${phase} phase. Read .omni/codex-gemini/runs/${taskId}/raw/${phase}.1.input.md\n${prompt}`] }, { env, spawn: spawnImpl });
            return JSON.parse(result.stdout).structured_output;
        },
    });
}

function withDiscussionWorker(options) {
    const { worker = fakeWorker([]), ...rest } = options;
    const discussion = options.discussion ?? discussionForWorker(worker);
    return { ...rest, discussion,
        processRunner: async (invocation, deps) => {
            assert.ok(invocation.args.some((arg) => arg.startsWith('-p=') && arg.includes('implement phase')),
                'Only implement may call processRunner; scout/review must use discussion');
            return worker(invocation, deps);
        },
    };
}
function runIsolatedTask(options) { return runRealIsolatedTask(withDiscussionWorker(options)); }
function createOrchestratorAdapter(options) { return createRealOrchestratorAdapter(withDiscussionWorker(options)); }

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-resume-orphan-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1,
        task: { task_id: 'TASK-1', model: 'gemini-3.8-flash-high', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '1.1.27-test', model: 'gemini-3.8-flash-high' }, authorize: () => true };
}

function fakeWorker(calls) {
    return async (invocation, options) => {
        calls.push(invocation);
        assert.ok(options.env.GIT_CEILING_DIRECTORIES);
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read index and spec',
            relevant_files: [{ path: 'index.js', description: 'return value' }], exact_symbols: [],
            validation_commands: ['node --check index.js'], constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'What to change?', source,
                source_type: 'REPOSITORY', conclusion: 'Return two' })),
            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
            failure_modes: ['wrong return value'] };
        else if (prompt.includes('implement phase')) {
            const target = spec.allowed_files[0];
            fs.writeFileSync(path.join(invocation.cwd, target), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: [target],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}

// Simulates the daemon dying mid-implement: the implement call never resolves
// (no phase.failed, no handoff, no outcome, operation never settled).
function hangImplementWorker(calls) {
    const base = fakeWorker(calls);
    return async (invocation, options) => {
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        if (prompt && prompt.includes('implement phase')) {
            calls.push(invocation);
            return new Promise(() => {});
        }
        return base(invocation, options);
    };
}

function seedAuthority(input) {
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
    const dir = path.join(input.workspaceRoot, '.omni/runs/dual-authority');
    const workspaceId = 'workspace-test';
    const snapshot = createConfiguredSnapshotBaseline({ root: input.workspaceRoot }).baseline.capture();
    const store = createAuthorityStore(dir);
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: input.workspaceRoot,
        workspace_id: workspaceId, session_id: input.sessionId, plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: input.sessionId, workspaceId,
        workspaceRoot: input.workspaceRoot, identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: input.capability.version, agy_model: input.capability.model } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ ...input.task, title: 'Task one', owner: 'agy', risk: 'low', execution_mode: 'isolated' }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: input.task.allowed_files, model: input.capability.model, effort: 'high', reason: 'Private task' });
    return { store, dir, snapshot };
}

function deadPid() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        const pid = child.pid;
        child.once('close', () => resolve(pid));
    });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(condition, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

// Builds the exact post-kill authority state: prepared workspace + execution
// owned by a dead controller pid + an active (never settled) operation +
// implement phase.started with no outcome. When `leaseTtlMs` elapses the
// lease reads as expired, which is the orphan resume must recover from.
async function craftOrphan(t, input, store, { leaseTtlMs = 5000, liveChild = false } = {}) {
    const controllerPid = await deadPid();
    const lease = store.acquireLease('TASK-1', 'agy', { ttlMs: leaseTtlMs });
    store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'TASK-1',
        lease_id: lease.lease_id, controller_pid: controllerPid });
    const operationId = crypto.randomUUID();
    createOperationLifecycleWriter(store).begin({ taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    let reference = null;
    const hangCalls = [];
    const pending = runIsolatedTask({ workspaceRoot: input.workspaceRoot, sessionId: input.sessionId, attempt: 1, planRevision: 1,
        task: store.derive().tasks['TASK-1'], capability: input.capability, worker: hangImplementWorker(hangCalls),
        authorize: () => true,
        onPrepared(ref) {
            reference = ref;
            store.append({ schema_version: 2, type: 'task.workspace.prepared', task_id: 'TASK-1',
                lease_id: lease.lease_id, attempt: 1,
                reference: { bindingPath: ref.bindingPath, bindingSha256: ref.bindingSha256,
                    workerBaselineSha256: ref.workerBaselineSha256, workerContractSha256: ref.workerContractSha256 } });
        } });
    pending.catch(() => {});
    await waitFor(() => {
        if (!reference) return false;
        const eventsPath = path.join(reference.workerRoot, '.omni/codex-gemini/runs/TASK-1/events.ndjson');
        if (!fs.existsSync(eventsPath)) return false;
        const lines = fs.readFileSync(eventsPath, 'utf8');
        return lines.includes('"phase":"implement"') && lines.includes('"type":"phase.started"');
    }, 20000, 'implement phase.started in the orphaned worker run');
    let trackedChild = null;
    if (liveChild) {
        trackedChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        t.after(() => { try { trackedChild.kill(); } catch {} });
        const processId = crypto.randomUUID();
        store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId });
        store.append({ schema_version: 2, type: 'task.process.started', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId, pid: trackedChild.pid });
    }
    if (leaseTtlMs < 120000) {
        await waitFor(() => {
            const derived = store.derive();
            return Object.values(derived.leases).find((candidate) => candidate.lease_id === lease.lease_id)?.status === 'expired';
        }, 30000, 'orphan lease to expire');
    }
    const derived = store.derive();
    assert.equal(derived.tasks['TASK-1'].isolatedHandoff, undefined, 'orphan must have no handoff');
    assert.equal(derived.tasks['TASK-1'].lastOutcome, undefined, 'orphan must have no lastOutcome');
    return { lease, operationId, reference, hangCalls, trackedChild, controllerPid };
}

test('BUG 1: resume after a daemon kill re-dispatches the orphaned implement in the SAME attempt', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store);
    const calls = [];
    const results = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    assert.equal(results[0].status, 'AWAITING_CODEX_QC',
        `resume must re-dispatch the orphaned implement, got ${JSON.stringify(results[0])}`);
    const after = store.derive();
    assert.equal(after.tasks['TASK-1'].isolatedWorkspace.attempt, 1, 're-dispatch keeps the same authority attempt');
    assert.equal(after.tasks['TASK-1'].isolatedWorkspace.reference.bindingSha256, orphan.reference.bindingSha256,
        're-dispatch keeps the same binding');
    assert.equal(after.tasks['TASK-1'].isolatedWorkspace.reference.workerBaselineSha256, orphan.reference.workerBaselineSha256,
        're-dispatch keeps the same baseline');
    assert.deepEqual(after.tasks['TASK-1'].allowed_files, ['index.js'], 're-dispatch keeps allowed_files');
    assert.equal(Object.values(after.leases).some((lease) => lease.lease_id === orphan.lease.lease_id && lease.status !== 'released'),
        false, 'the orphaned lease must be settled, not left unreleased');
    assert.ok(calls.some((invocation) => invocation.args.some((arg) => arg.startsWith('-p=') && arg.includes('implement phase'))),
        'resume must actually invoke implement again');
});

test('safety: resume does NOT re-dispatch while the orphan lease is still active', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    await craftOrphan(t, input, store, { leaseTtlMs: 120000 });
    const calls = [];
    const results = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    assert.equal(results[0].status, 'AGY_IN_PROGRESS');
    assert.equal(calls.length, 0, 'no worker call while the previous worker may still be alive');
});

test('safety: resume does NOT re-dispatch while a tracked worker process is still alive', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    await craftOrphan(t, input, store, { liveChild: true });
    const calls = [];
    const results = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    assert.notEqual(results[0].status, 'AWAITING_CODEX_QC',
        'a live worker process must never be duplicated by a second dispatch');
    assert.equal(calls.length, 0, 'no worker call while the previous worker process is alive');
});

test('BUG 2 (pinned, NOT fixed here): task.correct after a daemon kill is rejected for the missing lastOutcome', async (t) => {
    // Sibling worker owns the BUG 2 fix. This test pins the current rejection
    // (DUAL_INTEGRITY_CORRUPT: correction requires a failed released attempt)
    // so the BUG 1 fix cannot silently change correction semantics.
    const input = fixture(t);
    const { store } = seedAuthority(input);
    await craftOrphan(t, input, store);
    assert.throws(() => requestTaskCorrection({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, planRevision: 1, taskId: 'TASK-1',
        requestId: 'correct-after-kill', expectedAttempt: 1, reason: 'Retry after daemon kill.' }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
});
