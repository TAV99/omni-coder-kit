'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    createDiscussionRelay,
    createDiscussionAdapter,
    inspectJournal,
    DiscussionError,
} = require('../lib/dual/discussion');
const {
    bindingRef,
    validateBinding,
} = require('../lib/dual/discussion/contracts');

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const SNAPSHOT_TEXT = 'module.exports = { answer: 42 };\n';
const SNAPSHOT_HASH = sha256(SNAPSHOT_TEXT);

function createFixtures(stateDir, nowRef = { value: 1_700_000_000_000 }) {
    const astra = validateBinding({
        schema_version: 1,
        provider: 'codex',
        model: 'gpt-6-astra-medium',
        effort: 'medium',
        conversation_id: '01a15d65-b02d-7272-adf9-f890526e1d08',
        role: 'astra',
        session_id: 'sess-relay-01',
        task_id: 'TASK-RELAY-01',
        plan_revision: 1,
        snapshot_sha256: SNAPSHOT_HASH,
    });
    const argon = validateBinding({
        schema_version: 1,
        provider: 'agy',
        model: 'gemini-4-argon-medium',
        effort: 'medium',
        conversation_id: 'a2d46b6b-f54b-45be-82bb-e0380cdd37d1',
        role: 'argon',
        session_id: 'sess-relay-01',
        task_id: 'TASK-RELAY-01',
        plan_revision: 1,
        snapshot_sha256: SNAPSHOT_HASH,
    });
    const refA = bindingRef(astra);
    const refB = bindingRef(argon);

    let invokeCount = 0;
    const makeAdapter = (provider, adapterId) => createDiscussionAdapter({
        id: adapterId,
        provider,
        version: '1.0.0',
        mode: 'fake',
        profile: {
            format: 'json',
            allowlistedTerminalMarkers: ['fixture.completed'],
            requireConversationMatch: true,
        },
        invoke: async ({ binding, envelope, invocationId }) => {
            invokeCount += 1;
            const nextKind = envelope.kind === 'question' ? 'reply' : 'question';
            return {
                exitCode: 0,
                stdout: JSON.stringify({
                    terminal: 'fixture.completed',
                    conversation_id: binding.conversation_id,
                    invocation_id: invocationId,
                    payload: {
                        schema_version: 1,
                        kind: nextKind,
                        body: nextKind === 'reply' ? 'DONE: answered' : 'Follow-up question?',
                    },
                }),
                stderr: '',
            };
        },
        classify: (raw) => {
            const parsed = JSON.parse(raw.stdout);
            return {
                completion: parsed.status === 'error' ? 'failed' : 'succeeded',
                payload: parsed.payload,
                evidenceRef: `marker:${parsed.terminal}`,
                terminalMarker: parsed.terminal,
                observedConversationId: parsed.conversation_id,
                observedInvocationId: parsed.invocation_id,
                hasTerminalError: parsed.status === 'error',
            };
        },
    });

    const adapters = {
        codex: makeAdapter('codex', 'adapter-codex'),
        agy: makeAdapter('agy', 'adapter-agy'),
    };

    const authority = {
        check: async () => true,
    };

    const capabilityVerifier = {
        verify: async ({ binding, bindingRef: bRef, snapshotSha256, adapterId, provider, adapterVersion, stage }) => ({
            allowed: true,
            evidenceId: `ev-${bRef.slice(0, 8)}`,
            expiresAt: nowRef.value + 600_000,
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
            evidenceId: 'rec-ev-1',
            bindingRef: bRef,
            invocationId,
        }),
    };

    const questionEnvelope = {
        schema_version: 1,
        message_id: 'q-1',
        sender_ref: refA,
        recipient_ref: refB,
        sequence: 1,
        kind: 'question',
        body: 'Initial question from Astra to Argon',
        created_at: nowRef.value,
        expires_at: nowRef.value + 300_000,
    };

    const options = {
        enabled: true,
        stateDir,
        bindings: [astra, argon],
        snapshot: { text: SNAPSHOT_TEXT, sha256: SNAPSHOT_HASH },
        authority,
        capabilityVerifier,
        adapters,
        clock: () => nowRef.value,
    };

    return {
        astra,
        argon,
        refA,
        refB,
        options,
        questionEnvelope,
        getInvokeCount: () => invokeCount,
    };
}

describe('dual discussion functional relay (Task 4: R01, R03, R06-R11, R15-R20)', () => {
    let tempRoot;
    let stateDir;

    beforeEach(async () => {
        tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-disc-relay-'));
        stateDir = path.join(tempRoot, 'relay-state');
    });

    afterEach(async () => {
        if (tempRoot && fs.existsSync(tempRoot)) {
            await fsp.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('R01: default OFF performs zero filesystem or port I/O unless enabled === true', async () => {
        let portCalled = false;
        const { options } = createFixtures(stateDir);
        options.authority.check = async () => {
            portCalled = true;
            return true;
        };

        for (const badEnabled of [undefined, false, 'true', 1, null]) {
            const copy = { ...options, enabled: badEnabled };
            if (badEnabled === undefined) delete copy.enabled;
            await assert.rejects(
                createDiscussionRelay(copy),
                { code: 'DISCUSSION_DISABLED' },
            );
        }
        assert.equal(fs.existsSync(stateDir), false);
        assert.equal(portCalled, false);
    });

    it('R06, R09, R20: supports two-way fake dialogue (A question -> B reply -> A question) and keeps task_acceptance not_requested even when body says DONE', async () => {
        const { options, questionEnvelope, getInvokeCount } = createFixtures(stateDir);
        const relay = await createDiscussionRelay(options);

        const ack1 = await relay.receive(questionEnvelope);
        assert.deepEqual(ack1, { acknowledged: true, reused: false, message_id: 'q-1' });

        // Duplicate receive is idempotent and does not invoke
        const ackDup = await relay.receive(questionEnvelope);
        assert.deepEqual(ackDup, { acknowledged: true, reused: true, message_id: 'q-1' });
        assert.equal(getInvokeCount(), 0);

        // Inspect before dispatch shows receipt:stored, provider:not_started
        const preView = await relay.inspect();
        assert.equal(preView.turns[0].receipt, 'stored');
        assert.equal(preView.turns[0].provider, 'not_started');
        assert.equal(preView.turns[0].task_acceptance, 'not_requested');

        const first = await relay.dispatch(questionEnvelope.message_id);
        assert.equal(first.provider, 'succeeded');
        assert.equal(first.schema, 'valid');
        assert.equal(first.discussion_result, 'available');
        assert.equal(first.task_acceptance, 'not_requested');
        assert.ok(first.response_message_id);
        assert.equal(getInvokeCount(), 1);

        // Dispatching same ID again returns stored view without second invocation
        const firstRetry = await relay.dispatch(questionEnvelope.message_id);
        assert.deepEqual(firstRetry, first);
        assert.equal(getInvokeCount(), 1);

        const second = await relay.dispatch(first.response_message_id);
        assert.equal(second.provider, 'succeeded');
        assert.equal(second.schema, 'valid');
        assert.equal(second.discussion_result, 'available');
        assert.equal(second.task_acceptance, 'not_requested');
        assert.equal(getInvokeCount(), 2);

        const relayView = await relay.inspect();
        assert.equal(relayView.messages.length, 3);
        assert.equal(relayView.turns.every((t) => t.task_acceptance === 'not_requested'), true);

        await relay.close();
        assert.equal((await inspectJournal({ stateDir })).locked, false);
    });

    it('R10 & R11: blocks before invoke on stale authority or expired/mismatched capability evidence, and marks response stale if authority changes during invoke', async () => {
        const nowRef = { value: 1_700_000_000_000 };
        const { options, questionEnvelope, getInvokeCount } = createFixtures(stateDir, nowRef);

        // Authority false before dispatch -> zero invocations
        let allowDispatch = false;
        options.authority.check = async ({ stage }) => {
            if (stage === 'dispatch') return allowDispatch;
            return true;
        };

        const relay = await createDiscussionRelay(options);
        await relay.receive(questionEnvelope);

        await assert.rejects(
            relay.dispatch(questionEnvelope.message_id),
            { code: 'AUTHORITY_STALE' },
        );
        assert.equal(getInvokeCount(), 0);

        // Authority true, but capabilityVerifier returns mismatched conversationId -> CAPABILITY_BLOCKED, zero invocations
        allowDispatch = true;
        const origVerify = options.capabilityVerifier.verify;
        options.capabilityVerifier.verify = async (args) => ({
            ...(await origVerify(args)),
            conversationId: 'wrong-conv-id',
        });
        await assert.rejects(
            relay.dispatch(questionEnvelope.message_id),
            { code: 'CAPABILITY_BLOCKED' },
        );
        assert.equal(getInvokeCount(), 0);

        // Expired capability evidence -> CAPABILITY_BLOCKED, zero invocations
        options.capabilityVerifier.verify = async (args) => ({
            ...(await origVerify(args)),
            expiresAt: nowRef.value,
        });
        await assert.rejects(
            relay.dispatch(questionEnvelope.message_id),
            { code: 'CAPABILITY_BLOCKED' },
        );
        assert.equal(getInvokeCount(), 0);

        // Restore valid verifier, but make authority stale at 'result' stage (revision changed during invoke)
        options.capabilityVerifier.verify = origVerify;
        options.authority.check = async ({ stage }) => stage !== 'result';

        const turnView = await relay.dispatch(questionEnvelope.message_id);
        assert.equal(getInvokeCount(), 1);
        assert.equal(turnView.provider, 'succeeded');
        assert.equal(turnView.schema, 'valid');
        assert.equal(turnView.discussion_result, 'stale');
        assert.equal(turnView.response_message_id, null);
        assert.equal(turnView.task_acceptance, 'not_requested');

        await relay.close();
    });

    it('R15 & R18: rejects concurrent dispatch of different IDs with OWNER_BUSY and enforces 24-invocation ceiling', async () => {
        const nowRef = { value: 1_700_000_000_000 };
        const { options, questionEnvelope } = createFixtures(stateDir, nowRef);

        let releaseFirstInvoke;
        const firstInvokeGate = new Promise((resolve) => {
            releaseFirstInvoke = resolve;
        });
        let firstCall = true;
        const origAgyInvoke = options.adapters.agy.invoke;
        options.adapters.agy = createDiscussionAdapter({
            id: 'adapter-agy',
            provider: 'agy',
            version: '1.0.0',
            mode: 'fake',
            profile: {
                format: 'json',
                allowlistedTerminalMarkers: ['fixture.completed'],
                requireConversationMatch: true,
            },
            invoke: async (params) => {
                if (firstCall) {
                    firstCall = false;
                    await firstInvokeGate;
                }
                return origAgyInvoke(params);
            },
            classify: (raw) => {
                const parsed = JSON.parse(raw.stdout);
                return {
                    completion: parsed.status === 'error' ? 'failed' : 'succeeded',
                    payload: parsed.payload,
                    evidenceRef: `marker:${parsed.terminal}`,
                    terminalMarker: parsed.terminal,
                    observedConversationId: parsed.conversation_id,
                    observedInvocationId: parsed.invocation_id,
                    hasTerminalError: parsed.status === 'error',
                };
            },
        });

        const relay = await createDiscussionRelay(options);
        await relay.receive(questionEnvelope);

        const p1 = relay.dispatch('q-1');
        // Concurrent dispatch of the SAME message ID joins the in-flight invocation without a second provider call
        const p1Same = relay.dispatch('q-1');
        // Concurrent dispatch of another message ID while p1 is active must reject immediately with OWNER_BUSY
        await assert.rejects(
            relay.dispatch('other-msg'),
            { code: 'OWNER_BUSY' },
        );
        releaseFirstInvoke();
        const [t1, t1Same] = await Promise.all([p1, p1Same]);
        assert.deepEqual(t1Same, t1);
        assert.equal(t1.discussion_result, 'available');

        // Continue up to 24 invocations total (raised ceiling: 15–18 review
        // chunks + 1 shared scout turn + retry headroom must fit one relay)
        let nextId = t1.response_message_id;
        for (let turn = 2; turn <= 24; turn++) {
            const res = await relay.dispatch(nextId);
            assert.equal(res.discussion_result, 'available');
            nextId = res.response_message_id;
        }

        // 25th dispatch exceeds ceiling 24 -> LIMIT_EXCEEDED (loop protection intact)
        await assert.rejects(
            relay.dispatch(nextId),
            { code: 'LIMIT_EXCEEDED' },
        );

        await relay.close();
    });

    it('P2 receive boundary & maxInvocations dispatch-vs-sequence boundary (maxInvocations: 1 and 24 receive+dispatch turns)', async () => {
        const dirOne = path.join(tempRoot, 'max-inv-1');
        const nowRef = { value: 1_700_000_000_000 };
        const f1 = createFixtures(dirOne, nowRef);
        f1.options.limits = { maxInvocations: 1 };

        const relay1 = await createDiscussionRelay(f1.options);
        const mutableEnv = {
            ...f1.questionEnvelope,
            body: 'Original question before yield',
        };
        const pendingReceive = relay1.receive(mutableEnv);
        mutableEnv.body = 'Mutated question after call';
        await pendingReceive;

        const viewBeforeDispatch = await relay1.inspect();
        assert.equal(viewBeforeDispatch.messages[0].body, 'Original question before yield');

        const turn1 = await relay1.dispatch('q-1');
        assert.equal(turn1.provider, 'succeeded');
        assert.equal(turn1.discussion_result, 'available');
        assert.ok(turn1.response_message_id);

        const viewAfter1 = await relay1.inspect();
        assert.equal(viewAfter1.invocation_count, 1);
        assert.equal(viewAfter1.messages.length, 2);
        assert.equal(viewAfter1.messages[1].sequence, 2);

        await assert.rejects(
            relay1.dispatch(turn1.response_message_id),
            { code: 'LIMIT_EXCEEDED' },
        );
        await relay1.close();

        const dirTwentyFour = path.join(tempRoot, 'max-inv-24-pairs');
        const f24 = createFixtures(dirTwentyFour, nowRef);
        const relay24 = await createDiscussionRelay(f24.options);

        for (let inv = 1; inv <= 24; inv++) {
            const qSeq = (inv - 1) * 2 + 1;
            const qMsgId = `q-pair-${inv}`;
            await relay24.receive({
                schema_version: 1,
                message_id: qMsgId,
                sender_ref: f24.refA,
                recipient_ref: f24.refB,
                sequence: qSeq,
                kind: 'question',
                body: `Question ${inv}`,
                created_at: nowRef.value,
                expires_at: nowRef.value + 300_000,
            });
            const turn = await relay24.dispatch(qMsgId);
            assert.equal(turn.provider, 'succeeded');
            assert.equal(turn.discussion_result, 'available');
            assert.ok(turn.response_message_id);
        }

        const view24 = await relay24.inspect();
        assert.equal(view24.invocation_count, 24);
        assert.equal(view24.messages.length, 48);
        assert.equal(view24.messages[47].sequence, 48);

        await relay24.receive({
            schema_version: 1,
            message_id: 'q-pair-25',
            sender_ref: f24.refA,
            recipient_ref: f24.refB,
            sequence: 49,
            kind: 'question',
            body: 'Question 25 exceeding maxInvocations on dispatch',
            created_at: nowRef.value,
            expires_at: nowRef.value + 300_000,
        });
        await assert.rejects(
            relay24.dispatch('q-pair-25'),
            { code: 'LIMIT_EXCEEDED' },
        );
        await relay24.close();
    });
});
