'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTaskBinding, validateTaskPath } = require('./task-workspace');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function recordTaskOutcome({ authorityStore, taskId, leaseId, status, code, summary }) {
    const task = authorityStore.derive().tasks[taskId];
    authorityStore.append({ schema_version: 2, type: 'task.execution.outcome', task_id: taskId, lease_id: leaseId,
        attempt: task.isolatedWorkspace?.attempt || task.correction?.attempt || 1, status, code, summary: summary.slice(0, 2048) });
}

function requestTaskCorrection({ workspaceRoot, authorityStore, sessionId, planRevision, taskId, requestId, expectedAttempt, reason }) {
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
        if (existing.attempt !== expectedAttempt + 1 || existing.reason !== reason) {
            fail('DUAL_CORRECTION_CONFLICT', 'Correction request ID already binds different content');
        }
        return { acknowledged: true, reused: true, attempt: existing.attempt };
    }
    if ((task.isolatedWorkspace?.attempt || task.correction?.attempt || 1) !== expectedAttempt || expectedAttempt >= 3) {
        fail('DUAL_CORRECTION_LIMIT', 'No matching failed attempt or correction budget exhausted');
    }
    if (task.isolatedWorkspace) readTaskBinding(workspaceRoot, task.isolatedWorkspace.reference);
    const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const attemptDir = task.isolatedWorkspace ? path.posix.dirname(task.isolatedWorkspace.reference.bindingPath)
        : `.omni/runs/dual-workspaces/${hash(sessionId).slice(0, 16)}/${hash(taskId).slice(0, 16)}/attempt-${expectedAttempt}`;
    validateTaskPath(workspaceRoot, attemptDir);
    if (fs.existsSync(path.join(workspaceRoot, attemptDir))
        && fs.readdirSync(path.join(workspaceRoot, attemptDir)).some((file) => /^integrat(?:ion|ed)-/.test(file))) {
        fail('DUAL_CORRECTION_INTEGRATION_PENDING', 'Resume the recorded integration before starting a new correction');
    }
    authorityStore.append({ schema_version: 2, type: 'task.correction.requested', task_id: taskId, request_id: requestId,
        previous_attempt: expectedAttempt, attempt: expectedAttempt + 1,
        previous_binding_sha256: task.isolatedWorkspace?.reference.bindingSha256 || null, reason });
    return { acknowledged: true, reused: false, attempt: expectedAttempt + 1 };
}

module.exports = { recordTaskOutcome, requestTaskCorrection };
