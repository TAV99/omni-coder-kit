'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDiscussionRelay, inspectJournal, bindingRef, validateBinding } = require('../lib/dual/discussion');
const { sha256Utf8 } = require('../lib/dual/discussion/contracts');
const { createCodexAdapter, seedCodexConversation } = require('../lib/dual/discussion/live-codex-invoke');
const { createAgyAdapter, seedAgyConversation } = require('../lib/dual/discussion/live-agy-invoke');

const live = { skip: process.env.OMNI_DUAL_LIVE !== '1', timeout: 600000 };
const cwd = path.resolve(__dirname, '..');
const codexOptions = { cwd, model: 'gpt-6.1-sol', effort: 'medium', timeoutMs: 110000 };
const agyOptions = { cwd, model: 'gemini-3.8-flash-high', timeoutMs: 110000 };
const unusedId = '00000000-0000-0000-0000-000000000000';

function setup(stateDir, ids, adapters) {
    const text = 'function f(xs) { return xs.filter(x => x.active).map(x => x.id); }\n';
    const snapshot = { text, sha256: sha256Utf8(text) };
    const shared = {
        schema_version: 1, session_id: 'live-g2-session', task_id: 'live-g2',
        plan_revision: 1, snapshot_sha256: snapshot.sha256,
    };
    const bindings = [
        validateBinding({ ...shared, provider: 'codex', role: 'astra', model: codexOptions.model,
            effort: 'medium', conversation_id: ids.codex || unusedId }),
        validateBinding({ ...shared, provider: 'agy', role: 'argon', model: agyOptions.model,
            effort: 'high', conversation_id: ids.agy || unusedId }),
    ];
    return {
        enabled: true, stateDir, bindings, snapshot, adapters,
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
                providerOutcome: 'failed', evidenceId: 'live-g2-recovery',
                bindingRef: bRef, invocationId,
            }),
        },
        limits: { ttlMs: 900000, timeoutMs: 110000 },
    };
}

async function receive(relay, bindings, id, provider, extra = {}) {
    const recipient = bindings.find((binding) => binding.provider === provider);
    const sender = bindings.find((binding) => binding.provider !== provider);
    const now = Date.now();
    await relay.receive({
        schema_version: 1, message_id: id, sender_ref: bindingRef(sender),
        recipient_ref: bindingRef(recipient), sequence: (await relay.inspect()).messages.length + 1,
        kind: 'question', body: 'Reply briefly with ready.', created_at: now,
        expires_at: now + 900000, ...extra,
    });
}

async function invocationCount(stateDir, id) {
    const journal = await inspectJournal({ stateDir });
    return journal.events.filter(({ event }) => event.type === 'dispatch_intent'
        && event.message_id === id).length;
}

async function cleanup(t, relay, stateDir) {
    if (relay) {
        try { await relay.close(); } catch (error) {
            t.diagnostic(`Cleanup close: ${error.code}: ${error.message}`);
        }
    }
    await fs.rm(stateDir, { recursive: true, force: true });
}

function assertSuccess(turn) {
    assert.equal(turn.provider, 'succeeded');
    assert.equal(turn.schema, 'valid');
    assert.equal(turn.discussion_result, 'available');
}

test('G2 F1: AGY timeout blocks dispatch until reconciliation, then conversation resumes', live, async (t) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-live-g2-f1-'));
    let relay;
    try {
        const seed = await seedAgyConversation(agyOptions);
        const short = createAgyAdapter({ ...agyOptions, timeoutMs: 50 });
        const normal = createAgyAdapter(agyOptions);
        let timeoutNext = true;
        // Same live adapter identity; only the first call uses the 50ms adapter option.
        const agy = { ...normal, invoke(params) {
            const adapter = timeoutNext ? short : normal;
            timeoutNext = false;
            return adapter.invoke(params);
        } };
        const options = setup(stateDir, { agy: seed.conversationId }, {
            codex: createCodexAdapter(codexOptions), agy,
        });
        relay = await createDiscussionRelay(options);
        await receive(relay, options.bindings, 'f1-timeout', 'agy');
        await assert.rejects(relay.dispatch('f1-timeout'), { code: 'OUTCOME_UNKNOWN' });
        let view = await relay.inspect();
        assert.equal(view.turns.find((turn) => turn.message_id === 'f1-timeout').provider, 'outcome_unknown');
        assert.equal(view.blocked, true);
        await assert.rejects(relay.dispatch('f1-timeout'), {
            code: 'OUTCOME_UNKNOWN', message: 'Relay is blocked by an unresolved unknown outcome',
        });
        assert.equal(await invocationCount(stateDir, 'f1-timeout'), 1);
        const recovered = await relay.reconcile('f1-timeout', {});
        assert.equal(recovered.reconciled, true);
        assert.equal(recovered.reconciled_outcome, 'failed');
        view = await relay.inspect();
        assert.equal(view.blocked, false);
        assert.equal(view.unknown, null);
        assert.deepEqual(view.turns.find((turn) => turn.message_id === 'f1-timeout'), recovered);
        // Reconciliation clears the block but does not synthesize a reply. Supply a
        // host recovery reply so the next question satisfies the actual choreography.
        await receive(relay, options.bindings, 'f1-recovery-reply', 'codex', {
            kind: 'reply', reply_to: 'f1-timeout', body: 'The timed-out attempt was reconciled as failed.',
        });
        await receive(relay, options.bindings, 'f1-fresh', 'agy');
        const fresh = await relay.dispatch('f1-fresh');
        assertSuccess(fresh);
        assert.equal(await invocationCount(stateDir, 'f1-timeout'), 1);
        t.diagnostic(JSON.stringify({ scenario: 'F1', conversationId: seed.conversationId,
            messageId: 'f1-timeout', unknown: 'outcome_unknown', recovered, fresh,
            invocations: await invocationCount(stateDir, 'f1-timeout') }));
    } finally { await cleanup(t, relay, stateDir); }
});

test('G2 F2: bogus Codex conversation never produces an available response', live, async (t) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-live-g2-f2-'));
    let relay;
    try {
        const options = setup(stateDir, { codex: unusedId }, {
            codex: createCodexAdapter(codexOptions), agy: createAgyAdapter(agyOptions),
        });
        relay = await createDiscussionRelay(options);
        await receive(relay, options.bindings, 'f2-bogus', 'codex');
        let errorCode = null;
        try { await relay.dispatch('f2-bogus'); } catch (error) {
            assert.equal(error.code, 'OUTCOME_UNKNOWN');
            errorCode = error.code;
        }
        const view = await relay.inspect();
        const turn = view.turns.find((entry) => entry.message_id === 'f2-bogus');
        assert.ok(['failed', 'outcome_unknown'].includes(turn.provider));
        assert.notEqual(turn.provider, 'succeeded');
        assert.notEqual(turn.discussion_result, 'available');
        assert.equal(turn.response_message_id, null);
        assert.equal(view.messages.some((message) => message.reply_to === 'f2-bogus'), false);
        assert.equal(view.turns.some((entry) => entry.discussion_result === 'available'), false);
        const count = await invocationCount(stateDir, 'f2-bogus');
        assert.equal(count, 1);
        t.diagnostic(JSON.stringify({ scenario: 'F2', conversationId: unusedId, turn, errorCode, invocations: count }));
    } finally { await cleanup(t, relay, stateDir); }
});

test('G2 F3: restart replays successful turn and resumes the seeded Codex conversation', live, async (t) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-live-g2-f3-'));
    let relay;
    try {
        const seed = await seedCodexConversation(codexOptions);
        const observations = new Map();
        const adapter = createCodexAdapter(codexOptions);
        const codex = { ...adapter, classify(raw, binding, invocationId, limits) {
            const result = adapter.classify(raw, binding, invocationId, limits);
            observations.set(invocationId, result);
            return result;
        } };
        const options = setup(stateDir, { codex: seed.conversationId }, {
            codex, agy: createAgyAdapter(agyOptions),
        });
        relay = await createDiscussionRelay(options);
        await receive(relay, options.bindings, 'f3-first', 'codex');
        const first = await relay.dispatch('f3-first');
        assertSuccess(first);
        const before = await relay.inspect();
        const response = before.messages.find((message) => message.message_id === first.response_message_id);
        assert.ok(response);
        await relay.close();
        relay = null;
        relay = await createDiscussionRelay(options);
        const restored = await relay.inspect();
        assert.deepEqual(restored.turns, before.turns);
        assert.deepEqual(restored.messages, before.messages);
        assert.deepEqual(restored.messages.find((message) => message.message_id === first.response_message_id), response);
        await receive(relay, options.bindings, 'f3-followup', 'codex');
        const followup = await relay.dispatch('f3-followup');
        assertSuccess(followup);
        for (const turn of [first, followup]) {
            assert.equal(observations.get(turn.invocation_id).observedConversationId, seed.conversationId);
            assert.equal(await invocationCount(stateDir, turn.message_id), 1);
        }
        t.diagnostic(JSON.stringify({ scenario: 'F3', conversationId: seed.conversationId,
            first, response, followup, invocations: (await relay.inspect()).invocation_count,
            observedConversationIds: [...observations.values()].map((entry) => entry.observedConversationId) }));
    } finally { await cleanup(t, relay, stateDir); }
});
