'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    STATES,
    canTransition,
    createStateStore,
    deriveState,
} = require('../lib/dual/state-store');
const { createArtifactStore } = require('../lib/dual/artifacts');

const TASK_ID = 'dual-state-test';
const BASE_COMMIT = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function makeRunDir(t) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-state-'));
    t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
    return runDir;
}

function makeEvent(overrides) {
    return {
        schema_version: 1,
        task_id: TASK_ID,
        expected_base_commit: BASE_COMMIT,
        event_id: crypto.randomUUID(),
        sequence: 1,
        timestamp: '2026-08-24T01:02:03.000Z',
        ...overrides,
    };
}

function makeStore(t) {
    const runDir = makeRunDir(t);
    let uuidIndex = 0;
    const store = createStateStore(runDir, {
        taskId: TASK_ID,
        expectedBaseCommit: BASE_COMMIT,
        clock: () => new Date('2026-08-24T01:02:03.000Z'),
        uuid: () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`,
    });
    return { runDir, store };
}

test('declares the exact legal state transitions', () => {
    const happy = [
        'NEW',
        'PREFLIGHT_SAFE',
        'SCOUT_VALID',
        'SPEC_VALID',
        'ROUTED',
        'IMPLEMENT_VALID',
        'SCOPE_VALID',
        'REVIEW_VALID',
        'CODEX_QC',
    ];

    assert.deepEqual(STATES, [
        'NEW',
        'PREFLIGHT_SAFE',
        'SCOUT_VALID',
        'SPEC_VALID',
        'ROUTED',
        'CODEX_OWNED',
        'IMPLEMENT_VALID',
        'SCOPE_VALID',
        'REVIEW_VALID',
        'CODEX_QC',
    ]);
    for (let index = 0; index < happy.length - 1; index += 1) {
        assert.equal(canTransition(happy[index], happy[index + 1]), true);
    }
    assert.equal(canTransition('ROUTED', 'CODEX_OWNED'), true);
    assert.equal(canTransition('PREFLIGHT_SAFE', 'ROUTED'), false);
    assert.equal(canTransition('IMPLEMENT_VALID', 'REVIEW_VALID'), false);
});

test('replays a transaction and phase failure without advancing state', () => {
    const events = [
        makeEvent({ type: 'transaction.created', state: 'NEW' }),
        makeEvent({ sequence: 2, type: 'phase.started', phase: 'preflight', attempt: 1 }),
        makeEvent({
            sequence: 3,
            type: 'phase.failed',
            phase: 'preflight',
            attempt: 1,
            error_code: 'DUAL_AGY_TIMEOUT',
            retryable: true,
        }),
    ];

    assert.equal(deriveState(events), 'NEW');
});

test('state store appends correlated events with monotonic sequence and derives the cache', (t) => {
    const { runDir, store } = makeStore(t);
    const created = store.append({ type: 'transaction.created', state: 'NEW' });
    const started = store.append({ type: 'phase.started', phase: 'preflight', attempt: 1 });
    const completed = store.append({
        type: 'phase.completed',
        phase: 'preflight',
        attempt: 1,
        from_state: 'NEW',
        to_state: 'PREFLIGHT_SAFE',
        artifact_hashes: {},
        warnings: [],
    });

    assert.equal(created.sequence, 1);
    assert.equal(started.sequence, 2);
    assert.equal(completed.sequence, 3);
    assert.equal(completed.task_id, TASK_ID);
    assert.equal(completed.expected_base_commit, BASE_COMMIT);
    assert.equal(store.current(), 'PREFLIGHT_SAFE');
    assert.equal(store.readEvents().length, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')), {
        schema_version: 1,
        task_id: TASK_ID,
        expected_base_commit: BASE_COMMIT,
        state: 'PREFLIGHT_SAFE',
        last_sequence: 3,
    });
});

test('rejects an illegal completed transition before appending it', (t) => {
    const { runDir, store } = makeStore(t);
    store.append({ type: 'transaction.created', state: 'NEW' });
    store.append({ type: 'phase.started', phase: 'preflight', attempt: 1 });

    assert.throws(
        () => store.append({
            type: 'phase.completed',
            phase: 'preflight',
            attempt: 1,
            from_state: 'NEW',
            to_state: 'ROUTED',
            artifact_hashes: {},
            warnings: [],
        }),
        (error) => error.code === 'DUAL_STATE_TRANSITION',
    );
    assert.equal(store.readEvents().length, 2);
    assert.equal(fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).length, 2);
});

test('ignores and repairs only an incomplete trailing NDJSON record', (t) => {
    const { runDir, store } = makeStore(t);
    store.append({ type: 'transaction.created', state: 'NEW' });
    const eventsPath = path.join(runDir, 'events.ndjson');
    fs.appendFileSync(eventsPath, '{"schema_version":1,"type":"phase.started"', 'utf8');

    assert.equal(store.readEvents().length, 1);
    const appended = store.append({ type: 'phase.started', phase: 'preflight', attempt: 1 });

    assert.equal(appended.sequence, 2);
    assert.equal(store.readEvents().length, 2);
    assert.match(fs.readFileSync(eventsPath, 'utf8'), /\n$/);
});

test('rejects malformed complete records and correlation drift', (t) => {
    const { runDir, store } = makeStore(t);
    store.append({ type: 'transaction.created', state: 'NEW' });
    const eventsPath = path.join(runDir, 'events.ndjson');
    fs.appendFileSync(eventsPath, '{bad json}\n', 'utf8');

    assert.throws(() => store.readEvents(), (error) => error.code === 'DUAL_EVENT_LOG_CORRUPT');

    fs.writeFileSync(eventsPath, `${JSON.stringify(makeEvent({ type: 'transaction.created', state: 'NEW' }))}\n${JSON.stringify(makeEvent({
        sequence: 2,
        task_id: 'different-task',
        type: 'phase.started',
        phase: 'preflight',
        attempt: 1,
    }))}\n`, 'utf8');
    assert.throws(() => store.readEvents(), (error) => error.code === 'DUAL_EVENT_CORRELATION');
});

test('tracks attempts and exposes a successful phase for idempotent callers', (t) => {
    const { store } = makeStore(t);
    store.append({ type: 'transaction.created', state: 'NEW' });
    store.append({ type: 'phase.started', phase: 'preflight', attempt: 1 });
    store.append({
        type: 'phase.completed',
        phase: 'preflight',
        attempt: 1,
        from_state: 'NEW',
        to_state: 'PREFLIGHT_SAFE',
        artifact_hashes: {},
        warnings: [],
    });
    assert.equal(store.nextAttempt('scout'), 1);
    assert.equal(store.hasSuccessfulPhase('scout'), null);

    store.append({ type: 'phase.started', phase: 'scout', attempt: 1 });
    store.append({
        type: 'phase.failed',
        phase: 'scout',
        attempt: 1,
        error_code: 'DUAL_AGY_TIMEOUT',
        retryable: true,
    });
    assert.equal(store.nextAttempt('scout'), 2);

    store.append({ type: 'phase.started', phase: 'scout', attempt: 2 });
    const completed = store.append({
        type: 'phase.completed',
        phase: 'scout',
        attempt: 2,
        from_state: 'PREFLIGHT_SAFE',
        to_state: 'SCOUT_VALID',
        artifact_hashes: {},
        warnings: [],
    });
    assert.equal(store.hasSuccessfulPhase('scout').event_id, completed.event_id);
    assert.equal(store.hasSuccessfulPhase('scout').attempt, 2);
});

test('writes immutable artifacts and refuses an overwrite', (t) => {
    const runDir = makeRunDir(t);
    const artifacts = createArtifactStore(runDir);
    const first = artifacts.writeImmutable('attempts/scout.1.output.json', '{"ok":true}\n');

    assert.equal(fs.readFileSync(first.path, 'utf8'), '{"ok":true}\n');
    assert.equal(first.sha256, artifacts.sha256('{"ok":true}\n'));
    assert.throws(
        () => artifacts.writeImmutable('attempts/scout.1.output.json', 'replacement'),
        (error) => error.code === 'DUAL_ARTIFACT_EXISTS',
    );
    assert.equal(fs.readFileSync(first.path, 'utf8'), '{"ok":true}\n');
});

test('atomically replaces only mutable JSON cache files', (t) => {
    const runDir = makeRunDir(t);
    const artifacts = createArtifactStore(runDir);

    artifacts.writeJsonAtomic('state.json', { state: 'NEW' });
    artifacts.writeJsonAtomic('state.json', { state: 'PREFLIGHT_SAFE' });

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')), {
        state: 'PREFLIGHT_SAFE',
    });
    assert.deepEqual(fs.readdirSync(runDir), ['state.json']);
});

test('rejects artifact paths that escape the run directory', (t) => {
    const runDir = makeRunDir(t);
    const artifacts = createArtifactStore(runDir);

    for (const unsafe of ['../escape.txt', path.resolve(runDir, '..', 'absolute.txt')]) {
        assert.throws(
            () => artifacts.writeImmutable(unsafe, 'unsafe'),
            (error) => error.code === 'DUAL_ARTIFACT_PATH',
        );
    }
});

test('hashes strings and buffers deterministically', (t) => {
    const artifacts = createArtifactStore(makeRunDir(t));
    const expected = crypto.createHash('sha256').update('same bytes').digest('hex');

    assert.equal(artifacts.sha256('same bytes'), expected);
    assert.equal(artifacts.sha256(Buffer.from('same bytes')), expected);
    assert.notEqual(artifacts.sha256('same bytes'), HASH);
});

test('state store supports snapshot typed baseline and caches state correctly', (t) => {
    const runDir = makeRunDir(t);
    const snapshotId = 'c'.repeat(64);
    const store = createStateStore(runDir, {
        taskId: 'AI4T-SNAP-STORE',
        expectedBaseline: { kind: 'snapshot', id: snapshotId },
    });

    const ev1 = store.append({ type: 'transaction.created', state: 'NEW' });
    assert.equal(ev1.sequence, 1);
    assert.deepEqual(ev1.expected_baseline, { kind: 'snapshot', id: snapshotId });
    assert.equal(ev1.expected_base_commit, undefined);

    const cachedState = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    assert.equal(cachedState.state, 'NEW');
    assert.deepEqual(cachedState.expected_baseline, { kind: 'snapshot', id: snapshotId });
    assert.equal(cachedState.expected_base_commit, undefined);
    assert.equal(cachedState.last_sequence, 1);

    const ev2 = store.append({ type: 'phase.started', phase: 'preflight', attempt: 1 });
    assert.equal(ev2.sequence, 2);
    assert.deepEqual(ev2.expected_baseline, { kind: 'snapshot', id: snapshotId });

    // Corrupt baseline mismatch throws
    assert.throws(
        () => store.append({
            type: 'phase.completed',
            phase: 'preflight',
            attempt: 1,
            from_state: 'NEW',
            to_state: 'PREFLIGHT_SAFE',
            artifact_hashes: {},
            expected_baseline: { kind: 'snapshot', id: 'd'.repeat(64) },
        }),
        (err) => err.code === 'DUAL_EVENT_CORRELATION'
    );
});

