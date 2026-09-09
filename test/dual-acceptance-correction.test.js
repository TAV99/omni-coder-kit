'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { evaluateHook } = require('../lib/dual/hook-bridge');

const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');

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

test('acceptance correction lifecycle: start, authorization, bounded files, and completion', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-lifecycle');
    initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-corr'));

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

    const session = await client.beginSession({
        workspace_root: workspaceRoot,
        mode: 'auto',
    });

    // 1. Register plan with task-1
    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
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
    authorityStore.acquireLease('task-1', 'codex');
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
        () => client.startAcceptanceCorrection(session.session_id, {
            task_id: 'task-1',
            allowed_files: ['unauthorized.js'],
            reason: 'Try to edit outside task',
        }),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_SCOPE_EXCEEDED'
    );

    // b) Unknown task
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, {
            task_id: 'ghost-task',
            allowed_files: ['index.html'],
            reason: 'Target ghost task',
        }),
        (err) => err.code === 'DUAL_TASK_NOT_FOUND'
    );

    // 5. Valid start of acceptance correction for index.html
    const startRes = await client.startAcceptanceCorrection(session.session_id, {
        task_id: 'task-1',
        allowed_files: ['index.html'],
        reason: 'Fix heading copy discovered during acceptance review',
    });
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

    // 7. Starting a second correction while active is rejected
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, {
            task_id: 'task-1',
            allowed_files: ['index.html'],
            reason: 'Second correction parallel attempt',
        }),
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
    const completeRes = await client.completeAcceptanceCorrection(session.session_id, {
        status: 'PASSED',
        summary: 'Fixed heading title in index.html',
    });
    assert.equal(completeRes.completed, true);
    assert.equal(completeRes.status, 'PASSED');
    assert.ok(completeRes.diff_fingerprint);

    const postStatus = await client.status(session.session_id);
    assert.equal(postStatus.active_acceptance_correction, null);
    assert.equal(postStatus.acceptance_corrections.length, 1);
    assert.equal(postStatus.acceptance_corrections[0].status, 'PASSED');
});

test('acceptance correction attempt limit: enforces maximum 3 attempts per task', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-limit');
    initGitRepo(workspaceRoot);
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
        tasks: [{ task_id: 'task-1', title: 'Task 1', owner: 'codex', allowed_files: ['index.html'], deny_patterns: [] }],
    });

    authorityStore.acquireLease('task-1', 'codex');
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

    // Attempt 1
    const s1 = await client.startAcceptanceCorrection(session.session_id, {
        task_id: 'task-1', allowed_files: ['index.html'], reason: 'Attempt 1',
    });
    assert.equal(s1.attempt, 1);
    await client.completeAcceptanceCorrection(session.session_id, { status: 'PASSED', summary: 'Done 1' });

    // Attempt 2
    const s2 = await client.startAcceptanceCorrection(session.session_id, {
        task_id: 'task-1', allowed_files: ['index.html'], reason: 'Attempt 2',
    });
    assert.equal(s2.attempt, 2);
    await client.completeAcceptanceCorrection(session.session_id, { status: 'PASSED', summary: 'Done 2' });

    // Attempt 3
    const s3 = await client.startAcceptanceCorrection(session.session_id, {
        task_id: 'task-1', allowed_files: ['index.html'], reason: 'Attempt 3',
    });
    assert.equal(s3.attempt, 3);
    await client.completeAcceptanceCorrection(session.session_id, { status: 'PASSED', summary: 'Done 3' });

    // Attempt 4 must be rejected
    await assert.rejects(
        () => client.startAcceptanceCorrection(session.session_id, {
            task_id: 'task-1', allowed_files: ['index.html'], reason: 'Attempt 4 exceeded',
        }),
        (err) => err.code === 'DUAL_ACCEPTANCE_CORRECTION_LIMIT_EXCEEDED'
    );
});

test('failed acceptance correction blocks session completion and verification until repaired', async (t) => {
    const workspaceRoot = createTempDir('dual-acc-corr-fail');
    initGitRepo(workspaceRoot);
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

    await client.registerPlan(session.session_id, {
        plan_path: '.omni/plan.json',
        plan_sha256: sha('plan'),
        tasks: [{ task_id: 'task-1', title: 'Task 1', owner: 'codex', allowed_files: ['index.html'], deny_patterns: [] }],
    });

    authorityStore.acquireLease('task-1', 'codex');
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

    // Start correction and fail it via command failure
    await client.startAcceptanceCorrection(session.session_id, {
        task_id: 'task-1',
        allowed_files: ['index.html'],
        reason: 'Correction that fails validation',
        validation_commands: [{ program: process.execPath, args: ['-e', 'process.exit(1)'], cwd: '.' }],
    });

    const failRes = await client.completeAcceptanceCorrection(session.session_id);
    assert.equal(failRes.status, 'FAILED');

    // Completion evaluation must report blocker
    const evalFail = await client.evaluateCompletion(session.session_id);
    assert.equal(evalFail.verified, false);
    assert.ok(evalFail.blockers.some((b) => b.includes('ACCEPTANCE_CORRECTION_FAILED')));

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

    // Repair via Attempt 2
    await client.startAcceptanceCorrection(session.session_id, {
        task_id: 'task-1',
        allowed_files: ['index.html'],
        reason: 'Repair attempt 1',
        validation_commands: [{ program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.' }],
    });
    const passRes = await client.completeAcceptanceCorrection(session.session_id);
    assert.equal(passRes.status, 'PASSED');

    const evalPass = await client.evaluateCompletion(session.session_id);
    assert.ok(!evalPass.blockers.some((b) => b.includes('ACCEPTANCE_CORRECTION_FAILED')));
});
