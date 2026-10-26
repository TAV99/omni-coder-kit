'use strict';

// A dispatch finishing says nothing about terminal task/session authority.
function dispatchState(results) {
    if (!Array.isArray(results) || !results.length) return 'failed';
    if (results.some((result) => result?.status === 'NEEDS_CONTEXT')) return 'waiting_context';
    if (results.some((result) => result?.skipped || ['FAILED', 'NEEDS_FIX', 'CONFLICT', 'INCOMPLETE',
        'RECONCILIATION_REQUIRED', 'SPEC_COVERAGE_REQUIRED'].includes(result?.status))) return 'failed';
    return results.every((result) => result?.status === 'TASK_VERIFIED') ? 'verified' : 'completed';
}

function continuationCheckpoint(derived, taskId) {
    const task = derived.tasks[taskId];
    if (!task || derived.sessionState !== 'EXECUTING') return { status: 'RECONCILIATION_REQUIRED' };
    if (task.state === 'TASK_VERIFIED') return { status: 'VERIFIED' };
    if (Object.values(derived.leases || {}).some((lease) => lease.task_id === taskId && !lease.released_at)) {
        return { status: 'LEASE_HELD' };
    }
    if (task.lastOutcome) return { status: 'FAILED' };
    if (task.isolatedHandoff) return { status: 'QC' };
    if (Object.values(derived.gates || {}).some((gate) => gate.task_id === taskId && gate.details?.integration_receipt)) {
        return { status: 'RECONCILIATION_REQUIRED' };
    }
    if (task.waitingContext) {
        const questions = task.waitingContext.question_ids;
        const replies = (task.messages || []).filter((message) => message.kind === 'reply'
            && questions.includes(message.reply_to));
        return { status: questions.every((id) => replies.some((reply) => reply.reply_to === id))
            ? 'EVALUATE_CONTEXT' : 'WAITING_CONTEXT', reply_ids: replies.map((reply) => reply.message_id) };
    }
    if (task.isolatedWorkspace) return { status: 'RECONCILIATION_REQUIRED' };
    return { status: 'START' };
}

module.exports = { continuationCheckpoint, dispatchState };
