'use strict';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function lifecycleError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function requireStore(authorityStore) {
    if (!authorityStore || typeof authorityStore.derive !== 'function'
        || typeof authorityStore.readValidatorRecords !== 'function') {
        throw lifecycleError('DUAL_VALIDATOR_INVALID_OPTIONS', 'authorityStore does not expose validator lifecycle reads');
    }
}

function statesFor(authorityStore) {
    const states = new Map();
    for (const record of authorityStore.readValidatorRecords()) {
        const state = states.get(record.run_id);
        if (record.type === 'started') {
            states.set(record.run_id, {
                run_id: record.run_id,
                session_id: record.session_id,
                workspace_id: record.workspace_id,
                plan_revision: record.plan_revision,
                purpose: record.purpose,
                source_fingerprint: record.source_fingerprint,
                command_policy_digest: record.command_policy_digest,
                cycle: record.cycle,
                attempt: record.attempt,
                active: true,
                settled: false,
                outcome: null,
                started_at: record.timestamp,
            });
        } else if (state) {
            states.set(record.run_id, {
                ...state,
                active: false,
                settled: true,
                outcome: record.outcome,
                settled_at: record.timestamp,
                exit_code: record.exit_code,
                failure: record.failure,
            });
        }
    }
    return states;
}

function inspectValidatorRun({ authorityStore, runId }) {
    requireStore(authorityStore);
    if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) {
        throw lifecycleError('DUAL_VALIDATOR_INVALID', 'runId must be a valid UUID');
    }
    const state = statesFor(authorityStore).get(runId);
    if (!state) return { active: false, settled: false, outcome: null, runId, purpose: null };
    return {
        runId: state.run_id,
        active: state.active,
        settled: state.settled,
        outcome: state.outcome,
        purpose: state.purpose,
    };
}

function listValidatorRuns({ authorityStore, sessionId } = {}) {
    requireStore(authorityStore);
    const derived = authorityStore.derive();
    const targetSession = sessionId || derived.sessionId;
    return [...statesFor(authorityStore).values()].filter((state) => state.session_id === targetSession);
}

function assertValidatorRunAuthorized({ authorityStore, runId }) {
    requireStore(authorityStore);
    if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) {
        throw lifecycleError('DUAL_VALIDATOR_INVALID', 'runId must be a valid UUID');
    }
    const state = statesFor(authorityStore).get(runId);
    if (!state || !state.active || state.settled) {
        throw lifecycleError('DUAL_VALIDATOR_FENCED', 'Validator run is not currently active');
    }
    return { active: true, settled: false, outcome: null };
}

module.exports = {
    inspectValidatorRun,
    listValidatorRuns,
    assertValidatorRunAuthorized,
};
