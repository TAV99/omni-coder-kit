'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startDaemonServer, createDaemonClient, createAuthorityStore } = require('../lib/dual');
const { createDaemonServerOptions } = require('../bin/omni-daemon');
const { createTrustedQualityRunner } = require('../lib/dual/quality-runner');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function passingCapability() {
    return {
        status: 'PASSED',
        to_state: 'CAPABILITY_SAFE',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: {
            agy_version: '1.1.19-fixture',
            agy_model: 'gemini-3.7-flash-high',
            agy_evidence: { version: '1.1.19-fixture', model: 'gemini-3.7-flash-high' },
        },
    };
}

function acceptancePolicy() {
    return {
        protocol_version: 1,
        checks: [],
        ui: { required: false, viewport_widths: [390], reduced_motion_required: true },
    };
}

function makeTasks(count) {
    return Array.from({ length: count }, (_, index) => ({
        task_id: `TASK-${index + 1}`,
        title: `Checkpoint fixture ${index + 1}`,
        owner: 'codex',
        allowed_files: [`task-${index + 1}.txt`],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
    }));
}

function createDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

async function createFixture(t, taskCount, options = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-quality-checkpoint-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
    fs.writeFileSync(path.join(root, 'source.txt'), 'baseline\n');
    const planBytes = Buffer.from('# Checkpoint fixture\n');
    fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'plan.md'), planBytes);
    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    const calls = { count: 0 };
    const registrationProbe = options.registrationProbe;
    const setupManifestPath = path.resolve(root, '.omni', 'sdlc', 'setup.json');
    const serverFs = registrationProbe
        ? new Proxy(fs, {
            get(target, property) {
                if (property === 'existsSync') {
                    return (candidatePath, ...args) => {
                        if (typeof candidatePath === 'string' && path.resolve(candidatePath) === setupManifestPath) {
                            registrationProbe.counters.setupReadinessChecks += 1;
                        }
                        return target.existsSync(candidatePath, ...args);
                    };
                }
                return Reflect.get(target, property, target);
            },
        })
        : fs;
    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: root, authorityStore: store }),
        fsImpl: serverFs,
        preflightRunner: async () => {
            if (registrationProbe) registrationProbe.counters.preflightCalls += 1;
            return passingCapability();
        },
        trustedQualityRunner: createTrustedQualityRunner({
            executeQualityPlanImpl: (plan) => {
                calls.count += 1;
                if (options.executionGate) {
                    options.executionGate.started.resolve();
                    return options.executionGate.execution.promise.then(() => plan.commands.map((command) => ({
                        ...command,
                        command: `${command.program} ${command.args.join(' ')}`.trim(),
                        exit_code: 0,
                        duration_ms: 5,
                        ok: true,
                        failure: null,
                        signal: null,
                        started_at: '2026-09-29T00:00:00.000Z',
                        ended_at: '2026-09-29T00:00:00.005Z',
                        stdout: 'quality output\n',
                        stderr: '',
                        output: 'quality output\n',
                    })));
                }
                return plan.commands.map((command) => ({
                    ...command,
                    command: `${command.program} ${command.args.join(' ')}`.trim(),
                    exit_code: options.shouldFail?.() ? 1 : 0,
                    duration_ms: 5,
                    ok: !options.shouldFail?.(),
                    failure: options.shouldFail?.() ? 'nonzero' : null,
                    signal: null,
                    started_at: '2026-09-29T00:00:00.000Z',
                    ended_at: '2026-09-29T00:00:00.005Z',
                    stdout: 'quality output\n',
                    stderr: '',
                    output: 'quality output\n',
                }));
            },
        }),
    });
    t.after(async () => { try { await daemon.close(); } catch {} });
    const client = createDaemonClient({ workspaceRoot: root, timeoutMs: 20_000 });
    const begun = await client.beginSession({ workspace_root: root, mode: 'auto' });
    const tasks = makeTasks(taskCount);
    const planInput = {
        plan_path: '.omni/sdlc/plan.md',
        plan_sha256: sha(planBytes),
        plan_revision: 1,
        tasks,
        ...(options.omitPolicy ? {} : { acceptance_policy: acceptancePolicy() }),
    };
    if (registrationProbe) {
        registrationProbe.authorityDir = authorityDir;
        registrationProbe.beforeAuthorityBytes = snapshotAuthorityBytes(authorityDir);
    }
    const registration = await client.registerPlan(begun.session_id, planInput);

    async function verifyTask(taskId) {
        const lease = store.acquireLease(taskId, 'codex');
        store.append({
            type: 'task.completed',
            task_id: taskId,
            owner: 'codex',
            authority_state: 'TASK_VERIFIED',
            modified_files: [`task-${Number(taskId.slice(5))}.txt`],
            diff_fingerprint: sha(`completion:${taskId}`),
            verdict: 'SUCCESS',
            verified_by: 'codex',
        });
        store.releaseLease(lease.lease_id, taskId, 'codex', { reason: 'Fixture task complete' });
    }

    return { root, authorityDir, store, daemon, client, sessionId: begun.session_id, tasks, registration, calls, verifyTask };
}

async function recordCycle(context, cycleIndex) {
    const executed = await context.client.executeQualityCycle(context.sessionId, cycleIndex);
    await context.client.evaluateCompletion(context.sessionId, { quality_evidence: executed.quality_evidence });
    return executed.quality_evidence;
}

function qualityGateEvents(store) {
    return store.readEvents().filter((event) => event.type === 'gate.result'
        && /^quality-cycle-[1-3]$/.test(event.gate_id));
}

function snapshotAuthorityBytes(authorityDir) {
    const snapshot = {};
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolutePath = path.join(directory, entry.name);
            const relativePath = path.relative(authorityDir, absolutePath).split(path.sep).join('/');
            if (entry.isDirectory()) visit(absolutePath);
            else if (entry.isFile()) snapshot[relativePath] = fs.readFileSync(absolutePath).toString('base64');
        }
    }
    if (fs.existsSync(authorityDir)) visit(authorityDir);
    return snapshot;
}

test('three-task checkpoints record exact verified subsets and successful earlier checkpoints replay unchanged', async (t) => {
    const context = await createFixture(t, 3);
    await context.verifyTask('TASK-1');

    const cycle1Execution = await context.client.executeQualityCycle(context.sessionId, 1);
    const cycle1 = cycle1Execution.quality_evidence;
    const partialCompletion = await context.client.evaluateCompletion(context.sessionId, { quality_evidence: cycle1 });
    assert.deepEqual(cycle1.completed_task_ids, ['TASK-1']);
    assert.equal(partialCompletion.verified, false,
        'a partial checkpoint must not qualify a session with unverified tasks');
    assert.equal(partialCompletion.receipt, undefined,
        'a partial checkpoint must not issue a completion receipt');
    assert.notEqual(context.store.derive().tasks['TASK-2'].state, 'TASK_VERIFIED');
    assert.notEqual(context.store.derive().tasks['TASK-3'].state, 'TASK_VERIFIED');
    assert.equal(context.store.derive().receipt, null,
        'partial checkpoint delivery must leave authoritative receipt absent');
    assert.equal(qualityGateEvents(context.store).length, 1);

    await context.verifyTask('TASK-2');
    const cycle2 = await recordCycle(context, 2);
    assert.deepEqual(cycle2.completed_task_ids, ['TASK-1', 'TASK-2']);

    await context.verifyTask('TASK-3');
    const cycle3 = await recordCycle(context, 3);
    assert.deepEqual(cycle3.completed_task_ids, ['TASK-1', 'TASK-2', 'TASK-3']);
    assert.equal(context.store.derive().sessionState, 'VERIFIED',
        'daemon final qualification must use anchored current-generation quality history');

    const callCount = context.calls.count;
    const attestationCount = Object.keys(context.store.derive().qualityExecutions).length;
    const gateCount = qualityGateEvents(context.store).length;
    const replay = await context.client.executeQualityCycle(context.sessionId, 1);
    assert.deepEqual(replay.quality_evidence, cycle1);
    assert.equal(context.calls.count, callCount, 'successful replay must use the anchored artifact without spawning validators');
    assert.equal(Object.keys(context.store.derive().qualityExecutions).length, attestationCount,
        'successful replay must not append another durable execution attestation');
    await context.client.evaluateCompletion(context.sessionId, { quality_evidence: replay.quality_evidence });
    assert.equal(qualityGateEvents(context.store).length, gateCount, 'same evidence delivery must not append a duplicate gate');
    await context.client.evaluateCompletion(context.sessionId, { quality_evidence: replay.quality_evidence });
    assert.equal(qualityGateEvents(context.store).length, gateCount, 'lost completion response replay must remain read-only');

    fs.writeFileSync(path.join(context.root, 'source.txt'), 'changed after session verification\n');
    await assert.rejects(
        () => context.client.executeQualityCycle(context.sessionId, 1),
        (error) => error?.code === 'DUAL_SESSION_VERIFIED',
    );
    assert.equal(context.calls.count, callCount, 'a verified session cannot execute a new generation');
    assert.equal(Object.keys(context.store.derive().qualityExecutions).length, attestationCount);
    assert.equal(qualityGateEvents(context.store).length, gateCount);
});

test('a source change requires current-generation prerequisite cycles before later cycles', async (t) => {
    const context = await createFixture(t, 1);
    await context.verifyTask('TASK-1');
    await recordCycle(context, 1);
    const callsBeforeChange = context.calls.count;

    fs.writeFileSync(path.join(context.root, 'source.txt'), 'changed after checkpoint\n');
    await assert.rejects(
        () => context.client.executeQualityCycle(context.sessionId, 2),
        (error) => error?.code === 'DUAL_QUALITY_CYCLE_ORDER',
    );
    assert.equal(context.calls.count, callsBeforeChange, 'stale cycle 1 must reject before spawning cycle 2');

    const newCycle1 = await recordCycle(context, 1);
    assert.equal(newCycle1.attempt, 1, 'attempt budget is scoped to the new source generation');
    const newCycle2 = await recordCycle(context, 2);
    assert.equal(newCycle2.cycle_index, 2);
});

test('one task still requires three distinct current-generation cycles', async (t) => {
    const context = await createFixture(t, 1);
    await context.verifyTask('TASK-1');

    for (const cycleIndex of [1, 2, 3]) {
        const evidence = await recordCycle(context, cycleIndex);
        assert.equal(evidence.cycle_index, cycleIndex);
        assert.deepEqual(evidence.completed_task_ids, ['TASK-1']);
    }

    assert.deepEqual(qualityGateEvents(context.store).map((event) => event.gate_id), [
        'quality-cycle-1', 'quality-cycle-2', 'quality-cycle-3',
    ]);
});

test('raw plan registration without policy rejects before writing capability or setup authority', async (t) => {
    const registrationProbe = { counters: { preflightCalls: 0, setupReadinessChecks: 0 } };
    const context = await createFixture(t, 1, {
        omitPolicy: true,
        registrationProbe,
    }).catch((error) => ({ setupError: error }));
    assert.equal(context.setupError?.code, 'DUAL_ACCEPTANCE_POLICY_REQUIRED');
    assert.deepEqual(registrationProbe.counters, { preflightCalls: 0, setupReadinessChecks: 0 },
        'policy omission must reject before capability preflight or setup readiness work');
    assert.deepEqual(snapshotAuthorityBytes(registrationProbe.authorityDir), registrationProbe.beforeAuthorityBytes,
        'policy omission must not append or mutate any authority bytes');
});

test('attested partial execution can be replayed after restart and then delivered exactly once', async (t) => {
    const executionGate = { execution: createDeferred(), started: createDeferred() };
    const context = await createFixture(t, 2, { executionGate });
    await context.verifyTask('TASK-1');

    const pending = context.client.executeQualityCycle(context.sessionId, 1);
    await executionGate.started.promise;
    executionGate.execution.resolve();
    const first = await pending;
    assert.deepEqual(first.quality_evidence.completed_task_ids, ['TASK-1']);
    assert.equal(Object.keys(context.store.derive().qualityExecutions).length, 1,
        'execution attestation is durable even before gate delivery');
    assert.equal(qualityGateEvents(context.store).length, 0,
        'the first response was lost before quality gate delivery');
    await context.daemon.close();

    const store = createAuthorityStore(context.authorityDir);
    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: context.root, authorityStore: store }),
        preflightRunner: async () => passingCapability(),
        trustedQualityRunner: createTrustedQualityRunner({
            executeQualityPlanImpl: () => {
                context.calls.count += 1;
                throw new Error('successful attested replay must not spawn');
            },
        }),
    });
    t.after(async () => { try { await daemon.close(); } catch {} });
    const client = createDaemonClient({ workspaceRoot: context.root, timeoutMs: 20_000 });
    const replay = await client.executeQualityCycle(context.sessionId, 1);
    assert.deepEqual(replay, first);
    assert.equal(context.calls.count, 1);
    assert.equal(Object.keys(store.derive().qualityExecutions).length, 1,
        'replay must reuse the unresolved execution anchor without re-attesting');

    await client.evaluateCompletion(context.sessionId, { quality_evidence: replay.quality_evidence });
    assert.equal(qualityGateEvents(store).length, 1);
    await client.evaluateCompletion(context.sessionId, { quality_evidence: replay.quality_evidence });
    assert.equal(qualityGateEvents(store).length, 1, 'lost response replay must not append a second gate');
});

test('successfully recorded quality gate replay after daemon restart is exact and read-only', async (t) => {
    const context = await createFixture(t, 2);
    await context.verifyTask('TASK-1');

    const first = await context.client.executeQualityCycle(context.sessionId, 1);
    const evidence = first.quality_evidence;
    await context.client.evaluateCompletion(context.sessionId, { quality_evidence: evidence });
    const originalGateEvents = qualityGateEvents(context.store);
    assert.equal(originalGateEvents.length, 1);
    assert.equal(originalGateEvents[0].status, 'PASSED');
    const originalAttestations = Object.keys(context.store.derive().qualityExecutions).length;
    const originalAuthorityBytes = snapshotAuthorityBytes(context.authorityDir);
    const originalRunnerCalls = context.calls.count;

    await context.daemon.close();
    const store = createAuthorityStore(context.authorityDir);
    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: context.root, authorityStore: store }),
        preflightRunner: async () => passingCapability(),
        trustedQualityRunner: createTrustedQualityRunner({
            executeQualityPlanImpl: () => {
                context.calls.count += 1;
                throw new Error('successfully gated replay must not spawn validators');
            },
        }),
    });
    t.after(async () => { try { await daemon.close(); } catch {} });
    const client = createDaemonClient({ workspaceRoot: context.root, timeoutMs: 20_000 });

    const replay = await client.executeQualityCycle(context.sessionId, 1);
    assert.deepEqual(replay.quality_evidence, evidence,
        'restart replay must return the exact evidence already covered by the successful gate');
    assert.equal(context.calls.count, originalRunnerCalls,
        'replay of a successfully gated execution must not spawn another validator run');
    assert.equal(Object.keys(store.derive().qualityExecutions).length, originalAttestations,
        'successful replay must not append another execution attestation');
    assert.deepEqual(qualityGateEvents(store), originalGateEvents,
        'successful replay must not append another gate');
    assert.deepEqual(snapshotAuthorityBytes(context.authorityDir), originalAuthorityBytes,
        'successful replay must not write any authority or event bytes');
});

test('three failed attempts exhaust the current generation budget before a fourth validator run', async (t) => {
    const context = await createFixture(t, 1, { shouldFail: () => context.calls.count <= 3 });
    await context.verifyTask('TASK-1');

    for (const attempt of [1, 2, 3]) {
        const executed = await context.client.executeQualityCycle(context.sessionId, 1);
        assert.equal(executed.quality_evidence.attempt, attempt);
        assert.ok(executed.quality_evidence.commands.some((command) => command.exit_code !== 0));
        let deliveryError;
        await context.client.evaluateCompletion(context.sessionId, {
            quality_evidence: executed.quality_evidence,
        }).catch((error) => { deliveryError = error; });
        assert.equal(qualityGateEvents(context.store).length, attempt,
            `failed attempt ${attempt} must still be durably recorded${deliveryError ? `: ${deliveryError.code} ${deliveryError.message}` : ''}`);
    }

    assert.deepEqual(qualityGateEvents(context.store).map((event) => event.details.attempt), [1, 2, 3]);
    const callCount = context.calls.count;
    await assert.rejects(
        () => context.client.executeQualityCycle(context.sessionId, 1),
        (error) => error?.code === 'DUAL_QC_ATTEMPT_EXHAUSTED',
    );
    assert.equal(context.calls.count, callCount, 'attempt exhaustion must reject before spawning validators');
});

test('task-set drift while validators are in flight invalidates the execution before attestation', async (t) => {
    const executionGate = { execution: createDeferred(), started: createDeferred() };
    const context = await createFixture(t, 2, { executionGate });
    await context.verifyTask('TASK-1');

    const originalDerive = context.store.derive.bind(context.store);
    let injectTaskSetDrift = false;
    context.store.derive = () => {
        const derived = originalDerive();
        if (injectTaskSetDrift) {
            injectTaskSetDrift = false;
            derived.tasks['TASK-EXTRA'] = { state: 'PENDING', validation_commands: [] };
        }
        return derived;
    };

    const pending = context.client.executeQualityCycle(context.sessionId, 1);
    await executionGate.started.promise;
    injectTaskSetDrift = true;
    executionGate.execution.resolve();
    await assert.rejects(
        () => pending,
        (error) => error?.code === 'DUAL_QUALITY_ATTESTATION_INVALID',
    );
    context.store.derive = originalDerive;
    assert.equal(context.calls.count, 1);
    assert.equal(Object.keys(context.store.derive().qualityExecutions).length, 0,
        'drifted task identity must not receive a durable execution attestation');
    assert.equal(qualityGateEvents(context.store).length, 0);
});

test('replayed checkpoint rejects a completed-task subset that differs from its durable anchor', async (t) => {
    const context = await createFixture(t, 2);
    await context.verifyTask('TASK-1');
    const original = await recordCycle(context, 1);
    await context.verifyTask('TASK-2');
    const callCount = context.calls.count;

    const tampered = { ...original, completed_task_ids: ['TASK-1', 'TASK-2'] };
    await assert.rejects(
        () => context.client.evaluateCompletion(context.sessionId, { quality_evidence: tampered }),
        (error) => ['DUAL_QUALITY_ATTESTATION_INVALID', 'DUAL_QUALITY_ARTIFACT_INVALID'].includes(error?.code),
    );
    assert.equal(context.calls.count, callCount, 'tampering must not trigger new validators');
    assert.equal(qualityGateEvents(context.store).length, 1, 'tampering must not append a gate');
    assert.equal(Object.keys(context.store.derive().qualityExecutions).length, 1,
        'tampering must not append another execution attestation');
});
