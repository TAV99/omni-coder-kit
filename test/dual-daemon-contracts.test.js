'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BaselineIdentitySchema,
    GateStatusSchema,
    SessionStateSchema,
    TaskAuthorityStateSchema,
    SetupActionSchema,
    SessionEventSchema,
    normalizeBaselineCorrelation,
    DualContractError,
} = require('../lib/dual/contracts');
const dualIndex = require('../lib/dual/index');

test('accepts git and snapshot baseline identities', () => {
    assert.equal(BaselineIdentitySchema.parse({ kind: 'git', id: 'a'.repeat(40) }).kind, 'git');
    assert.equal(BaselineIdentitySchema.parse({ kind: 'git', id: 'a'.repeat(64) }).kind, 'git');
    assert.equal(BaselineIdentitySchema.parse({ kind: 'snapshot', id: 'b'.repeat(64) }).kind, 'snapshot');
    assert.equal(BaselineIdentitySchema.safeParse({ kind: 'snapshot', id: 'short' }).success, false);
    assert.equal(BaselineIdentitySchema.safeParse({ kind: 'unknown', id: 'b'.repeat(64) }).success, false);
});

test('mandatory gate vocabulary has no ambiguous SKIP', () => {
    for (const status of ['PASSED', 'FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED']) {
        assert.equal(GateStatusSchema.parse(status), status);
    }
    assert.equal(GateStatusSchema.safeParse('SKIP').success, false);
    assert.equal(GateStatusSchema.safeParse('PASS').success, false);
});

test('setup actions are argv-only', () => {
    const action = SetupActionSchema.parse({
        program: 'npm', args: ['install'], cwd: '.', kind: 'package-manager',
    });
    assert.deepEqual(action.args, ['install']);
    assert.equal(action.cwd, '.');
    assert.equal(SetupActionSchema.safeParse({ command: 'npm install && npm test' }).success, false);
    assert.equal(SetupActionSchema.safeParse({ program: '', args: [] }).success, false);
});

test('session states and task authority states match approved design', () => {
    const sessionStates = [
        'DISCOVERED', 'CAPABILITY_SAFE', 'INTERVIEWING', 'PLANNED',
        'EXECUTING', 'ACCEPTANCE', 'VERIFIED', 'BLOCKED',
    ];
    for (const state of sessionStates) {
        assert.equal(SessionStateSchema.parse(state), state);
    }
    assert.equal(SessionStateSchema.safeParse('DONE').success, false);

    const taskStates = [
        'REGISTERED', 'ROUTED', 'AGY_SCOUT', 'AGY_IMPLEMENT', 'SCOPE_VALID',
        'AGY_REVIEW', 'CODEX_IMPLEMENT', 'CODEX_QC', 'TASK_VERIFIED', 'BLOCKED',
    ];
    for (const state of taskStates) {
        assert.equal(TaskAuthorityStateSchema.parse(state), state);
    }
    assert.equal(TaskAuthorityStateSchema.safeParse('IN_PROGRESS').success, false);
});

test('normalizes legacy git correlation without changing source input', () => {
    const legacy = { schema_version: 1, expected_base_commit: 'c'.repeat(40) };
    assert.deepEqual(normalizeBaselineCorrelation(legacy), {
        kind: 'git', id: 'c'.repeat(40),
    });
    assert.equal(legacy.expected_baseline, undefined);

    const v2Correlation = {
        schema_version: 2,
        expected_baseline: { kind: 'snapshot', id: 'd'.repeat(64) },
    };
    assert.deepEqual(normalizeBaselineCorrelation(v2Correlation), {
        kind: 'snapshot', id: 'd'.repeat(64),
    });

    const directGit = { kind: 'git', id: 'e'.repeat(40) };
    assert.deepEqual(normalizeBaselineCorrelation(directGit), {
        kind: 'git', id: 'e'.repeat(40),
    });

    assert.throws(
        () => normalizeBaselineCorrelation({ invalid: true }),
        (err) => {
            assert.equal(err.name, 'DualContractError');
            return true;
        }
    );
});

test('validates strict session events across full lifecycle', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
    };

    const sessionCreated = SessionEventSchema.parse({
        ...base,
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: '.',
        mode: 'auto',
    });
    assert.equal(sessionCreated.type, 'session.created');
    assert.equal(sessionCreated.state, 'DISCOVERED');
    assert.equal(sessionCreated.workspace_root, '.');
    assert.equal(sessionCreated.mode, 'auto');

    const capabilityResult = SessionEventSchema.parse({
        ...base,
        sequence: 2,
        type: 'capability.result',
        status: 'PASSED',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        checks: [{ name: 'codex-hooks', status: 'PASSED' }],
    });
    assert.equal(capabilityResult.status, 'PASSED');
    assert.equal(capabilityResult.to_state, 'CAPABILITY_SAFE');

    const capabilityBlocked = SessionEventSchema.parse({
        ...base,
        sequence: 2,
        type: 'capability.result',
        status: 'UNAVAILABLE',
        from_state: 'DISCOVERED',
        to_state: 'BLOCKED',
        checks: [{ name: 'codex-hooks', status: 'UNAVAILABLE', reason: 'hooks unavailable' }],
    });
    assert.equal(capabilityBlocked.status, 'UNAVAILABLE');
    assert.equal(capabilityBlocked.to_state, 'BLOCKED');

    const planRegistered = SessionEventSchema.parse({
        ...base,
        sequence: 3,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'f'.repeat(64),
        total_tasks: 2,
        tasks: [
            { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/foo.js'] },
            { task_id: 'TASK-2', title: 'Task 2', owner: 'codex', allowed_files: ['lib/bar.js'] },
        ],
    });
    assert.equal(planRegistered.total_tasks, 2);
    assert.equal(planRegistered.tasks.length, 2);

    const taskRouted = SessionEventSchema.parse({
        ...base,
        sequence: 4,
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/foo.js'],
        reason: 'bounded implementation slice',
        model: 'gemini-3.7-flash-high',
        effort: 'high',
        token_budget: 4000,
    });
    assert.equal(taskRouted.owner, 'agy');
    assert.equal(taskRouted.authority_state, 'ROUTED');

    const leaseAcquired = SessionEventSchema.parse({
        ...base,
        sequence: 5,
        type: 'lease.acquired',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        owner: 'agy',
        acquired_at: '2026-08-24T12:00:00.000Z',
        expires_at: '2026-08-24T12:00:30.000Z',
        ttl_ms: 30000,
    });
    assert.equal(leaseAcquired.lease_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(leaseAcquired.ttl_ms, 30000);

    const leaseRenewed = SessionEventSchema.parse({
        ...base,
        sequence: 6,
        type: 'lease.renewed',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        renewed_at: '2026-08-24T12:00:10.000Z',
        expires_at: '2026-08-24T12:00:40.000Z',
        ttl_ms: 30000,
    });
    assert.equal(leaseRenewed.sequence, 6);
    assert.equal(leaseRenewed.expires_at, '2026-08-24T12:00:40.000Z');

    const leaseReleased = SessionEventSchema.parse({
        ...base,
        sequence: 7,
        type: 'lease.released',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        released_at: '2026-08-24T12:00:20.000Z',
        reason: 'task completed',
    });
    assert.equal(leaseReleased.reason, 'task completed');

    const gateResult = SessionEventSchema.parse({
        ...base,
        sequence: 8,
        type: 'gate.result',
        gate_id: 'quality-cycle-1',
        status: 'PASSED',
        cycle_index: 1,
        evidence_sha256: 'e'.repeat(64),
        reason: 'deterministic tests passed',
    });
    assert.equal(gateResult.status, 'PASSED');
    assert.equal(gateResult.evidence_sha256, 'e'.repeat(64));

    const taskCompleted = SessionEventSchema.parse({
        ...base,
        sequence: 9,
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/foo.js'],
        diff_fingerprint: '1'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    assert.equal(taskCompleted.task_id, 'TASK-1');
    assert.equal(taskCompleted.authority_state, 'TASK_VERIFIED');
    assert.equal(taskCompleted.verdict, 'SUCCESS');

    const sessionVerified = SessionEventSchema.parse({
        ...base,
        sequence: 10,
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: '2'.repeat(64),
        completed_tasks: ['TASK-1', 'TASK-2'],
    });
    assert.equal(sessionVerified.to_state, 'VERIFIED');
    assert.equal(sessionVerified.receipt_sha256, '2'.repeat(64));

    const sessionBlocked = SessionEventSchema.parse({
        ...base,
        sequence: 11,
        type: 'session.blocked',
        from_state: 'EXECUTING',
        to_state: 'BLOCKED',
        reason: 'gate failure',
        blocker_code: 'GATE_FAILED',
    });
    assert.equal(sessionBlocked.reason, 'gate failure');
    assert.equal(sessionBlocked.blocker_code, 'GATE_FAILED');

    const baselinePromoted = SessionEventSchema.parse({
        ...base,
        sequence: 12,
        type: 'baseline.promoted',
        from_baseline: { kind: 'snapshot', id: '3'.repeat(64) },
        to_baseline: { kind: 'git', id: '4'.repeat(40) },
    });
    assert.equal(baselinePromoted.type, 'baseline.promoted');

    // Strict validation: rejects extra fields and invalid schema_version
    assert.equal(SessionEventSchema.safeParse({ ...sessionCreated, extra_field: true }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...sessionCreated, schema_version: 1 }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...sessionCreated, expected_baseline: { kind: 'invalid' } }).success, false);
});

test('rejects duplicate or removed event kinds', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 2,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
    };

    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'capability.evaluated',
        status: 'PASSED',
    }).success, false);

    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'gate.evaluated',
        gate_id: 'cycle-1',
        status: 'PASSED',
    }).success, false);
});

test('rejects v2 events with legacy gemini owner', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
    };

    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'gemini',
        authority_state: 'ROUTED',
        allowed_files: ['lib/foo.js'],
        reason: 'test',
    }).success, false);

    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plan.md',
        plan_sha256: 'a'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'gemini', allowed_files: [] }],
    }).success, false);

    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'lease.acquired',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        owner: 'gemini',
        acquired_at: '2026-08-24T12:00:00.000Z',
        expires_at: '2026-08-24T12:00:30.000Z',
        ttl_ms: 30000,
    }).success, false);

    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'gemini',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/foo.js'],
        diff_fingerprint: '1'.repeat(64),
        verdict: 'SUCCESS',
    }).success, false);
});

test('rejects non-positive plan_revision in session events', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 0,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: '.',
        mode: 'auto',
    };
    assert.equal(SessionEventSchema.safeParse(base).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, plan_revision: -1 }).success, false);
});

test('rejects session.created with wrong literals or missing workspace_root', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'session.created',
    };

    // created with VERIFIED
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        state: 'VERIFIED',
        workspace_root: '.',
        mode: 'auto',
    }).success, false);

    // created missing workspace_root
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        state: 'DISCOVERED',
        mode: 'auto',
    }).success, false);

    // created with mode manual
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        state: 'DISCOVERED',
        workspace_root: '.',
        mode: 'manual',
    }).success, false);
});

test('rejects capability.result without checks or with illegal state transition pairing', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 2,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'capability.result',
    };

    // missing checks
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        status: 'PASSED',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
    }).success, false);

    // empty checks
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        status: 'PASSED',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        checks: [],
    }).success, false);

    // wrong from_state
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        status: 'PASSED',
        from_state: 'PLANNED',
        to_state: 'CAPABILITY_SAFE',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    }).success, false);

    // PASSED with to_state BLOCKED
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        status: 'PASSED',
        from_state: 'DISCOVERED',
        to_state: 'BLOCKED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    }).success, false);

    // FAILED with to_state CAPABILITY_SAFE
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        status: 'FAILED',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        checks: [{ name: 'hooks', status: 'FAILED', reason: 'failed' }],
    }).success, false);
});

test('rejects plan.registered without evidence, mismatch tasks, or missing task fields', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 3,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'f'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/foo.js'] }],
    };

    // plan without evidence: missing plan_sha256
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        plan_sha256: undefined,
    }).success, false);

    // missing plan_path
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        plan_path: undefined,
    }).success, false);

    // total_tasks mismatch
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        total_tasks: 2,
    }).success, false);

    // empty tasks
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        total_tasks: 0,
        tasks: [],
    }).success, false);

    // task missing title
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        tasks: [{ task_id: 'TASK-1', owner: 'agy', allowed_files: ['lib/foo.js'] }],
    }).success, false);

    // task missing allowed_files
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'agy' }],
    }).success, false);

    // wrong from_state
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        from_state: 'DISCOVERED',
    }).success, false);

    // wrong to_state
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        to_state: 'EXECUTING',
    }).success, false);
});

test('rejects task.routed with missing fields or wrong literal', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 4,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/foo.js'],
        reason: 'test reason',
    };

    // missing authority_state or wrong state
    assert.equal(SessionEventSchema.safeParse({ ...base, authority_state: undefined }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, authority_state: 'AGY_IMPLEMENT' }).success, false);

    // missing allowed_files
    assert.equal(SessionEventSchema.safeParse({ ...base, allowed_files: undefined }).success, false);

    // missing reason
    assert.equal(SessionEventSchema.safeParse({ ...base, reason: undefined }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, reason: '' }).success, false);
});

test('rejects lease events with missing timestamps, expiry, ttl, or release reason', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 5,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
    };

    // lease without expiry
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'lease.acquired',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        owner: 'agy',
        acquired_at: '2026-08-24T12:00:00.000Z',
        ttl_ms: 30000,
    }).success, false);

    // lease.acquired missing acquired_at or ttl_ms
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'lease.acquired',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        owner: 'agy',
        expires_at: '2026-08-24T12:00:30.000Z',
    }).success, false);

    // lease.renewed missing expires_at or ttl_ms
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'lease.renewed',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        renewed_at: '2026-08-24T12:00:10.000Z',
    }).success, false);

    // lease.released missing reason or empty reason
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'lease.released',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        released_at: '2026-08-24T12:00:20.000Z',
    }).success, false);
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        type: 'lease.released',
        lease_id: '33333333-3333-4333-8333-333333333333',
        task_id: 'TASK-1',
        released_at: '2026-08-24T12:00:20.000Z',
        reason: '',
    }).success, false);
});

test('rejects gate.result without evidence_sha256 or reason', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 8,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'gate.result',
        gate_id: 'quality-cycle-1',
        status: 'PASSED',
    };

    assert.equal(SessionEventSchema.safeParse(base).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, evidence_sha256: 'e'.repeat(64) }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, reason: 'passed' }).success, false);
});

test('rejects task.completed without diff_fingerprint, modified_files, or SUCCESS verdict', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 9,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/foo.js'],
        diff_fingerprint: '1'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    };

    // completed without fingerprint
    assert.equal(SessionEventSchema.safeParse({ ...base, diff_fingerprint: undefined }).success, false);

    // missing modified_files
    assert.equal(SessionEventSchema.safeParse({ ...base, modified_files: undefined }).success, false);

    // non-SUCCESS verdict
    assert.equal(SessionEventSchema.safeParse({ ...base, verdict: 'FAILURE' }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, verdict: undefined }).success, false);

    // wrong authority_state
    assert.equal(SessionEventSchema.safeParse({ ...base, authority_state: 'ROUTED' }).success, false);
});

test('rejects session.verified without receipt, completed_tasks, or with wrong literals/extra state', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 10,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: '2'.repeat(64),
        completed_tasks: ['TASK-1'],
    };

    // verified without receipt
    assert.equal(SessionEventSchema.safeParse({ ...base, receipt_sha256: undefined }).success, false);

    // missing or empty completed_tasks
    assert.equal(SessionEventSchema.safeParse({ ...base, completed_tasks: undefined }).success, false);
    assert.equal(SessionEventSchema.safeParse({ ...base, completed_tasks: [] }).success, false);

    // wrong from_state
    assert.equal(SessionEventSchema.safeParse({ ...base, from_state: 'EXECUTING' }).success, false);

    // wrong to_state
    assert.equal(SessionEventSchema.safeParse({ ...base, to_state: 'BLOCKED' }).success, false);

    // redundant generic state field
    assert.equal(SessionEventSchema.safeParse({ ...base, state: 'VERIFIED' }).success, false);
});

test('rejects session.blocked from terminal state, missing blocker_code, or with extra state', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 11,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'session.blocked',
        from_state: 'EXECUTING',
        to_state: 'BLOCKED',
        reason: 'gate failure',
        blocker_code: 'GATE_FAILED',
    };

    // from terminal state VERIFIED
    assert.equal(SessionEventSchema.safeParse({ ...base, from_state: 'VERIFIED' }).success, false);

    // from terminal state BLOCKED
    assert.equal(SessionEventSchema.safeParse({ ...base, from_state: 'BLOCKED' }).success, false);

    // missing blocker_code
    assert.equal(SessionEventSchema.safeParse({ ...base, blocker_code: undefined }).success, false);

    // missing reason
    assert.equal(SessionEventSchema.safeParse({ ...base, reason: undefined }).success, false);

    // wrong to_state
    assert.equal(SessionEventSchema.safeParse({ ...base, to_state: 'VERIFIED' }).success, false);

    // redundant generic state field
    assert.equal(SessionEventSchema.safeParse({ ...base, state: 'BLOCKED' }).success, false);
});

test('rejects baseline.promoted with snapshot-to-snapshot, git-to-git, or extra commit field', () => {
    const base = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 12,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'baseline.promoted',
    };

    // snapshot -> snapshot promotion
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        from_baseline: { kind: 'snapshot', id: '3'.repeat(64) },
        to_baseline: { kind: 'snapshot', id: '4'.repeat(64) },
    }).success, false);

    // git -> git promotion
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        from_baseline: { kind: 'git', id: '3'.repeat(40) },
        to_baseline: { kind: 'git', id: '4'.repeat(40) },
    }).success, false);

    // git -> snapshot promotion
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        from_baseline: { kind: 'git', id: '3'.repeat(40) },
        to_baseline: { kind: 'snapshot', id: '4'.repeat(64) },
    }).success, false);

    // redundant optional commit field
    assert.equal(SessionEventSchema.safeParse({
        ...base,
        from_baseline: { kind: 'snapshot', id: '3'.repeat(64) },
        to_baseline: { kind: 'git', id: '4'.repeat(40) },
        commit: '4'.repeat(40),
    }).success, false);
});

test('index re-exports all v2 daemon contracts', () => {
    assert.equal(dualIndex.BaselineIdentitySchema, BaselineIdentitySchema);
    assert.equal(dualIndex.GateStatusSchema, GateStatusSchema);
    assert.equal(dualIndex.SessionStateSchema, SessionStateSchema);
    assert.equal(dualIndex.TaskAuthorityStateSchema, TaskAuthorityStateSchema);
    assert.equal(dualIndex.SetupActionSchema, SetupActionSchema);
    assert.equal(dualIndex.SessionEventSchema, SessionEventSchema);
    assert.equal(dualIndex.normalizeBaselineCorrelation, normalizeBaselineCorrelation);
});
