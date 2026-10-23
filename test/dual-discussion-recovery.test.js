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
    bindingRef,
    validateBinding,
} = require('../lib/dual/discussion');

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const SNAPSHOT_TEXT = 'function verify(x) { return Boolean(x); }\n';
const SNAPSHOT_HASH = sha256(SNAPSHOT_TEXT);

function makeSetup(stateDir, nowRef = { value: 1_700_000_000_000 }) {
    const astra = validateBinding({
        schema_version: 1,
        provider: 'codex',
        model: 'gpt-6-astra-medium',
        effort: 'medium',
        conversation_id: '01a15d65-b02d-7272-adf9-f890526e1d08',
        role: 'astra',
        session_id: 'sess-rec-01',
        task_id: 'TASK-REC-01',
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
        session_id: 'sess-rec-01',
        task_id: 'TASK-REC-01',
        plan_revision: 1,
        snapshot_sha256: SNAPSHOT_HASH,
    });
    const refA = bindingRef(astra);
    const refB = bindingRef(argon);

    let invokeCalls = 0;
    let customAgyInvoke = null;

    const makeAdapter = (provider, id) => createDiscussionAdapter({
        id,
        provider,
        version: '1.0.0',
        mode: 'fake',
        profile: {
            format: 'json',
            allowlistedTerminalMarkers: ['fixture.completed'],
            requireConversationMatch: true,
        },
        invoke: async (params) => {
            invokeCalls += 1;
            if (provider === 'agy' && customAgyInvoke) {
                return customAgyInvoke(params);
            }
            const nextKind = params.envelope.kind === 'question' ? 'reply' : 'question';
            return {
                exitCode: 0,
                stdout: JSON.stringify({
                    terminal: 'fixture.completed',
                    conversation_id: params.binding.conversation_id,
                    invocation_id: params.invocationId,
                    payload: {
                        schema_version: 1,
                        kind: nextKind,
                        body: nextKind === 'reply' ? 'Reply body' : 'Next question body',
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
            evidenceId: 'rec-ev-01',
            bindingRef: bRef,
            invocationId,
        }),
    };

    const q1 = {
        schema_version: 1,
        message_id: 'q-1',
        sender_ref: refA,
        recipient_ref: refB,
        sequence: 1,
        kind: 'question',
        body: 'Question 1',
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
        adapters: {
            codex: makeAdapter('codex', 'adapter-codex'),
            agy: makeAdapter('agy', 'adapter-agy'),
        },
        clock: () => nowRef.value,
    };

    return {
        astra,
        argon,
        refA,
        refB,
        q1,
        options,
        getInvokeCalls: () => invokeCalls,
        setCustomAgyInvoke: (fn) => { customAgyInvoke = fn; },
    };
}

describe('dual discussion fault boundaries & recovery (Task 5: R12-R20)', () => {
    let tempRoot;

    beforeEach(async () => {
        tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-disc-rec-'));
    });

    afterEach(async () => {
        if (tempRoot && fs.existsSync(tempRoot)) {
            await fsp.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('Boundary 1 & 2 (R12): received-before-ACK and intent-before-invoke sync failures do not ACK or spawn, and retain lock', async () => {
        // 1. received-before-ACK sync failure
        const dir1 = path.join(tempRoot, 'b1');
        let syncCount1 = 0;
        const s1 = makeSetup(dir1);
        s1.options.syncHook = async () => {
            syncCount1 += 1;
            // syncCount1 === 1 is initial 'registered' event; syncCount1 === 2 is 'received'
            if (syncCount1 === 2) {
                throw new Error('Simulated sync failure on received');
            }
        };
        const relay1 = await createDiscussionRelay(s1.options);
        await assert.rejects(relay1.receive(s1.q1), { code: 'JOURNAL_INVALID' });
        assert.equal(s1.getInvokeCalls(), 0);
        assert.equal((await relay1.inspect()).messages.length, 0);
        await assert.rejects(relay1.close(), { code: 'JOURNAL_INVALID' });
        assert.equal(fs.existsSync(path.join(dir1, 'owner.lock')), true);

        // 2. intent-before-invoke sync failure
        const dir2 = path.join(tempRoot, 'b2');
        let syncCount2 = 0;
        const s2 = makeSetup(dir2);
        s2.options.syncHook = async () => {
            syncCount2 += 1;
            // 1: registered, 2: received, 3: dispatch_intent
            if (syncCount2 === 3) {
                throw new Error('Simulated sync failure on dispatch_intent');
            }
        };
        const relay2 = await createDiscussionRelay(s2.options);
        await relay2.receive(s2.q1);
        await assert.rejects(relay2.dispatch('q-1'), { code: 'JOURNAL_INVALID' });
        assert.equal(s2.getInvokeCalls(), 0);
        await assert.rejects(relay2.close(), { code: 'JOURNAL_INVALID' });
        assert.equal(fs.existsSync(path.join(dir2, 'owner.lock')), true);
    });

    it('Boundary 3 & 4 (R12, R14, R16): invoke-before-observation and observation-before-response sync failures fail closed into blocked state and never publish response', async () => {
        // 3. observation write/sync failure after invoke succeeded
        const dir3 = path.join(tempRoot, 'b3');
        let syncCount3 = 0;
        const s3 = makeSetup(dir3);
        s3.options.syncHook = async () => {
            syncCount3 += 1;
            // 1: registered, 2: received, 3: dispatch_intent, 4: observation
            if (syncCount3 === 4) {
                throw new Error('Simulated sync failure on observation');
            }
        };
        const relay3 = await createDiscussionRelay(s3.options);
        await relay3.receive(s3.q1);
        await assert.rejects(relay3.dispatch('q-1'), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(s3.getInvokeCalls(), 1);
        const view3 = await relay3.inspect();
        assert.equal(view3.blocked, true);
        assert.equal(view3.turns[0].provider, 'outcome_unknown');
        assert.equal(view3.turns[0].discussion_result, 'none');
        assert.equal(view3.turns[0].response_message_id, null);
        await assert.rejects(relay3.close(), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(fs.existsSync(path.join(dir3, 'owner.lock')), true);

        // 4. response write/sync failure after observation succeeded
        const dir4 = path.join(tempRoot, 'b4');
        let syncCount4 = 0;
        const s4 = makeSetup(dir4);
        s4.options.syncHook = async () => {
            syncCount4 += 1;
            // 1: registered, 2: received, 3: dispatch_intent, 4: observation, 5: response
            if (syncCount4 === 5) {
                throw new Error('Simulated sync failure on response');
            }
        };
        const relay4 = await createDiscussionRelay(s4.options);
        await relay4.receive(s4.q1);
        await assert.rejects(relay4.dispatch('q-1'), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(s4.getInvokeCalls(), 1);
        const view4 = await relay4.inspect();
        assert.equal(view4.blocked, true);
        assert.equal(view4.turns[0].discussion_result, 'none');
        assert.equal(view4.turns[0].response_message_id, null);
        assert.equal(view4.messages.length, 1);
        await assert.rejects(relay4.close(), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(fs.existsSync(path.join(dir4, 'owner.lock')), true);
    });

    it('Boundary 5 & R16 & R17: timeout/unknown blocks relay, ignores late completion, retains lock on close, and requires two-layer identity-bound evidence to reconcile', async () => {
        const dir5 = path.join(tempRoot, 'b5');
        const s5 = makeSetup(dir5);
        s5.options.limits = { timeoutMs: 25 };

        let resolveLate;
        const lateGate = new Promise((resolve) => {
            resolveLate = resolve;
        });
        s5.setCustomAgyInvoke(async ({ binding, invocationId }) => {
            await lateGate;
            return {
                exitCode: 0,
                stdout: JSON.stringify({
                    terminal: 'fixture.completed',
                    conversation_id: binding.conversation_id,
                    invocation_id: invocationId,
                    payload: { schema_version: 1, kind: 'reply', body: 'Late reply after timeout' },
                }),
                stderr: '',
            };
        });

        const relay = await createDiscussionRelay(s5.options);
        await relay.receive(s5.q1);

        await assert.rejects(relay.dispatch('q-1'), { code: 'OUTCOME_UNKNOWN' });
        const invokeCalls = s5.getInvokeCalls();
        const nextMessageId = 'q-next';

        // Required minimum assertions from plan Task 5
        assert.equal((await relay.inspect()).blocked, true);
        await assert.rejects(relay.dispatch(nextMessageId), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(invokeCalls, 1);

        // Late completion resolves now: must NOT unblock relay or publish response
        resolveLate();
        await new Promise((r) => setTimeout(r, 15));
        const afterLate = await relay.inspect();
        assert.equal(afterLate.blocked, true);
        assert.equal(afterLate.messages.length, 1);
        assert.equal(afterLate.turns[0].response_message_id, null);

        // Partial recovery evidence (processQuiescent only, providerTerminal false) keeps relay blocked
        const origVerifyRec = s5.options.capabilityVerifier.verifyRecovery;
        s5.options.capabilityVerifier.verifyRecovery = async (args) => ({
            ...(await origVerifyRec(args)),
            providerTerminal: false,
        });
        await assert.rejects(relay.reconcile('q-1', {}), { code: 'OUTCOME_UNKNOWN' });
        assert.equal((await relay.inspect()).blocked, true);

        // Process false, providerTerminal true -> keeps blocked
        s5.options.capabilityVerifier.verifyRecovery = async (args) => ({
            ...(await origVerifyRec(args)),
            processQuiescent: false,
        });
        await assert.rejects(relay.reconcile('q-1', {}), { code: 'OUTCOME_UNKNOWN' });

        // Mismatched invocationId -> keeps blocked
        s5.options.capabilityVerifier.verifyRecovery = async (args) => ({
            ...(await origVerifyRec(args)),
            invocationId: 'inv-wrong',
        });
        await assert.rejects(relay.reconcile('q-1', {}), { code: 'OUTCOME_UNKNOWN' });

        // Stale authority during recovery -> keeps blocked
        s5.options.capabilityVerifier.verifyRecovery = origVerifyRec;
        s5.options.authority.check = async ({ stage }) => stage !== 'recovery';
        await assert.rejects(relay.reconcile('q-1', {}), { code: 'AUTHORITY_STALE' });
        assert.equal((await relay.inspect()).blocked, true);

        // Close while unknown rejects with OUTCOME_UNKNOWN and retains owner.lock
        await assert.rejects(relay.close(), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(fs.existsSync(path.join(dir5, 'owner.lock')), true);

        // Controller crash / retained lock prevents new relay open with OWNER_BUSY
        await assert.rejects(createDiscussionRelay(s5.options), { code: 'OWNER_BUSY' });
    });

    it('R14, R17, R19: full reconciliation under live owner unlocks new explicit dispatch without re-running old invocation, and reopen verifies registration correlation', async () => {
        const dir6 = path.join(tempRoot, 'b6');
        const s6 = makeSetup(dir6);

        let failFirst = true;
        s6.setCustomAgyInvoke(async ({ binding, invocationId }) => {
            if (failFirst) {
                failFirst = false;
                throw new Error('Simulated transport crash after intent');
            }
            return {
                exitCode: 0,
                stdout: JSON.stringify({
                    terminal: 'fixture.completed',
                    conversation_id: binding.conversation_id,
                    invocation_id: invocationId,
                    payload: { schema_version: 1, kind: 'reply', body: 'Recovered reply' },
                }),
                stderr: '',
            };
        });

        const relay = await createDiscussionRelay(s6.options);
        await relay.receive(s6.q1);
        await assert.rejects(relay.dispatch('q-1'), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(s6.getInvokeCalls(), 1);

        // Reconcile with both processQuiescent and providerTerminal verified
        let observedRecoveryEvidence = null;
        const origVerifyRecovery = s6.options.capabilityVerifier.verifyRecovery;
        s6.options.capabilityVerifier.verifyRecovery = async (args) => {
            observedRecoveryEvidence = args.evidence;
            return origVerifyRecovery(args);
        };
        const mutableRecoveryEvidence = {
            operatorNote: 'verified process dead and provider settled',
            nested: { status: 'quiescent' },
        };
        const pendingReconcile = relay.reconcile('q-1', mutableRecoveryEvidence);
        mutableRecoveryEvidence.operatorNote = 'mutated-after-call';
        mutableRecoveryEvidence.nested.status = 'mutated-nested-after-call';
        const recTurn = await pendingReconcile;
        assert.equal(observedRecoveryEvidence.operatorNote, 'verified process dead and provider settled');
        assert.equal(observedRecoveryEvidence.nested.status, 'quiescent');
        assert.equal(recTurn.reconciled, true);
        assert.equal(recTurn.reconciled_outcome, 'failed');
        assert.equal(recTurn.discussion_result, 'none');
        assert.equal((await relay.inspect()).blocked, false);
        // Reconcile did NOT re-invoke the old turn
        assert.equal(s6.getInvokeCalls(), 1);
        // Calling dispatch('q-1') again returns stored reconciled view without re-invoking
        const afterRecDispatchSame = await relay.dispatch('q-1');
        assert.equal(afterRecDispatchSame.reconciled, true);
        assert.equal(s6.getInvokeCalls(), 1);

        await relay.close();
        assert.equal(fs.existsSync(path.join(dir6, 'owner.lock')), false);

        // Reopen with mismatched binding (changed plan_revision) fails with CORRELATION_INVALID and releases lock
        const mismatchedOptions = {
            ...s6.options,
            bindings: [
                { ...s6.astra, plan_revision: 2 },
                { ...s6.argon, plan_revision: 2 },
            ],
        };
        await assert.rejects(createDiscussionRelay(mismatchedOptions), { code: 'CORRELATION_INVALID' });
        assert.equal(fs.existsSync(path.join(dir6, 'owner.lock')), false);

        // Simulate journal where observation (succeeded/valid) was written before crash without response event:
        // reopening must preserve response/completion separation (no implicit response synthesis, starts blocked)
        const dir7 = path.join(tempRoot, 'b7');
        let syncCount7 = 0;
        const s7 = makeSetup(dir7);
        s7.options.syncHook = async () => {
            syncCount7 += 1;
            if (syncCount7 === 5) {
                throw new Error('Crash before response write completes');
            }
        };
        const relay7 = await createDiscussionRelay(s7.options);
        await relay7.receive(s7.q1);
        await assert.rejects(relay7.dispatch('q-1'), { code: 'OUTCOME_UNKNOWN' });
        await assert.rejects(relay7.close(), { code: 'OUTCOME_UNKNOWN' });

        // Remove lock only in test fixture to test journal replay of observation-without-response
        await fsp.unlink(path.join(dir7, 'owner.lock'));
        delete s7.options.syncHook;
        const relay7Reopened = await createDiscussionRelay(s7.options);
        const view7 = await relay7Reopened.inspect();
        assert.equal(view7.blocked, true);
        assert.equal(view7.turns[0].provider, 'succeeded');
        assert.equal(view7.turns[0].schema, 'valid');
        assert.equal(view7.turns[0].discussion_result, 'none');
        assert.equal(view7.turns[0].response_message_id, null);
        assert.equal(view7.messages.length, 1);
        await assert.rejects(relay7Reopened.close(), { code: 'OUTCOME_UNKNOWN' });
    });
});
