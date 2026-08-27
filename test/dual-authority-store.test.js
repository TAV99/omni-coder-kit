'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createAuthorityStore,
    DualAuthorityError,
    canonicalizeEvent,
    computeEventHash,
    computeLeaseStatus,
} = require('../lib/dual/authority-store');
const dualIndex = require('../lib/dual/index');

const WORKSPACE_ID = 'ws-test-123';
const SESSION_ID = 'sess-test-456';
const BASELINE_GIT = { kind: 'git', id: 'a'.repeat(40) };
const BASELINE_SNAPSHOT = { kind: 'snapshot', id: 'b'.repeat(64) };
const BASELINE_GIT_PROMOTED = { kind: 'git', id: 'c'.repeat(40) };

function createFakeClock(startIso = '2026-08-25T00:00:00.000Z') {
    let currentMs = new Date(startIso).getTime();
    function clock() {
        return new Date(currentMs);
    }
    clock.advance = (ms) => {
        currentMs += ms;
        return clock();
    };
    clock.set = (isoString) => {
        currentMs = new Date(isoString).getTime();
        return clock();
    };
    clock.iso = () => new Date(currentMs).toISOString();
    return clock;
}

function createDeterministicUuid() {
    let counter = 0;
    return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
}

function makeSessionDir(t) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-auth-'));
    t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
    return sessionDir;
}

function makeStore(t, options = {}) {
    const sessionDir = makeSessionDir(t);
    const clock = options.clock || createFakeClock();
    const uuid = options.uuid || createDeterministicUuid();
    const store = createAuthorityStore(sessionDir, {
        clock,
        uuid,
        ...options,
    });
    return { sessionDir, clock, uuid, store };
}

function createSessionCreatedEvent(overrides = {}) {
    return {
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:00.000Z',
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: '.',
        mode: 'auto',
        ...overrides,
    };
}

test('authority store module and error classes are exported through lib/dual/index', () => {
    assert.equal(typeof createAuthorityStore, 'function');
    assert.equal(typeof DualAuthorityError, 'function');
    assert.equal(typeof dualIndex.createAuthorityStore, 'function');
    assert.equal(typeof dualIndex.DualAuthorityError, 'function');
});

test('canonicalizeEvent produces deterministic recursively key-sorted JSON', () => {
    const objA = { z: 1, a: 2, m: { y: 'hello', x: 'world' }, arr: [{ b: 1, a: 2 }, 3] };
    const objB = { arr: [{ a: 2, b: 1 }, 3], m: { x: 'world', y: 'hello' }, a: 2, z: 1 };
    assert.equal(canonicalizeEvent(objA), canonicalizeEvent(objB));
    assert.equal(
        canonicalizeEvent(objA),
        '{"a":2,"arr":[{"a":2,"b":1},3],"m":{"x":"world","y":"hello"},"z":1}'
    );
});

test('computes cryptographic SHA-256 hash over previous hash and canonical payload', () => {
    const prevHash = '0'.repeat(64);
    const event = createSessionCreatedEvent();
    const hash = computeEventHash(prevHash, event);
    assert.match(hash, /^[0-9a-f]{64}$/);

    const expectedPayload = `${prevHash}${canonicalizeEvent(event)}`;
    const expectedHash = crypto.createHash('sha256').update(expectedPayload).digest('hex');
    assert.equal(hash, expectedHash);
});

test('appends initial session.created event and reconstructs derived state', (t) => {
    const { sessionDir, store } = makeStore(t);

    const event = store.append(createSessionCreatedEvent());
    assert.equal(event.sequence, 1);
    assert.equal(event.type, 'session.created');

    const events = store.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session.created');

    const derived = store.derive();
    assert.equal(derived.sessionId, SESSION_ID);
    assert.equal(derived.workspaceId, WORKSPACE_ID);
    assert.equal(derived.workspaceRoot, '.');
    assert.equal(derived.mode, 'auto');
    assert.equal(derived.sessionState, 'DISCOVERED');
    assert.equal(derived.planRevision, 1);
    assert.deepEqual(derived.currentBaseline, BASELINE_GIT);
    assert.equal(derived.lastSequence, 1);
    assert.match(derived.lastHash, /^[0-9a-f]{64}$/);
    assert.equal(derived.lastEventId, event.event_id);

    const integrity = store.verifyIntegrity();
    assert.equal(integrity.valid, true);
    assert.equal(integrity.eventCount, 1);
    assert.equal(integrity.lastSequence, 1);
});

test('enforces append durability with fs.openSync(a), fsyncSync, and closeSync', (t) => {
    const sessionDir = makeSessionDir(t);
    const fsCalls = [];
    const realFs = fs;

    const fsSeam = {
        ...realFs,
        openSync(...args) {
            fsCalls.push({ method: 'openSync', flags: args[1] });
            return realFs.openSync(...args);
        },
        writeSync(...args) {
            fsCalls.push({ method: 'writeSync' });
            return realFs.writeSync(...args);
        },
        fsyncSync(...args) {
            fsCalls.push({ method: 'fsyncSync' });
            return realFs.fsyncSync(...args);
        },
        closeSync(...args) {
            fsCalls.push({ method: 'closeSync' });
            return realFs.closeSync(...args);
        },
    };

    const store = createAuthorityStore(sessionDir, {
        fsImpl: fsSeam,
        clock: createFakeClock(),
        uuid: createDeterministicUuid(),
    });

    store.append(createSessionCreatedEvent());

    const methods = fsCalls.map((c) => c.method);
    assert.ok(methods.includes('openSync'));
    assert.ok(methods.includes('writeSync'));
    assert.ok(methods.includes('fsyncSync'));
    assert.ok(methods.includes('closeSync'));

    const openCall = fsCalls.find((c) => c.method === 'openSync');
    assert.equal(openCall.flags, 'a');

    const openIndex = methods.indexOf('openSync');
    const writeIndex = methods.indexOf('writeSync');
    const fsyncIndex = methods.indexOf('fsyncSync');
    const closeIndex = methods.indexOf('closeSync');
    assert.ok(openIndex < writeIndex, 'openSync before writeSync');
    assert.ok(writeIndex < fsyncIndex, 'writeSync before fsyncSync');
    assert.ok(fsyncIndex < closeIndex, 'fsyncSync before closeSync');
});

test('rejects first event that is not session.created or has sequence != 1', (t) => {
    const { store } = makeStore(t);

    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: '10000000-0000-4000-8000-000000000002',
            sequence: 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:00.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('rejects non-contiguous or non-monotonic sequences', (t) => {
    const { store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent());

    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: first.event_id,
            sequence: 3, // gap!
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('rejects duplicate event IDs across the ledger', (t) => {
    const { store } = makeStore(t);
    const duplicateId = '10000000-0000-4000-8000-000000000001';
    store.append(createSessionCreatedEvent({ event_id: duplicateId }));

    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: duplicateId, // duplicate!
            causation_id: duplicateId,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('rejects workspace or session correlation drift', (t) => {
    const { store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent());

    // Wrong workspace
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: first.event_id,
            sequence: 2,
            workspace_id: 'ws-different',
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // Wrong session
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000003',
            causation_id: first.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: 'sess-different',
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('rejects unknown or future causation reference', (t) => {
    const { store } = makeStore(t);
    store.append(createSessionCreatedEvent());

    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: '99999999-9999-4999-8999-999999999999', // unknown!
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('rejects decreasing plan revision', (t) => {
    const { store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent({ plan_revision: 2 }));

    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: first.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1, // decreasing: was 2, now 1!
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('rejects baseline drift without promotion', (t) => {
    const { store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent({ expected_baseline: BASELINE_SNAPSHOT }));

    // Unannounced drift to git baseline
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: first.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT, // drifted!
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('supports valid snapshot -> git baseline promotion and continuity thereafter', (t) => {
    const { store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent({ expected_baseline: BASELINE_SNAPSHOT }));

    // Promote snapshot to git
    const promoted = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: first.event_id,
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_SNAPSHOT,
        timestamp: '2026-08-25T00:00:01.000Z',
        type: 'baseline.promoted',
        from_baseline: BASELINE_SNAPSHOT,
        to_baseline: BASELINE_GIT_PROMOTED,
    });

    const derived = store.derive();
    assert.deepEqual(derived.currentBaseline, BASELINE_GIT_PROMOTED);

    // Next event with promoted git baseline succeeds
    const next = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: promoted.event_id,
        sequence: 3,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT_PROMOTED,
        timestamp: '2026-08-25T00:00:02.000Z',
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'codex-hooks', status: 'PASSED' }],
    });
    assert.equal(next.sequence, 3);
    assert.equal(store.readEvents().length, 3);

    // Attempting old snapshot baseline after promotion is rejected
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000004',
            causation_id: next.event_id,
            sequence: 4,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_SNAPSHOT, // old baseline!
            timestamp: '2026-08-25T00:00:03.000Z',
            type: 'session.blocked',
            from_state: 'CAPABILITY_SAFE',
            to_state: 'BLOCKED',
            reason: 'Test failure',
            blocker_code: 'TEST_FAIL',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('detects cryptographic hash tampering in NDJSON log', (t) => {
    const { sessionDir, store } = makeStore(t);
    store.append(createSessionCreatedEvent());
    const eventsPath = path.join(sessionDir, 'events.ndjson');

    // Tamper with payload
    const content = fs.readFileSync(eventsPath, 'utf8');
    const envelope = JSON.parse(content.trim());
    envelope.event.workspace_root = './tampered';
    fs.writeFileSync(eventsPath, `${JSON.stringify(envelope)}\n`, 'utf8');

    assert.throws(
        () => store.readEvents(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    assert.throws(
        () => store.verifyIntegrity(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('detects previous_hash tampering in hash chain', (t) => {
    const { sessionDir, store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent());
    store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: first.event_id,
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:01.000Z',
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'codex-hooks', status: 'PASSED' }],
    });

    const eventsPath = path.join(sessionDir, 'events.ndjson');
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    const env2 = JSON.parse(lines[1]);
    env2.previous_hash = 'f'.repeat(64); // corrupted chain!
    lines[1] = JSON.stringify(env2);
    fs.writeFileSync(eventsPath, `${lines.join('\n')}\n`, 'utf8');

    assert.throws(
        () => store.derive(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('malformed complete line blocks replay', (t) => {
    const { sessionDir, store } = makeStore(t);
    store.append(createSessionCreatedEvent());
    const eventsPath = path.join(sessionDir, 'events.ndjson');

    fs.appendFileSync(eventsPath, '{"broken json line\n', 'utf8');

    assert.throws(
        () => store.readEvents(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('incomplete trailing line without newline is safely ignored and uncommitted', (t) => {
    const { sessionDir, store } = makeStore(t);
    store.append(createSessionCreatedEvent());
    const eventsPath = path.join(sessionDir, 'events.ndjson');

    // Append partial line without trailing newline
    fs.appendFileSync(eventsPath, '{"previous_hash":"0000', 'utf8');

    // Replay succeeds and returns only the 1 complete event
    const events = store.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session.created');

    const derived = store.derive();
    assert.equal(derived.sessionState, 'DISCOVERED');
});

function setupRoutedSession(store, options = {}) {
    const baseline = options.baseline || BASELINE_GIT;
    const e1 = store.append(createSessionCreatedEvent({
        expected_baseline: baseline,
        ...(options.createdOverrides || {}),
    }));
    const e2 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: baseline,
        timestamp: '2026-08-25T00:00:01.000Z',
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'codex-hooks', status: 'PASSED' }],
    });
    const tasks = options.tasks || [
        { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/a.js'] },
        { task_id: 'TASK-2', title: 'Task 2', owner: 'codex', allowed_files: ['lib/b.js'] },
    ];
    const e3 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: baseline,
        timestamp: '2026-08-25T00:00:02.000Z',
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'd'.repeat(64),
        total_tasks: tasks.length,
        tasks,
    });
    const e4 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: baseline,
        timestamp: '2026-08-25T00:00:03.000Z',
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        model: 'gemini-3.7-flash-high',
        effort: 'high',
        token_budget: 10000,
        allowed_files: ['lib/a.js'],
        reason: 'Bounded file implementation',
    });
    let e5 = null;
    if (tasks.some((t) => t.task_id === 'TASK-2')) {
        e5 = store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000005',
            causation_id: e4.event_id,
            sequence: 5,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: baseline,
            timestamp: '2026-08-25T00:00:03.500Z',
            type: 'task.routed',
            task_id: 'TASK-2',
            owner: 'codex',
            authority_state: 'ROUTED',
            allowed_files: ['lib/b.js'],
            reason: 'Codex task routed',
        });
    }
    return { e1, e2, e3, e4, e5, lastEvent: e5 || e4 };
}

test('reconstructs complete session lifecycle and task states across full flow', (t) => {
    const { store } = makeStore(t);
    const e1 = store.append(createSessionCreatedEvent());

    const e2 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:01.000Z',
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'codex-hooks', status: 'PASSED' }],
    });

    const e3 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:02.000Z',
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'd'.repeat(64),
        total_tasks: 2,
        tasks: [
            { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/a.js'] },
            { task_id: 'TASK-2', title: 'Task 2', owner: 'codex', allowed_files: ['lib/b.js'] },
        ],
    });

    const e4 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:03.000Z',
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        model: 'gemini-3.7-flash-high',
        effort: 'high',
        token_budget: 10000,
        allowed_files: ['lib/a.js'],
        reason: 'Bounded file implementation',
    });

    const e5 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000005',
        causation_id: e4.event_id,
        sequence: 5,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:04.000Z',
        type: 'lease.acquired',
        lease_id: '20000000-0000-4000-8000-000000000001',
        task_id: 'TASK-1',
        owner: 'agy',
        acquired_at: '2026-08-25T00:00:04.000Z',
        expires_at: '2026-08-25T00:00:34.000Z',
        ttl_ms: 30000,
    });

    const e6 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000006',
        causation_id: e5.event_id,
        sequence: 6,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:05.000Z',
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/a.js'],
        diff_fingerprint: 'e'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });

    let derived = store.derive();
    assert.equal(derived.tasks['TASK-1'].state, 'TASK_VERIFIED');
    assert.equal(derived.tasks['TASK-2'].state, 'REGISTERED');
    assert.equal(derived.sessionState, 'EXECUTING');

    const e7 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000007',
        causation_id: e6.event_id,
        sequence: 7,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:06.000Z',
        type: 'task.routed',
        task_id: 'TASK-2',
        owner: 'codex',
        authority_state: 'ROUTED',
        allowed_files: ['lib/b.js'],
        reason: 'Codex task',
    });

    const e8 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000008',
        causation_id: e7.event_id,
        sequence: 8,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:07.000Z',
        type: 'lease.acquired',
        lease_id: '20000000-0000-4000-8000-000000000002',
        task_id: 'TASK-2',
        owner: 'codex',
        acquired_at: '2026-08-25T00:00:07.000Z',
        expires_at: '2026-08-25T00:00:37.000Z',
        ttl_ms: 30000,
    });

    const e9 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000009',
        causation_id: e8.event_id,
        sequence: 9,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:08.000Z',
        type: 'task.completed',
        task_id: 'TASK-2',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/b.js'],
        diff_fingerprint: 'f'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });

    derived = store.derive();
    assert.equal(derived.tasks['TASK-2'].state, 'TASK_VERIFIED');
    assert.equal(derived.sessionState, 'ACCEPTANCE');

    const e10 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000010',
        causation_id: e9.event_id,
        sequence: 10,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:09.000Z',
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: '1'.repeat(64),
        completed_tasks: ['TASK-1', 'TASK-2'],
    });

    derived = store.derive();
    assert.equal(derived.sessionState, 'VERIFIED');
    assert.equal(derived.lastSequence, 10);
    assert.equal(derived.lastEventId, e10.event_id);
    assert.deepEqual(derived.receipt.completedTasks, ['TASK-1', 'TASK-2']);
});

test('lease lifecycle: acquire, prevent duplicate active, renew before expiry, release', (t) => {
    const { clock, store } = makeStore(t);
    setupRoutedSession(store);

    // 1. Acquire lease for TASK-1 (owner: agy)
    const lease1 = store.acquireLease('TASK-1', 'agy');
    assert.match(lease1.lease_id, /^[0-9a-f-]{36}$/);
    assert.equal(lease1.task_id, 'TASK-1');
    assert.equal(lease1.owner, 'agy');
    assert.equal(lease1.ttl_ms, 30000);
    assert.equal(lease1.status, 'active');

    let derived = store.derive();
    assert.equal(derived.leases[lease1.lease_id].status, 'active');
    assert.equal(derived.leases[lease1.lease_id].owner, 'agy');

    // 2. Reject duplicate active lease for same task
    assert.throws(
        () => store.acquireLease('TASK-1', 'agy'),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_ACTIVE');
            return true;
        }
    );

    // 3. Acquire concurrent lease for DIFFERENT task succeeds
    const lease2 = store.acquireLease('TASK-2', 'codex');
    assert.equal(lease2.task_id, 'TASK-2');
    assert.equal(lease2.owner, 'codex');

    // 4. Advance clock by 10s and renew lease1 before expiry
    clock.advance(10000);
    const renewed = store.renewLease(lease1.lease_id);
    assert.equal(renewed.lease_id, lease1.lease_id);
    assert.equal(renewed.task_id, 'TASK-1');

    derived = store.derive();
    assert.equal(derived.leases[lease1.lease_id].status, 'active');
    assert.ok(derived.leases[lease1.lease_id].renewed_at);

    // 5. Release lease2 with deterministic reason
    const released = store.releaseLease(lease2.lease_id, 'manual_finish');
    assert.equal(released.lease_id, lease2.lease_id);

    derived = store.derive();
    assert.equal(derived.leases[lease2.lease_id].status, 'released');
    assert.equal(derived.leases[lease2.lease_id].release_reason, 'manual_finish');
});

test('lease expiry: status is expired, reacquisition is allowed, no success inferred', (t) => {
    const { clock, store } = makeStore(t);
    setupRoutedSession(store);

    const lease = store.acquireLease('TASK-1', 'agy');
    clock.advance(10000);
    store.renewLease(lease.lease_id);

    // Advance 31 seconds after renewal -> lease expires (30s TTL)
    clock.advance(31000);

    const derived = store.derive();
    assert.equal(derived.leases[lease.lease_id].status, 'expired');
    // Critical: expiry alone never sets TASK_VERIFIED
    assert.notEqual(derived.tasks['TASK-1']?.state, 'TASK_VERIFIED');

    // Reject renew after expiry
    assert.throws(
        () => store.renewLease(lease.lease_id),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_EXPIRED');
            return true;
        }
    );

    // Reject release after expiry
    assert.throws(
        () => store.releaseLease(lease.lease_id),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_EXPIRED');
            return true;
        }
    );

    // Expired lease is recoverable by new acquire by matching owner
    const newLease = store.acquireLease('TASK-1', 'agy');
    assert.notEqual(newLease.lease_id, lease.lease_id);
    assert.equal(newLease.owner, 'agy');
    assert.equal(store.derive().leases[newLease.lease_id].status, 'active');
});

test('lease operations reject uninitialized session, non-canonical owner, or unrouted task', (t) => {
    const { store } = makeStore(t);

    // Reject before session.created
    assert.throws(
        () => store.acquireLease('TASK-1', 'agy'),
        (err) => {
            assert.equal(err.code, 'DUAL_SESSION_NOT_INITIALIZED');
            return true;
        }
    );

    store.append(createSessionCreatedEvent());

    // Reject non-canonical owner (e.g. 'gemini' or 'other')
    assert.throws(
        () => store.acquireLease('TASK-1', 'gemini'),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_INVALID');
            return true;
        }
    );

    // Reject lease acquisition before task is routed
    assert.throws(
        () => store.acquireLease('TASK-1', 'agy'),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_INVALID');
            return true;
        }
    );
});

test('verifyIntegrity passes on clean ledger and throws on corruption', (t) => {
    const { sessionDir, store } = makeStore(t);
    store.append(createSessionCreatedEvent());

    const result = store.verifyIntegrity();
    assert.equal(result.valid, true);
    assert.equal(result.eventCount, 1);
    assert.equal(result.lastSequence, 1);

    // Truncate file mid-json
    const eventsPath = path.join(sessionDir, 'events.ndjson');
    fs.writeFileSync(eventsPath, '{"broken"\n');

    assert.throws(
        () => store.verifyIntegrity(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

// ============================================================================
// REGRESSION & NEGATIVE TESTS FOR TASK 4 CODEX REVIEW FINDINGS
// ============================================================================

test('Fix 1: rejects non-genesis event self-causation with DUAL_INTEGRITY_CORRUPT', (t) => {
    const { store } = makeStore(t);
    const e1 = store.append(createSessionCreatedEvent());

    const selfCausingId = '10000000-0000-4000-8000-000000000002';
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: selfCausingId,
            causation_id: selfCausingId, // Self-causation on sequence 2!
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('Fix 1: rejects non-genesis event referencing unknown or future causation ID', (t) => {
    const { store } = makeStore(t);
    store.append(createSessionCreatedEvent());

    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: '99999999-9999-4999-8999-999999999999', // Unknown/future causation
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        }),
        (err) => {
            assert.equal(err.name, 'DualAuthorityError');
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('Fix 2: rejects committed empty newline-terminated lines at start, middle, and end', (t) => {
    const { sessionDir, store } = makeStore(t);
    const eventsPath = path.join(sessionDir, 'events.ndjson');

    // 1. Blank line at start
    const validEnvelope1 = {
        previous_hash: '0'.repeat(64),
        event: createSessionCreatedEvent(),
    };
    validEnvelope1.event_hash = computeEventHash(validEnvelope1.previous_hash, validEnvelope1.event);

    fs.writeFileSync(eventsPath, `\n${JSON.stringify(validEnvelope1)}\n`, 'utf8');
    assert.throws(
        () => store.readEvents(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 2. Blank line in the middle
    const validEnvelope2 = {
        previous_hash: validEnvelope1.event_hash,
        event: {
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: validEnvelope1.event.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            status: 'PASSED',
            checks: [{ name: 'codex-hooks', status: 'PASSED' }],
        },
    };
    validEnvelope2.event_hash = computeEventHash(validEnvelope2.previous_hash, validEnvelope2.event);

    fs.writeFileSync(
        eventsPath,
        `${JSON.stringify(validEnvelope1)}\n\n${JSON.stringify(validEnvelope2)}\n`,
        'utf8'
    );
    assert.throws(
        () => store.readEvents(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 3. Blank line at end before trailing newline
    fs.writeFileSync(
        eventsPath,
        `${JSON.stringify(validEnvelope1)}\n\n`,
        'utf8'
    );
    assert.throws(
        () => store.readEvents(),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('Fix 3: baseline.promoted requires expected_baseline to equal current baseline before promotion', (t) => {
    const { store } = makeStore(t);
    const first = store.append(createSessionCreatedEvent({ expected_baseline: BASELINE_SNAPSHOT }));

    // Attempt promotion with mismatching expected_baseline
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: first.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT_PROMOTED, // Mismatch with current snapshot baseline!
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'baseline.promoted',
            from_baseline: BASELINE_SNAPSHOT,
            to_baseline: BASELINE_GIT_PROMOTED,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // Attempt promotion with from_baseline mismatching current snapshot baseline
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: first.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_SNAPSHOT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'baseline.promoted',
            from_baseline: { kind: 'snapshot', id: 'f'.repeat(64) }, // Mismatch!
            to_baseline: BASELINE_GIT_PROMOTED,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('Fix 4: replay lease invariants fail closed on duplicate, invalid expiry math, unknown lease, and released lease', (t) => {
    const { store } = makeStore(t);
    const { lastEvent } = setupRoutedSession(store);

    // 1. Acquired expiry math mismatch: expires_at != acquired_at + ttl_ms
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000011',
            causation_id: lastEvent.event_id,
            sequence: lastEvent.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:04.000Z',
            type: 'lease.acquired',
            lease_id: '30000000-0000-4000-8000-000000000001',
            task_id: 'TASK-1',
            owner: 'agy',
            acquired_at: '2026-08-25T00:00:04.000Z',
            expires_at: '2026-08-25T00:00:50.000Z', // 46s != 30s TTL
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 2. Acquire valid lease
    const l1 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000012',
        causation_id: lastEvent.event_id,
        sequence: lastEvent.sequence + 1,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:04.000Z',
        type: 'lease.acquired',
        lease_id: '30000000-0000-4000-8000-000000000001',
        task_id: 'TASK-1',
        owner: 'agy',
        acquired_at: '2026-08-25T00:00:04.000Z',
        expires_at: '2026-08-25T00:00:34.000Z',
        ttl_ms: 30000,
    });

    // 3. Duplicate lease_id acquisition rejection
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000013',
            causation_id: l1.event_id,
            sequence: l1.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:05.000Z',
            type: 'lease.acquired',
            lease_id: '30000000-0000-4000-8000-000000000001', // Duplicate lease_id!
            task_id: 'TASK-2',
            owner: 'codex',
            acquired_at: '2026-08-25T00:00:05.000Z',
            expires_at: '2026-08-25T00:00:35.000Z',
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 4. lease.renewed for unknown lease_id
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000014',
            causation_id: l1.event_id,
            sequence: l1.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:10.000Z',
            type: 'lease.renewed',
            lease_id: '30000000-0000-4000-8000-999999999999', // Unknown lease!
            task_id: 'TASK-1',
            renewed_at: '2026-08-25T00:00:10.000Z',
            expires_at: '2026-08-25T00:00:40.000Z',
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 5. lease.renewed with task_id mismatch
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000015',
            causation_id: l1.event_id,
            sequence: l1.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:10.000Z',
            type: 'lease.renewed',
            lease_id: '30000000-0000-4000-8000-000000000001',
            task_id: 'TASK-2', // Mismatch! Lease is for TASK-1
            renewed_at: '2026-08-25T00:00:10.000Z',
            expires_at: '2026-08-25T00:00:40.000Z',
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 6. lease.renewed after prior expiry
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000016',
            causation_id: l1.event_id,
            sequence: l1.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:35.000Z', // After 00:00:34 expiry!
            type: 'lease.renewed',
            lease_id: '30000000-0000-4000-8000-000000000001',
            task_id: 'TASK-1',
            renewed_at: '2026-08-25T00:00:35.000Z',
            expires_at: '2026-08-25T00:01:05.000Z',
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 7. lease.renewed with expiry math mismatch
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000017',
            causation_id: l1.event_id,
            sequence: l1.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:10.000Z',
            type: 'lease.renewed',
            lease_id: '30000000-0000-4000-8000-000000000001',
            task_id: 'TASK-1',
            renewed_at: '2026-08-25T00:00:10.000Z',
            expires_at: '2026-08-25T00:00:50.000Z', // Math mismatch! 40s != 30s
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 8. Release lease
    const rel = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000018',
        causation_id: l1.event_id,
        sequence: l1.sequence + 1,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:15.000Z',
        type: 'lease.released',
        lease_id: '30000000-0000-4000-8000-000000000001',
        task_id: 'TASK-1',
        released_at: '2026-08-25T00:00:15.000Z',
        reason: 'done',
    });

    // 9. Cannot renew released lease
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000019',
            causation_id: rel.event_id,
            sequence: rel.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:20.000Z',
            type: 'lease.renewed',
            lease_id: '30000000-0000-4000-8000-000000000001',
            task_id: 'TASK-1',
            renewed_at: '2026-08-25T00:00:20.000Z',
            expires_at: '2026-08-25T00:00:50.000Z',
            ttl_ms: 30000,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 10. Cannot release released lease again
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000020',
            causation_id: rel.event_id,
            sequence: rel.sequence + 1,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:22.000Z',
            type: 'lease.released',
            lease_id: '30000000-0000-4000-8000-000000000001',
            task_id: 'TASK-1',
            released_at: '2026-08-25T00:00:22.000Z',
            reason: 'again',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('Fix 5: authority and task transitions enforce strict invariants', (t) => {
    const { store } = makeStore(t);
    const e1 = store.append(createSessionCreatedEvent());

    // 1. plan.registered directly from DISCOVERED (without CAPABILITY_SAFE) is rejected
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000002',
            causation_id: e1.event_id,
            sequence: 2,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:01.000Z',
            type: 'plan.registered',
            from_state: 'INTERVIEWING',
            to_state: 'PLANNED',
            plan_path: 'plans/plan.md',
            plan_sha256: 'd'.repeat(64),
            total_tasks: 1,
            tasks: [{ task_id: 'TASK-1', title: 'T1', owner: 'agy', allowed_files: ['a.js'] }],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // Pass capability check
    const e2 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:01.000Z',
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'codex-hooks', status: 'PASSED' }],
    });

    // 2. plan.registered with duplicate task IDs rejected
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000003',
            causation_id: e2.event_id,
            sequence: 3,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:02.000Z',
            type: 'plan.registered',
            from_state: 'INTERVIEWING',
            to_state: 'PLANNED',
            plan_path: 'plans/plan.md',
            plan_sha256: 'd'.repeat(64),
            total_tasks: 2,
            tasks: [
                { task_id: 'TASK-1', title: 'T1', owner: 'agy', allowed_files: ['a.js'] },
                { task_id: 'TASK-1', title: 'Duplicate T1', owner: 'codex', allowed_files: ['b.js'] },
            ],
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // Register valid plan with TASK-1 and TASK-2
    const e3 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:02.000Z',
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'd'.repeat(64),
        total_tasks: 2,
        tasks: [
            { task_id: 'TASK-1', title: 'T1', owner: 'agy', allowed_files: ['a.js'] },
            { task_id: 'TASK-2', title: 'T2', owner: 'codex', allowed_files: ['b.js'] },
        ],
    });

    // 3. task.routed for unregistered task rejected
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000004',
            causation_id: e3.event_id,
            sequence: 4,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:03.000Z',
            type: 'task.routed',
            task_id: 'TASK-UNREGISTERED',
            owner: 'agy',
            authority_state: 'ROUTED',
            allowed_files: ['a.js'],
            reason: 'unregistered',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 4. lease acquisition for unrouted task rejected
    assert.throws(
        () => store.acquireLease('TASK-1', 'agy'),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_INVALID');
            return true;
        }
    );

    // Route TASK-1
    const e4 = store.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:03.000Z',
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['a.js'],
        reason: 'routed',
    });

    // 5. lease acquisition with owner mismatch or unrouted task rejected
    assert.throws(
        () => store.acquireLease('TASK-2', 'agy'),
        (err) => {
            assert.equal(err.code, 'DUAL_LEASE_INVALID');
            return true;
        }
    );

    // 6. task.completed without an active lease rejected
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000005',
            causation_id: e4.event_id,
            sequence: 5,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:04.000Z',
            type: 'task.completed',
            task_id: 'TASK-1',
            owner: 'agy',
            authority_state: 'TASK_VERIFIED',
            modified_files: ['a.js'],
            diff_fingerprint: '1'.repeat(64),
            verdict: 'SUCCESS',
            verified_by: 'codex',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );

    // 7. session.blocked with mismatched from_state rejected
    assert.throws(
        () => store.append({
            schema_version: 2,
            event_id: '10000000-0000-4000-8000-000000000005',
            causation_id: e4.event_id,
            sequence: 5,
            workspace_id: WORKSPACE_ID,
            session_id: SESSION_ID,
            plan_revision: 1,
            expected_baseline: BASELINE_GIT,
            timestamp: '2026-08-25T00:00:04.000Z',
            type: 'session.blocked',
            from_state: 'DISCOVERED', // Current derived state is EXECUTING!
            to_state: 'BLOCKED',
            reason: 'blocked reason',
            blocker_code: 'ERR_1',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_INTEGRITY_CORRUPT');
            return true;
        }
    );
});

test('Fix 6: handles partial fs.writeSync writes in a loop before fsync', (t) => {
    const sessionDir = makeSessionDir(t);
    const realFs = fs;
    let writeCalls = 0;

    const partialFsSeam = {
        ...realFs,
        writeSync(fd, buffer, offset, length, position) {
            writeCalls += 1;
            // Write at most 17 bytes per writeSync invocation
            const chunk = Math.min(17, length);
            return realFs.writeSync(fd, buffer, offset, chunk, position);
        },
    };

    const store = createAuthorityStore(sessionDir, {
        fsImpl: partialFsSeam,
        clock: createFakeClock(),
        uuid: createDeterministicUuid(),
    });

    const event = store.append(createSessionCreatedEvent());
    assert.equal(event.sequence, 1);
    assert.ok(writeCalls > 1, `Expected multiple writeSync calls due to partial write chunking, got ${writeCalls}`);

    const eventsPath = path.join(sessionDir, 'events.ndjson');
    const content = fs.readFileSync(eventsPath, 'utf8');
    assert.match(content, /\n$/);
    const record = JSON.parse(content.trim());
    assert.equal(record.event.event_id, event.event_id);

    const integrity = store.verifyIntegrity();
    assert.equal(integrity.valid, true);
});

test('Fix 7: lease operations sample clock exactly once per operation for deterministic timestamps and expiry', (t) => {
    const sessionDir = makeSessionDir(t);
    let clockCallCount = 0;
    let baseTime = new Date('2026-08-25T00:00:00.000Z').getTime();

    // Clock increments by 100ms on EVERY invocation to detect redundant clock() samples
    function volatileClock() {
        clockCallCount += 1;
        baseTime += 100;
        return new Date(baseTime);
    }

    const store = createAuthorityStore(sessionDir, {
        clock: volatileClock,
        uuid: createDeterministicUuid(),
    });

    setupRoutedSession(store);

    const lease = store.acquireLease('TASK-1', 'agy');
    const acqMs = new Date(lease.acquired_at).getTime();
    const expMs = new Date(lease.expires_at).getTime();
    assert.equal(expMs, acqMs + 30000);

    const renewed = store.renewLease(lease.lease_id);
    const renMs = new Date(renewed.renewed_at).getTime();
    const renExpMs = new Date(renewed.expires_at).getTime();
    assert.equal(renExpMs, renMs + 30000);

    const released = store.releaseLease(lease.lease_id, 'done');
    assert.ok(released.released_at);
    assert.equal(released.status, 'released');
});

test('Slice 3C: replayAuthorityEvents retains capability result in derived state', (t) => {
    const { store } = makeStore(t);
    store.append(createSessionCreatedEvent());
    store.append({
        schema_version: 2,
        event_id: '20000000-0000-4000-8000-000000000002',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 2,
        workspace_id: WORKSPACE_ID,
        session_id: SESSION_ID,
        plan_revision: 1,
        expected_baseline: BASELINE_GIT,
        timestamp: '2026-08-25T00:00:01.000Z',
        type: 'capability.result',
        from_state: 'DISCOVERED',
        status: 'PASSED',
        checks: [
            { name: 'authority_ledger_integrity', status: 'PASSED' },
            { name: 'agy_cli_and_model', status: 'PASSED' },
        ],
        details: {
            agy_version: '1.1.19',
            agy_model: 'gemini-3.7-flash-high',
        },
        to_state: 'CAPABILITY_SAFE',
    });

    const derived = store.derive();
    assert.equal(derived.sessionState, 'CAPABILITY_SAFE');
    assert.ok(derived.capability);
    assert.equal(derived.capability.status, 'PASSED');
    assert.equal(derived.capability.to_state, 'CAPABILITY_SAFE');
    assert.equal(derived.capability.details.agy_version, '1.1.19');
    assert.equal(derived.capability.details.agy_model, 'gemini-3.7-flash-high');
});

