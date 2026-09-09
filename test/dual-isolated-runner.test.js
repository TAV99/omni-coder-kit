'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { runIsolatedTask } = require('../lib/dual/isolated-runner');
const { integrateTaskResult } = require('../lib/dual/task-integration');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { startDaemonServer } = require('../lib/dual/daemon-server');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-isolated-runner-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1,
        task: { task_id: 'TASK-1', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
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
    const handoff = await runIsolatedTask({ ...input, processRunner: fakeWorker(calls) });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.equal(calls.length, 3);
    assert.equal(calls.every((invocation) => invocation.cwd === handoff.reference.workerRoot), true);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(handoff.result.changes.length, 1);
    assert.equal(Buffer.from(handoff.result.changes[0].contentBase64, 'base64').toString(), 'module.exports = 2;\n');
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, handoff.handoffPath)), true);
    assert.match(handoff.handoffSha256, /^[a-f0-9]{64}$/);
    const resumed = await runIsolatedTask({ ...input, processRunner: fakeWorker(calls), reference: handoff.reference });
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
    const handoff = await runIsolatedTask({ ...input, processRunner: fakeWorker(calls) });
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
    await assert.rejects(() => runIsolatedTask({ ...input, processRunner: fakeWorker(calls),
        authorize: () => permitted, onPrepared() { permitted = false; } }),
    (error) => error.code === 'DUAL_ISOLATED_UNAUTHORIZED');
    assert.equal(calls.length, 0);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
});

test('completed handoff detects evidence rewritten together with its mutable phase log', async (t) => {
    const input = fixture(t), calls = [];
    const handoff = await runIsolatedTask({ ...input, processRunner: fakeWorker(calls) });
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
    await assert.rejects(() => runIsolatedTask({ ...input, reference: handoff.reference, processRunner: fakeWorker(calls) }),
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
        capability: { ...input.capability, model: 'another-model' }, processRunner: fakeWorker([]) }),
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
    await assert.rejects(() => runIsolatedTask({ ...input, reference, processRunner: fakeWorker([]) }),
        (error) => error.code === 'DUAL_PATH_ESCAPE');
    assert.deepEqual(fs.readdirSync(target), [], 'no artifact writes outside private runtime');
});

test('isolated semantic evidence must correlate to the registered task and baseline', async (t) => {
    for (const field of ['task_id', 'expected_baseline']) {
        const input = fixture(t);
        await assert.rejects(() => runIsolatedTask({ ...input, processRunner: fakeWorker([], (payload) => ({
            ...payload, [field]: field === 'task_id' ? 'UNRELATED-TASK' : { kind: 'snapshot', id: 'a'.repeat(64) },
        })) }), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    }
});

test('isolated handoff requires outputs for the registered validation command', async (t) => {
    for (const outputs of [[], [{ command: 'unregistered command', exit_code: 0, output: '' }]]) {
        const input = fixture(t);
        await assert.rejects(() => runIsolatedTask({ ...input, processRunner: fakeWorker([], (payload) => (
            payload.status === 'SUCCESS' ? { ...payload, command_outputs: outputs } : payload
        )) }), (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID');
    }
});

function seedAuthority(input, extraTasks = []) {
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
    const dir = path.join(input.workspaceRoot, '.omni/runs/dual-authority');
    const snapshot = createConfiguredSnapshotBaseline({ root: input.workspaceRoot }).baseline.capture();
    const store = createAuthorityStore(dir);
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: input.workspaceRoot,
        workspace_id: 'workspace-test', session_id: input.sessionId, plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: input.sessionId, workspaceId: 'workspace-test',
        workspaceRoot: input.workspaceRoot, identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: input.capability.version, agy_model: input.capability.model } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1 + extraTasks.length,
        tasks: [{ ...input.task, title: 'Task one', owner: 'agy', risk: 'low', execution_mode: 'isolated' }, ...extraTasks] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: input.task.allowed_files, model: input.capability.model, reason: 'Private task' });
    for (const task of extraTasks) store.append({ schema_version: 2, type: 'task.routed', task_id: task.task_id,
        owner: 'agy', authority_state: 'ROUTED', allowed_files: task.allowed_files, model: input.capability.model, reason: 'Private dependent task' });
    return { store, dir, snapshot };
}

test('authority adapter persists isolated binding and handoff and resumes after reopen without duplicate worker calls', async (t) => {
    const input = fixture(t), calls = [];
    const { store, dir } = seedAuthority(input);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        agyProjectId: '12345678-1234-1234-1234-123456789abc', processRunner: fakeWorker(calls) });
    const result = await adapter.runTask(store.derive());
    assert.equal(result[0].status, 'AWAITING_CODEX_QC');
    assert.equal(store.derive().tasks['TASK-1'].isolatedWorkspace.attempt, 1);
    assert.match(store.derive().tasks['TASK-1'].isolatedHandoff.handoff_sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.values(store.derive().leases).every((lease) => lease.status === 'released'), true);
    const reopened = createAuthorityStore(dir);
    const next = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: reopened,
        processRunner: fakeWorker(calls) });
    assert.equal((await next.runTask(reopened.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.equal(calls.length, 3);
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.ok(Object.values(store.derive().tasks['TASK-1'].executions || {}).length > 0, 'controller PID is recorded for recovery');
    await assert.rejects(() => next.runTask({ ...reopened.derive(), planRevision: 2 }),
        (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
    const foreign = fixture(t);
    const wrongRoot = createOrchestratorAdapter({ workspaceRoot: foreign.workspaceRoot, authorityStore: reopened,
        processRunner: fakeWorker(calls) });
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
        model: 'unqualified-model', allowed_files: input.task.allowed_files, reason: 'Same revision model drift' });
    await assert.rejects(() => next.runTask(reopened.derive()), (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
    reopened.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        plan_revision: 2, model: input.capability.model, allowed_files: input.task.allowed_files, reason: 'Changed revision' });
    await assert.rejects(() => next.runTask(reopened.derive()), (error) => error.code === 'DUAL_ISOLATED_AUTHORITY_STALE');
});

test('unsafe isolated arguments report preparation failure with released lease and no model call', async (t) => {
    const input = fixture(t), { store } = seedAuthority(input), calls = [];
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        agyPrefixArgs: ['--project', 'source'], processRunner: fakeWorker(calls) });
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
        processRunner: fakeWorker(calls) }).runTask(store.derive());
    const request = { workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 };
    const complete = await completeIsolatedTask(request);
    assert.equal(complete.status, 'TASK_VERIFIED');
    assert.equal(store.derive().tasks['TASK-1'].verified_by, 'codex');
    assert.equal(store.derive().sessionState, 'ACCEPTANCE', 'task completion does not bypass session gates');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(complete.commands[0].command, 'node --check index.js');
    assert.equal(complete.commands[0].exit_code, 0);
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
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker }).runTask(store.derive());
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
        processRunner: fakeWorker([], (payload) => payload.status === 'SUCCESS' ? { ...payload, command_outputs: [{ command, exit_code: 0, output: '' }] } : payload) }).runTask(store.derive());
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
            processRunner: worker }).runTask(store.derive());
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
        processRunner: fakeWorker([]) }).runTask(store.derive());
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
        processRunner: async (invocation, options) => {
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
        processRunner: async (invocation) => {
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
        processRunner: worker }).runTask(store.derive());
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
        processRunner: async (invocation, options) => {
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
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });
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
        processRunner: async (invocation, options) => {
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
    const waiting = await runIsolatedTask({ ...input, processRunner: worker });
    assert.equal(waiting.status, 'NEEDS_CONTEXT');
    await assert.rejects(() => runIsolatedTask({ ...input, reference: waiting.reference,
        expectedQuestions: ['Which value?'], controllerReplies: [{ question: 'Which value?', answer: '2' }],
        processRunner: async (invocation, options) => {
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
        processRunner: worker }).runTask(store.derive());
    assert.equal(result[0].status, 'NEEDS_CONTEXT');
    const records = store.readEvents().filter((event) => ['task.message', 'task.questions'].includes(event.type));
    assert.equal(records.length, 1);
    assert.equal(records[0].questions.length, 2);
});

test('worker cannot invent controller answers when the controller never supplied replies', async (t) => {
    const input = fixture(t);
    const worker = fakeWorker([]);
    await assert.rejects(() => runIsolatedTask({ ...input, processRunner: async (invocation, options) => {
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
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });
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
        processRunner: async (invocation, options) => {
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
        processRunner: async () => { throw new Error('worker stopped'); } });
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
        processRunner: fakeWorker([]) }).runTask(store.derive());
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

test('preparation failure records an outcome and can be corrected without deleting an unregistered snapshot', async (t) => {
    const { requestTaskCorrection } = require('../lib/dual/task-correction');
    const input = fixture(t);
    let orphan;
    await assert.rejects(() => runIsolatedTask({ ...input, onPrepared(reference) {
        orphan = reference;
        throw new Error('interrupted before authority registration');
    } }), /interrupted before authority/);
    const orphanBytes = fs.readFileSync(path.join(input.workspaceRoot, orphan.bindingPath));
    const { store, dir } = seedAuthority(input), calls = [];
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: fakeWorker(calls) });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_TASK_WORKSPACE_EXISTS');
    const failed = createAuthorityStore(dir).derive().tasks['TASK-1'];
    assert.equal(failed.lastOutcome.code, 'DUAL_TASK_WORKSPACE_EXISTS');
    assert.equal(failed.lastOutcome.attempt, 1);
    assert.equal(failed.isolatedWorkspace, undefined);
    assert.equal(calls.length, 0);
    assert.equal(requestTaskCorrection({ workspaceRoot: input.workspaceRoot, authorityStore: store, sessionId: input.sessionId,
        taskId: 'TASK-1', planRevision: 1, expectedAttempt: 1, requestId: 'prepare-fix', reason: 'Retry interrupted preparation in a fresh attempt.' }).attempt, 2);
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.equal(store.derive().tasks['TASK-1'].isolatedWorkspace.attempt, 2);
    assert.deepEqual(fs.readFileSync(path.join(input.workspaceRoot, orphan.bindingPath)), orphanBytes);
    assert.equal(store.derive().tasks['TASK-1'].previousAttempts[0].workspace, null);
});

test('missing context failure is durable before model calls or workspace registration', async (t) => {
    const input = fixture(t);
    input.task.context_files = ['missing.md'];
    const { store } = seedAuthority(input), calls = [];
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: fakeWorker(calls) });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_TASK_CONTEXT_UNAVAILABLE');
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome.code, 'DUAL_TASK_CONTEXT_UNAVAILABLE');
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'FAILED');
    assert.equal(calls.length, 0);
});

test('isolated task evidence satisfies existing session gates and produces a verified receipt', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const input = fixture(t), { store, snapshot } = seedAuthority(input);
    await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        processRunner: fakeWorker([]) }).runTask(store.derive());
    await completeIsolatedTask({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: 'TASK-1', planRevision: 1 });
    const daemon = await startDaemonServer({ workspaceRoot: input.workspaceRoot, authorityStore: store });
    t.after(() => daemon.close());
    const client = createDaemonClient({ workspaceRoot: input.workspaceRoot });
    const { baseline, excludedPaths } = createConfiguredSnapshotBaseline({ root: input.workspaceRoot });
    const fingerprint = baseline.fingerprint(snapshot.identity, snapshot.manifest, { excludedPaths }).patchSha256;
    for (const cycle of [1, 2, 3]) {
        const testResult = spawnSync(process.execPath, ['--check', 'index.js'], {
            cwd: input.workspaceRoot, shell: false, windowsHide: true,
        });
        assert.equal(testResult.status, 0);
        await client.evaluateCompletion(input.sessionId, { quality_evidence: {
            cycle_index: cycle, attempt: 1, total_tasks: 1, completed_task_ids: ['TASK-1'], plan_revision: 1,
            diff_fingerprint: fingerprint,
            gate_results: [{ id: 'syntax', required: true, status: 'PASSED' }],
            commands: [{ command: 'node --check index.js', exit_code: 0, duration_ms: 1 }],
            evidence_sha256: crypto.createHash('sha256').update(`syntax cycle ${cycle}`).digest('hex'),
        } });
    }
    const result = await client.evaluateCompletion(input.sessionId);
    assert.equal(result.verified, true, JSON.stringify(result.blockers));
    assert.equal(store.derive().sessionState, 'VERIFIED');
    assert.match(result.receipt?.receipt_sha256, /^[a-f0-9]{64}$/);
});

test('isolated runner prepares declared locked dependencies before invoking model and preserves receipt on resume', async (t) => {
    const input = fixture(t), calls = [];
    input.task.dependency_mode = 'npm-ci';
    fs.writeFileSync(path.join(input.workspaceRoot, 'package.json'), '{"name":"worker-fixture","version":"1.0.0"}');
    fs.writeFileSync(path.join(input.workspaceRoot, 'package-lock.json'), JSON.stringify({
        name: 'worker-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { name: 'worker-fixture', version: '1.0.0' } },
    }));
    const result = await runIsolatedTask({ ...input, processRunner: fakeWorker(calls) });
    assert.match(result.reference.workerDependencies?.receiptSha256 || '', /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(input.workspaceRoot, 'node_modules')), false);
    const resumed = await runIsolatedTask({ ...input, reference: result.reference, processRunner: fakeWorker(calls) });
    assert.equal(resumed.reference.workerDependencies.receiptSha256, result.reference.workerDependencies.receiptSha256);
    assert.equal(calls.length, 3);
    // Separate session identity avoids reusing the direct-run attempt above.
    const input2 = fixture(t);
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(input.workspaceRoot, file), path.join(input2.workspaceRoot, file));
    input2.task.dependency_mode = 'npm-ci';
    const { store: authority } = seedAuthority(input2);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input2.workspaceRoot, authorityStore: authority, processRunner: fakeWorker([]) });
    assert.equal((await adapter.runTask(authority.derive()))[0].status, 'AWAITING_CODEX_QC');
    assert.match(authority.derive().tasks['TASK-1'].isolatedWorkspace.reference.workerDependencies.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal((await adapter.runTask(authority.derive()))[0].status, 'AWAITING_CODEX_QC');
});

test('isolated contract header instructs unverified_items empty array and prompt templates are aligned', async (t) => {
    const input = fixture(t);
    const calls = [];
    await runIsolatedTask({
        ...input,
        processRunner: async (invocation, deps) => {
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
