'use strict';

const { CEILINGS, DiscussionError, isPlainObject } = require('./contracts');

const DISCUSSION_PHASES = Object.freeze(['scout', 'plan', 'review']);

class DiscussionPhaseError extends DiscussionError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'DiscussionPhaseError';
    }
}

// The host retains phase schema/correlation validation and state transitions.
// This bridge only unwraps the phase JSON object from a durable discussion reply.
async function runDiscussionPhase({ session, phase, promptBody, snapshotText,
    senderRef, recipientRef, messageId, ttlMs = CEILINGS.ttlMs, now = Date.now() }) {
    if (!DISCUSSION_PHASES.includes(phase)) {
        throw new DiscussionPhaseError('PHASE_NOT_DISCUSSION', `Phase '${phase}' cannot use discussion`, { phase });
    }
    if (!session || session.enabled !== true) {
        throw new DiscussionPhaseError('SESSION_DISABLED', 'Discussion session is disabled', { phase });
    }

    const { relay } = session;
    const before = await relay.inspect();
    await relay.receive({
        schema_version: 1,
        message_id: messageId,
        sender_ref: senderRef,
        recipient_ref: recipientRef,
        sequence: before.messages.length + 1,
        kind: 'question',
        body: snapshotText ? `${promptBody}\n\n${snapshotText}` : promptBody,
        created_at: now,
        expires_at: now + ttlMs,
    });

    let turn;
    try {
        turn = await relay.dispatch(messageId);
    } catch (err) {
        if (err.code !== 'OUTCOME_UNKNOWN') throw err;
        const view = await relay.inspect();
        // No retry: only host reconciliation may clear the relay's unknown state.
        throw new DiscussionPhaseError('OUTCOME_UNKNOWN', err.message, {
            phase, messageId,
            invocationId: view.unknown?.invocation_id,
            bindingRef: view.unknown?.binding_ref,
            unknown: view.unknown,
        });
    }

    const view = await relay.inspect();
    const response = view.messages.find((message) => message.message_id === turn.response_message_id);
    const rawBody = response?.body;
    const details = { phase, messageId, invocationId: turn.invocation_id,
        responseMessageId: turn.response_message_id };
    try {
        if (typeof rawBody !== 'string') throw new Error('No stored reply body');
        const trimmed = rawBody.trim();
        const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        const result = JSON.parse(fence ? fence[1] : trimmed);
        if (!isPlainObject(result)) throw new Error('Phase result must be a JSON object');
        return { phase, result, rawBody, messageId, responseMessageId: response.message_id };
    } catch (cause) {
        const error = new DiscussionPhaseError('RESULT_MALFORMED', 'Reply body is not a phase JSON object', details);
        error.cause = cause;
        throw error;
    }
}

module.exports = { DISCUSSION_PHASES, DiscussionPhaseError, runDiscussionPhase };
