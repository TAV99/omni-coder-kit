'use strict';

const crypto = require('node:crypto');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const attemptOf = (task) => task.isolatedWorkspace?.attempt || task.correction?.attempt || task.attempt || 1;
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
        .filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

// Only facts already recorded by the controller can establish a free recovery.
// A limit, an arbitrary worker reason, or an unsettled finalization proves none.
function classifyFailure(task) {
    const code = task.lastOutcome?.code;
    if (code === 'RESULT_MALFORMED') return { category: 'worker', phase: 'worker_result' };
    if (['DUAL_QC_VALIDATION_FAILED', 'DUAL_QC_WORKSPACE_MUTATION', 'DUAL_QC_BEHAVIOR_FAILED',
        'DUAL_QC_EVIDENCE_FAILED', 'DUAL_CONTROLLER_REVIEW_REJECTED',
        'DUAL_ACCEPTANCE_PREINTEGRATION_FAILED'].includes(code)) return { category: 'worker', phase: 'controller_qc' };
    if (task.lastOutcome && task.finalization?.settled === true
        && ['outer_handoff', 'post_worker_collection'].includes(task.finalization.stage)) {
        return { category: 'harness', phase: task.finalization.stage };
    }
    return { category: 'unknown', phase: 'unclassified' };
}

function failureEvidence(task, { sessionId, planRevision }) {
    return crypto.createHash('sha256').update(canonical({ session_id: sessionId, plan_revision: planRevision,
        task_id: task.task_id, ...(task.revision_id ? { revision_id: task.revision_id, contract_sha256: task.contract_sha256 } : {}), outcome: task.lastOutcome || null, finalization: task.finalization || null,
        binding_sha256: task.isolatedWorkspace?.reference.bindingSha256 || null })).digest('hex');
}

function recoveryUsage(task) {
    const corrections = [...(task.previousAttempts || []).map((item) => item.correction), task.correction].filter(Boolean);
    const harness = corrections.filter((item) => item.budget_class === 'harness').length;
    // Old events have no classification. Charging them conservatively never creates credits.
    return { worker: corrections.length - harness, harness, total: corrections.length };
}

function validPolicy(policy) {
    return policy?.policy_version === 1 && policy.worker_limit === 2
        && Number.isSafeInteger(policy.harness_limit) && policy.harness_limit >= 0 && policy.harness_limit <= 100
        && Number.isSafeInteger(policy.total_limit) && policy.total_limit >= 1 && policy.total_limit <= 102;
}

function authorizeCorrection(task, { expectedAttempt, grantId, sessionId, planRevision } = {}) {
    if (!task.lastOutcome || attemptOf(task) !== expectedAttempt || task.lastOutcome.attempt !== expectedAttempt) {
        fail('DUAL_CORRECTION_LIMIT', 'A matching failed attempt is required');
    }
    const usage = recoveryUsage(task);
    const policy = task.recoveryPolicy;
    if (task.revision_id && (policy?.worker_limit !== 2 || policy?.harness_limit !== 1 || policy?.total_limit !== 3)) {
        fail('DUAL_CORRECTION_POLICY_REQUIRED', 'Candidate recovery policy is fixed at worker 2, harness 1, total 3');
    }
    const classification = classifyFailure(task);
    if (classification.category === 'unknown') {
        fail('DUAL_CORRECTION_CLASSIFICATION_REQUIRED', 'Failure cause is unknown; inspect controller evidence and classify before correction');
    }
    if (!policy) {
        if (grantId || classification.category === 'harness') fail('DUAL_CORRECTION_POLICY_REQUIRED', 'Configure a finite harness and total recovery policy first');
        if (expectedAttempt >= 3 || usage.worker >= 2) fail('DUAL_CORRECTION_LIMIT', 'Worker correction budget exhausted');
        return { budget_class: 'worker' };
    }
    if (!validPolicy(policy)) fail('DUAL_CORRECTION_POLICY_REQUIRED', 'Configure explicit finite harness and total recovery limits');
    const recorded = task.failureClassification;
    if (!recorded || recorded.attempt !== expectedAttempt || recorded.category !== classification.category
        || recorded.phase !== classification.phase
        || sessionId !== undefined && recorded.failure_sha256 !== failureEvidence(task, { sessionId, planRevision })) {
        fail('DUAL_CORRECTION_CLASSIFICATION_REQUIRED', 'Record a classification bound to current controller failure evidence');
    }
    if (usage.total >= policy.total_limit) fail('DUAL_CORRECTION_LIMIT', 'Total recovery budget exhausted');
    if (classification.category === 'worker') {
        if (grantId) fail('DUAL_CORRECTION_GRANT_INVALID', 'Harness grants cannot authorize worker corrections');
        if (usage.worker >= policy.worker_limit) fail('DUAL_CORRECTION_LIMIT', 'Worker correction budget exhausted');
        return { budget_class: 'worker', failure_sha256: recorded.failure_sha256, policy_version: 1 };
    }
    const grant = (task.recoveryGrants || []).find((item) => item.grant_id === grantId);
    if (!grant || grant.consumed || grant.attempt !== expectedAttempt + 1
        || grant.failure_sha256 !== recorded.failure_sha256 || grant.policy_version !== policy.policy_version) {
        fail('DUAL_CORRECTION_GRANT_INVALID', 'A current single-use recovery grant bound to this failure and next attempt is required');
    }
    if (usage.harness >= policy.harness_limit) fail('DUAL_CORRECTION_LIMIT', 'Harness recovery budget exhausted');
    return { budget_class: 'harness', failure_sha256: recorded.failure_sha256, grant_id: grantId, policy_version: 1 };
}

function reduceRecoveryEvent(task, event, context) {
    if (!task || !['PLANNED', 'EXECUTING'].includes(context.sessionState) || task.owner !== 'agy'
        || task.execution_mode !== 'isolated' || task.state === 'TASK_VERIFIED'
        || event.session_id !== context.sessionId || event.plan_revision !== context.planRevision || event.task_id !== task.task_id
        || Object.values(context.leases).some((lease) => lease.task_id === task.task_id && !lease.released_at)
        || Object.values(context.gates).some((gate) => gate.task_id === task.task_id && gate.details?.integration_receipt)) {
        fail('DUAL_CORRECTION_STALE', 'Recovery requires the current released unintegrated task and matching lineage');
    }
    if (event.type === 'task.recovery.policy') {
        if (!validPolicy(event) || task.recoveryPolicy) fail('DUAL_CORRECTION_POLICY_REQUIRED', 'Recovery policy must be finite, explicit and immutable; worker limit is two');
        task.recoveryPolicy = { policy_version: 1, worker_limit: 2, harness_limit: event.harness_limit, total_limit: event.total_limit };
        return;
    }
    if (!validPolicy(task.recoveryPolicy)) fail('DUAL_CORRECTION_POLICY_REQUIRED', 'Configure finite harness and total recovery bounds first');
    if (context.sessionState !== 'EXECUTING' || !task.lastOutcome || task.lastOutcome.attempt !== attemptOf(task)) {
        fail('DUAL_CORRECTION_CLASSIFICATION_REQUIRED', 'A current failed attempt with controller evidence is required');
    }
    const digest = failureEvidence(task, context);
    if (event.type === 'task.failure.classified') {
        const classified = classifyFailure(task);
        if (event.attempt !== attemptOf(task) || event.failure_sha256 !== digest || event.policy_version !== 1
            || event.category !== classified.category || event.phase !== classified.phase
            || typeof event.harness_version !== 'string' || !event.harness_version.trim()) {
            fail('DUAL_CORRECTION_CLASSIFICATION_REQUIRED', 'Classification must match recorded daemon evidence, phase and version');
        }
        task.failureClassification = { attempt: event.attempt, failure_sha256: digest, ...classified,
            harness_version: event.harness_version, policy_version: 1 };
        return;
    }
    if (event.type === 'task.recovery.granted') {
        const classified = task.failureClassification;
        if (!classified || classified.category !== 'harness' || classified.failure_sha256 !== digest
            || classifyFailure(task).category !== 'harness') {
            fail('DUAL_CORRECTION_CLASSIFICATION_REQUIRED', 'Only a proven harness failure can receive recovery authority');
        }
        const usage = recoveryUsage(task);
        if (event.attempt !== attemptOf(task) + 1 || event.failure_sha256 !== digest || event.policy_version !== 1
            || typeof event.grant_id !== 'string' || !event.grant_id
            || (task.recoveryGrants || []).some((grant) => grant.grant_id === event.grant_id || grant.failure_sha256 === digest)) {
            fail('DUAL_CORRECTION_GRANT_INVALID', 'Recovery grants bind one failure, next attempt and policy, and cannot be reused');
        }
        if (usage.harness >= task.recoveryPolicy.harness_limit || usage.total >= task.recoveryPolicy.total_limit) {
            fail('DUAL_CORRECTION_LIMIT', 'Finite harness or total recovery budget exhausted');
        }
        task.recoveryGrants ||= [];
        task.recoveryGrants.push({ grant_id: event.grant_id, attempt: event.attempt, failure_sha256: digest,
            policy_version: 1, consumed: false });
        return;
    }
    fail('DUAL_CORRECTION_INVALID', 'Unknown recovery event');
}

function applyCorrectionBudget(task, event, context) {
    // Historical journals lack classification metadata. Replay keeps the old
    // finite worker charge; new requests still pass authorizeCorrection first.
    if (!task.recoveryPolicy && ['budget_class', 'failure_sha256', 'grant_id', 'policy_version'].every((field) => event[field] === undefined)) {
        if (event.previous_attempt >= 3 || recoveryUsage(task).worker >= 2) fail('DUAL_CORRECTION_LIMIT', 'Legacy worker correction budget exhausted');
        return { budget_class: 'worker' };
    }
    const authorized = authorizeCorrection(task, { expectedAttempt: event.previous_attempt, grantId: event.grant_id, ...context });
    if (task.recoveryPolicy || event.budget_class !== undefined || event.grant_id !== undefined) {
        for (const field of ['budget_class', 'failure_sha256', 'grant_id', 'policy_version']) {
            if (event[field] !== authorized[field]) fail('DUAL_CORRECTION_GRANT_INVALID', 'Correction budget metadata does not match current authority');
        }
    }
    if (authorized.grant_id) task.recoveryGrants.find((grant) => grant.grant_id === authorized.grant_id).consumed = true;
    return authorized;
}

module.exports = { classifyFailure, failureEvidence, recoveryUsage, authorizeCorrection, reduceRecoveryEvent, applyCorrectionBudget };
