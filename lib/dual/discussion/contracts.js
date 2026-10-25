'use strict';

const crypto = require('node:crypto');

const ERROR_CODES = Object.freeze({
    DISCUSSION_DISABLED: 'DISCUSSION_DISABLED',
    INVALID_INPUT: 'INVALID_INPUT',
    MESSAGE_CONFLICT: 'MESSAGE_CONFLICT',
    CORRELATION_INVALID: 'CORRELATION_INVALID',
    LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
    OWNER_BUSY: 'OWNER_BUSY',
    JOURNAL_INVALID: 'JOURNAL_INVALID',
    AUTHORITY_STALE: 'AUTHORITY_STALE',
    CAPABILITY_BLOCKED: 'CAPABILITY_BLOCKED',
    OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
    RELAY_CLOSED: 'RELAY_CLOSED',
});

class DiscussionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DiscussionError';
        this.code = ERROR_CODES[code] || code;
        this.details = details && typeof details === 'object' ? { ...details } : {};
    }
}

const CEILINGS = Object.freeze({
    maxParticipants: 2,
    maxInvocations: 24,
    maxTurns: 24,
    timeoutMs: 120_000,
    maxBodyBytes: 16_384,
    maxSnapshotBytes: 65_536,
    maxOutputBytes: 262_144,
    maxStdoutBytes: 262_144,
    maxStderrBytes: 262_144,
    maxJournalBytes: 8 * 1024 * 1024,
    maxEvents: 256,
    ttlMs: 300_000,
    maxTtlMs: 900_000,
});

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function cloneAndFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Cyclic object is not allowed');
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const copy = value.map((item) => cloneAndFreeze(item, seen));
        seen.delete(value);
        return Object.freeze(copy);
    }
    if (!isPlainObject(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Only plain objects are allowed');
    }
    const copy = {};
    for (const key of Object.keys(value)) {
        const prop = value[key];
        if (prop !== undefined) {
            copy[key] = cloneAndFreeze(prop, seen);
        }
    }
    seen.delete(value);
    return Object.freeze(copy);
}

function canonicalizeJson(value, seen = new Set()) {
    if (value === null) {
        return 'null';
    }
    const type = typeof value;
    if (type === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (type === 'number') {
        if (!Number.isFinite(value)) {
            throw new DiscussionError('INVALID_INPUT', 'Non-finite numbers are not allowed in canonical JSON');
        }
        return JSON.stringify(value);
    }
    if (type === 'string') {
        return JSON.stringify(value);
    }
    if (type !== 'object') {
        throw new DiscussionError('INVALID_INPUT', `Unsupported canonical JSON value type: ${type}`);
    }
    if (seen.has(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Cyclic object is not allowed in canonical JSON');
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const parts = value.map((item) => {
            if (item === undefined) {
                throw new DiscussionError('INVALID_INPUT', 'Array cannot contain undefined in canonical JSON');
            }
            return canonicalizeJson(item, seen);
        });
        seen.delete(value);
        return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Non-plain object is not allowed in canonical JSON');
    }
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const key of keys) {
        const prop = value[key];
        if (prop === undefined) {
            throw new DiscussionError('INVALID_INPUT', `Property '${key}' cannot be undefined in canonical JSON`);
        }
        entries.push(`${JSON.stringify(key)}:${canonicalizeJson(prop, seen)}`);
    }
    seen.delete(value);
    return `{${entries.join(',')}}`;
}

function sha256Utf8(text) {
    if (typeof text !== 'string') {
        throw new DiscussionError('INVALID_INPUT', 'sha256Utf8 requires a string');
    }
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Canonical(value) {
    return sha256Utf8(canonicalizeJson(value));
}

function assertNoUnknownKeys(obj, allowedSet, label) {
    for (const key of Object.keys(obj)) {
        if (!allowedSet.has(key)) {
            throw new DiscussionError('INVALID_INPUT', `${label} contains unknown field '${key}'`);
        }
    }
}

function validateId(value, label) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        throw new DiscussionError('INVALID_INPUT', `${label} must match [A-Za-z0-9._:-]{1,128}`);
    }
    return value;
}

function validateSha256(value, label) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        throw new DiscussionError('INVALID_INPUT', `${label} must be a 64-character lowercase hex SHA-256`);
    }
    return value;
}

function validateSafeNonNegativeInt(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new DiscussionError('INVALID_INPUT', `${label} must be a safe integer >= 0`);
    }
    return value;
}

function validateSafePositiveInt(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new DiscussionError('INVALID_INPUT', `${label} must be a safe integer > 0`);
    }
    return value;
}

function validateNonControlString(value, maxLen, label) {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > maxLen
        || value.trim().length === 0
        || CONTROL_CHAR_PATTERN.test(value)
    ) {
        throw new DiscussionError('INVALID_INPUT', `${label} must be a non-empty string up to ${maxLen} chars without control characters`);
    }
    return value;
}

const ALLOWED_LIMIT_KEYS = new Set([
    'maxParticipants',
    'maxInvocations',
    'maxTurns',
    'timeoutMs',
    'maxBodyBytes',
    'maxSnapshotBytes',
    'maxOutputBytes',
    'maxStdoutBytes',
    'maxStderrBytes',
    'maxJournalBytes',
    'maxBytes',
    'maxEvents',
    'ttlMs',
    'defaultTtlMs',
    'maxTtlMs',
]);

function resolveLimits(overrides = {}) {
    if (overrides === undefined) {
        return CEILINGS;
    }
    if (!isPlainObject(overrides)) {
        throw new DiscussionError('INVALID_INPUT', 'Limits overrides must be a plain object');
    }
    assertNoUnknownKeys(overrides, ALLOWED_LIMIT_KEYS, 'Limits');

    for (const key of Object.keys(overrides)) {
        validateSafePositiveInt(overrides[key], `limits.${key}`);
    }

    if (overrides.maxParticipants !== undefined && overrides.maxParticipants !== CEILINGS.maxParticipants) {
        throw new DiscussionError(
            overrides.maxParticipants > CEILINGS.maxParticipants ? 'LIMIT_EXCEEDED' : 'INVALID_INPUT',
            'v1 requires exactly 2 participants',
        );
    }

    const maxInvocations = overrides.maxInvocations ?? overrides.maxTurns ?? CEILINGS.maxInvocations;
    if (
        overrides.maxInvocations !== undefined
        && overrides.maxTurns !== undefined
        && overrides.maxInvocations !== overrides.maxTurns
    ) {
        throw new DiscussionError('INVALID_INPUT', 'maxInvocations and maxTurns cannot disagree');
    }
    if (maxInvocations > CEILINGS.maxInvocations) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxInvocations exceeds ceiling 24');
    }

    const timeoutMs = overrides.timeoutMs ?? CEILINGS.timeoutMs;
    if (timeoutMs > CEILINGS.timeoutMs) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'timeoutMs exceeds ceiling 120000');
    }

    const maxBodyBytes = overrides.maxBodyBytes ?? CEILINGS.maxBodyBytes;
    if (maxBodyBytes > CEILINGS.maxBodyBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxBodyBytes exceeds ceiling 16384');
    }

    const maxSnapshotBytes = overrides.maxSnapshotBytes ?? CEILINGS.maxSnapshotBytes;
    if (maxSnapshotBytes > CEILINGS.maxSnapshotBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxSnapshotBytes exceeds ceiling 65536');
    }

    const maxOutputBytes = overrides.maxOutputBytes ?? CEILINGS.maxOutputBytes;
    const maxStdoutBytes = overrides.maxStdoutBytes ?? maxOutputBytes;
    const maxStderrBytes = overrides.maxStderrBytes ?? maxOutputBytes;
    if (
        maxOutputBytes > CEILINGS.maxOutputBytes
        || maxStdoutBytes > CEILINGS.maxStdoutBytes
        || maxStderrBytes > CEILINGS.maxStderrBytes
    ) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'Output stream limit exceeds ceiling 262144');
    }

    const maxJournalBytes = overrides.maxJournalBytes ?? overrides.maxBytes ?? CEILINGS.maxJournalBytes;
    if (
        overrides.maxJournalBytes !== undefined
        && overrides.maxBytes !== undefined
        && overrides.maxJournalBytes !== overrides.maxBytes
    ) {
        throw new DiscussionError('INVALID_INPUT', 'maxJournalBytes and maxBytes cannot disagree');
    }
    if (maxJournalBytes > CEILINGS.maxJournalBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxJournalBytes exceeds ceiling 8 MiB');
    }

    const maxEvents = overrides.maxEvents ?? CEILINGS.maxEvents;
    if (maxEvents > CEILINGS.maxEvents) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxEvents exceeds ceiling 256');
    }

    const maxTtlMs = overrides.maxTtlMs ?? CEILINGS.maxTtlMs;
    if (maxTtlMs > CEILINGS.maxTtlMs) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxTtlMs exceeds ceiling 900000');
    }

    const ttlMs = overrides.ttlMs ?? overrides.defaultTtlMs ?? Math.min(CEILINGS.ttlMs, maxTtlMs);
    if (ttlMs > CEILINGS.maxTtlMs || ttlMs > maxTtlMs) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'ttlMs exceeds maxTtlMs ceiling');
    }

    return Object.freeze({
        maxParticipants: 2,
        maxInvocations,
        maxTurns: maxInvocations,
        timeoutMs,
        maxBodyBytes,
        maxSnapshotBytes,
        maxOutputBytes,
        maxStdoutBytes,
        maxStderrBytes,
        maxJournalBytes,
        maxEvents,
        ttlMs,
        maxTtlMs,
    });
}

const ALLOWED_BINDING_KEYS = new Set([
    'schema_version',
    'provider',
    'model',
    'effort',
    'conversation_id',
    'role',
    'session_id',
    'task_id',
    'plan_revision',
    'snapshot_sha256',
    'execution',
]);

const ALLOWED_EXECUTION_KEYS = new Set(['attempt', 'workspace_binding_sha256']);

function validateBinding(value) {
    if (!isPlainObject(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Binding must be a plain object');
    }
    assertNoUnknownKeys(value, ALLOWED_BINDING_KEYS, 'Binding');

    if (value.schema_version !== undefined && value.schema_version !== 1) {
        throw new DiscussionError('INVALID_INPUT', 'Binding schema_version must be 1');
    }

    const provider = validateId(value.provider, 'binding.provider');
    const model = validateNonControlString(value.model, 128, 'binding.model');
    const effort = validateNonControlString(value.effort, 128, 'binding.effort');
    const conversationId = validateId(value.conversation_id, 'binding.conversation_id');

    if (value.role !== 'astra' && value.role !== 'argon') {
        throw new DiscussionError('INVALID_INPUT', "binding.role must be 'astra' or 'argon'");
    }

    const sessionId = validateId(value.session_id, 'binding.session_id');
    const taskId = validateId(value.task_id, 'binding.task_id');
    const planRevision = validateSafeNonNegativeInt(value.plan_revision, 'binding.plan_revision');
    const snapshotSha256 = validateSha256(value.snapshot_sha256, 'binding.snapshot_sha256');

    let execution;
    if (value.execution !== undefined) {
        if (!isPlainObject(value.execution)) {
            throw new DiscussionError('INVALID_INPUT', 'binding.execution must be a plain object when provided');
        }
        assertNoUnknownKeys(value.execution, ALLOWED_EXECUTION_KEYS, 'binding.execution');
        const attempt = validateSafeNonNegativeInt(value.execution.attempt, 'binding.execution.attempt');
        const workspaceBindingSha256 = validateSha256(
            value.execution.workspace_binding_sha256,
            'binding.execution.workspace_binding_sha256',
        );
        execution = Object.freeze({
            attempt,
            workspace_binding_sha256: workspaceBindingSha256,
        });
    }

    const normalized = {
        schema_version: 1,
        provider,
        model,
        effort,
        conversation_id: conversationId,
        role: value.role,
        session_id: sessionId,
        task_id: taskId,
        plan_revision: planRevision,
        snapshot_sha256: snapshotSha256,
        ...(execution !== undefined ? { execution } : {}),
    };
    return Object.freeze(normalized);
}

function bindingRef(binding) {
    const validated = validateBinding(binding);
    return sha256Canonical(validated);
}

function extractBindingsArray(bindings) {
    if (Array.isArray(bindings)) {
        return bindings;
    }
    if (isPlainObject(bindings)) {
        if (bindings.astra !== undefined && bindings.argon !== undefined && Object.keys(bindings).length === 2) {
            return [bindings.astra, bindings.argon];
        }
        const values = Object.values(bindings);
        if (values.length === 2) {
            return values;
        }
    }
    throw new DiscussionError('INVALID_INPUT', 'Relay requires exactly 2 participant bindings');
}

function validateBindingPair(bindings, expectedSnapshotSha256) {
    const list = extractBindingsArray(bindings);
    if (list.length !== 2) {
        throw new DiscussionError('INVALID_INPUT', 'Relay requires exactly 2 participant bindings');
    }
    const b0 = validateBinding(list[0]);
    const b1 = validateBinding(list[1]);

    if (b0.role === b1.role) {
        throw new DiscussionError('CORRELATION_INVALID', 'Participant bindings must have distinct roles (astra and argon)');
    }
    if (b0.provider === b1.provider && b0.conversation_id === b1.conversation_id) {
        throw new DiscussionError('CORRELATION_INVALID', 'Participants sharing a provider cannot share conversation_id');
    }
    if (
        b0.session_id !== b1.session_id
        || b0.task_id !== b1.task_id
        || b0.plan_revision !== b1.plan_revision
        || b0.snapshot_sha256 !== b1.snapshot_sha256
    ) {
        throw new DiscussionError(
            'CORRELATION_INVALID',
            'Participant bindings must share session_id, task_id, plan_revision, and snapshot_sha256',
        );
    }
    if (expectedSnapshotSha256 !== undefined && b0.snapshot_sha256 !== expectedSnapshotSha256) {
        throw new DiscussionError(
            'CORRELATION_INVALID',
            'Participant binding snapshot_sha256 does not match registered snapshot',
        );
    }

    const hasExec0 = b0.execution !== undefined;
    const hasExec1 = b1.execution !== undefined;
    if (hasExec0 !== hasExec1) {
        throw new DiscussionError('CORRELATION_INVALID', 'Participant bindings must agree on execution reference presence');
    }
    if (
        hasExec0
        && (b0.execution.attempt !== b1.execution.attempt
            || b0.execution.workspace_binding_sha256 !== b1.execution.workspace_binding_sha256)
    ) {
        throw new DiscussionError('CORRELATION_INVALID', 'Participant bindings must share identical execution reference');
    }

    const ref0 = sha256Canonical(b0);
    const ref1 = sha256Canonical(b1);
    if (ref0 === ref1) {
        throw new DiscussionError('CORRELATION_INVALID', 'Participant binding_refs must be distinct');
    }

    const byRef = new Map([
        [ref0, b0],
        [ref1, b1],
    ]);
    const ordered = b0.role === 'astra' ? [b0, b1] : [b1, b0];
    return {
        bindings: Object.freeze(ordered),
        byRef,
    };
}

const ALLOWED_SNAPSHOT_KEYS = new Set(['schema_version', 'text', 'sha256']);

function validateSnapshot(value, limits = {}) {
    const resolvedLimits = resolveLimits(limits);
    if (!isPlainObject(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Snapshot must be a plain object');
    }
    assertNoUnknownKeys(value, ALLOWED_SNAPSHOT_KEYS, 'Snapshot');
    if (value.schema_version !== undefined && value.schema_version !== 1) {
        throw new DiscussionError('INVALID_INPUT', 'Snapshot schema_version must be 1');
    }
    if (typeof value.text !== 'string' || value.text.includes('\u0000')) {
        throw new DiscussionError('INVALID_INPUT', 'Snapshot text must be a valid UTF-8 string without NUL');
    }
    const byteLen = Buffer.byteLength(value.text, 'utf8');
    if (byteLen > resolvedLimits.maxSnapshotBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', `Snapshot exceeds ${resolvedLimits.maxSnapshotBytes} bytes`);
    }
    const sha256 = validateSha256(value.sha256, 'snapshot.sha256');
    const computed = sha256Utf8(value.text);
    if (computed !== sha256) {
        throw new DiscussionError('CORRELATION_INVALID', 'Snapshot sha256 does not match UTF-8 text');
    }
    return Object.freeze({
        text: value.text,
        sha256,
    });
}

const ALLOWED_PAYLOAD_KEYS = new Set(['schema_version', 'kind', 'body']);

function validatePayload(value, limits = {}) {
    const resolvedLimits = resolveLimits(limits);
    if (!isPlainObject(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Payload must be a plain object');
    }
    assertNoUnknownKeys(value, ALLOWED_PAYLOAD_KEYS, 'Payload');
    if (value.schema_version !== 1) {
        throw new DiscussionError('INVALID_INPUT', 'Payload schema_version must be 1');
    }
    if (value.kind !== 'question' && value.kind !== 'reply') {
        throw new DiscussionError('INVALID_INPUT', "Payload kind must be 'question' or 'reply'");
    }
    if (typeof value.body !== 'string' || value.body.length === 0 || value.body.includes('\u0000')) {
        throw new DiscussionError('INVALID_INPUT', 'Payload body must be a non-empty string without NUL');
    }
    const byteLen = Buffer.byteLength(value.body, 'utf8');
    if (byteLen > resolvedLimits.maxBodyBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', `Payload body exceeds ${resolvedLimits.maxBodyBytes} UTF-8 bytes`);
    }
    return Object.freeze({
        schema_version: 1,
        kind: value.kind,
        body: value.body,
    });
}

const ALLOWED_ENVELOPE_KEYS = new Set([
    'schema_version',
    'message_id',
    'sender_ref',
    'recipient_ref',
    'binding_ref',
    'sequence',
    'kind',
    'body',
    'reply_to',
    'payload_hash',
    'created_at',
    'expires_at',
]);

function canonicalEnvelopeShape(env) {
    return {
        schema_version: 1,
        message_id: env.message_id,
        sender_ref: env.sender_ref,
        recipient_ref: env.recipient_ref,
        binding_ref: env.recipient_ref,
        sequence: env.sequence,
        kind: env.kind,
        body: env.body,
        ...(env.reply_to !== undefined ? { reply_to: env.reply_to } : {}),
        payload_hash: sha256Utf8(env.body),
        created_at: env.created_at,
        expires_at: env.expires_at,
    };
}

function validateEnvelope(value, context = {}) {
    if (!isPlainObject(context)) {
        throw new DiscussionError('INVALID_INPUT', 'Envelope validation context must be a plain object');
    }
    const resolvedLimits = resolveLimits(context.limits || {});
    if (!isPlainObject(value)) {
        throw new DiscussionError('INVALID_INPUT', 'Envelope must be a plain object');
    }
    assertNoUnknownKeys(value, ALLOWED_ENVELOPE_KEYS, 'Envelope');

    if (value.schema_version !== 1) {
        throw new DiscussionError('INVALID_INPUT', 'Envelope schema_version must be 1');
    }
    const messageId = validateId(value.message_id, 'envelope.message_id');
    const senderRef = validateSha256(value.sender_ref, 'envelope.sender_ref');
    const recipientRef = validateSha256(value.recipient_ref, 'envelope.recipient_ref');
    const sequence = validateSafePositiveInt(value.sequence, 'envelope.sequence');

    if (value.kind !== 'question' && value.kind !== 'reply') {
        throw new DiscussionError('INVALID_INPUT', "envelope.kind must be 'question' or 'reply'");
    }
    if (typeof value.body !== 'string' || value.body.length === 0 || value.body.includes('\u0000')) {
        throw new DiscussionError('INVALID_INPUT', 'envelope.body must be a non-empty string without NUL');
    }
    const bodyBytes = Buffer.byteLength(value.body, 'utf8');
    if (bodyBytes > resolvedLimits.maxBodyBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', `envelope.body exceeds ${resolvedLimits.maxBodyBytes} UTF-8 bytes`);
    }

    const createdAt = validateSafeNonNegativeInt(value.created_at, 'envelope.created_at');
    const expiresAt = validateSafeNonNegativeInt(value.expires_at, 'envelope.expires_at');
    if (expiresAt <= createdAt) {
        throw new DiscussionError('INVALID_INPUT', 'envelope.expires_at must be greater than created_at');
    }

    if (value.reply_to !== undefined) {
        validateId(value.reply_to, 'envelope.reply_to');
    }

    const computedPayloadHash = sha256Utf8(value.body);
    if (value.payload_hash !== undefined && value.payload_hash !== computedPayloadHash) {
        throw new DiscussionError('CORRELATION_INVALID', 'envelope.payload_hash does not match body SHA-256');
    }
    if (value.binding_ref !== undefined && value.binding_ref !== recipientRef) {
        throw new DiscussionError('CORRELATION_INVALID', 'envelope.binding_ref must equal recipient_ref');
    }

    const candidateStored = canonicalEnvelopeShape({
        message_id: messageId,
        sender_ref: senderRef,
        recipient_ref: recipientRef,
        sequence,
        kind: value.kind,
        body: value.body,
        reply_to: value.reply_to,
        created_at: createdAt,
        expires_at: expiresAt,
    });

    const messages = Array.isArray(context.messages) ? context.messages : [];
    const existing = messages.find((msg) => msg && msg.message_id === messageId);
    if (existing) {
        const existingCanonical = canonicalizeJson(canonicalEnvelopeShape(existing));
        const candidateCanonical = canonicalizeJson(candidateStored);
        if (existingCanonical !== candidateCanonical) {
            throw new DiscussionError('MESSAGE_CONFLICT', `Message '${messageId}' conflicts with an existing envelope`);
        }
        const reusedCopy = { ...candidateStored };
        Object.defineProperty(reusedCopy, 'reused', {
            value: true,
            enumerable: false,
            writable: false,
            configurable: false,
        });
        return Object.freeze(reusedCopy);
    }

    const { byRef } = validateBindingPair(context.bindings);
    if (!byRef.has(senderRef) || !byRef.has(recipientRef) || senderRef === recipientRef) {
        throw new DiscussionError(
            'CORRELATION_INVALID',
            'sender_ref and recipient_ref must reference the two distinct registered participant bindings',
        );
    }

    const expectedSequence = context.nextSequence !== undefined
        ? validateSafePositiveInt(context.nextSequence, 'context.nextSequence')
        : messages.length + 1;
    if (sequence !== expectedSequence) {
        throw new DiscussionError(
            'CORRELATION_INVALID',
            `Envelope sequence ${sequence} does not match expected sequence ${expectedSequence}`,
        );
    }

    const ttl = expiresAt - createdAt;
    if (ttl > resolvedLimits.maxTtlMs) {
        throw new DiscussionError('LIMIT_EXCEEDED', `Envelope TTL ${ttl}ms exceeds maxTtlMs ${resolvedLimits.maxTtlMs}ms`);
    }
    if (context.now !== undefined) {
        const now = validateSafeNonNegativeInt(context.now, 'context.now');
        if (expiresAt <= now) {
            throw new DiscussionError('LIMIT_EXCEEDED', 'Envelope has already expired');
        }
    }

    if (value.kind === 'question') {
        if (value.reply_to !== undefined) {
            throw new DiscussionError('CORRELATION_INVALID', 'Question envelope cannot include reply_to');
        }
        if (messages.length > 0) {
            const previous = messages[messages.length - 1];
            if (
                !previous
                || previous.kind !== 'reply'
                || !(
                    (previous.recipient_ref === senderRef && previous.sender_ref === recipientRef)
                    || (previous.sender_ref === senderRef && previous.recipient_ref === recipientRef)
                )
            ) {
                throw new DiscussionError(
                    'CORRELATION_INVALID',
                    'Follow-up question must follow a reply between the same participants in either direction',
                );
            }
        }
    } else {
        if (value.reply_to === undefined) {
            throw new DiscussionError('CORRELATION_INVALID', 'Reply envelope must include reply_to');
        }
        const target = messages.find((msg) => msg && msg.message_id === value.reply_to);
        if (!target || target.kind !== 'question') {
            throw new DiscussionError('CORRELATION_INVALID', 'Reply must reference an existing question in the same relay');
        }
        if (target.recipient_ref !== senderRef || target.sender_ref !== recipientRef) {
            throw new DiscussionError('CORRELATION_INVALID', 'Reply must invert sender_ref and recipient_ref of the question');
        }
        const alreadyReplied = messages.some((msg) => msg && msg.kind === 'reply' && msg.reply_to === target.message_id);
        if (alreadyReplied) {
            throw new DiscussionError('CORRELATION_INVALID', `Question '${target.message_id}' already has a reply`);
        }
    }

    Object.defineProperty(candidateStored, 'reused', {
        value: false,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return Object.freeze(candidateStored);
}

module.exports = Object.freeze({
    ERROR_CODES,
    CEILINGS,
    DiscussionError,
    isPlainObject,
    cloneAndFreeze,
    canonicalizeJson,
    sha256Utf8,
    sha256Canonical,
    validateId,
    validateSha256,
    validateSafeNonNegativeInt,
    validateSafePositiveInt,
    validateNonControlString,
    resolveLimits,
    validateBinding,
    bindingRef,
    validateBindingPair,
    validateSnapshot,
    validatePayload,
    validateEnvelope,
});
