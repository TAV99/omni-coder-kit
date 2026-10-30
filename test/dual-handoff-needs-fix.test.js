'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runIsolatedTask } = require('../lib/dual/isolated-runner');
const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
const { classifyFailure, authorizeCorrection, requestTaskCorrection } = require('../lib/dual/task-correction');
const { withDiscussion } = require('./helpers/dual-discussion-stub');

function createAdapter(options) {
    return createOrchestratorAdapter(withDiscussion(options));
}

function fixture(t, overrides = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-handoff-needs-fix-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Task specification.\n');
    fs.writeFileSync(path.join(root, 'scripts', 'check-shop-main.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(root, 'scripts', 'behavior-qc.mjs'), 'process.exit(1);\n');
    return {
        workspaceRoot: root,
        sessionId: 'session-1',
        attempt: 1,
        planRevision: 1,
        task: {
            task_id: 'TASK-SHOP-MAIN-4',
            model: 'gemini-3.8-flash-high',
            effort: 'high',
            goal: 'Implement shop main functionality',
            allowed_files: ['index.js'],
            context_files: ['spec.md'],
            deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['scripts/check-shop-main.mjs'], cwd: '.' }],
            behavior_commands: [{ program: 'node', args: ['scripts/behavior-qc.mjs'], cwd: '.' }],
            ...overrides.task,
        },
        capability: { version: '1.1.27-test', model: 'gemini-3.8-flash-high' },
        authorize: () => true,
    };
}

function seedAuthority(input) {
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
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ ...input.task, title: 'Shop Main 4', owner: 'agy', risk: 'low', execution_mode: 'isolated' }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: input.task.task_id, owner: 'agy',
        authority_state: 'ROUTED', allowed_files: input.task.allowed_files, model: input.capability.model, effort: 'high', reason: 'Isolated task' });
    return { store, dir, snapshot };
}

function workerWithOutputs(commandOutputs, overrides = {}) {
    return async (invocation) => {
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) {
            payload = {
                ...common,
                summary: 'Read files and planned checks',
                relevant_files: [{ path: 'index.js', description: 'main target' }],
                exact_symbols: [],
                validation_commands: spec.validation_commands.map((c) => `${c.program} ${c.args.join(' ')}`),
                constraints: ['scope only'],
                risks: [],
                open_questions: [],
                research_trace: [{ question: 'What to change?', source: 'index.js', source_type: 'REPOSITORY', conclusion: 'Implement shop' },
                    { question: 'What to test?', source: 'spec.md', source_type: 'REPOSITORY', conclusion: 'Run scripts' }],
                alternatives_considered: [{ option: 'Edit existing', tradeoff: 'targeted' }, { option: 'New file', tradeoff: 'unnecessary' }],
                failure_modes: ['validation failure'],
            };
        } else if (prompt.includes('implement phase')) {
            const target = spec.allowed_files[0];
            fs.writeFileSync(path.join(invocation.cwd, target), 'module.exports = 2;\n');
            payload = {
                ...common,
                status: overrides.evidenceStatus || 'SUCCESS',
                modified_files: overrides.modifiedFiles || [target],
                command_outputs: commandOutputs,
                unverified_items: overrides.unverifiedItems !== undefined ? overrides.unverifiedItems : [],
                self_review: overrides.selfReview || { checks: ['scope', 'syntax', 'behavior'], remaining_risks: ['controller correction round may be needed'] },
            };
        } else {
            if (overrides.unverifiedItems && overrides.unverifiedItems.length > 0) {
                const evidencePath = path.join(taskRun, 'evidence.json');
                const evidenceContent = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
                evidenceContent.unverified_items = overrides.unverifiedItems;
                fs.writeFileSync(evidencePath, JSON.stringify(evidenceContent, null, 2) + '\n');
                const newHash = crypto.createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex');
                const eventsPath = path.join(taskRun, 'events.ndjson');
                const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
                const impEvent = events.find((e) => e.type === 'phase.completed' && e.phase === 'implement');
                if (impEvent) {
                    impEvent.artifact_hashes['evidence.json'] = newHash;
                    fs.writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
                }
            }
            payload = {
                ...common,
                recommendation: overrides.reviewRecommendation || 'APPROVE',
                risk_level: 'LOW',
                findings: overrides.reviewFindings || [],
                review_checks: ['scope', 'syntax', 'behavior'],
                challenge_summary: 'Compared implementation and checked outputs.',
            };
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify({ status: 'success', structured_output: payload }),
            stderr: '',
            timedOut: false,
            startedAt: new Date(),
            endedAt: new Date(),
            durationMs: 1,
        };
    };
}

test('(1) & (2) MAIN-4-like fixture: honest worker evidence with failing behavior command passes gate to AWAITING_CODEX_QC, Codex QC returns NEEDS_FIX with DUAL_QC_BEHAVIOR_FAILED, and correction is accepted end-to-end', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);

    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'check passed' },
        { command: 'node scripts/behavior-qc.mjs', exit_code: 1, output: 'behavior check failed' },
    ];
    const worker = workerWithOutputs(commandOutputs);
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    // Gate execution: runTask runs the worker through finalization gate.
    // The gate must NOT throw DUAL_ISOLATED_EVIDENCE_INVALID.
    const runResults = await adapter.runTask(store.derive());
    assert.equal(runResults.length, 1);
    assert.equal(runResults[0].status, 'AWAITING_CODEX_QC');

    const handoff = store.derive().tasks[input.task.task_id].isolatedHandoff;
    assert.ok(handoff, 'task.workspace.handoff must be durably recorded');
    assert.match(handoff.handoff_sha256, /^[a-f0-9]{64}$/);

    // Independent Codex QC re-runs the commands on the worker's changes.
    const qcResult = await completeIsolatedTask({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        sessionId: input.sessionId,
        taskId: input.task.task_id,
        planRevision: 1,
    });

    assert.equal(qcResult.status, 'NEEDS_FIX');
    assert.equal(qcResult.code, 'DUAL_QC_BEHAVIOR_FAILED');

    const derivedTask = store.derive().tasks[input.task.task_id];
    assert.equal(derivedTask.lastOutcome.status, 'NEEDS_FIX');
    assert.equal(derivedTask.lastOutcome.code, 'DUAL_QC_BEHAVIOR_FAILED');

    // (2) Prove correction is ACCEPTED end-to-end through real authorizeCorrection and classifyFailure
    const classification = classifyFailure(derivedTask);
    assert.deepEqual(classification, { category: 'worker', phase: 'controller_qc' });

    const authorization = authorizeCorrection(derivedTask, {
        expectedAttempt: 1,
        sessionId: input.sessionId,
        planRevision: 1,
    });
    assert.deepEqual(authorization, { budget_class: 'worker' });

    const correction = requestTaskCorrection({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        sessionId: input.sessionId,
        planRevision: 1,
        taskId: input.task.task_id,
        expectedAttempt: 1,
        requestId: 'fix-1',
        reason: 'Repair behavior check failure in controller correction round',
    });
    assert.equal(correction.acknowledged, true);
    assert.equal(correction.attempt, 2);

    const updatedTask = store.derive().tasks[input.task.task_id];
    assert.equal(updatedTask.correction.attempt, 2);
    assert.equal(updatedTask.correction.outcome_code, 'DUAL_QC_BEHAVIOR_FAILED');
});

test('(1) & (2) Checker failure fixture: honest worker evidence with failing validation command passes gate, Codex QC returns DUAL_QC_VALIDATION_FAILED, and correction is accepted end-to-end', async (t) => {
    const input = fixture(t, {
        task: {
            behavior_commands: undefined,
            validation_commands: [
                { program: 'node', args: ['scripts/check-shop-main.mjs'], cwd: '.' },
                { program: 'node', args: ['scripts/behavior-qc.mjs'], cwd: '.' },
            ],
        },
    });
    const { store } = seedAuthority(input);

    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'check passed' },
        { command: 'node scripts/behavior-qc.mjs', exit_code: 1, output: 'validation failed' },
    ];
    const worker = workerWithOutputs(commandOutputs);
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    const runResults = await adapter.runTask(store.derive());
    assert.equal(runResults[0].status, 'AWAITING_CODEX_QC');

    const qcResult = await completeIsolatedTask({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        sessionId: input.sessionId,
        taskId: input.task.task_id,
        planRevision: 1,
    });
    assert.equal(qcResult.status, 'NEEDS_FIX');

    const derivedTask = store.derive().tasks[input.task.task_id];
    assert.equal(derivedTask.lastOutcome.code, 'DUAL_QC_VALIDATION_FAILED');

    const classification = classifyFailure(derivedTask);
    assert.deepEqual(classification, { category: 'worker', phase: 'controller_qc' });

    const authorization = authorizeCorrection(derivedTask, {
        expectedAttempt: 1,
        sessionId: input.sessionId,
        planRevision: 1,
    });
    assert.deepEqual(authorization, { budget_class: 'worker' });

    const correction = requestTaskCorrection({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        sessionId: input.sessionId,
        planRevision: 1,
        taskId: input.task.task_id,
        expectedAttempt: 1,
        requestId: 'fix-validation',
        reason: 'Repair validation failure',
    });
    assert.equal(correction.attempt, 2);
});

test('(3) REGRESSION: failing validation with non-empty unverified_items is STILL rejected DUAL_ISOLATED_EVIDENCE_INVALID', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'check passed' },
        { command: 'node scripts/behavior-qc.mjs', exit_code: 1, output: 'behavior check failed' },
    ];
    const worker = workerWithOutputs(commandOutputs, {
        unverifiedItems: ['Behavior check not verified by worker'],
    });
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    await assert.rejects(
        () => adapter.runTask(store.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID'
    );
});

test('(3) REGRESSION: missing required command output for declared validation command is STILL rejected DUAL_ISOLATED_EVIDENCE_INVALID', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    // Missing output for declared validation command
    const commandOutputs = [
        { command: 'node scripts/some-other-script.mjs', exit_code: 0, output: 'other' },
    ];
    const worker = workerWithOutputs(commandOutputs);
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    await assert.rejects(
        () => adapter.runTask(store.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID'
    );
});

test('(3) REGRESSION: empty command_outputs array is STILL rejected DUAL_ISOLATED_EVIDENCE_INVALID', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const worker = workerWithOutputs([]);
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    await assert.rejects(
        () => adapter.runTask(store.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID'
    );
});

test('(3) REGRESSION: review not APPROVE is STILL rejected DUAL_ISOLATED_EVIDENCE_INVALID', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'ok' },
        { command: 'node scripts/behavior-qc.mjs', exit_code: 1, output: 'failed' },
    ];
    const worker = workerWithOutputs(commandOutputs, { reviewRecommendation: 'NEEDS_FIX' });
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    await assert.rejects(
        () => adapter.runTask(store.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID'
    );
});

test('(3) REGRESSION: evidence status not SUCCESS is STILL rejected DUAL_ISOLATED_EVIDENCE_INVALID', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'ok' },
        { command: 'node scripts/behavior-qc.mjs', exit_code: 1, output: 'failed' },
    ];
    const worker = workerWithOutputs(commandOutputs, { evidenceStatus: 'FAILURE' });
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    await assert.rejects(
        () => adapter.runTask(store.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID'
    );
});

test('(3) REGRESSION: modified-files mismatch is STILL rejected DUAL_ISOLATED_EVIDENCE_INVALID', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'ok' },
        { command: 'node scripts/behavior-qc.mjs', exit_code: 1, output: 'failed' },
    ];
    // Worker claims index.js and other.js were modified, but only index.js was changed on disk
    const worker = workerWithOutputs(commandOutputs, { modifiedFiles: ['index.js', 'other.js'] });
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    await assert.rejects(
        () => adapter.runTask(store.derive()),
        (error) => error.code === 'DUAL_ISOLATED_EVIDENCE_INVALID'
    );
});

test('(4) REGRESSION: all-green evidence behaves exactly as before (handoff proceeds to Codex QC unchanged and completes TASK_VERIFIED)', async (t) => {
    const input = fixture(t, {
        task: {
            behavior_commands: undefined,
            validation_commands: [{ program: 'node', args: ['scripts/check-shop-main.mjs'], cwd: '.' }],
        },
    });
    const { store } = seedAuthority(input);
    const commandOutputs = [
        { command: 'node scripts/check-shop-main.mjs', exit_code: 0, output: 'all checks pass' },
    ];
    const worker = workerWithOutputs(commandOutputs);
    const adapter = createAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store, processRunner: worker });

    const runResults = await adapter.runTask(store.derive());
    assert.equal(runResults[0].status, 'AWAITING_CODEX_QC');

    const qcResult = await completeIsolatedTask({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        sessionId: input.sessionId,
        taskId: input.task.task_id,
        planRevision: 1,
    });
    assert.equal(qcResult.status, 'TASK_VERIFIED');
    assert.equal(store.derive().tasks[input.task.task_id].state, 'TASK_VERIFIED');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n');
});
