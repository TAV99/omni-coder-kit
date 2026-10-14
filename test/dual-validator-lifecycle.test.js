'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAuthorityStore, computeEventHash } = require('../lib/dual/authority-store');
const validatorLifecycleApi = require('../lib/dual/validator-lifecycle');
const { createValidatorLifecycleWriter } = require('../lib/dual/validator-lifecycle-writer');
const {
    inspectValidatorRun,
    assertValidatorRunAuthorized,
} = require('../lib/dual/validator-lifecycle');

function beginRun({ authorityStore, ...binding }) {
    return createValidatorLifecycleWriter(authorityStore).begin(binding);
}

function settleRun({ authorityStore, capability, ownedResult, resultAnchor }) {
    return createValidatorLifecycleWriter(authorityStore).settle({ capability, ownedResult, resultAnchor });
}

function fixture(t, options = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-validator-lifecycle-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const authorityDir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(authorityDir, options);
    store.append({
        schema_version: 2,
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: root,
        workspace_id: 'ws-1',
        session_id: 'session-1',
        plan_revision: 1,
        expected_baseline: { kind: 'snapshot', id: 'a'.repeat(64) },
        mode: 'auto',
    });
    store.append({
        schema_version: 2,
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'fixture', status: 'PASSED' }],
    });
    return { root, authorityDir, store };
}

function makeBinding(overrides = {}) {
    return {
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        planRevision: 1,
        baselineId: 'a'.repeat(64),
        baselineKind: 'snapshot',
        sourceFingerprint: 'f'.repeat(64),
        purpose: 'quality',
        commandPolicyDigest: 'c'.repeat(64),
        runId: crypto.randomUUID(),
        cycle: 1,
        attempt: 1,
        ...overrides,
    };
}

function makeOwnedResult(runId, overrides = {}) {
    return {
        runId,
        purpose: 'quality',
        commandIndex: 0,
        exitCode: 0,
        signal: null,
        failure: null,
        durationMs: 150,
        stdoutBytes: 10,
        stderrBytes: 0,
        stdoutSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        stderrSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        outputSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        stdoutSummary: 'ok\n',
        stderrSummary: '',
        stdoutSummaryTruncated: false,
        stderrSummaryTruncated: false,
        outputTruncated: false,
        stdoutComplete: true,
        stderrComplete: true,
        outputComplete: true,
        cancellationCode: null,
        cleanupVerified: true,
        activeOwnedProcesses: 0,
        ownership: 'windows-job',
        ...overrides,
    };
}

test('session-validator lifecycle persists active intent and settlement across authority restart', (t) => {
    const { authorityDir, store } = fixture(t);
    const binding = makeBinding();
    const runId = binding.runId;

    const handle = beginRun({ authorityStore: store, ...binding });
    assert.equal(handle.runId, runId);
    assert.equal(handle.active, true);
    assert.equal(handle.settled, false);

    assert.deepEqual(inspectValidatorRun({ authorityStore: store, runId }), {
        runId,
        active: true,
        settled: false,
        outcome: null,
        purpose: 'quality',
    });

    const ownedResult = makeOwnedResult(runId);
    const settled = settleRun({
        authorityStore: store,
        capability: handle.capability,
        ownedResult,
        resultAnchor: { digest: 'd'.repeat(64) },
    });

    assert.equal(settled.active, false);
    assert.equal(settled.settled, true);
    assert.equal(settled.outcome, 'passed');

    const reopened = createAuthorityStore(authorityDir);
    assert.deepEqual(inspectValidatorRun({ authorityStore: reopened, runId }), {
        runId,
        active: false,
        settled: true,
        outcome: 'passed',
        purpose: 'quality',
    });
});

test('validator lifecycle rejects second conflicting active run and allows coalescing exact same in-process run', (t) => {
    const { store } = fixture(t);
    const firstBinding = makeBinding();
    const handle1 = beginRun({ authorityStore: store, ...firstBinding });

    // Exact same in-process begin returns coalesced handle without authorizing duplicate spawn
    const handleCoalesced = beginRun({ authorityStore: store, ...firstBinding });
    assert.equal(handleCoalesced.runId, handle1.runId);
    assert.equal(handleCoalesced.coalesced, true);

    // Conflicting begin with different runId is rejected while an active run exists
    const secondBinding = makeBinding({ runId: crypto.randomUUID() });
    assert.throws(
        () => beginRun({ authorityStore: store, ...secondBinding }),
        (err) => err.code === 'DUAL_VALIDATOR_RUN_CONFLICT'
    );
});

test('public authority store exposes no validator lifecycle mutation methods and rejects forged capability', (t) => {
    const { store } = fixture(t);
    assert.equal(typeof store.beginValidatorRun, 'undefined');
    assert.equal(typeof store.settleValidatorRun, 'undefined');

    const binding = makeBinding();
    const handle = beginRun({ authorityStore: store, ...binding });

    // Settle with forged capability is rejected
    assert.throws(
        () => settleRun({
            authorityStore: store,
            capability: 'forged-capability-token',
            ownedResult: makeOwnedResult(binding.runId),
            resultAnchor: { digest: 'd'.repeat(64) },
        }),
        (err) => err.code === 'DUAL_VALIDATOR_CAPABILITY_INVALID'
    );
});

test('settleValidatorRun rejects forged result, wrong runId, or unverified cleanup', (t) => {
    const { store } = fixture(t);
    const binding = makeBinding();
    const handle = beginRun({ authorityStore: store, ...binding });

    // Wrong runId in ownedResult
    assert.throws(
        () => settleRun({
            authorityStore: store,
            capability: handle.capability,
            ownedResult: makeOwnedResult('00000000-0000-4000-8000-000000000000'),
            resultAnchor: { digest: 'd'.repeat(64) },
        }),
        (err) => err.code === 'DUAL_VALIDATOR_RESULT_MISMATCH'
    );

    // Unverified cleanup / active processes > 0
    assert.throws(
        () => settleRun({
            authorityStore: store,
            capability: handle.capability,
            ownedResult: makeOwnedResult(binding.runId, { cleanupVerified: false }),
            resultAnchor: { digest: 'd'.repeat(64) },
        }),
        (err) => err.code === 'DUAL_VALIDATOR_CLEANUP_UNPROVEN'
    );
});

test('persisted unresolved intent remains fenced after authority restart', (t) => {
    const { authorityDir, store } = fixture(t);
    const binding = makeBinding();
    beginRun({ authorityStore: store, ...binding });

    // Restart without settlement
    const reopened = createAuthorityStore(authorityDir);
    const state = inspectValidatorRun({ authorityStore: reopened, runId: binding.runId });
    assert.equal(state.active, true);
    assert.equal(state.settled, false);

    // Starting a new validator while an unresolved run exists from before restart is fenced
    assert.throws(
        () => beginRun({ authorityStore: reopened, ...makeBinding({ runId: crypto.randomUUID() }) }),
        (err) => err.code === 'DUAL_VALIDATOR_RUN_CONFLICT'
    );
});

test('legacy store without validators.ndjson derives cleanly and returns empty validator records', (t) => {
    const { authorityDir, store } = fixture(t);
    // Ensure validators.ndjson does not exist
    const valFile = path.join(authorityDir, 'validators.ndjson');
    if (fs.existsSync(valFile)) fs.rmSync(valFile);

    assert.equal(fs.existsSync(valFile), false);
    const records = store.readValidatorRecords();
    assert.deepEqual(records, []);
    assert.ok(store.verifyIntegrity().valid);
    assert.equal(store.derive().sessionId, 'session-1');

    const reopened = createAuthorityStore(authorityDir);
    assert.deepEqual(reopened.readValidatorRecords(), []);
    assert.ok(reopened.verifyIntegrity().valid);
});

test('ledger byte preservation: replay and inspection preserve exact ledger bytes and hash integrity', (t) => {
    const { authorityDir, store } = fixture(t);
    const binding = makeBinding();
    const handle = beginRun({ authorityStore: store, ...binding });
    settleRun({
        authorityStore: store,
        capability: handle.capability,
        ownedResult: makeOwnedResult(binding.runId),
        resultAnchor: { digest: 'd'.repeat(64) },
    });

    const eventsPath = path.join(authorityDir, 'events.ndjson');
    const validatorsPath = path.join(authorityDir, 'validators.ndjson');
    const eventsBefore = fs.readFileSync(eventsPath);
    const validatorsBefore = fs.readFileSync(validatorsPath);

    // Reopen and run multiple derive, verify, and inspect cycles
    for (let i = 0; i < 3; i++) {
        const reopened = createAuthorityStore(authorityDir);
        assert.ok(reopened.verifyIntegrity().valid);
        assert.equal(reopened.derive().sessionId, 'session-1');
        assert.equal(inspectValidatorRun({ authorityStore: reopened, runId: binding.runId }).settled, true);
        assert.equal(reopened.readValidatorRecords().length, 2);
    }

    const eventsAfter = fs.readFileSync(eventsPath);
    const validatorsAfter = fs.readFileSync(validatorsPath);

    assert.equal(Buffer.compare(eventsBefore, eventsAfter), 0, 'events.ndjson bytes must be byte-for-byte identical');
    assert.equal(Buffer.compare(validatorsBefore, validatorsAfter), 0, 'validators.ndjson bytes must be byte-for-byte identical');
});

test('unresolved validator run safely reports diagnostics without mutating ledger bytes', (t) => {
    const { authorityDir, store } = fixture(t);
    const binding = makeBinding();
    beginRun({ authorityStore: store, ...binding });

    const validatorsPath = path.join(authorityDir, 'validators.ndjson');
    const validatorsBefore = fs.readFileSync(validatorsPath);

    const reopened = createAuthorityStore(authorityDir);
    const diagnostic = inspectValidatorRun({ authorityStore: reopened, runId: binding.runId });
    assert.equal(diagnostic.active, true);
    assert.equal(diagnostic.settled, false);
    assert.equal(diagnostic.purpose, 'quality');

    const validatorsAfter = fs.readFileSync(validatorsPath);
    assert.equal(Buffer.compare(validatorsBefore, validatorsAfter), 0, 'unresolved diagnostic must not alter ledger bytes');
});

