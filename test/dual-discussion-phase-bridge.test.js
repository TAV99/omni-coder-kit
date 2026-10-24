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

async function sessionFixture(t, { body = '{"summary":"scouted"}', unknown = false, bodies, recover = false, invalidPayload = false, failed = [] } = {}) {
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
                if (unknown === true || (Array.isArray(unknown) && unknown.includes(calls.length))) throw new Error('provider outcome unavailable');
                return { exitCode: failed.includes(calls.length) ? 7 : 0, stderr: '', stdout: JSON.stringify({
                    conversationId: args.binding.conversation_id, invocationId: args.invocationId,
                    payload: { schema_version: 1, kind: 'reply', body: invalidPayload ? { token: 'secret-value', text: 'x'.repeat(2000) } : (bodies ? bodies[calls.length - 1] : body) },
                }) };
            },
            classify: (raw) => {
                const parsed = JSON.parse(raw.stdout);
                return { completion: raw.exitCode === 0 ? 'succeeded' : 'failed', payload: parsed.payload,
                    observedConversationId: parsed.conversationId, observedInvocationId: parsed.invocationId,
                    terminalMarker: 'fixture.completed', evidenceRef: 'fixture', hasTerminalError: false };
            },
        });
    }
    session = await createDiscussionSession({
        models: { agy: 'gemini-3.8-flash-high' }, efforts: { agy: 'high' },
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
                ...(recover || args.evidence.fixtureCleanup ? {} : { allowed: false }),
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


test('unknown reconciles failed, supplies recovery reply, then re-asks identical body once', async (t) => {
    const { session, calls, args } = await sessionFixture(t, { unknown: [1], recover: true });
    const outcome = await runDiscussionPhase(args);
    assert.equal(outcome.discussionRecovery, 'reconciled-retry');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].envelope.body, calls[0].envelope.body);
    assert.notEqual(calls[1].envelope.message_id, calls[0].envelope.message_id);
    assert.equal(outcome.messageId, calls[1].envelope.message_id);
    const view = await session.relay.inspect();
    assert.equal(outcome.responseMessageId,
        view.turns.find((turn) => turn.message_id === outcome.messageId).response_message_id);
    assert.equal(view.messages[1].kind, 'reply');
    assert.equal(view.messages[1].reply_to, args.messageId);
    assert.equal(view.turns[0].reconciled_outcome, 'failed');
    assert.equal(view.blocked, false);
});

for (const schemaFailure of [false, true]) {
    test(`recovery diagnostics identify the retry turn (schema failure=${schemaFailure})`, async (t) => {
        const { session, calls, args } = await sessionFixture(t, {
            unknown: [schemaFailure ? 2 : 1], recover: true,
            bodies: schemaFailure ? ['{"summary":42}', '', '{"summary":43}'] : ['', 'bad JSON'],
        });
        let details;
        await assert.rejects(runDiscussionPhase({ ...args,
            ...(schemaFailure ? { validate: () => ({ ok: false, issues: 'summary must be a string' }) } : {}),
        }), (err) => {
            assert.ok(phaseError('RESULT_MALFORMED')(err));
            assert.equal(err.details.messageId, calls.at(-1).envelope.message_id);
            assert.equal(err.details.invocationId, calls.at(-1).invocationId);
            details = err.details;
            return true;
        });
        const view = await session.relay.inspect();
        const retryTurn = view.turns.find((turn) => turn.message_id === details.messageId);
        assert.equal(details.responseMessageId, retryTurn.response_message_id);
    });
}

test('second unknown propagates without a second reconciliation', async (t) => {
    const { session, calls, args } = await sessionFixture(t, { unknown: true, recover: true });
    const reconcile = session.relay.reconcile;
    let recoveries = 0;
    session.relay = { ...session.relay, reconcile: (...a) => { recoveries++; return reconcile(...a); } };
    await assert.rejects(runDiscussionPhase(args), phaseError('OUTCOME_UNKNOWN'));
    assert.equal(calls.length, 2);
    assert.equal(recoveries, 1);
});

for (const secondValid of [true, false]) {
    test(`schema correction validates follow-up (second valid=${secondValid})`, async (t) => {
        const { session, calls, args } = await sessionFixture(t, {
            bodies: ['{"summary":42}', secondValid ? '{"summary":"fixed"}' : '{"summary":43}'],
        });
        const validate = (value) => typeof value.summary === 'string'
            ? { ok: true } : { ok: false, issues: 'summary must be a string' };
        const run = runDiscussionPhase({ ...args, promptBody: 'Original prompt\nSCHEMA: summary string', schemaText: 'SCHEMA: summary string', validate });
        if (secondValid) {
            const outcome = await run;
            assert.equal(outcome.result.summary, 'fixed');
            assert.equal(outcome.discussionCorrection, 'schema-nudge');
        } else {
            await assert.rejects(run, (err) => {
                assert.ok(phaseError('RESULT_MALFORMED')(err));
                assert.equal(err.details.validationIssues, 'summary must be a string');
                assert.equal(err.details.rawReplyExcerpt, '{"summary":43}');
                return true;
            });
        }
        assert.equal(calls.length, 2);
        const correction = calls[1].envelope;
        assert.ok(correction.body.startsWith(calls[0].envelope.body));
        assert.ok(correction.body.includes('summary must be a string'));
        assert.ok(correction.body.endsWith('Answer with ONLY a JSON object matching the schema above.'));
        assert.equal(correction.body.split('SCHEMA: summary string').length - 1, 1);
        assert.equal(correction.body.split('Original prompt').length - 1, 1);
        assert.equal(correction.sender_ref, args.senderRef);
        assert.equal(correction.recipient_ref, args.recipientRef);
        assert.equal((await session.relay.inspect()).messages.length, 4);
    });
}

test('without validator a schema-invalid JSON object returns unchanged', async (t) => {
    const { calls, args } = await sessionFixture(t, { body: '{"summary":42}' });
    assert.deepEqual((await runDiscussionPhase(args)).result, { summary: 42 });
    assert.equal(calls.length, 1);
});


for (const settlement of [undefined, { reconciled: false }, { reconciled: true, reconciled_outcome: 'succeeded' }]) {
    test(`unsettled/non-failed reconciliation preserves original phase error (${JSON.stringify(settlement)})`, async () => {
        const original = new DiscussionPhaseError('OUTCOME_UNKNOWN', 'original failure', { marker: 'unchanged' });
        let dispatches = 0, receives = 0, reconciles = 0;
        const session = { enabled: true, relay: {
            inspect: async () => ({ messages: [] }),
            receive: async () => { receives++; },
            dispatch: async () => { dispatches++; throw original; },
            reconcile: async () => { reconciles++; return settlement; },
        } };
        await assert.rejects(runDiscussionPhase({ session, phase: 'scout', messageId: 'original' }), (err) => err === original);
        assert.equal(reconciles, 1);
        assert.equal(dispatches, 1);
        assert.equal(receives, 1);
    });
}

test('returned outcome_unknown attempts recovery once and retains invocation details', async () => {
    let reconciles = 0;
    const session = { enabled: true, relay: {
        inspect: async () => ({ messages: [], unknown: { invocation_id: 'inv-returned', binding_ref: 'worker' } }),
        receive: async () => {},
        dispatch: async () => ({ provider: 'outcome_unknown', invocation_id: 'inv-returned' }),
        reconcile: async () => { reconciles++; throw new Error('insufficient evidence'); },
    } };
    await assert.rejects(runDiscussionPhase({ session, phase: 'scout', messageId: 'original' }), (err) => {
        assert.ok(phaseError('OUTCOME_UNKNOWN')(err));
        assert.equal(err.details.invocationId, 'inv-returned');
        return true;
    });
    assert.equal(reconciles, 1);
});

test('correction malformed JSON retains previous validation issues', async (t) => {
    const { calls, args } = await sessionFixture(t, { bodies: ['{"summary":42}', 'bad JSON'] });
    await assert.rejects(runDiscussionPhase({ ...args, validate: () => ({ ok: false, issues: 'summary must be a string' }) }), (err) => {
        assert.ok(phaseError('RESULT_MALFORMED')(err));
        assert.equal(err.details.rawReplyExcerpt, 'bad JSON');
        assert.equal(err.details.validationIssues, 'summary must be a string');
        return true;
    });
    assert.equal(calls.length, 2);
});


for (const schemaPlacement of ['embedded', 'omitted', 'separate']) {
    test(`schema correction keeps a 12 KiB input within relay limits (schema ${schemaPlacement})`, async (t) => {
        const { calls, args } = await sessionFixture(t, { bodies: ['{"summary":42}', '{"summary":"fixed"}'] });
        const schemaText = 'SCHEMA: summary string';
        const outcome = await runDiscussionPhase({ ...args,
            promptBody: 'x'.repeat(12 * 1024) + (schemaPlacement === 'separate' ? '' : `\n${schemaText}`),
            ...(schemaPlacement === 'omitted' ? {} : { schemaText }),
            validate: (value) => typeof value.summary === 'string' ? { ok: true } : { ok: false, issues: 'summary must be a string' },
        });
        assert.equal(outcome.discussionCorrection, 'schema-nudge');
        assert.equal(calls.length, 2);
        const originalBody = calls[0].envelope.body;
        const correctionBody = calls[1].envelope.body;
        assert.ok(correctionBody.startsWith(originalBody));
        assert.ok(Buffer.byteLength(correctionBody) <= Buffer.byteLength(originalBody) + 1024);
        assert.ok(Buffer.byteLength(correctionBody) < 16 * 1024);
        assert.equal(correctionBody.split(schemaText).length - 1, 1);
        assert.equal(correctionBody.split(args.snapshotText).length - 1, 1);
        assert.ok(correctionBody.endsWith('Answer with ONLY a JSON object matching the schema above.'));
    });
}

for (const recovery of ['blocked', 'succeeded', 'unsettled']) {
    test(`recovery diagnostic records ${recovery} while retaining OUTCOME_UNKNOWN`, async () => {
        const session = { enabled: true, relay: {
            inspect: async () => ({ messages: [] }), receive: async () => {},
            dispatch: async () => { throw Object.assign(new Error('unknown'), { code: 'OUTCOME_UNKNOWN' }); },
            reconcile: async () => {
                if (recovery === 'blocked') throw Object.assign(new Error('private failure text'), { code: 'CAPABILITY_BLOCKED' });
                return recovery === 'succeeded' ? { reconciled: true, reconciled_outcome: 'succeeded' }
                    : { reconciled: false, code: 'RECOVERY_PENDING' };
            },
        } };
        await assert.rejects(runDiscussionPhase({ session, phase: 'scout', messageId: 'original' }), (err) => {
            assert.ok(phaseError('OUTCOME_UNKNOWN')(err));
            if (recovery === 'succeeded') assert.equal(err.details.recoveryOutcome, 'succeeded');
            else assert.equal(err.details.recoveryError, recovery === 'blocked' ? 'CAPABILITY_BLOCKED' : 'RECOVERY_PENDING');
            assert.ok(!JSON.stringify(err.details).includes('private failure text'));
            return true;
        });
    });
}

test('schema-invalid adapter observation supplies bounded redacted excerpt without stored reply', async (t) => {
    const { session, args } = await sessionFixture(t, { invalidPayload: true });
    await assert.rejects(runDiscussionPhase(args), (err) => {
        assert.ok(phaseError('RESULT_MALFORMED')(err));
        assert.ok(err.details.rawReplyExcerpt.length <= 1024);
        assert.ok(err.details.rawReplyExcerpt.includes('[REDACTED]'));
        assert.ok(!err.details.rawReplyExcerpt.includes('secret-value'));
        return true;
    });
    const view = await session.relay.inspect();
    assert.equal(view.messages.length, 1);
    assert.equal(view.turns[0].raw_reply_excerpt.length, 1024);
});

for (const repeated of [false, true]) {
    test(`settled failure re-asks once (repeated=${repeated})`, async (t) => {
        const { session, calls, args } = await sessionFixture(t, { failed: repeated ? [1, 2] : [1] });
        if (repeated) await assert.rejects(runDiscussionPhase(args), phaseError('RESULT_MALFORMED'));
        else {
            const result = await runDiscussionPhase(args);
            assert.equal(result.discussionRecovery, 'failed-retry');
            assert.deepEqual(result.result, { summary: 'scouted' });
        }
        assert.equal(calls.length, 2);
        assert.equal(calls[0].envelope.body, calls[1].envelope.body);
        const view = await session.relay.inspect();
        assert.equal(view.messages[1].kind, 'reply');
        assert.equal(view.messages[1].reply_to, args.messageId);
        assert.equal(view.messages[2].kind, 'question');
        assert.equal(view.turns[0].provider, 'failed');
        assert.equal(view.unknown, null);
    });
}

for (const firstUnknown of [false, true]) {
    test(`recovery does not re-ask twice across failure types (first unknown=${firstUnknown})`, async (t) => {
        const { session, calls, args } = await sessionFixture(t, {
            failed: firstUnknown ? [2] : [1], unknown: firstUnknown ? [1] : [2], recover: true,
        });
        await assert.rejects(runDiscussionPhase(args), (err) => {
            assert.ok(phaseError(firstUnknown ? 'RESULT_MALFORMED' : 'OUTCOME_UNKNOWN')(err));
            assert.equal(err.details.messageId, calls[1].envelope.message_id);
            assert.equal(err.details.invocationId, calls[1].invocationId);
            return true;
        });
        assert.equal(calls.length, 2);
        const view = await session.relay.inspect();
        assert.deepEqual(view.messages.map((message) => message.kind), ['question', 'reply', 'question']);
    });
}
