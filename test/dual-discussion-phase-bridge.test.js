'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bindingRef, sha256Utf8 } = require('../lib/dual/discussion/contracts');
const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');
const { createHostPorts } = require('../lib/dual/discussion/host-ports');
const { createDiscussionSession } = require('../lib/dual/discussion/session');
const { DISCUSSION_PHASES, DiscussionPhaseError, runDiscussionPhase } = require('../lib/dual/discussion/phase-bridge');

async function sessionFixture(t, { body = '{"summary":"scouted"}', unknown = false } = {}) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-phase-bridge-'));
    const calls = [];
    const snapshot = { text: 'Read-only phase context', sha256: sha256Utf8('Read-only phase context') };
    let session;
    t.after(async () => {
        try {
            if (session) {
                const view = await session.relay.inspect();
                if (view.unknown) await session.relay.reconcile(view.unknown.message_id, { fixtureCleanup: true });
                await session.close();
            }
        }
        finally { await fs.rm(stateDir, { recursive: true, force: true }); }
    });
    function fakeAdapter(provider) {
        return createDiscussionAdapter({
            id: `fake-${provider}`, provider, version: '1', mode: 'fake',
            profile: { format: 'json', requireConversationMatch: true,
                allowlistedTerminalMarkers: ['fixture.completed'] },
            invoke: async (args) => {
                calls.push(args);
                if (unknown) throw new Error('provider outcome unavailable');
                return { exitCode: 0, stderr: '', stdout: JSON.stringify({
                    conversationId: args.binding.conversation_id, invocationId: args.invocationId,
                    payload: { schema_version: 1, kind: 'reply', body },
                }) };
            },
            classify: (raw) => {
                const parsed = JSON.parse(raw.stdout);
                return { completion: 'succeeded', payload: parsed.payload,
                    observedConversationId: parsed.conversationId, observedInvocationId: parsed.invocationId,
                    terminalMarker: 'fixture.completed', evidenceRef: 'fixture', hasTerminalError: false };
            },
        });
    }
    session = await createDiscussionSession({
        enabled: true, stateDir, sessionId: 'phase-session', taskId: 'task-1', planRevision: 1, snapshot,
        seeds: Object.fromEntries(['codex', 'agy'].map((provider) =>
            [provider, async () => ({ conversationId: `seed-${provider}` })])),
        adapters: { codex: fakeAdapter('codex'), agy: fakeAdapter('agy') },
        hostPorts: createHostPorts({
            checkAuthority: async () => true,
            verifyCapability: async (args) => ({
                allowed: true, liveProfileVerified: true, evidenceId: 'phase-evidence',
                expiresAt: Date.now() + 600_000, bindingRef: args.bindingRef,
                provider: args.provider, adapterId: args.adapterId, adapterVersion: args.adapterVersion,
                conversationId: args.binding.conversation_id, snapshotSha256: args.snapshotSha256, stage: args.stage,
            }),
            verifyRecoveryEvidence: async (args) => ({
                allowed: true, processQuiescent: true, providerTerminal: true,
                providerOutcome: 'failed', evidenceId: 'fixture-recovery',
                bindingRef: args.bindingRef, invocationId: args.invocationId,
            }),
        }),
    });
    return { session, calls, args: { session, phase: 'scout', promptBody: 'Return phase JSON',
        snapshotText: snapshot.text, senderRef: bindingRef(session.bindings[0]),
        recipientRef: bindingRef(session.bindings[1]), messageId: 'phase-1', ttlMs: 300_000, now: Date.now() } };
}

function phaseError(code) {
    return (err) => err instanceof DiscussionPhaseError && err.code === code;
}

test('discussion phases are frozen and exclude implement', () => {
    assert.deepEqual(DISCUSSION_PHASES, ['scout', 'plan', 'review']);
    assert.ok(Object.isFrozen(DISCUSSION_PHASES));
});

test('scout round-trip returns parsed body and stored message identifiers', async (t) => {
    const { session, calls, args } = await sessionFixture(t);
    const outcome = await runDiscussionPhase(args);
    assert.deepEqual(outcome, { phase: 'scout', result: { summary: 'scouted' },
        rawBody: '{"summary":"scouted"}', messageId: 'phase-1', responseMessageId: 'resp-inv-1-1' });
    const view = await session.relay.inspect();
    assert.equal(view.messages.length, 2);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].envelope.body.includes(args.promptBody));
    assert.ok(calls[0].envelope.body.includes(args.snapshotText));
    assert.equal(view.messages[0].created_at, args.now);
    assert.equal(view.messages[0].expires_at, args.now + args.ttlMs);
});

test('plan parses a surrounding JSON fence while preserving rawBody', async (t) => {
    const body = '  ```json\n{"steps":["inspect","build"]}\n```\n';
    const { args } = await sessionFixture(t, { body });
    const outcome = await runDiscussionPhase({ ...args, phase: 'plan' });
    assert.deepEqual(outcome.result, { steps: ['inspect', 'build'] });
    assert.equal(outcome.rawBody, body);
});

test('implement is refused before relay receives anything', async (t) => {
    const { session, calls, args } = await sessionFixture(t);
    await assert.rejects(runDiscussionPhase({ ...args, phase: 'implement' }), phaseError('PHASE_NOT_DISCUSSION'));
    assert.equal((await session.relay.inspect()).messages.length, 0);
    assert.equal(calls.length, 0);
});

test('unknown outcome carries message and invocation info without retry', async (t) => {
    const { session, calls, args } = await sessionFixture(t, { unknown: true });
    await assert.rejects(runDiscussionPhase(args), (err) => {
        assert.ok(phaseError('OUTCOME_UNKNOWN')(err));
        assert.equal(err.details.messageId, args.messageId);
        assert.equal(err.details.invocationId, calls[0].invocationId);
        assert.equal(err.details.bindingRef, args.recipientRef);
        return true;
    });
    const view = await session.relay.inspect();
    assert.equal(calls.length, 1);
    assert.equal(view.invocation_count, 1);
    assert.equal(view.blocked, true);
});

for (const body of ['not JSON', 'null', '[]', '"text"', 'before ```json\n{}\n``` after']) {
    test(`rejects malformed phase result: ${body}`, async (t) => {
        const { calls, args } = await sessionFixture(t, { body });
        await assert.rejects(runDiscussionPhase(args), phaseError('RESULT_MALFORMED'));
        assert.equal(calls.length, 1);
    });
}

test('disabled session is refused before relay access', async () => {
    const session = await createDiscussionSession({ enabled: false });
    await assert.rejects(runDiscussionPhase({ session, phase: 'scout' }), phaseError('SESSION_DISABLED'));
});

test('review reuses session with explicit reversed direction and next relay sequence', async (t) => {
    const { session, calls, args } = await sessionFixture(t);
    await runDiscussionPhase(args);
    const outcome = await runDiscussionPhase({ ...args, phase: 'review', messageId: 'phase-2',
        senderRef: args.recipientRef, recipientRef: args.senderRef });
    assert.equal(outcome.phase, 'review');
    assert.equal(calls[1].binding.provider, 'codex');
    assert.equal(calls[1].envelope.sequence, 3);
    assert.equal((await session.relay.inspect()).messages.length, 4);
});
