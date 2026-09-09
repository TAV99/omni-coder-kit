'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { evaluateHook, deriveOwnerAndAction, failedTaskStopMessage } = require('../lib/dual/hook-bridge');

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

test('session.block RPC and daemon-client blockSession integration', async (t) => {
    const workspaceRoot = createTempDir('dual-block-rpc');
    initGitRepo(workspaceRoot);
    const authorityStore = createAuthorityStore(path.join(workspaceRoot, '.omni', 'sessions', 'test-sess-block'));

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

    const client = createDaemonClient({ workspaceRoot, timeoutMs: 5000 });

    const session = await client.beginSession({
        workspace_root: workspaceRoot,
        mode: 'auto',
    });

    // 1. Initial status is DISCOVERED
    const initialStatus = await client.status(session.session_id);
    assert.equal(initialStatus.session_state, 'DISCOVERED');

    // 2. Block the session via client API
    const blockRes = await client.blockSession(session.session_id, {
        reason: 'Unrecoverable environment failure',
        blocker_code: 'ENV_FAILURE',
    });
    assert.equal(blockRes.blocked, true);
    assert.equal(blockRes.session_state, 'BLOCKED');
    assert.equal(blockRes.reason, 'Unrecoverable environment failure');
    assert.equal(blockRes.blocker_code, 'ENV_FAILURE');

    // 3. Status reflects BLOCKED and holds blocker details
    const blockedStatus = await client.status(session.session_id);
    assert.equal(blockedStatus.session_state, 'BLOCKED');
    assert.equal(blockedStatus.blocked.blocker_code, 'ENV_FAILURE');
    assert.equal(blockedStatus.blocked.reason, 'Unrecoverable environment failure');

    // 4. Calling blockSession again is idempotent
    const repeatBlock = await client.blockSession(session.session_id, {
        reason: 'Another reason',
        blocker_code: 'ANOTHER_CODE',
    });
    assert.equal(repeatBlock.blocked, true);
    assert.equal(repeatBlock.session_state, 'BLOCKED');

    // 5. PreToolUse hook denies mutations when session is BLOCKED
    const hookRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: workspaceRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-block-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-b1',
        tool_input: { command: '*** Update File: index.html\n+change\n' },
    }, { createClient: () => client });
    assert.equal(hookRes.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(hookRes.hookSpecificOutput?.permissionDecisionReason || '', /session is BLOCKED/);

    // 6. Stop hook returns systemMessage without looping or blocking turn
    const stopRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: workspaceRoot,
        hook_event_name: 'Stop',
        turn_id: 'turn-block-2',
        stop_hook_active: false,
    }, { createClient: () => client });
    assert.equal(stopRes.decision, undefined);
    assert.ok(stopRes.systemMessage);
    assert.match(stopRes.systemMessage, /session is BLOCKED: Unrecoverable environment failure/);
});

test('failedTaskStopMessage: terminal task failure, exhausted budget, and non-terminal continuation', () => {
    // 1. Non-terminal task failure (attempt 1 NEEDS_FIX) -> no stop message (allows correction)
    const nonTerminalStatus = {
        leases: {},
        tasks: {
            'TASK-1': {
                task_id: 'TASK-1',
                state: 'ROUTED',
                last_outcome: { status: 'NEEDS_FIX', attempt: 1, code: 'LINT_FAILED' },
            },
        },
    };
    assert.equal(failedTaskStopMessage(nonTerminalStatus), null);

    // 2. Terminal task failure (status FAILED) -> returns terminal stop message
    const terminalFailedStatus = {
        leases: {},
        tasks: {
            'TASK-1': {
                task_id: 'TASK-1',
                state: 'ROUTED',
                last_outcome: { status: 'FAILED', attempt: 2, code: 'INTERNAL_ERROR' },
            },
        },
    };
    const msg1 = failedTaskStopMessage(terminalFailedStatus);
    assert.ok(msg1);
    assert.match(msg1, /INTERNAL_ERROR/);
    assert.match(msg1, /Execution failed/);

    // 3. Exhausted task correction budget (NEEDS_FIX at attempt 3) -> returns terminal stop message
    const exhaustedStatus = {
        leases: {},
        tasks: {
            'TASK-1': {
                task_id: 'TASK-1',
                state: 'ROUTED',
                last_outcome: { status: 'NEEDS_FIX', attempt: 3, code: 'PERSISTENT_BUG' },
            },
        },
    };
    const msg2 = failedTaskStopMessage(exhaustedStatus);
    assert.ok(msg2);
    assert.match(msg2, /TASK-1/);
    assert.match(msg2, /Execution failed/);

    // 4. Terminal acceptance correction failure (attempt >= 3) -> returns terminal stop message
    const exhaustedAcceptanceStatus = {
        leases: {},
        tasks: {
            'TASK-1': { task_id: 'TASK-1', state: 'TASK_VERIFIED' },
        },
        acceptance_corrections: [
            { task_id: 'TASK-1', attempt: 3, status: 'FAILED', summary: 'Verification tests still fail' },
        ],
    };
    const msg3 = failedTaskStopMessage(exhaustedAcceptanceStatus);
    assert.ok(msg3);
    assert.match(msg3, /Acceptance correction budget exhausted \(max 3 attempts\)/);

    // 5. Terminal quality cycle failure (attempt >= 3) -> returns terminal stop message
    const exhaustedQualityStatus = {
        leases: {},
        tasks: {
            'TASK-1': { task_id: 'TASK-1', state: 'TASK_VERIFIED' },
        },
        gates: {
            'quality-cycle-1': {
                status: 'FAILED',
                details: { cycle_index: 1, attempt: 3 },
            },
        },
    };
    const msg4 = failedTaskStopMessage(exhaustedQualityStatus);
    assert.ok(msg4);
    assert.match(msg4, /quality-cycle-1 failed after 3 attempts; quality cycle budget exhausted/);

    // 6. Active lease suppresses stop message (wait for worker to settle)
    const activeLeaseStatus = {
        leases: {
            'lease-1': { task_id: 'TASK-1', status: 'active' },
        },
        tasks: {
            'TASK-1': {
                task_id: 'TASK-1',
                state: 'ROUTED',
                last_outcome: { status: 'FAILED', code: 'TEMP_ERR' },
            },
        },
    };
    assert.equal(failedTaskStopMessage(activeLeaseStatus), null);
});

test('deriveOwnerAndAction: grounded next action transitions accurately', () => {
    // 1. Session BLOCKED
    const blockedAction = deriveOwnerAndAction({ state: 'BLOCKED' }, {});
    assert.equal(blockedAction.nextAction, 'user intervention required');

    // 2. Session VERIFIED
    const verifiedAction = deriveOwnerAndAction({ state: 'VERIFIED' }, {});
    assert.equal(verifiedAction.nextAction, 'session complete');

    // 3. Active Acceptance Correction
    const corrAction = deriveOwnerAndAction({
        state: 'ACCEPTANCE',
        active_acceptance_correction: { task_id: 'TASK-1', attempt: 2 },
    }, {});
    assert.equal(corrAction.currentOwner, 'codex');
    assert.equal(corrAction.nextAction, 'acceptance correction (TASK-1, attempt 2)');

    // 4. Executing with a task needing correction
    const fixAction = deriveOwnerAndAction({
        state: 'EXECUTING',
        tasks: {
            'TASK-1': {
                task_id: 'TASK-1',
                state: 'ROUTED',
                last_outcome: { status: 'NEEDS_FIX', attempt: 1 },
            },
        },
    }, {});
    assert.equal(fixAction.nextAction, 'task correction (TASK-1)');

    // 5. Executing with active lease
    const leaseAction = deriveOwnerAndAction({
        state: 'EXECUTING',
        leases: {
            'lease-1': { status: 'active', owner: 'agy' },
        },
    }, {});
    assert.equal(leaseAction.currentOwner, 'agy');
    assert.equal(leaseAction.nextAction, 'execute tasks (agy)');
});
