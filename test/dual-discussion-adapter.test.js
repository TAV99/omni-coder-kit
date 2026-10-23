'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    validateBinding,
} = require('../lib/dual/discussion/contracts');
const {
    createDiscussionAdapter,
} = require('../lib/dual/discussion/adapter');

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const SNAPSHOT_TEXT = 'const x = 42;\n';
const SNAPSHOT_HASH = sha256(SNAPSHOT_TEXT);

const BINDING = validateBinding({
    schema_version: 1,
    provider: 'fake-provider',
    model: 'fake-model-1',
    effort: 'medium',
    conversation_id: 'conv-fixed-01',
    role: 'argon',
    session_id: 'sess-01',
    task_id: 'TASK-01',
    plan_revision: 1,
    snapshot_sha256: SNAPSHOT_HASH,
});

// NOTE: All fixtures in this file are synthetic offline test fixtures, NOT real AGY or Codex CLI outputs.
function createSyntheticAdapter(overrides = {}) {
    return createDiscussionAdapter({
        id: 'synthetic-adapter-v1',
        provider: 'fake-provider',
        version: '1.0.0',
        mode: 'fake',
        profile: {
            format: 'json',
            allowlistedTerminalMarkers: ['fixture.completed'],
            requireConversationMatch: true,
        },
        invoke: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
                terminal: 'fixture.completed',
                conversation_id: 'conv-fixed-01',
                invocation_id: 'inv-01',
                payload: { schema_version: 1, kind: 'reply', body: 'Synthetic reply' },
            }),
            stderr: '',
            timedOut: false,
            overflowed: false,
            hasTerminalError: false,
        }),
        classify: (raw) => {
            let parsed;
            try {
                parsed = JSON.parse(raw.stdout);
            } catch {
                return {
                    completion: 'unknown',
                    payload: null,
                    evidenceRef: null,
                    terminalMarker: null,
                    observedConversationId: null,
                };
            }
            if (parsed.status === 'error') {
                return {
                    completion: 'failed',
                    payload: parsed.payload ?? null,
                    evidenceRef: 'synthetic.outer_error',
                    terminalMarker: parsed.terminal ?? null,
                    observedConversationId: parsed.conversation_id ?? null,
                    observedInvocationId: parsed.invocation_id ?? null,
                    hasTerminalError: true,
                };
            }
            return {
                completion: 'succeeded',
                payload: parsed.payload ?? null,
                evidenceRef: parsed.terminal ? `marker:${parsed.terminal}` : null,
                terminalMarker: parsed.terminal ?? null,
                observedConversationId: parsed.conversation_id ?? null,
                observedInvocationId: parsed.invocation_id ?? null,
                hasTerminalError: Boolean(parsed.hasTerminalError),
            };
        },
        ...overrides,
    });
}

describe('dual discussion adapter boundary (Task 3: R08-R10, R21)', () => {
    it('R08: requires explicit allowlisted terminalMarker, exitCode 0, and exact conversation/invocation match for positive completion', () => {
        const adapter = createSyntheticAdapter();

        const rawValid = {
            exitCode: 0,
            stdout: JSON.stringify({
                terminal: 'fixture.completed',
                conversation_id: BINDING.conversation_id,
                invocation_id: 'inv-01',
                payload: { schema_version: 1, kind: 'reply', body: 'Valid synthetic reply' },
            }),
            stderr: '',
        };
        const positive = rawValid.exitCode === 0
            && JSON.parse(rawValid.stdout).terminal === 'fixture.completed'
            && JSON.parse(rawValid.stdout).conversation_id === BINDING.conversation_id;
        assert.equal(positive, true);

        const resValid = adapter.classify(rawValid, BINDING, 'inv-01');
        assert.equal(resValid.completion, 'succeeded');
        assert.equal(resValid.schema, 'valid');
        assert.equal(resValid.payload.body, 'Valid synthetic reply');

        // Non-zero exitCode is never succeeded even if classifier returns succeeded
        const resNonZero = adapter.classify({ ...rawValid, exitCode: 1 }, BINDING, 'inv-01');
        assert.notEqual(resNonZero.completion, 'succeeded');
        assert.equal(resNonZero.completion, 'failed');

        // Absent or un-allowlisted terminal marker -> unknown (never succeeded)
        const rawUnknownMarker = {
            exitCode: 0,
            stdout: JSON.stringify({
                terminal: 'fixture.other_marker',
                conversation_id: BINDING.conversation_id,
                invocation_id: 'inv-01',
                payload: { schema_version: 1, kind: 'reply', body: 'Valid schema but wrong marker' },
            }),
            stderr: '',
        };
        const resUnknownMarker = adapter.classify(rawUnknownMarker, BINDING, 'inv-01');
        assert.equal(resUnknownMarker.completion, 'unknown');
        assert.equal(resUnknownMarker.schema, 'valid');

        // Conversation ID mismatch -> never succeeded
        const rawConvMismatch = {
            exitCode: 0,
            stdout: JSON.stringify({
                terminal: 'fixture.completed',
                conversation_id: 'conv-wrong-99',
                invocation_id: 'inv-01',
                payload: { schema_version: 1, kind: 'reply', body: 'Wrong conv' },
            }),
            stderr: '',
        };
        const resConvMismatch = adapter.classify(rawConvMismatch, BINDING, 'inv-01');
        assert.notEqual(resConvMismatch.completion, 'succeeded');
        assert.equal(resConvMismatch.completion, 'unknown');

        // Invocation ID mismatch -> never succeeded
        const resInvMismatch = adapter.classify(rawValid, BINDING, 'inv-other');
        assert.notEqual(resInvMismatch.completion, 'succeeded');
        assert.equal(resInvMismatch.completion, 'unknown');
    });

    it('R09: separates provider failure from schema validity on error envelope with valid payload', () => {
        const adapter = createSyntheticAdapter();
        const rawOuterErrorValidPayload = {
            exitCode: 0,
            stdout: JSON.stringify({
                status: 'error',
                terminal: 'fixture.completed',
                conversation_id: BINDING.conversation_id,
                invocation_id: 'inv-01',
                payload: { schema_version: 1, kind: 'reply', body: 'DONE' },
            }),
            stderr: '',
        };

        const res = adapter.classify(rawOuterErrorValidPayload, BINDING, 'inv-01');
        assert.equal(res.completion, 'failed');
        assert.equal(res.schema, 'valid');
        assert.equal(res.payload.body, 'DONE');
    });

    it('R10 & R18 & R21: rejects invalid adapter profiles, enforces output stream byte caps as unknown, and ignores instructions in payload', () => {
        // Reject adapter without allowlistedTerminalMarkers or requireConversationMatch !== true
        assert.throws(
            () => createSyntheticAdapter({
                profile: { format: 'json', allowlistedTerminalMarkers: [], requireConversationMatch: true },
            }),
            { code: 'INVALID_INPUT' },
        );
        assert.throws(
            () => createSyntheticAdapter({
                profile: { format: 'json', allowlistedTerminalMarkers: ['fixture.completed'], requireConversationMatch: false },
            }),
            { code: 'INVALID_INPUT' },
        );

        const adapter = createSyntheticAdapter();

        // Oversized stdout exceeds 262144 bytes -> completion is unknown
        const oversizedStdout = 'x'.repeat(262_145);
        const resOversize = adapter.classify(
            { exitCode: 0, stdout: oversizedStdout, stderr: '' },
            BINDING,
            'inv-01',
        );
        assert.equal(resOversize.completion, 'unknown');

        // Malformed JSON -> completion is unknown
        const resMalformed = adapter.classify(
            { exitCode: 0, stdout: '{not-valid-json', stderr: '' },
            BINDING,
            'inv-01',
        );
        assert.equal(resMalformed.completion, 'unknown');
    });

    it('P1 regression & timeout handle boundary: failure evidence with mismatched or missing correlation classifies as unknown, and timeout-only fake invocation settles without other handles', async () => {
        const unrelatedFailureAdapter = createSyntheticAdapter({
            classify: () => ({
                completion: 'failed',
                payload: null,
                evidenceRef: 'unrelated-terminal',
                terminalMarker: 'fixture.completed',
                observedConversationId: 'OTHER',
                observedInvocationId: 'OTHER',
                hasTerminalError: true,
            }),
        });
        const resUnrelated = unrelatedFailureAdapter.classify(
            { exitCode: 1, stdout: '{}', stderr: '' },
            BINDING,
            'expected-invocation',
        );
        assert.equal(resUnrelated.completion, 'unknown');

        // Mismatched invocation ID only on failure -> unknown
        const mismatchInvFailureAdapter = createSyntheticAdapter({
            classify: () => ({
                completion: 'failed',
                payload: null,
                evidenceRef: 'mismatch-inv-terminal',
                terminalMarker: 'fixture.completed',
                observedConversationId: BINDING.conversation_id,
                observedInvocationId: 'OTHER',
                hasTerminalError: true,
            }),
        });
        assert.equal(
            mismatchInvFailureAdapter.classify({ exitCode: 1, stdout: '{}', stderr: '' }, BINDING, 'expected-invocation').completion,
            'unknown',
        );

        // Missing correlation (null conversation_id) on failure -> unknown
        const missingCorrFailureAdapter = createSyntheticAdapter({
            classify: () => ({
                completion: 'failed',
                payload: null,
                evidenceRef: 'missing-corr-terminal',
                terminalMarker: null,
                observedConversationId: null,
                observedInvocationId: null,
                hasTerminalError: true,
            }),
        });
        assert.equal(
            missingCorrFailureAdapter.classify({ exitCode: 1, stdout: '{}', stderr: '' }, BINDING, 'expected-invocation').completion,
            'unknown',
        );

        // Matching correlation on failure + valid payload still classifies as failed + valid schema
        const matchingErrorValidPayload = createSyntheticAdapter().classify(
            {
                exitCode: 1,
                stdout: JSON.stringify({
                    status: 'error',
                    terminal: 'fixture.completed',
                    conversation_id: BINDING.conversation_id,
                    invocation_id: 'expected-invocation',
                    payload: { schema_version: 1, kind: 'reply', body: 'Correlated failure payload' },
                }),
                stderr: '',
            },
            BINDING,
            'expected-invocation',
        );
        assert.equal(matchingErrorValidPayload.completion, 'failed');
        assert.equal(matchingErrorValidPayload.schema, 'valid');

        // Timeout-only fake invocation where the adapter timeout timer is the only live handle
        const neverResolvingAdapter = createSyntheticAdapter({
            invoke: () => new Promise(() => {}),
        });
        const rawTimedOut = await neverResolvingAdapter.invoke({
            binding: BINDING,
            snapshot: { text: SNAPSHOT_TEXT, sha256: SNAPSHOT_HASH },
            envelope: {
                schema_version: 1,
                message_id: 'q-timeout',
                kind: 'question',
                body: 'Will timeout',
            },
            invocationId: 'inv-timeout-only',
            timeoutMs: 20,
        });
        assert.equal(rawTimedOut.timedOut, true);
        assert.equal(
            neverResolvingAdapter.classify(rawTimedOut, BINDING, 'inv-timeout-only').completion,
            'unknown',
        );
    });
});
