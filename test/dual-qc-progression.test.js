'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { handleDualQc } = require('../lib/commands/dual');

const {
    buildQualityPlan,
    deriveQualityExecutionId,
    executeQualityPlan,
    readQualityExecutionArtifact,
    redactSecrets,
    persistQualityExecutionArtifact,
    verifyQualityExecutionArtifact,
} = require('../lib/dual/quality-runner');

function createGitWorkspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'quality-fixture@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Quality Fixture'], { cwd: root });
    fs.writeFileSync(path.join(root, 'index.js'), "'use strict';\n");
    execFileSync('git', ['add', 'index.js'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    return { root, head };
}

function createQcProgressionHarness(t, initialTaskState) {
    const { root, head } = createGitWorkspace(t);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const taskId = 'TASK-1';
    const acceptancePolicy = {
        protocol_version: 1,
        checks: [],
        ui: {
            required: false,
            viewport_widths: [390, 768, 1024, 1440],
            reduced_motion_required: true,
        },
    };
    let taskState = initialTaskState;
    const gates = {};
    const calls = { complete: 0, qc: 0, quality: [], ui: 0, final: 0 };
    const status = () => ({
        session_id: sessionId,
        workspace_id: 'a'.repeat(64),
        workspace_root: root,
        plan_revision: 1,
        state: taskState === 'TASK_VERIFIED' ? 'ACCEPTANCE' : 'CODEX_QC',
        current_baseline: { kind: 'git', id: head },
        plan: { acceptance_policy: acceptancePolicy },
        tasks: {
            [taskId]: {
                task_id: taskId,
                state: taskState,
                execution_mode: 'isolated',
                validation_commands: [{ program: process.execPath, args: ['--version'], cwd: '.' }],
            },
        },
        gates: { ...gates },
    });
    const client = {
        async health() { return { status: 'healthy', session_id: sessionId }; },
        async status() { return status(); },
        async completeIsolatedTask() {
            calls.complete++;
            taskState = 'TASK_VERIFIED';
            return { status: 'TASK_VERIFIED', task_id: taskId };
        },
        async evaluateCompletion(_sessionId, payload) {
            if (payload?.qc_evidence) {
                calls.qc++;
                return { verified: false };
            }
            if (payload?.ui_evidence) {
                calls.ui++;
                return { verified: false };
            }
            if (payload?.quality_evidence) {
                const cycle = payload.quality_evidence.cycle_index;
                calls.quality.push(cycle);
                gates[`quality-cycle-${cycle}`] = {
                    status: 'PASSED',
                    details: { provenance: payload.quality_evidence.provenance, attempt: 1 },
                };
                return { verified: cycle === 3 };
            }
            calls.final++;
            return {
                verified: calls.quality.length === 3,
                receipt: calls.quality.length === 3 ? { receipt_sha256: 'b'.repeat(64) } : null,
            };
        },
    };
    const qualityPlan = {
        commands: [{
            id: 'registered-node-version',
            name: 'registered node --version',
            program: process.execPath,
            args: ['--version'],
            cwd: '.',
            available: true,
        }],
    };
    const options = {
        cwd: root,
        client,
        json: true,
        buildQualityPlan: () => qualityPlan,
        evaluateAdaptiveVisualQa: async () => ({ evidence: null }),
        deriveQualityExecutionId: ({ cycleIndex }) => crypto.createHash('sha256').update(`cycle-${cycleIndex}`).digest('hex'),
        readQualityExecutionArtifact: () => {
            const error = new Error('missing');
            error.code = 'DUAL_QUALITY_ARTIFACT_MISSING';
            throw error;
        },
        executeQualityPlan: (plan) => plan.commands.map((command) => ({
            ...command,
            command: `${command.program} ${command.args.join(' ')}`,
            exit_code: 0,
            duration_ms: 1,
            ok: true,
            failure: null,
            signal: null,
            started_at: '2026-09-10T01:02:03.000Z',
            ended_at: '2026-09-10T01:02:03.001Z',
            stdout: '',
            stderr: '',
        })),
        persistQualityExecutionArtifact: (input) => ({
            sha256: crypto.createHash('sha256').update(input.executionId).digest('hex'),
            artifact: {
                commands: input.results.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms })),
                gate_results: input.gateResults.map((gate) => ({ ...gate })),
            },
        }),
    };
    return { calls, client, options, taskId };
}

async function captureJsonOutput(t, action) {
    const messages = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode;
    console.log = (...args) => messages.push(args.join(' '));
    process.exitCode = undefined;
    t.after(() => {
        console.log = originalLog;
        process.exitCode = originalExitCode;
    });
    await action();
    return messages.map((message) => JSON.parse(message));
}

test('handleDualQc progresses the last isolated task through three cycles without duplicate task QC', async (t) => {
    const harness = createQcProgressionHarness(t, 'CODEX_QC');
    const output = await captureJsonOutput(t, () => handleDualQc(undefined, harness.options));

    assert.equal(harness.calls.complete, 1);
    assert.equal(harness.calls.qc, 0);
    assert.deepEqual(harness.calls.quality, [1, 2, 3]);
    assert.equal(harness.calls.final, 1);
    assert.equal(output.length, 1);
    assert.equal(output[0].verified, true);
});

test('handleDualQc with an explicit isolated task verifies only that task', async (t) => {
    const harness = createQcProgressionHarness(t, 'CODEX_QC');
    const output = await captureJsonOutput(t, () => handleDualQc(harness.taskId, harness.options));

    assert.equal(harness.calls.complete, 1);
    assert.equal(harness.calls.qc, 0);
    assert.deepEqual(harness.calls.quality, []);
    assert.equal(harness.calls.final, 0);
    assert.equal(output.length, 1);
    assert.equal(output[0].status, 'TASK_VERIFIED');
});

test('handleDualQc continues acceptance when every isolated task is already verified', async (t) => {
    const harness = createQcProgressionHarness(t, 'TASK_VERIFIED');
    const output = await captureJsonOutput(t, () => handleDualQc(undefined, harness.options));

    assert.equal(harness.calls.complete, 0);
    assert.equal(harness.calls.qc, 0);
    assert.deepEqual(harness.calls.quality, [1, 2, 3]);
    assert.equal(harness.calls.final, 1);
    assert.equal(output.length, 1);
    assert.equal(output[0].verified, true);
});

test('quality plan preserves typed argv and cwd and deduplicates only exact command identity', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-plan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', verify: 'node verify.js' } }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });

    const validationCommands = [
        { program: 'npm', args: ['run', 'verify', '--', '--flag'], cwd: 'packages/app' },
        { program: 'npm', args: ['run', 'verify', '--', '--flag'], cwd: 'packages/app' },
        { program: 'npm', args: ['run', 'verify', '--', '--other'], cwd: 'packages/app' },
    ];
    const plan = buildQualityPlan(root, fs, { validationCommands });
    const registered = plan.commands.filter((command) => command.source === 'registered');
    assert.equal(registered.length, 2);
    assert.deepEqual(registered.map(({ program, args, cwd }) => ({ program, args, cwd })), [
        validationCommands[0], validationCommands[2],
    ]);

    const calls = [];
    executeQualityPlan({ ...plan, commands: registered }, {
        workspaceRoot: root,
        spawnSyncImpl: (program, args, options) => {
            calls.push({ program, args, cwd: options.cwd });
            return { status: 0, stdout: '', stderr: '' };
        },
        resolveExecutable: () => process.execPath,
    });
    assert.deepEqual(calls.map(({ args, cwd }) => ({ args: args.slice(-4), cwd })), [
        { args: validationCommands[0].args, cwd: path.join(root, 'packages', 'app') },
        { args: validationCommands[2].args, cwd: path.join(root, 'packages', 'app') },
    ]);
});

test('quality plan deduplicates built-in and registered commands by full identity', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-plan-dedupe-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

    const plan = buildQualityPlan(root, fs, {
        validationCommands: [
            { program: 'npm', args: ['audit', '--audit-level=high'], cwd: '.' },
            { program: 'npm', args: ['run', 'test'], cwd: '.' },
            { program: 'npm', args: ['run', 'test', '--', '--test-name-pattern=focused'], cwd: '.' },
        ],
    });

    assert.equal(plan.commands.length, 3);
    assert.deepEqual(plan.commands.map(({ program, args, cwd }) => ({ program, args, cwd: cwd || '.' })), [
        { program: 'npm', args: ['audit', '--audit-level=high'], cwd: '.' },
        { program: 'npm', args: ['run', 'test'], cwd: '.' },
        { program: 'npm', args: ['run', 'test', '--', '--test-name-pattern=focused'], cwd: '.' },
    ]);
});

test('quality plan rejects more than 50 canonical commands without truncation', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-plan-limit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const validationCommands = Array.from({ length: 49 }, (_, index) => ({
        program: 'node',
        args: [`script-${index}.mjs`],
        cwd: '.',
    }));

    assert.throws(
        () => buildQualityPlan(root, fs, { validationCommands }),
        (error) => error?.code === 'DUAL_QUALITY_PLAN_OVERFLOW'
            && /51 canonical commands exceeds maximum 50/.test(error.message)
    );
});

test('redaction removes unquoted multiword, bearer, JSON, URL, and query-string secrets', () => {
    const redacted = redactSecrets([
        'password=two word argv secret',
        'status=kept',
        'Authorization: Bearer bearer token with spaces',
        'Authorization: Bearer "bearer \\"quoted\\" escaped-bearer-tail"',
        '{"token":"json token with spaces","safe":"kept-json"}',
        '{"auth_token":"json \\"quoted\\" escaped-json-tail","safe":"kept-escaped"}',
        'https://user:url-password@example.invalid/path?access_token=query-secret&mode=kept',
    ].join('\n'));

    assert.doesNotMatch(redacted, /two word argv secret|bearer token with spaces|escaped-bearer-tail|json token with spaces|escaped-json-tail|url-password|query-secret/);
    assert.match(redacted, /password=\[REDACTED\]/);
    assert.match(redacted, /status=kept/);
    assert.match(redacted, /"safe":"kept-json"/);
    assert.match(redacted, /"safe":"kept-escaped"/);
    assert.match(redacted, /mode=\[REDACTED\]/);
});

function qualityArtifactFixture(root, overrides = {}) {
    const diffFingerprint = overrides.diffFingerprint || 'b'.repeat(64);
    const startedAt = '2026-09-10T01:02:03.000Z';
    const endedAt = '2026-09-10T01:02:03.025Z';
    const fixture = {
        authorityDir: path.join(root, '.omni', 'runs', 'dual-authority'),
        workspaceRoot: root,
        sessionId: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'c'.repeat(64),
        baseline: { kind: 'git', id: 'd'.repeat(40) },
        planRevision: 1,
        policySha256: 'e'.repeat(64),
        diffFingerprint,
        cycleIndex: 1,
        attempt: 1,
        totalTasks: 1,
        completedTaskIds: ['TASK-1'],
        gateResults: [{ id: 'registered-tests', required: true, status: 'PASSED', reason: 'tests exited 0' }],
        startedAt,
        endedAt,
        results: [{
            id: 'registered-tests',
            name: 'registered node --test',
            program: process.execPath,
            args: ['--test', 'test/example.test.js', '--token', 'raw-argv-secret', '--password=two word argv secret'],
            cwd: 'packages/app',
            command: `${process.execPath} --test test/example.test.js --token raw-argv-secret --password=two word argv secret`,
            exit_code: 0,
            duration_ms: 25,
            ok: true,
            failure: null,
            signal: null,
            started_at: startedAt,
            ended_at: endedAt,
            stdout: 'Authorization: Bearer top-secret-token\napi_key=private-key\ntoken="two word output secret"',
            stderr: 'password=hunter2',
        }],
        ...overrides,
    };
    fixture.executionId = overrides.executionId || deriveQualityExecutionId({
        workspaceRoot: fixture.workspaceRoot,
        sessionId: fixture.sessionId,
        workspaceId: fixture.workspaceId,
        baseline: fixture.baseline,
        planRevision: fixture.planRevision,
        policySha256: fixture.policySha256,
        diffFingerprint: fixture.diffFingerprint,
        cycleIndex: fixture.cycleIndex,
        attempt: fixture.attempt,
        totalTasks: 1,
        completedTaskIds: fixture.completedTaskIds,
        commandPlan: fixture.results,
    });
    return fixture;
}

test('quality artifacts keep raw daemon-runner digests after diagnostic redaction', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-raw-digests-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

    const input = qualityArtifactFixture(root);
    const rawStdout = 'Authorization: Bearer runner raw secret with spaces';
    const rawStderr = 'password=runner stderr secret';
    const [runnerResult] = executeQualityPlan({ commands: [{ ...input.results[0], available: true }] }, {
        workspaceRoot: root,
        spawnSyncImpl: () => ({ status: 0, stdout: rawStdout, stderr: rawStderr }),
    });

    assert.doesNotMatch(JSON.stringify(runnerResult), /runner raw secret|runner stderr secret/);
    runnerResult.stdout_sha256 = 'f'.repeat(64);
    runnerResult.stderr_sha256 = 'f'.repeat(64);
    runnerResult.output_sha256 = 'f'.repeat(64);
    const persisted = persistQualityExecutionArtifact({ ...input, results: [runnerResult] });

    const combined = `${rawStdout}\n${rawStderr}`;
    assert.equal(persisted.artifact.commands[0].stdout_sha256, crypto.createHash('sha256').update(rawStdout).digest('hex'));
    assert.equal(persisted.artifact.commands[0].stderr_sha256, crypto.createHash('sha256').update(rawStderr).digest('hex'));
    assert.equal(persisted.artifact.commands[0].output_sha256, crypto.createHash('sha256').update(combined).digest('hex'));
});

test('quality artifacts ignore forged public digests on injected results', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-forged-digests-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

    const input = qualityArtifactFixture(root);
    const injectedResult = {
        ...input.results[0],
        stdout_sha256: 'a'.repeat(64),
        stderr_sha256: 'b'.repeat(64),
        output_sha256: 'c'.repeat(64),
    };
    const persisted = persistQualityExecutionArtifact({ ...input, results: [injectedResult] });
    const stdout = injectedResult.stdout;
    const stderr = injectedResult.stderr;

    assert.equal(persisted.artifact.commands[0].stdout_sha256, crypto.createHash('sha256').update(stdout).digest('hex'));
    assert.equal(persisted.artifact.commands[0].stderr_sha256, crypto.createHash('sha256').update(stderr).digest('hex'));
    assert.equal(persisted.artifact.commands[0].output_sha256, crypto.createHash('sha256').update(`${stdout}\n${stderr}`).digest('hex'));
});

test('quality artifacts discard runner digest provenance when result streams change or are copied', (t) => {
    for (const kind of ['mutated', 'copied']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `omni-quality-${kind}-digests-`));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

        const input = qualityArtifactFixture(root);
        const [runnerResult] = executeQualityPlan({ commands: [{ ...input.results[0], available: true }] }, {
            workspaceRoot: root,
            spawnSyncImpl: () => ({ status: 0, stdout: 'Bearer original stdout secret', stderr: 'password=original stderr secret' }),
        });
        const changedResult = kind === 'copied' ? { ...runnerResult } : runnerResult;
        changedResult.stdout = `${kind} visible stdout`;
        changedResult.stderr = `${kind} visible stderr`;
        changedResult.output = `${kind} visible output`;
        const persisted = persistQualityExecutionArtifact({ ...input, results: [changedResult] });
        const stdout = changedResult.stdout;
        const stderr = changedResult.stderr;

        assert.equal(persisted.artifact.commands[0].stdout_sha256, crypto.createHash('sha256').update(stdout).digest('hex'));
        assert.equal(persisted.artifact.commands[0].stderr_sha256, crypto.createHash('sha256').update(stderr).digest('hex'));
        assert.equal(persisted.artifact.commands[0].output_sha256, crypto.createHash('sha256').update(`${stdout}\n${stderr}`).digest('hex'));
    }
});

test('quality execution artifact is immutable, identity-bound, digested, and redacts secrets', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-artifact-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

    const input = qualityArtifactFixture(root);
    const persisted = persistQualityExecutionArtifact(input);
    const bytes = fs.readFileSync(persisted.path);
    const raw = bytes.toString('utf8');

    assert.equal(persisted.relative_path, `quality/${input.executionId}.json`);
    assert.equal(persisted.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.doesNotMatch(raw, /top-secret-token|private-key|hunter2|raw-argv-secret|two word (?:argv|output) secret/);
    assert.match(raw, /\[REDACTED\]/);
    assert.deepEqual(persisted.artifact.commands[0].args, [
        '--test', 'test/example.test.js', '--token', '[REDACTED]', '--password=[REDACTED]',
    ]);
    assert.equal(persisted.artifact.commands[0].cwd, input.results[0].cwd);
    assert.match(persisted.artifact.commands[0].output_sha256, /^[0-9a-f]{64}$/);
    assert.equal(persisted.artifact.dependencies.lockfiles[0].path, 'package-lock.json');
    assert.equal(persisted.artifact.runner.node_version, process.version);
    assert.equal(Object.hasOwn(persisted.artifact, 'environment'), false);

    const qualityEvidence = {
        cycle_index: input.cycleIndex,
        attempt: input.attempt,
        total_tasks: 1,
        completed_task_ids: input.completedTaskIds,
        plan_revision: input.planRevision,
        diff_fingerprint: input.diffFingerprint,
        gate_results: input.gateResults,
        commands: persisted.artifact.commands.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms })),
        evidence_sha256: persisted.sha256,
        provenance: {
            execution_id: input.executionId,
            input_fingerprint: input.diffFingerprint,
            mode: 'fresh',
        },
    };
    const verified = verifyQualityExecutionArtifact({
        authorityDir: input.authorityDir,
        qualityEvidence,
        expected: {
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            baseline: input.baseline,
            planRevision: input.planRevision,
            policySha256: input.policySha256,
            workspaceRoot: root,
            commandPlan: input.results,
        },
    });
    assert.equal(verified.sha256, persisted.sha256);
    assert.equal(verified.artifact.execution_id, input.executionId);
});

test('quality artifact retry is idempotent but the same execution id cannot change payload', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-retry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

    const input = qualityArtifactFixture(root);
    const first = persistQualityExecutionArtifact(input);
    const retry = persistQualityExecutionArtifact(input);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.sha256, first.sha256);

    const changedResults = input.results.map((result) => ({ ...result, exit_code: 7, ok: false, failure: 'nonzero' }));
    assert.throws(
        () => persistQualityExecutionArtifact({ ...input, results: changedResults }),
        (error) => error && error.code === 'DUAL_QUALITY_EXECUTION_CONFLICT'
    );

    const loaded = readQualityExecutionArtifact({ authorityDir: input.authorityDir, executionId: input.executionId });
    assert.equal(loaded.sha256, first.sha256);
    assert.deepEqual(loaded.artifact, first.artifact);
});

test('quality execution id is stable for an identical request and changes with command or dependency identity', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const identity = {
        workspaceRoot: root,
        sessionId: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'c'.repeat(64),
        baseline: { kind: 'git', id: 'd'.repeat(40) },
        planRevision: 1,
        policySha256: 'e'.repeat(64),
        diffFingerprint: 'b'.repeat(64),
        cycleIndex: 1,
        attempt: 1,
        totalTasks: 1,
        completedTaskIds: ['TASK-1'],
        commandPlan: [{ program: process.execPath, args: ['--test'], cwd: '.' }],
    };
    const first = deriveQualityExecutionId(identity);
    assert.equal(deriveQualityExecutionId(identity), first);
    assert.notEqual(deriveQualityExecutionId({
        ...identity,
        commandPlan: [{ program: process.execPath, args: ['--test', '--watch'], cwd: '.' }],
    }), first);
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    assert.notEqual(deriveQualityExecutionId(identity), first);
});

test('quality artifact verifier rejects hash, dependency, and command-plan drift', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-verify-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const input = qualityArtifactFixture(root);
    const persisted = persistQualityExecutionArtifact(input);
    const evidence = {
        cycle_index: 1,
        attempt: 1,
        total_tasks: 1,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: input.diffFingerprint,
        gate_results: input.gateResults,
        commands: persisted.artifact.commands.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms })),
        evidence_sha256: persisted.sha256,
        provenance: { execution_id: input.executionId, input_fingerprint: input.diffFingerprint, mode: 'fresh' },
    };
    const expected = {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        baseline: input.baseline,
        planRevision: input.planRevision,
        policySha256: input.policySha256,
        workspaceRoot: root,
        commandPlan: input.results,
    };

    assert.throws(
        () => verifyQualityExecutionArtifact({ authorityDir: input.authorityDir, qualityEvidence: { ...evidence, evidence_sha256: 'f'.repeat(64) }, expected }),
        (error) => error && error.code === 'DUAL_QUALITY_ARTIFACT_HASH'
    );
    assert.throws(
        () => verifyQualityExecutionArtifact({
            authorityDir: input.authorityDir,
            qualityEvidence: evidence,
            expected: { ...expected, commandPlan: [{ ...input.results[0], args: ['--test', '--watch'] }] },
        }),
        (error) => error && error.code === 'DUAL_QUALITY_ARTIFACT_BINDING'
    );
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    assert.throws(
        () => verifyQualityExecutionArtifact({ authorityDir: input.authorityDir, qualityEvidence: evidence, expected }),
        (error) => error && error.code === 'DUAL_QUALITY_ARTIFACT_BINDING'
    );
});
