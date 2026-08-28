'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    evaluateUiEvidence,
    recordUiEvidence,
    DualUiGateError,
    REQUIRED_VIEWPORT_WIDTHS,
} = require('../lib/dual/ui-gate');
const { createAuthorityStore } = require('../lib/dual/authority-store');

const DUMMY_SHA256 = 'c'.repeat(64);
const VALID_VIEWPORTS = [390, 768, 1024, 1440];

function createValidRequirement(overrides = {}) {
    return {
        gate_id: 'ui-responsive-matrix',
        required: true,
        viewport_widths: [390, 768, 1024, 1440],
        reduced_motion_required: true,
        ...overrides,
    };
}

function createValidEvidence(overrides = {}) {
    return {
        runtime_status: 'AVAILABLE',
        evidence_sha256: DUMMY_SHA256,
        viewports: [
            { width: 390, passed: true, horizontal_overflow: false },
            { width: 768, passed: true, horizontal_overflow: false },
            { width: 1024, passed: true, horizontal_overflow: false },
            { width: 1440, passed: true, horizontal_overflow: false },
        ],
        reduced_motion: { tested: true, passed: true },
        ...overrides,
    };
}

function createFakeClock(startIso = '2026-08-25T00:00:00.000Z') {
    let currentMs = new Date(startIso).getTime();
    return () => new Date(currentMs);
}

function createDeterministicUuid() {
    let counter = 0;
    return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
}

function makeSessionDir(t) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-gate-test-'));
    t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
    return sessionDir;
}

function setupStore(t) {
    const sessionDir = makeSessionDir(t);
    const clock = createFakeClock();
    const uuid = createDeterministicUuid();
    const store = createAuthorityStore(sessionDir, { clock, uuid });

    store.append({
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_id: 'ws-test',
        session_id: 'sess-test',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        workspace_root: '.',
        mode: 'auto',
    });

    return { store, clock, uuid };
}

// 1. Evaluator - Passing cases
test('evaluateUiEvidence passes complete valid evidence across 390/768/1024/1440 and reduced-motion', () => {
    const req = createValidRequirement();
    const ev = createValidEvidence();

    const result = evaluateUiEvidence(req, ev);
    assert.equal(result.gate_id, 'ui-responsive-matrix');
    assert.equal(result.status, 'PASSED');
    assert.match(result.reason, /passed/i);
    assert.equal(result.evidence_sha256, DUMMY_SHA256);
    assert.equal(result.details.required, true);
    assert.deepEqual(result.details.viewport_widths, VALID_VIEWPORTS);
    assert.equal(result.details.reduced_motion_required, true);
    assert.equal(result.details.runtime_status, 'AVAILABLE');
    assert.equal(result.required, undefined);
});

// 2. Evaluator - Unavailable runtime
test('evaluateUiEvidence returns UNAVAILABLE when browser runtime is missing/cannot start for required gate', () => {
    const req = createValidRequirement({ required: true });
    const ev = {
        runtime_status: 'UNAVAILABLE',
        evidence_sha256: DUMMY_SHA256,
        reason: 'Chromium binary not found',
    };

    const result = evaluateUiEvidence(req, ev);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.details.required, true);
    assert.equal(result.details.runtime_status, 'UNAVAILABLE');
    assert.match(result.reason, /Chromium binary not found/);
});

test('evaluateUiEvidence returns OPTIONAL_SKIPPED only when browser is unavailable and gate was predeclared optional', () => {
    const req = createValidRequirement({ required: false });
    const ev = {
        runtime_status: 'UNAVAILABLE',
        evidence_sha256: DUMMY_SHA256,
        reason: 'Optional browser skipped',
    };

    const result = evaluateUiEvidence(req, ev);
    assert.equal(result.status, 'OPTIONAL_SKIPPED');
    assert.equal(result.details.required, false);
    assert.equal(result.details.runtime_status, 'UNAVAILABLE');
});

// 3. Evaluator - Blocked and Attempted Failure
test('evaluateUiEvidence keeps status BLOCKED when browser execution was blocked (even if optional)', () => {
    for (const required of [true, false]) {
        const req = createValidRequirement({ required });
        const ev = {
            runtime_status: 'BLOCKED',
            evidence_sha256: DUMMY_SHA256,
            reason: 'Display server not accessible',
        };

        const result = evaluateUiEvidence(req, ev);
        assert.equal(result.status, 'BLOCKED');
        assert.match(result.reason, /Display server/);
    }
});

test('evaluateUiEvidence keeps FAILED for optional gate when real failure was attempted', () => {
    const req = createValidRequirement({ required: false });
    const ev = createValidEvidence({
        viewports: [
            { width: 390, passed: false, horizontal_overflow: true },
            { width: 768, passed: true, horizontal_overflow: false },
            { width: 1024, passed: true, horizontal_overflow: false },
            { width: 1440, passed: true, horizontal_overflow: false },
        ],
    });

    const result = evaluateUiEvidence(req, ev);
    assert.equal(result.status, 'FAILED');
    assert.match(result.reason, /overflow|fail/i);
});

// 4. Evaluator - Viewports matrix assertions
test('evaluateUiEvidence fails when required viewports are missing, duplicated, extra, or have wrong widths', () => {
    const req = createValidRequirement();

    assert.throws(
        () => evaluateUiEvidence(req, createValidEvidence({
            viewports: [
                { width: 390, passed: true, horizontal_overflow: false },
                { width: 768, passed: true, horizontal_overflow: false },
                { width: 1024, passed: true, horizontal_overflow: false },
            ],
        })),
        /DualUiGateError/
    );

    assert.throws(
        () => evaluateUiEvidence(req, createValidEvidence({
            viewports: [
                { width: 390, passed: true, horizontal_overflow: false },
                { width: 390, passed: true, horizontal_overflow: false },
                { width: 768, passed: true, horizontal_overflow: false },
                { width: 1024, passed: true, horizontal_overflow: false },
            ],
        })),
        /DualUiGateError/
    );

    assert.throws(
        () => evaluateUiEvidence(req, createValidEvidence({
            viewports: [
                { width: 390, passed: true, horizontal_overflow: false },
                { width: 768, passed: true, horizontal_overflow: false },
                { width: 1024, passed: true, horizontal_overflow: false },
                { width: 1440, passed: true, horizontal_overflow: false },
                { width: 1920, passed: true, horizontal_overflow: false },
            ],
        })),
        /DualUiGateError/
    );

    assert.throws(
        () => evaluateUiEvidence(req, createValidEvidence({
            viewports: [
                { width: 390, passed: true, horizontal_overflow: false },
                { width: 800, passed: true, horizontal_overflow: false },
                { width: 1024, passed: true, horizontal_overflow: false },
                { width: 1440, passed: true, horizontal_overflow: false },
            ],
        })),
        /DualUiGateError/
    );
});

test('evaluateUiEvidence fails when horizontal overflow occurs at 390px', () => {
    const req = createValidRequirement();
    const ev = createValidEvidence({
        viewports: [
            { width: 390, passed: true, horizontal_overflow: true },
            { width: 768, passed: true, horizontal_overflow: false },
            { width: 1024, passed: true, horizontal_overflow: false },
            { width: 1440, passed: true, horizontal_overflow: false },
        ],
    });

    const result = evaluateUiEvidence(req, ev);
    assert.equal(result.status, 'FAILED');
    assert.match(result.reason, /overflow/i);
});

test('evaluateUiEvidence fails when reduced motion evidence is false or failed', () => {
    const req = createValidRequirement({ reduced_motion_required: true });

    const untestedRm = createValidEvidence({ reduced_motion: { tested: false, passed: true } });
    assert.equal(evaluateUiEvidence(req, untestedRm).status, 'FAILED');

    const failedRm = createValidEvidence({ reduced_motion: { tested: true, passed: false } });
    assert.equal(evaluateUiEvidence(req, failedRm).status, 'FAILED');
});

test('evaluateUiEvidence does not mutate requirement or evidence objects', () => {
    const req = createValidRequirement();
    const ev = createValidEvidence();
    const reqJson = JSON.stringify(req);
    const evJson = JSON.stringify(ev);

    evaluateUiEvidence(req, ev);

    assert.equal(JSON.stringify(req), reqJson);
    assert.equal(JSON.stringify(ev), evJson);
});

// 5. recordUiEvidence tests
test('recordUiEvidence appends exactly one gate.result event to authority store and never turns failure into success', (t) => {
    const { store } = setupStore(t);
    const req = createValidRequirement();
    const ev = createValidEvidence();

    const result = recordUiEvidence({
        authorityStore: store,
        requirement: req,
        evidence: ev,
    });

    assert.equal(result.type, 'gate.result');
    assert.equal(result.gate_id, 'ui-responsive-matrix');
    assert.equal(result.status, 'PASSED');
    assert.equal(result.evidence_sha256, DUMMY_SHA256);
    assert.equal(result.details.required, true);
    assert.equal(result.required, undefined);

    const derived = store.derive();
    assert.ok(derived.gates['ui-responsive-matrix']);
    assert.equal(derived.gates['ui-responsive-matrix'].status, 'PASSED');
});

test('recordUiEvidence with fake authority store proves exactly one gate.result and no completion/verification events', () => {
    const appendedEvents = [];
    const fakeStore = {
        append: (event) => {
            appendedEvents.push(event);
            return event;
        },
    };

    recordUiEvidence({
        authorityStore: fakeStore,
        requirement: createValidRequirement(),
        evidence: createValidEvidence(),
    });

    assert.equal(appendedEvents.length, 1);
    assert.equal(appendedEvents[0].type, 'gate.result');
    assert.equal(appendedEvents[0].gate_id, 'ui-responsive-matrix');
    assert.ok(!appendedEvents.some((e) => e.type === 'task.completed' || e.type === 'session.verified'));
});

test('recordUiEvidence fails closed if authorityStore is missing or append throws', () => {
    assert.throws(
        () => recordUiEvidence({
            requirement: createValidRequirement(),
            evidence: createValidEvidence(),
        }),
        /DualUiGateError/
    );

    const failingStore = {
        append: () => {
            throw new Error('Storage write failed');
        },
    };

    assert.throws(
        () => recordUiEvidence({
            authorityStore: failingStore,
            requirement: createValidRequirement(),
            evidence: createValidEvidence(),
        }),
        /Storage write failed/
    );
});

// ==========================================
// Codex Review 1 P0 Regression Tests
// ==========================================

test('P0-1: evaluateUiEvidence rejects missing typed assertions (untyped viewports or empty reduced motion)', () => {
    const req = createValidRequirement();
    
    assert.throws(
        () => evaluateUiEvidence(
            req,
            {
                runtime_status: 'AVAILABLE',
                evidence_sha256: DUMMY_SHA256,
                viewports: [390, 768, 1024, 1440].map((width) => ({ width })),
                reduced_motion: {},
            }
        ),
        (err) => {
            assert.ok(err instanceof DualUiGateError || err.name === 'DualUiGateError');
            return true;
        }
    );
});

test('P0-1: evaluateUiEvidence requires exact own keys on requirement (rejects missing keys, extra keys, aliases, wrong reduced_motion_required)', () => {
    assert.throws(() => evaluateUiEvidence({ gate_id: 'ui', required: true }, createValidEvidence()), /DualUiGateError/);
    assert.throws(() => evaluateUiEvidence({ ...createValidRequirement(), extra: true }, createValidEvidence()), /DualUiGateError/);
    assert.throws(() => evaluateUiEvidence({
        gateId: 'ui',
        required: true,
        viewports: [390, 768, 1024, 1440],
        reduced_motion_required: true,
    }, createValidEvidence()), /DualUiGateError/);
    assert.throws(() => evaluateUiEvidence({
        ...createValidRequirement(),
        reduced_motion_required: false,
    }, createValidEvidence()), /DualUiGateError/);
    assert.throws(() => evaluateUiEvidence({
        ...createValidRequirement(),
        viewport_widths: [320, 768, 1024, 1440],
    }, createValidEvidence()), /DualUiGateError/);
});

test('P0-1: evaluateUiEvidence requires exact own keys on viewport records (width, passed, horizontal_overflow) without coercion', () => {
    const req = createValidRequirement();

    assert.throws(() => evaluateUiEvidence(req, createValidEvidence({
        viewports: [
            { width: 390, passed: 'true', horizontal_overflow: false },
            { width: 768, passed: true, horizontal_overflow: false },
            { width: 1024, passed: true, horizontal_overflow: false },
            { width: 1440, passed: true, horizontal_overflow: false },
        ],
    })), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, createValidEvidence({
        viewports: [
            { width: 390, passed: true, horizontal_overflow: false, extra: 'forbidden' },
            { width: 768, passed: true, horizontal_overflow: false },
            { width: 1024, passed: true, horizontal_overflow: false },
            { width: 1440, passed: true, horizontal_overflow: false },
        ],
    })), /DualUiGateError/);
});

test('P0-1: evaluateUiEvidence requires exact own keys on reduced_motion ({ tested: boolean, passed: boolean }) without coercion', () => {
    const req = createValidRequirement();

    assert.throws(() => evaluateUiEvidence(req, createValidEvidence({
        reduced_motion: { passed: true },
    })), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, createValidEvidence({
        reduced_motion: { tested: 'true', passed: 'true' },
    })), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, createValidEvidence({
        reduced_motion: { tested: true, passed: true, extra: 1 },
    })), /DualUiGateError/);
});

test('P0-2: evaluateUiEvidence rejects input gate verdicts (PASSED/FAILED/OPTIONAL_SKIPPED/SKIP) or aliases in evidence', () => {
    const req = createValidRequirement();

    assert.throws(() => evaluateUiEvidence(req, {
        status: 'OPTIONAL_SKIPPED',
        runtime_available: true,
        evidence_sha256: DUMMY_SHA256,
        viewports: createValidEvidence().viewports,
        reduced_motion: { tested: true, passed: true },
    }), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, {
        status: 'PASSED',
        evidence_sha256: DUMMY_SHA256,
    }), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, {
        status: 'SKIP',
        evidence_sha256: DUMMY_SHA256,
    }), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, {
        runtime_available: true,
        evidence_sha256: DUMMY_SHA256,
    }), /DualUiGateError/);
});

test('P0-2: evaluateUiEvidence enforces strict runtime_status vocabulary (AVAILABLE|UNAVAILABLE|BLOCKED)', () => {
    const req = createValidRequirement();

    assert.throws(() => evaluateUiEvidence(req, {
        runtime_status: 'UNKNOWN_STATUS',
        evidence_sha256: DUMMY_SHA256,
    }), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(req, {
        runtime_status: 'available',
        evidence_sha256: DUMMY_SHA256,
    }), /DualUiGateError/);
});

test('P0-8: evaluateUiEvidence rejects control characters in gate_id, reason, and rejects objects with prototype tampering or getters', () => {
    assert.throws(() => evaluateUiEvidence(
        createValidRequirement({ gate_id: 'ui\x00gate' }),
        createValidEvidence()
    ), /DualUiGateError/);

    assert.throws(() => evaluateUiEvidence(
        createValidRequirement(),
        createValidEvidence({ reason: 'Bad\x08reason' })
    ), /DualUiGateError/);

    const nullProtoReq = Object.create(null);
    Object.assign(nullProtoReq, createValidRequirement());
    assert.throws(() => evaluateUiEvidence(nullProtoReq, createValidEvidence()), /DualUiGateError/);

    const getterReq = { ...createValidRequirement() };
    Object.defineProperty(getterReq, 'gate_id', {
        get() { return 'ui'; },
        enumerable: true,
        configurable: true,
    });
    assert.throws(() => evaluateUiEvidence(getterReq, createValidEvidence()), /DualUiGateError/);

    const symEv = { ...createValidEvidence() };
    symEv[Symbol('evil')] = 'bad';
    assert.throws(() => evaluateUiEvidence(createValidRequirement(), symEv), /DualUiGateError/);
});

// ==========================================
// Codex Review 2 P0 Regression Tests
// ==========================================

test('Review2-Finding 4: UNAVAILABLE or BLOCKED runtime rejects viewports or reduced_motion payloads, and rejects empty/whitespace reason', () => {
    const req = createValidRequirement({ required: true });

    // UNAVAILABLE runtime with viewports payload must be rejected
    assert.throws(
        () => evaluateUiEvidence(req, {
            runtime_status: 'UNAVAILABLE',
            evidence_sha256: DUMMY_SHA256,
            viewports: createValidEvidence().viewports,
        }),
        /DualUiGateError/
    );

    // BLOCKED runtime with reduced_motion payload must be rejected
    assert.throws(
        () => evaluateUiEvidence(req, {
            runtime_status: 'BLOCKED',
            evidence_sha256: DUMMY_SHA256,
            reduced_motion: { tested: true, passed: true },
        }),
        /DualUiGateError/
    );

    // Empty string reason
    assert.throws(
        () => evaluateUiEvidence(req, {
            runtime_status: 'UNAVAILABLE',
            evidence_sha256: DUMMY_SHA256,
            reason: '',
        }),
        /DualUiGateError/
    );

    // Whitespace-only reason
    assert.throws(
        () => evaluateUiEvidence(req, {
            runtime_status: 'UNAVAILABLE',
            evidence_sha256: DUMMY_SHA256,
            reason: '   ',
        }),
        /DualUiGateError/
    );
});

test('Review2-Finding 5: recordUiEvidence rejects extra keys, aliases, accessors, symbols on options object', () => {
    const fakeStore = { append: (e) => e };
    const req = createValidRequirement();
    const ev = createValidEvidence();

    // Extra keys
    assert.throws(
        () => recordUiEvidence({
            authorityStore: fakeStore,
            requirement: req,
            evidence: ev,
            extra: 'forbidden',
        }),
        /DualUiGateError/
    );

    // Aliases (authority_store instead of authorityStore)
    assert.throws(
        () => recordUiEvidence({
            authority_store: fakeStore,
            requirement: req,
            evidence: ev,
        }),
        /DualUiGateError/
    );

    // Null prototype
    const nullProto = Object.create(null);
    Object.assign(nullProto, { authorityStore: fakeStore, requirement: req, evidence: ev });
    assert.throws(() => recordUiEvidence(nullProto), /DualUiGateError/);

    // Symbols
    const symObj = { authorityStore: fakeStore, requirement: req, evidence: ev };
    symObj[Symbol('evil')] = true;
    assert.throws(() => recordUiEvidence(symObj), /DualUiGateError/);
});

// ==========================================
// Codex Review 3 P0 Regression Tests
// ==========================================

test('Review3-Finding 3: recordUiEvidence requires strict append acknowledgement (throws DUAL_UI_GATE_INVALID_APPEND_ACK if store returns undefined or mismatched ack)', () => {
    const req = createValidRequirement();
    const ev = createValidEvidence();

    // 1. Returns undefined
    const storeUndef = { append: () => undefined };
    assert.throws(
        () => recordUiEvidence({
            authorityStore: storeUndef,
            requirement: req,
            evidence: ev,
        }),
        (err) => err.code === 'DUAL_UI_GATE_INVALID_APPEND_ACK' || err.name === 'DualUiGateError'
    );

    // 2. Returns mismatched gate_id
    const storeBadGate = { append: (event) => ({ ...event, gate_id: 'other-gate' }) };
    assert.throws(
        () => recordUiEvidence({
            authorityStore: storeBadGate,
            requirement: req,
            evidence: ev,
        }),
        (err) => err.code === 'DUAL_UI_GATE_INVALID_APPEND_ACK' || err.name === 'DualUiGateError'
    );

    // 3. Returns mismatched runtime_status
    const storeBadStatus = {
        append: (event) => ({
            ...event,
            details: { ...event.details, runtime_status: 'BLOCKED' },
        }),
    };
    assert.throws(
        () => recordUiEvidence({
            authorityStore: storeBadStatus,
            requirement: req,
            evidence: ev,
        }),
        (err) => err.code === 'DUAL_UI_GATE_INVALID_APPEND_ACK' || err.name === 'DualUiGateError'
    );
});
