'use strict';

const { randomUUID } = require('node:crypto');
const { redactDiagnostic } = require('../validator-security');
const { CEILINGS, DiscussionError, isPlainObject } = require('./contracts');

const DISCUSSION_PHASES = Object.freeze(['scout', 'plan', 'review']);

class DiscussionPhaseError extends DiscussionError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'DiscussionPhaseError';
    }
}

function recoveryCode(value, fallback) {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value) ? value : fallback;
}

// The host supplies schema validation; the relay retains recovery proof checks.
async function runDiscussionPhase({ session, phase, promptBody, snapshotText, schemaText, validate,
    senderRef, recipientRef, messageId, ttlMs = CEILINGS.ttlMs, now = Date.now() }) {
    if (!DISCUSSION_PHASES.includes(phase)) {
        throw new DiscussionPhaseError('PHASE_NOT_DISCUSSION', `Phase '${phase}' cannot use discussion`, { phase });
    }
    if (!session || session.enabled !== true) {
        throw new DiscussionPhaseError('SESSION_DISABLED', 'Discussion session is disabled', { phase });
    }

    const { relay } = session;
    // A rebuilt dirty relay must report its original refs before receiving a
    // new question. Recovery still requires the unchanged reconcile proof gate.
    const recovered = await relay.inspect();
    if (recovered.blocked) {
        throw new DiscussionPhaseError('OUTCOME_UNKNOWN', 'Discussion is blocked by an unresolved journal invocation', {
            phase, messageId: recovered.unknown?.message_id,
            invocationId: recovered.unknown?.invocation_id,
            bindingRef: recovered.unknown?.binding_ref, unknown: recovered.unknown,
            recoveryError: 'RECOVERY_PROOF_REQUIRED',
        });
    }
    const originalBody = snapshotText ? `${promptBody}\n\n${snapshotText}` : promptBody;
    const flags = {};
    let recoveryAttempted = false;
    let correctionAttempted = false;
    let validationIssues;
    let lastDiagnostics = {};

    async function receive(id, body, recoveryReplyTo) {
        const before = await relay.inspect();
        const createdAt = before.messages.length === 0 ? now : Math.max(now, Date.now());
        await relay.receive({
            schema_version: 1, message_id: id,
            sender_ref: recoveryReplyTo ? recipientRef : senderRef,
            recipient_ref: recoveryReplyTo ? senderRef : recipientRef,
            sequence: before.messages.length + 1,
            kind: recoveryReplyTo ? 'reply' : 'question', body,
            ...(recoveryReplyTo ? { reply_to: recoveryReplyTo } : {}),
            created_at: createdAt, expires_at: createdAt + ttlMs,
        });
    }

    async function dispatch(id, body) {
        let turn;
        try {
            turn = await relay.dispatch(id);
            if (turn.provider === 'failed' && !recoveryAttempted) {
                recoveryAttempted = true;
                await receive(randomUUID(), 'The previous attempt settled as failed.', id);
                const retryId = randomUUID();
                await receive(retryId, body);
                const retryTurn = await dispatch(retryId, body);
                flags.discussionRecovery = 'failed-retry';
                return retryTurn;
            }
            if (turn.provider !== 'outcome_unknown') return turn;
            throw new DiscussionError('OUTCOME_UNKNOWN', 'Question invocation ended with unknown outcome');
        } catch (err) {
            if (err.code !== 'OUTCOME_UNKNOWN') throw err;
            const view = await relay.inspect();
            const originalError = err instanceof DiscussionPhaseError ? err
                : new DiscussionPhaseError('OUTCOME_UNKNOWN', err.message, {
                    ...lastDiagnostics, phase, messageId: id,
                    invocationId: view.unknown?.invocation_id ?? turn?.invocation_id,
                    bindingRef: view.unknown?.binding_ref,
                    unknown: view.unknown,
                });
            if (recoveryAttempted || typeof relay.reconcile !== 'function') throw originalError;
            recoveryAttempted = true;
            let reconciled;
            try {
                // reconcile asks the session's host verifyRecovery port for proof,
                // checks authority and invocation identity, then durably settles it.
                reconciled = await relay.reconcile(id, {});
            } catch (recoveryError) {
                originalError.details = { ...originalError.details,
                    recoveryError: recoveryCode(recoveryError?.code, 'RECOVERY_FAILED') };
                throw originalError;
            }
            if (reconciled?.reconciled !== true || reconciled.reconciled_outcome !== 'failed') {
                originalError.details = { ...originalError.details,
                    ...(reconciled?.reconciled === true && reconciled.reconciled_outcome === 'succeeded'
                        ? { recoveryOutcome: 'succeeded' }
                        : { recoveryError: recoveryCode(reconciled?.code, 'RECOVERY_UNSETTLED') }),
                };
                throw originalError;
            }
            await receive(randomUUID(), 'The timed-out attempt was reconciled as failed.', id);
            const retryId = randomUUID();
            await receive(retryId, body);
            const retryTurn = await dispatch(retryId, body);
            flags.discussionRecovery = 'reconciled-retry';
            return retryTurn;
        }
    }

    let currentId = messageId;
    let body = originalBody;
    for (;;) {
        let turn;
        try {
            await receive(currentId, body);
            turn = await dispatch(currentId, body);
        } catch (err) {
            if (!(err instanceof DiscussionPhaseError)) {
                err.details = { ...lastDiagnostics, ...(err.details || {}) };
            }
            throw err;
        }
        const view = await relay.inspect();
        const response = view.messages.find((message) => message.message_id === turn.response_message_id);
        const rawBody = response?.body;
        const details = { phase, messageId: turn.message_id ?? currentId, invocationId: turn.invocation_id,
            responseMessageId: turn.response_message_id,
            ...(validationIssues ? { validationIssues } : {}),
            ...(typeof rawBody === 'string' ? { rawReplyExcerpt: redactDiagnostic(rawBody, { maxLength: 4096 }) }
                : typeof turn.raw_reply_excerpt === 'string'
                    ? { rawReplyExcerpt: redactDiagnostic(turn.raw_reply_excerpt, { maxLength: 1024 }) } : {}),
            ...(turn.evidence_ref ? {
                repairKind: /;payload-repair=([a-z_+-]+)/i.exec(turn.evidence_ref)?.[1]?.replace(/\+nudge(?:\+nudge-denied)?$/, '') ?? null,
                nudged: /\+nudge(?:\+nudge-denied)?$/.test(turn.evidence_ref),
            } : {}),
        };
        lastDiagnostics = {
            ...(details.rawReplyExcerpt !== undefined ? { rawReplyExcerpt: details.rawReplyExcerpt } : {}),
            ...(details.repairKind ? { repairKind: details.repairKind } : {}),
            ...(details.nudged !== undefined ? { nudged: details.nudged } : {}),
            ...(validationIssues ? { validationIssues } : {}),
        };
        let result;
        try {
            if (typeof rawBody !== 'string') throw new Error('No stored reply body');
            const trimmed = rawBody.trim();
            const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
            result = JSON.parse(fence ? fence[1] : trimmed);
            if (!isPlainObject(result)) throw new Error('Phase result must be a JSON object');
        } catch (cause) {
            const error = new DiscussionPhaseError('RESULT_MALFORMED', 'Reply body is not a phase JSON object', details);
            error.cause = cause;
            throw error;
        }
        const validation = validate ? await validate(result) : { ok: true };
        if (validation.ok === true) {
            return { phase, result, rawBody, messageId: turn.message_id ?? currentId,
                responseMessageId: response.message_id, ...flags };
        }
        const issues = redactDiagnostic(String(validation.issues), { maxLength: 4096 });
        validationIssues = issues;
        lastDiagnostics.validationIssues = issues;
        if (correctionAttempted) {
            throw new DiscussionPhaseError('RESULT_MALFORMED', 'Reply body does not satisfy the phase schema', {
                ...details, validationIssues: issues,
            });
        }
        correctionAttempted = true;
        flags.discussionCorrection = 'schema-nudge';
        currentId = randomUUID();
        // The orchestrator embeds schemaText verbatim in the original body.
        // Only add it for callers that supply a separate, not-yet-embedded schema.
        const missingSchema = schemaText && !originalBody.includes(schemaText) ? `\n\n${schemaText}` : '';
        body = `${originalBody}${missingSchema}\n\n--- PHASE SCHEMA CORRECTION ---\n${issues}\n`
            + 'Answer with ONLY a JSON object matching the schema above.';
    }
}

module.exports = { DISCUSSION_PHASES, DiscussionPhaseError, runDiscussionPhase };
