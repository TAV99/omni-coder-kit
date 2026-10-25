'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    CEILINGS,
    DiscussionError,
    resolveLimits,
    validateBinding,
    bindingRef,
    validateBindingPair,
    validateSnapshot,
    validatePayload,
    validateEnvelope,
} = require('../lib/dual/discussion/contracts');

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const SNAPSHOT_TEXT = 'function add(a, b) { return a + b; }\n';
const SNAPSHOT_HASH = sha256(SNAPSHOT_TEXT);
const WORKSPACE_HASH = 'a'.repeat(64);

function makeBindings() {
    const astra = {
        schema_version: 1,
        provider: 'codex',
        model: 'gpt-6-astra-medium',
        effort: 'medium',
        conversation_id: '01a15d65-b02d-7272-adf9-f890526e1d08',
        role: 'astra',
        session_id: 'dual-session-01',
        task_id: 'TASK-01',
        plan_revision: 1,
        snapshot_sha256: SNAPSHOT_HASH,
        execution: {
            attempt: 1,
            workspace_binding_sha256: WORKSPACE_HASH,
        },
    };
    const argon = {
        schema_version: 1,
        provider: 'agy',
        model: 'gemini-4-argon-medium',
        effort: 'medium',
        conversation_id: 'a2d46b6b-f54b-45be-82bb-e0380cdd37d1',
        role: 'argon',
        session_id: 'dual-session-01',
        task_id: 'TASK-01',
        plan_revision: 1,
        snapshot_sha256: SNAPSHOT_HASH,
        execution: {
            attempt: 1,
            workspace_binding_sha256: WORKSPACE_HASH,
        },
    };
    return { astra, argon };
}

describe('dual discussion contracts (Task 1: R03-R07, R18, R21)', () => {
    it('R03: validates binding with and without execution and computes deterministic bindingRef', () => {
        const { astra } = makeBindings();
        const validated = validateBinding(astra);
        assert.equal(validated.role, 'astra');
        assert.equal(Object.isFrozen(validated), true);
        assert.equal(Object.isFrozen(validated.execution), true);

        const ref1 = bindingRef(astra);
        assert.match(ref1, /^[0-9a-f]{64}$/);

        // Caller mutation after validation does not alter validated object or ref
        const mutated = structuredClone(astra);
        const refBefore = bindingRef(mutated);
        mutated.plan_revision = 2;
        assert.NotEqual?.(bindingRef(mutated), refBefore);
        assert.notEqual(bindingRef(mutated), refBefore);

        // Without execution (no fabricated attempt for chat)
        const noExec = { ...astra };
        delete noExec.execution;
        const validatedNoExec = validateBinding(noExec);
        assert.equal(validatedNoExec.execution, undefined);
        assert.notEqual(bindingRef(noExec), ref1);

        // Changing any single identity field changes bindingRef
        for (const [key, nextVal] of [
            ['provider', 'codex-v2'],
            ['model', 'gpt-6-other'],
            ['effort', 'high'],
            ['conversation_id', 'conv-2'],
            ['role', 'argon'],
            ['session_id', 'dual-session-02'],
            ['task_id', 'TASK-02'],
            ['plan_revision', 2],
            ['snapshot_sha256', 'b'.repeat(64)],
        ]) {
            const copy = { ...astra, [key]: nextVal };
            assert.notEqual(bindingRef(copy), ref1, `Expected ref to change when ${key} changes`);
        }
        const copyExecAttempt = {
            ...astra,
            execution: { ...astra.execution, attempt: 2 },
        };
        assert.notEqual(bindingRef(copyExecAttempt), ref1);

        // Reject partial execution or caller-supplied binding_ref
        assert.throws(
            () => validateBinding({ ...astra, execution: { attempt: 1 } }),
            { code: 'INVALID_INPUT' },
        );
        assert.throws(
            () => validateBinding({ ...astra, binding_ref: 'c'.repeat(64) }),
            { code: 'INVALID_INPUT' },
        );
    });

    it('R04: validates scoped snapshot and enforces 65536 UTF-8 byte ceiling and hash match', () => {
        const snap = validateSnapshot({ text: SNAPSHOT_TEXT, sha256: SNAPSHOT_HASH });
        assert.equal(snap.sha256, SNAPSHOT_HASH);
        assert.equal(Object.isFrozen(snap), true);

        assert.throws(
            () => validateSnapshot({ text: SNAPSHOT_TEXT, sha256: '0'.repeat(64) }),
            { code: 'CORRELATION_INVALID' },
        );

        const oversized = 'a'.repeat(65537);
        assert.throws(
            () => validateSnapshot({ text: oversized, sha256: sha256(oversized) }),
            { code: 'LIMIT_EXCEEDED' },
        );

        assert.throws(
            () => validateSnapshot({ text: 'bad\u0000text', sha256: sha256('bad\u0000text') }),
            { code: 'INVALID_INPUT' },
        );
    });

    it('R05 & R18: enforces strict schema validation and UTF-8 byte ceiling including Vietnamese characters', () => {
        assert.throws(
            () => validatePayload({ schema_version: 1, kind: 'reply', body: 'ế'.repeat(6000) }, { maxBodyBytes: 16384 }),
            { code: 'LIMIT_EXCEEDED' },
        );

        // Exact boundary 16384 bytes passes
        const exactBody = 'a'.repeat(16384);
        const valid = validatePayload({ schema_version: 1, kind: 'question', body: exactBody });
        assert.equal(valid.body.length, 16384);

        // Reject unknown fields, wrong version, NUL byte, non-plain prototype, NaN
        assert.throws(
            () => validatePayload({ schema_version: 2, kind: 'reply', body: 'ok' }),
            { code: 'INVALID_INPUT' },
        );
        assert.throws(
            () => validatePayload({ schema_version: 1, kind: 'reply', body: 'ok', extra: true }),
            { code: 'INVALID_INPUT' },
        );
        assert.throws(
            () => validatePayload({ schema_version: 1, kind: 'reply', body: 'hello\u0000world' }),
            { code: 'INVALID_INPUT' },
        );
        class CustomProto {}
        const badProto = new CustomProto();
        badProto.schema_version = 1;
        badProto.kind = 'reply';
        badProto.body = 'ok';
        assert.throws(() => validatePayload(badProto), { code: 'INVALID_INPUT' });

        // Limits ceiling cannot be increased by caller (ceiling is now 24, not 12:
        // this is an intentional, approved behaviour change — see relay-ceiling
        // commit message. 13 is allowed; 25 still throws LIMIT_EXCEEDED.)
        assert.equal(CEILINGS.maxInvocations, 24);
        assert.equal(CEILINGS.maxTurns, 24);
        assert.equal(resolveLimits({ maxInvocations: 13 }).maxInvocations, 13);
        assert.equal(resolveLimits({ maxInvocations: 13 }).maxTurns, 13);
        assert.equal(resolveLimits({ maxTurns: 24 }).maxInvocations, 24);
        assert.throws(() => resolveLimits({ maxInvocations: 25 }), { code: 'LIMIT_EXCEEDED' });
        assert.throws(() => resolveLimits({ maxTurns: 25 }), { code: 'LIMIT_EXCEEDED' });
        assert.throws(() => resolveLimits({ maxBodyBytes: 16385 }), { code: 'LIMIT_EXCEEDED' });
        assert.throws(() => resolveLimits({ maxEvents: 257 }), { code: 'LIMIT_EXCEEDED' });
        assert.throws(() => resolveLimits({ maxJournalBytes: 8 * 1024 * 1024 + 1 }), { code: 'LIMIT_EXCEEDED' });
        assert.throws(() => resolveLimits({ ttlMs: 900001 }), { code: 'LIMIT_EXCEEDED' });
    });

    it('accepts mirrored follow-up questions after replies but rejects consecutive questions', () => {
        const { astra, argon } = makeBindings();
        const now = 1_700_000_000_000;
        for (const [sender, recipient] of [[astra, argon], [argon, astra]]) {
            const context = { bindings: [astra, argon], messages: [], now };
            const q1 = validateEnvelope({
                schema_version: 1,
                message_id: 'q-1',
                sender_ref: bindingRef(sender),
                recipient_ref: bindingRef(recipient),
                sequence: 1,
                kind: 'question',
                body: 'Initial question',
                created_at: now,
                expires_at: now + 60_000,
            }, context);
            const mirrored = {
                ...q1,
                message_id: 'q-2',
                sender_ref: q1.recipient_ref,
                recipient_ref: q1.sender_ref,
                binding_ref: q1.sender_ref,
                sequence: 2,
            };
            assert.throws(
                () => validateEnvelope(mirrored, { ...context, messages: [q1] }),
                { code: 'CORRELATION_INVALID' },
            );
            const r1 = validateEnvelope({
                ...mirrored, message_id: 'r-1', kind: 'reply', reply_to: q1.message_id,
            }, { ...context, messages: [q1] });
            const q2 = validateEnvelope({ ...mirrored, sequence: 3 }, {
                ...context, messages: [q1, r1],
            });
            assert.equal(q2.sender_ref, r1.sender_ref);
            assert.equal(q2.recipient_ref, r1.recipient_ref);
            assert.throws(
                () => validateEnvelope({ ...q1, message_id: 'q-3', sequence: 4 }, {
                    ...context, messages: [q1, r1, q2],
                }),
                { code: 'CORRELATION_INVALID' },
            );
        }
    });

    it('R06 & R07 & R21: validates envelope correlation, idempotent receipt vs conflict, and rejects lease/flag fields', () => {
        const { astra, argon } = makeBindings();
        const refA = bindingRef(astra);
        const refB = bindingRef(argon);
        const now = 1_700_000_000_000;

        const q1Input = {
            schema_version: 1,
            message_id: 'msg-1',
            sender_ref: refA,
            recipient_ref: refB,
            sequence: 1,
            kind: 'question',
            body: 'Question 1: Cần làm rõ biên giới dữ liệu?',
            created_at: now,
            expires_at: now + 60_000,
        };

        const q1 = validateEnvelope(q1Input, {
            bindings: [astra, argon],
            messages: [],
            nextSequence: 1,
            now,
        });
        assert.equal(q1.binding_ref, refB);
        assert.equal(q1.payload_hash, sha256(q1Input.body));
        assert.equal(q1.reused, false);

        // Duplicate identical envelope is acknowledged as reused without consuming sequence
        const q1Dup = validateEnvelope(q1Input, {
            bindings: [astra, argon],
            messages: [q1],
            nextSequence: 2,
            now,
        });
        assert.equal(q1Dup.reused, true);
        assert.equal(q1Dup.message_id, 'msg-1');

        // Duplicate message_id with any modified field throws MESSAGE_CONFLICT
        for (const override of [
            { body: 'Different body' },
            { expires_at: now + 120_000 },
            { sender_ref: refB, recipient_ref: refA },
        ]) {
            assert.throws(
                () => validateEnvelope({ ...q1Input, ...override }, {
                    bindings: [astra, argon],
                    messages: [q1],
                    nextSequence: 2,
                    now,
                }),
                { code: 'MESSAGE_CONFLICT' },
            );
        }

        // Valid reply to q1
        const r1Input = {
            schema_version: 1,
            message_id: 'msg-2',
            sender_ref: refB,
            recipient_ref: refA,
            sequence: 2,
            kind: 'reply',
            body: 'Reply 1: Đã rõ.',
            reply_to: 'msg-1',
            created_at: now + 1000,
            expires_at: now + 61_000,
        };
        const r1 = validateEnvelope(r1Input, {
            bindings: [astra, argon],
            messages: [q1],
            nextSequence: 2,
            now: now + 1000,
        });
        assert.equal(r1.reply_to, 'msg-1');

        // Second reply to same question is rejected
        assert.throws(
            () => validateEnvelope({ ...r1Input, message_id: 'msg-3', sequence: 3 }, {
                bindings: [astra, argon],
                messages: [q1, r1],
                nextSequence: 3,
                now: now + 2000,
            }),
            { code: 'CORRELATION_INVALID' },
        );

        // Question carrying reply_to is rejected
        assert.throws(
            () => validateEnvelope({
                schema_version: 1,
                message_id: 'msg-3',
                sender_ref: refA,
                recipient_ref: refB,
                sequence: 3,
                kind: 'question',
                body: 'Follow-up question',
                reply_to: 'msg-2',
                created_at: now + 2000,
                expires_at: now + 62_000,
            }, {
                bindings: [astra, argon],
                messages: [q1, r1],
                nextSequence: 3,
                now: now + 2000,
            }),
            { code: 'CORRELATION_INVALID' },
        );

        // Cross-task participant pair is rejected
        assert.throws(
            () => validateBindingPair([astra, { ...argon, task_id: 'TASK-OTHER' }], SNAPSHOT_HASH),
            { code: 'CORRELATION_INVALID' },
        );

        // R21: Envelope cannot carry lease_id or CLI flags
        assert.throws(
            () => validateEnvelope({ ...q1Input, message_id: 'msg-lease', lease_id: '1234' }, {
                bindings: [astra, argon],
                messages: [],
                nextSequence: 1,
                now,
            }),
            { code: 'INVALID_INPUT' },
        );
    });
});
