'use strict';

// O2 (docs/SQUAD-ORCA-ADOPTION.md): one typed "what to do next" for the
// orchestrator and for `omni dual status`, derived only from authority state.
// The orchestrator follows it instead of inventing a recovery path; a gate is
// always relayed to the person, never approved by the orchestrator.

const { unansweredQuestions } = require('./task-messages');

const NEXT_ACTIONS = Object.freeze([
    'request_correction', // bounded correction via omni_dual_resume.correction
    'block_exhausted_attempts', // attempt 3 rejected: keep evidence, omni_dual_session_block
    'answer_worker_question', // omni_dual_resume.context_reply
    'codex_qc', // independent QC of a released handoff (omni_dual_completion.isolated_qc)
    'provide_review_checks', // NEEDS_REVIEW: supply the missing review check ids
    'relay_gate_to_human', // print the gate command for the person; never approve it
    'wait_for_runtime', // WAITING_RUNTIME: the daemon probes; do nothing
    'wait_for_agy', // a worker lease is live; do nothing
    'wait_for_dependency', // a dependency or scope must settle first
    'authority_resume', // omni dual resume <task>
    'codex_work', // a controller-owned task
    'check_task_status', // call omni_dual_status and follow that task's next_action
    'evaluate_completion', // every task verified: call omni_dual_completion
    'resolve_blockers', // completion not verified: fix the listed blockers
    'inspect_blocker', // session BLOCKED or lease expired: read the blocker, do not reset
    'inspect_status',
    'done',
]);

function deriveAuthorityTaskState(task, leases) {
    if (task.state === 'TASK_VERIFIED') return task.state;
    const taskLeases = Object.values(leases || {}).filter(
        (lease) => (lease.task_id || lease.taskId) === (task.task_id || task.taskId || task.id),
    );
    if (taskLeases.some((lease) => lease.owner === 'agy' && lease.status === 'active')) {
        // SPEC-SQUAD-P7 §6.1: the live holder is paused for its runtime's usage limit.
        const wait = task.runtimeWait;
        if (wait && taskLeases.some((lease) => (lease.lease_id || lease.leaseId) === wait.lease_id && lease.status === 'active')) {
            return 'WAITING_RUNTIME';
        }
        return 'AGY_IN_PROGRESS';
    }
    if (task.lastOutcome) return task.lastOutcome.status;
    if (task.isolatedHandoff) return 'AWAITING_CODEX_QC';
    if (unansweredQuestions(task).length) return 'NEEDS_CONTEXT';
    if (taskLeases.some((lease) => (
        lease.owner === 'agy'
        && lease.status === 'released'
        && (lease.release_reason || lease.releaseReason) === 'agy_reviewed_awaiting_codex_qc'
    ))) return 'AWAITING_CODEX_QC';
    if (taskLeases.some((lease) => lease.owner === 'agy' && lease.status === 'expired')) {
        return 'AGY_LEASE_EXPIRED';
    }
    return task.state || 'UNKNOWN';
}

function authorityNextAction(task, sessionState, derivedTaskState = task.state) {
    if (task.handoffRejection?.attempt === 3) return 'block_exhausted_attempts';
    if (['NEEDS_FIX', 'CONFLICT', 'FAILED'].includes(derivedTaskState)) return 'request_correction';
    if (derivedTaskState === 'NEEDS_CONTEXT') return 'answer_worker_question';
    if (derivedTaskState === 'WAITING_FOR_DEPENDENCY' || derivedTaskState === 'WAITING_FOR_SCOPE') return 'wait_for_dependency';
    if (derivedTaskState === 'TASK_VERIFIED') return 'done';
    if (sessionState === 'BLOCKED') return 'inspect_blocker';
    if (derivedTaskState === 'AWAITING_CODEX_QC') return 'codex_qc';
    if (derivedTaskState === 'AGY_IN_PROGRESS') return 'wait_for_agy';
    if (derivedTaskState === 'WAITING_RUNTIME') return 'wait_for_runtime';
    if (derivedTaskState === 'AGY_LEASE_EXPIRED') return 'inspect_blocker';
    if (task.owner === 'codex') return 'codex_work';
    if (task.owner === 'agy') return 'authority_resume';
    return 'inspect_status';
}

// The session's single next step, most urgent first. taskActions maps task id
// to its next action. A gate waiting on the person outranks everything.
const TASK_PRIORITY = ['block_exhausted_attempts', 'request_correction', 'answer_worker_question', 'codex_qc',
    'authority_resume', 'codex_work', 'wait_for_runtime', 'wait_for_agy', 'wait_for_dependency'];

function sessionNextAction({ state, blocked, awaitingGate, taskActions }) {
    if (awaitingGate) return { action: 'relay_gate_to_human' };
    if (state === 'BLOCKED' || blocked) return { action: 'inspect_blocker' };
    const entries = Object.entries(taskActions || {});
    for (const action of TASK_PRIORITY) {
        const hit = entries.find(([, value]) => value === action);
        if (hit) return { action, task_id: hit[0] };
    }
    if (entries.length && entries.every(([, value]) => value === 'done')) return { action: 'evaluate_completion' };
    return { action: 'inspect_status' };
}

// omni_dual_completion with isolated_qc: the daemon's task status → next step.
// NEEDS_FIX/CONFLICT do not say whether attempts are spent; status does.
const ISOLATED_QC_ACTIONS = Object.freeze({
    TASK_VERIFIED: 'check_task_status',
    NEEDS_FIX: 'check_task_status',
    CONFLICT: 'check_task_status',
    WAITING_FOR_LEASE: 'wait_for_agy',
    WAITING_FOR_INTEGRATION: 'wait_for_dependency',
    WAITING_FOR_DEPENDENCY: 'wait_for_dependency',
    WAITING_FOR_SCOPE: 'wait_for_dependency',
    NEEDS_REVIEW: 'provide_review_checks',
    AWAITING_HUMAN_APPROVAL: 'relay_gate_to_human',
    INTEGRATION_REJECTED: 'relay_gate_to_human',
});

function completionNextAction({ verified, blockers }) {
    if (verified) return 'done';
    return Array.isArray(blockers) && blockers.length ? 'resolve_blockers' : 'inspect_status';
}

module.exports = {
    NEXT_ACTIONS, ISOLATED_QC_ACTIONS,
    deriveAuthorityTaskState, authorityNextAction, sessionNextAction, completionNextAction,
};
