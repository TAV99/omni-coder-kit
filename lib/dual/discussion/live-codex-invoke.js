'use strict';

const { spawn } = require('node:child_process');
const { createDiscussionAdapter } = require('./adapter');
const { CEILINGS } = require('./contracts');

function settings({
    codexPath = '/usr/bin/codex', cwd, model = 'gpt-6.1-sol',
    effort = 'medium', timeoutMs = 110000,
} = {}) {
    return { codexPath, cwd, model, effort, timeoutMs };
}

function runCodex(options, args, { timeoutMs, maxOutputBytes, signal }) {
    return new Promise((resolve, reject) => {
        const child = spawn(options.codexPath, args, {
            cwd: options.cwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks = { stdout: [], stderr: [] };
        const bytes = { stdout: 0, stderr: 0 };
        let timedOut = false;
        let aborted = false;
        let overflowed = false;
        const kill = () => child.kill('SIGKILL');
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
            reject(err);
        });
        child.once('close', (exitCode) => {
            cleanup();
            resolve({
                exitCode,
                stdout: Buffer.concat(chunks.stdout).toString('utf8'),
                stderr: Buffer.concat(chunks.stderr).toString('utf8'),
                timedOut: timedOut || aborted,
                overflowed,
                hasTerminalError: false,
                transportError: false,
                pid: child.pid,
            });
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

function parseOutput(stdout) {
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
    let payload = null;
    try {
        const candidate = JSON.parse(responseText.replace(/^\s*```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[^\S\r\n]*```\s*$/u, '$1'));
        if (candidate && candidate.schema_version === 1
            && (candidate.kind === 'reply' || candidate.kind === 'question')
            && typeof candidate.body === 'string') payload = candidate;
    } catch {
        // Only the last agent message can supply a payload.
    }
    return {
        events,
        conversationId: thread && typeof thread.thread_id === 'string' ? thread.thread_id : null,
        completed: events.some((event) => event.type === 'turn.completed'),
        failed: events.some((event) => event.type === 'turn.failed' || event.type === 'error'),
        responseText,
        payload,
    };
}

function classify(raw, binding, invocationId) {
    const parsed = parseOutput(raw.stdout);
    const failed = parsed.failed || (raw.exitCode !== 0 && parsed.events.length > 0);
    return {
        completion: failed ? 'failed' : (parsed.completed && raw.exitCode === 0 ? 'succeeded' : 'unknown'),
        payload: parsed.payload,
        observedConversationId: parsed.conversationId,
        observedInvocationId: null,
        terminalMarker: parsed.completed && !failed && raw.exitCode === 0 ? 'codex.turn.completed' : null,
        hasTerminalError: failed,
        evidenceRef: parsed.events.length ? 'codex-jsonl-v1' : null,
    };
}

function createCodexAdapter(options = {}) {
    const config = settings(options);
    return createDiscussionAdapter({
        id: 'codex-live-v1',
        provider: 'codex',
        version: '1',
        mode: 'live',
        profile: {
            format: 'jsonl',
            requireConversationMatch: true,
            allowlistedTerminalMarkers: ['codex.turn.completed'],
        },
        invoke: (params) => {
            const model = params.binding.model || config.model;
            const effort = params.binding.effort || config.effort;
            const expected = params.envelope.kind === 'question' ? 'reply' : 'question';
            const prompt = [
                'Read-only snapshot context:', params.snapshot.text,
                'Discussion message:', params.envelope.body,
                `Reply with ONLY one JSON object {"schema_version":1,"kind":"${expected}","body":"<your answer>"}. No markdown fences.`,
            ].join('\n\n');
            return runCodex(config, [
                'exec', 'resume', '--skip-git-repo-check', params.binding.conversation_id,
                prompt, '--json', '-m', model, '-c',
                `model_reasoning_effort="${effort}"`,
            ], {
                timeoutMs: Math.min(params.timeoutMs, config.timeoutMs),
                maxOutputBytes: params.maxOutputBytes,
                signal: params.signal,
            });
        },
        classify,
    });
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

module.exports = { createCodexAdapter, seedCodexConversation };
