'use strict';

const { redactDiagnostic } = require('../validator-security');

const {
    DiscussionError,
    CEILINGS,
    isPlainObject,
    cloneAndFreeze,
    validateId,
    validateNonControlString,
    validateSafePositiveInt,
    validateBinding,
    validateSnapshot,
    validatePayload,
    resolveLimits,
} = require('./contracts');

const ALLOWED_ADAPTER_KEYS = new Set([
    'id',
    'provider',
    'version',
    'mode',
    'profile',
    'invoke',
    'classify',
]);

const ALLOWED_PROFILE_KEYS = new Set([
    'format',
    'allowlistedTerminalMarkers',
    'requireConversationMatch',
]);

const ALLOWED_CLASSIFY_KEYS = new Set([
    'completion',
    'payload',
    'evidenceRef',
    'terminalMarker',
    'observedConversationId',
    'observedInvocationId',
    'hasTerminalError',
]);

function validateProfile(profile) {
    if (!isPlainObject(profile)) {
        throw new DiscussionError('INVALID_INPUT', 'adapter.profile must be a plain object');
    }
    for (const key of Object.keys(profile)) {
        if (!ALLOWED_PROFILE_KEYS.has(key)) {
            throw new DiscussionError('INVALID_INPUT', `adapter.profile contains unknown field '${key}'`);
        }
    }
    if (profile.format !== 'json' && profile.format !== 'jsonl') {
        throw new DiscussionError('INVALID_INPUT', "adapter.profile.format must be 'json' or 'jsonl'");
    }
    if (profile.requireConversationMatch !== true) {
        throw new DiscussionError('INVALID_INPUT', 'adapter.profile.requireConversationMatch must be true');
    }
    if (!Array.isArray(profile.allowlistedTerminalMarkers) || profile.allowlistedTerminalMarkers.length === 0) {
        throw new DiscussionError('INVALID_INPUT', 'adapter.profile.allowlistedTerminalMarkers must be a non-empty array');
    }
    const seen = new Set();
    const markers = [];
    for (const marker of profile.allowlistedTerminalMarkers) {
        const valid = validateNonControlString(marker, 128, 'allowlistedTerminalMarker');
        if (valid === '*' || seen.has(valid)) {
            throw new DiscussionError('INVALID_INPUT', 'allowlistedTerminalMarkers must be explicit unique markers');
        }
        seen.add(valid);
        markers.push(valid);
    }
    return {
        frozenProfile: Object.freeze({
            format: profile.format,
            allowlistedTerminalMarkers: Object.freeze(markers),
            requireConversationMatch: true,
        }),
        allowlistedSet: seen,
    };
}

function createDiscussionAdapter(config) {
    if (!isPlainObject(config)) {
        throw new DiscussionError('INVALID_INPUT', 'Adapter configuration must be a plain object');
    }
    for (const key of Object.keys(config)) {
        if (!ALLOWED_ADAPTER_KEYS.has(key)) {
            throw new DiscussionError('INVALID_INPUT', `Adapter configuration contains unknown field '${key}'`);
        }
    }

    const id = validateId(config.id, 'adapter.id');
    const provider = validateId(config.provider, 'adapter.provider');
    const version = validateNonControlString(config.version, 128, 'adapter.version');
    if (config.mode !== 'fake' && config.mode !== 'live') {
        throw new DiscussionError('INVALID_INPUT', "adapter.mode must be 'fake' or 'live'");
    }
    const mode = config.mode;
    const { frozenProfile, allowlistedSet } = validateProfile(config.profile);

    if (typeof config.invoke !== 'function') {
        throw new DiscussionError('INVALID_INPUT', 'adapter.invoke must be a function');
    }
    if (typeof config.classify !== 'function') {
        throw new DiscussionError('INVALID_INPUT', 'adapter.classify must be a function');
    }

    const rawInvoke = config.invoke;
    const rawClassify = config.classify;

    async function invoke(params = {}) {
        if (!isPlainObject(params)) {
            throw new DiscussionError('INVALID_INPUT', 'adapter.invoke params must be a plain object');
        }
        const binding = validateBinding(params.binding);
        if (binding.provider !== provider) {
            throw new DiscussionError('CORRELATION_INVALID', `Adapter provider '${provider}' does not match binding provider '${binding.provider}'`);
        }
        const maxOutputBytes = params.maxOutputBytes === undefined
            ? CEILINGS.maxOutputBytes
            : validateSafePositiveInt(params.maxOutputBytes, 'maxOutputBytes');
        if (maxOutputBytes > CEILINGS.maxOutputBytes) {
            throw new DiscussionError('LIMIT_EXCEEDED', 'maxOutputBytes exceeds ceiling 262144');
        }
        const timeoutMs = params.timeoutMs === undefined
            ? CEILINGS.timeoutMs
            : validateSafePositiveInt(params.timeoutMs, 'timeoutMs');
        if (timeoutMs > CEILINGS.timeoutMs) {
            throw new DiscussionError('LIMIT_EXCEEDED', 'timeoutMs exceeds ceiling 120000');
        }
        const snapshot = validateSnapshot(params.snapshot);
        const invocationId = validateId(params.invocationId, 'invocationId');
        if (!isPlainObject(params.envelope)) {
            throw new DiscussionError('INVALID_INPUT', 'adapter.invoke envelope must be a plain object');
        }
        const envelope = cloneAndFreeze(params.envelope);

        const controller = new AbortController();
        if (params.signal) {
            if (params.signal.aborted) {
                controller.abort();
            } else if (typeof params.signal.addEventListener === 'function') {
                params.signal.addEventListener('abort', () => controller.abort(), { once: true });
            }
        }

        let timer = null;
        let timedOutByWrapper = false;
        let nudged = false;
        let nudgeDenied = false;
        const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => {
                timedOutByWrapper = true;
                controller.abort();
                resolve({
                    exitCode: null,
                    stdout: '',
                    stderr: '',
                    timedOut: true,
                    overflowed: false,
                    hasTerminalError: false,
                    transportError: false,
                });
            }, timeoutMs);
        });

        const invokePromise = (async () => {
            try {
                return await rawInvoke({
                    binding,
                    snapshot,
                    envelope,
                    invocationId,
                    timeoutMs,
                    maxOutputBytes,
                    signal: controller.signal,
                    markNudged: (denialAware = false) => { nudged = true; nudgeDenied = denialAware; },
                });
            } catch (err) {
                return {
                    exitCode: null,
                    stdout: '',
                    stderr: '',
                    timedOut: timedOutByWrapper,
                    overflowed: false,
                    hasTerminalError: false,
                    transportError: true,
                    errorCode: err && typeof err.code === 'string' ? err.code : 'INVOKE_THROWN',
                };
            }
        })();

        let rawResult;
        try {
            rawResult = await Promise.race([invokePromise, timeoutPromise]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }

        if (!isPlainObject(rawResult)) {
            return Object.freeze({
                exitCode: null,
                stdout: '',
                stderr: '',
                timedOut: timedOutByWrapper,
                overflowed: false,
                hasTerminalError: false,
                transportError: true,
                latePromise: timedOutByWrapper ? invokePromise : null,
            });
        }

        const stdout = typeof rawResult.stdout === 'string' ? rawResult.stdout : '';
        const stderr = typeof rawResult.stderr === 'string' ? rawResult.stderr : '';
        const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
        const stderrBytes = Buffer.byteLength(stderr, 'utf8');
        const overflowed = Boolean(rawResult.overflowed) || stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes;
        const timedOut = Boolean(rawResult.timedOut) || timedOutByWrapper || Boolean(controller.signal.aborted);
        const exitCode = Number.isInteger(rawResult.exitCode) ? rawResult.exitCode : null;

        return Object.freeze({
            exitCode,
            stdout: overflowed ? stdout.slice(0, maxOutputBytes) : stdout,
            stderr: overflowed ? stderr.slice(0, maxOutputBytes) : stderr,
            stdoutBytes,
            stderrBytes,
            timedOut,
            overflowed,
            hasTerminalError: Boolean(rawResult.hasTerminalError),
            transportError: Boolean(rawResult.transportError),
            pid: Number.isSafeInteger(rawResult.pid) && rawResult.pid > 0 ? rawResult.pid : null,
            latePromise: timedOutByWrapper ? invokePromise : null,
            ...(nudged ? { nudged: true, ...(nudgeDenied ? { nudgeDenied: true } : {}) } : {}),
            // Live adapters attach the prompt's expectation to this invocation.
            ...(rawResult.expectedKind === 'question' || rawResult.expectedKind === 'reply'
                ? { expectedKind: rawResult.expectedKind } : {}),
        });
    }

    function classifyObservation(raw, bindingInput, invocationIdInput, limitsInput = {}) {
        const binding = validateBinding(bindingInput);
        const invocationId = validateId(invocationIdInput, 'invocationId');
        const limits = resolveLimits(limitsInput);

        if (!isPlainObject(raw)) {
            return Object.freeze({
                completion: 'unknown',
                schema: 'not_checked',
                payload: null,
                evidenceRef: 'invalid_raw_observation',
                terminalMarker: null,
                observedConversationId: null,
                observedInvocationId: null,
            });
        }

        const stdout = typeof raw.stdout === 'string' ? raw.stdout : '';
        const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';
        const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
        const stderrBytes = Buffer.byteLength(stderr, 'utf8');
        const overflowed = Boolean(raw.overflowed)
            || stdoutBytes > limits.maxStdoutBytes
            || stderrBytes > limits.maxStderrBytes;
        const timedOut = Boolean(raw.timedOut);
        const transportError = Boolean(raw.transportError);

        if (timedOut || overflowed || transportError) {
            return Object.freeze({
                completion: 'unknown',
                schema: 'not_checked',
                payload: null,
                evidenceRef: timedOut ? 'timed_out' : (overflowed ? 'output_overflow' : 'transport_error'),
                terminalMarker: null,
                observedConversationId: null,
                observedInvocationId: null,
            });
        }

        let classified;
        try {
            classified = rawClassify(cloneAndFreeze(raw), binding, invocationId);
        } catch {
            return Object.freeze({
                completion: 'unknown',
                schema: 'not_checked',
                payload: null,
                evidenceRef: 'classifier_exception',
                terminalMarker: null,
                observedConversationId: null,
                observedInvocationId: null,
            });
        }

        if (!isPlainObject(classified)) {
            return Object.freeze({
                completion: 'unknown',
                schema: 'not_checked',
                payload: null,
                evidenceRef: 'classifier_invalid_shape',
                terminalMarker: null,
                observedConversationId: null,
                observedInvocationId: null,
            });
        }
        for (const key of Object.keys(classified)) {
            if (!ALLOWED_CLASSIFY_KEYS.has(key)) {
                return Object.freeze({
                    completion: 'unknown',
                    schema: 'not_checked',
                    payload: null,
                    evidenceRef: 'classifier_unknown_key',
                    terminalMarker: null,
                    observedConversationId: null,
                    observedInvocationId: null,
                });
            }
        }

        let schema = 'not_checked';
        let validatedPayload = null;
        if (classified.payload !== undefined && classified.payload !== null) {
            try {
                validatedPayload = validatePayload(classified.payload, limits);
                schema = 'valid';
            } catch {
                schema = 'invalid';
                validatedPayload = null;
            }
        }

        const evidenceRef = typeof classified.evidenceRef === 'string' && classified.evidenceRef.trim().length > 0
            ? classified.evidenceRef.trim()
            : null;
        const terminalMarker = typeof classified.terminalMarker === 'string' && classified.terminalMarker.trim().length > 0
            ? classified.terminalMarker.trim()
            : null;
        const observedConversationId = typeof classified.observedConversationId === 'string' && classified.observedConversationId.trim().length > 0
            ? classified.observedConversationId.trim()
            : null;
        const observedInvocationId = typeof classified.observedInvocationId === 'string' && classified.observedInvocationId.trim().length > 0
            ? classified.observedInvocationId.trim()
            : null;
        const hasTerminalError = Boolean(raw.hasTerminalError) || Boolean(classified.hasTerminalError);
        const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
        const hasCorrelationMatch = observedConversationId === binding.conversation_id
            && (observedInvocationId === null || observedInvocationId === invocationId);

        // Explicit terminal failure check: requires correlation match so unrelated/un-correlated failures remain unknown
        if (
            (classified.completion === 'failed' || hasTerminalError || (exitCode !== null && exitCode !== 0))
            && evidenceRef !== null
            && hasCorrelationMatch
        ) {
            return Object.freeze({
                completion: 'failed',
                schema,
                payload: validatedPayload,
                evidenceRef,
                terminalMarker,
                observedConversationId,
                observedInvocationId,
            });
        }

        // Positive completion check: enforce all allowlist and correlation requirements
        const isPositiveSuccess = classified.completion === 'succeeded'
            && exitCode === 0
            && !hasTerminalError
            && evidenceRef !== null
            && terminalMarker !== null
            && allowlistedSet.has(terminalMarker)
            && hasCorrelationMatch;

        if (isPositiveSuccess) {
            if (schema === 'not_checked') {
                schema = 'invalid';
            }
            return Object.freeze({
                completion: 'succeeded',
                schema,
                payload: validatedPayload,
                evidenceRef,
                terminalMarker,
                observedConversationId,
                observedInvocationId,
            });
        }

        return Object.freeze({
            completion: 'unknown',
            schema,
            payload: validatedPayload,
            evidenceRef: evidenceRef || 'unverified_completion',
            terminalMarker,
            observedConversationId,
            observedInvocationId,
        });
    }

    function classify(raw, bindingInput, invocationIdInput, limitsInput = {}) {
        const observation = classifyObservation(raw, bindingInput, invocationIdInput, limitsInput);
        const result = observation.schema === 'invalid' && typeof raw?.stdout === 'string'
            ? Object.freeze({ ...observation, rawReplyExcerpt: redactDiagnostic(raw.stdout, { maxLength: 1024 }) })
            : observation;
        return raw && raw.nudged === true
            ? Object.freeze({ ...result, evidenceRef: `${result.evidenceRef || 'unverified_completion'}+nudge${raw.nudgeDenied ? '+nudge-denied' : ''}` })
            : result;
    }

    return Object.freeze({
        id,
        provider,
        version,
        mode,
        profile: frozenProfile,
        invoke,
        classify,
    });
}

module.exports = Object.freeze({
    createDiscussionAdapter,
});
