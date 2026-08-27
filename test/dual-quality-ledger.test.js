'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    cycleThresholds,
    evaluateMandatoryGates,
    createQualityLedger,
    DualQualityError,
} = require('../lib/dual/quality-ledger');
const { createAuthorityStore } = require('../lib/dual/authority-store');

const DUMMY_SHA256 = 'a'.repeat(64);
const DIFF_SHA256 = 'b'.repeat(64);

function createFakeClock(startIso = '2026-08-25T00:00:00.000Z') {
    let currentMs = new Date(startIso).getTime();
    function clock() {
        return new Date(currentMs);
    }
    clock.advance = (ms) => {
        currentMs += ms;
        return clock();
    };
    return clock;
}

function createDeterministicUuid() {
    let counter = 0;
    return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
}

function makeSessionDir(t) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-quality-test-'));
    t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
    return sessionDir;
}

function setupStoreWithVerifiedTasks(t, totalTasks = 3, verifiedCount = 3) {
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
        expected_baseline: { kind: 'git', id: 'c'.repeat(40) },
        workspace_root: '.',
        mode: 'auto',
    });

    store.append({
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'test-check', status: 'PASSED' }],
    });

    const tasks = [];
    for (let i = 1; i <= totalTasks; i++) {
        tasks.push({
            task_id: `TASK-${i}`,
            title: `Task ${i}`,
            owner: 'agy',
            allowed_files: [`lib/task-${i}.js`],
        });
    }

    store.append({
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'd'.repeat(64),
        total_tasks: totalTasks,
        tasks,
    });

    for (let i = 1; i <= verifiedCount; i++) {
        const taskId = `TASK-${i}`;
        store.append({
            type: 'task.routed',
            task_id: taskId,
            owner: 'agy',
            authority_state: 'ROUTED',
            allowed_files: [`lib/task-${i}.js`],
            reason: 'Task routed to agy',
        });
        store.acquireLease(taskId, 'agy');
        store.append({
            type: 'task.completed',
            task_id: taskId,
            owner: 'agy',
            authority_state: 'TASK_VERIFIED',
            modified_files: [`lib/task-${i}.js`],
            diff_fingerprint: 'e'.repeat(64),
            verdict: 'SUCCESS',
            verified_by: 'codex',
        });
    }

    return { store, clock, uuid };
}

// 1. Thresholds tests
test('cycleThresholds calculates exact ceil ratios for 1, 2, 3, 7, and 10 without deduplication', () => {
    assert.deepEqual(cycleThresholds(1), [1, 1, 1]);
    assert.deepEqual(cycleThresholds(2), [1, 2, 2]);
    assert.deepEqual(cycleThresholds(3), [1, 2, 3]);
    assert.deepEqual(cycleThresholds(7), [3, 5, 7]);
    assert.deepEqual(cycleThresholds(10), [4, 7, 10]);
});

test('cycleThresholds rejects invalid, negative, zero, float, or non-number totals', () => {
    const invalidTotals = [0, -1, -5, 1.5, 3.14, NaN, Infinity, -Infinity, '3', null, undefined, {}, []];
    for (const total of invalidTotals) {
        assert.throws(
            () => cycleThresholds(total),
            (err) => {
                assert.ok(err instanceof DualQualityError || err.name === 'DualQualityError');
                return true;
            },
            `Should have thrown for total=${total}`
        );
    }
});

// 2. evaluateMandatoryGates tests
test('evaluateMandatoryGates passes when all required and optional gates pass', () => {
    const gates = [
        { id: 'typecheck', required: true, status: 'PASSED' },
        { id: 'unit-tests', required: true, status: 'PASSED' },
        { id: 'optional-bench', required: false, status: 'PASSED' },
        { id: 'optional-docs', required: false, status: 'OPTIONAL_SKIPPED' },
    ];
    const result = evaluateMandatoryGates(gates);
    assert.deepEqual(result, { verdict: 'PASSED', blockers: [] });
});

test('evaluateMandatoryGates blocks when required gate fails, is blocked, is unavailable, or is optional_skipped', () => {
    const blockingStatuses = ['FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED'];
    for (const status of blockingStatuses) {
        const gates = [
            { id: 'typecheck', required: true, status: 'PASSED' },
            { id: 'gate-under-test', required: true, status },
        ];
        const result = evaluateMandatoryGates(gates);
        assert.equal(result.verdict, 'BLOCKED', `Expected BLOCKED for required status ${status}`);
        assert.equal(result.blockers.length, 1);
        assert.equal(result.blockers[0].id, 'gate-under-test');
        assert.equal(result.blockers[0].status, status);
    }
});

test('evaluateMandatoryGates blocks when optional gate fails or is blocked/unavailable (attempted failure)', () => {
    const blockingStatuses = ['FAILED', 'BLOCKED', 'UNAVAILABLE'];
    for (const status of blockingStatuses) {
        const gates = [
            { id: 'typecheck', required: true, status: 'PASSED' },
            { id: 'optional-gate', required: false, status },
        ];
        const result = evaluateMandatoryGates(gates);
        assert.equal(result.verdict, 'BLOCKED', `Expected BLOCKED for optional attempted failure ${status}`);
        assert.equal(result.blockers.length, 1);
        assert.equal(result.blockers[0].id, 'optional-gate');
        assert.equal(result.blockers[0].status, status);
    }
});

test('evaluateMandatoryGates rejects unknown statuses, generic SKIP, PASS, aliases, missing/duplicate IDs, non-plain shapes', () => {
    const invalidGateSets = [
        [{ id: 'g1', required: true, status: 'SKIP' }],
        [{ id: 'g1', required: true, status: 'PASS' }],
        [{ id: 'g1', required: true, status: 'passed' }],
        [{ id: 'g1', required: true, status: 'failed' }],
        [{ id: '', required: true, status: 'PASSED' }],
        [{ required: true, status: 'PASSED' }],
        [{ id: 'g1', status: 'PASSED' }],
        [{ id: 'g1', required: 'true', status: 'PASSED' }],
        [
            { id: 'g1', required: true, status: 'PASSED' },
            { id: 'g1', required: false, status: 'PASSED' },
        ],
        'not-an-array',
        [],
        [null],
    ];

    for (const item of invalidGateSets) {
        assert.throws(
            () => evaluateMandatoryGates(item),
            (err) => {
                assert.ok(err instanceof DualQualityError || err.name === 'DualQualityError');
                return true;
            }
        );
    }
});

test('evaluateMandatoryGates does not mutate input array or gate objects', () => {
    const gate1 = { id: 'typecheck', required: true, status: 'PASSED' };
    const gate2 = { id: 'lint', required: false, status: 'OPTIONAL_SKIPPED' };
    const gates = [gate1, gate2];
    const originalGatesJson = JSON.stringify(gates);

    const result = evaluateMandatoryGates(gates);
    assert.equal(result.verdict, 'PASSED');
    assert.equal(JSON.stringify(gates), originalGatesJson);
});

// 3. Authority-store recorder tests
test('createQualityLedger fails closed if authorityStore or readDiffFingerprint is missing or invalid', () => {
    assert.throws(() => createQualityLedger(), /DualQualityError/);
    assert.throws(() => createQualityLedger({}), /DualQualityError/);
    assert.throws(() => createQualityLedger({ authorityStore: {} }), /DualQualityError/);
    assert.throws(() => createQualityLedger({
        authorityStore: { derive: () => {}, readEvents: () => {}, append: () => {} },
        readDiffFingerprint: 'not-a-func',
    }), /DualQualityError/);
});

test('records successful quality cycle and appends exact gate.result event to authority store', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 3, 3);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const cycleInput = {
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [
            { id: 'typecheck', required: true, status: 'PASSED' },
            { id: 'test', required: true, status: 'PASSED' },
        ],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 120 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    };

    const record = ledger.recordCycle(cycleInput);
    assert.equal(record.verdict, 'PASSED');
    assert.equal(record.status, 'PASSED');
    assert.equal(record.attempt, 1);

    const derived = store.derive();
    assert.ok(derived.gates['quality-cycle-1']);
    const cycleGate = derived.gates['quality-cycle-1'];
    assert.equal(cycleGate.status, 'PASSED');
    assert.equal(cycleGate.cycleIndex, 1);
    assert.equal(cycleGate.evidenceSha256, DUMMY_SHA256);
    assert.equal(cycleGate.details.required, true);
    assert.equal(cycleGate.details.threshold, 1);
    assert.deepEqual(cycleGate.details.completed_task_ids, ['TASK-1']);
    assert.equal(cycleGate.details.attempt, 1);

    const events = store.readEvents();
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.type, 'gate.result');
    assert.equal(lastEvent.gate_id, 'quality-cycle-1');
    assert.equal(lastEvent.status, 'PASSED');
    assert.equal(lastEvent.required, undefined);
});

test('three distinct cycle records can be recorded for duplicate small-N thresholds (e.g. N=1)', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 1, 1);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    for (let cycle = 1; cycle <= 3; cycle++) {
        const res = ledger.recordCycle({
            cycle_index: cycle,
            total_tasks: 1,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: `gate-${cycle}`, required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        });
        assert.equal(res.verdict, 'PASSED');
    }

    const derived = store.derive();
    assert.ok(derived.gates['quality-cycle-1']);
    assert.ok(derived.gates['quality-cycle-2']);
    assert.ok(derived.gates['quality-cycle-3']);
    assert.equal(derived.gates['quality-cycle-1'].status, 'PASSED');
    assert.equal(derived.gates['quality-cycle-2'].status, 'PASSED');
    assert.equal(derived.gates['quality-cycle-3'].status, 'PASSED');
});

test('enforces monotonic attempt numbers 1..3 and limits to maximum 3 attempts per cycle', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 3, 3);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const failedGateResults = [
        { id: 'typecheck', required: true, status: 'FAILED' },
    ];
    const validCommands = [{ command: 'npm test', exit_code: 1, duration_ms: 50 }];

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: failedGateResults,
            commands: validCommands,
            evidence_sha256: DUMMY_SHA256,
            attempt: 2,
        }),
        (err) => err.code === 'DUAL_QUALITY_NON_MONOTONIC_ATTEMPT' || err.name === 'DualQualityError'
    );

    const a1 = ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: failedGateResults,
        commands: validCommands,
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    });
    assert.equal(a1.status, 'FAILED');
    assert.equal(a1.verdict, 'BLOCKED');

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: failedGateResults,
            commands: validCommands,
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_NON_MONOTONIC_ATTEMPT' || err.name === 'DualQualityError'
    );

    const a2 = ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: failedGateResults,
        commands: validCommands,
        evidence_sha256: DUMMY_SHA256,
        attempt: 2,
    });
    assert.equal(a2.status, 'FAILED');

    const a3 = ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: failedGateResults,
        commands: validCommands,
        evidence_sha256: DUMMY_SHA256,
        attempt: 3,
    });
    assert.equal(a3.status, 'FAILED');

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 'typecheck', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 50 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 4,
        }),
        (err) => err.code === 'DUAL_QUALITY_MAX_ATTEMPTS_EXCEEDED' || err.name === 'DualQualityError'
    );
});

test('cannot record a cycle attempt after the cycle has already PASSED', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 3, 3);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 'typecheck', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 'typecheck', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 2,
        }),
        (err) => err.code === 'DUAL_QUALITY_CYCLE_ALREADY_PASSED' || err.name === 'DualQualityError'
    );
});

test('rejects insufficient completed task count for cycle threshold', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 7, 7);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 7,
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 'typecheck', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_INSUFFICIENT_TASKS' || err.name === 'DualQualityError'
    );
});

test('rejects plan revision mismatch before append', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 3, 3);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const initialEventCount = store.readEvents().length;

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 2,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 'typecheck', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_PLAN_REVISION_MISMATCH' || err.name === 'DualQualityError'
    );

    assert.equal(store.readEvents().length, initialEventCount);
});

test('rejects diff fingerprint mismatch before append', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 3, 3);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const initialEventCount = store.readEvents().length;

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: 'c'.repeat(64),
            gate_results: [{ id: 'typecheck', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_DIFF_MISMATCH' || err.name === 'DualQualityError'
    );

    assert.equal(store.readEvents().length, initialEventCount);
});

test('fake authority store proves exactly one gate.result append and never appends completion or verification events', () => {
    const appendedEvents = [];
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: {
                'TASK-1': { state: 'TASK_VERIFIED' },
                'TASK-2': { state: 'REGISTERED' },
                'TASK-3': { state: 'REGISTERED' },
            },
            gates: {},
        }),
        readEvents: () => appendedEvents,
        append: (event) => {
            appendedEvents.push(event);
            return event;
        },
    };

    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 't', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    });

    assert.equal(appendedEvents.length, 1);
    assert.equal(appendedEvents[0].type, 'gate.result');
    assert.equal(appendedEvents[0].gate_id, 'quality-cycle-1');
    assert.ok(!appendedEvents.some((e) => e.type === 'task.completed' || e.type === 'session.verified'));
});

test('authority-store append failure propagates without false success', () => {
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: {
                'TASK-1': { state: 'TASK_VERIFIED' },
                'TASK-2': { state: 'REGISTERED' },
                'TASK-3': { state: 'REGISTERED' },
            },
            gates: {},
        }),
        readEvents: () => [],
        append: () => {
            throw new Error('Disk IO failure in authority store');
        },
    };

    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /Disk IO failure/
    );
});

// ==========================================
// Codex Review 1 P0 Regression Tests
// ==========================================

test('P0-3: evaluateMandatoryGates rejects Object.create(null), accessors, symbol keys, extra keys, and gate_id alias', () => {
    const nullProtoGate = Object.create(null);
    nullProtoGate.id = 'g1';
    nullProtoGate.required = true;
    nullProtoGate.status = 'PASSED';
    assert.throws(() => evaluateMandatoryGates([nullProtoGate]), /DualQualityError/);

    const getterGate = { required: true, status: 'PASSED' };
    Object.defineProperty(getterGate, 'id', {
        get() { return 'g1'; },
        enumerable: true,
        configurable: true,
    });
    assert.throws(() => evaluateMandatoryGates([getterGate]), /DualQualityError/);

    const symGate = { id: 'g1', required: true, status: 'PASSED' };
    symGate[Symbol('evil')] = 1;
    assert.throws(() => evaluateMandatoryGates([symGate]), /DualQualityError/);

    assert.throws(() => evaluateMandatoryGates([
        { id: 'g1', required: true, status: 'PASSED', extraProp: 'bad' },
    ]), /DualQualityError/);

    assert.throws(() => evaluateMandatoryGates([
        { gate_id: 'g1', required: true, status: 'PASSED' },
    ]), /DualQualityError/);
});

test('P0-3: recordCycle rejects non-plain prototypes, symbol keys, getters, extra keys, and camelCase aliases', () => {
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'REGISTERED' }, 'TASK-3': { state: 'REGISTERED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: () => ({}),
    };
    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const validCycle = {
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 't', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    };

    assert.throws(() => ledger.recordCycle({ ...validCycle, extraKey: true }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        cycleIndex: 1,
        totalTasks: 3,
        completedTaskIds: ['TASK-1'],
        planRevision: 1,
        diffFingerprint: DIFF_SHA256,
        gateResults: [{ id: 't', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
        evidenceSha256: DUMMY_SHA256,
        attempt: 1,
    }), /DualQualityError/);

    const nullProto = Object.create(null);
    Object.assign(nullProto, validCycle);
    assert.throws(() => ledger.recordCycle(nullProto), /DualQualityError/);

    const symObj = { ...validCycle };
    symObj[Symbol('evil')] = true;
    assert.throws(() => ledger.recordCycle(symObj), /DualQualityError/);
});

test('P0-4: recordCycle rejects missing/corrupt derived state before diff/events or append', () => {
    const emptyStore = {
        derive: () => ({}),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };
    let diffCalled = false;
    const ledger = createQualityLedger({
        authorityStore: emptyStore,
        readDiffFingerprint: () => { diffCalled = true; return DIFF_SHA256; },
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );
    assert.equal(diffCalled, false, 'Should reject before invoking readDiffFingerprint');
});

test('P0-4: recordCycle requires every completed_task_id to exist in derived.tasks with state TASK_VERIFIED', () => {
    const storeWithUnverifiedTask = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: {
                'TASK-1': { state: 'ROUTED' },
                'TASK-2': { state: 'TASK_VERIFIED' },
                'TASK-3': { state: 'REGISTERED' },
            },
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };
    const ledger = createQualityLedger({
        authorityStore: storeWithUnverifiedTask,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-99'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );
});

test('P0-5: recordCycle enforces sequential cycle ordering (cycle 2 requires cycle 1 PASSED; cycle 3 requires cycle 1 & 2 PASSED)', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 3, 3);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 2,
            total_tasks: 3,
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_PRIOR_CYCLE_NOT_PASSED' || err.name === 'DualQualityError'
    );

    ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 't', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 3,
            total_tasks: 3,
            completed_task_ids: ['TASK-1', 'TASK-2', 'TASK-3'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_PRIOR_CYCLE_NOT_PASSED' || err.name === 'DualQualityError'
    );
});

test('P0-5: duplicate thresholds (N=1) still require sequential cycle passes (cycle 1 pass -> cycle 2 pass -> cycle 3 pass)', (t) => {
    const { store } = setupStoreWithVerifiedTasks(t, 1, 1);
    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 2,
            total_tasks: 1,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_PRIOR_CYCLE_NOT_PASSED' || err.name === 'DualQualityError'
    );
});

test('P0-6: recordCycle requires non-empty commands array (rejects empty commands)', () => {
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'REGISTERED' }, 'TASK-3': { state: 'REGISTERED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };
    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );
});

test('P0-6: recordCycle rejects invalid command records (bad types, NaN duration, negative duration, control chars) without defaulting', () => {
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'REGISTERED' }, 'TASK-3': { state: 'REGISTERED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };
    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const baseCycle = {
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 't', required: true, status: 'PASSED' }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    };

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        commands: [{ command: 42, exit_code: 0, duration_ms: 100 }],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        commands: [{ command: 'npm test', exit_code: '0', duration_ms: 100 }],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: -5 }],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: NaN }],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 10, extra: true }],
    }), /DualQualityError/);
});

test('P0-7: recordCycle validates prior attempt integrity (detects gaps, duplicates, invalid statuses, corrupt history)', () => {
    const corruptHistoryStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'REGISTERED' }, 'TASK-3': { state: 'REGISTERED' } },
            gates: {},
        }),
        readEvents: () => [
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-1',
                cycle_index: 1,
                status: 'FAILED',
                details: { attempt: 2 },
            },
        ],
        append: () => assert.fail('should not append'),
    };

    const ledger = createQualityLedger({
        authorityStore: corruptHistoryStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 2,
        }),
        /DualQualityError/
    );
});

test('P0-8: rejects control characters in task_ids, gate_ids, command strings, and reasons', () => {
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'REGISTERED' }, 'TASK-3': { state: 'REGISTERED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };
    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    const baseCycle = {
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 't', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    };

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        completed_task_ids: ['TASK\x001'],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        commands: [{ command: 'npm test\x1b[31m', exit_code: 0, duration_ms: 100 }],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        gate_results: [{ id: 'gate\x001', required: true, status: 'PASSED' }],
    }), /DualQualityError/);

    assert.throws(() => ledger.recordCycle({
        ...baseCycle,
        gate_results: [{ id: 'gate1', required: true, status: 'PASSED', reason: 'bad\x07reason' }],
    }), /DualQualityError/);
});

// ==========================================
// Codex Review 2 P0 Regression Tests
// ==========================================

test('Review2-Finding 1: recordCycle rejects total_tasks understating derived.plan or registered task count', () => {
    // derived.plan has totalTasks: 10, tasks has 10 registered tasks, but input total_tasks is 2
    const tasks = {};
    for (let i = 1; i <= 10; i++) {
        tasks[`TASK-${i}`] = { state: 'TASK_VERIFIED' };
    }
    const store = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 10, total_tasks: 10 },
            tasks,
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };

    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 2,
            total_tasks: 2, // Mismatch! Stated 2 instead of 10
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => {
            assert.ok(err instanceof DualQualityError || err.name === 'DualQualityError');
            return true;
        }
    );

    // Prototype entries on tasks must not be counted as tasks
    const tasksWithProto = Object.create({ 'TASK-INVENTED': { state: 'TASK_VERIFIED' } });
    tasksWithProto['TASK-1'] = { state: 'TASK_VERIFIED' };
    const storeWithProto = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 1, total_tasks: 1 },
            tasks: tasksWithProto,
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };
    const ledgerProto = createQualityLedger({
        authorityStore: storeWithProto,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    // Requesting TASK-INVENTED must fail because it's not an own property
    assert.throws(
        () => ledgerProto.recordCycle({
            cycle_index: 1,
            total_tasks: 1,
            completed_task_ids: ['TASK-INVENTED'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );
});

test('Review2-Finding 2: history validator detects corrupt prior cycle (mismatched gate_id/cycle_index, invalid details, gap in attempts, later cycle before earlier)', () => {
    // 1. Mismatched gate_id and cycle_index in history
    const storeMismatched = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'TASK_VERIFIED' }, 'TASK-3': { state: 'TASK_VERIFIED' } },
            gates: {},
        }),
        readEvents: () => [
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-1',
                cycle_index: 3, // Mismatched!
                status: 'PASSED',
                details: { cycle_index: 1, attempt: 1, required: true, total_tasks: 3, plan_revision: 1 },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Cycle 1 passed',
            },
        ],
        append: () => assert.fail('should not append'),
    };
    const ledgerMismatched = createQualityLedger({
        authorityStore: storeMismatched,
        readDiffFingerprint: () => DIFF_SHA256,
    });
    assert.throws(
        () => ledgerMismatched.recordCycle({
            cycle_index: 2,
            total_tasks: 3,
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );

    // 2. attempt: 99 in details
    const storeAttempt99 = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'TASK_VERIFIED' }, 'TASK-3': { state: 'TASK_VERIFIED' } },
            gates: {},
        }),
        readEvents: () => [
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-1',
                cycle_index: 1,
                status: 'PASSED',
                details: { cycle_index: 1, attempt: 99, required: true, total_tasks: 3, plan_revision: 1 },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Cycle 1 passed',
            },
        ],
        append: () => assert.fail('should not append'),
    };
    const ledgerAttempt99 = createQualityLedger({
        authorityStore: storeAttempt99,
        readDiffFingerprint: () => DIFF_SHA256,
    });
    assert.throws(
        () => ledgerAttempt99.recordCycle({
            cycle_index: 2,
            total_tasks: 3,
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );

    // 3. Later cycle record (quality-cycle-2) appears in event log before earlier cycle (quality-cycle-1)
    const storeReversed = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'TASK_VERIFIED' }, 'TASK-3': { state: 'TASK_VERIFIED' } },
            gates: {},
        }),
        readEvents: () => [
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-2',
                cycle_index: 2,
                status: 'PASSED',
                details: { cycle_index: 2, attempt: 1, required: true, total_tasks: 3, plan_revision: 1 },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Cycle 2 passed',
            },
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-1',
                cycle_index: 1,
                status: 'PASSED',
                details: { cycle_index: 1, attempt: 1, required: true, total_tasks: 3, plan_revision: 1 },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Cycle 1 passed',
            },
        ],
        append: () => assert.fail('should not append'),
    };
    const ledgerReversed = createQualityLedger({
        authorityStore: storeReversed,
        readDiffFingerprint: () => DIFF_SHA256,
    });
    assert.throws(
        () => ledgerReversed.recordCycle({
            cycle_index: 3,
            total_tasks: 3,
            completed_task_ids: ['TASK-1', 'TASK-2', 'TASK-3'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );
});

test('Review2-Finding 3: nonzero command exit code blocks cycle pass even if gates passed, and requires safe integer duration_ms', () => {
    const fakeStore = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' }, 'TASK-2': { state: 'REGISTERED' }, 'TASK-3': { state: 'REGISTERED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: (event) => event,
    };
    const ledger = createQualityLedger({
        authorityStore: fakeStore,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    // Float duration_ms (1.5) must be rejected
    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 3,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 1.5 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );

    // Nonzero exit_code (1) with all gates PASSED must NOT result in aggregate PASSED
    const result = ledger.recordCycle({
        cycle_index: 1,
        total_tasks: 3,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: DIFF_SHA256,
        gate_results: [{ id: 't', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 1, duration_ms: 100 }],
        evidence_sha256: DUMMY_SHA256,
        attempt: 1,
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.verdict, 'BLOCKED');
    assert.ok(result.blockers.some((b) => b.id.includes('command') || b.reason.includes('code 1')));
});

// ==========================================
// Codex Review 3 P0 Regression Tests
// ==========================================

test('Review3-Finding 1: history validator rejects forged or minimal quality event (missing details, diff, threshold, commands, blockers, or unverified tasks)', () => {
    // Minimal prior event lacking rich recorder details
    const storeMinimal = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 1, total_tasks: 1 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' } },
            gates: {},
        }),
        readEvents: () => [
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-1',
                cycle_index: 1,
                status: 'PASSED',
                details: {
                    cycle_index: 1,
                    attempt: 1,
                    required: true,
                    total_tasks: 1,
                    plan_revision: 1,
                },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Quality cycle 1 passed',
            },
        ],
        append: () => assert.fail('should not append'),
    };

    const ledgerMinimal = createQualityLedger({
        authorityStore: storeMinimal,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledgerMinimal.recordCycle({
            cycle_index: 2,
            total_tasks: 1,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_CORRUPT_HISTORY' || err.name === 'DualQualityError'
    );
});

test('Review3-Finding 2: rejects recording a lower cycle when history already contains a future cycle event', () => {
    const storeWithCycle3 = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 3, total_tasks: 3 },
            tasks: {
                'TASK-1': { state: 'TASK_VERIFIED' },
                'TASK-2': { state: 'TASK_VERIFIED' },
                'TASK-3': { state: 'TASK_VERIFIED' },
            },
            gates: {},
        }),
        readEvents: () => [
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-1',
                cycle_index: 1,
                status: 'PASSED',
                details: {
                    required: true,
                    cycle_index: 1,
                    attempt: 1,
                    threshold: 1,
                    total_tasks: 3,
                    completed_task_ids: ['TASK-1'],
                    plan_revision: 1,
                    diff_fingerprint: DIFF_SHA256,
                    commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                    verdict: 'PASSED',
                    blockers: [],
                },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Quality cycle 1 passed (attempt 1)',
            },
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-2',
                cycle_index: 2,
                status: 'PASSED',
                details: {
                    required: true,
                    cycle_index: 2,
                    attempt: 1,
                    threshold: 2,
                    total_tasks: 3,
                    completed_task_ids: ['TASK-1', 'TASK-2'],
                    plan_revision: 1,
                    diff_fingerprint: DIFF_SHA256,
                    commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                    verdict: 'PASSED',
                    blockers: [],
                },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Quality cycle 2 passed (attempt 1)',
            },
            {
                type: 'gate.result',
                gate_id: 'quality-cycle-3',
                cycle_index: 3,
                status: 'FAILED',
                details: {
                    required: true,
                    cycle_index: 3,
                    attempt: 1,
                    threshold: 3,
                    total_tasks: 3,
                    completed_task_ids: ['TASK-1', 'TASK-2', 'TASK-3'],
                    plan_revision: 1,
                    diff_fingerprint: DIFF_SHA256,
                    commands: [{ command: 'npm test', exit_code: 1, duration_ms: 100 }],
                    verdict: 'BLOCKED',
                    blockers: [{ id: 'cmd', required: true, status: 'FAILED', reason: 'fail' }],
                },
                evidence_sha256: DUMMY_SHA256,
                reason: 'Quality cycle 3 failed (attempt 1)',
            },
        ],
        append: () => assert.fail('should not append'),
    };

    const ledger = createQualityLedger({
        authorityStore: storeWithCycle3,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    // Attempting to record cycle 2 when cycle 3 already exists in history must throw
    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 2,
            total_tasks: 3,
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 2,
        }),
        (err) => err.code === 'DUAL_QUALITY_LATER_CYCLE_EXISTS' || err.name === 'DualQualityError'
    );
});

test('Review3-Finding 3: recordCycle requires strict append acknowledgement (throws DUAL_QUALITY_INVALID_APPEND_ACK if store returns undefined or mismatched ack)', () => {
    // 1. Returns undefined
    const storeUndef = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 1, total_tasks: 1 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: () => undefined,
    };

    const ledgerUndef = createQualityLedger({
        authorityStore: storeUndef,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledgerUndef.recordCycle({
            cycle_index: 1,
            total_tasks: 1,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_INVALID_APPEND_ACK' || err.name === 'DualQualityError'
    );

    // 2. Returns mismatched status
    const storeMismatched = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 1, total_tasks: 1 },
            tasks: { 'TASK-1': { state: 'TASK_VERIFIED' } },
            gates: {},
        }),
        readEvents: () => [],
        append: (event) => ({ ...event, status: 'FAILED' }),
    };

    const ledgerMismatched = createQualityLedger({
        authorityStore: storeMismatched,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    assert.throws(
        () => ledgerMismatched.recordCycle({
            cycle_index: 1,
            total_tasks: 1,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        (err) => err.code === 'DUAL_QUALITY_INVALID_APPEND_ACK' || err.name === 'DualQualityError'
    );
});

test('Review3-Finding 4: rejects total_tasks > 1024 and completed_task_ids.length > total_tasks', () => {
    const store = {
        derive: () => ({
            planRevision: 1,
            plan: { totalTasks: 2000, total_tasks: 2000 },
            tasks: {},
            gates: {},
        }),
        readEvents: () => [],
        append: () => assert.fail('should not append'),
    };

    const ledger = createQualityLedger({
        authorityStore: store,
        readDiffFingerprint: () => DIFF_SHA256,
    });

    // total_tasks > 1024
    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 1025,
            completed_task_ids: ['TASK-1'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );

    // completed_task_ids.length > total_tasks
    assert.throws(
        () => ledger.recordCycle({
            cycle_index: 1,
            total_tasks: 1,
            completed_task_ids: ['TASK-1', 'TASK-2'],
            plan_revision: 1,
            diff_fingerprint: DIFF_SHA256,
            gate_results: [{ id: 't', required: true, status: 'PASSED' }],
            commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            evidence_sha256: DUMMY_SHA256,
            attempt: 1,
        }),
        /DualQualityError/
    );
});
