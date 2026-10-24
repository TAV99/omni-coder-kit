'use strict';

const { withDiscussion } = require('./helpers/dual-discussion-stub');

function createOrchestratorAdapter(options) {
    return createOrchestratorAdapterImpl(withDiscussion(options));
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createAuthorityStore, canonicalizeEvent } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter: createOrchestratorAdapterImpl } = require('../lib/dual/orchestrator-adapter');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
const { hashAcceptancePolicy } = require('../lib/dual/acceptance-policy');
const { requestTaskCorrection } = require('../lib/dual/task-correction');

// This getter makes the initial RED assert the missing service explicitly.
function reject(input) {
    const servicePath = '../lib/dual/handoff-rejection';
    const service = fs.existsSync(path.join(__dirname, servicePath + '.js')) ? require(servicePath) : {};
    assert.equal(typeof service.rejectTaskHandoff, 'function', 'rejectTaskHandoff must be exported');
    return service.rejectTaskHandoff(input);
}

async function fixture(t, { newSource = false } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-handoff-reject-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (!newSource) fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');
    const dir = path.join(root, '.omni/runs/dual-authority');
    let clockMs = Date.now();
    const clock = () => new Date(clockMs);
    const store = createAuthorityStore(dir, { clock });
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const command = { program: 'node', args: ['--check', 'index.js'], cwd: '.' };
    const policy = { protocol_version: 1, checks: [
        { id: 'syntax', requirement_id: 'R1', task_id: 'TASK-1', phase: 'pre_integration', kind: 'command', required: true, command },
        { id: 'session-review', requirement_id: 'R2', phase: 'session', kind: 'review', required: true },
    ] };
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-1', plan_revision: 1, expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: 'session-1', workspaceId: 'workspace-test', workspaceRoot: root,
        identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.8-flash-high' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        acceptance_policy: policy, acceptance_policy_sha256: hashAcceptancePolicy(policy),
        tasks: [{ task_id: 'TASK-1', title: 'Return two', goal: 'Return two', owner: 'agy', risk: 'low',
            execution_mode: 'isolated', allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [],
            validation_commands: [command] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['index.js'], model: 'gemini-3.8-flash-high', effort: 'high', reason: 'Private task' });
    const processRunner = async (invocation) => {
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1');
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: 'TASK-1', expected_baseline: spec.expected_baseline };
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
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: root, authorityStore: store, processRunner });
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'AWAITING_CODEX_QC');
    const task = store.derive().tasks['TASK-1'];
    // The pinned reference resolves the actual private root, without assuming its layout.
    const { readTaskBinding } = require('../lib/dual/task-workspace');
    const bound = readTaskBinding(root, task.isolatedWorkspace.reference);
    assert.equal(spawnSync(process.execPath, ['--check', 'index.js'], { cwd: bound.workerRoot, windowsHide: true }).status, 0);
    const input = { workspaceRoot: root, authorityStore: store, session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1,
        expected_attempt: 1, request_id: 'reject-1', expected_handoff_sha256: task.isolatedHandoff.handoff_sha256,
        expected_result_sha256: task.isolatedHandoff.result_sha256,
        findings: [{ id: 'F1', file: 'index.js', line: 1, requirement_id: 'R1', description: 'The result does not meet the product requirement.' }] };
    return { root, dir, store, task, input, adapter, workerRoot: bound.workerRoot, advance(ms) { clockMs += ms; }, clock };
}

function preserved(f) {
    const files = new Map();
    function visit(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name), relative = path.relative(f.root, full).replace(/\\/g, '/');
            if (relative.startsWith('.omni/runs/dual-authority/')) continue;
            if (entry.isDirectory()) visit(full);
            else if (entry.isFile()) files.set(relative, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
        }
    }
    visit(f.root);
    return files;
}

function unchanged(f, input, code) {
    const events = fs.readFileSync(path.join(f.dir, 'events.ndjson'));
    const files = preserved(f);
    assert.throws(() => reject(input), (error) => code ? error.code === code : /^DUAL_/.test(error.code), code);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.ndjson')), events);
    assert.deepEqual(preserved(f), files);
}

function rejectionEvent(f, changes = {}) {
    const { workspaceRoot, authorityStore, ...input } = f.input;
    return { schema_version: 2, type: 'task.handoff.rejected', task_id: input.task_id,
        request_id: input.request_id, request_sha256: crypto.createHash('sha256').update(canonicalizeEvent(input)).digest('hex'),
        attempt: input.expected_attempt, binding_sha256: f.task.isolatedWorkspace.reference.bindingSha256,
        handoff_sha256: input.expected_handoff_sha256, result_sha256: input.expected_result_sha256,
        findings: input.findings, ...changes };
}

test('released passing handoff can receive durable controller rejection without integrating or changing artifacts', async (t) => {
    const f = await fixture(t), before = preserved(f), count = f.store.readEvents().length;
    assert.equal(Object.values(f.store.derive().leases).every((lease) => lease.status === 'released'), true);
    assert.deepEqual(reject(f.input), { acknowledged: true, reused: false, task_id: 'TASK-1', attempt: 1, status: 'NEEDS_FIX' });
    const task = f.store.derive().tasks['TASK-1'];
    assert.deepEqual(task.isolatedHandoff, f.task.isolatedHandoff);
    assert.equal(task.state, 'ROUTED');
    assert.equal(task.lastOutcome.status, 'NEEDS_FIX');
    assert.equal(task.lastOutcome.code, 'DUAL_CONTROLLER_REVIEW_REJECTED');
    assert.deepEqual(task.handoffRejection.findings, f.input.findings);
    assert.equal(f.store.readEvents().length, count + 1);
    assert.equal(f.store.readEvents().at(-1).type, 'task.handoff.rejected');
    assert.equal(f.store.readEvents().some((event) => event.type === 'gate.result' || event.type === 'task.completed'), false);
    assert.deepEqual(preserved(f), before);
    const reopened = createAuthorityStore(f.dir, { clock: f.clock });
    assert.deepEqual(reopened.derive().tasks['TASK-1'].lastOutcome, task.lastOutcome);
    assert.deepEqual(reject({ ...f.input, authorityStore: reopened }), { acknowledged: true, reused: true, task_id: 'TASK-1', attempt: 1, status: 'NEEDS_FIX' });
    assert.equal(reopened.readEvents().length, count + 1);
});

test('strict rejection input refuses stale identities, attempts, hashes, scope and unbounded findings without writes', async (t) => {
    const f = await fixture(t);
    for (const changed of [
        { session_id: 'other' }, { plan_revision: 2 }, { expected_attempt: 2 }, { expected_attempt: 0 }, { expected_attempt: 4 },
        { expected_handoff_sha256: 'a'.repeat(64) }, { expected_result_sha256: 'b'.repeat(64) }, { task_id: 'other' },
        { findings: [] }, { findings: Array(33).fill(f.input.findings[0]) },
        ...[{ file: 'spec.md' }, { file: './index.js' }, { line: 0 }, { description: '' }, { description: ' '.repeat(8) },
            { description: 'x'.repeat(2049) }, { requirement_id: '' }, { override: true }]
            .map((finding) => ({ findings: [{ ...f.input.findings[0], ...finding }] })),
        { token: 'forged' }, { code: 'PASS' }, { pid: 123 }, { scope: ['spec.md'] }, { validators: [] }, { request_id: '' },
        { findings: Array.from({ length: 32 }, (_, i) => ({ ...f.input.findings[0], id: `F${i}`, description: 'x'.repeat(2048) })) },
    ]) unchanged(f, { ...f.input, ...changed });
});

test('rejection detects tampered worker bytes and handoff bytes before appending', async (t) => {
    for (const file of ['handoff', 'worker', 'binding', 'artifact']) {
        const f = await fixture(t);
        const target = file === 'worker' ? path.join(f.workerRoot, 'index.js')
            : file === 'handoff' ? path.join(f.root, f.task.isolatedHandoff.handoff_path)
                : file === 'binding' ? path.join(f.root, f.task.isolatedWorkspace.reference.bindingPath)
                    : path.join(f.workerRoot, '.omni/codex-gemini/runs/TASK-1/evidence.json');
        fs.appendFileSync(target, '\n ');
        fs.writeFileSync(path.join(f.workerRoot, '.eslintcache'), 'preserved private cache');
        unchanged(f, f.input);
    }
});

test('controller rejection preserves newly generated ephemeral evidence without hidden cleanup', async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.workerRoot, '.eslintcache'), 'preserved private cache');
    fs.mkdirSync(path.join(f.workerRoot, 'coverage'));
    fs.writeFileSync(path.join(f.workerRoot, 'coverage/lcov.info'), 'TN:');
    fs.mkdirSync(path.join(f.workerRoot, 'empty-private-directory'));
    const before = preserved(f), count = f.store.readEvents().length;
    assert.equal(reject(f.input).status, 'NEEDS_FIX');
    assert.deepEqual(preserved(f), before);
    assert.equal(fs.existsSync(path.join(f.workerRoot, 'empty-private-directory')), true);
    assert.equal(f.store.readEvents().length, count + 1);
    assert.equal(f.store.readEvents().at(-1).type, 'task.handoff.rejected');
});

test('unreleased active and expired leases prevent controller rejection without lease fabrication', async (t) => {
    const f = await fixture(t);
    f.store.acquireLease('TASK-1', 'codex', { ttlMs: 1000 });
    unchanged(f, f.input, 'DUAL_HANDOFF_REJECTION_UNSAFE');
    f.advance(1001);
    unchanged(f, f.input, 'DUAL_HANDOFF_REJECTION_UNSAFE');
});

test('terminal session, integration journal and receipt prevent rejection without writes', async (t) => {
    for (const blockedBy of ['blocked', 'journal', 'receipt']) {
        const f = await fixture(t);
        if (blockedBy === 'blocked') f.store.append({ schema_version: 2, type: 'session.blocked', from_state: 'EXECUTING', to_state: 'BLOCKED',
            reason: 'Terminal test', blocker_code: 'TEST_BLOCKED' });
        else fs.writeFileSync(path.join(f.root, path.posix.dirname(f.task.isolatedWorkspace.reference.bindingPath),
            `${blockedBy === 'journal' ? 'integration' : 'integrated'}-${f.input.expected_result_sha256}.json`), '{}');
        unchanged(f, f.input, 'DUAL_HANDOFF_REJECTION_UNSAFE');
    }
});

test('canonical replay is stable after correction and conflicting request IDs cannot reject a new attempt', async (t) => {
    const f = await fixture(t);
    reject(f.input);
    const rearranged = { ...f.input, findings: [{ description: f.input.findings[0].description, requirement_id: 'R1', line: 1, file: 'index.js', id: 'F1' }] };
    assert.equal(reject(rearranged).reused, true);
    unchanged(f, { ...f.input, findings: [{ ...f.input.findings[0], description: 'Different finding' }] }, 'DUAL_HANDOFF_REJECTION_CONFLICT');
    requestTaskCorrection({ workspaceRoot: f.root, authorityStore: f.store, sessionId: 'session-1', planRevision: 1,
        taskId: 'TASK-1', requestId: 'correct-1', expectedAttempt: 1, reason: 'Address F1' });
    const before = f.store.readEvents().length;
    assert.equal(reject(f.input).reused, true);
    assert.equal(f.store.readEvents().length, before);
    assert.equal(f.store.derive().tasks['TASK-1'].correction.attempt, 2);
    assert.equal(f.store.derive().tasks['TASK-1'].previousAttempts[0].handoffRejection.request_id, 'reject-1');
    unchanged(f, { ...f.input, expected_attempt: 2 }, 'DUAL_HANDOFF_REJECTION_CONFLICT');
    unchanged(f, { ...f.input, request_id: 'reject-pending' }, 'DUAL_HANDOFF_REJECTION_UNSAFE');
});

test('reducer rejects forged rejection binding, payload hash, findings and active lease at append boundary', async (t) => {
    const f = await fixture(t);
    for (const change of [
        { binding_sha256: 'a'.repeat(64) }, { handoff_sha256: 'a'.repeat(64) }, { result_sha256: 'a'.repeat(64) },
        { attempt: 2 }, { request_sha256: 'a'.repeat(64) }, { findings: [{ ...f.input.findings[0], file: 'spec.md' }] },
        { findings: [{ ...f.input.findings[0], line: 0 }] }, { caller_code: 'PASSED' },
    ]) {
        const before = fs.readFileSync(path.join(f.dir, 'events.ndjson'));
        assert.throws(() => f.store.append(rejectionEvent(f, change)), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
        assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.ndjson')), before);
    }
    f.store.acquireLease('TASK-1', 'codex', { ttlMs: 1000 });
    for (const expired of [false, true]) {
        if (expired) f.advance(1001);
        const before = fs.readFileSync(path.join(f.dir, 'events.ndjson'));
        assert.throws(() => f.store.append(rejectionEvent(f)), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
        assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.ndjson')), before);
    }
});

test('QC lease winning immediately before rejection append prevents the negative event', async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.workerRoot, '.eslintcache'), 'preserved on append refusal');
    const files = preserved(f);
    const append = f.store.append;
    f.store.append = (event) => {
        if (event.type === 'task.handoff.rejected') f.store.acquireLease('TASK-1', 'codex', { ttlMs: 1000 });
        return append(event);
    };
    assert.throws(() => reject(f.input), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
    assert.equal(f.store.readEvents().some((event) => event.type === 'task.handoff.rejected'), false);
    assert.equal(f.store.derive().tasks['TASK-1'].lastOutcome, undefined);
    assert.deepEqual(preserved(f), files);
});

test('already integrated verified task and blocked ledger refuse negative authority events', async (t) => {
    const f = await fixture(t);
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    assert.equal((await completeIsolatedTask({ workspaceRoot: f.root, authorityStore: f.store,
        sessionId: 'session-1', taskId: 'TASK-1', planRevision: 1 })).status, 'TASK_VERIFIED');
    unchanged(f, f.input, 'DUAL_HANDOFF_REJECTION_UNSAFE');
    assert.throws(() => f.store.append(rejectionEvent(f)), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
    const blocked = await fixture(t);
    blocked.store.append({ schema_version: 2, type: 'session.blocked', from_state: 'EXECUTING', to_state: 'BLOCKED',
        reason: 'Terminal test', blocker_code: 'TEST_BLOCKED' });
    assert.throws(() => blocked.store.append(rejectionEvent(blocked)), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
});

test('new rejection IDs cannot overwrite a durable veto and reducer replay preserves earlier request history', async (t) => {
    const f = await fixture(t);
    reject(f.input);
    unchanged(f, { ...f.input, request_id: 'second-rejection' }, 'DUAL_HANDOFF_REJECTION_UNSAFE');
    assert.throws(() => f.store.append(rejectionEvent(f)), (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
    const events = f.store.readEvents().length;
    const state = createAuthorityStore(f.dir, { clock: f.clock }).derive();
    assert.equal(state.tasks['TASK-1'].handoffRejection.request_id, 'reject-1');
    assert.equal(f.store.readEvents().length, events);
});

function qcInput(f) {
    return { workspaceRoot: f.root, authorityStore: f.store, sessionId: 'session-1', taskId: 'TASK-1', planRevision: 1 };
}

function barrier() {
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    return { entered, release, async wait() { enter(); await released; } };
}

// Hold the real asynchronous handoff reader at its return boundary. The QC
// module captures this wrapper; all evidence measurement still runs normally.
function qcPausedAfterHandoff(t, pause) {
    const authority = require('../lib/dual/isolated-authority');
    const read = authority.readAuthorityHandoffAsync;
    const modulePath = require.resolve('../lib/dual/isolated-qc');
    const cached = require.cache[modulePath];
    const wrapped = t.mock.method(authority, 'readAuthorityHandoffAsync', async (...args) => {
        const handoff = await read(...args);
        await pause.wait();
        return handoff;
    });
    delete require.cache[modulePath];
    const { completeIsolatedTask } = require(modulePath);
    wrapped.mock.restore();
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
    t.after(pause.release);
    return completeIsolatedTask;
}

test('durable rejection refuses QC before any lease, execution, validator or integration side effect', async (t) => {
    const f = await fixture(t, { newSource: true });
    assert.equal(fs.existsSync(path.join(f.root, 'index.js')), false);
    reject(f.input);
    const bytes = fs.readFileSync(path.join(f.dir, 'events.ndjson')), files = preserved(f);
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    await assert.rejects(() => completeIsolatedTask(qcInput(f)), (error) => error.code === 'DUAL_CONTROLLER_REVIEW_REJECTED');
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.ndjson')), bytes);
    assert.deepEqual(preserved(f), files);
    assert.equal(fs.existsSync(path.join(f.root, 'index.js')), false);
});

test('rejection wins while QC awaits handoff: fresh authority denies QC with zero new side effects', async (t) => {
    const f = await fixture(t), pause = barrier();
    const completeIsolatedTask = qcPausedAfterHandoff(t, pause);
    const qc = completeIsolatedTask(qcInput(f));
    await pause.entered;
    reject(f.input);
    const bytes = fs.readFileSync(path.join(f.dir, 'events.ndjson')), files = preserved(f);
    const denied = assert.rejects(qc, (error) => error.code === 'DUAL_CONTROLLER_REVIEW_REJECTED');
    pause.release();
    await denied;
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.ndjson')), bytes);
    assert.deepEqual(preserved(f), files);
    assert.equal(fs.readFileSync(path.join(f.root, 'index.js'), 'utf8'), 'module.exports = 1;\n');
});

test('correction replacing a rejected attempt during the QC read invalidates the captured handoff', async (t) => {
    const f = await fixture(t), pause = barrier();
    const completeIsolatedTask = qcPausedAfterHandoff(t, pause);
    const qc = completeIsolatedTask(qcInput(f));
    await pause.entered;
    reject(f.input);
    requestTaskCorrection({ ...qcInput(f), requestId: 'correct-during-qc', expectedAttempt: 1, reason: 'Address F1' });
    assert.equal((await f.adapter.runTask(f.store.derive()))[0].status, 'AWAITING_CODEX_QC');
    const bytes = fs.readFileSync(path.join(f.dir, 'events.ndjson')), files = preserved(f);
    const denied = assert.rejects(qc, (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
    pause.release();
    await denied;
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.ndjson')), bytes);
    assert.deepEqual(preserved(f), files);
    assert.equal(f.store.derive().tasks['TASK-1'].isolatedHandoff.attempt, 2);
});

test('service integration authorization rechecks current rejection even after QC admission passed', async (t) => {
    const f = await fixture(t);
    const integration = require('../lib/dual/task-integration');
    const integrate = integration.integrateTaskResultAsync;
    const modulePath = require.resolve('../lib/dual/isolated-qc'), cached = require.cache[modulePath];
    let boundaryReached = false;
    const wrapped = t.mock.method(integration, 'integrateTaskResultAsync', async (input) => {
        boundaryReached = true;
        // A legal rejection cannot win after QC owns the lease. Simulate a
        // revoked current authority view to exercise the lower service guard.
        const derive = f.store.derive;
        const current = derive();
        const changed = { ...current, tasks: { ...current.tasks, 'TASK-1': {
            ...current.tasks['TASK-1'], handoffRejection: rejectionEvent(f),
        } } };
        f.store.derive = () => changed;
        try { return await integrate(input); }
        finally { f.store.derive = derive; }
    });
    delete require.cache[modulePath];
    const { completeIsolatedTask } = require(modulePath);
    wrapped.mock.restore();
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
    await assert.rejects(() => completeIsolatedTask(qcInput(f)), (error) => error.code === 'DUAL_INTEGRATION_UNAUTHORIZED');
    assert.equal(boundaryReached, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(f.store.readEvents().some((event) => event.type === 'task.completed' || event.type === 'gate.result'), false);
    const attemptDir = path.join(f.root, path.posix.dirname(f.task.isolatedWorkspace.reference.bindingPath));
    assert.equal(fs.readdirSync(attemptDir).some((file) => /^integrat(?:ion|ed)-/.test(file)), false);
});

test('QC owns its lease before rejection: rejection refuses and normal integration completes', async (t) => {
    const f = await fixture(t), pause = barrier();
    const realpath = fs.promises.realpath;
    let held = false;
    t.mock.method(fs.promises, 'realpath', async (...args) => {
        if (!held && Object.values(f.store.derive().leases).some((lease) => lease.owner === 'codex' && lease.status === 'active')) {
            held = true;
            await pause.wait();
        }
        return realpath(...args);
    });
    t.after(pause.release);
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const qc = completeIsolatedTask(qcInput(f));
    await pause.entered;
    unchanged(f, f.input, 'DUAL_HANDOFF_REJECTION_UNSAFE');
    pause.release();
    assert.equal((await qc).status, 'TASK_VERIFIED');
    assert.equal(f.store.readEvents().some((event) => event.type === 'task.handoff.rejected'), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'index.js'), 'utf8'), 'module.exports = 2;\n');
});

test('rejected correction preserves evidence, starts fresh attempt and cannot exceed attempt three', async (t) => {
    const f = await fixture(t), original = preserved(f);
    reject(f.input);
    requestTaskCorrection({ ...qcInput(f), requestId: 'correction-1', expectedAttempt: 1, reason: 'Address controller finding' });
    const archived = f.store.derive().tasks['TASK-1'].previousAttempts[0];
    assert.deepEqual(archived.workspace, f.task.isolatedWorkspace);
    assert.deepEqual(archived.handoff, f.task.isolatedHandoff);
    assert.equal(archived.handoffRejection.request_id, f.input.request_id);
    assert.deepEqual(preserved(f), original);
    assert.equal((await f.adapter.runTask(f.store.derive()))[0].status, 'AWAITING_CODEX_QC');
    const second = f.store.derive().tasks['TASK-1'];
    assert.equal(second.isolatedHandoff.attempt, 2);
    assert.equal(second.handoffRejection, undefined);
    const eventCount = f.store.readEvents().length;
    assert.equal(reject(f.input).reused, true);
    assert.equal(f.store.readEvents().length, eventCount);
    assert.equal(f.store.derive().tasks['TASK-1'].handoffRejection, undefined);
    for (const [file, hash] of original) assert.equal(preserved(f).get(file), hash, file);
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    assert.equal((await completeIsolatedTask(qcInput(f))).status, 'TASK_VERIFIED');

    const limited = await fixture(t);
    for (const attempt of [1, 2, 3]) {
        const task = limited.store.derive().tasks['TASK-1'];
        reject({ ...limited.input, request_id: `reject-attempt-${attempt}`, expected_attempt: attempt,
            expected_handoff_sha256: task.isolatedHandoff.handoff_sha256, expected_result_sha256: task.isolatedHandoff.result_sha256 });
        const correct = () => requestTaskCorrection({ ...qcInput(limited), requestId: `correct-attempt-${attempt}`,
            expectedAttempt: attempt, reason: 'Address finding' });
        if (attempt === 3) {
            const before = limited.store.readEvents().length;
            assert.throws(correct, (error) => error.code === 'DUAL_CORRECTION_LIMIT');
            assert.equal(limited.store.readEvents().length, before);
            assert.equal(limited.store.derive().tasks['TASK-1'].isolatedHandoff.attempt, 3);
        } else {
            assert.equal(correct().attempt, attempt + 1);
            assert.equal((await limited.adapter.runTask(limited.store.derive()))[0].status, 'AWAITING_CODEX_QC');
        }
    }
});
