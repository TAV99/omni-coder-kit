'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { runIsolatedTask: runRealIsolatedTask, normalizeCommandString } = require('../lib/dual/isolated-runner');
const { integrateTaskResult } = require('../lib/dual/task-integration');
const { createAuthorityStore, computeEventHash } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter: createRealOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { listOperations } = require('../lib/dual/operation-lifecycle');
const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
const { releaseSettledTaskLease } = require('../lib/dual/task-processes');

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

function beginOperation({ authorityStore, ...params }) {
    return createOperationLifecycleWriter(authorityStore).begin(params);
}

function settleOperation({ authorityStore, ...params }) {
    return createOperationLifecycleWriter(authorityStore).settle(params);
}

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-isolated-runner-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1,
        task: { task_id: 'TASK-1', model: 'gemini-3.8-flash-high', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '1.1.27-test', model: 'gemini-3.8-flash-high' }, authorize: () => true };
}

function fakeWorker(calls, transform = (payload) => payload) {
    return async (invocation, options) => {
        calls.push(invocation);
        assert.ok(options.env.GIT_CEILING_DIRECTORIES);
        assert.equal(invocation.args.includes('--project'), false);
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
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: transform(payload) }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}

test('existing orchestrator runs worker phases in private snapshot and returns a QC handoff without source mutation', async (t) => {
    const input = fixture(t), calls = [];
    const handoff = await runIsolatedTask({ ...input, worker: fakeWorker(calls) });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.equal(calls.length, 3);
    assert.equal(calls.every((invocation) => invocation.cwd === handoff.reference.workerRoot), true);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(handoff.result.changes.length, 1);
    assert.equal(Buffer.from(handoff.result.changes[0].contentBase64, 'base64').toString(), 'module.exports = 2;\n');
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, handoff.handoffPath)), true);
    assert.match(handoff.handoffSha256, /^[a-f0-9]{64}$/);
    const resumed = await runIsolatedTask({ ...input, worker: fakeWorker(calls), reference: handoff.reference });
    assert.equal(resumed.handoffSha256, handoff.handoffSha256);
    assert.equal(calls.length, 3, 'resume does not call completed phases again');
});

test('isolated dispatch requires controller permission before creating a workspace or invoking a worker', async (t) => {
    const input = fixture(t);
    await assert.rejects(() => runIsolatedTask({ ...input, authorize: () => false }),
        (error) => error.code === 'DUAL_ISOLATED_UNAUTHORIZED');
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, '.omni')), false);
});

test('isolated dispatch refuses inherited AGY project selection', async (t) => {
    const input = fixture(t);
    for (const agyPrefixArgs of [['--project', 'source-project'], ['--add-dir', 'source'], ['--new-project'], null, 'invalid']) {
        await assert.rejects(() => runIsolatedTask({ ...input, agyPrefixArgs }),
            (error) => error.code === 'DUAL_ISOLATED_PROJECT_UNSAFE');
    }
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, '.omni')), false);
});

test('private worker handoff can pass independent real validation and integrate through the controller', async (t) => {
    const input = fixture(t);
    const calls = [];
    const handoff = await runIsolatedTask({ ...input, worker: fakeWorker(calls) });
    const validation = spawnSync(process.execPath, ['--check', 'index.js'], {
        cwd: handoff.reference.workerRoot, shell: false, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    const integrated = integrateTaskResult({ workspaceRoot: input.workspaceRoot, reference: handoff.reference,
        result: handoff.result, expectedResultSha256: handoff.result.resultSha256, authorize: () => true });
    assert.equal(integrated.status, 'INTEGRATED');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n');
});

test('revoked authority after preparation prevents worker invocation and preserves source', async (t) => {
    const input = fixture(t), calls = [];
    let permitted = true;
    await assert.rejects(() => runIsolatedTask({ ...input, worker: fakeWorker(calls),
        authorize: () => permitted, onPrepared() { permitted = false; } }),
    (error) => error.code === 'DUAL_ISOLATED_UNAUTHORIZED');
    assert.equal(calls.length, 0);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
});

test('completed handoff detects evidence rewritten together with its mutable phase log', async (t) => {
    const input = fixture(t), calls = [];
    const handoff = await runIsolatedTask({ ...input, worker: fakeWorker(calls) });
    const runDir = path.join(handoff.reference.workerRoot, handoff.artifactPath);
    const evidencePath = path.join(runDir, 'evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.command_outputs[0].output = 'forged replacement output';
    fs.writeFileSync(evidencePath, JSON.stringify(evidence));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex');
    const eventsPath = path.join(runDir, 'events.ndjson');
    const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
    events.find((event) => event.type === 'phase.completed' && event.phase === 'implement').artifact_hashes['evidence.json'] = digest;
    fs.writeFileSync(eventsPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await assert.rejects(() => runIsolatedTask({ ...input, reference: handoff.reference, worker: fakeWorker(calls) }),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    assert.equal(calls.length, 3);
});

test('prepared reference pins worker model before any phase is started', async (t) => {
    const input = fixture(t);
    let reference;
    await assert.rejects(() => runIsolatedTask({ ...input, onPrepared(ref) {
        reference = ref; throw new Error('interrupted before worker');
    } }), /interrupted before worker/);
    await assert.rejects(() => runIsolatedTask({ ...input, reference,
        task: { ...input.task, model: 'another-model' },
        capability: { ...input.capability, model: 'another-model' }, worker: fakeWorker([]) }),
    (error) => error.code === 'DUAL_SPEC_CORRELATION');
});

test('redirected runtime is rejected before orchestrator writes into the source checkout', async (t) => {
    const input = fixture(t);
    let reference;
    await assert.rejects(() => runIsolatedTask({ ...input, onPrepared(ref) {
        reference = ref; throw new Error('before phases');
    } }), /before phases/);
    const target = path.join(input.workspaceRoot, 'source-target');
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(reference.workerRoot, '.omni'), { recursive: true });
    fs.symlinkSync(target, path.join(reference.workerRoot, '.omni/codex-gemini'), 'junction');
    await assert.rejects(() => runIsolatedTask({ ...input, reference, worker: fakeWorker([]) }),
        (error) => error.code === 'DUAL_PATH_ESCAPE');
    assert.deepEqual(fs.readdirSync(target), [], 'no artifact writes outside private runtime');
});

test('isolated semantic evidence must correlate to the registered task and baseline', async (t) => {
    for (const field of ['task_id', 'expected_baseline']) {
        const input = fixture(t);
        await assert.rejects(() => runIsolatedTask({ ...input, worker: fakeWorker([], (payload) => ({
            ...payload, [field]: field === 'task_id' ? 'UNRELATED-TASK' : { kind: 'snapshot', id: 'a'.repeat(64) },
        })) }), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    }
});

test('isolated handoff requires outputs for the registered validation command', async (t) => {
    for (const outputs of [[], [{ command: 'unregistered command', exit_code: 0, output: '' }]]) {
        const input = fixture(t);
        await assert.rejects(() => runIsolatedTask({ ...input, worker: fakeWorker([], (payload) => (
            payload.status === 'SUCCESS' ? { ...payload, command_outputs: outputs } : payload
        )) }), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    }
});

function seedAuthority(input, extraTasks = [], options = {}) {
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
    const dir = path.join(input.workspaceRoot, '.omni/runs/dual-authority');
    const workspaceId = options.workspaceId || 'workspace-test';
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
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1 + extraTasks.length,
        ...(options.acceptancePolicy ? { acceptance_policy: options.acceptancePolicy } : {}),
        ...(options.acceptancePolicySha256 ? { acceptance_policy_sha256: options.acceptancePolicySha256 } : {}),
        tasks: [{ ...input.task, title: 'Task one', owner: 'agy', risk: 'low', execution_mode: 'isolated' }, ...extraTasks] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: input.task.allowed_files, model: input.capability.model, effort: 'high', reason: 'Private task' });
    for (const task of extraTasks) store.append({ schema_version: 2, type: 'task.routed', task_id: task.task_id,
        owner: 'agy', authority_state: 'ROUTED', allowed_files: task.allowed_files, model: input.capability.model, effort: 'high', reason: 'Private dependent task' });
    return { store, dir, snapshot };
}

async function createAuthoritativeHandoff(input, store, processRunner, operationOutcome = null) {
    const lease = store.acquireLease('TASK-1', 'agy', { ttlMs: 120000 });
    store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'TASK-1',
        lease_id: lease.lease_id, controller_pid: process.pid });
    const operationId = crypto.randomUUID();
    if (operationOutcome !== 'missing') {
        beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    }
    const task = store.derive().tasks['TASK-1'];
    const handoff = await runIsolatedTask({ workspaceRoot: input.workspaceRoot, sessionId: input.sessionId,
        attempt: 1, planRevision: 1, task, capability: input.capability, worker: processRunner, authorize: () => true,
        onPrepared(reference) {
            const { bindingPath, bindingSha256, workerBaselineSha256, workerContractSha256 } = reference;
            store.append({ schema_version: 2, type: 'task.workspace.prepared', task_id: 'TASK-1',
                lease_id: lease.lease_id, attempt: 1,
                reference: { bindingPath, bindingSha256, workerBaselineSha256, workerContractSha256 } });
        },
    });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    store.append({ schema_version: 2, type: 'task.workspace.handoff', task_id: 'TASK-1',
        lease_id: lease.lease_id, attempt: 1, handoff_path: handoff.handoffPath,
        handoff_sha256: handoff.handoffSha256, result_sha256: handoff.result.resultSha256 });
    if (operationOutcome === 'failed' || operationOutcome === 'wrong-lineage') {
        settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId,
            outcome: operationOutcome === 'failed' ? 'failed' : 'completed' });
        if (operationOutcome === 'failed' || operationOutcome === 'wrong-lineage') releaseSettledTaskLease({ authorityStore: store,
            taskId: 'TASK-1', leaseId: lease.lease_id, reason: 'test_operation_fixture' });
    }
    return { lease, operationId };
}

test('authority adapter persists isolated binding and handoff and resumes after reopen without duplicate worker calls', async (t) => {
    const input = fixture(t), calls = [];
    const { store, dir } = seedAuthority(input);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        agyProjectId: '12345678-1234-1234-1234-123456789abc', worker: fakeWorker(calls) });
    const result = await adapter.runTask(store.derive());
    assert.equal(result[0].status, 'AWAITING_CODEX_QC');
    assert.equal(store.derive().tasks['TASK-1'].isolatedWorkspace.attempt, 1);
    assert.match(store.derive().tasks['TASK-1'].isolatedHandoff.handoff_sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.values(store.derive().leases).every((lease) => lease.status === 'released'), true);
    const reopened = createAuthorityStore(dir);
    const next = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: reopened,
        worker: fakeWorker(calls) });
    assert.equal((await next.runTask(reopened.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.equal(calls.length, 3);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.ok(Object.values(store.derive().tasks['TASK-1'].executions || {}).length > 0, 'controller PID is recorded for recovery');
    await assert.rejects(() => next.runTask({ ...reopened.derive(), planRevision: 2 }),
        (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
    const foreign = fixture(t);
    const wrongRoot = createOrchestratorAdapter({ workspaceRoot: foreign.workspaceRoot, authorityStore: reopened,
        worker: fakeWorker(calls) });
    await assert.rejects(() => wrongRoot.runTask(reopened.derive()),
        (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
    const handoffPath = reopened.derive().tasks['TASK-1'].isolatedHandoff.handoff_path;
    const handoffBytes = fs.readFileSync(path.join(input.workspaceRoot, handoffPath));
    fs.appendFileSync(path.join(input.workspaceRoot, handoffPath), ' ');
    await assert.rejects(() => next.runTask(reopened.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    assert.equal(calls.length, 3);
    fs.writeFileSync(path.join(input.workspaceRoot, handoffPath), handoffBytes);
    reopened.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        model: 'unqualified-model', effort: 'high', allowed_files: input.task.allowed_files, reason: 'Same revision model drift' });
    await assert.rejects(() => next.runTask(reopened.derive()), (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
    assert.throws(() => reopened.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        plan_revision: 2, model: input.capability.model, allowed_files: input.task.allowed_files, reason: 'Changed revision' }),
    (error) => error.code === 'DUAL_OPERATION_CORRUPT');
});

test('isolated authority records a completed operation before releasing the AGY lease', async (t) => {
    const input = fixture(t), calls = [];
    const { store } = seedAuthority(input);
    const order = [];
    const writer = createOperationLifecycleWriter(store);
    const releaseLease = store.releaseLease.bind(store);
    const operationWriter = {
        begin: (args) => writer.begin(args),
        settle: (args) => { order.push('settle'); return writer.settle(args); },
    };
    store.releaseLease = (leaseId, reason) => { order.push('release'); return releaseLease(leaseId, reason); };

    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        operationWriter, worker: fakeWorker(calls) });
    const result = await adapter.runTask(store.derive());

    assert.equal(result[0].status, 'AWAITING_CODEX_QC');
    assert.deepEqual(order, ['settle', 'release']);
    assert.deepEqual(store.readOperationRecords().map((record) => ({ type: record.type, outcome: record.outcome })), [
        { type: 'started', outcome: undefined }, { type: 'settled', outcome: 'completed' },
    ]);
    assert.equal(Object.values(store.derive().leases).every((lease) => lease.status === 'released'), true);
});

test('a cancellation signal requested after worker completion does not force a cancelled operation', async (t) => {
    const input = fixture(t), { store } = seedAuthority(input), calls = [];
    const controller = new AbortController();
    const worker = fakeWorker(calls);
    const discussion = discussionForWorker(worker, { close() { controller.abort(); } });
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker, discussion, signal: controller.signal });
    const result = await adapter.runTask(store.derive());
    assert.equal(result[0].status, 'AWAITING_CODEX_QC');
    assert.deepEqual(store.readOperationRecords().map((record) => record.outcome), [undefined, 'completed']);
    assert.equal(Object.values(store.derive().leases).every((lease) => lease.status === 'released'), true);
});

test('isolated QC rejects missing, active, failed, and wrong-lineage operation evidence before mutation', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const scenarios = ['missing', 'active', 'failed', 'wrong-lineage'];
    for (const scenario of scenarios) {
        const input = fixture(t), calls = [];
        const { store, dir } = seedAuthority(input);
        await createAuthoritativeHandoff(input, store, fakeWorker(calls), scenario);
        if (scenario === 'wrong-lineage') {
            const operationsPath = path.join(dir, 'operations.ndjson');
            const envelopes = fs.readFileSync(operationsPath, 'utf8').trim().split('\n').map(JSON.parse);
            envelopes[0].record.session_id = 'foreign-session';
            envelopes[0].record_hash = computeEventHash(envelopes[0].previous_hash, envelopes[0].record);
            fs.writeFileSync(operationsPath, envelopes.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n', 'utf8');
        }
        const eventsPath = path.join(input.workspaceRoot, '.omni/runs/dual-authority/events.ndjson');
        const eventsBefore = fs.readFileSync(eventsPath, 'utf8');
        const sourceBefore = fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8');
        await assert.rejects(() => completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
            sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 }), (error) => /^DUAL_/.test(error.code || ''));
        assert.equal(fs.readFileSync(eventsPath, 'utf8'), eventsBefore, `QC must not append events for ${scenario}`);
        assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), sourceBefore,
            `QC must not integrate source for ${scenario}`);
    }
});

test('stale isolated writer cannot append handoff, settle, integrate, or complete after lease fencing', async (t) => {
    const input = fixture(t), calls = [];
    const { store } = seedAuthority(input);
    let fenced = false;
    const worker = fakeWorker(calls);
    const processRunner = async (invocation, options) => {
        if (!fenced) {
            fenced = true;
            const lease = Object.values(store.derive().leases).find((candidate) => candidate.task_id === 'TASK-1');
            store.releaseLease(lease.lease_id, 'test_operation_fence');
        }
        return worker(invocation, options);
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: processRunner });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_ISOLATED_UNAUTHORIZED');

    const events = store.readEvents();
    assert.equal(events.some((event) => event.type === 'task.workspace.handoff'), false);
    assert.equal(events.some((event) => event.type === 'task.completed'), false);
    const operations = store.readOperationRecords();
    assert.equal(operations.filter((record) => record.type === 'started').length, 1);
    assert.equal(operations.some((record) => record.type === 'settled'), false);
    assert.equal(store.derive().tasks['TASK-1'].isolatedHandoff, undefined);
});

test('aborted isolated work with an unresolved tracked child cannot create settled operation evidence', async (t) => {
    const input = fixture(t), { store } = seedAuthority(input);
    const controller = new AbortController();
    let child;
    const processRunner = async (_invocation, options) => {
        child = options.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
            cwd: _invocation.cwd, env: options.env, shell: false, windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        controller.abort();
        const error = new Error('worker cancellation requested');
        error.code = 'DUAL_PRIVATE_SETUP_ABORTED';
        throw error;
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: processRunner, signal: controller.signal });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_PRIVATE_SETUP_ABORTED');
    assert.ok(child?.pid > 0);
    assert.equal(store.readOperationRecords().some((record) => record.type === 'settled'), false);
    const lease = Object.values(store.derive().leases).find((candidate) => candidate.task_id === 'TASK-1');
    assert.equal(listOperations({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id })[0].active, true);
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(store.readOperationRecords().some((record) => record.type === 'settled'), false);
    assert.equal(Object.values(store.derive().leases).some((lease) => lease.status === 'released'), false);
});

test('isolated failure with an unresolved tracked child cannot record a task outcome before settlement', async (t) => {
    const input = fixture(t), { store } = seedAuthority(input);
    let child;
    const processRunner = async (_invocation, options) => {
        child = options.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
            cwd: _invocation.cwd, env: options.env, shell: false, windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        throw new Error('worker stopped while child is still running');
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: processRunner });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.message === 'worker stopped while child is still running');
    assert.ok(child?.pid > 0);
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome, undefined);
    assert.equal(store.readOperationRecords().some((record) => record.type === 'settled'), false);
    const lease = Object.values(store.derive().leases).find((candidate) => candidate.task_id === 'TASK-1');
    assert.equal(listOperations({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id })[0].active, true);
    assert.equal(Object.values(store.derive().leases).some((lease) => lease.status === 'released'), false);
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome, undefined);
    assert.equal(store.readOperationRecords().some((record) => record.type === 'settled'), false);
    assert.equal(Object.values(store.derive().leases).some((lease) => lease.status === 'released'), false);
});

test('unsafe isolated arguments report preparation failure with released lease and no model call', async (t) => {
    const input = fixture(t), { store } = seedAuthority(input), calls = [];
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        agyPrefixArgs: ['--project', 'source'], worker: fakeWorker(calls) });
    await assert.rejects(() => adapter.runTask(store.derive()), { code: 'DUAL_ISOLATED_PROJECT_UNSAFE' });
    assert.equal(calls.length, 0);
    assert.match(store.derive().tasks['TASK-1'].lastOutcome.summary, /before model invocation/);
    assert.equal(Object.values(store.derive().leases).every((lease) => lease.status === 'released'), true);
});

test('isolated authority QC runs registered validators and integrates before task completion', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t), calls = [];
    const { store } = seedAuthority(input);
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    const request = { workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 };
    const complete = await completeIsolatedTask(request);
    assert.equal(complete.status, 'TASK_VERIFIED');
    assert.equal(store.derive().tasks['TASK-1'].verified_by, 'codex');
    assert.equal(store.derive().sessionState, 'ACCEPTANCE', 'task completion does not bypass session gates');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(complete.commands[0].command, 'node --check index.js');
    assert.equal(complete.commands[0].exit_code, 0);
    assert.equal(Object.hasOwn(complete, 'qcLayers'), false, 'absent fields preserve the legacy return shape');
    assert.equal(complete.commands.length, 1, 'absent fields run only the registered checker');
    assert.equal(Object.hasOwn(store.derive().gates['isolated-qc-TASK-1'].details, 'qcLayers'), false);
    const before = store.verifyIntegrity().lastHash;
    assert.equal((await completeIsolatedTask(request)).status, 'TASK_VERIFIED');
    assert.equal(store.verifyIntegrity().lastHash, before);
    const gate = store.derive().gates['isolated-qc-TASK-1'];
    const receiptPath = path.join(input.workspaceRoot, gate.details.integration_receipt);
    const receiptBytes = fs.readFileSync(receiptPath);
    fs.appendFileSync(receiptPath, ' ');
    await assert.rejects(() => completeIsolatedTask(request), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    fs.writeFileSync(receiptPath, receiptBytes);
    fs.writeFileSync(path.join(input.workspaceRoot, 'index.js'), 'user new version');
    assert.equal((await completeIsolatedTask(request)).status, 'CONFLICT');
});

test('isolated authority QC cleans ephemeral build artifacts generated by validation commands', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t), calls = [];
    input.task.generated_outputs = ['dist'];
    input.task.validation_commands = [{ program: 'node', args: ['-e', 'require("fs").mkdirSync("dist", {recursive: true}); require("fs").writeFileSync("dist/output.txt", "bundle");'], cwd: '.' }];
    const { store } = seedAuthority(input);
    const worker = fakeWorker(calls, (payload) => {
        if (payload.command_outputs) {
            payload.command_outputs = [{ command: `${input.task.validation_commands[0].program} ${input.task.validation_commands[0].args.join(' ')}`, exit_code: 0, output: '' }];
        }
        return payload;
    });
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: worker }).runTask(store.derive());
    const request = { workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 };
    const complete = await completeIsolatedTask(request);
    assert.equal(complete.status, 'TASK_VERIFIED');
    assert.equal(store.derive().tasks['TASK-1'].verified_by, 'codex');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, 'dist')), false, 'ephemeral dist should not be in integrated root');
});

test('isolated authority QC rejects undeclared generated validation output', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t);
    input.task.validation_commands = [{ program: 'node', args: ['-e', 'require("fs").mkdirSync("dist", {recursive: true}); require("fs").writeFileSync("dist/output.txt", "bundle");'], cwd: '.' }];
    const { store } = seedAuthority(input);
    const command = `${input.task.validation_commands[0].program} ${input.task.validation_commands[0].args.join(' ')}`;
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker([], (payload) => payload.status === 'SUCCESS' ? { ...payload, command_outputs: [{ command, exit_code: 0, output: '' }] } : payload) }).runTask(store.derive());
    const result = await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
    assert.equal(result.status, 'NEEDS_FIX'); assert.ok(result.cleanup.unexpected_outputs.includes('dist/output.txt'));
    assert.notEqual(store.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
});

test('isolated QC failure and source conflict do not integrate or verify the task', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    for (const conflict of [true, false]) {
        const input = fixture(t);
        if (!conflict) input.task.validation_commands = [{ program: 'node', args: ['-e', 'process.exit(7)'], cwd: '.' }];
        const { store } = seedAuthority(input);
        const worker = fakeWorker([], (payload) => payload.status === 'SUCCESS' ? { ...payload,
            command_outputs: [{ command: `${input.task.validation_commands[0].program} ${input.task.validation_commands[0].args.join(' ')}`,
                exit_code: 0, output: 'untrusted worker claim' }] } : payload);
        await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
            worker: worker }).runTask(store.derive());
        if (conflict) fs.writeFileSync(path.join(input.workspaceRoot, 'index.js'), 'user new version');
        const result = await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
            sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
        assert.equal(result.status, conflict ? 'CONFLICT' : 'NEEDS_FIX');
        assert.notEqual(store.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
        assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), conflict ? 'user new version' : 'module.exports = 1;\n');
    }
});

test('omni dual qc completes a private handoff via daemon without legacy source artifacts', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker([]) }).runTask(store.derive());
    const daemon = await startDaemonServer({ workspaceRoot: input.workspaceRoot, authorityStore: store });
    t.after(() => daemon.close());
    const response = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/omni.js'), 'dual', 'qc', 'TASK-1', '--json'], {
            cwd: input.workspaceRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (bytes) => { stdout += bytes; });
        child.stderr.on('data', (bytes) => { stderr += bytes; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(response.code, 0, response.stdout + response.stderr);
    const parsed = JSON.parse(response.stdout);
    assert.equal(parsed.status, 'TASK_VERIFIED');
    assert.equal(parsed.verified, false, 'session quality gates remain pending');
    assert.equal(store.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, '.omni/codex-gemini/runs/TASK-1')), false);
});

test('dependent private task waits for integration then snapshots the accepted predecessor output', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t), calls = [];
    const { store } = seedAuthority(input, [{ ...input.task, task_id: 'TASK-2', title: 'Dependent task', owner: 'agy',
        execution_mode: 'isolated', risk: 'low', depends_on: ['TASK-1'] }]);
    const worker = fakeWorker(calls);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: async (invocation, options) => {
            const ids = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'));
            if (ids.includes('TASK-2')) assert.equal(fs.readFileSync(path.join(invocation.cwd, 'index.js'), 'utf8'), 'module.exports = 2;\n');
            return worker(invocation, options);
        } });
    const first = await adapter.runTask(store.derive());
    assert.equal(first.find((result) => result.taskId === 'TASK-2').status, 'WAITING_FOR_DEPENDENCY');
    assert.equal(calls.length, 3);
    assert.equal(store.derive().tasks['TASK-2'].isolatedWorkspace, undefined);
    const qc = await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
    assert.equal(qc.status, 'TASK_VERIFIED');
    // Stop before second implementation: the assertion in its scout proves a fresh accepted snapshot.
    let seen = false;
    const second = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: async (invocation) => {
            assert.equal(fs.readFileSync(path.join(invocation.cwd, 'index.js'), 'utf8'), 'module.exports = 2;\n');
            seen = true; throw new Error('snapshot observed');
        } });
    await assert.rejects(() => second.runTask(store.derive()), /snapshot observed/);
    assert.equal(seen, true);
});

test('two independent isolated tasks complete through QC without mixing their diffs', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t), calls = [];
    fs.writeFileSync(path.join(input.workspaceRoot, 'second.js'), 'module.exports = 1;\n');
    const { store } = seedAuthority(input, [{ ...input.task, task_id: 'TASK-2', title: 'Second file', owner: 'agy',
        execution_mode: 'isolated', risk: 'low', allowed_files: ['second.js'],
        validation_commands: [{ program: 'node', args: ['--check', 'second.js'], cwd: '.' }] }]);
    const worker = fakeWorker(calls, (payload) => payload.status === 'SUCCESS' && payload.task_id === 'TASK-2'
        ? { ...payload, command_outputs: [{ command: 'node --check second.js', exit_code: 0, output: '' }] } : payload);
    const outcomes = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: worker }).runTask(store.derive());
    assert.deepEqual(outcomes.map((item) => item.status), ['AWAITING_CODEX_QC', 'AWAITING_CODEX_QC']);
    assert.equal(calls.length, 6);
    for (const taskId of ['TASK-1', 'TASK-2']) {
        assert.equal((await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
            sessionId: input.sessionId, taskId, planRevision: 1 })).status, 'TASK_VERIFIED');
    }
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'second.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(store.derive().sessionState, 'ACCEPTANCE');
});

test('rechecking an earlier task accepts a later verified edit on the same file but rejects external drift', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t), calls = [];
    const { store } = seedAuthority(input, [{ ...input.task, task_id: 'TASK-2', title: 'Extend same file', owner: 'agy',
        execution_mode: 'isolated', risk: 'low', depends_on: ['TASK-1'] }]);
    const worker = fakeWorker(calls);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: async (invocation, options) => {
            const result = await worker(invocation, options);
            const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
            if (prompt.includes('implement phase') && fs.existsSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-2'))) {
                fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 3;\n');
            }
            return result;
        } });
    const qc = (taskId) => completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId, planRevision: 1 });
    await adapter.runTask(store.derive());
    assert.equal((await qc('TASK-1')).status, 'TASK_VERIFIED');
    await adapter.runTask(store.derive());
    assert.equal((await qc('TASK-2')).status, 'TASK_VERIFIED');
    const before = store.verifyIntegrity().lastHash;
    assert.equal((await qc('TASK-1')).status, 'TASK_VERIFIED', 'a later accepted patch is not external drift');
    assert.equal(store.verifyIntegrity().lastHash, before, 'historical replay is read-only');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 3;\n');
    fs.writeFileSync(path.join(input.workspaceRoot, 'index.js'), 'user edit');
    assert.equal((await qc('TASK-1')).status, 'CONFLICT');
    fs.writeFileSync(path.join(input.workspaceRoot, 'index.js'), 'module.exports = 3;\n');
    const receipt = store.derive().gates['isolated-qc-TASK-2'].details.integration_receipt;
    fs.appendFileSync(path.join(input.workspaceRoot, receipt), ' ');
    await assert.rejects(() => qc('TASK-1'), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    assert.equal(calls.length, 6);
});

test('worker question waits durably for Codex reply then resumes the same task without repeating scout', async (t) => {
    const { postTaskMessage } = require('../lib/dual/task-messages');
    const input = fixture(t), calls = [];
    const { store, dir } = seedAuthority(input);
    const worker = fakeWorker(calls, (payload) => payload.open_questions ? { ...payload, open_questions: ['Which value is required?'] } : payload);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: worker });
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'NEEDS_CONTEXT');
    assert.equal(calls.length, 1);
    const waiting = createAuthorityStore(dir).derive().tasks['TASK-1'];
    assert.equal(waiting.messages[0].body, 'Which value is required?');
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'NEEDS_CONTEXT');
    assert.equal(calls.length, 1);
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    const daemon = await startDaemonServer({ workspaceRoot: input.workspaceRoot, authorityStore: store });
    t.after(() => daemon.close());
    const client = createDaemonClient({ workspaceRoot: input.workspaceRoot });
    assert.equal((await client.replyToTask(input.sessionId, { task_id: 'TASK-1', plan_revision: 1,
        message_id: 'reply-1', reply_to: waiting.messages[0].message_id, body: 'Return 2; preserve the existing file scope.' })).acknowledged, true);
    const resumed = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: async (invocation, options) => {
            const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
            const reference = prompt.match(/Read (\S+)/)[1];
            assert.ok(fs.readFileSync(path.join(invocation.cwd, reference), 'utf8').includes('Return 2; preserve the existing file scope.'));
            return worker(invocation, options);
        } });
    assert.equal((await resumed.runTask(store.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.equal(calls.length, 3);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
});

test('worker cannot rewrite the controller clarification between implementation and review', async (t) => {
    const input = fixture(t), calls = [];
    const worker = fakeWorker(calls, (payload) => payload.open_questions ? { ...payload, open_questions: ['Which value?'] } : payload);
    const waiting = await runIsolatedTask({ ...input, worker: worker });
    assert.equal(waiting.status, 'NEEDS_CONTEXT');
    await assert.rejects(() => runIsolatedTask({ ...input, reference: waiting.reference,
        expectedQuestions: ['Which value?'], controllerReplies: [{ question: 'Which value?', answer: '2' }],
        worker: async (invocation, options) => {
            const result = await worker(invocation, options);
            fs.writeFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/controller-context.json'),
                JSON.stringify({ task_id: 'TASK-1', plan_revision: 1, replies: [{ question: 'Which value?', answer: 'forged' }] }));
            return result;
        } }), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
});

test('multiple scout questions are recorded atomically in one authority event', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const worker = fakeWorker([], (payload) => payload.open_questions ? { ...payload, open_questions: ['First?', 'Second?'] } : payload);
    const result = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: worker }).runTask(store.derive());
    assert.equal(result[0].status, 'NEEDS_CONTEXT');
    const records = store.readEvents().filter((event) => ['task.message', 'task.questions'].includes(event.type));
    assert.equal(records.length, 1);
    assert.equal(records[0].questions.length, 2);
});

test('worker cannot invent controller answers when the controller never supplied replies', async (t) => {
    const input = fixture(t);
    const worker = fakeWorker([]);
    await assert.rejects(() => runIsolatedTask({ ...input, worker: async (invocation, options) => {
        const result = await worker(invocation, options);
        fs.writeFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/controller-context.json'), 'FORGED_CONTROLLER_ANSWER');
        return result;
    } }), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
});

test('Codex correction after failed QC creates a bounded new attempt and preserves old artifacts', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const { requestTaskCorrection } = require('../lib/dual/task-correction');
    const input = fixture(t), calls = [];
    input.task.validation_commands = [{ program: 'node', args: ['-e', 'process.exit(require("./index.js")===3?0:7)'], cwd: '.' }];
    const { store, dir } = seedAuthority(input);
    const worker = fakeWorker(calls, (payload) => payload.status === 'SUCCESS' ? { ...payload,
        command_outputs: [{ command: `node ${input.task.validation_commands[0].args.join(' ')}`, exit_code: 0, output: '' }] } : payload);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: worker });
    await adapter.runTask(store.derive());
    const old = store.derive().tasks['TASK-1'].isolatedWorkspace;
    const qcArgs = { workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 };
    assert.equal((await completeIsolatedTask(qcArgs)).status, 'NEEDS_FIX');
    assert.equal(createAuthorityStore(dir).derive().tasks['TASK-1'].lastOutcome.status, 'NEEDS_FIX');
    const correction = { ...qcArgs, requestId: 'fix-1', expectedAttempt: 1, reason: 'Return three to pass the registered value check.' };
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    const daemon = await startDaemonServer({ workspaceRoot: input.workspaceRoot, authorityStore: store });
    t.after(() => daemon.close());
    const client = createDaemonClient({ workspaceRoot: input.workspaceRoot });
    assert.equal((await client.correctTask(input.sessionId, { task_id: 'TASK-1', plan_revision: 1,
        request_id: correction.requestId, expected_attempt: 1, reason: correction.reason })).attempt, 2);
    assert.equal(requestTaskCorrection(correction).reused, true);
    assert.deepEqual(store.derive().tasks['TASK-1'].allowed_files, ['index.js']);
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, old.reference.bindingPath)), true);
    const repaired = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: async (invocation, options) => {
            const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
            const file = prompt.match(/Read (\S+)/)[1];
            assert.ok(fs.readFileSync(path.join(invocation.cwd, file), 'utf8').includes(correction.reason));
            const result = await worker(invocation, options);
            if (prompt.includes('implement phase')) fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 3;\n');
            return result;
        } });
    assert.equal((await repaired.runTask(store.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.equal(store.derive().tasks['TASK-1'].isolatedWorkspace.attempt, 2);
    assert.equal((await completeIsolatedTask(qcArgs)).status, 'TASK_VERIFIED');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 3;\n');
    assert.equal(store.derive().tasks['TASK-1'].previousAttempts.length, 1);
});

test('correction budget and active-lease checks prevent duplicate or unbounded worker attempts', async (t) => {
    const { requestTaskCorrection } = require('../lib/dual/task-correction');
    const input = fixture(t), { store } = seedAuthority(input);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: async () => { throw Object.assign(new Error('worker stopped'), { code: 'RESULT_MALFORMED' }); } });
    const base = { workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId,
        taskId: 'TASK-1', planRevision: 1, reason: 'Retry the failed attempt within its unchanged scope.' };
    for (let attempt = 1; attempt <= 3; attempt++) {
        await assert.rejects(() => adapter.runTask(store.derive()), /worker stopped/);
        assert.equal(store.derive().tasks['TASK-1'].lastOutcome.attempt, attempt);
        assert.equal((await adapter.runTask(store.derive()))[0].status, 'FAILED');
        const request = { ...base, requestId: `retry-${attempt}`, expectedAttempt: attempt };
        if (attempt < 3) {
            const lease = store.acquireLease('TASK-1', 'codex');
            assert.throws(() => requestTaskCorrection(request), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
            store.releaseLease(lease.lease_id, 'test');
            assert.equal(requestTaskCorrection(request).attempt, attempt + 1);
        } else assert.throws(() => requestTaskCorrection(request), (error) => error.code === 'DUAL_CORRECTION_LIMIT');
    }
    assert.equal(store.derive().tasks['TASK-1'].previousAttempts.length, 2);
    const beforeReplay = store.verifyIntegrity().lastHash;
    assert.deepEqual(requestTaskCorrection({ ...base, requestId: 'retry-1', expectedAttempt: 1 }),
        { acknowledged: true, reused: true, attempt: 2 });
    assert.equal(store.verifyIntegrity().lastHash, beforeReplay);
});

test('correction refuses an attempt with a recorded partial integration', async (t) => {
    const { requestTaskCorrection, recordTaskOutcome } = require('../lib/dual/task-correction');
    const input = fixture(t), { store } = seedAuthority(input);
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker([]) }).runTask(store.derive());
    const task = store.derive().tasks['TASK-1'];
    const lease = store.acquireLease('TASK-1', 'codex');
    recordTaskOutcome({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        status: 'CONFLICT', code: 'DUAL_SOURCE_CONFLICT', summary: 'Partial integration requires recovery' });
    store.releaseLease(lease.lease_id, 'test');
    const attemptDir = path.join(input.workspaceRoot, path.dirname(task.isolatedWorkspace.reference.bindingPath));
    fs.writeFileSync(path.join(attemptDir, 'integration-existing.json'), '{}');
    assert.throws(() => requestTaskCorrection({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1, expectedAttempt: 1, requestId: 'fix', reason: 'Retry' }),
    (error) => error.code === 'DUAL_CORRECTION_INTEGRATION_PENDING');
    assert.equal(store.derive().tasks['TASK-1'].isolatedWorkspace.reference.bindingSha256, task.isolatedWorkspace.reference.bindingSha256);
});

test('unknown preparation failure parks for classification and preserves the unregistered snapshot', async (t) => {
    const { requestTaskCorrection } = require('../lib/dual/task-correction');
    const input = fixture(t);
    let orphan;
    await assert.rejects(() => runIsolatedTask({ ...input, onPrepared(reference) {
        orphan = reference;
        throw new Error('interrupted before authority registration');
    } }), /interrupted before authority/);
    const orphanBytes = fs.readFileSync(path.join(input.workspaceRoot, orphan.bindingPath));
    const { store, dir } = seedAuthority(input), calls = [];
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: fakeWorker(calls) });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_TASK_WORKSPACE_EXISTS');
    const failed = createAuthorityStore(dir).derive().tasks['TASK-1'];
    assert.equal(failed.lastOutcome.code, 'DUAL_TASK_WORKSPACE_EXISTS');
    assert.equal(failed.lastOutcome.attempt, 1);
    assert.equal(failed.isolatedWorkspace, undefined);
    assert.equal(calls.length, 0);
    assert.throws(() => requestTaskCorrection({ workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId,
        taskId: 'TASK-1', planRevision: 1, expectedAttempt: 1, requestId: 'prepare-fix', reason: 'Retry interrupted preparation in a fresh attempt.' }),
    { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'FAILED');
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome.attempt, 1);
    assert.deepEqual(fs.readFileSync(path.join(input.workspaceRoot, orphan.bindingPath)), orphanBytes);
    assert.equal(store.derive().tasks['TASK-1'].previousAttempts, undefined);
});

test('missing context failure is durable before model calls or workspace registration', async (t) => {
    const input = fixture(t);
    input.task.context_files = ['missing.md'];
    const { store } = seedAuthority(input), calls = [];
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: fakeWorker(calls) });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_TASK_CONTEXT_UNAVAILABLE');
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome.code, 'DUAL_TASK_CONTEXT_UNAVAILABLE');
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'FAILED');
    assert.equal(calls.length, 0);
});

test('isolated task evidence satisfies existing session gates and produces a verified receipt', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    const { createDaemonServerOptions } = require('../bin/omni-daemon');
    const input = fixture(t);
    input.sessionId = crypto.randomUUID();
    const packageJson = { name: 'isolated-receipt-fixture', version: '1.0.0', private: true };
    fs.writeFileSync(path.join(input.workspaceRoot, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    fs.writeFileSync(path.join(input.workspaceRoot, 'package-lock.json'), `${JSON.stringify({
        ...packageJson,
        lockfileVersion: 3,
        requires: true,
        packages: { '': packageJson },
    })}\n`);
    fs.writeFileSync(path.join(input.workspaceRoot, '.npmrc'), 'offline=true\naudit=true\n');
    const { store } = seedAuthority(input, [], { workspaceId: crypto.createHash('sha256').update('isolated receipt workspace').digest('hex'), acceptancePolicy: {
        protocol_version: 1,
        checks: [],
        ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true },
    } });
    assert.equal(store.derive().plan.acceptancePolicySha256, undefined,
        'the durable legacy plan includes a validated acceptance policy without an optional persisted digest');
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker([]) }).runTask(store.derive());
    await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
    const daemon = await startDaemonServer(createDaemonServerOptions({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        orchestrator: createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store }),
    }));
    t.after(() => daemon.close());
    const client = createDaemonClient({ workspaceRoot: input.workspaceRoot });
    for (const cycle of [1, 2, 3]) {
        const execution = await client.executeQualityCycle(input.sessionId, cycle);
        assert.equal(execution.quality_evidence.cycle_index, cycle);
        await client.evaluateCompletion(input.sessionId, { quality_evidence: execution.quality_evidence });
        const recordedGate = store.derive().gates[`quality-cycle-${cycle}`];
        assert.equal(recordedGate?.status, 'PASSED', JSON.stringify(recordedGate));
    }
    const result = await client.evaluateCompletion(input.sessionId);
    assert.equal(result.verified, true, JSON.stringify(result.blockers));
    assert.equal(store.derive().sessionState, 'VERIFIED');
    assert.match(result.receipt?.receipt_sha256, /^[a-f0-9]{64}$/);
});

test('authority rejects a quality attestation when the explicit stored policy hash is inconsistent', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t);
    input.sessionId = crypto.randomUUID();
    const acceptancePolicy = {
        protocol_version: 1,
        checks: [],
        ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true },
    };
    const inconsistentPolicySha256 = 'f'.repeat(64);
    const { store } = seedAuthority(input, [], {
        workspaceId: crypto.createHash('sha256').update('mismatched policy workspace').digest('hex'),
        acceptancePolicy,
        acceptancePolicySha256: inconsistentPolicySha256,
    });
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker([]) }).runTask(store.derive());
    await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
    const derived = store.derive();
    assert.equal(derived.sessionState, 'ACCEPTANCE');

    const eventsBeforeAttestation = store.readEvents().length;
    assert.throws(() => store.append({
        schema_version: 2,
        type: 'quality.execution.attested',
        session_id: input.sessionId,
        workspace_id: derived.workspaceId,
        plan_revision: derived.planRevision,
        expected_baseline: derived.currentBaseline,
        execution_id: 'a'.repeat(64),
        artifact_sha256: 'b'.repeat(64),
        policy_sha256: inconsistentPolicySha256,
        diff_fingerprint: 'c'.repeat(64),
        cycle_index: 1,
        attempt: 1,
        total_tasks: 1,
        completed_task_ids: ['TASK-1'],
    }), (error) => error?.code === 'DUAL_INTEGRITY_CORRUPT' && /policy/i.test(error.message));
    assert.equal(store.readEvents().length, eventsBeforeAttestation,
        'an inconsistent explicit policy hash must reject before appending the attestation');
});

test('isolated runner prepares declared locked dependencies before invoking model and preserves receipt on resume', async (t) => {
    const input = fixture(t), calls = [];
    input.task.dependency_mode = 'npm-ci';
    fs.writeFileSync(path.join(input.workspaceRoot, 'package.json'), '{"name":"worker-fixture","version":"1.0.0"}');
    fs.writeFileSync(path.join(input.workspaceRoot, 'package-lock.json'), JSON.stringify({
        name: 'worker-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { name: 'worker-fixture', version: '1.0.0' } },
    }));
    const result = await runIsolatedTask({ ...input, worker: fakeWorker(calls) });
    assert.match(result.reference.workerDependencies?.receiptSha256 || '', /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, 'node_modules')), false);
    const resumed = await runIsolatedTask({ ...input, reference: result.reference, worker: fakeWorker(calls) });
    assert.equal(resumed.reference.workerDependencies.receiptSha256, result.reference.workerDependencies.receiptSha256);
    assert.equal(calls.length, 3);
    // Separate session identity avoids reusing the direct-run attempt above.
    const input2 = fixture(t);
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(input.workspaceRoot, file), path.join(input2.workspaceRoot, file));
    input2.task.dependency_mode = 'npm-ci';
    const { store: authority } = seedAuthority(input2);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input2.workspaceRoot, authorityStore: authority, worker: fakeWorker([]) });
    assert.equal((await adapter.runTask(authority.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.match(authority.derive().tasks['TASK-1'].isolatedWorkspace.reference.workerDependencies.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal((await adapter.runTask(authority.derive()))[0].status, 'AWAITING_CODEX_QC');
});

test('isolated contract header instructs unverified_items empty array and prompt templates are aligned', async (t) => {
    const input = fixture(t);
    const calls = [];
    await runIsolatedTask({
        ...input,
        worker: async (invocation, deps) => {
            if (invocation.args && invocation.args.includes('implement')) {
                const runDir = path.join(invocation.cwd, `.omni/codex-gemini/runs/${input.task.task_id}`);
                const inputMd = fs.readFileSync(path.join(runDir, 'raw/implement.1.input.md'), 'utf8');
                assert.match(inputMd, /unverified_items in evidence\.json MUST BE \[\]/);
            }
            return fakeWorker(calls)(invocation, deps);
        },
    });
    const implementTemplate = fs.readFileSync(path.resolve(__dirname, '../templates/codex-gemini/prompts/implement.md'), 'utf8');
    assert.doesNotMatch(implementTemplate, /tag them in `unverified_items` with `\[EXTERNAL_OPTIONAL\]`/);
    assert.match(implementTemplate, /`unverified_items` in `evidence\.json` MUST BE EXACTLY `\[\]`/);
    const reviewTemplate = fs.readFileSync(path.resolve(__dirname, '../templates/codex-gemini/prompts/review.md'), 'utf8');
    assert.doesNotMatch(reviewTemplate, /Unverified items tagged `\[EXTERNAL_OPTIONAL\]`.*do NOT block APPROVE/);
});

test('normalizeCommandString standardizes tool extensions and test aliases', () => {
    assert.equal(normalizeCommandString('npm.cmd run test'), 'npm test');
    assert.equal(normalizeCommandString('pnpm.exe run test'), 'pnpm test');
    assert.equal(normalizeCommandString('npx.bat vitest run'), 'npx vitest run');
    assert.equal(normalizeCommandString('node.exe --check file.js'), 'node --check file.js');
    assert.equal(normalizeCommandString('  yarn   run   test  '), 'yarn test');
});

test('isolated runner allows evidence with informational unverified_items when status is SUCCESS', async (t) => {
    const input = fixture(t);
    const calls = [];
    const handoff = await runIsolatedTask({
        ...input,
        worker: fakeWorker(calls, (payload) => {
            if (payload.status === 'SUCCESS') {
                return {
                    ...payload,
                    unverified_items: ['Manual smoke test in production environment not performed'],
                };
            }
            return payload;
        }),
    });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
});

test('isolated runner flexibly matches validation commands with npm run test / npm.cmd formatting', async (t) => {
    const input = fixture(t);
    input.task.validation_commands = [{ program: 'npm', args: ['test'], cwd: '.' }];
    const calls = [];
    const handoff = await runIsolatedTask({
        ...input,
        worker: fakeWorker(calls, (payload) => {
            if (payload.status === 'SUCCESS') {
                return {
                    ...payload,
                    command_outputs: [{ command: 'npm.cmd run test', exit_code: 0, output: 'all tests pass' }],
                };
            }
            return payload;
        }),
    });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
});

test('isolated authority QC automatically cleans untracked ephemeral tool caches without generated_outputs declaration', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const input = fixture(t), calls = [];
    input.task.generated_outputs = [];
    input.task.validation_commands = [{
        program: 'node',
        args: ['-e', 'require("fs").writeFileSync("tsconfig.tsbuildinfo", "cache"); require("fs").writeFileSync(".eslintcache", "cache");'],
        cwd: '.',
    }];
    const { store } = seedAuthority(input);
    const worker = fakeWorker(calls, (payload) => {
        if (payload.command_outputs) {
            payload.command_outputs = [{ command: `${input.task.validation_commands[0].program} ${input.task.validation_commands[0].args.join(' ')}`, exit_code: 0, output: '' }];
        }
        return payload;
    });
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker: worker }).runTask(store.derive());
    const request = { workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 };
    const complete = await completeIsolatedTask(request);
    assert.equal(complete.status, 'TASK_VERIFIED');
});

test('isolated runner scrubs ephemeral tool cache created during implement phase', async (t) => {
    const input = fixture(t);
    input.task.deny_patterns = [];
    const calls = [];
    const baseWorker = fakeWorker(calls);
    const handoff = await runIsolatedTask({
        ...input,
        worker: async (invocation, options) => {
            const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
            if (prompt && prompt.includes('implement phase')) {
                fs.writeFileSync(path.join(invocation.cwd, 'tsconfig.tsbuildinfo'), 'buildinfo cache');
            }
            return baseWorker(invocation, options);
        },
    });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.equal(handoff.result.changes.length, 1);
    assert.equal(handoff.result.changes[0].path, 'index.js');
    assert.equal(fs.existsSync(path.join(handoff.reference.workerRoot, 'tsconfig.tsbuildinfo')), false);
});

for (const [file, deny] of [
    ['forbidden/rogue.txt', 'forbidden/**'],
    ['dist/bundle.js', 'dist/**'],
    ['.eslintcache', '.eslintcache'],
]) {
    test(`isolated runner preserves and rejects denied output ${file}`, async (t) => {
        const input = fixture(t);
        input.task.deny_patterns = [deny];
        const baseWorker = fakeWorker([]);
        let target;
        await assert.rejects(() => runIsolatedTask({
            ...input,
            worker: async (invocation, options) => {
                const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
                if (prompt && prompt.includes('implement phase')) {
                    target = path.join(invocation.cwd, file);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, 'denied diagnostic evidence');
                }
                return baseWorker(invocation, options);
            },
        }), (error) => error.code === 'DUAL_DENY_PATTERN');
        assert.ok(target);
        assert.equal(fs.readFileSync(target, 'utf8'), 'denied diagnostic evidence');
        assert.equal(fs.existsSync(path.join(input.workspaceRoot, file)), false);
    });
}


test('enabled isolated discussion requires factory before any phase or seed', async (t) => {
    const input = fixture(t), calls = [];
    let prepared;
    await assert.rejects(() => runIsolatedTask({ ...input, discussion: { enabled: true }, worker: fakeWorker(calls),
        onPrepared(reference) { prepared = reference; } }),
        { code: 'DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED' });
    assert.equal(calls.length, 0);
    const events = path.join(prepared.workerRoot, '.omni/codex-gemini/runs/TASK-1/events.ndjson');
    assert.equal(fs.existsSync(events), false, 'missing factory is rejected before orchestrator phases');
});


test('discussion scout/review use separate execution transport and implement remains cold', async (t) => {
    const input = fixture(t), calls = [], worker = fakeWorker(calls);
    const discussion = discussionForWorker(worker);
    const result = await runIsolatedTask({ ...input, worker, discussion });
    assert.equal(result.status, 'AWAITING_CODEX_QC');
    assert.equal(calls.filter((call) => call.transport === 'discussion').length, 2);
    assert.equal(calls.filter((call) => call.transport !== 'discussion').length, 1);
    assert.deepEqual(discussion.counters.turns.map((turn) => turn.phase), ['scout', 'review']);
    assert.equal(discussion.counters.closes.length, 1);
    assert.ok(discussion.executions.every((execution) => execution.closed));
});

test('isolated discussion rejects authority reference root mismatch before seeds', async (t) => {
    const input = fixture(t), calls = [];
    const discussion = discussionForWorker(fakeWorker(calls));
    let reference;
    await assert.rejects(() => runIsolatedTask({ ...input, discussion,
        onPrepared(ref) { reference = ref; throw new Error('capture reference'); } }), /capture reference/);
    await assert.rejects(() => runIsolatedTask({ ...input, discussion,
        reference: { ...reference, workerRoot: input.workspaceRoot } }),
        { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
    assert.equal(discussion.counters.seeds.length, 0);
    assert.equal(calls.length, 0);
});

test('revocation between seeds prevents second seed and closes discussion child', async (t) => {
    const input = fixture(t), calls = [];
    let allowed = true;
    const discussion = discussionForWorker(fakeWorker(calls), { afterSeed() { allowed = false; } });
    await assert.rejects(() => runIsolatedTask({ ...input, discussion, authorize: () => allowed }),
        { code: 'DUAL_ISOLATED_UNAUTHORIZED' });
    assert.deepEqual(discussion.counters.seeds.map((seed) => seed.provider), ['codex']);
    assert.equal(discussion.counters.turns.length, 0);
    assert.equal(discussion.counters.closes.length, 1);
});

test('prespawn guard rejects internal nudge after controller context tampering', async (t) => {
    const input = fixture(t), calls = [];
    const discussion = discussionForWorker(fakeWorker(calls), { internalNudge: true,
        beforeNudge({ workerRoot }) {
            fs.writeFileSync(path.join(workerRoot, '.omni/codex-gemini/runs/TASK-1/controller-context.json'), 'forged');
        } });
    await assert.rejects(() => runIsolatedTask({ ...input, discussion }),
        { code: 'DUAL_ISOLATED_EVIDENCE_INVALID' });
    assert.equal(discussion.counters.turns.length, 1, 'nudge is denied before a second provider call');
    assert.equal(discussion.counters.closes.length, 1);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
});

test('NEEDS_CONTEXT closes execution and resume creates a new conversation generation', async (t) => {
    const input = fixture(t), calls = [];
    const worker = fakeWorker(calls, (payload) => payload.open_questions
        ? { ...payload, open_questions: ['Which value?'] } : payload);
    const discussion = discussionForWorker(worker);
    const waiting = await runIsolatedTask({ ...input, discussion, worker, operationId: 'operation-first' });
    assert.equal(waiting.status, 'NEEDS_CONTEXT');
    assert.equal(discussion.counters.closes.length, 1);
    const result = await runIsolatedTask({ ...input, discussion, worker, operationId: 'operation-second',
        reference: waiting.reference, expectedQuestions: ['Which value?'],
        controllerReplies: [{ question: 'Which value?', answer: 'Two' }] });
    assert.equal(result.status, 'AWAITING_CODEX_QC');
    assert.deepEqual(discussion.counters.turns.map(({ phase, executionId }) => [phase, executionId]),
        [['scout', 'operation-first'], ['review', 'operation-second']]);
    assert.equal(discussion.counters.seeds.length, 4);
    assert.notEqual(discussion.executions[0].bindings[0].conversation_id,
        discussion.executions[1].bindings[0].conversation_id);
    assert.equal(discussion.counters.closes.length, 2);
});


test('failed discussion child close leaves operation and lease unsettled for recovery', async (t) => {
    const input = fixture(t), { store } = seedAuthority(input), calls = [];
    const worker = fakeWorker(calls);
    const discussion = discussionForWorker(worker, { close() {
        throw Object.assign(new Error('child not quiescent'), { code: 'DUAL_DISCUSSION_CLOSE_UNPROVEN' });
    } });
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker, discussion });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => {
        assert.equal(error.code, 'DUAL_DISCUSSION_CLOSE_UNPROVEN');
        assert.equal(error.discussionQuiescent, false);
        return true;
    });
    assert.equal(store.readOperationRecords().some((record) => record.type === 'settled'), false);
    assert.equal(Object.values(store.derive().leases).some((lease) => lease.status === 'released'), false);
    assert.equal(store.readEvents().some((event) => event.type === 'task.workspace.handoff'), false);
});

for (const field of ['workerBaselineSha256', 'workerContractSha256', 'bindingSha256', 'workerRoot']) {
    test(`isolated discussion denies reference ${field} mismatch before factory or seeds`, async (t) => {
        const input = fixture(t), calls = [];
        const discussion = discussionForWorker(fakeWorker(calls));
        let reference;
        await assert.rejects(() => runIsolatedTask({ ...input, discussion,
            onPrepared(ref) { reference = ref; throw new Error('capture reference'); } }), /capture reference/);
        const value = field === 'workerRoot' ? path.join(input.workspaceRoot, 'nonexistent-worker') : 'f'.repeat(64);
        await assert.rejects(() => runIsolatedTask({ ...input, discussion, reference: { ...reference, [field]: value } }),
            { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
        assert.equal(discussion.executions.length, 0, 'identity must be checked before factory acquisition');
        assert.equal(discussion.counters.seeds.length, 0);
        assert.equal(discussion.counters.turns.length, 0);
        assert.equal(calls.length, 0);
    });
}

// Context recovery regressions use the real authority journal and daemon transport.
async function contextFixture(t, hooks = {}) {
    const input = fixture(t), calls = [];
    const { store, dir } = seedAuthority(input);
    const worker = fakeWorker(calls, (payload) => payload.open_questions
        ? { ...payload, open_questions: ['Which value is required?'] } : payload);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker });
    await adapter.runTask(store.derive());
    const question = store.derive().tasks['TASK-1'].messages[0];
    const daemon = await startDaemonServer({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        orchestrator: { runTask: async (...args) => { await hooks.beforeRun?.(); return adapter.runTask(...args); } } });
    t.after(() => daemon.close());
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    const client = createDaemonClient({ workspaceRoot: input.workspaceRoot, timeoutMs: 5000 });
    const reply = { task_id: 'TASK-1', plan_revision: 1, message_id: 'context-reply', reply_to: question.message_id, body: 'Return 2.' };
    return { input, calls, store, dir, adapter, daemon, client, reply };
}
async function waitContext(predicate) {
    const until = Date.now() + 5000;
    while (!await predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await predicate(), 'context continuation did not settle');
}
test('context park persists lineage and manual resume retains attempt while unanswered', async (t) => {
    const f = await contextFixture(t);
    const task = createAuthorityStore(f.dir).derive().tasks['TASK-1'];
    assert.deepEqual(task.waitingContext.question_ids, [f.reply.reply_to]);
    assert.equal(task.waitingContext.attempt, 1);
    assert.equal(task.waitingContext.session_id, f.input.sessionId);
    await f.client.resumeSession(f.input.sessionId);
    await waitContext(async () => (await f.client.status(f.input.sessionId)).worker_start?.state === 'waiting_context');
    assert.equal(f.calls.length, 1);
});
test('late reply triggers dispatch exactly once and duplicate reply is journal-idempotent', async (t) => {
    const f = await contextFixture(t);
    await f.client.replyToTask(f.input.sessionId, f.reply);
    await f.client.replyToTask(f.input.sessionId, f.reply);
    await waitContext(() => !!f.store.derive().tasks['TASK-1'].isolatedHandoff);
    assert.equal(f.calls.length, 3);
    assert.equal(f.store.readEvents().filter((e) => e.type === 'task.message' && e.message_id === f.reply.message_id).length, 1);
    assert.equal(f.store.readEvents().filter((e) => e.type === 'task.context.dispatch.claimed').length, 1);
});
test('restart reconciles a crash after reply commit before dispatch without repeating implementation', async (t) => {
    const f = await contextFixture(t);
    await f.daemon.close();
    const { postTaskMessage } = require('../lib/dual/task-messages');
    postTaskMessage({ authorityStore: f.store, sessionId: f.input.sessionId, planRevision: 1,
        taskId: 'TASK-1', messageId: f.reply.message_id, kind: 'reply', body: f.reply.body, replyTo: f.reply.reply_to });
    const restarted = await startDaemonServer({ workspaceRoot: f.input.workspaceRoot,
        authorityStore: createAuthorityStore(f.dir), orchestrator: f.adapter });
    t.after(() => restarted.close());
    await waitContext(() => !!f.store.derive().tasks['TASK-1'].isolatedHandoff);
    assert.equal(f.calls.length, 3);
    await restarted.close();
    const again = await startDaemonServer({ workspaceRoot: f.input.workspaceRoot, authorityStore: f.store, orchestrator: f.adapter });
    t.after(() => again.close());
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 3, 'handoff is a QC checkpoint, never another implementation');
});
test('reply while worker exits is committed before lease release and wakeup is retained', async (t) => {
    const input = fixture(t), calls = [];
    const { store } = seedAuthority(input);
    const { postTaskMessage } = require('../lib/dual/task-messages');
    const worker = fakeWorker(calls, (payload) => payload.open_questions ? { ...payload, open_questions: ['Value?'] } : payload);
    const append = store.append.bind(store);
    let replied = false;
    store.append = (event) => {
        const result = append(event);
        if (event.type === 'task.questions' && !replied) {
            replied = true;
            postTaskMessage({ authorityStore: store, sessionId: input.sessionId, planRevision: 1,
                taskId: 'TASK-1', messageId: 'exit-reply', kind: 'reply', body: '2', replyTo: event.questions[0].message_id });
        }
        return result;
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, worker });
    const daemon = await startDaemonServer({ workspaceRoot: input.workspaceRoot, authorityStore: store, orchestrator: adapter });
    t.after(() => daemon.close());
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    await createDaemonClient({ workspaceRoot: input.workspaceRoot, timeoutMs: 5000 }).resumeSession(input.sessionId);
    await waitContext(() => !!store.derive().tasks['TASK-1'].isolatedHandoff);
    assert.equal(calls.length, 3);
});
test('answered reply only evaluates readiness; NEEDS_CONTEXT parks again without a dispatch loop', async (t) => {
    const f = await contextFixture(t);
    await f.daemon.close();
    let evaluations = 0;
    const daemon = await startDaemonServer({ workspaceRoot: f.input.workspaceRoot, authorityStore: f.store,
        orchestrator: { async runTask() { evaluations++; return [{ taskId: 'TASK-1', status: 'NEEDS_CONTEXT' }]; } } });
    t.after(() => daemon.close());
    await f.client.replyToTask(f.input.sessionId, f.reply);
    await waitContext(() => f.store.derive().tasks['TASK-1'].contextDispatch?.status === 'waiting_context');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(evaluations, 1);
    assert.equal(f.calls.length, 1, 'readiness does not authorize implementation or invent context');
});
test('restart abandons a dead pre-execution context claim and dispatches once', async (t) => {
    const f = await contextFixture(t);
    await f.daemon.close();
    const { postTaskMessage } = require('../lib/dual/task-messages');
    postTaskMessage({ authorityStore: f.store, sessionId: f.input.sessionId, planRevision: 1, taskId: 'TASK-1',
        messageId: f.reply.message_id, kind: 'reply', body: f.reply.body, replyTo: f.reply.reply_to });
    const executionId = crypto.randomUUID();
    f.store.append({ schema_version: 2, type: 'task.context.dispatch.claimed', task_id: 'TASK-1', execution_id: executionId,
        controller_pid: 2147483647, attempt: 1, reply_ids: [f.reply.message_id] });
    const restarted = await startDaemonServer({ workspaceRoot: f.input.workspaceRoot, authorityStore: f.store, orchestrator: f.adapter });
    t.after(() => restarted.close());
    await waitContext(() => !!f.store.derive().tasks['TASK-1'].isolatedHandoff);
    assert.equal(f.calls.length, 3);
    assert.ok(f.store.readEvents().some((e) => e.execution_id === executionId && e.status === 'abandoned'));
});
test('stale context lineage and simultaneous durable claims are rejected without journal changes', async (t) => {
    const f = await contextFixture(t);
    await f.daemon.close();
    const { postTaskMessage } = require('../lib/dual/task-messages');
    assert.throws(() => postTaskMessage({ authorityStore: f.store, sessionId: f.input.sessionId, planRevision: 2,
        taskId: 'TASK-1', messageId: 'stale', kind: 'reply', body: '2', replyTo: f.reply.reply_to }), { code: 'DUAL_MESSAGE_STALE' });
    postTaskMessage({ authorityStore: f.store, sessionId: f.input.sessionId, planRevision: 1, taskId: 'TASK-1',
        messageId: f.reply.message_id, kind: 'reply', body: f.reply.body, replyTo: f.reply.reply_to });
    const claim = { schema_version: 2, type: 'task.context.dispatch.claimed', task_id: 'TASK-1', execution_id: crypto.randomUUID(),
        controller_pid: process.pid, attempt: 1, reply_ids: [f.reply.message_id] };
    assert.throws(() => f.store.append({ ...claim, attempt: 2 }));
    f.store.append(claim);
    const before = f.store.verifyIntegrity().lastHash;
    assert.throws(() => f.store.append({ ...claim, execution_id: crypto.randomUUID() }));
    assert.equal(f.store.verifyIntegrity().lastHash, before);
});
test('manual resume cannot turn an insufficient-context evaluation into implementation', async (t) => {
    const f = await contextFixture(t);
    await f.daemon.close();
    let evaluations = 0;
    const daemon = await startDaemonServer({ workspaceRoot: f.input.workspaceRoot, authorityStore: f.store,
        orchestrator: { async runTask() { evaluations++; return [{ taskId: 'TASK-1', status: 'NEEDS_CONTEXT' }]; } } });
    t.after(() => daemon.close());
    await f.client.replyToTask(f.input.sessionId, f.reply);
    await waitContext(() => f.store.derive().tasks['TASK-1'].contextDispatch?.status === 'waiting_context');
    await f.client.resumeSession(f.input.sessionId);
    await waitContext(async () => (await f.client.status(f.input.sessionId)).worker_start?.state === 'waiting_context');
    assert.equal(evaluations, 1);
});
test('daemon recovery API requires finite config and refuses caller-supplied failure classification', async (t) => {
    const f = await contextFixture(t);
    const lineage = { session_id: f.input.sessionId, task_id: 'TASK-1', plan_revision: 1 };
    await assert.rejects(() => f.client.request('task.recovery.configure', lineage));
    const configured = await f.client.request('task.recovery.configure', { ...lineage, harness_limit: 1, total_limit: 3 });
    assert.equal(configured.acknowledged, true);
    await assert.rejects(() => f.client.request('task.failure.classify', { ...lineage, category: 'harness' }));
    await assert.rejects(() => f.client.request('task.recovery.grant', { ...lineage, grant_id: 'fake', expected_attempt: 1 }));
    assert.equal(f.store.derive().tasks['TASK-1'].recoveryPolicy.worker_limit, 2);
});

for (const scenario of ['pass', 'exit', 'missing-block', 'false-test', 'evidence-missing', 'evidence-unknown', 'path-escape']) {
    test(`layered isolated QC: ${scenario}`, async (t) => {
        const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
        const input = fixture(t);
        const tests = [{ name: 'cart', passed: scenario !== 'false-test' }];
        const stdout = scenario === 'missing-block' ? 'no results' :
            `---QC-BEHAVIOR-RESULTS-BEGIN---\n${JSON.stringify({ tests })}\n---QC-BEHAVIOR-RESULTS-END---`;
        input.task.behavior_commands = [{ program: 'node', args: ['-e',
            `console.log(${JSON.stringify(stdout)});process.exit(${scenario === 'exit' ? 1 : 0})`], cwd: '.' }];
        input.task.qc_evidence = { requirements_path: 'requirements.json', evidence_path: 'mapping.json' };
        fs.writeFileSync(path.join(input.workspaceRoot, 'requirements.json'), JSON.stringify({ requirements: [{ id: 'R1', text: 'Cart works' }] }));
        fs.writeFileSync(path.join(input.workspaceRoot, 'mapping.json'), JSON.stringify({ entries:
            scenario === 'evidence-missing' ? [] : [{ requirement_id: scenario === 'evidence-unknown' ? 'R2' : 'R1', tests: ['cart'] }] }));
        input.task.context_files.push('requirements.json', 'mapping.json');
        const { store } = seedAuthority(input);
        await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
            worker: fakeWorker([]) }).runTask(store.derive());
        if (scenario === 'path-escape') {
            // Simulate a legacy/malformed task bypassing the registration schema.
            const derive = store.derive.bind(store);
            store.derive = () => {
                const state = derive();
                state.tasks['TASK-1'].qc_evidence.requirements_path = '../outside.json';
                return state;
            };
            // The immutable contract binding must reject this before any file read.
            await assert.rejects(() => completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
                sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 }), { code: 'DUAL_ISOLATED_AUTHORITY_STALE' });
            return;
        }
        const result = await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
            sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
        assert.equal(result.status, scenario === 'pass' ? 'TASK_VERIFIED' : 'NEEDS_FIX', JSON.stringify(result));
        assert.equal(result.qcLayers.checker.passed, true);
        assert.equal(result.qcLayers.passed, scenario === 'pass');
        if (scenario === 'pass') {
            const retry = await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
                sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
            assert.equal(retry.alreadyVerified, true);
            assert.deepEqual(retry.qcLayers, result.qcLayers);
        } else {
            const code = ['exit', 'missing-block', 'false-test'].includes(scenario) ? 'DUAL_QC_BEHAVIOR_FAILED' : 'DUAL_QC_EVIDENCE_FAILED';
            assert.equal(result.code, code);
            assert.equal(store.derive().tasks['TASK-1'].lastOutcome.code, code);
            assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
        }
    });
}

test('turn watchdog aborts a stalled discussion, preserves artifacts and closes execution', async (t) => {
    const input = fixture(t);
    let reference, workerSignal, marker, nudges = 0;
    const discussion = createDiscussionStub({
        async beforeTurn(context) {
            workerSignal = context.signal;
            marker = path.join(context.workerRoot, 'index.js');
            fs.writeFileSync(marker, 'module.exports = 42;\n');
            await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
            context.signal.throwIfAborted();
        },
    });
    await assert.rejects(runRealIsolatedTask({ ...input, discussion,
        onPrepared(saved) { reference = saved; }, onTurnNudge() { nudges++; },
        turnSafety: { softMs: 2000, hardMs: 4000, heartbeatMs: 10, noProgressMs: 30, graceMs: 20, pollMs: 5 },
    }), (error) => error.code === 'DUAL_TURN_STALLED' && error.status === 'STALLED');
    assert.equal(workerSignal.aborted, true);
    assert.equal(nudges, 1);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'module.exports = 42;\n');
    const attemptDir = path.dirname(path.join(input.workspaceRoot, reference.bindingPath));
    const events = fs.readFileSync(path.join(attemptDir, 'turn-progress.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((event) => event.type === 'nudge').length, 1);
    assert.equal(events.filter((event) => event.type === 'STALLED').length, 1);
    assert.ok(events.some((event) => event.type === 'heartbeat'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(attemptDir, 'last-activity.json'))).type, 'STALLED');
    assert.ok(fs.existsSync(path.join(attemptDir, 'worker-contract.json')));
    assert.equal(discussion.counters.closes.length, 1);
    assert.equal(discussion.counters.turns.length, 0);
});

test('turn zero-evidence fail-fast immediately aborts with DUAL_NO_WRITE_PROGRESS and no nudge', async (t) => {
    const input = fixture(t);
    let reference, workerSignal, nudges = 0;
    const discussion = createDiscussionStub({
        async beforeTurn(context) {
            workerSignal = context.signal;
            // Zero-evidence: worker does not modify any files
            await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
            context.signal.throwIfAborted();
        },
    });
    await assert.rejects(runRealIsolatedTask({ ...input, discussion,
        onPrepared(saved) { reference = saved; }, onTurnNudge() { nudges++; },
        turnSafety: { softMs: 2000, hardMs: 4000, heartbeatMs: 10, noProgressMs: 30, graceMs: 20, pollMs: 5 },
    }), (error) => error.code === 'DUAL_NO_WRITE_PROGRESS' && error.status === 'NO_WRITE_PROGRESS' && error.turn.reason === 'no_evidence');
    assert.equal(workerSignal.aborted, true);
    assert.equal(nudges, 0);
    const attemptDir = path.dirname(path.join(input.workspaceRoot, reference.bindingPath));
    const events = fs.readFileSync(path.join(attemptDir, 'turn-progress.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((event) => event.type === 'nudge').length, 0);
    assert.equal(events.filter((event) => event.type === 'STALLED').length, 0);
    assert.equal(events.filter((event) => event.type === 'NO_WRITE_PROGRESS').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(attemptDir, 'last-activity.json'))).type, 'NO_WRITE_PROGRESS');
    assert.ok(fs.existsSync(path.join(attemptDir, 'worker-contract.json')));
    assert.equal(discussion.counters.closes.length, 1);
    assert.equal(discussion.counters.turns.length, 0);
});

test('hard turn budget stops a progressing worker and preserves its evidence', async (t) => {
    const input = fixture(t);
    let reference;
    const discussion = createDiscussionStub({
        async beforeTurn(context) {
            const output = path.join(context.workerRoot, 'index.js');
            const timer = setInterval(() => fs.appendFileSync(output, '// progress\n'), 5);
            try {
                await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
                context.signal.throwIfAborted();
            } finally { clearInterval(timer); }
        },
    });
    await assert.rejects(runRealIsolatedTask({ ...input, discussion, onPrepared(saved) { reference = saved; },
        turnSafety: { softMs: 100, hardMs: 300, heartbeatMs: 10, noProgressMs: 1000, graceMs: 20, pollMs: 5 },
    }), (error) => error.code === 'DUAL_TURN_STALLED' && error.turn.reason === 'hard_budget');
    const attemptDir = path.dirname(path.join(input.workspaceRoot, reference.bindingPath));
    const events = fs.readFileSync(path.join(attemptDir, 'turn-progress.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((event) => event.type === 'soft-budget-warning' && event.phase === 'scout').length, 1);
    assert.equal(events.filter((event) => event.type === 'nudge').length, 0);
    assert.equal(events.at(-1).type, 'STALLED');
});

test('authority settles stalled turn, releases lease and never classifies it as kill recovery', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const discussion = createDiscussionStub({ async beforeTurn(context) {
        fs.writeFileSync(path.join(context.workerRoot, 'index.js'), '// partial milestone\n');
        await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
        context.signal.throwIfAborted();
    } });
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, discussion,
        turnSafety: { softMs: 2000, hardMs: 4000, heartbeatMs: 10, noProgressMs: 30, graceMs: 20, pollMs: 5 } });
    await assert.rejects(adapter.runTask(store.derive()), { code: 'DUAL_TURN_STALLED' });
    const derived = store.derive(), task = derived.tasks['TASK-1'];
    assert.equal(task.lastOutcome.code, 'DUAL_TURN_STALLED');
    assert.equal(task.lastOutcome.status, 'FAILED');
    assert.equal(require('../lib/dual/isolated-authority').resolveKillDiscussionRecovery(input.workspaceRoot, task), null);
    assert.ok(Object.values(derived.leases).every((lease) => lease.status === 'released'));
    assert.equal(task.isolatedHandoff, undefined);
    assert.equal(discussion.executions.length, 1);
    const root = discussion.executions[0].workerRoot;
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), '// partial milestone\n');
});

test('progressing implement emits heartbeats and completes without watchdog intervention', async (t) => {
    const input = fixture(t), worker = fakeWorker([]);
    let reference;
    const handoff = await runIsolatedTask({ ...input, onPrepared(saved) { reference = saved; },
        turnSafety: { softMs: 1000, hardMs: 2000, heartbeatMs: 10, noProgressMs: 100, graceMs: 100, pollMs: 5 },
        worker: async (invocation, deps) => {
            if (invocation.args.some((arg) => arg.includes('implement phase'))) {
                const file = path.join(invocation.cwd, 'index.js');
                const timer = setInterval(() => fs.appendFileSync(file, '// progress\n'), 10);
                try { await new Promise((resolve) => setTimeout(resolve, 150)); }
                finally { clearInterval(timer); }
            }
            return worker(invocation, deps);
        },
    });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    const attemptDir = path.dirname(path.join(input.workspaceRoot, reference.bindingPath));
    const events = fs.readFileSync(path.join(attemptDir, 'turn-progress.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some((event) => event.phase === 'implement' && event.type === 'heartbeat'));
    assert.ok(events.some((event) => event.phase === 'implement' && event.type === 'turn-complete'));
    assert.equal(events.some((event) => ['STALLED', 'nudge'].includes(event.type)), false);
});
