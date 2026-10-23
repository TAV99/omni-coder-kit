'use strict';

// Run explicitly: OMNI_DUAL_LIVE=1 node test/dual-discussion-live-benchmark.js
// Each mode-run seeds each provider once, independently of its paired mode, so
// neither mode inherits the other's completed dialogue. Seeds are not timed.
if (process.env.OMNI_DUAL_LIVE !== '1') {
    console.log('Live benchmark skipped; set OMNI_DUAL_LIVE=1 to run.');
} else {
    main().catch((error) => {
        console.error(`Benchmark infrastructure failure: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

async function main() {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const { performance } = require('node:perf_hooks');
    const { createDiscussionRelay, inspectJournal, validateBinding,
        validatePayload, CEILINGS } = require('../lib/dual/discussion');
    const { sha256Utf8 } = require('../lib/dual/discussion/contracts');
    const { createCodexAdapter, seedCodexConversation } = require('../lib/dual/discussion/live-codex-invoke');
    const { createAgyAdapter, seedAgyConversation } = require('../lib/dual/discussion/live-agy-invoke');
    const cwd = path.resolve(__dirname, '..');
    const codexOptions = { cwd, model: 'gpt-6.1-sol', effort: 'medium', timeoutMs: 110000 };
    const agyOptions = { cwd, model: 'gemini-3.8-flash-high', timeoutMs: 110000 };
    const text = 'function f(xs) { return xs.filter(x => x.active).map(x => x.id); }\n';
    const snapshot = { text, sha256: sha256Utf8(text) };
    const labels = ['A', 'B', 'C', 'D'];
    const providers = ['codex', 'agy', 'codex', 'agy'];
    const runs = [];

    function bodyFor(index, answers) {
        if (index === 0) return 'Based on the snapshot, propose ONE better function name and remember it for this conversation. '
            + 'Put only that JavaScript identifier in the response body.';
        if (index === 1) return `Astra proposed this name: ${answers[0]}\nCritique the chosen name in one sentence. `
            + 'Include exactly one ALL-CAPS keyword summarizing your critique, and remember that keyword.';
        if (index === 2) return `Argon gave this critique: ${answers[1]}\nWhat name did you choose in your first answer, `
            + 'and do you keep it? Include the original identifier exactly.';
        return 'Which ALL-CAPS keyword did you use in your earlier critique? Repeat it exactly.';
    }

    // This duplicates the invoke modules' provider-specific prompt construction
    // deliberately: direct mode must bypass adapter.invoke AND adapter.classify.
    function directPrompt(provider, body) {
        const instruction = provider === 'codex'
            ? 'Reply with ONLY one JSON object {"schema_version":1,"kind":"reply","body":"<your answer>"}. No markdown fences.'
            : 'Reply with ONLY one JSON object {"schema_version":1,"kind":"reply","body":"<your answer>"}. No markdown fences, no extra text.';
        return ['Read-only snapshot context:', snapshot.text, 'Discussion message:', body, instruction].join('\n\n');
    }

    function rawCli(provider, conversationId, body) {
        const prompt = directPrompt(provider, body);
        const executable = provider === 'codex' ? '/usr/bin/codex' : 'agy';
        const args = provider === 'codex'
            ? ['exec', 'resume', '--skip-git-repo-check', conversationId, prompt,
                '--json', '-m', codexOptions.model, '-c', 'model_reasoning_effort="medium"']
            : ['-p', prompt, '--output-format', 'json', '--model', agyOptions.model,
                '--print-timeout', '110s', '--conversation', conversationId];
        return new Promise((resolve) => {
            const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks = { stdout: [], stderr: [] };
            const bytes = { stdout: 0, stderr: 0 };
            let timedOut = false;
            let overflowed = false;
            let settled = false;
            const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 110000);
            for (const stream of ['stdout', 'stderr']) {
                child[stream].on('data', (chunk) => {
                    const remaining = Math.max(0, CEILINGS.maxOutputBytes - bytes[stream]);
                    if (remaining) chunks[stream].push(chunk.subarray(0, remaining));
                    bytes[stream] += chunk.length;
                    if (bytes[stream] > CEILINGS.maxOutputBytes) {
                        overflowed = true;
                        child.kill('SIGKILL');
                    }
                });
            }
            function finish(exitCode, error = null) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ exitCode, stdout: Buffer.concat(chunks.stdout).toString('utf8'),
                    stderr: Buffer.concat(chunks.stderr).toString('utf8'), timedOut, overflowed,
                    error: error ? error.message : null });
            }
            child.once('error', (error) => finish(null, error));
            child.once('close', (code) => finish(code));
        });
    }

    function parseJson(value) {
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return null; }
    }

    function output(provider, raw) {
        let payload;
        let usage;
        let terminal;
        let conversationId;
        if (provider === 'codex') {
            const events = raw.stdout.split(/\r?\n/u).map(parseJson).filter(Boolean);
            const messages = events.filter((event) => event.type === 'item.completed'
                && event.item && event.item.type === 'agent_message');
            payload = messages.length ? messages[messages.length - 1].item.text : null;
            usage = events.filter((event) => event.type === 'turn.completed' && event.usage)
                .map((event) => event.usage);
            terminal = events.some((event) => event.type === 'turn.completed')
                && !events.some((event) => event.type === 'turn.failed' || event.type === 'error');
            conversationId = events.find((event) => event.type === 'thread.started')?.thread_id;
        } else {
            const parsed = parseJson(raw.stdout);
            payload = parsed?.response;
            usage = parsed?.usage ? [parsed.usage] : [];
            terminal = parsed?.status === 'SUCCESS';
            conversationId = parsed?.conversation_id;
        }
        if (typeof payload === 'string') {
            payload = parseJson(payload.replace(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu, '$1'));
        }
        let valid = false;
        try { payload = validatePayload(payload); valid = payload.kind === 'reply'; } catch { payload = null; }
        return { payload, valid, usage, conversationId,
            succeeded: valid && terminal && raw.exitCode === 0 && !raw.timedOut && !raw.overflowed && !raw.error };
    }

    function ports() {
        return {
            authority: { check: async () => true },
            capabilityVerifier: {
                verify: async ({ binding, bindingRef: bRef, snapshotSha256, adapterId,
                    provider, adapterVersion, stage }) => ({
                    allowed: true, liveProfileVerified: true, evidenceId: `live-${bRef.slice(0, 8)}`,
                    expiresAt: Date.now() + 900000, bindingRef: bRef, provider, adapterId,
                    adapterVersion, conversationId: binding.conversation_id, snapshotSha256, stage,
                }),
                verifyRecovery: async ({ bindingRef: bRef, invocationId }) => ({
                    allowed: true, processQuiescent: true, providerTerminal: true,
                    providerOutcome: 'failed', evidenceId: 'benchmark-recovery', bindingRef: bRef, invocationId,
                }),
            },
        };
    }

    async function run(mode, pair, prompts) {
        const record = { pair, mode, conversationIds: {}, turns: [], seedErrors: [],
            duplicateDispatchCount: mode === 'relay' ? -4 : 'unavailable', manualRecoveryInterventions: 0 };
        const ids = record.conversationIds;
        // Failures are reported against the fixed denominator of four turns.
        for (const [provider, seed, options] of [
            ['codex', seedCodexConversation, codexOptions], ['agy', seedAgyConversation, agyOptions],
        ]) {
            try { ids[provider] = (await seed(options)).conversationId; } catch (error) {
                record.seedErrors.push({ provider, error: error.message });
            }
        }
        let relay;
        let stateDir;
        const raws = new Map();
        const answers = [];
        let setupError = null;
        try {
            if (mode === 'relay' && ids.codex && ids.agy) {
                stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `omni-live-bench-${pair}-`));
                const shared = { schema_version: 1, session_id: `bench-${pair}`, task_id: 'live-benchmark',
                    plan_revision: 1, snapshot_sha256: snapshot.sha256 };
                const bindings = [
                    validateBinding({ ...shared, provider: 'codex', role: 'astra', model: codexOptions.model,
                        effort: 'medium', conversation_id: ids.codex }),
                    validateBinding({ ...shared, provider: 'agy', role: 'argon', model: agyOptions.model,
                        effort: 'high', conversation_id: ids.agy }),
                ];
                function capture(adapter) {
                    return { ...adapter, async invoke(params) {
                        const raw = await adapter.invoke(params);
                        raws.set(params.envelope.message_id, raw);
                        return raw;
                    } };
                }
                try {
                    relay = await createDiscussionRelay({ enabled: true, stateDir, bindings, snapshot,
                        adapters: { codex: capture(createCodexAdapter(codexOptions)),
                            agy: capture(createAgyAdapter(agyOptions)) }, ...ports(),
                        limits: { ttlMs: 900000, timeoutMs: 110000 } });
                } catch (error) { setupError = error.message; }
            }
            for (let index = 0; index < 4; index += 1) {
                if (prompts[index] === undefined) prompts[index] = bodyFor(index, answers);
                const provider = providers[index];
                const messageId = `bench-${pair}-${labels[index]}`;
                const turn = { label: labels[index], provider, messageId, prompt: prompts[index],
                    wallMs: null, validPayload: false, succeeded: false, usage: 'unavailable' };
                if (!ids[provider] || (mode === 'relay' && !relay)) {
                    turn.error = setupError || 'Provider seed unavailable; turn not attempted';
                    turn.attempted = false;
                    answers.push('');
                    record.turns.push(turn);
                    continue;
                }
                turn.attempted = true;
                const started = performance.now();
                let raw;
                try {
                    if (mode === 'relay') {
                        const view = await relay.inspect();
                        const recipient = view.bindings.find((binding) => binding.provider === provider);
                        const sender = view.bindings.find((binding) => binding.provider !== provider);
                        const now = Date.now();
                        await relay.receive({ schema_version: 1, message_id: messageId,
                            sender_ref: sender.binding_ref, recipient_ref: recipient.binding_ref,
                            sequence: view.messages.length + 1, kind: 'question', body: prompts[index],
                            created_at: now, expires_at: now + 900000 });
                        const outcome = await relay.dispatch(messageId);
                        turn.outcome = outcome;
                        turn.succeeded = outcome.provider === 'succeeded' && outcome.discussion_result === 'available';
                    } else {
                        raw = await rawCli(provider, ids[provider], prompts[index]);
                    }
                } catch (error) { turn.error = `${error.code || 'ERROR'}: ${error.message}`; }
                turn.wallMs = performance.now() - started;
                raw = raw || raws.get(messageId);
                if (raw) {
                    const parsed = output(provider, raw);
                    turn.validPayload = parsed.valid;
                    turn.observedConversationId = parsed.conversationId || null;
                    turn.usage = parsed.usage.length ? parsed.usage : 'unavailable';
                    if (mode === 'direct') turn.succeeded = parsed.succeeded;
                    turn.exitCode = raw.exitCode;
                    turn.timedOut = Boolean(raw.timedOut);
                    answers.push(parsed.payload?.body || '');
                } else { answers.push(''); }
                record.turns.push(turn);
            }
            if (stateDir) {
                const journal = await inspectJournal({ stateDir });
                const intents = journal.events.filter(({ event }) => event.type === 'dispatch_intent');
                record.journalInvocationCount = intents.length;
                record.expectedInvocationCount = 4;
                record.invocationsMinusExpected = intents.length - 4;
                // Fixed protocol: invocations minus four expected turns. Negative
                // values indicate missing dispatches, also exposed explicitly below.
                record.duplicateDispatchCount = intents.length - 4;
                record.duplicateMessageDispatchCount = intents.length
                    - new Set(intents.map(({ event }) => event.message_id)).size;
                record.missingDispatchCount = Math.max(0, 4 - intents.length);
            }
        } finally {
            if (relay) {
                try { await relay.close(); } catch (error) {
                    record.closeError = `${error.code}: ${error.message}`;
                }
            }
            if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
        }
        runs.push(record);
    }

    for (let pair = 1; pair <= 3; pair += 1) {
        const order = pair === 2 ? ['direct', 'relay'] : ['relay', 'direct'];
        const prompts = [];
        for (const mode of order) await run(mode, pair, prompts);
    }

    function percentile(values, fraction) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    }

    function numericFields(value, prefix = '', totals = {}) {
        for (const [key, entry] of Object.entries(value || {})) {
            const field = prefix ? `${prefix}.${key}` : key;
            if (typeof entry === 'number' && Number.isFinite(entry)) totals[field] = (totals[field] || 0) + entry;
            else if (entry && typeof entry === 'object') numericFields(entry, field, totals);
        }
        return totals;
    }

    const modes = {};
    for (const mode of ['relay', 'direct']) {
        const selected = runs.filter((run) => run.mode === mode);
        const turns = selected.flatMap((run) => run.turns);
        const times = turns.map((turn) => turn.wallMs).filter((value) => typeof value === 'number');
        const tokens = {};
        for (const provider of ['codex', 'agy']) {
            const available = turns.filter((turn) => turn.provider === provider && turn.usage !== 'unavailable');
            const totals = {};
            for (const turn of available) for (const usage of turn.usage) numericFields(usage, '', totals);
            tokens[provider] = { totals: Object.keys(totals).length ? totals : 'unavailable',
                turnsWithUsage: available.length, totalTurns: 6 };
        }
        modes[mode] = { p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95),
            measuredTurns: times.length, validPayloadTurns: turns.filter((turn) => turn.validPayload).length,
            totalTurns: 12, completionRate: turns.filter((turn) => turn.validPayload).length / 12,
            successfulTurns: turns.filter((turn) => turn.succeeded).length,
            duplicateDispatchCount: mode === 'relay'
                ? selected.reduce((sum, run) => sum + run.duplicateDispatchCount, 0) : 'unavailable',
            invocationsMinusExpected: mode === 'relay'
                ? selected.reduce((sum, run) => sum + (run.journalInvocationCount || 0), 0) - 12 : 'unavailable',
            manualRecoveryInterventions: selected.reduce((sum, run) => sum + run.manualRecoveryInterventions, 0),
            tokenTotals: tokens };
    }
    const overhead = modes.direct.p50Ms > 0 && modes.relay.p50Ms !== null
        ? 100 * (modes.relay.p50Ms / modes.direct.p50Ms - 1) : null;
    const report = {
        protocol: { pairs: 3, order: runs.map(({ pair, mode }) => ({ pair, mode })),
            models: { codex: codexOptions.model, codexEffort: 'medium', agy: agyOptions.model },
            dialogue: 'A codex / B agy / C codex / D agy; identical prompt bodies within each pair',
            seeding: 'Each provider seeded once per mode-run; independent histories; seed time and usage excluded',
            timing: 'Relay inspect + receive + dispatch versus direct CLI resume; nearest-rank percentiles',
            completion: 'Valid reply payload JSON / 12 planned turns per mode',
            usage: 'Provider usage fields summed separately, preserving field names; partial coverage reported' },
        thresholds: { relayP50OverheadPercentMax: 25, completionRatePerMode: 1,
            relayDuplicateDispatchCount: 0, manualRecoveryInterventionsExpected: 0 },
        relayP50OverheadPercent: overhead,
        assessment: { overheadAcceptable: overhead === null ? null : overhead <= 25,
            completion100PercentBothModes: modes.relay.completionRate === 1 && modes.direct.completionRate === 1,
            duplicatesZero: modes.relay.duplicateDispatchCount === 0
                && runs.filter((run) => run.mode === 'relay').every((run) => !run.duplicateMessageDispatchCount) },
        modes, runs,
    };
    console.log(JSON.stringify(report, null, 2));
    console.log('\n| Mode | p50 ms | p95 ms | Valid payloads | Duplicates | Recovery |');
    console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const [mode, stats] of Object.entries(modes)) {
        console.log(`| ${mode} | ${stats.p50Ms?.toFixed(1) ?? 'unavailable'} | ${stats.p95Ms?.toFixed(1) ?? 'unavailable'} | ${stats.validPayloadTurns}/${stats.totalTurns} | ${stats.duplicateDispatchCount} | ${stats.manualRecoveryInterventions} |`);
    }
    console.log(`\nThresholds: relay p50 overhead <= +25% (observed ${overhead?.toFixed(2) ?? 'unavailable'}%); completion 100% both modes; duplicates 0; manual recovery 0. Threshold misses are reported without failing the script.`);
}
