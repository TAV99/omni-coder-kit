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

function settings({
    codexPath = '/usr/bin/codex', cwd, model = 'gpt-6.1-sol',
    effort = 'medium', timeoutMs = 110000,
} = {}) {
    return { codexPath, cwd, model, effort, timeoutMs };
}

function runCodex(options, args, { timeoutMs, maxOutputBytes, signal, binding, expectedKind }) {
    return new Promise((resolve, reject) => {
        const childToken = {};
        const finish = trackInvocation(binding, expectedKind, childToken);
        let child;
        try {
            child = spawn(options.codexPath, args, {
                cwd: options.cwd,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            finish({ stdout: '', exitCode: null, transportError: true });
            reject(err);
            return;
        }
        childToken.child = child;
        const chunks = { stdout: [], stderr: [] };
        const bytes = { stdout: 0, stderr: 0 };
        let timedOut = false;
        let aborted = false;
        let overflowed = false;
        const kill = () => {
            childToken.terminating = true;
            child.kill('SIGKILL');
        };
        const abort = () => {
            aborted = true;
            kill();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', abort);
        };
        for (const stream of ['stdout', 'stderr']) {
            child[stream].on('data', (chunk) => {
                const remaining = Math.max(0, maxOutputBytes - bytes[stream]);
                if (remaining > 0) chunks[stream].push(chunk.subarray(0, remaining));
                bytes[stream] += chunk.length;
                if (bytes[stream] > maxOutputBytes) {
                    overflowed = true;
                    kill();
                }
            });
        }
        child.once('error', (err) => {
            cleanup();
            finish({ stdout: '', exitCode: null, transportError: true });
            reject(err);
        });
        child.once('close', (exitCode) => {
            cleanup();
            const raw = {
                exitCode,
                stdout: Buffer.concat(chunks.stdout).toString('utf8'),
                stderr: Buffer.concat(chunks.stderr).toString('utf8'),
                timedOut: timedOut || aborted,
                overflowed,
                hasTerminalError: false,
                transportError: false,
                pid: child.pid,
            };
            finish(raw);
            resolve(raw);
        });
        if (signal) {
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        }
    });
}

function flags(options) {
    return ['--json', '-m', options.model, '-c',
        `model_reasoning_effort="${options.effort}"`, '-s', 'read-only'];
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

function parseOutput(stdout, expectedKind) {
    const events = [];
    for (const line of stdout.split(/\r?\n/u)) {
        try {
            const event = JSON.parse(line);
            if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
        } catch {
            // Ignore non-JSON diagnostics; they cannot establish completion.
        }
    }
    const thread = events.find((event) => event.type === 'thread.started');
    const messages = events.filter((event) => event.type === 'item.completed'
        && event.item && event.item.type === 'agent_message'
        && typeof event.item.text === 'string');
    const responseText = messages.length ? messages[messages.length - 1].item.text : '';
    const { payload, repair } = extractPayload(responseText, expectedKind);
    return {
        events,
        conversationId: thread && typeof thread.thread_id === 'string' ? thread.thread_id : null,
        completed: events.some((event) => event.type === 'turn.completed'),
        failed: events.some((event) => event.type === 'turn.failed' || event.type === 'error'),
        responseText,
        payload,
        repair,
    };
}

function classify(raw, binding, invocationId) {
    const parsed = parseOutput(raw.stdout, raw.expectedKind);
    const failed = parsed.failed || (raw.exitCode !== 0 && parsed.events.length > 0);
    return {
        completion: failed ? 'failed' : (parsed.completed && raw.exitCode === 0 ? 'succeeded' : 'unknown'),
        payload: parsed.payload,
        observedConversationId: parsed.conversationId,
        observedInvocationId: null,
        terminalMarker: parsed.completed && !failed && raw.exitCode === 0 ? 'codex.turn.completed' : null,
        hasTerminalError: failed,
        evidenceRef: parsed.events.length
            ? 'codex-jsonl-v1' + (parsed.repair ? `;payload-repair=${parsed.repair}` : '')
            : null,
    };
}

function createCodexAdapter(options = {}) {
    const config = settings(options);
    const adapter = createDiscussionAdapter({
        id: 'codex-live-v1',
        provider: 'codex',
        version: '1',
        mode: 'live',
        profile: {
            format: 'jsonl',
            requireConversationMatch: true,
            allowlistedTerminalMarkers: ['codex.turn.completed'],
        },
        invoke: async (params) => {
            const started = performance.now();
            const model = params.binding.model || config.model;
            const effort = params.binding.effort || config.effort;
            const expected = params.envelope.kind === 'question' ? 'reply' : 'question';
            const prompt = [
                'Read-only snapshot context:', params.snapshot.text,
                'Discussion message:', params.envelope.body,
                `Reply with ONLY one JSON object {"schema_version":1,"kind":"${expected}","body":"<your answer>"}. No markdown fences.`,
            ].join('\n\n');
            const effectiveTimeoutMs = Math.min(params.timeoutMs, config.timeoutMs);
            const call = async (callPrompt, timeoutMs) => {
                const raw = await runCodex(config, [
                    'exec', 'resume', '--skip-git-repo-check', params.binding.conversation_id,
                    callPrompt, '--json', '-m', model, '-c',
                    `model_reasoning_effort="${effort}"`,
                ], {
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
            const evidence = parseOutput(first.stdout, expected);
            const denialAware = !evidence.responseText.trim() || evidence.events.some((event) =>
                Array.isArray(event.usage?.denied_actions) && event.usage.denied_actions.length > 0);
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

async function seedCodexConversation(options = {}) {
    const config = settings(options);
    const prompt = 'Prepare for a discussion. Reply with ONLY the JSON payload '
        + '{"schema_version":1,"kind":"reply","body":"ready"}. No markdown fences.';
    const raw = await runCodex(config, [
        'exec', '--skip-git-repo-check', ...flags(config), prompt,
    ], { timeoutMs: config.timeoutMs, maxOutputBytes: CEILINGS.maxOutputBytes });
    const parsed = parseOutput(raw.stdout);
    if (raw.exitCode !== 0 || raw.timedOut || raw.overflowed || parsed.failed
        || !parsed.completed || !parsed.conversationId || !parsed.payload
        || parsed.payload.kind !== 'reply' || parsed.payload.body !== 'ready') {
        throw new Error(`Codex seed failed (exit=${raw.exitCode}, timedOut=${raw.timedOut}, overflowed=${raw.overflowed}): ${raw.stderr}`);
    }
    return {
        conversationId: parsed.conversationId,
        responseText: parsed.responseText,
        rawStdout: raw.stdout,
    };
}

module.exports = { createCodexAdapter, seedCodexConversation, probeRecovery };
