'use strict';

function postTaskMessage({ authorityStore, sessionId, planRevision, taskId, messageId, kind, body, replyTo, leaseId }) {
    const derived = authorityStore.derive();
    if (derived.sessionId !== sessionId || derived.planRevision !== planRevision || !derived.tasks[taskId]) {
        const error = new Error('Message does not match current task authority'); error.code = 'DUAL_MESSAGE_STALE'; throw error;
    }
    const existing = Object.values(derived.tasks).flatMap((task) => (task.messages || []).map((message) => ({ task, message })))
        .find(({ message }) => message.message_id === messageId);
    if (existing) {
        if (existing.task.task_id !== taskId || existing.message.kind !== kind || existing.message.body !== body
            || existing.message.reply_to !== replyTo || existing.message.plan_revision !== planRevision) {
            const error = new Error('Message ID already binds different content'); error.code = 'DUAL_MESSAGE_CONFLICT'; throw error;
        }
        return { acknowledged: true, reused: true, message_id: messageId };
    }
    authorityStore.append({ schema_version: 2, type: 'task.message', task_id: taskId,
        message_id: messageId, kind, body, ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
        ...(leaseId !== undefined ? { lease_id: leaseId } : {}) });
    return { acknowledged: true, reused: false, message_id: messageId };
}

function unansweredQuestions(task) {
    const messages = task.messages || [];
    return messages.filter((message) => message.kind === 'question'
        && !messages.some((reply) => reply.kind === 'reply' && reply.reply_to === message.message_id));
}

module.exports = { postTaskMessage, unansweredQuestions };
