'use strict';

const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeOperations = new WeakMap();

function operationError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function requireStore(authorityStore) {
    if (!authorityStore || typeof authorityStore.derive !== 'function'
        || typeof authorityStore.readOperationRecords !== 'function') {
        throw operationError('DUAL_OPERATION_INVALID_OPTIONS', 'authorityStore does not expose operation lifecycle reads');
    }
}

function requireIdentity({ taskId, leaseId, operationId }) {
    if (typeof taskId !== 'string' || !taskId || typeof leaseId !== 'string' || !OPERATION_UUID.test(leaseId)
        || typeof operationId !== 'string' || !OPERATION_UUID.test(operationId)) {
        throw operationError('DUAL_OPERATION_INVALID', 'taskId, leaseId, and operationId must be valid authority identities');
    }
}

function nowIso(authorityStore) {
    if (typeof authorityStore.now === 'function') return authorityStore.now();
    return new Date().toISOString();
}

function statesFor(authorityStore) {
    const states = new Map();
    for (const record of authorityStore.readOperationRecords()) {
        const state = states.get(record.operation_id);
        if (record.type === 'started') {
            states.set(record.operation_id, {
                operation_id: record.operation_id,
                session_id: record.session_id,
                workspace_id: record.workspace_id,
                plan_revision: record.plan_revision,
                task_id: record.task_id,
                lease_id: record.lease_id,
                active: true,
                settled: false,
                outcome: null,
                started_at: record.timestamp,
            });
        } else if (state) {
            states.set(record.operation_id, {
                ...state,
                active: false,
                settled: true,
                outcome: record.outcome,
                settled_at: record.timestamp,
            });
        }
    }
    return states;
}

function currentLineage(authorityStore, taskId, leaseId, { allowReleased = false } = {}) {
    const derived = authorityStore.derive();
    const task = derived.tasks?.[taskId];
    const lease = derived.leases?.[leaseId];
    if (!task || !lease || lease.task_id !== taskId || lease.session_id !== derived.sessionId) {
        throw operationError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation does not match the current task lease lineage');
    }
    if (!allowReleased && lease.status !== 'active') {
        throw operationError(lease.status === 'expired' ? 'DUAL_OPERATION_LEASE_EXPIRED' : 'DUAL_OPERATION_FENCED',
            `Operation lease is ${lease.status} and cannot be written`);
    }
    if (task.execution_mode !== 'isolated' || task.owner !== 'agy' || lease.owner !== 'agy') {
        throw operationError('DUAL_OPERATION_INVALID', 'Operation lifecycle requires an isolated AGY task lease');
    }
    const holder = lease.revision_id
        ? task.revisions?.find((revision) => revision.revision_id === lease.revision_id)
            || (task.active_revision?.revision_id === lease.revision_id ? task.active_revision : task)
        : task;
    const execution = holder.executions?.[leaseId];
    if (!execution || execution.session_id !== derived.sessionId || execution.plan_revision !== derived.planRevision) {
        throw operationError('DUAL_OPERATION_INVALID', 'Operation lifecycle requires matching task.execution.started evidence');
    }
    return { derived, task, lease };
}

function operationState(authorityStore, taskId, leaseId, operationId) {
    const state = statesFor(authorityStore).get(operationId);
    if (!state) return null;
    if (state.task_id !== taskId || state.lease_id !== leaseId) {
        throw operationError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation ID is bound to a different task or lease');
    }
    return state;
}

function inspectOperation({ authorityStore, taskId, leaseId, operationId }) {
    requireStore(authorityStore);
    requireIdentity({ taskId, leaseId, operationId });
    currentLineage(authorityStore, taskId, leaseId, { allowReleased: true });
    const state = operationState(authorityStore, taskId, leaseId, operationId);
    const memoryActive = activeOperations.get(authorityStore)?.has(operationId) === true;
    if (memoryActive && (!state || !state.active || state.settled)) {
        throw operationError('DUAL_OPERATION_CORRUPT', 'In-memory operation state disagrees with durable settlement evidence');
    }
    if (!state) return { active: false, settled: false, outcome: null };
    return { active: state.active, settled: state.settled, outcome: state.outcome };
}

function listOperations({ authorityStore, taskId, leaseId } = {}) {
    requireStore(authorityStore);
    if (typeof taskId !== 'string' || !taskId || typeof leaseId !== 'string' || !OPERATION_UUID.test(leaseId)) {
        throw operationError('DUAL_OPERATION_INVALID', 'taskId and leaseId must be valid authority identities');
    }
    const derived = authorityStore.derive();
    const task = derived.tasks?.[taskId];
    const lease = derived.leases?.[leaseId];
    if (!task || !lease || lease.task_id !== taskId || lease.session_id !== derived.sessionId) {
        throw operationError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation does not match the current task lease lineage');
    }
    return [...statesFor(authorityStore).values()].filter((state) => state.task_id === taskId && state.lease_id === leaseId);
}

function assertOperationAuthorized({ authorityStore, taskId, leaseId, operationId }) {
    requireStore(authorityStore);
    requireIdentity({ taskId, leaseId, operationId });
    const { lease } = currentLineage(authorityStore, taskId, leaseId);
    const state = operationState(authorityStore, taskId, leaseId, operationId);
    if (!state || !state.active || state.settled) throw operationError('DUAL_OPERATION_FENCED', 'Operation is not the current active writer');
    if (lease.status !== 'active') throw operationError('DUAL_OPERATION_FENCED', 'Operation lease is no longer active');
    return { active: true, settled: false, outcome: null };
}

module.exports = {
    inspectOperation,
    listOperations,
    assertOperationAuthorized,
};
