'use strict';

// Claude Code in a discussion slot (SPEC-SQUAD-P4 §4). Turns are argv from the
// claude runtime adapter (read-only tool list, worker-root isolation); the
// process runner and recovery tracking are the codex ones. `claude -p --resume`
// keeps the session id (V27), so conversation matching works as for codex.

const telemetry = require('../../squad/acceptance-telemetry');
const { resolveClaudeCommand } = require('../binary-paths');
const claudeRuntime = require('../../squad/runtimes/claude');
const { parseJsonObject } = require('../../squad/runtimes/result');
const { createDiscussionAdapter } = require('./adapter');
const { CEILINGS, validatePayload } = require('./contracts');
const { runCodex, extractPayload, probeRecovery } = require('./live-codex-invoke');

const TERMINAL_MARKER = 'claude.result.success';

// provider names the discussion slot: 'agy' (worker) or 'codex' (orchestrator, P4c).
function settings({
    command, prefixArgs, cwd, model = 'sonnet', effort, timeoutMs = 110000,
    spawnImpl, env = process.env, signal, prespawnGuard, provider = 'agy', isolatedRoot = false, excludeCwdInstructions = false,
} = {}) {
    const resolved = command ? { command, prefixArgs: prefixArgs || [] } : resolveClaudeCommand({ env });
    return { runtime: 'claude', command: resolved.command, prefixArgs: [...resolved.prefixArgs], cwd, model, effort, timeoutMs,
        spawnImpl, env, signal, prespawnGuard, provider, isolatedRoot, excludeCwdInstructions };
}

function turnArgs(config, { prompt, model, effort, timeoutMs, resume }) {
    const turn = { prompt, cwd: config.cwd, model, ...(effort ? { effort } : {}), permission: 'read-only',
        isolatedRoot: config.isolatedRoot === true, ...(config.excludeCwdInstructions === true ? { excludeCwdInstructions: true } : {}),
        timeoutMs: Math.max(1, Math.floor(timeoutMs)) };
    const ctx = { resolved: { found: true, command: config.command, prefixArgs: config.prefixArgs } };
    const invocation = resume ? claudeRuntime.buildResume(resume, turn, ctx) : claudeRuntime.buildHeadless(turn, ctx);
    return [...invocation.args];
}

function classify(raw) {
    const envelope = parseJsonObject(String(raw.stdout || '').trim());
    const parsed = claudeRuntime.parseResult({ exitCode: raw.exitCode, stdout: raw.stdout, timedOut: raw.timedOut }, {});
    const text = envelope && typeof envelope.result === 'string' ? envelope.result : '';
    const { payload, repair } = extractPayload(text, raw.expectedKind);
    const failed = parsed.completion === 'failed' && Boolean(envelope);
    return {
        completion: parsed.completion,
        payload,
        observedConversationId: parsed.sessionRef,
        observedInvocationId: null,
        terminalMarker: parsed.completion === 'succeeded' ? TERMINAL_MARKER : null,
        hasTerminalError: failed,
        evidenceRef: envelope ? 'claude-json-v1' + (repair ? `;payload-repair=${repair}` : '') : null,
    };
}

const effortOf = (value) => (typeof value === 'string' && value.trim() && value !== 'model-default' ? value.trim() : undefined);

function createClaudeAdapter(options = {}) {
    const config = settings(options);
    const buildAdapter = (prespawnGuard) => createDiscussionAdapter({
        id: 'claude-live-v1',
        provider: config.provider,
        version: '1',
        mode: 'live',
        profile: { format: 'json', requireConversationMatch: true, allowlistedTerminalMarkers: [TERMINAL_MARKER] },
        invoke: async (params) => {
            const started = performance.now();
            const model = params.binding.model || config.model;
            const effort = effortOf(params.binding.effort) || effortOf(config.effort);
            const expected = params.envelope.kind === 'question' ? 'reply' : 'question';
            const prompt = [
                'Read-only snapshot context:', params.snapshot.text,
                'Discussion message:', params.envelope.body,
                `Reply with ONLY one JSON object {"schema_version":1,"kind":"${expected}","body":"<your answer>"}. No markdown fences.`,
            ].join('\n\n');
            const effectiveTimeoutMs = Math.min(params.timeoutMs, config.timeoutMs);
            const signal = config.signal ? AbortSignal.any([config.signal, params.signal]) : params.signal;
            let callCount = 0, previousTurn;
            const call = async (callPrompt, timeoutMs) => {
                const raw = await runCodex(config, turnArgs(config, { prompt: callPrompt, model, effort, timeoutMs,
                    resume: params.binding.conversation_id }), {
                    ...config, prespawnGuard, classifyFn: classify, invocationId: params.invocationId, messageId: params.envelope.message_id, retryFrom: previousTurn,
                    phase: callCount++ === 0 ? 'turn' : 'nudge',
                    timeoutMs, maxOutputBytes: params.maxOutputBytes, signal,
                    binding: params.binding, expectedKind: expected,
                });
                previousTurn = telemetry.turnFor(raw);
                return { ...raw, expectedKind: expected };
            };
            const first = await call(prompt, effectiveTimeoutMs);
            const classified = classify(first);
            if (first.exitCode !== 0 || first.timedOut || first.overflowed
                || first.transportError || signal.aborted
                || classified.completion !== 'succeeded' || classified.hasTerminalError) return first;
            try {
                validatePayload(classified.payload);
                return first;
            } catch {
                telemetry.turnFor(first)?.contract({ status: 'failed', code: 'DISCUSSION_ENVELOPE_INVALID', layer: 'envelope' });
                // A completed turn with no valid envelope gets one corrective resume.
            }
            const remainingMs = Math.floor(effectiveTimeoutMs - (performance.now() - started));
            if (remainingMs < 5000) return first;
            params.markNudged(false);
            return call('Your previous reply was empty/invalid. Reply now with exactly one JSON object '
                + `{"schema_version":1,"kind":"${expected}","body":"<answer as serialized string>"}. `
                + 'The body must be your answer as a serialized string. No fences or prose.', remainingMs);
        },
        classify,
    });
    const adapter = buildAdapter(config.prespawnGuard);
    if (!config.prespawnGuard) return Object.freeze({ ...adapter, probeRecovery });
    return Object.freeze({ ...adapter, probeRecovery, async invoke(params) {
        // Scope guard failures per invocation: the shared wrapper classifies other throws.
        let denied = false;
        let failure;
        const guarded = buildAdapter(async (context) => {
            try { await config.prespawnGuard(context); }
            catch (error) { denied = true; failure = error; throw error; }
        });
        const raw = await guarded.invoke(params);
        if (denied) throw failure;
        return raw;
    } });
}

async function seedClaudeConversation(options = {}) {
    const config = settings(options);
    const prompt = 'Prepare for a discussion. Reply with ONLY the JSON payload '
        + '{"schema_version":1,"kind":"reply","body":"ready"}. No markdown fences.';
    const raw = await runCodex(config, turnArgs(config, { prompt, model: config.model, effort: effortOf(config.effort),
        timeoutMs: config.timeoutMs }), { ...config, classifyFn: classify, phase: 'seed', timeoutMs: config.timeoutMs,
        maxOutputBytes: CEILINGS.maxOutputBytes });
    const classified = classify({ ...raw, expectedKind: 'reply' });
    if (raw.exitCode !== 0 || raw.timedOut || raw.overflowed || classified.completion !== 'succeeded'
        || !classified.observedConversationId || !classified.payload
        || classified.payload.kind !== 'reply' || classified.payload.body !== 'ready') {
        telemetry.turnFor(raw)?.contract({ status: 'failed', code: 'SEED_INVALID', layer: 'seed' });
        throw new Error(`Claude seed failed (exit=${raw.exitCode}, timedOut=${raw.timedOut}, overflowed=${raw.overflowed}): ${raw.stderr}`);
    }
    telemetry.turnFor(raw)?.contract({ status: 'succeeded', layer: 'seed' });
    const envelope = parseJsonObject(raw.stdout.trim());
    return { conversationId: classified.observedConversationId, responseText: envelope.result, rawStdout: raw.stdout };
}

module.exports = { createClaudeAdapter, seedClaudeConversation, probeRecovery };
