'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startDaemonServer, createDaemonClient, createAuthorityStore } = require('../lib/dual');
const { createDaemonServerOptions } = require('../bin/omni-daemon');
const {
    buildQualityPlan,
    createTrustedQualityRunner,
    deriveQualityExecutionId,
    persistQualityExecutionArtifact,
    readQualityExecutionArtifact,
} = require('../lib/dual/quality-runner');
const { SessionEventSchema } = require('../lib/dual/contracts');

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

function taskContract() {
    return {
        task_id: 'TASK-1',
        title: 'Replay fixture',
        owner: 'codex',
        allowed_files: ['index.html'],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
    };
}

function deterministicExecutor(calls, options = {}) {
    return (plan) => {
        calls.count += 1;
        const createResults = () => plan.commands.map((command) => ({
            ...command,
            command: `${command.program} ${command.args.join(' ')}`.trim(),
            exit_code: options.fail ? 1 : 0,
            duration_ms: 5,
            ok: !options.fail,
            failure: options.fail ? 'nonzero' : null,
            signal: null,
            started_at: '2026-09-26T00:00:00.000Z',
            ended_at: '2026-09-26T00:00:00.005Z',
            stdout: 'quality output\n',
            stderr: '',
            output: 'quality output\n',
        }));
        if (options.executionGate) {
            options.executionGate.started.resolve();
            return options.executionGate.execution.promise.then(createResults);
        }
        return createResults();
    };
}

function createDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

async function startFixtureDaemon(t, fixture, calls, executorOptions = {}) {
    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: fixture.root, authorityStore: fixture.store }),
        preflightRunner: async () => passingCapability(),
        trustedQualityRunner: createTrustedQualityRunner({
            executeQualityPlanImpl: deterministicExecutor(calls, executorOptions),
        }),
    });
    t.after(async () => { try { await daemon.close(); } catch {} });
    return {
        daemon,
        client: createDaemonClient({ workspaceRoot: fixture.root, timeoutMs: 20_000 }),
    };
}

async function createQualityFixture(t, calls, executorOptions = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-quality-replay-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>fixture</body></html>\n');
    const planBytes = Buffer.from('# Replay fixture\n');
    fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'plan.md'), planBytes);
    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    const fixture = { root, authorityDir, store, planBytes };
    const { daemon, client } = await startFixtureDaemon(t, fixture, calls, executorOptions);
    const begun = await client.beginSession({ workspace_root: root, mode: 'auto' });
    await client.registerPlan(begun.session_id, {
        plan_path: '.omni/sdlc/plan.md',
        plan_sha256: sha(planBytes),
        plan_revision: 1,
        acceptance_policy: acceptancePolicy(),
        tasks: [taskContract()],
    });
    store.append({
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'codex',
        authority_state: 'ROUTED',
        allowed_files: ['index.html'],
        reason: 'Fixture task setup',
    });
    const lease = store.acquireLease('TASK-1', 'codex');
    store.append({
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: sha('task-completion'),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    store.releaseLease(lease.lease_id, 'TASK-1', 'codex', { reason: 'Fixture task complete' });
    return { ...fixture, daemon, client, sessionId: begun.session_id, calls, executorOptions };
}

test('quality execution replays its attested artifact after daemon restart without executing validators again', async (t) => {
    const calls = { count: 0 };
    const executionGate = { execution: createDeferred(), started: createDeferred() };
    const context = await createQualityFixture(t, calls, { executionGate });
    const originalDerive = context.store.derive.bind(context.store);
    const secondRequestEnteredHandler = createDeferred();
    let executionStarted = false;
    let handlerDerivesAfterStart = 0;
    context.store.derive = (...args) => {
        const derived = originalDerive(...args);
        if (executionStarted && handlerDerivesAfterStart < 2) {
            handlerDerivesAfterStart += 1;
            if (handlerDerivesAfterStart === 2) secondRequestEnteredHandler.resolve();
        }
        return derived;
    };
    const firstPromise = context.client.executeQualityCycle(context.sessionId, 1);
    await executionGate.started.promise;
    executionStarted = true;
    const concurrentPromise = context.client.executeQualityCycle(context.sessionId, 1);
    await secondRequestEnteredHandler.promise;
    assert.equal(calls.count, 1, 'second request reached the handler while validator execution remained pending');
    executionGate.execution.resolve();
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    const artifactPath = path.join(context.authorityDir, 'quality', `${first.quality_evidence.provenance.execution_id}.json`);
    const firstBytes = fs.readFileSync(artifactPath);
    const firstEvents = context.store.readEvents();
    assert.deepEqual(concurrent, first, 'concurrent identical requests share one execution response');
    assert.equal(firstEvents.filter((event) => event.type === 'gate.result').length, 0);
    const attestedEvent = firstEvents.find((event) => event.type === 'quality.execution.attested');
    assert.ok(attestedEvent);
    assert.doesNotThrow(() => SessionEventSchema.parse(attestedEvent));
    assert.throws(() => SessionEventSchema.parse({ ...attestedEvent, caller_supplied: true }));
    const anchor = context.store.derive().qualityExecutions[attestedEvent.execution_id];
    assert.ok(Object.isFrozen(anchor));
    assert.ok(Object.isFrozen(anchor.completed_task_ids));
    const beforeConflict = context.store.readEvents().length;
    const conflictingEvent = Object.fromEntries(Object.entries(attestedEvent)
        .filter(([key]) => key !== 'event_id' && key !== 'sequence'));
    assert.throws(
        () => context.store.append({ ...conflictingEvent, artifact_sha256: 'f'.repeat(64) }),
        (error) => error?.code === 'DUAL_INTEGRITY_CORRUPT',
    );
    assert.equal(context.store.readEvents().length, beforeConflict, 'conflicting anchor must reject before append');

    await context.daemon.close();
    const store = createAuthorityStore(context.authorityDir);
    const restarted = await startFixtureDaemon(t, { ...context, store }, calls);
    const second = await restarted.client.executeQualityCycle(context.sessionId, 1);

    assert.equal(calls.count, 1, 'restart replay must not spawn validators twice');
    assert.deepEqual(second, first);
    assert.deepEqual(fs.readFileSync(artifactPath), firstBytes);
    const events = store.readEvents();
    assert.equal(events.filter((event) => event.type === 'quality.execution.attested').length, 1);
    assert.equal(events.filter((event) => event.type === 'gate.result').length, 0);

    await restarted.client.evaluateCompletion(context.sessionId, { quality_evidence: second.quality_evidence });
    assert.equal(calls.count, 1, 'submitting anchored evidence after restart must not execute validators again');
});

test('a changed Node runtime cannot reexecute an already anchored logical quality attempt', async (t) => {
    const calls = { count: 0 };
    const context = await createQualityFixture(t, calls);
    const first = await context.client.executeQualityCycle(context.sessionId, 1);
    const qualityDir = path.join(context.authorityDir, 'quality');
    const snapshotArtifacts = () => Object.fromEntries(fs.readdirSync(qualityDir).sort().map((name) => [
        name,
        fs.readFileSync(path.join(qualityDir, name)).toString('base64'),
    ]));
    const beforeArtifacts = snapshotArtifacts();
    const beforeEvents = context.store.readEvents();

    await context.daemon.close();
    const originalVersion = Object.getOwnPropertyDescriptor(process, 'version');
    let restarted;
    let restartedStore;
    let restartError;
    try {
        Object.defineProperty(process, 'version', { ...originalVersion, value: 'v99.0.0-test-runtime' });
        restartedStore = createAuthorityStore(context.authorityDir);
        restarted = await startFixtureDaemon(t, { ...context, store: restartedStore }, calls);
        try {
            await restarted.client.executeQualityCycle(context.sessionId, 1);
        } catch (error) {
            restartError = error;
        }
    } finally {
        Object.defineProperty(process, 'version', originalVersion);
    }

    assert.equal(first.quality_evidence.attempt, 1);
    assert.equal(beforeEvents.some((event) => event.type === 'gate.result'), false,
        'the anchored logical attempt has no gate result and must not be implicitly advanced');
    assert.equal(restartError?.code, 'DUAL_QUALITY_EXECUTION_CONFLICT');
    assert.equal(calls.count, 1, 'a conflicting execution ID must be rejected before validator spawn');
    assert.deepEqual(snapshotArtifacts(), beforeArtifacts, 'rejection must not create or alter artifacts');
    assert.deepEqual(restartedStore.readEvents(), beforeEvents,
        'rejection must not append an authority event');
});

test('quality artifacts flush their containing directories before returning and propagate directory I/O failures', async (t) => {
    const calls = { count: 0 };
    const context = await createQualityFixture(t, calls);
    const first = await context.client.executeQualityCycle(context.sessionId, 1);
    const original = readQualityExecutionArtifact({
        authorityDir: context.authorityDir,
        executionId: first.quality_evidence.provenance.execution_id,
    }).artifact;
    const qualityDir = path.join(context.authorityDir, 'quality');

    function persistenceInput(executionId) {
        return {
            authorityDir: context.authorityDir,
            workspaceRoot: context.root,
            sessionId: original.session_id,
            workspaceId: original.workspace_id,
            baseline: original.baseline,
            planRevision: original.plan_revision,
            policySha256: original.policy_sha256,
            diffFingerprint: original.diff_fingerprint,
            cycleIndex: original.cycle_index,
            attempt: original.attempt,
            executionId,
            totalTasks: original.total_tasks,
            completedTaskIds: original.completed_task_ids,
            startedAt: original.started_at,
            endedAt: original.ended_at,
            gateResults: original.gate_results,
            results: original.commands.map((command) => ({
                ...command,
                stdout: 'quality output\n',
                stderr: '',
                output: 'quality output\n',
            })),
        };
    }

    function trackedFs(failDirectoryPath) {
        const descriptors = new Map();
        const operations = [];
        const fsImpl = Object.create(fs);
        fsImpl.openSync = (filePath, flags, mode) => {
            const resolvedPath = path.resolve(filePath);
            const fd = fs.openSync(filePath, flags, mode);
            descriptors.set(fd, resolvedPath);
            operations.push({ operation: 'open', path: resolvedPath, flags });
            return fd;
        };
        fsImpl.fsyncSync = (fd) => {
            const resolvedPath = descriptors.get(fd);
            operations.push({ operation: 'fsync', path: resolvedPath });
            if (resolvedPath === failDirectoryPath) {
                const error = new Error('simulated directory flush I/O failure');
                error.code = 'EIO';
                throw error;
            }
            return fs.fsyncSync(fd);
        };
        fsImpl.closeSync = (fd) => {
            const resolvedPath = descriptors.get(fd);
            try {
                return fs.closeSync(fd);
            } finally {
                descriptors.delete(fd);
                operations.push({ operation: 'close', path: resolvedPath });
            }
        };
        return { fsImpl, operations, descriptors };
    }

    const successfulId = 'b'.repeat(64);
    const successfulPath = path.join(qualityDir, `${successfulId}.json`);
    const tracked = trackedFs();
    persistQualityExecutionArtifact(persistenceInput(successfulId), { fsImpl: tracked.fsImpl });
    assert.deepEqual(tracked.operations, [
        { operation: 'open', path: successfulPath, flags: 'wx' },
        { operation: 'fsync', path: successfulPath },
        { operation: 'close', path: successfulPath },
        { operation: 'open', path: qualityDir, flags: 'r' },
        { operation: 'fsync', path: qualityDir },
        { operation: 'close', path: qualityDir },
        { operation: 'open', path: context.authorityDir, flags: 'r' },
        { operation: 'fsync', path: context.authorityDir },
        { operation: 'close', path: context.authorityDir },
    ]);
    assert.equal(tracked.descriptors.size, 0, 'all file and directory descriptors must close');

    const failedId = 'c'.repeat(64);
    const failedPath = path.join(qualityDir, `${failedId}.json`);
    const failing = trackedFs(qualityDir);
    assert.throws(
        () => persistQualityExecutionArtifact(persistenceInput(failedId), { fsImpl: failing.fsImpl }),
        (error) => error?.code === 'EIO',
        'genuine directory I/O errors must propagate before attestation can occur',
    );
    assert.deepEqual(failing.operations, [
        { operation: 'open', path: failedPath, flags: 'wx' },
        { operation: 'fsync', path: failedPath },
        { operation: 'close', path: failedPath },
        { operation: 'open', path: qualityDir, flags: 'r' },
        { operation: 'fsync', path: qualityDir },
        { operation: 'close', path: qualityDir },
    ]);
    assert.equal(failing.descriptors.size, 0, 'failed directory sync must still close every descriptor');
});

test('schema-valid outcome tampering cannot replace the anchored failed execution or spawn validators after restart', async (t) => {
    const calls = { count: 0 };
    const context = await createQualityFixture(t, calls, { fail: true });
    const first = await context.client.executeQualityCycle(context.sessionId, 1);
    const evidence = structuredClone(first.quality_evidence);
    const artifactPath = path.join(context.authorityDir, 'quality', `${evidence.provenance.execution_id}.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    artifact.commands[0].exit_code = 0;
    artifact.commands[0].failure = null;
    artifact.gate_results = artifact.gate_results.map((gate) => ({ ...gate, status: 'PASSED' }));
    const forgedBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    fs.writeFileSync(artifactPath, forgedBytes);
    evidence.commands = artifact.commands.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms }));
    evidence.gate_results = artifact.gate_results;
    evidence.evidence_sha256 = sha(forgedBytes);

    await context.daemon.close();
    const store = createAuthorityStore(context.authorityDir);
    const restarted = await startFixtureDaemon(t, { ...context, store }, calls, { fail: true });
    const before = store.readEvents().length;
    await assert.rejects(
        () => restarted.client.evaluateCompletion(context.sessionId, { quality_evidence: evidence }),
        (error) => ['DUAL_QUALITY_ATTESTATION_INVALID', 'DUAL_QUALITY_ARTIFACT_HASH'].includes(error?.code),
    );
    assert.equal(calls.count, 1, 'durable anchor mismatch rejects before rerunning validators');
    assert.equal(store.readEvents().length, before, 'forged evidence must not append a gate');
    assert.equal(store.readEvents().some((event) => event.type === 'gate.result'), false);
});

test('artifact without a committed attestation is rejected as an orphan without overwrite or retry spawn', async (t) => {
    const calls = { count: 0 };
    const context = await createQualityFixture(t, calls);
    const append = context.store.append;
    context.store.append = (event, options) => {
        if (event?.type === 'quality.execution.attested') {
            const error = new Error('simulated authority append failure after artifact fsync');
            error.code = 'SIMULATED_APPEND_FAILURE';
            throw error;
        }
        return append(event, options);
    };
    await assert.rejects(
        () => context.client.executeQualityCycle(context.sessionId, 1),
        (error) => error?.code === 'SIMULATED_APPEND_FAILURE',
    );
    context.store.append = append;
    const qualityDir = path.join(context.authorityDir, 'quality');
    const orphanNames = fs.readdirSync(qualityDir);
    assert.equal(orphanNames.length, 1, 'failed attestation leaves one durable orphan artifact');
    const orphanPath = path.join(qualityDir, orphanNames[0]);
    const orphanBytes = fs.readFileSync(orphanPath);
    const eventsBefore = context.store.readEvents().length;
    await assert.rejects(
        () => context.client.executeQualityCycle(context.sessionId, 1),
        (error) => error?.code === 'DUAL_QUALITY_ORPHAN_ARTIFACT' || error?.code === 'DUAL_QUALITY_PLAN_INVALID',
    );
    assert.equal(calls.count, 1, 'an unanchored artifact must never be overwritten by a new spawn');
    assert.equal(context.store.readEvents().length, eventsBefore);
    assert.equal(context.store.readEvents().some((event) => event.type === 'quality.execution.attested'), false);
    assert.deepEqual(fs.readdirSync(qualityDir), orphanNames, 'retry must not add or remove artifacts');
    assert.deepEqual(fs.readFileSync(orphanPath), orphanBytes, 'retry must not overwrite the orphan artifact');
});

test('durable replay rejects changed command, dependency, diff, revision, policy, session, and workspace identity', async (t) => {
    const calls = { count: 0 };
    const context = await createQualityFixture(t, calls);
    const first = await context.client.executeQualityCycle(context.sessionId, 1);
    await context.daemon.close();
    const derived = context.store.derive();
    const registeredCommands = Object.values(derived.tasks)
        .flatMap((task) => Array.isArray(task.validation_commands) ? task.validation_commands : []);
    const expected = {
        sessionId: derived.sessionId,
        workspaceId: derived.workspaceId,
        baseline: derived.currentBaseline,
        planRevision: derived.planRevision,
        policySha256: derived.plan.acceptancePolicySha256,
        diffFingerprint: first.quality_evidence.diff_fingerprint,
        cycleIndex: first.quality_evidence.cycle_index,
        attempt: first.quality_evidence.attempt,
        totalTasks: first.quality_evidence.total_tasks,
        completedTaskIds: first.quality_evidence.completed_task_ids,
        workspaceRoot: context.root,
        commandPlan: buildQualityPlan(context.root, fs, { validationCommands: registeredCommands }).commands,
    };
    const executionId = deriveQualityExecutionId({
        workspaceRoot: context.root,
        sessionId: expected.sessionId,
        workspaceId: expected.workspaceId,
        baseline: expected.baseline,
        planRevision: expected.planRevision,
        policySha256: expected.policySha256,
        diffFingerprint: expected.diffFingerprint,
        cycleIndex: expected.cycleIndex,
        attempt: expected.attempt,
        totalTasks: expected.totalTasks,
        completedTaskIds: expected.completedTaskIds,
        commandPlan: expected.commandPlan,
    });
    const anchor = derived.qualityExecutions[executionId];
    const runner = createTrustedQualityRunner({ executeQualityPlanImpl: deterministicExecutor(calls) });
    const mutations = [
        ['raw secret argv', (copy) => { copy.commandPlan[0].args.push('--token=not-for-logs'); }],
        ['diff', (copy) => { copy.diffFingerprint = sha('other diff'); }],
        ['revision', (copy) => { copy.planRevision += 1; }],
        ['policy', (copy) => { copy.policySha256 = sha('other policy'); }],
        ['session', (copy) => { copy.sessionId = crypto.randomUUID(); }],
        ['workspace', (copy) => { copy.workspaceId = sha('other workspace'); }],
        ['dependencies', (copy) => { fs.writeFileSync(path.join(context.root, 'package-lock.json'), '{"lockfileVersion":3}\n'); }],
    ];
    for (const [label, mutate] of mutations) {
        const expectedCopy = { ...expected, commandPlan: expected.commandPlan.map((command) => ({ ...command, args: [...command.args] })) };
        mutate(expectedCopy);
        await assert.rejects(
            () => runner({
                mode: 'execute',
                authorityDir: context.authorityDir,
                workspaceRoot: context.root,
                expected: expectedCopy,
                executionAttestation: anchor,
            }),
            (error) => error?.code === 'DUAL_QUALITY_ATTESTATION_INVALID',
            label,
        );
    }
    fs.rmSync(path.join(context.root, 'package-lock.json'), { force: true });
    await assert.rejects(
        () => runner({ mode: 'execute', authorityDir: context.authorityDir, workspaceRoot: context.root, expected }),
        (error) => error?.code === 'DUAL_QUALITY_ORPHAN_ARTIFACT'
            && /preserve.*session.*create a new run/i.test(error.message),
        'existing artifact without supplied authority anchor is never adopted',
    );
    await assert.rejects(
        () => runner({
            mode: 'execute', authorityDir: context.authorityDir, workspaceRoot: context.root, expected,
            executionAttestation: { ...anchor, artifact_sha256: 'f'.repeat(64) },
        }),
        (error) => ['DUAL_QUALITY_ATTESTATION_INVALID', 'DUAL_QUALITY_ARTIFACT_HASH'].includes(error?.code),
        'contradictory anchor binding or artifact digest rejects',
    );
    assert.equal(calls.count, 1, 'identity changes and conflicts must not spawn validators');
});

test('artifact loader distinguishes missing, malformed, and truncated paths', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-quality-artifact-load-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const authorityDir = path.join(root, 'authority');
    const qualityDir = path.join(authorityDir, 'quality');
    fs.mkdirSync(qualityDir, { recursive: true });
    const executionId = 'a'.repeat(64);
    const target = path.join(qualityDir, `${executionId}.json`);
    assert.throws(
        () => readQualityExecutionArtifact({ authorityDir, executionId }),
        (error) => error?.code === 'DUAL_QUALITY_ARTIFACT_MISSING',
    );
    fs.writeFileSync(target, '{');
    assert.throws(
        () => readQualityExecutionArtifact({ authorityDir, executionId }),
        (error) => error?.code === 'DUAL_QUALITY_ARTIFACT_INVALID',
        'truncated artifact must fail closed',
    );
    fs.writeFileSync(target, '{}');
    assert.throws(
        () => readQualityExecutionArtifact({ authorityDir, executionId }),
        (error) => error?.code === 'DUAL_QUALITY_ARTIFACT_INVALID',
        'schema-invalid artifact must fail closed',
    );
    fs.unlinkSync(target);
});

test('artifact loader rejects a symlink path when the host allows creating symlinks', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-quality-artifact-symlink-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const authorityDir = path.join(root, 'authority');
    const qualityDir = path.join(authorityDir, 'quality');
    fs.mkdirSync(qualityDir, { recursive: true });
    const executionId = 'a'.repeat(64);
    const target = path.join(qualityDir, `${executionId}.json`);
    const source = path.join(qualityDir, 'source.json');
    fs.writeFileSync(source, '{}');
    try {
        fs.symlinkSync(source, target, 'file');
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('file symlink privilege is unavailable on this host');
        throw error;
    }
    assert.throws(
        () => readQualityExecutionArtifact({ authorityDir, executionId }),
        (error) => error?.code === 'DUAL_QUALITY_ARTIFACT_INVALID',
        'symlink artifact must fail closed',
    );
});
