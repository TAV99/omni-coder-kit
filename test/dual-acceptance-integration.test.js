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

test('isolated QC enforces pre-integration review evidence before integrating task', async (t) => {
    const { completeIsolatedTask } = require('../lib/dual/isolated-qc');
    const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
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

    const adapter = createOrchestratorAdapter({
        workspaceRoot: root, authorityStore: store, processRunner: fakeWorker,
    });
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

    // 2. With failing review evidence: completeIsolatedTask must return NEEDS_FIX and not integrate
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
    assert.equal(failRes.status, 'NEEDS_FIX');
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'root files untouched');

    // 3. With passing review evidence: completeIsolatedTask integrates and sets TASK_VERIFIED
    const passingEvidence = withEvidenceDigest({
        policy_sha256: policySha,
        task_id: 'TASK-1',
        result_sha256: handoff.result_sha256,
        check_results: [
            { check_id: 'review-task1', status: 'PASS', findings: [] },
        ],
    });
    const passRes = await completeIsolatedTask({ ...qcRequest, reviewEvidence: passingEvidence });
    assert.equal(passRes.status, 'TASK_VERIFIED');
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 2;\n', 'root files integrated');
    assert.ok(store.derive().gates['acceptance-review-task1']);
    assert.equal(store.derive().gates['acceptance-review-task1'].status, 'PASSED');
});
