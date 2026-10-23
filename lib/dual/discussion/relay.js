'use strict';

const {
    DiscussionError,
    isPlainObject,
    cloneAndFreeze,
    canonicalizeJson,
    validateId,
    validateSafeNonNegativeInt,
    resolveLimits,
    validateBindingPair,
    bindingRef,
    validateSnapshot,
    validateEnvelope,
} = require('./contracts');
const {
    openJournal,
} = require('./journal');

const ALLOWED_RELAY_OPTION_KEYS = new Set([
    'enabled',
    'stateDir',
    'bindings',
    'snapshot',
    'authority',
    'capabilityVerifier',
    'adapters',
    'limits',
    'clock',
    'syncHook',
]);

function createInitialTurn(messageId) {
    return {
        message_id: messageId,
        invocation_id: null,
        has_dispatch_intent: false,
        receipt: 'stored',
        provider: 'not_started',
        schema: 'not_checked',
        task_acceptance: 'not_requested',
        discussion_result: 'none',
        response_message_id: null,
        reconciled: false,
        reconciled_outcome: null,
    };
}

function toTurnView(turn) {
    return Object.freeze({
        message_id: turn.message_id,
        invocation_id: turn.invocation_id,
        receipt: turn.receipt,
        provider: turn.provider,
        schema: turn.schema,
        task_acceptance: 'not_requested',
        discussion_result: turn.discussion_result,
        response_message_id: turn.response_message_id,
        reconciled: Boolean(turn.reconciled),
        ...(turn.reconciled_outcome ? { reconciled_outcome: turn.reconciled_outcome } : {}),
    });
}

function validateAdaptersMap(adaptersInput, orderedBindings) {
    if (!isPlainObject(adaptersInput) && !(adaptersInput instanceof Map)) {
        throw new DiscussionError('INVALID_INPUT', 'adapters must be a plain object or Map keyed by provider');
    }
    const byProvider = new Map();
    for (const binding of orderedBindings) {
        const candidate = adaptersInput instanceof Map
            ? adaptersInput.get(binding.provider)
            : adaptersInput[binding.provider];
        if (
            !candidate
            || typeof candidate !== 'object'
            || candidate.provider !== binding.provider
            || typeof candidate.id !== 'string'
            || typeof candidate.version !== 'string'
            || (candidate.mode !== 'fake' && candidate.mode !== 'live')
            || !isPlainObject(candidate.profile)
            || typeof candidate.invoke !== 'function'
            || typeof candidate.classify !== 'function'
        ) {
            throw new DiscussionError(
                'INVALID_INPUT',
                `Missing or invalid discussion adapter for provider '${binding.provider}'`,
            );
        }
        byProvider.set(binding.provider, candidate);
    }
    return byProvider;
}

function validatePorts(authority, capabilityVerifier) {
    if (!authority || typeof authority !== 'object' || typeof authority.check !== 'function') {
        throw new DiscussionError('INVALID_INPUT', 'authority port with check() function is required');
    }
    if (
        !capabilityVerifier
        || typeof capabilityVerifier !== 'object'
        || typeof capabilityVerifier.verify !== 'function'
        || typeof capabilityVerifier.verifyRecovery !== 'function'
    ) {
        throw new DiscussionError(
            'INVALID_INPUT',
            'capabilityVerifier port with verify() and verifyRecovery() functions is required',
        );
    }
}

function verifyCapabilityEvidence(evidence, {
    expectedBindingRef,
    binding,
    adapter,
    snapshotSha256,
    now,
}) {
    if (!isPlainObject(evidence) || evidence.allowed !== true) {
        throw new DiscussionError('CAPABILITY_BLOCKED', 'Capability verifier denied invocation');
    }
    if (
        typeof evidence.evidenceId !== 'string'
        || evidence.evidenceId.trim().length === 0
        || typeof evidence.expiresAt !== 'number'
        || !Number.isSafeInteger(evidence.expiresAt)
        || evidence.expiresAt <= now
    ) {
        throw new DiscussionError('CAPABILITY_BLOCKED', 'Capability evidence is missing or expired');
    }
    if (
        evidence.bindingRef !== expectedBindingRef
        || evidence.provider !== binding.provider
        || evidence.adapterId !== adapter.id
        || evidence.adapterVersion !== adapter.version
        || evidence.conversationId !== binding.conversation_id
        || evidence.snapshotSha256 !== snapshotSha256
        || evidence.stage !== 'dispatch'
    ) {
        throw new DiscussionError('CAPABILITY_BLOCKED', 'Capability evidence identity does not match invocation binding');
    }
    if (adapter.mode === 'live' && evidence.liveProfileVerified !== true) {
        throw new DiscussionError('CAPABILITY_BLOCKED', 'Live adapter requires liveProfileVerified === true');
    }
    return evidence;
}

function verifyRecoveryEvidence(rec, { expectedBindingRef, expectedInvocationId }) {
    if (
        !isPlainObject(rec)
        || rec.allowed !== true
        || rec.processQuiescent !== true
        || rec.providerTerminal !== true
        || (rec.providerOutcome !== 'succeeded' && rec.providerOutcome !== 'failed')
        || typeof rec.evidenceId !== 'string'
        || rec.evidenceId.trim().length === 0
        || rec.bindingRef !== expectedBindingRef
        || rec.invocationId !== expectedInvocationId
    ) {
        throw new DiscussionError(
            'OUTCOME_UNKNOWN',
            'Recovery requires verified processQuiescent, providerTerminal, non-unknown providerOutcome, and matching identity',
        );
    }
    return rec;
}

async function createDiscussionRelay(options = {}) {
    if (!isPlainObject(options) || options.enabled !== true) {
        throw new DiscussionError('DISCUSSION_DISABLED', 'Discussion relay is disabled unless enabled === true');
    }
    for (const key of Object.keys(options)) {
        if (!ALLOWED_RELAY_OPTION_KEYS.has(key)) {
            throw new DiscussionError('INVALID_INPUT', `createDiscussionRelay contains unknown option '${key}'`);
        }
    }

    const limits = resolveLimits(options.limits || {});
    const snapshot = validateSnapshot(options.snapshot, limits);
    const { bindings: orderedBindings, byRef: bindingsByRef } = validateBindingPair(options.bindings, snapshot.sha256);
    validatePorts(options.authority, options.capabilityVerifier);
    const adaptersByProvider = validateAdaptersMap(options.adapters, orderedBindings);
    const clock = options.clock === undefined ? () => Date.now() : options.clock;
    if (typeof clock !== 'function') {
        throw new DiscussionError('INVALID_INPUT', 'clock must be a function');
    }
    validateSafeNonNegativeInt(clock(), 'clock()');

    const authority = options.authority;
    const capabilityVerifier = options.capabilityVerifier;

    const canonicalRegistration = orderedBindings.map((b) => ({
        ...b,
        binding_ref: bindingRef(b),
    }));

    const journal = await openJournal({
        stateDir: options.stateDir,
        maxBytes: limits.maxJournalBytes,
        maxEvents: limits.maxEvents,
        clock,
        syncHook: options.syncHook,
    });

    const messages = [];
    const turnsByMessageId = new Map();
    const turnsByInvocationId = new Map();
    let invocationCount = 0;
    let unknownState = null;

    try {
        const initialRead = await journal.read();
        if (initialRead.events.length === 0) {
            await journal.append({
                type: 'registered',
                bindings: canonicalRegistration,
                snapshot_sha256: snapshot.sha256,
            });
        } else {
            const firstEv = initialRead.events[0].event;
            if (
                firstEv.type !== 'registered'
                || firstEv.snapshot_sha256 !== snapshot.sha256
                || canonicalizeJson(firstEv.bindings) !== canonicalizeJson(canonicalRegistration)
            ) {
                await journal.close();
                throw new DiscussionError(
                    'CORRELATION_INVALID',
                    'Existing journal registration does not match supplied bindings or snapshot',
                );
            }

            for (let i = 1; i < initialRead.events.length; i++) {
                const ev = initialRead.events[i].event;
                if (ev.type === 'received') {
                    const env = cloneAndFreeze(ev.envelope);
                    messages.push(env);
                    turnsByMessageId.set(env.message_id, createInitialTurn(env.message_id));
                } else if (ev.type === 'dispatch_intent') {
                    const turn = turnsByMessageId.get(ev.message_id);
                    if (!turn) {
                        throw new DiscussionError('JOURNAL_INVALID', 'dispatch_intent references unknown message_id');
                    }
                    invocationCount += 1;
                    turn.has_dispatch_intent = true;
                    turn.invocation_id = ev.invocation_id;
                    turn.provider = 'outcome_unknown';
                    turn.discussion_result = 'none';
                    turnsByInvocationId.set(ev.invocation_id, turn);
                    unknownState = {
                        message_id: ev.message_id,
                        invocation_id: ev.invocation_id,
                        binding_ref: ev.binding_ref,
                        reason: 'in_flight_after_intent',
                    };
                } else if (ev.type === 'observation') {
                    const turn = turnsByInvocationId.get(ev.invocation_id);
                    if (!turn) {
                        throw new DiscussionError('JOURNAL_INVALID', 'observation references unknown invocation_id');
                    }
                    turn.schema = ev.schema || 'not_checked';
                    if (ev.completion === 'failed') {
                        turn.provider = 'failed';
                        turn.discussion_result = 'rejected';
                        if (unknownState && unknownState.invocation_id === ev.invocation_id) {
                            unknownState = null;
                        }
                    } else if (ev.completion === 'succeeded') {
                        turn.provider = 'succeeded';
                        turn.discussion_result = ev.discussion_result || 'none';
                        if (
                            ev.discussion_result === 'rejected'
                            && unknownState
                            && unknownState.invocation_id === ev.invocation_id
                        ) {
                            unknownState = null;
                        }
                    } else {
                        turn.provider = 'outcome_unknown';
                        turn.discussion_result = 'none';
                    }
                } else if (ev.type === 'response') {
                    const turn = turnsByInvocationId.get(ev.invocation_id);
                    if (!turn) {
                        throw new DiscussionError('JOURNAL_INVALID', 'response references unknown invocation_id');
                    }
                    turn.discussion_result = ev.discussion_result;
                    if (unknownState && unknownState.invocation_id === ev.invocation_id) {
                        unknownState = null;
                    }
                    if (ev.discussion_result === 'available' && ev.response_envelope) {
                        const respEnv = cloneAndFreeze(ev.response_envelope);
                        messages.push(respEnv);
                        turnsByMessageId.set(respEnv.message_id, createInitialTurn(respEnv.message_id));
                        turn.response_message_id = respEnv.message_id;
                    }
                } else if (ev.type === 'outcome_unknown') {
                    const turn = turnsByInvocationId.get(ev.invocation_id) || turnsByMessageId.get(ev.message_id);
                    if (turn) {
                        turn.provider = 'outcome_unknown';
                        turn.schema = ev.schema || turn.schema;
                        turn.discussion_result = 'none';
                    }
                    unknownState = {
                        message_id: ev.message_id,
                        invocation_id: ev.invocation_id,
                        binding_ref: ev.binding_ref,
                        reason: ev.reason || 'outcome_unknown',
                    };
                } else if (ev.type === 'reconciled') {
                    const turn = turnsByInvocationId.get(ev.invocation_id) || turnsByMessageId.get(ev.message_id);
                    if (turn) {
                        turn.reconciled = true;
                        turn.reconciled_outcome = ev.provider_outcome;
                    }
                    if (unknownState && unknownState.invocation_id === ev.invocation_id) {
                        unknownState = null;
                    }
                }
            }
        }
    } catch (err) {
        if (err instanceof DiscussionError) {
            throw err;
        }
        throw new DiscussionError('JOURNAL_INVALID', `Failed during journal replay: ${err.message}`);
    }

    let closed = false;
    let inFlightInvocation = null;
    let stateQueue = Promise.resolve();

    function enqueueState(fn) {
        const next = stateQueue.then(fn, fn);
        stateQueue = next.catch(() => {});
        return next;
    }

    function assertOpen() {
        if (closed) {
            throw new DiscussionError('RELAY_CLOSED', 'Discussion relay is closed');
        }
    }

    async function receive(envelopeInput) {
        const snapshotEnvelope = isPlainObject(envelopeInput)
            ? cloneAndFreeze(envelopeInput)
            : envelopeInput;
        return enqueueState(async () => {
            assertOpen();
            const now = validateSafeNonNegativeInt(clock(), 'clock()');
            const validated = validateEnvelope(snapshotEnvelope, {
                bindings: orderedBindings,
                messages,
                nextSequence: messages.length + 1,
                now,
                limits,
            });
            if (validated.reused === true) {
                return Object.freeze({
                    acknowledged: true,
                    reused: true,
                    message_id: validated.message_id,
                });
            }
            await journal.append({
                type: 'received',
                envelope: validated,
            });
            messages.push(validated);
            turnsByMessageId.set(validated.message_id, createInitialTurn(validated.message_id));
            return Object.freeze({
                acknowledged: true,
                reused: false,
                message_id: validated.message_id,
            });
        });
    }

    async function executeDispatch(messageId) {
        assertOpen();
        if (unknownState !== null) {
            throw new DiscussionError('OUTCOME_UNKNOWN', 'Relay is blocked by an unresolved unknown outcome');
        }

        const envelope = messages.find((m) => m.message_id === messageId);
        const turn = turnsByMessageId.get(messageId);
        if (!envelope || !turn) {
            throw new DiscussionError('INVALID_INPUT', `Unknown message_id '${messageId}'`);
        }

        if (turn.has_dispatch_intent) {
            return toTurnView(turn);
        }

        if (invocationCount + 1 > limits.maxInvocations) {
            throw new DiscussionError('LIMIT_EXCEEDED', `Relay invocation count exceeds ceiling ${limits.maxInvocations}`);
        }

        const nowPre = validateSafeNonNegativeInt(clock(), 'clock()');
        if (envelope.expires_at <= nowPre) {
            throw new DiscussionError('LIMIT_EXCEEDED', `Message '${messageId}' has expired`);
        }

        const binding = bindingsByRef.get(envelope.recipient_ref);
        const adapter = adaptersByProvider.get(binding.provider);

        let authDispatchOk = false;
        try {
            authDispatchOk = (await authority.check({
                bindings: cloneAndFreeze(orderedBindings),
                stage: 'dispatch',
            })) === true;
        } catch {
            authDispatchOk = false;
        }
        if (!authDispatchOk) {
            throw new DiscussionError('AUTHORITY_STALE', 'Current authority check failed before dispatch');
        }

        let rawCapEvidence;
        try {
            rawCapEvidence = await capabilityVerifier.verify({
                binding: cloneAndFreeze(binding),
                bindingRef: envelope.recipient_ref,
                snapshotSha256: snapshot.sha256,
                adapterId: adapter.id,
                provider: adapter.provider,
                adapterVersion: adapter.version,
                mode: adapter.mode,
                stage: 'dispatch',
            });
        } catch (err) {
            if (err instanceof DiscussionError) {
                throw err;
            }
            throw new DiscussionError('CAPABILITY_BLOCKED', `Capability verifier failed: ${err.message}`);
        }
        const verifiedCap = verifyCapabilityEvidence(rawCapEvidence, {
            expectedBindingRef: envelope.recipient_ref,
            binding,
            adapter,
            snapshotSha256: snapshot.sha256,
            now: nowPre,
        });

        const invocationId = `inv-${invocationCount + 1}-${envelope.sequence}`;

        // Durable dispatch_intent before invoking provider
        await journal.append({
            type: 'dispatch_intent',
            message_id: messageId,
            invocation_id: invocationId,
            binding_ref: envelope.recipient_ref,
            capability_evidence_id: verifiedCap.evidenceId,
        });

        invocationCount += 1;
        turn.has_dispatch_intent = true;
        turn.invocation_id = invocationId;
        turn.provider = 'pending';
        turnsByInvocationId.set(invocationId, turn);

        let rawObs;
        let classified;
        try {
            rawObs = await adapter.invoke({
                binding,
                snapshot,
                envelope,
                invocationId,
                timeoutMs: limits.timeoutMs,
                maxOutputBytes: limits.maxOutputBytes,
            });
            if (rawObs && rawObs.latePromise && typeof rawObs.latePromise.catch === 'function') {
                rawObs.latePromise.catch(() => {});
            }
            classified = adapter.classify(rawObs, binding, invocationId, limits);
        } catch {
            classified = {
                completion: 'unknown',
                schema: 'not_checked',
                payload: null,
                evidenceRef: 'post_intent_exception',
            };
        }

        if (classified.completion === 'unknown') {
            turn.provider = 'outcome_unknown';
            turn.schema = classified.schema || 'not_checked';
            turn.discussion_result = 'none';
            unknownState = {
                message_id: messageId,
                invocation_id: invocationId,
                binding_ref: envelope.recipient_ref,
                reason: classified.evidenceRef || 'unknown_provider_outcome',
            };
            try {
                await journal.append({
                    type: 'outcome_unknown',
                    message_id: messageId,
                    invocation_id: invocationId,
                    binding_ref: envelope.recipient_ref,
                    reason: unknownState.reason,
                    schema: turn.schema,
                });
            } catch {
                // If journal append also fails (e.g., quota or sync error), relay remains blocked in unknownState
            }
            throw new DiscussionError('OUTCOME_UNKNOWN', `Invocation '${invocationId}' ended with unknown outcome`);
        }

        const expectedResponseKind = envelope.kind === 'question' ? 'reply' : 'question';
        let effectiveSchema = classified.schema;
        if (effectiveSchema === 'valid' && (!classified.payload || classified.payload.kind !== expectedResponseKind)) {
            effectiveSchema = 'invalid';
        }

        if (classified.completion === 'failed') {
            try {
                await journal.append({
                    type: 'observation',
                    message_id: messageId,
                    invocation_id: invocationId,
                    completion: 'failed',
                    schema: effectiveSchema,
                    evidence_ref: classified.evidenceRef,
                    discussion_result: 'rejected',
                });
            } catch {
                turn.provider = 'outcome_unknown';
                turn.schema = effectiveSchema;
                turn.discussion_result = 'none';
                unknownState = {
                    message_id: messageId,
                    invocation_id: invocationId,
                    binding_ref: envelope.recipient_ref,
                    reason: 'observation_persist_failed',
                };
                throw new DiscussionError('OUTCOME_UNKNOWN', 'Failed to persist terminal failure observation');
            }
            turn.provider = 'failed';
            turn.schema = effectiveSchema;
            turn.discussion_result = 'rejected';
            return toTurnView(turn);
        }

        if (effectiveSchema !== 'valid') {
            try {
                await journal.append({
                    type: 'observation',
                    message_id: messageId,
                    invocation_id: invocationId,
                    completion: 'succeeded',
                    schema: 'invalid',
                    evidence_ref: classified.evidenceRef,
                    discussion_result: 'rejected',
                });
            } catch {
                turn.provider = 'outcome_unknown';
                turn.schema = 'invalid';
                turn.discussion_result = 'none';
                unknownState = {
                    message_id: messageId,
                    invocation_id: invocationId,
                    binding_ref: envelope.recipient_ref,
                    reason: 'observation_persist_failed',
                };
                throw new DiscussionError('OUTCOME_UNKNOWN', 'Failed to persist invalid-schema observation');
            }
            turn.provider = 'succeeded';
            turn.schema = 'invalid';
            turn.discussion_result = 'rejected';
            return toTurnView(turn);
        }

        // Durable terminal observation before response publication
        try {
            await journal.append({
                type: 'observation',
                message_id: messageId,
                invocation_id: invocationId,
                completion: 'succeeded',
                schema: 'valid',
                evidence_ref: classified.evidenceRef,
            });
        } catch {
            turn.provider = 'outcome_unknown';
            turn.schema = 'valid';
            turn.discussion_result = 'none';
            unknownState = {
                message_id: messageId,
                invocation_id: invocationId,
                binding_ref: envelope.recipient_ref,
                reason: 'observation_persist_failed',
            };
            throw new DiscussionError('OUTCOME_UNKNOWN', 'Failed to persist terminal observation');
        }
        turn.provider = 'succeeded';
        turn.schema = 'valid';

        const nowPost = validateSafeNonNegativeInt(clock(), 'clock()');
        let authResultOk = false;
        try {
            authResultOk = (await authority.check({
                bindings: cloneAndFreeze(orderedBindings),
                stage: 'result',
            })) === true;
        } catch {
            authResultOk = false;
        }
        const notExpired = envelope.expires_at > nowPost;

        if (!authResultOk || !notExpired) {
            try {
                await journal.append({
                    type: 'response',
                    message_id: messageId,
                    invocation_id: invocationId,
                    discussion_result: 'stale',
                    reason: !authResultOk ? 'authority_stale' : 'message_expired',
                });
            } catch {
                turn.discussion_result = 'none';
                turn.response_message_id = null;
                unknownState = {
                    message_id: messageId,
                    invocation_id: invocationId,
                    binding_ref: envelope.recipient_ref,
                    reason: 'response_persist_failed',
                };
                throw new DiscussionError('OUTCOME_UNKNOWN', 'Failed to persist stale response state');
            }
            turn.discussion_result = 'stale';
            turn.response_message_id = null;
            return toTurnView(turn);
        }

        const synthesizedInput = {
            schema_version: 1,
            message_id: `resp-${invocationId}`,
            sender_ref: envelope.recipient_ref,
            recipient_ref: envelope.sender_ref,
            sequence: messages.length + 1,
            kind: expectedResponseKind,
            body: classified.payload.body,
            ...(expectedResponseKind === 'reply' ? { reply_to: envelope.message_id } : {}),
            created_at: nowPost,
            expires_at: nowPost + Math.min(limits.ttlMs, limits.maxTtlMs),
        };

        const responseEnvelope = validateEnvelope(synthesizedInput, {
            bindings: orderedBindings,
            messages,
            nextSequence: messages.length + 1,
            now: nowPost,
            limits,
        });

        try {
            await journal.append({
                type: 'response',
                message_id: messageId,
                invocation_id: invocationId,
                discussion_result: 'available',
                response_envelope: responseEnvelope,
            });
        } catch {
            turn.discussion_result = 'none';
            turn.response_message_id = null;
            unknownState = {
                message_id: messageId,
                invocation_id: invocationId,
                binding_ref: envelope.recipient_ref,
                reason: 'response_persist_failed',
            };
            throw new DiscussionError('OUTCOME_UNKNOWN', 'Failed to persist response envelope');
        }

        messages.push(responseEnvelope);
        turnsByMessageId.set(responseEnvelope.message_id, createInitialTurn(responseEnvelope.message_id));
        turn.discussion_result = 'available';
        turn.response_message_id = responseEnvelope.message_id;

        return toTurnView(turn);
    }

    function dispatch(messageIdInput) {
        let messageId;
        try {
            messageId = validateId(messageIdInput, 'messageId');
            assertOpen();
            if (unknownState !== null) {
                throw new DiscussionError('OUTCOME_UNKNOWN', 'Relay is blocked by an unresolved unknown outcome');
            }
        } catch (err) {
            return Promise.reject(err);
        }

        if (inFlightInvocation !== null) {
            if (inFlightInvocation.messageId === messageId) {
                return inFlightInvocation.promise;
            }
            return Promise.reject(
                new DiscussionError('OWNER_BUSY', 'Another invocation is currently active on this relay'),
            );
        }

        const runPromise = enqueueState(() => executeDispatch(messageId)).finally(() => {
            if (inFlightInvocation && inFlightInvocation.messageId === messageId) {
                inFlightInvocation = null;
            }
        });
        inFlightInvocation = {
            messageId,
            promise: runPromise,
        };
        return runPromise;
    }

    async function reconcile(messageIdInput, evidence = {}) {
        if (inFlightInvocation !== null) {
            throw new DiscussionError('OWNER_BUSY', 'Cannot reconcile while an invocation is active');
        }
        const messageId = validateId(messageIdInput, 'messageId');
        if (!isPlainObject(evidence)) {
            throw new DiscussionError('INVALID_INPUT', 'reconcile evidence must be a plain object');
        }
        const snapshotEvidence = cloneAndFreeze(evidence);
        return enqueueState(async () => {
            assertOpen();
            if (!unknownState || unknownState.message_id !== messageId) {
                throw new DiscussionError('INVALID_INPUT', `Message '${messageId}' does not have an unresolved unknown outcome`);
            }

            let authRecoveryOk = false;
            try {
                authRecoveryOk = (await authority.check({
                    bindings: cloneAndFreeze(orderedBindings),
                    stage: 'recovery',
                })) === true;
            } catch {
                authRecoveryOk = false;
            }
            if (!authRecoveryOk) {
                throw new DiscussionError('AUTHORITY_STALE', 'Current authority check failed during recovery');
            }

            const binding = bindingsByRef.get(unknownState.binding_ref);
            let rawRec;
            try {
                rawRec = await capabilityVerifier.verifyRecovery({
                    binding: cloneAndFreeze(binding),
                    bindingRef: unknownState.binding_ref,
                    invocationId: unknownState.invocation_id,
                    evidence: snapshotEvidence,
                });
            } catch (err) {
                if (err instanceof DiscussionError) {
                    throw err;
                }
                throw new DiscussionError('OUTCOME_UNKNOWN', `Recovery verification failed: ${err.message}`);
            }

            const verifiedRec = verifyRecoveryEvidence(rawRec, {
                expectedBindingRef: unknownState.binding_ref,
                expectedInvocationId: unknownState.invocation_id,
            });

            const turn = turnsByMessageId.get(messageId);
            await journal.append({
                type: 'reconciled',
                message_id: messageId,
                invocation_id: unknownState.invocation_id,
                binding_ref: unknownState.binding_ref,
                provider_outcome: verifiedRec.providerOutcome,
                evidence_id: verifiedRec.evidenceId,
            });

            unknownState = null;
            turn.reconciled = true;
            turn.reconciled_outcome = verifiedRec.providerOutcome;
            return toTurnView(turn);
        });
    }

    async function inspect() {
        return enqueueState(async () => {
            const turns = messages.map((m) => toTurnView(turnsByMessageId.get(m.message_id)));
            return cloneAndFreeze({
                closed,
                blocked: unknownState !== null,
                unknown: unknownState ? { ...unknownState } : null,
                invocation_count: invocationCount,
                bindings: canonicalRegistration,
                snapshot_sha256: snapshot.sha256,
                messages: messages.map((m) => ({ ...m })),
                turns,
            });
        });
    }

    async function close() {
        if (inFlightInvocation !== null) {
            throw new DiscussionError('OWNER_BUSY', 'Cannot close relay while an invocation is active');
        }
        return enqueueState(async () => {
            if (closed) {
                if (unknownState !== null) {
                    throw new DiscussionError('OUTCOME_UNKNOWN', 'Relay closed with unresolved unknown outcome; lock retained');
                }
                return;
            }
            if (unknownState !== null) {
                closed = true;
                try {
                    await journal.close({ retainLock: true });
                } catch {
                    // Lock is already retained on disk when journal is poisoned
                }
                throw new DiscussionError('OUTCOME_UNKNOWN', 'Cannot release owner lock while outcome is unknown');
            }
            await journal.close();
            closed = true;
        });
    }

    return Object.freeze({
        receive,
        dispatch,
        inspect,
        reconcile,
        close,
    });
}

module.exports = Object.freeze({
    createDiscussionRelay,
});
