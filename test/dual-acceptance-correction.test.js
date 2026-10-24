'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { withDiscussion } = require('./helpers/dual-discussion-stub');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { evaluateHook } = require('../lib/dual/hook-bridge');
const { captureDiffFingerprint } = require('../lib/dual/scope-guard');
const { createTrustedQualityRunner } = require('../lib/dual/quality-runner');
const { createDaemonServerOptions } = require('../bin/omni-daemon');

const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');

function createPassingTrustedQualityRunner() {
    return createTrustedQualityRunner({
        executeQualityPlanImpl: (plan) => plan.commands.map((command) => ({
            ...command,
            command: `${command.program} ${command.args.join(' ')}`.trim(),
            exit_code: 0,
            duration_ms: 1,
            ok: true,
            failure: null,
            signal: null,
            started_at: '2026-09-11T00:00:00.000Z',
            ended_at: '2026-09-11T00:00:00.001Z',
            stdout: '',
            stderr: '',
        })),
    });
}

function acceptancePolicy({ correctionCommand = { program: 'node', args: ['--version'], cwd: '.' } } = {}) {
    return {
        protocol_version: 1,
        ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true },
        checks: [{
            id: 'review-task-1', requirement_id: 'REQ-TASK-1', task_id: 'task-1',
            phase: 'pre_integration', kind: 'review', required: true,
        }, {
            id: 'acceptance-task-1', requirement_id: 'REQ-SESSION-1',
            phase: 'session', kind: 'review', required: true,
        }],
        correction_grants: [{
            failure_check_id: 'acceptance-task-1', task_id: 'task-1',
            allowed_files: ['index.html'],
            validation_commands: [correctionCommand],
        }],
    };
}

function sessionOnlyAcceptancePolicy({ correctionCommand = { program: 'node', args: ['--version'], cwd: '.' } } = {}) {
    return {
        protocol_version: 1,
        checks: [{
            id: 'acceptance-task-1', requirement_id: 'REQ-SESSION-1',
            phase: 'session', kind: 'review', required: true,
        }],
        correction_grants: [{
            failure_check_id: 'acceptance-task-1', task_id: 'task-1',
            allowed_files: ['index.html'],
            validation_commands: [correctionCommand],
        }],
    };
}

function correctionPrereqs(workspaceRoot, baseCommit, authorityStore, overrides = {}) {
    return {
        expected_sequence: authorityStore.verifyIntegrity().lastSequence,
        start_fingerprint: captureDiffFingerprint({ repoRoot: workspaceRoot, baseCommit, excludedPaths: ['.omni'] }).patchSha256,
        failure_check_id: 'acceptance-task-1',
        ...overrides,
    };
}

async function submitPreparedReview(client, sessionId, checkResults) {
    const prepared = await client.prepareAcceptanceReview(sessionId, 'task-1', 1);
    return client.submitAcceptanceReview(sessionId, 'task-1', 1, {
        review_execution_id: prepared.review_execution_id,
        check_results: checkResults,
    });
}

async function submitAcceptanceFailure(client, sessionId) {
    return submitPreparedReview(client, sessionId, [
        { check_id: 'acceptance-task-1', status: 'FAIL', findings: ['Heading contrast'] },
    ]);
}

function createTempDir(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync.native(require('node:os').tmpdir()), `${prefix}-`));
}

function initGitRepo(dir) {
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Initial</h1>\n');
    fs.writeFileSync(path.join(dir, 'styles.css'), 'body { color: black; }\n');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

const mockPreflightRunner = async () => ({
    status: 'PASSED',
    to_state: 'CAPABILITY_SAFE',
    checks: [
        { name: 'agy', status: 'PASSED' },
        { name: 'agy_cli_and_model', status: 'PASSED' },
    ],
    details: {
        agy_model: 'gemini-3.7-flash-high',
        agy_version: '1.1.19',
        agy_evidence: { model: 'gemini-3.7-flash-high' },
    },
});

function publicDaemonWorker() {
    return async (invocation, options) => {
        assert.ok(options.env.GIT_CEILING_DIRECTORIES);
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) {
            payload = { ...common, summary: 'Read index and spec',
                relevant_files: [{ path: 'index.html', description: 'page heading' }], exact_symbols: [],
                validation_commands: ['node --version'], constraints: ['scope only'], risks: [], open_questions: [],
                research_trace: ['index.html', 'README.md'].map((source) => ({ question: 'What to change?', source,
                    source_type: 'REPOSITORY', conclusion: 'Update heading' })),
                alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
                failure_modes: ['wrong heading'] };
        } else if (prompt.includes('implement phase')) {
            const target = spec.allowed_files[0];
            fs.writeFileSync(path.join(invocation.cwd, target), '<h1>Implemented</h1>\n');
            payload = { ...common, status: 'SUCCESS', modified_files: [target],
                command_outputs: [{ command: 'node --version', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'heading'], remaining_risks: [] } };
        } else {
            payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
                review_checks: ['scope', 'syntax', 'heading'], challenge_summary: 'Compared original and changed heading.' };
        }
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}

test('public daemon path completes isolated QC, correction, and fresh review without direct task completion append', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-public-daemon');
    const baseCommit = initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'public-daemon'));
    const policy = sessionOnlyAcceptancePolicy();
    const daemon = await startDaemonServer({
        workspaceRoot,
        authorityStore,
        preflightRunner: mockPreflightRunner,
        orchestrator: createOrchestratorAdapter(withDiscussion({
            workspaceRoot, authorityStore, processRunner: publicDaemonWorker(),
        })),
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    t.after(async () => {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const client = createDaemonClient({ workspaceRoot, timeoutMs: 5000 });
    const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });
    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
        acceptance_policy: policy,
        tasks: [{ task_id: 'task-1', title: 'Task 1', goal: 'Update heading', owner: 'agy',
            execution_mode: 'isolated', allowed_files: ['index.html'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] }],
    });

    await client.resumeSession(session.session_id);
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
        status = await client.status(session.session_id);
        if (status.tasks?.['task-1']?.isolatedHandoff) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(status.tasks?.['task-1']?.isolatedHandoff,
        `public resume must persist a private handoff before QC: ${JSON.stringify(status)}`);

    const qc = await client.completeIsolatedTask(session.session_id, 'task-1', 1);
    assert.equal(qc.status, 'TASK_VERIFIED', JSON.stringify(qc));
    assert.equal((await client.status(session.session_id)).session_state, 'ACCEPTANCE');

    assert.equal((await submitAcceptanceFailure(client, session.session_id)).status, 'NEEDS_FIX');
    assert.equal(authorityStore.readEvents().filter((event) => event.type === 'review.attested').length, 1);
    assert.equal(authorityStore.readEvents().some((event) => event.type === 'gate.result'
        && event.details?.review_phase === 'post_integration'), false,
        'one review attestation event must atomically derive every acceptance gate');

    const correction = await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(
        workspaceRoot, baseCommit, authorityStore, { task_id: 'task-1', reason: 'Fix heading from public flow' }
    ));
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Corrected publicly</h1>\n');
    const corrected = await client.completeAcceptanceCorrection(session.session_id, { correction_id: correction.correction_id });
    assert.equal(corrected.status, 'PASSED');

    const blockedUntilReview = await client.evaluateCompletion(session.session_id);
    assert.ok(blockedUntilReview.blockers.some((blocker) => blocker.includes('SESSION_ACCEPTANCE_FAILED')),
        `correction must not mint acceptance PASS: ${JSON.stringify(blockedUntilReview)}`);

    assert.equal((await submitPreparedReview(client, session.session_id, [
        { check_id: 'acceptance-task-1', status: 'PASS', findings: [] },
    ])).status, 'PASSED');

    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Workspace drift after review</h1>\n');
    const staleReview = await client.evaluateCompletion(session.session_id);
    assert.equal(staleReview.verified, false);
    assert.ok(staleReview.blockers.some((blocker) => blocker.includes('SESSION_ACCEPTANCE_FAILED')),
        `review PASS must be invalidated by a later workspace mutation: ${JSON.stringify(staleReview)}`);
});

test('acceptance correction lifecycle: start, authorization, bounded files, and completion', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-lifecycle');
    const baseCommit = initGitRepo(workspaceRoot);
    fs.appendFileSync(path.join(workspaceRoot, '.git', 'info', 'exclude'), 'escape.ignored\n');
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-corr'));

    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot, authorityStore }),
        trustedQualityRunner: createPassingTrustedQualityRunner(),
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    t.after(async () => {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const client = createDaemonClient({ workspaceRoot });

    const session = await client.beginSession({
        workspace_root: workspaceRoot,
        mode: 'auto',
    });

    // 1. Register plan with task-1
    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
        acceptance_policy: acceptancePolicy(),
        tasks: [
            {
                task_id: 'task-1',
                title: 'Task 1',
                owner: 'codex',
                allowed_files: ['index.html', 'styles.css'],
                deny_patterns: ['.omni/**'],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            },
        ],
    });

    // Complete task-1 so session reaches ACCEPTANCE
    const taskLease = authorityStore.acquireLease('task-1', 'codex');
    authorityStore.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'task-1',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: sha('task1-diff'),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    authorityStore.releaseLease(taskLease.lease_id, 'test_task_completed');
    const reviewResult = await submitAcceptanceFailure(client, session.session_id);
    assert.equal(reviewResult.status, 'NEEDS_FIX');

    const preStatus = await client.status(session.session_id);
    assert.equal(preStatus.session_state, 'ACCEPTANCE');

    // 3. Before starting correction, writing index.html via hook bridge is blocked (task is already verified, no lease)
    const preHook = await evaluateHook({
        session_id: 'codex-session',
        cwd: workspaceRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-pre',
        tool_input: {
            command: '*** Update File: index.html\n+<h1>Changed</h1>\n',
        },
    });
    assert.equal(preHook.hookSpecificOutput?.permissionDecision, 'deny');

    // 4. Invalid correction attempts:
    // a) Out of task scope file
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
            task_id: 'task-1', reason: 'Try to edit outside task', allowed_files: ['unauthorized.js'],
        })),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_INVALID'
    );

    // b) Unknown task
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
            task_id: 'ghost-task', reason: 'Target ghost task',
        })),
        (err) => err.code === 'DUAL_TASK_NOT_FOUND'
    );

    // 5. Valid start of acceptance correction for index.html
    const startRes = await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1',
        reason: 'Fix heading copy discovered during acceptance review',
    }));
    assert.equal(startRes.started, true);
    assert.equal(startRes.attempt, 1);
    assert.deepEqual(startRes.allowed_files, ['index.html']);

    const corrStatus = await client.status(session.session_id);
    assert.ok(corrStatus.active_acceptance_correction);
    assert.equal(corrStatus.active_acceptance_correction.taskId, 'task-1');
    assert.equal(corrStatus.active_acceptance_correction.status, 'CORRECTING');

    // 6. Completion evaluation is blocked while correction is active
    const compEval = await client.evaluateCompletion(session.session_id);
    assert.equal(compEval.verified, false);
    assert.ok(compEval.blockers.some((b) => b.includes('ACCEPTANCE_CORRECTION_ACTIVE')));

    await assert.rejects(
        () => client.completeAcceptanceCorrection(session.session_id, { summary: 'No source change' }),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_NO_CHANGE'
    );

    // 7. Starting a second correction while active is rejected
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
            task_id: 'task-1',
            reason: 'Second correction parallel attempt',
        })),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_ACTIVE'
    );

    // 8. Hook Bridge authorization during active correction:
    // a) Allowed file: index.html
    const allowHook = await evaluateHook({
        session_id: 'codex-session',
        cwd: workspaceRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-2',
        tool_name: 'apply_patch',
        tool_use_id: 'call-corr-1',
        tool_input: {
            command: '*** Update File: index.html\n+<h1>Fixed Title</h1>\n',
        },
    }, { createClient: () => client });
    assert.deepEqual(allowHook, {});

    // b) File in task allowed_files, but NOT in this correction allowed_files: styles.css
    const denyHookScope = await evaluateHook({
        session_id: 'codex-session',
        cwd: workspaceRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-3',
        tool_name: 'apply_patch',
        tool_use_id: 'call-corr-2',
        tool_input: {
            command: '*** Update File: styles.css\n+body { background: blue; }\n',
        },
    }, { createClient: () => client });
    assert.equal(denyHookScope.hookSpecificOutput?.permissionDecision, 'deny');

    // 9. Complete correction:
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Fixed Title</h1>\n');
    fs.writeFileSync(path.join(workspaceRoot, 'styles.css'), 'body { color: blue; }\n');
    await assert.rejects(
        () => client.completeAcceptanceCorrection(session.session_id, { summary: 'Must reject unauthorized delta' }),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_SCOPE_EXCEEDED'
    );
    assert.ok((await client.status(session.session_id)).active_acceptance_correction, 'Rejected scope must not close correction authority');
    fs.writeFileSync(path.join(workspaceRoot, 'styles.css'), 'body { color: black; }\n');

    // Ignored untracked files are still source-tree mutations and must not bypass correction scope.
    fs.writeFileSync(path.join(workspaceRoot, 'escape.ignored'), 'unauthorized ignored delta\n');
    await assert.rejects(
        () => client.completeAcceptanceCorrection(session.session_id, { summary: 'Must reject ignored unauthorized delta' }),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_SCOPE_EXCEEDED'
    );
    assert.ok((await client.status(session.session_id)).active_acceptance_correction,
        'Ignored scope rejection must keep correction authority active');
    assert.equal(
        authorityStore.readEvents().some((event) => event.type === 'acceptance.correction.completed'),
        false,
        'Ignored scope rejection must not append correction completion'
    );
    fs.rmSync(path.join(workspaceRoot, 'escape.ignored'));

    const completeRes = await client.completeAcceptanceCorrection(session.session_id, {
        summary: 'Fixed heading title in index.html',
    });
    assert.equal(completeRes.completed, true);
    assert.equal(completeRes.status, 'PASSED');
    assert.ok(completeRes.diff_fingerprint);

    const postStatus = await client.status(session.session_id);
    assert.equal(postStatus.active_acceptance_correction, null);
    assert.equal(postStatus.acceptance_corrections.length, 1);
    assert.equal(postStatus.acceptance_corrections[0].status, 'PASSED');
    assert.equal(postStatus.acceptance_corrections[0].failure_check_id, 'acceptance-task-1');
    assert.equal(postStatus.gates['acceptance-acceptance-task-1'].status, 'FAILED',
        'Correction completion must not mint a review PASS gate');
    const blockedUntilFreshReview = await client.evaluateCompletion(session.session_id);
    assert.equal(blockedUntilFreshReview.verified, false);
    assert.ok(blockedUntilFreshReview.blockers.some((blocker) => blocker.includes('MANDATORY_GATE_UNMET')),
        `Changed fingerprint requires a fresh independent review before verification: ${JSON.stringify(blockedUntilFreshReview)}`);

    // A passed correction consumes the exact failed review provenance. Reusing
    // the old failure without submitting a fresh review must fail closed.
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
            task_id: 'task-1', reason: 'Attempt to reuse superseded failure',
        })),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_FAILURE_REQUIRED'
    );
    const invalidation = authorityStore.readEvents().find((event) => event.type === 'quality.generation.invalidated');
    assert.ok(invalidation, 'A changed accepted correction must invalidate the previous quality generation');
    assert.equal(invalidation.previous_fingerprint, startRes.start_fingerprint);
    assert.equal(invalidation.new_fingerprint, completeRes.diff_fingerprint);

    const reopened = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-corr'));
    const replayed = reopened.derive();
    assert.equal(replayed.acceptance_corrections[0].correction_id, completeRes.correction_id);
    assert.equal(replayed.acceptance_corrections[0].failure_check_id, 'acceptance-task-1');
    assert.equal(replayed.gates['acceptance-acceptance-task-1'].status, 'FAILED');
    assert.ok(reopened.readEvents().some((event) => event.type === 'quality.generation.invalidated'));

    const freshReviewResult = await submitPreparedReview(client, session.session_id, [
        { check_id: 'acceptance-task-1', status: 'PASS', findings: [] },
    ]);
    assert.equal(freshReviewResult.status, 'PASSED');

    for (const cycle of [1, 2, 3]) {
        const execution = await client.executeQualityCycle(session.session_id, cycle);
        const qualityRes = await client.evaluateCompletion(session.session_id, {
            quality_evidence: execution.quality_evidence,
        });
        const recordedGate = authorityStore.derive().gates[`quality-cycle-${cycle}`];
        assert.equal(recordedGate?.status, 'PASSED', JSON.stringify(recordedGate));
        assert.equal(qualityRes.verified, cycle === 3, JSON.stringify(qualityRes));
    }
    const verified = await client.evaluateCompletion(session.session_id);
    assert.equal(verified.verified, true, `New quality generation must be required before verification: ${JSON.stringify(verified)}`);
    assert.equal(authorityStore.derive().sessionState, 'VERIFIED');
});

test('acceptance correction attempt limit: enforces maximum 3 attempts per task', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-limit');
    const baseCommit = initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-limit'));

    const daemon = await startDaemonServer({
        workspaceRoot,
        authorityStore,
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    t.after(async () => {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const client = createDaemonClient({ workspaceRoot });
    const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });

    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
        acceptance_policy: acceptancePolicy(),
        tasks: [{ task_id: 'task-1', title: 'Task 1', owner: 'codex', allowed_files: ['index.html'], deny_patterns: [] }],
    });

    const taskLease = authorityStore.acquireLease('task-1', 'codex');
    authorityStore.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'task-1',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: sha('diff1'),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    authorityStore.releaseLease(taskLease.lease_id, 'test_task_completed');
    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, acceptancePolicy())).status, 'NEEDS_FIX');

    // Attempt 1
    const s1 = await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1', reason: 'Attempt 1',
    }));
    assert.equal(s1.attempt, 1);
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Corrected 1</h1>\n');
    await client.completeAcceptanceCorrection(session.session_id, { summary: 'Done 1' });

    // Attempt 2 needs a fresh failed review on a new candidate result.
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Candidate 2</h1>\n');
    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, acceptancePolicy())).status, 'NEEDS_FIX');
    const s2 = await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1', reason: 'Attempt 2',
    }));
    assert.equal(s2.attempt, 2);
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Corrected 2</h1>\n');
    await client.completeAcceptanceCorrection(session.session_id, { summary: 'Done 2' });

    // Attempt 3 also requires a new review/fingerprint.
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Candidate 3</h1>\n');
    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, acceptancePolicy())).status, 'NEEDS_FIX');
    const s3 = await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1', reason: 'Attempt 3',
    }));
    assert.equal(s3.attempt, 3);
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Corrected 3</h1>\n');
    await client.completeAcceptanceCorrection(session.session_id, { summary: 'Done 3' });

    // A fresh failure cannot bypass the bounded attempt limit.
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Candidate 4</h1>\n');
    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, acceptancePolicy())).status, 'NEEDS_FIX');
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
            task_id: 'task-1', reason: 'Attempt 4 exceeded',
        })),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_LIMIT_EXCEEDED'
    );
});

test('failed acceptance correction blocks session completion and verification until repaired', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-fail');
    const baseCommit = initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-fail'));

    const daemon = await startDaemonServer({
        workspaceRoot,
        authorityStore,
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    t.after(async () => {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const client = createDaemonClient({ workspaceRoot });
    const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });
    const correctionPolicy = acceptancePolicy({
        correctionCommand: { program: 'node', args: ['-e', "process.exit(Number(require('fs').readFileSync('.omni/correction-status', 'utf8')))"], cwd: '.' },
    });

    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
        acceptance_policy: correctionPolicy,
        tasks: [{ task_id: 'task-1', title: 'Task 1', owner: 'codex', allowed_files: ['index.html'], deny_patterns: [] }],
    });

    const taskLease = authorityStore.acquireLease('task-1', 'codex');
    authorityStore.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'task-1',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: sha('diff1'),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    authorityStore.releaseLease(taskLease.lease_id, 'test_task_completed');
    fs.writeFileSync(path.join(workspaceRoot, '.omni', 'correction-status'), '1');
    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, correctionPolicy)).status, 'NEEDS_FIX');

    // Start correction and fail it via command failure
    await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1',
        reason: 'Correction that fails validation',
    }));

    const failRes = await client.completeAcceptanceCorrection(session.session_id);
    assert.equal(failRes.status, 'FAILED');

    // Completion evaluation must report blocker
    const evalFail = await client.evaluateCompletion(session.session_id);
    assert.equal(evalFail.verified, false);
    assert.ok(evalFail.blockers.some((b) => b.includes('ACCEPTANCE_CORRECTION_FAILED')));
    fs.writeFileSync(path.join(workspaceRoot, '.omni', 'correction-status'), '0');

    // Attempting session.verified directly must throw integrity corrupt error
    assert.throws(
        () => authorityStore.append({
            schema_version: 2,
            type: 'session.verified',
            from_state: 'ACCEPTANCE',
            to_state: 'VERIFIED',
            receipt_sha256: sha('fake-receipt'),
            completed_tasks: ['task-1'],
        }),
        (err) => err.code === 'DUAL_INTEGRITY_CORRUPT' && err.message.includes('unpassed acceptance correction')
    );

    // A failed correction consumed its original failure. Repair requires a
    // changed candidate and a fresh independent review failure first.
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Candidate 2</h1>\n');
    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, correctionPolicy)).status, 'NEEDS_FIX');

    // Repair via Attempt 2
    await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1',
        reason: 'Repair attempt 1',
    }));
    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Repaired Candidate 2</h1>\n');
    const passRes = await client.completeAcceptanceCorrection(session.session_id);
    assert.equal(passRes.status, 'PASSED');

    const evalPass = await client.evaluateCompletion(session.session_id);
    assert.ok(!evalPass.blockers.some((b) => b.includes('ACCEPTANCE_CORRECTION_FAILED')));
});

test('acceptance correction validator: async responsiveness, mutation fence, and durable ledger records', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-resp');
    const baseCommit = initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-corr-resp'));

    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot, authorityStore }),
        trustedQualityRunner: createPassingTrustedQualityRunner(),
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    t.after(async () => {
        try { await daemon.close(); } catch {}
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    const client = createDaemonClient({ workspaceRoot, timeoutMs: 20000 });
    const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });

    // Slow validator command (3 seconds)
    const slowCorrectionPolicy = acceptancePolicy({
        correctionCommand: {
            program: 'node',
            args: ['-e', 'setTimeout(() => { process.exit(0); }, 3000)'],
            cwd: '.',
        },
    });

    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
        acceptance_policy: slowCorrectionPolicy,
        tasks: [{ task_id: 'task-1', title: 'Task 1', owner: 'codex', allowed_files: ['index.html'], deny_patterns: [] }],
    });

    const taskLease = authorityStore.acquireLease('task-1', 'codex');
    authorityStore.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'task-1',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: sha('diff1'),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    authorityStore.releaseLease(taskLease.lease_id, 'test_task_completed');

    assert.equal((await submitAcceptanceFailure(client, session.session_id, workspaceRoot, baseCommit, slowCorrectionPolicy)).status, 'NEEDS_FIX');

    const correction = await client.startAcceptanceCorrection(session.session_id, correctionPrereqs(workspaceRoot, baseCommit, authorityStore, {
        task_id: 'task-1',
        reason: 'Async correction test',
    }));

    fs.writeFileSync(path.join(workspaceRoot, 'index.html'), '<h1>Corrected async</h1>\n');

    // Launch completion (which runs the 3-second validator)
    const completionPromise = client.completeAcceptanceCorrection(session.session_id, {
        correction_id: correction.correction_id,
    });

    // Wait 300ms for child process to be active
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Health must remain responsive (< 1000ms)
    const healthStart = Date.now();
    const healthRes = await client.health();
    const healthElapsed = Date.now() - healthStart;
    assert.equal(healthRes.status, 'healthy');
    assert.ok(healthElapsed < 1000, `health took ${healthElapsed}ms, expected < 1000ms`);

    // Status must remain responsive (< 1000ms)
    const statusStart = Date.now();
    const statusRes = await client.status(session.session_id);
    const statusElapsed = Date.now() - statusStart;
    assert.ok(statusRes && statusRes.session_id === session.session_id);
    assert.ok(statusElapsed < 1000, `status took ${statusElapsed}ms, expected < 1000ms`);

    // Conflicting stop during active run is rejected with 409
    await assert.rejects(
        () => client.stop(),
        (err) => err.code === 'DUAL_VALIDATOR_ACTIVE' || err.code === 'DUAL_VALIDATOR_BUSY'
    );

    // Await completion result
    const completed = await completionPromise;
    assert.equal(completed.status, 'PASSED');

    // Verify durable validator lifecycle records in validators.ndjson
    const validatorRecords = authorityStore.readValidatorRecords();
    const correctionRecords = validatorRecords.filter((r) => r.purpose === 'acceptance-correction');
    assert.ok(correctionRecords.length >= 2, `expected at least 2 correction records, found ${correctionRecords.length}`);
    const started = correctionRecords.find((r) => r.type === 'started');
    const settled = correctionRecords.find((r) => r.type === 'settled');
    assert.ok(started, 'started validator record must exist');
    assert.ok(settled, 'settled validator record must exist');
    assert.equal(started.run_id, settled.run_id);
    assert.equal(started.session_id, session.session_id);
    assert.equal(settled.outcome, 'passed');
    assert.equal(settled.exit_code, 0);
});

