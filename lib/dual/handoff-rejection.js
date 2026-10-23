'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TaskHandoffRejectionInputSchema } = require('./contracts');
const { canonicalizeEvent } = require('./authority-store');
const { readAuthorityHandoff } = require('./isolated-authority');
const { validateTaskPath } = require('./task-workspace');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

// Synchronous by design: remeasurement and append do not yield to another daemon
// request. append replays the current ledger and enforces the same state guards.
// QC reserves its authority with a Codex lease; even an expired unreleased lease
// remains a fence until its existing recovery path has settled it.
function rejectTaskHandoff({ workspaceRoot, authorityStore, ...request }) {
    const parsed = TaskHandoffRejectionInputSchema.safeParse(request);
    if (!parsed.success) fail('DUAL_HANDOFF_REJECTION_INVALID', 'Invalid handoff rejection input');
    const input = parsed.data;
    const current = authorityStore.derive();
    const root = fs.realpathSync.native(workspaceRoot);
    if (current.sessionId !== input.session_id || current.planRevision !== input.plan_revision
        || !current.workspaceRoot || root !== fs.realpathSync.native(current.workspaceRoot)) {
        fail('DUAL_HANDOFF_REJECTION_STALE', 'Rejection request does not match current authority');
    }
    const requestSha256 = crypto.createHash('sha256').update(canonicalizeEvent(input)).digest('hex');
    const existing = authorityStore.readEvents().find((event) => event.type === 'task.handoff.rejected'
        && event.request_id === input.request_id);
    const acknowledgement = (reused) => ({ acknowledged: true, reused, task_id: input.task_id,
        attempt: input.expected_attempt, status: 'NEEDS_FIX' });
    // Resolve history before checking current-attempt readiness. An old request
    // can acknowledge its old rejection after correction without touching attempt 2.
    if (existing) {
        if (existing.request_sha256 !== requestSha256) {
            fail('DUAL_HANDOFF_REJECTION_CONFLICT', 'Rejection request ID already binds different content');
        }
        return acknowledgement(true);
    }
    const task = current.tasks[input.task_id];
    if (current.sessionState !== 'EXECUTING' || current.activeAcceptanceCorrection || current.receipt
        || !task || task.owner !== 'agy' || task.execution_mode !== 'isolated' || task.state === 'TASK_VERIFIED'
        || task.routePlanRevision !== current.planRevision || task.lastOutcome || task.handoffRejection
        || !task.isolatedWorkspace || !task.isolatedHandoff
        || task.isolatedWorkspace.attempt !== input.expected_attempt || task.isolatedHandoff.attempt !== input.expected_attempt
        || task.isolatedHandoff.handoff_sha256 !== input.expected_handoff_sha256
        || task.isolatedHandoff.result_sha256 !== input.expected_result_sha256
        || task.correction && task.correction.attempt !== input.expected_attempt
        || Object.values(current.leases).some((lease) => lease.task_id === input.task_id && !lease.released_at)
        || Object.values(current.gates).some((gate) => gate.task_id === input.task_id && gate.details?.integration_receipt)
        || input.findings.some((finding) => !task.allowed_files.includes(finding.file))) {
        fail('DUAL_HANDOFF_REJECTION_UNSAFE', 'Rejection requires the current released unintegrated isolated handoff');
    }
    const attemptDir = path.posix.dirname(task.isolatedWorkspace.reference.bindingPath);
    validateTaskPath(root, attemptDir);
    if (fs.readdirSync(path.join(root, attemptDir)).some((file) => /^integrat(?:ion|ed)-/.test(file))) {
        fail('DUAL_HANDOFF_REJECTION_UNSAFE', 'Integration metadata already exists for this attempt');
    }
    // Reuse the QC reader: binding, worker contract, all handoff artifact hashes
    // and the freshly collected private result must still match authority.
    readAuthorityHandoff(root, task, current, { readOnly: true });
    authorityStore.append({ schema_version: 2, type: 'task.handoff.rejected', task_id: input.task_id,
        request_id: input.request_id, request_sha256: requestSha256, attempt: input.expected_attempt,
        binding_sha256: task.isolatedWorkspace.reference.bindingSha256,
        handoff_sha256: input.expected_handoff_sha256, result_sha256: input.expected_result_sha256,
        findings: input.findings });
    return acknowledgement(false);
}

module.exports = { rejectTaskHandoff };
