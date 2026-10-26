'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTaskBinding, validateTaskPath } = require('./task-workspace');
const policy = require('./correction-policy');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function recordTaskOutcome({ authorityStore, taskId, leaseId, status, code, summary }) {
    const task = authorityStore.derive().tasks[taskId];
    authorityStore.append({ schema_version: 2, type: 'task.execution.outcome', task_id: taskId, lease_id: leaseId,
        attempt: task.isolatedWorkspace?.attempt || task.correction?.attempt || 1, status, code, summary: summary.slice(0, 2048) });
}

function requestTaskCorrection({ workspaceRoot, authorityStore, sessionId, planRevision, taskId, requestId, expectedAttempt, reason, grantId }) {
    const current = authorityStore.derive();
    if (current.sessionId !== sessionId || current.planRevision !== planRevision
        || fs.realpathSync.native(workspaceRoot) !== fs.realpathSync.native(current.workspaceRoot)) {
        fail('DUAL_CORRECTION_STALE', 'Correction request does not match current authority');
    }
    const task = current.tasks[taskId];
    if (!task) fail('DUAL_TASK_NOT_FOUND', 'Task is not registered');
    const existing = [task.correction, ...(task.previousAttempts || []).map((attempt) => attempt.correction)]
        .find((correction) => correction?.request_id === requestId);
    if (existing) {
        if (existing.attempt !== expectedAttempt + 1 || existing.reason !== reason || existing.grant_id !== grantId) {
            fail('DUAL_CORRECTION_CONFLICT', 'Correction request ID already binds different content');
        }
        return { acknowledged: true, reused: true, attempt: existing.attempt };
    }
    assertRecoveryCheckpoint(current, task, expectedAttempt);
    const budget = policy.authorizeCorrection(task, { expectedAttempt, grantId, sessionId, planRevision });
    authorityStore.append({ schema_version: 2, type: 'task.correction.requested', task_id: taskId, request_id: requestId,
        previous_attempt: expectedAttempt, attempt: expectedAttempt + 1,
        previous_binding_sha256: task.isolatedWorkspace?.reference.bindingSha256 || null, reason,
        ...(task.recoveryPolicy ? budget : {}) });
    return { acknowledged: true, reused: false, attempt: expectedAttempt + 1 };
}

function assertRecoveryCheckpoint(current, task, expectedAttempt) {
    const workspaceRoot = current.workspaceRoot, sessionId = current.sessionId, taskId = task.task_id;
    if (task.isolatedWorkspace) {
        const { binding } = readTaskBinding(workspaceRoot, task.isolatedWorkspace.reference);
        if (binding.sessionId !== sessionId || binding.taskId !== taskId || binding.planRevision !== current.planRevision
            || binding.attempt !== expectedAttempt) fail('DUAL_CORRECTION_STALE', 'Recovery binding does not match current task lineage');
    }
    const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const attemptDir = task.isolatedWorkspace ? path.posix.dirname(task.isolatedWorkspace.reference.bindingPath)
        : `.omni/runs/dual-workspaces/${hash(sessionId).slice(0, 16)}/${hash(taskId).slice(0, 16)}/attempt-${expectedAttempt}`;
    validateTaskPath(workspaceRoot, attemptDir);
    if (fs.existsSync(path.join(workspaceRoot, attemptDir))
        && fs.readdirSync(path.join(workspaceRoot, attemptDir)).some((file) => /^integrat(?:ion|ed)-/.test(file))) {
        fail('DUAL_CORRECTION_INTEGRATION_PENDING', 'Resume the recorded integration before starting a new correction');
    }
}

function recoveryTask(args) {
    const current = args.authorityStore.derive();
    if (current.sessionId !== args.sessionId || current.planRevision !== args.planRevision
        || !current.tasks[args.taskId]) fail('DUAL_CORRECTION_STALE', 'Recovery does not match current task authority');
    const task = current.tasks[args.taskId];
    assertRecoveryCheckpoint(current, task, task.isolatedWorkspace?.attempt || task.correction?.attempt || 1);
    return { current, task };
}

function configureTaskRecovery(args) {
    const { task } = recoveryTask(args);
    const configured = { policy_version: 1, worker_limit: 2, harness_limit: args.harnessLimit, total_limit: args.totalLimit };
    if (task.recoveryPolicy && JSON.stringify(task.recoveryPolicy) === JSON.stringify(configured)) return { acknowledged: true, reused: true };
    args.authorityStore.append({ schema_version: 2, type: 'task.recovery.policy', task_id: args.taskId, ...configured });
    return { acknowledged: true, reused: false };
}

function classifyTaskFailure(args) {
    const { current, task } = recoveryTask(args);
    const classification = { attempt: task.lastOutcome?.attempt,
        failure_sha256: policy.failureEvidence(task, current), ...policy.classifyFailure(task),
        harness_version: require('../../package.json').version, policy_version: 1 };
    if (task.failureClassification && JSON.stringify(task.failureClassification) === JSON.stringify(classification)) {
        return { acknowledged: true, reused: true, ...classification };
    }
    args.authorityStore.append({ schema_version: 2, type: 'task.failure.classified', task_id: args.taskId, ...classification });
    return { acknowledged: true, reused: false, ...classification };
}

function grantTaskRecovery(args) {
    const { current, task } = recoveryTask(args);
    if (task.lastOutcome?.attempt !== args.expectedAttempt) fail('DUAL_CORRECTION_GRANT_INVALID', 'Grant must name the current failed attempt');
    args.authorityStore.append({ schema_version: 2, type: 'task.recovery.granted', task_id: args.taskId,
        grant_id: args.grantId, attempt: args.expectedAttempt + 1,
        failure_sha256: policy.failureEvidence(task, current), policy_version: 1 });
    return { acknowledged: true, grant_id: args.grantId, attempt: args.expectedAttempt + 1 };
}

module.exports = { recordTaskOutcome, requestTaskCorrection, configureTaskRecovery, classifyTaskFailure, grantTaskRecovery, ...policy };
