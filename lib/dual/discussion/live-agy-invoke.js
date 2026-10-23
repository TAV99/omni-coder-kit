'use strict';

const { spawn } = require('node:child_process');
const { createDiscussionAdapter } = require('./adapter');
const { CEILINGS, isPlainObject, validatePayload } = require('./contracts');

// Keep recovery evidence alongside the bounded child capture lifecycle. A kill
// request is not evidence of quiescence: only close/error retires its token.
const recovery = new Map();
async function probeRecovery({ conversationId } = {}) {
    const state = recovery.get(conversationId);
    const deadline = performance.now() + 3000;
    while (state && state.active.size > 0
        && [...state.active].every((token) => token.terminating
            || token.child?.killed || token.child?.exitCode != null || token.child?.signalCode != null)) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    return {
        processQuiescent: state ? state.active.size === 0 : false,
        providerTerminal: state ? state.terminal : false,
        providerOutcome: state ? state.outcome : 'unknown',
    };
}

function trackInvocation(binding, expectedKind, childToken = {}) {
    if (!binding) return () => {};
    const conversationId = binding.conversation_id;
    const state = recovery.get(conversationId) || { active: new Set() };
    const token = childToken;
    state.active.add(token);
    state.latest = token;
    state.terminal = false;
    state.outcome = 'unknown';
    recovery.set(conversationId, state);
    let finished = false;
    return (raw) => {
        if (finished) return;
        finished = true;
        state.active.delete(token);
        if (state.latest !== token) return;
        // Recovery asks whether a valid provider completion was captured before
        // reaping, even if the child later needed killing. Normal turn acceptance
        // still classifies the real exit code and remains fail-closed.
        const classified = classify({ ...raw, exitCode: 0, expectedKind }, binding);
        let valid = false;
        try {
            validatePayload(classified.payload);
            valid = classified.payload.kind === expectedKind
                && classified.observedConversationId === conversationId;
        } catch {
            // Invalid or uncorrelated output cannot certify successful completion.
        }
        const succeeded = classified.completion === 'succeeded' && valid;
        const failed = raw.transportError || raw.timedOut || raw.overflowed
            || raw.exitCode !== 0 || classified.completion === 'failed';
        state.terminal = succeeded || failed || classified.completion === 'succeeded';
        state.outcome = succeeded ? 'succeeded' : (failed ? 'failed' : 'unknown');
    };
}

function resolveOptions(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    return {
        agyPath: typeof opts.agyPath === 'string' && opts.agyPath.trim().length > 0 ? opts.agyPath.trim() : 'agy',
        cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
        model: typeof opts.model === 'string' && opts.model.trim().length > 0 ? opts.model.trim() : 'gemini-3.8-flash-high',
        timeoutMs: typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
            ? opts.timeoutMs
            : 110000,
    };
}

function runAgy(agyPath, args, { cwd, timeoutMs, maxOutputBytes, signal, binding, expectedKind }) {
    return new Promise((resolve) => {
        const childToken = {};
        const finish = trackInvocation(binding, expectedKind, childToken);
        const complete = (raw) => { finish(raw); resolve(raw); };
        let child;
        try {
            child = spawn(agyPath, args, {
                cwd,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            complete({
                exitCode: null,
                stdout: '',
                stderr: err ? (err.message || String(err)) : '',
                timedOut: false,
                overflowed: false,
                hasTerminalError: false,
                transportError: true,
                pid: null,
            });
            return;
        }

        childToken.child = child;
        const chunks = { stdout: [], stderr: [] };
        const bytes = { stdout: 0, stderr: 0 };
        let timedOut = false;
        let overflowed = false;
        let settled = false;

        const kill = () => {
            childToken.terminating = true;
            try {
                child.kill('SIGKILL');
            } catch {
                // Ignore errors if child is already terminated
            }
        };

        let timer = null;
        if (typeof timeoutMs === 'number' && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
            timer = setTimeout(() => {
                timedOut = true;
                kill();
            }, timeoutMs);
        }

        const onAbort = () => {
            kill();
        };

        if (signal) {
            if (signal.aborted) {
                kill();
            } else if (typeof signal.addEventListener === 'function') {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', onAbort);
            }
        };

        for (const stream of ['stdout', 'stderr']) {
            if (child[stream]) {
                child[stream].on('data', (chunk) => {
                    const remaining = Math.max(0, maxOutputBytes - bytes[stream]);
                    if (remaining > 0) {
                        chunks[stream].push(chunk.subarray(0, remaining));
                    }
                    bytes[stream] += chunk.length;
                    if (bytes[stream] > maxOutputBytes) {
                        overflowed = true;
                        kill();
                    }
                });
            }
        }

        child.once('error', (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            complete({
                exitCode: null,
                stdout: Buffer.concat(chunks.stdout).toString('utf8'),
                stderr: Buffer.concat(chunks.stderr).toString('utf8') || (err ? (err.message || String(err)) : ''),
                timedOut,
                overflowed,
                hasTerminalError: false,
                transportError: true,
                pid: child.pid || null,
            });
        });

        child.once('close', (code) => {
            if (settled) return;
            settled = true;
            cleanup();
            complete({
                exitCode: Number.isInteger(code) ? code : null,
                stdout: Buffer.concat(chunks.stdout).toString('utf8'),
                stderr: Buffer.concat(chunks.stderr).toString('utf8'),
                timedOut,
                overflowed,
                hasTerminalError: false,
                transportError: false,
                pid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
            });
        });
    });
}

// Repair only a complete JSON object; validation remains the wrapper's job.
function extractPayload(response, expectedKind) {
    let candidate = response;
    let fenced = false;
    const invalid = { payload: null, repair: null };
    if (typeof response === 'string') {
        const trimmed = response.trim();
        const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        fenced = Boolean(fence);
        try {
            candidate = JSON.parse(fence ? fence[1] : trimmed);
        } catch {
            return invalid;
        }
    }
    if (!isPlainObject(candidate)) return invalid;

    let payload = null;
    let repair = null;
    if (candidate.schema_version === 1
        && (candidate.kind === 'question' || candidate.kind === 'reply')) {
        if (typeof candidate.body === 'string') {
            payload = candidate;
        } else if (isPlainObject(candidate.body)) {
            // Preserve every envelope key so validatePayload still rejects extras.
            payload = { ...candidate, body: JSON.stringify(candidate.body) };
            repair = 'body_object';
        }
    } else if (!Object.hasOwn(candidate, 'schema_version') && !Object.hasOwn(candidate, 'kind')
        && (expectedKind === 'question' || expectedKind === 'reply')) {
        payload = { schema_version: 1, kind: expectedKind, body: JSON.stringify(candidate) };
        repair = 'bare_object';
    }
    if (!payload) return invalid;
    return { payload, repair: [fenced ? 'fence' : null, repair].filter(Boolean).join('+') || null };
}

function classify(raw, binding, invocationId) {
    let parsed = null;
    if (raw && typeof raw.stdout === 'string') {
        try {
            const candidate = JSON.parse(raw.stdout);
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                parsed = candidate;
            }
        } catch {
            // raw.stdout is not valid JSON
        }
    }

    const agyJsonParsed = parsed !== null;
    let evidenceRef = agyJsonParsed ? 'agy-json-v1' : null;

    const observedConversationId = (parsed && typeof parsed.conversation_id === 'string' && parsed.conversation_id.trim().length > 0)
        ? parsed.conversation_id.trim()
        : null;
    const observedInvocationId = null;

    const status = (parsed && typeof parsed.status === 'string') ? parsed.status : null;
    const statusExists = status !== null;

    const terminalMarker = status === 'SUCCESS' ? 'agy.status.SUCCESS' : null;

    const rawExitCode = (raw && Number.isInteger(raw.exitCode)) ? raw.exitCode : null;

    let completion = 'unknown';
    let hasTerminalError = false;

    if (status === 'SUCCESS' && rawExitCode === 0) {
        completion = 'succeeded';
        hasTerminalError = false;
    } else if (statusExists && status !== 'SUCCESS') {
        completion = 'failed';
        hasTerminalError = true;
    } else {
        completion = 'unknown';
        hasTerminalError = false;
    }

    let payload = null;
    if (parsed && parsed.response !== undefined) {
        const extracted = extractPayload(parsed.response, raw.expectedKind);
        payload = extracted.payload;
        if (extracted.repair) evidenceRef += `;payload-repair=${extracted.repair}`;
    }

    return {
        completion,
        payload,
        evidenceRef,
        terminalMarker,
        observedConversationId,
        observedInvocationId,
        hasTerminalError,
    };
}

function createAgyAdapter(options = {}) {
    const config = resolveOptions(options);
    const configuredModel = (options && typeof options.model === 'string' && options.model.trim().length > 0)
        ? options.model.trim()
        : null;

    const adapter = createDiscussionAdapter({
        id: 'agy-live-v1',
        provider: 'agy',
        version: '1',
        mode: 'live',
        profile: {
            format: 'json',
            requireConversationMatch: true,
            allowlistedTerminalMarkers: ['agy.status.SUCCESS'],
        },
        invoke: async (params) => {
            const started = performance.now();
            const expected = params.envelope.kind === 'question' ? 'reply' : 'question';
            const prompt = [
                'Read-only snapshot context:',
                params.snapshot.text,
                'Discussion message:',
                params.envelope.body,
                `Reply with ONLY one JSON object {"schema_version":1,"kind":"${expected}","body":"<your answer>"}. No markdown fences, no extra text.`,
            ].join('\n\n');

            const effectiveTimeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
                ? Math.min(params.timeoutMs, config.timeoutMs)
                : config.timeoutMs;
            const printTimeoutSeconds = Math.ceil(effectiveTimeoutMs / 1000);

            const effectiveModel = configuredModel
                || (params.binding && typeof params.binding.model === 'string' && params.binding.model.trim().length > 0 ? params.binding.model.trim() : null)
                || config.model;

            const args = [
                '-p',
                prompt,
                '--output-format',
                'json',
                '--model',
                effectiveModel,
                '--print-timeout',
                `${printTimeoutSeconds}s`,
                '--conversation',
                params.binding.conversation_id,
            ];

            const call = async (callPrompt, timeoutMs) => {
                const callArgs = [...args];
                callArgs[1] = callPrompt;
                callArgs[callArgs.indexOf('--print-timeout') + 1] = `${Math.ceil(timeoutMs / 1000)}s`;
                const raw = await runAgy(config.agyPath, callArgs, {
                    cwd: config.cwd,
                    timeoutMs,
                    maxOutputBytes: params.maxOutputBytes,
                    signal: params.signal,
                    binding: params.binding,
                    expectedKind: expected,
                });
                return { ...raw, expectedKind: expected };
            };
            const first = await call(prompt, effectiveTimeoutMs);
            const classified = classify(first, params.binding, params.invocationId);
            if (first.exitCode !== 0 || first.timedOut || first.overflowed
                || first.transportError || first.hasTerminalError || params.signal.aborted
                || classified.completion !== 'succeeded' || classified.hasTerminalError) return first;
            try {
                validatePayload(classified.payload);
                return first;
            } catch {
                // A completed provider turn with no valid envelope gets one corrective resume.
            }
            const remainingMs = Math.floor(effectiveTimeoutMs - (performance.now() - started));
            if (remainingMs < 5000) return first;
            const evidence = JSON.parse(first.stdout);
            const denialAware = (Array.isArray(evidence.usage?.denied_actions) && evidence.usage.denied_actions.length > 0)
                || evidence.response == null || (typeof evidence.response === 'string' && !evidence.response.trim());
            const nudge = (denialAware
                ? 'Some tool actions were denied in this environment; do NOT call tools; answer ONLY from the prompt contents already provided. '
                : '') + `Your previous reply was empty/invalid. Reply now with exactly one JSON object `
                + `{"schema_version":1,"kind":"${expected}","body":"<answer as serialized string>"}. `
                + 'The body must be your answer as a serialized string. No fences or prose.';
            params.markNudged(denialAware);
            return call(nudge, remainingMs);
        },
        classify,
    });
    return Object.freeze({ ...adapter, probeRecovery });
}

async function seedAgyConversation(options = {}) {
    const config = resolveOptions(options);
    const seedPrompt = 'Prepare for a discussion. Reply with ONLY one JSON object {"schema_version":1,"kind":"reply","body":"ready"}. No markdown fences, no extra text.';
    const printTimeoutSeconds = Math.ceil(config.timeoutMs / 1000);

    const args = [
        '-p',
        seedPrompt,
        '--output-format',
        'json',
        '--model',
        config.model,
        '--print-timeout',
        `${printTimeoutSeconds}s`,
    ];

    const raw = await runAgy(config.agyPath, args, {
        cwd: config.cwd,
        timeoutMs: config.timeoutMs,
        maxOutputBytes: CEILINGS.maxOutputBytes,
        signal: options ? options.signal : undefined,
    });

    if (raw.exitCode !== 0 || raw.timedOut || raw.overflowed || raw.transportError) {
        throw new Error(`AGY seed process failed (exitCode=${raw.exitCode}, timedOut=${raw.timedOut}, overflowed=${raw.overflowed}, transportError=${raw.transportError}): ${raw.stderr}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw.stdout);
    } catch (err) {
        throw new Error(`AGY seed stdout was not valid JSON: ${err.message}; stdout=${raw.stdout}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`AGY seed output was not an object: ${raw.stdout}`);
    }

    if (parsed.status !== 'SUCCESS') {
        throw new Error(`AGY seed failed with status '${parsed.status}': ${raw.stdout}`);
    }

    const conversationId = typeof parsed.conversation_id === 'string' && parsed.conversation_id.trim().length > 0
        ? parsed.conversation_id.trim()
        : null;

    if (!conversationId) {
        throw new Error(`AGY seed output missing conversation_id: ${raw.stdout}`);
    }

    const responseText = typeof parsed.response === 'string' ? parsed.response : '';

    return {
        conversationId,
        responseText,
        rawStdout: raw.stdout,
    };
}

module.exports = {
    createAgyAdapter,
    probeRecovery,
    seedAgyConversation,
};

Object.defineProperty(module.exports, 'classify', {
    value: classify,
    enumerable: false,
    writable: true,
    configurable: true,
});
