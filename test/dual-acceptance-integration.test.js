'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const {
    hashAcceptancePolicy,
    hashReviewEvidence,
    evaluatePreIntegrationReview,
} = require('../lib/dual/acceptance-policy');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { captureDiffFingerprint } = require('../lib/dual/scope-guard');

const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');
const withEvidenceDigest = (evidence) => ({ ...evidence, evidence_sha256: hashReviewEvidence(evidence) });

function createTempDir(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync.native(require('node:os').tmpdir()), `${prefix}-`));
}

function initGitRepo(dir) {
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
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

test('plan registration stores acceptance policy and hash in authority ledger and derived state', async () => {
    const workspaceRoot = createTempDir('dual-acceptance-reg');
    initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot,
        authorityStore,
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    const client = createDaemonClient({ workspaceRoot });

    try {
        const session = await client.beginSession({
            workspace_root: workspaceRoot,
            mode: 'auto',
        });

        // 1. Attempting to register invalid acceptance policy (targeting nonexistent task) must fail 400
        const invalidPolicy = {
            protocol_version: 1,
            checks: [
                {
                    id: 'review-ghost',
                    requirement_id: 'REQ-1',
                    task_id: 'ghost-task',
                    phase: 'pre_integration',
                    kind: 'review',
                    required: true,
                },
            ],
        };
        await assert.rejects(
            () => client.registerPlan(session.session_id, {
                plan_path: '.omni/plan.json',
                plan_sha256: sha('invalid'),
                acceptance_policy: invalidPolicy,
                tasks: [
                    {
                        task_id: 'task-1',
                        title: 'Task 1',
                        owner: 'codex',
                        allowed_files: ['README.md'],
                        context_files: [],
                        deny_patterns: ['.omni/**'],
                        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                    },
                ],
            }),
            (err) => err.code === 'DUAL_ACCEPTANCE_POLICY_INVALID' || err.code === 'DUAL_PLAN_INVALID'
        );

        // 2. Register valid policy
        const policy = {
            protocol_version: 1,
            checks: [
                {
                    id: 'review-task1',
                    requirement_id: 'REQ-1',
                    task_id: 'task-1',
                    phase: 'pre_integration',
                    kind: 'review',
                    required: true,
                },
                {
                    id: 'session-check',
                    requirement_id: 'REQ-FINAL',
                    phase: 'session',
                    kind: 'review',
                    required: true,
                },
            ],
        };

        const planPayload = {
            plan_path: '.omni/plan.json',
            plan_sha256: sha(JSON.stringify({ test: 1 })),
            acceptance_policy: policy,
            tasks: [
                {
                    task_id: 'task-1',
                    title: 'Task 1',
                    owner: 'codex',
                    allowed_files: ['README.md'],
                    context_files: [],
                    deny_patterns: ['.omni/**'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                },
            ],
        };

        const planRes = await client.registerPlan(session.session_id, planPayload);
        assert.equal(planRes.registered, true);

        const status = await client.status(session.session_id);
        assert.ok(['PLANNED', 'EXECUTING'].includes(status.session_state));
        assert.ok(status.plan);
        assert.deepEqual(status.plan.acceptance_policy, policy);
        assert.equal(status.plan.acceptance_policy_sha256, hashAcceptancePolicy(policy));
    } finally {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('session completion blocks when mandatory session acceptance checks are not satisfied', async () => {
    const workspaceRoot = createTempDir('dual-session-acc');
    initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-2'));

    const daemon = await startDaemonServer({
        workspaceRoot,
        authorityStore,
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    const client = createDaemonClient({ workspaceRoot });

    try {
        const session = await client.beginSession({
            workspace_root: workspaceRoot,
            mode: 'auto',
        });

        const policy = {
            protocol_version: 1,
            checks: [
                {
                    id: 'session-e2e',
                    requirement_id: 'REQ-E2E',
                    phase: 'session',
                    kind: 'review',
                    required: true,
                },
            ],
        };

        await client.registerPlan(session.session_id, {
            plan_path: '.omni/plan.json',
            plan_sha256: sha('plan'),
            acceptance_policy: policy,
            tasks: [
                {
                    task_id: 'task-1',
                    title: 'Task 1',
                    owner: 'codex',
                    allowed_files: ['README.md'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                },
            ],
        });

        // Evaluate completion before task is verified -> blocked
        const eval1 = await client.evaluateCompletion(session.session_id);
        assert.equal(eval1.verified, false);
        assert.ok(eval1.blockers.some((b) => b.includes('TASK_UNVERIFIED')));
        assert.ok(eval1.blockers.some((b) => b.includes('SESSION_ACCEPTANCE_MISSING')));
    } finally {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('daemon derives UI authority from persisted policy and rejects mismatched evidence before append', async () => {
    const workspaceRoot = createTempDir('dual-ui-policy');
    const baseCommit = initGitRepo(workspaceRoot);
    const authorityDir = path.join(workspaceRoot, '.omni', 'sessions', 'test-ui-policy');
    const authorityStore = createAuthorityStore(authorityDir);
    let daemon = await startDaemonServer({
        workspaceRoot,
        authorityStore,
        preflightRunner: mockPreflightRunner,
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    let client = createDaemonClient({ workspaceRoot, timeoutMs: 10000 });

    try {
        const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });
        const policy = {
            protocol_version: 1,
            checks: [],
            ui: { required: true, viewport_widths: [390, 768], reduced_motion_required: true },
        };
        await client.registerPlan(session.session_id, {
            plan_path: '.omni/plan.json',
            plan_sha256: sha('ui-policy-plan'),
            acceptance_policy: policy,
            tasks: [{
                task_id: 'task-1', title: 'Task 1', owner: 'codex',
                allowed_files: ['README.md'], context_files: [], deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            }],
        });

        const missing = await client.evaluateCompletion(session.session_id);
        assert.equal(missing.verified, false);
        assert.ok(missing.blockers.some((blocker) => blocker.includes('UI_EVIDENCE_MISSING')));

        const sourceFingerprint = captureDiffFingerprint({
            repoRoot: workspaceRoot,
            baseCommit,
            excludedPaths: ['.omni'],
        }).patchSha256;
        const valid = {
            requirement: {
                gate_id: 'responsive_visual_qa', required: true,
                viewport_widths: [390, 768], reduced_motion_required: true,
            },
            evidence: {
                runtime_status: 'AVAILABLE', evidence_sha256: sha('ui-evidence'),
                policy_sha256: hashAcceptancePolicy(policy),
                source_fingerprint: sourceFingerprint,
                requested_viewports: [390, 768],
                artifact_hashes: [sha('shot-390'), sha('shot-768')],
                viewports: [
                    { width: 390, passed: true, horizontal_overflow: false },
                    { width: 768, passed: true, horizontal_overflow: false },
                ],
                reduced_motion: { tested: true, passed: true },
            },
        };
        const ledgerPath = path.join(authorityDir, 'events.ndjson');
        const mutations = [
            { label: 'required', payload: { ...valid, requirement: { ...valid.requirement, required: false } } },
            { label: 'viewports', payload: { ...valid, requirement: { ...valid.requirement, viewport_widths: [390] } } },
            { label: 'reduced motion', payload: { ...valid, requirement: { ...valid.requirement, reduced_motion_required: false } } },
            { label: 'policy hash', payload: { ...valid, evidence: { ...valid.evidence, policy_sha256: '0'.repeat(64) } } },
            { label: 'source fingerprint', payload: { ...valid, evidence: { ...valid.evidence, source_fingerprint: '0'.repeat(64) } } },
            { label: 'requested viewports', payload: { ...valid, evidence: { ...valid.evidence, requested_viewports: [390] } } },
        ];
        for (const mutation of mutations) {
            const before = fs.readFileSync(ledgerPath);
            await assert.rejects(
                () => client.evaluateCompletion(session.session_id, { ui_evidence: mutation.payload }),
                (error) => /^DUAL_UI_(POLICY|BINDING|GATE)/.test(error.code),
                mutation.label
            );
            assert.deepEqual(fs.readFileSync(ledgerPath), before, `${mutation.label} rejection must not append`);
        }

        const beforeForgedAvailable = fs.readFileSync(ledgerPath);
        await assert.rejects(
            () => client.evaluateCompletion(session.session_id, { ui_evidence: valid }),
            (error) => error?.code === 'DUAL_UI_ATTESTATION_REQUIRED'
        );
        assert.deepEqual(fs.readFileSync(ledgerPath), beforeForgedAvailable, 'Caller-supplied AVAILABLE evidence must not append without a trusted adapter run');

        await daemon.close();
        const runUiDir = path.join(workspaceRoot, '.omni', 'runs', 'dual-authority', 'ui');
        fs.mkdirSync(runUiDir, { recursive: true });
        const artifactPaths = [path.join(runUiDir, '390.png'), path.join(runUiDir, '768.png')];
        fs.writeFileSync(artifactPaths[0], Buffer.from('trusted-390'));
        fs.writeFileSync(artifactPaths[1], Buffer.from('trusted-768'));
        const artifactHashes = artifactPaths.map((artifactPath) => sha(fs.readFileSync(artifactPath)));
        const evidenceData = {
            runtime_status: 'AVAILABLE',
            policy_sha256: hashAcceptancePolicy(policy),
            source_fingerprint: sourceFingerprint,
            requested_viewports: [390, 768],
            viewports: [
                { width: 390, passed: false, horizontal_overflow: true },
                { width: 768, passed: true, horizontal_overflow: false },
            ],
            reduced_motion: { tested: true, passed: false },
        };
        const trustedEvidence = {
            ...evidenceData,
            artifact_hashes: artifactHashes,
            evidence_sha256: sha(JSON.stringify({ evidenceData, artifactHashes })),
        };
        let adapterCalls = 0;
        daemon = await startDaemonServer({
            workspaceRoot,
            authorityStore,
            preflightRunner: mockPreflightRunner,
            planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
            trustedUiAdapter: async () => {
                adapterCalls += 1;
                return { evidence: trustedEvidence, artifact_paths: artifactPaths };
            },
        });
        client = createDaemonClient({ workspaceRoot, timeoutMs: 10000 });
        const trustedResult = await client.evaluateCompletion(session.session_id, {
            ui_evidence: { requirement: valid.requirement, evidence: trustedEvidence },
        });
        assert.equal(trustedResult.verified, false);
        assert.equal(adapterCalls, 1);
        assert.equal(authorityStore.derive().gates.responsive_visual_qa.status, 'FAILED');

        const forgedPassEvidence = {
            ...trustedEvidence,
            viewports: trustedEvidence.viewports.map((viewport) => ({ ...viewport, passed: true, horizontal_overflow: false })),
            reduced_motion: { tested: true, passed: true },
        };
        const eventsBeforeForgedReplay = authorityStore.readEvents().length;
        await assert.rejects(
            () => client.evaluateCompletion(session.session_id, {
                ui_evidence: { requirement: valid.requirement, evidence: forgedPassEvidence },
            }),
            (error) => error?.code === 'DUAL_UI_ATTESTATION_INVALID'
        );
        assert.equal(adapterCalls, 1, 'Forged replay must not re-run or replace the attested adapter result');
        assert.equal(authorityStore.readEvents().length, eventsBeforeForgedReplay, 'Changed replay measurements must not append');
        assert.equal(authorityStore.derive().gates.responsive_visual_qa.status, 'FAILED');

        fs.writeFileSync(artifactPaths[0], Buffer.from('tampered-390'));
        const eventsBeforeTamperedRetry = authorityStore.readEvents().length;
        await assert.rejects(
            () => client.evaluateCompletion(session.session_id, {
                ui_evidence: { requirement: valid.requirement, evidence: trustedEvidence },
            }),
            (error) => error?.code === 'DUAL_UI_ARTIFACT_HASH_MISMATCH'
        );
        assert.equal(adapterCalls, 1, 'Idempotent retry must use the private current-process registry');
        assert.equal(authorityStore.readEvents().length, eventsBeforeTamperedRetry, 'Tampered UI retry must not append');
    } finally {
        await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('isolated QC enforces pre-integration review evidence before integrating task', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
    const { withDiscussion } = require('./helpers/dual-discussion-stub');
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');

    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dual-qc-acceptance-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');

    const dir = path.join(root, '.omni/runs/dual-authority');
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const store = createAuthorityStore(dir);

    const policy = {
        protocol_version: 1,
        checks: [
            {
                id: 'review-task1',
                requirement_id: 'REQ-1',
                task_id: 'TASK-1',
                phase: 'pre_integration',
                kind: 'review',
                required: true,
            },
        ],
    };

    const task = {
        task_id: 'TASK-1',
        goal: 'Return two',
        allowed_files: ['index.js'],
        context_files: ['spec.md'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }],
    };

    store.append({
        schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-qc', plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto',
    });
    writeInitialSnapshot({
        authorityDir: dir, sessionId: 'session-qc', workspaceId: 'workspace-test',
        workspaceRoot: root, identity: snapshot.identity, manifest: snapshot.manifest,
    });
    store.append({
        schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.0.0', agy_model: 'gemini-3.7-flash-high' },
    });
    store.append({
        schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ ...task, title: 'Task one', owner: 'agy', risk: 'low', execution_mode: 'isolated' }],
        acceptance_policy: policy,
        acceptance_policy_sha256: hashAcceptancePolicy(policy),
    });
    store.append({
        schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: task.allowed_files, model: 'gemini-3.7-flash-high', reason: 'Private task',
    });

    const fakeWorker = async (invocation) => {
        const taskId = 'TASK-1';
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) {
            payload = {
                ...common, summary: 'Read index', relevant_files: [{ path: 'index.js', description: 'return value' }],
                exact_symbols: [], validation_commands: ['node --check index.js'], constraints: ['scope only'], risks: [], open_questions: [],
                research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'What to change?', source,
                    source_type: 'REPOSITORY', conclusion: 'Return two' })),
                alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
                failure_modes: ['wrong return value'],
            };
        } else if (prompt.includes('implement phase')) {
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            payload = {
                ...common, status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['syntax', 'scope', 'value'], remaining_risks: [] },
            };
        } else {
            payload = {
                ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
                review_checks: ['syntax', 'scope', 'value'], challenge_summary: 'Compared returns',
            };
        }
        return {
            exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1,
        };
    };

    const adapter = createOrchestratorAdapter(withDiscussion({
        workspaceRoot: root, authorityStore: store, processRunner: fakeWorker,
    }));
    await adapter.runTask(store.derive());

    const qcRequest = {
        workspaceRoot: root, authorityStore: store,
        sessionId: 'session-qc', taskId: 'TASK-1', planRevision: 1,
    };

    // 1. Without review evidence: completeIsolatedTask must fail closed (NEEDS_REVIEW) and not integrate
    const missingRes = await completeIsolatedTask(qcRequest);
    assert.equal(missingRes.status, 'NEEDS_REVIEW');
    assert.deepEqual(missingRes.missing, ['review-task1']);
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'root files untouched');

    // 2. Caller-computable review evidence is never trusted and cannot integrate.
    const handoff = store.derive().tasks['TASK-1'].isolatedHandoff;
    const policySha = hashAcceptancePolicy(policy);
    const failingEvidence = withEvidenceDigest({
        policy_sha256: policySha,
        task_id: 'TASK-1',
        result_sha256: handoff.result_sha256,
        check_results: [
            { check_id: 'review-task1', status: 'FAIL', findings: ['Syntax issue spotted by reviewer'] },
        ],
    });
    const failRes = await completeIsolatedTask({ ...qcRequest, reviewEvidence: failingEvidence });
    assert.equal(failRes.status, 'NEEDS_REVIEW');
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'root files untouched');

    // 3. A forged PASS remains untrusted.
    const passingEvidence = withEvidenceDigest({
        policy_sha256: policySha,
        task_id: 'TASK-1',
        result_sha256: handoff.result_sha256,
        check_results: [
            { check_id: 'review-task1', status: 'PASS', findings: [] },
        ],
    });
    const forgedPassRes = await completeIsolatedTask({ ...qcRequest, reviewEvidence: passingEvidence });
    assert.equal(forgedPassRes.status, 'NEEDS_REVIEW');
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'root files untouched');

    // 4. Only a daemon-issued execution and daemon-persisted attestation can authorize integration.
    let daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    t.after(async () => daemon.close());
    const client = createDaemonClient({ workspaceRoot: root, timeoutMs: 10000 });
    await assert.rejects(
        () => client.submitAcceptanceReview('session-qc', 'TASK-1', 1, passingEvidence),
        (error) => error.code === 'DUAL_REVIEW_ATTESTATION_REQUIRED'
    );
    const prepared = await client.prepareAcceptanceReview('session-qc', 'TASK-1', 1);
    assert.equal(prepared.review_phase, 'pre_integration');
    await daemon.close();
    daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    const eventsBeforeIncomplete = store.readEvents().length;
    const incomplete = await client.submitAcceptanceReview('session-qc', 'TASK-1', 1, {
        review_execution_id: prepared.review_execution_id,
        check_results: [],
    });
    assert.equal(incomplete.status, 'NEEDS_REVIEW');
    assert.equal(store.readEvents().length, eventsBeforeIncomplete,
        'incomplete findings must not consume the single-use review execution');
    const submitted = await client.submitAcceptanceReview('session-qc', 'TASK-1', 1, {
        review_execution_id: prepared.review_execution_id,
        check_results: [{ check_id: 'review-task1', status: 'PASS', findings: [] }],
    });
    assert.equal(submitted.status, 'PASSED');
    const preparedRetry = await client.prepareAcceptanceReview('session-qc', 'TASK-1', 1);
    assert.equal(preparedRetry.review_execution_id, prepared.review_execution_id,
        'same candidate binding must reuse the consumed execution and stay immutable');
    const replayed = await client.submitAcceptanceReview('session-qc', 'TASK-1', 1, {
        review_execution_id: prepared.review_execution_id,
        check_results: [{ check_id: 'review-task1', status: 'PASS', findings: [] }],
    });
    assert.equal(replayed.attestation_sha256, submitted.attestation_sha256);
    await assert.rejects(
        () => client.submitAcceptanceReview('session-qc', 'TASK-1', 1, {
            review_execution_id: prepared.review_execution_id,
            check_results: [{ check_id: 'review-task1', status: 'FAIL', findings: ['changed'] }],
        }),
        (error) => error.code === 'DUAL_ACCEPTANCE_EVIDENCE_CONFLICT'
    );

    const passRes = await completeIsolatedTask(qcRequest);
    assert.equal(passRes.status, 'TASK_VERIFIED');
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 2;\n', 'root files integrated');
    assert.ok(store.derive().gates['acceptance-review-task1']);
    assert.equal(store.derive().gates['acceptance-review-task1'].status, 'PASSED');
});
