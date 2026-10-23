'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDiscussionRelay } = require('../lib/dual/discussion/index');
const { bindingRef, validateBinding, sha256Utf8 } = require('../lib/dual/discussion/contracts');
const {
    createCodexAdapter, seedCodexConversation,
} = require('../lib/dual/discussion/live-codex-invoke');

test('live Codex/AGY discussion preserves both conversation histories', {
    skip: process.env.OMNI_DUAL_LIVE !== '1',
    timeout: 900000,
}, async (t) => {
    // Load the sibling transport only when live execution is explicitly enabled.
    const {
        createAgyAdapter, seedAgyConversation,
    } = require('../lib/dual/discussion/live-agy-invoke');
    const cwd = path.resolve(__dirname, '..');
    const codexOptions = { cwd, model: 'gpt-6.1-sol', effort: 'medium', timeoutMs: 110000 };
    const agyOptions = { cwd, model: 'gemini-3.8-flash-high', timeoutMs: 110000 };
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-disc-live-'));
    let relay;
    const started = Date.now();
    try {
        const seedStarted = Date.now();
        const codex = await seedCodexConversation(codexOptions);
        t.diagnostic(`Codex seed: ${codex.conversationId}, ${Date.now() - seedStarted}ms`);
        const agyStarted = Date.now();
        const agy = await seedAgyConversation(agyOptions);
        t.diagnostic(`AGY seed: ${agy.conversationId}, ${Date.now() - agyStarted}ms`);

        const text = 'function f(xs) { return xs.filter(x => x.active).map(x => x.id); }\n';
        const snapshot = { text, sha256: sha256Utf8(text) };
        const shared = {
            schema_version: 1,
            session_id: 'live-g1-session',
            task_id: 'live-g1',
            plan_revision: 1,
            snapshot_sha256: snapshot.sha256,
        };
        const astra = validateBinding({
            ...shared, provider: 'codex', role: 'astra', model: codexOptions.model,
            effort: 'medium', conversation_id: codex.conversationId,
        });
        const argon = validateBinding({
            ...shared, provider: 'agy', role: 'argon', model: agyOptions.model,
            effort: 'high', conversation_id: agy.conversationId,
        });
        const expectedIds = { codex: codex.conversationId, agy: agy.conversationId };
        const observations = new Map();
        // inspect() exposes invocation IDs but not classifier observations. Record
        // the real classifications and join them to inspected dispatched turns.
        function observe(adapter) {
            return {
                ...adapter,
                classify(raw, binding, invocationId, limits) {
                    const result = adapter.classify(raw, binding, invocationId, limits);
                    observations.set(`${binding.provider}:${invocationId}`, result);
                    return result;
                },
            };
        }
        const adapters = {
            codex: observe(createCodexAdapter(codexOptions)),
            agy: observe(createAgyAdapter(agyOptions)),
        };
        const authority = { check: async () => true };
        const capabilityVerifier = {
            verify: async ({ binding, bindingRef: bRef, snapshotSha256, adapterId,
                provider, adapterVersion, stage }) => ({
                allowed: true,
                liveProfileVerified: true,
                evidenceId: `live-${bRef.slice(0, 8)}`,
                expiresAt: Date.now() + 900000,
                bindingRef: bRef,
                provider,
                adapterId,
                adapterVersion,
                conversationId: binding.conversation_id,
                snapshotSha256,
                stage,
            }),
            verifyRecovery: async ({ bindingRef: bRef, invocationId }) => ({
                allowed: true,
                processQuiescent: true,
                providerTerminal: true,
                providerOutcome: 'failed',
                evidenceId: 'live-recovery',
                bindingRef: bRef,
                invocationId,
            }),
        };
        relay = await createDiscussionRelay({
            enabled: true,
            stateDir: tempDir,
            bindings: [astra, argon],
            snapshot,
            adapters,
            authority,
            capabilityVerifier,
            limits: { ttlMs: 900000, timeoutMs: 110000 },
        });
        async function turn(label, recipient, sender, body) {
            const before = await relay.inspect();
            const now = Date.now();
            const envelope = {
                schema_version: 1,
                message_id: `live-${label}`,
                sender_ref: bindingRef(sender),
                recipient_ref: bindingRef(recipient),
                sequence: before.messages.length + 1,
                kind: 'question',
                body,
                created_at: now,
                expires_at: now + 900000,
            };
            await relay.receive(envelope);
            const turnStarted = Date.now();
            let outcome;
            try {
                outcome = await relay.dispatch(envelope.message_id);
            } finally {
                t.diagnostic(`Turn ${label}: ${Date.now() - turnStarted}ms, ${JSON.stringify(outcome || (await relay.inspect()).unknown)}`);
            }
            assert.equal(outcome.provider, 'succeeded');
            assert.equal(outcome.schema, 'valid');
            assert.equal(outcome.discussion_result, 'available');
            const view = await relay.inspect();
            const response = view.messages.find((message) => message.message_id === outcome.response_message_id);
            assert.ok(response, `Turn ${label} reply is stored`);
            t.diagnostic(`Turn ${label} body: ${response.body}`);
            return response.body;
        }

        const first = await turn('A', astra, argon,
            'Based on the snapshot, propose ONE better function name and remember it for this conversation. '
            + 'Put only that JavaScript identifier in the response body.');
        const name = first.trim();
        assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/u, 'Turn A chooses one identifier');
        const critique = await turn('B', argon, astra,
            `Astra proposed this name: ${first}\nCritique the chosen name in one sentence. `
            + 'Include exactly one ALL-CAPS keyword summarizing your critique, and remember that keyword.');
        const keywords = critique.match(/\b[A-Z]{2,}\b/gu) || [];
        assert.equal(keywords.length, 1, 'Turn B contains exactly one ALL-CAPS keyword');
        const followup = await turn('C', astra, argon,
            `Argon gave this critique: ${critique}\nWhat name did you choose in your first answer, `
            + 'and do you keep it? Include the original identifier exactly.');
        assert.ok(followup.includes(name), 'Turn C recalls the original name');
        const recall = await turn('D', argon, astra,
            'Which ALL-CAPS keyword did you use in your earlier critique? Repeat it exactly.');
        assert.ok(recall.includes(keywords[0]), 'Turn D recalls the critique keyword');

        let dispatched = 0;
        const view = await relay.inspect();
        const byRef = new Map(view.bindings.map((binding) => [binding.binding_ref, binding]));
        for (const stored of view.turns.filter((entry) => entry.invocation_id !== null)) {
            const message = view.messages.find((entry) => entry.message_id === stored.message_id);
            const binding = byRef.get(message.recipient_ref);
            const observation = observations.get(`${binding.provider}:${stored.invocation_id}`);
            assert.ok(observation, 'Every dispatched turn has real classifier evidence');
            assert.equal(observation.observedConversationId, expectedIds[binding.provider]);
            assert.equal(stored.provider, 'succeeded');
            dispatched += 1;
        }
        assert.equal(dispatched, 4);
        assert.equal(observations.size, 4);
    } finally {
        const closed = await Promise.allSettled(relay ? [relay.close()] : []);
        await fs.rm(tempDir, { recursive: true, force: true });
        t.diagnostic(`Total live duration: ${Date.now() - started}ms`);
        for (const result of closed) {
            if (result.status === 'rejected') t.diagnostic(`Relay close: ${result.reason.message}`);
        }
    }
});
