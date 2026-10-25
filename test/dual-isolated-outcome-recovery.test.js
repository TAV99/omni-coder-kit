'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { createAuthorityStore, DualAuthorityError } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { readTaskBinding } = require('../lib/dual/task-workspace');
const { withDiscussion } = require('./helpers/dual-discussion-stub');
const authority = require('../lib/dual/isolated-authority');
const sha = content => crypto.createHash('sha256').update(content).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readEvents = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
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


async function pollTask(client, sessionId, predicate, message, deadlineMs = 10000) {
    const deadline = Date.now() + deadlineMs;
    do {
        const status = await client.status(sessionId);
        const task = status.tasks?.['task-1'];
        if (predicate(task, status)) return task;
        await pause(25);
    } while (Date.now() < deadline);
    assert.fail(message);
}

for (const killed of [true, false]) {
    test(`daemon resume ${killed ? '(b) recovers killed review in same attempt' : "(c') preserves real seed failure"}`, async t => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-outcome-recovery-'));
        initGitRepo(workspaceRoot);
        const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni/sessions/recovery'));
        const base = withDiscussion({ workspaceRoot, authorityStore, processRunner: publicDaemonWorker() });
        let reviewResolves = 0;
        const discussion = { ...base.discussion, async createIsolatedDiscussion(context) {
            const child = await base.discussion.createIsolatedDiscussion(context);
            return { ...child, async sessionResolver(args) {
                if (args.phase === 'review' && ++reviewResolves === 1) {
                    throw Object.assign(new Error(killed
                        ? 'Codex seed failed (exit=null, timedOut=true, overflowed=false): killed'
                        : 'Codex seed failed (exit=1, timedOut=false, overflowed=false): failed'),
                    { details: { conversationIds: {} } });
                }
                return child.sessionResolver(args);
            } };
        } };
        const daemon = await startDaemonServer({ workspaceRoot, authorityStore,
            workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', preflightRunner: mockPreflightRunner,
            orchestrator: createOrchestratorAdapter({ ...base, discussion }),
            planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
        });
        t.after(async () => { await daemon.close(); fs.rmSync(workspaceRoot, { recursive: true, force: true }); });
        const client = createDaemonClient({ workspaceRoot, timeoutMs: 5000 });
        const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });
        await client.registerPlan(session.session_id, {
            plan_path: '.omni/plan.json', plan_sha256: sha('plan'),
            // Raw omission remains covered by dual-flow-checkpoints.test.js;
            // supply the neutral policy at this fixture boundary.
            acceptance_policy: {
                protocol_version: 1,
                checks: [],
                ui: {
                    required: false,
                    viewport_widths: [390, 768, 1024, 1440],
                    reduced_motion_required: true,
                },
            },
            tasks: [{ task_id: 'task-1', title: 'Task 1', goal: 'Update heading', owner: 'agy',
                execution_mode: 'isolated', allowed_files: ['index.html'], deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] }],
        });
        await client.resumeSession(session.session_id);
        const first = await pollTask(client, session.session_id, task => task?.lastOutcome
            && !Object.values(authorityStore.derive().leases).some(lease => lease.status === 'active'), 'first outcome missing');
        assert.equal(first.lastOutcome.status, 'FAILED');
        assert.equal(first.lastOutcome.code, 'DUAL_WORKER_EXECUTION_FAILED');
        assert.ok(!first.isolatedHandoff);
        const { workerRoot } = readTaskBinding(workspaceRoot, first.isolatedWorkspace.reference);
        const runDir = path.join(workerRoot, '.omni/codex-gemini/runs/task-1');
        const eventsFile = path.join(runDir, 'events.ndjson');
        assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'raw/review.1.failure.json'))).retryable, killed);
        const before = readEvents(eventsFile);
        assert.ok(before.some(event => event.type === 'phase.failed' && event.phase === 'review' && event.retryable === killed));
        assert.ok(before.some(event => event.type === 'phase.completed' && event.phase === 'scout'));
        await client.resumeSession(session.session_id);
        if (killed) {
            const recovered = await pollTask(client, session.session_id, task => task?.isolatedHandoff,
                'no handoff after resume 2: adapter returned old outcome');
            assert.equal(recovered.isolatedWorkspace.attempt, first.isolatedWorkspace.attempt);
            assert.equal(recovered.isolatedWorkspace.reference.bindingSha256, first.isolatedWorkspace.reference.bindingSha256);
            assert.ok(!recovered.correction);
            assert.ok(!recovered.lastOutcome);
            assert.deepEqual(recovered.recoveredOutcomes[0], { ...first.lastOutcome,
                recovered_at: recovered.recoveredOutcomes[0].recovered_at,
                recovery_phase: 'review', recovery_error_code: 'DUAL_DISCUSSION_FAILED' });
            const event = authorityStore.readEvents().find(e => e.type === 'task.execution.outcome.recovered');
            assert.ok(event);
            for (const key of ['attempt', 'status', 'code', 'summary']) assert.equal(event[`previous_${key}`], first.lastOutcome[key]);
            const after = readEvents(eventsFile);
            const failed = after.findIndex(e => e.type === 'phase.failed' && e.phase === 'review');
            assert.ok(after.slice(failed + 1).some(e => e.type === 'phase.started' && e.phase === 'review' && e.attempt === 2));
            assert.ok(after.slice(failed + 1).some(e => e.type === 'phase.completed' && e.phase === 'review'));
        } else {
            await pause(200);
            const unchanged = (await client.status(session.session_id)).tasks['task-1'];
            assert.deepEqual(unchanged.lastOutcome, first.lastOutcome);
            assert.ok(!unchanged.isolatedHandoff);
            assert.ok(!authorityStore.readEvents().some(e => e.type === 'task.execution.outcome.recovered'));
            assert.equal(reviewResolves, 1);
            assert.ok(!readEvents(eventsFile).some(e => e.phase === 'review' && e.attempt === 2));
        }
    });
}

function candidateTask() {
    return { task_id: 'task-1', isolatedWorkspace: { attempt: 2, reference: {} },
        lastOutcome: { attempt: 2, status: 'FAILED', code: 'DUAL_WORKER_EXECUTION_FAILED', summary: 'failure' } };
}
const interruptedReview = { type: 'phase.failed', phase: 'review', attempt: 1,
    retryable: true, error_code: 'DUAL_DISCUSSION_FAILED' };

test('pure classifier requires matching failed outcome and unfinished discussion phase, independent of phase attempt', () => {
    const task = candidateTask();
    assert.equal(authority.isKillCausedExecutionOutcome(task, [interruptedReview]), true);
    assert.equal(authority.isKillCausedExecutionOutcome(task, [
        { type: 'phase.completed', phase: 'scout' }, interruptedReview,
    ]), true);
    const rejected = [
        [{ ...task, lastOutcome: { ...task.lastOutcome, attempt: 1 } }, [interruptedReview]],
        [{ ...task, lastOutcome: { ...task.lastOutcome, status: 'NEEDS_FIX' } }, [interruptedReview]],
        [{ ...task, lastOutcome: { ...task.lastOutcome, code: 'OTHER' } }, [interruptedReview]],
        [{ ...task, isolatedHandoff: {} }, [interruptedReview]],
        [{ ...task, correction: {} }, [interruptedReview]],
        [{ ...task, isolatedWorkspace: undefined }, [interruptedReview]],
        [task, []], [task, null], [null, [interruptedReview]],
        [task, [{ ...interruptedReview, retryable: false }]],
        [task, [{ ...interruptedReview, retryable: undefined }]],
        [task, [{ ...interruptedReview, phase: 'implement' }]],
        [task, [{ ...interruptedReview, error_code: 'DUAL_AGY_FAILED' }]],
        [task, [interruptedReview, { type: 'phase.completed', phase: 'review' }]],
        [task, [interruptedReview, { type: 'phase.failed', phase: 'implement', retryable: false }]],
    ];
    for (const [input, events] of rejected) assert.equal(authority.isKillCausedExecutionOutcome(input, events), false);
});

test('binding/events resolver fails closed for missing or corrupt binding', () => {
    assert.equal(authority.resolveKillDiscussionRecovery('/nonexistent', candidateTask()), null);
});

test('pure classifier preserves worker-lost settlement, implement-only and terminal review failures (d)', () => {
    const task = candidateTask();
    assert.equal(authority.isKillCausedExecutionOutcome({ ...task,
        lastOutcome: { ...task.lastOutcome, code: 'DUAL_WORKER_LOST' },
    }, [interruptedReview]), false);
    assert.equal(authority.isKillCausedExecutionOutcome(task, [
        { ...interruptedReview, phase: 'implement' },
    ]), false);
    assert.equal(authority.isKillCausedExecutionOutcome(task, [
        { ...interruptedReview, retryable: false },
    ]), false);
});

async function setupKilledTaskFixture(t) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-outcome-recovery-'));
    initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni/sessions/recovery'));
    const base = withDiscussion({ workspaceRoot, authorityStore, processRunner: publicDaemonWorker() });
    let reviewResolves = 0;
    const discussion = { ...base.discussion, async createIsolatedDiscussion(context) {
        const child = await base.discussion.createIsolatedDiscussion(context);
        return { ...child, async sessionResolver(args) {
            if (args.phase === 'review' && ++reviewResolves === 1) {
                throw Object.assign(new Error('Codex seed failed (exit=null, timedOut=true, overflowed=false): killed'),
                    { details: { conversationIds: {} } });
            }
            return child.sessionResolver(args);
        } };
    } };
    const daemon = await startDaemonServer({ workspaceRoot, authorityStore,
        workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', preflightRunner: mockPreflightRunner,
        orchestrator: createOrchestratorAdapter({ ...base, discussion }),
        planArtifactVerifier: async (_root, p) => ({ plan_path: p.plan_path, plan_sha256: p.plan_sha256 }),
    });
    t.after(async () => { await daemon.close(); fs.rmSync(workspaceRoot, { recursive: true, force: true }); });
    const client = createDaemonClient({ workspaceRoot, timeoutMs: 5000 });
    const session = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });
    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json', plan_sha256: sha('plan'),
        acceptance_policy: {
            protocol_version: 1,
            checks: [],
            ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true },
        },
        tasks: [{ task_id: 'task-1', title: 'Task 1', goal: 'Update heading', owner: 'agy',
            execution_mode: 'isolated', allowed_files: ['index.html'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] }],
    });
    await client.resumeSession(session.session_id);
    const task = await pollTask(client, session.session_id, item => item?.lastOutcome
        && !Object.values(authorityStore.derive().leases).some(lease => lease.status === 'active'), 'first outcome missing');
    const { workerRoot } = readTaskBinding(workspaceRoot, task.isolatedWorkspace.reference);
    const eventsFile = path.join(workerRoot, '.omni/codex-gemini/runs/task-1/events.ndjson');
    return { workspaceRoot, task, workerRoot, eventsFile };
}

test('binding/events resolver fails closed for actual corrupt NDJSON events file (P2.1)', async (t) => {
    const { workspaceRoot, task, eventsFile } = await setupKilledTaskFixture(t);
    assert.deepEqual(authority.resolveKillDiscussionRecovery(workspaceRoot, task), {
        recoveryPhase: 'review',
        recoveryErrorCode: 'DUAL_DISCUSSION_FAILED',
    });
    fs.writeFileSync(eventsFile, '{"type":"phase.started"}\n{"type":"phase.failed", malformed\n');
    assert.equal(authority.resolveKillDiscussionRecovery(workspaceRoot, task), null);
});

test('binding/events resolver fails closed when task binding mismatches taskId or attempt (gap)', async (t) => {
    const { workspaceRoot, task } = await setupKilledTaskFixture(t);
    assert.deepEqual(authority.resolveKillDiscussionRecovery(workspaceRoot, task), {
        recoveryPhase: 'review',
        recoveryErrorCode: 'DUAL_DISCUSSION_FAILED',
    });

    const mismatchedTaskIdTask = { ...task, task_id: 'task-other' };
    assert.equal(authority.resolveKillDiscussionRecovery(workspaceRoot, mismatchedTaskIdTask), null);

    const mismatchedAttemptTask = {
        ...task,
        isolatedWorkspace: { ...task.isolatedWorkspace, attempt: 2 },
        lastOutcome: { ...task.lastOutcome, attempt: 2 },
    };
    assert.equal(authority.resolveKillDiscussionRecovery(workspaceRoot, mismatchedAttemptTask), null);
});

test('authority-store rejects task.execution.outcome.recovered with DUAL_INTEGRITY_CORRUPT on active lease or TASK_VERIFIED (P2.3)', (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-auth-store-p23-'));
    t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
    const store = createAuthorityStore(sessionDir);

    const baseline = { kind: 'git', id: 'a'.repeat(40) };
    store.append({
        schema_version: 2,
        workspace_id: 'ws-1',
        session_id: 'sess-1',
        plan_revision: 1,
        expected_baseline: baseline,
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: '.',
        mode: 'auto',
    });

    store.append({
        schema_version: 2,
        workspace_id: 'ws-1',
        session_id: 'sess-1',
        plan_revision: 1,
        expected_baseline: baseline,
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [
            { name: 'authority_ledger_integrity', status: 'PASSED' },
            { name: 'agy_cli_and_model', status: 'PASSED' },
        ],
        details: {
            agy_version: '1.1.19',
            agy_model: 'gemini-3.7-flash-high',
        },
    });

    store.append({
        schema_version: 2,
        workspace_id: 'ws-1',
        session_id: 'sess-1',
        plan_revision: 1,
        expected_baseline: baseline,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'b'.repeat(64),
        total_tasks: 1,
        tasks: [{
            task_id: 'task-1',
            title: 'Task 1',
            goal: 'Goal 1',
            owner: 'agy',
            execution_mode: 'isolated',
            allowed_files: ['index.html'],
        }],
    });

    store.append({
        schema_version: 2,
        workspace_id: 'ws-1',
        session_id: 'sess-1',
        plan_revision: 1,
        expected_baseline: baseline,
        type: 'task.routed',
        task_id: 'task-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        model: 'gemini-3.7-flash-high',
        effort: 'high',
        token_budget: 10000,
        allowed_files: ['index.html'],
        reason: 'Routing isolated worker',
    });

    assert.equal(store.derive().sessionState, 'EXECUTING');

    const lease1 = store.acquireLease('task-1', 'agy');
    store.append({
        schema_version: 2,
        type: 'task.execution.started',
        task_id: 'task-1',
        lease_id: lease1.lease_id,
        controller_pid: process.pid,
    });
    store.append({
        schema_version: 2,
        type: 'task.execution.outcome',
        task_id: 'task-1',
        lease_id: lease1.lease_id,
        attempt: 1,
        status: 'FAILED',
        code: 'DUAL_WORKER_EXECUTION_FAILED',
        summary: 'Worker execution failed',
    });

    // Case (a): lease1 is still active at event time
    assert.throws(
        () => store.append({
            schema_version: 2,
            type: 'task.execution.outcome.recovered',
            task_id: 'task-1',
            previous_attempt: 1,
            previous_status: 'FAILED',
            previous_code: 'DUAL_WORKER_EXECUTION_FAILED',
            previous_summary: 'Worker execution failed',
            recovery_phase: 'review',
            recovery_error_code: 'DUAL_DISCUSSION_FAILED',
            recovered_at: new Date().toISOString(),
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            assert.match(err.message, /Outcome recovery requires matching failed isolated task evidence and no active lease/);
            return true;
        }
    );

    // Release lease1 to allow legitimate outcome recovery
    store.releaseLease(lease1.lease_id, 'recovery_settled');
    const recoveredEvent = store.append({
        schema_version: 2,
        type: 'task.execution.outcome.recovered',
        task_id: 'task-1',
        previous_attempt: 1,
        previous_status: 'FAILED',
        previous_code: 'DUAL_WORKER_EXECUTION_FAILED',
        previous_summary: 'Worker execution failed',
        recovery_phase: 'review',
        recovery_error_code: 'DUAL_DISCUSSION_FAILED',
        recovered_at: new Date().toISOString(),
    });
    assert.equal(recoveredEvent.type, 'task.execution.outcome.recovered');

    // Transition task through complete pipeline to TASK_VERIFIED
    const lease2 = store.acquireLease('task-1', 'agy');
    store.append({
        schema_version: 2,
        type: 'task.execution.started',
        task_id: 'task-1',
        lease_id: lease2.lease_id,
        controller_pid: process.pid,
    });
    store.append({
        schema_version: 2,
        type: 'task.workspace.prepared',
        task_id: 'task-1',
        lease_id: lease2.lease_id,
        attempt: 1,
        reference: {
            bindingPath: '.omni/runs/dual-workspaces/task-1/1/binding.json',
            bindingSha256: 'c'.repeat(64),
            workerBaselineSha256: 'd'.repeat(64),
            workerContractSha256: 'e'.repeat(64),
        },
    });
    store.append({
        schema_version: 2,
        type: 'task.workspace.handoff',
        task_id: 'task-1',
        lease_id: lease2.lease_id,
        attempt: 1,
        handoff_path: '.omni/runs/dual-workspaces/task-1/1/worker-handoff.json',
        handoff_sha256: 'f'.repeat(64),
        result_sha256: '0'.repeat(64),
    });
    store.append({
        schema_version: 2,
        type: 'gate.result',
        gate_id: 'isolated-qc-task-1',
        task_id: 'task-1',
        status: 'PASSED',
        evidence_sha256: '0'.repeat(64),
        reason: 'QC passed',
        details: {
            handoff_sha256: 'f'.repeat(64),
            result_sha256: '0'.repeat(64),
            integration_receipt: 'receipt-1',
            commands: [{ program: 'test', exit_code: 0 }],
        },
    });
    store.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'task-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: '0'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    store.releaseLease(lease2.lease_id, 'verified');

    assert.equal(store.derive().tasks['task-1'].state, 'TASK_VERIFIED');
    assert.ok(!Object.values(store.derive().leases).some(l => l.status === 'active'));

    // Case (b): task is already TASK_VERIFIED
    assert.throws(
        () => store.append({
            schema_version: 2,
            type: 'task.execution.outcome.recovered',
            task_id: 'task-1',
            previous_attempt: 1,
            previous_status: 'FAILED',
            previous_code: 'DUAL_WORKER_EXECUTION_FAILED',
            previous_summary: 'Worker execution failed',
            recovery_phase: 'review',
            recovery_error_code: 'DUAL_DISCUSSION_FAILED',
            recovered_at: new Date().toISOString(),
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            assert.match(err.message, /Outcome recovery requires matching failed isolated task evidence and no active lease/);
            return true;
        }
    );
});
