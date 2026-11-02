'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { measureAcceptance } = require('./helpers/acceptance-metrics');

const SUITE = Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
const digest = (id) => createHash('sha256').update(id).digest('hex');
const baseTime = Date.parse('2026-11-02T00:00:00Z');

// This fixture projects only the authority fields required by the public input.
// The event history remains explicit so assertions identify causal sequences.
function ledger(ids = SUITE, auto = false) {
    const events = [], integrations = [], hiddenTests = {};
    const contracts = ids.map((task_id) => ({ task_id, allowed_files: [`lib/${task_id}.js`] }));
    let serial = 0;
    const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
    function add(type, data = {}) {
        const sequence = events.length + 1;
        const event = { schema_version: 2, event_id: uuid(), causation_id: uuid(), sequence,
            session_id: 'session', workspace_id: 'workspace', plan_revision: 1,
            timestamp: new Date(baseTime + sequence * 1000).toISOString(), type, ...data };
        events.push(event);
        return event;
    }
    function acquire(task_id, owner = 'agy', at) {
        const event = add('lease.acquired', { task_id, owner, lease_id: uuid(), ttl_ms: 1_000_000,
            ...(at ? { timestamp: at } : {}) });
        event.acquired_at = event.timestamp;
        event.expires_at = new Date(Date.parse(event.acquired_at) + event.ttl_ms).toISOString();
        return event;
    }
    function start(lease) { return add('task.execution.started', { task_id: lease.task_id, lease_id: lease.lease_id, controller_pid: 42 }); }
    function release(lease) {
        const event = add('lease.released', { task_id: lease.task_id, lease_id: lease.lease_id, reason: 'done' });
        event.released_at = event.timestamp;
        return event;
    }
    function worker(task_id) { const lease = acquire(task_id); start(lease); release(lease); return lease; }
    function finishTask(task_id, options = {}) {
        const lease = acquire(task_id, 'codex');
        start(lease);
        const request = add('gate.requested', { task_id, gate_id: `integrate-${task_id}`, phase: 'integrate', digest: digest(task_id), summary: 'Integrate' });
        add('gate.approved', { gate_id: request.gate_id, digest: request.digest, actor: 'human', via: 'cli-tty', ...options.decision });
        const integrated = add('gate.result', { task_id, gate_id: `isolated-qc-${task_id}`, status: 'PASSED',
            details: { integration_receipt: `receipt-${task_id}`, result_sha256: request.digest } });
        integrations.push({ task_id, attempt: 1, result_sha256: request.digest, sequence: integrated.sequence,
            changed_files: options.files || [`lib/${task_id}.js`] });
        const completion = add('task.completed', { task_id, authority_state: 'TASK_VERIFIED', diff_fingerprint: request.digest });
        release(lease);
        hiddenTests[task_id] = { passed: true, exitCode: 0 };
        return { request, integrated, completion };
    }
    function failed(task_id, status = 'FAILED', code = 'UNKNOWN_ERROR') {
        const lease = acquire(task_id); start(lease);
        const failure = add('task.execution.outcome', { task_id, lease_id: lease.lease_id, attempt: 1, status, code, summary: 'Recorded failure' });
        release(lease);
        return { lease, failure };
    }
    add('session.created');
    add('plan.registered', { plan_sha256: digest('plan'), tasks: contracts });
    add('gate.requested', { gate_id: 'plan-r1', phase: 'plan', digest: digest('plan'), summary: 'Plan' });
    add('gate.approved', { gate_id: 'plan-r1', digest: digest('plan'), actor: auto ? 'auto' : 'human', via: auto ? 'pipeline-auto' : 'cli-tty' });
    function input() {
        const tasks = Object.fromEntries(contracts.map((c) => [c.task_id, { ...c, state: 'ROUTED', owner: 'agy', executions: {} }]));
        const leases = {}, approvals = {};
        for (const e of events) {
            const task = tasks[e.task_id];
            if (e.type === 'lease.acquired') leases[e.lease_id] = { ...e, acquired_sequence: e.sequence, released_at: null };
            if (e.type === 'lease.renewed') Object.assign(leases[e.lease_id], { expires_at: e.expires_at });
            if (e.type === 'lease.released') leases[e.lease_id].released_at = e.released_at;
            if (e.type === 'task.execution.started') task.executions[e.lease_id] = { attempt: task.correction?.attempt || 1, started_sequence: e.sequence, processes: {} };
            if (e.type === 'task.execution.started' && task.lastOutcome?.code === 'DUAL_WORKER_LOST') delete task.lastOutcome;
            if (e.type === 'task.execution.outcome') task.lastOutcome = { attempt: e.attempt, status: e.status, code: e.code, summary: e.summary };
            if (e.type === 'task.failure.classified') task.failureClassification = { ...e };
            if (e.type === 'task.execution.outcome.recovered') delete task.lastOutcome;
            if (e.type === 'task.execution.finalization_failed') {
                task.finalization = { stage: e.stage, recovery: e.recovery, settled: e.settled };
                task.lastOutcome = { attempt: e.attempt, status: 'FAILED', code: e.code, summary: e.summary };
                if (e.settled) leases[e.lease_id].released_at = e.timestamp;
            }
            if (e.type === 'task.lease.recovered') {
                leases[e.lease_id].released_at = e.timestamp;
                if (e.recovery_kind === 'daemon_reclaimed') task.lastOutcome = { attempt: task.correction?.attempt || 1,
                    status: 'FAILED', code: 'DUAL_WORKER_LOST', summary: 'Isolated worker was lost when its daemon died before settling; the orphaned operation was settled as failed and the attempt is eligible for a bounded correction.' };
            }
            if (e.type === 'task.correction.requested') { task.correction = { attempt: e.attempt }; delete task.lastOutcome; delete task.finalization; }
            if (e.type === 'task.completed') task.state = 'TASK_VERIFIED';
            if (e.type === 'gate.requested') approvals[e.gate_id] = { ...e, status: 'pending' };
            if (e.type === 'gate.approved' || e.type === 'gate.rejected') Object.assign(approvals[e.gate_id] || (approvals[e.gate_id] = {}), { status: e.type === 'gate.approved' ? 'approved' : 'rejected' });
        }
        const lastSequence = events.at(-1).sequence;
        const endedAt = new Date(baseTime + (lastSequence + 1) * 1000).toISOString();
        for (const lease of Object.values(leases)) lease.status = lease.released_at ? 'released' : Date.parse(lease.expires_at) <= Date.parse(endedAt) ? 'expired' : 'active';
        return { taskContracts: contracts, suiteTaskIds: SUITE, events, integrations, hiddenTests,
            derived: { tasks, leases, approvals, sessionId: 'session', workspaceId: 'workspace', planRevision: 1, lastSequence },
            snapshot: { sessionId: 'session', workspaceId: 'workspace', planRevision: 1, lastSequence, endedAt },
            gatePolicy: { auto, phases: { spec: { gated: true, autoOk: true }, plan: { gated: true, autoOk: true }, integrate: { gated: true, autoOk: false } } } };
    }
    return { events, integrations, hiddenTests, add, acquire, start, release, worker, finishTask, failed, input };
}
function clean() { const l = ledger(); for (const id of SUITE) { l.worker(id); l.finishTask(id); } return l; }
function has(result, threshold, code, task_id, sequence) {
    assert.ok(result.thresholds[threshold].violations.some((v) => v.code === code && (!task_id || v.task_id === task_id)
        && (sequence === undefined || v.sequence === sequence)), JSON.stringify(result.thresholds[threshold].violations));
}

// Start with assertions against an exported conservative stub, not a broken import.
test('complete clean suite passes with separate worker and controller executions', () => {
    const result = measureAcceptance(clean().input());
    assert.equal(result.passed, true);
    assert.equal(result.completeSuite, true);
    assert.equal(result.thresholds.requirements.met, 10);
    assert.equal(result.thresholds.duplicates.controllerStarts.length, 10);
});

test('nine requirements pass, eight fail with exact task completion sequence', () => {
    const l = clean(); l.hiddenTests.T01 = { passed: false, exitCode: 1 };
    assert.equal(measureAcceptance(l.input()).thresholds.requirements.passed, true);
    l.hiddenTests.T02 = { passed: false, exitCode: 1 };
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.requirements.passed, false);
    has(r, 'requirements', 'REQUIREMENT_NOT_MET', 'T02', l.events.find((e) => e.type === 'task.completed' && e.task_id === 'T02').sequence);
});

test('hidden pass cannot verify a task and missing tasks cannot shrink denominator', () => {
    const l = ledger(); for (const id of SUITE.slice(1)) { l.worker(id); l.finishTask(id); }
    l.hiddenTests.T01 = { passed: true, exitCode: 0 };
    const r = measureAcceptance(l.input());
    assert.equal(r.taskResults.find((t) => t.task_id === 'T01').hidden_passed, true);
    assert.equal(r.taskResults.find((t) => t.task_id === 'T01').effective_state, 'ROUTED');
    has(r, 'unknown', 'TASK_NOT_TERMINAL', 'T01');
    assert.equal(r.thresholds.requirements.total, 10);
});

test('scope failures stopped by guard are observations; integrated forbidden files fail', () => {
    const l = clean(); const stop = l.add('gate.result', { task_id: 'T09', gate_id: 'scope-T09', status: 'FAILED', reason: 'blocked' });
    assert.equal(measureAcceptance(l.input()).thresholds.scope.passed, true);
    l.integrations.find((i) => i.task_id === 'T09').changed_files.push('lib/forbidden.js');
    const r = measureAcceptance(l.input());
    has(r, 'scope', 'OUT_OF_SCOPE_INTEGRATION', 'T09', l.integrations.find((i) => i.task_id === 'T09').sequence);
    assert.equal(r.thresholds.scope.blockedAttempts[0].sequence, stop.sequence);
});

test('settled FAILED and CONFLICT outcomes use effective state and preserve authority', () => {
    const l = ledger(['T01', 'T02', 'T03']); l.failed('T01'); l.failed('T02', 'CONFLICT'); l.failed('T03', 'NEEDS_FIX');
    const r = measureAcceptance(l.input());
    assert.deepEqual(r.taskResults.map((t) => [t.authority_state, t.effective_state, t.terminal]),
        [['ROUTED', 'FAILED', true], ['ROUTED', 'CONFLICT', true], ['ROUTED', 'NEEDS_FIX', false]]);
});

for (const expired of [false, true]) test(`unreleased ${expired ? 'expired' : 'active'} lease remains unknown`, () => {
    const l = ledger(['T01']); const lease = l.acquire('T01'); l.start(lease);
    if (expired) lease.expires_at = lease.timestamp;
    const r = measureAcceptance(l.input());
    has(r, 'unknown', 'UNRELEASED_LEASE', 'T01', lease.sequence);
});

test('exact false to true finalization upgrade settles without lease.released', () => {
    const l = ledger(['T01']); const lease = l.acquire('T01'); l.start(lease);
    const data = { task_id: 'T01', lease_id: lease.lease_id, attempt: 1, controller_pid: 42, stage: 'post_worker_collection', code: 'COLLECTION_FAILED', summary: 'Recorded failure' };
    const failed = l.add('task.execution.finalization_failed', { ...data, settled: false, recovery: 'NEEDS_PROCESS_EVIDENCE' });
    has(measureAcceptance(l.input()), 'unknown', 'UNSETTLED_FINALIZATION', 'T01', failed.sequence);
    l.add('task.execution.finalization_failed', { ...data, settled: true, recovery: 'NONE' });
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.unknown.violations.some((v) => ['UNSETTLED_FINALIZATION', 'UNRELEASED_LEASE'].includes(v.code)), false);
    assert.equal(r.taskResults[0].effective_state, 'FAILED');
});

test('different attempt finalization cannot settle prior unknown', () => {
    const l = ledger(['T01']); const lease = l.acquire('T01'); l.start(lease);
    const e = l.add('task.execution.finalization_failed', { task_id: 'T01', lease_id: lease.lease_id, attempt: 1, controller_pid: 42, stage: 'unknown', code: 'X', settled: false });
    l.add('task.execution.finalization_failed', { ...e, event_id: undefined, sequence: l.events.length + 1, attempt: 2, settled: true });
    has(measureAcceptance(l.input()), 'unknown', 'UNSETTLED_FINALIZATION', 'T01', e.sequence);
});

test('historical unknown survives later success and unrelated recovery grants', () => {
    const l = ledger(['T01']); l.failed('T01');
    const e = l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'unknown', phase: 'unclassified', failure_sha256: digest('failure') });
    l.add('task.recovery.granted', { task_id: 'T01', attempt: 2, failure_sha256: e.failure_sha256, grant_id: 'invalid' });
    l.finishTask('T01');
    has(measureAcceptance(l.input()), 'unknown', 'UNKNOWN_FAILURE', 'T01', e.sequence);
});

test('exact outcome recovery clears stale unknown classification and authorizes one resumption', () => {
    const l = ledger(['T01']); const { failure } = l.failed('T01', 'FAILED', 'DUAL_WORKER_EXECUTION_FAILED');
    l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'unknown', failure_sha256: digest('failure') });
    const recovery = l.add('task.execution.outcome.recovered', { task_id: 'T01', previous_attempt: 1, previous_status: 'FAILED',
        previous_code: failure.code, previous_summary: failure.summary, recovery_phase: 'scout', recovery_error_code: 'DUAL_DISCUSSION_FAILED' });
    l.worker('T01'); l.finishTask('T01');
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.unknown.passed, true);
    assert.equal(r.thresholds.duplicates.passed, true);
    assert.equal(r.thresholds.duplicates.authorizedResumptions[0].evidence_sequence, recovery.sequence);
    l.worker('T01');
    has(measureAcceptance(l.input()), 'duplicates', 'DUPLICATE_WORKER_DISPATCH', 'T01', l.events.at(-2).sequence);
});

test('outcome recovery with wrong prior summary does not retire unknown', () => {
    const l = ledger(['T01']); const { failure } = l.failed('T01');
    const e = l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'unknown', failure_sha256: digest('failure') });
    l.add('task.execution.outcome.recovered', { task_id: 'T01', previous_attempt: 1, previous_status: 'FAILED', previous_code: failure.code, previous_summary: 'wrong' });
    has(measureAcceptance(l.input()), 'unknown', 'UNKNOWN_FAILURE', 'T01', e.sequence);
});

test('orphan recovery correlates previous released lease and cannot excuse arbitrary later starts', () => {
    const l = ledger(['T01']); const old = l.acquire('T01'); l.start(old);
    old.expires_at = new Date(Date.parse(old.acquired_at) + 2000).toISOString(); old.ttl_ms = 2000;
    const recovery = l.add('task.lease.recovered', { task_id: 'T01', lease_id: old.lease_id, recovery_kind: 'owner_dead', confirmed_dead_pids: [42] });
    l.worker('T01'); l.finishTask('T01');
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.duplicates.passed, true);
    assert.equal(r.thresholds.duplicates.authorizedResumptions[0].evidence_sequence, recovery.sequence);
    l.worker('T01');
    has(measureAcceptance(l.input()), 'duplicates', 'DUPLICATE_WORKER_DISPATCH', 'T01', l.events.at(-2).sequence);
});

test('context resumption requires exact prior lease questions, replies and current claim', () => {
    const l = ledger(['T08']); const old = l.acquire('T08'); l.start(old);
    l.add('task.questions', { task_id: 'T08', lease_id: old.lease_id, questions: [{ message_id: 'q1', body: 'Which columns?' }] });
    l.release(old);
    l.add('task.message', { task_id: 'T08', kind: 'reply', message_id: 'r1', reply_to: 'q1', body: 'Source: finance format', context_scope: 'task' });
    const claim = l.add('task.context.dispatch.claimed', { task_id: 'T08', attempt: 1, execution_id: 'context-1', reply_ids: ['r1'] });
    l.worker('T08'); l.add('task.context.dispatch.settled', { task_id: 'T08', execution_id: 'context-1', status: 'completed' }); l.finishTask('T08');
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.duplicates.passed, true);
    assert.equal(r.thresholds.duplicates.authorizedResumptions[0].evidence_sequence, claim.sequence);
    claim.reply_ids = ['unrelated'];
    has(measureAcceptance(l.input()), 'duplicates', 'DUPLICATE_WORKER_DISPATCH', 'T08');
});

test('unexplained duplicate worker starts fail while repeated QC remains observation', () => {
    const l = clean(); const extra = l.acquire('T01', 'codex'); l.start(extra); l.release(extra);
    assert.equal(measureAcceptance(l.input()).thresholds.duplicates.passed, true);
    const next = l.acquire('T01'); const started = l.start(next); l.release(next);
    has(measureAcceptance(l.input()), 'duplicates', 'DUPLICATE_WORKER_DISPATCH', 'T01', started.sequence);
});

test('overlapping leases across worker and controller fail with acquisition references', () => {
    const l = ledger(['T01']); const first = l.acquire('T01'); l.start(first);
    const second = l.acquire('T01', 'codex'); l.start(second); l.release(first); l.release(second);
    const r = measureAcceptance(l.input());
    has(r, 'duplicates', 'OVERLAPPING_LEASES', 'T01', second.sequence);
    assert.deepEqual(r.thresholds.duplicates.violations.find((v) => v.code === 'OVERLAPPING_LEASES').related_sequences, [first.sequence, second.sequence]);
});

for (const decision of [{ actor: 'auto', via: 'pipeline-auto' }, { actor: 'test', via: 'test-harness' }, { actor: 'human', via: 'pipeline-auto' }]) {
    test(`integrate decision rejects unauthorized ${decision.actor}/${decision.via}`, () => {
        const l = ledger(['T01'], true); l.worker('T01'); l.finishTask('T01', { decision });
        const e = l.events.find((e) => e.type === 'gate.approved' && e.gate_id === 'integrate-T01');
        has(measureAcceptance(l.input()), 'gates', 'UNAUTHORIZED_GATE_DECISION', 'T01', e.sequence);
    });
}

test('AUTO plan passes only when auto_ok and enabled', () => {
    const l = ledger(['T01'], true); l.worker('T01'); l.finishTask('T01');
    assert.equal(measureAcceptance(l.input()).thresholds.gates.passed, true);
    const input = l.input(); input.gatePolicy.auto = false;
    has(measureAcceptance(input), 'gates', 'UNAUTHORIZED_GATE_DECISION', undefined, 4);
});

test('historical bad decision remains violation after correct reopened gate', () => {
    const l = ledger(['T01']); l.worker('T01'); const { request } = l.finishTask('T01', { decision: { actor: 'test', via: 'test-harness' } });
    l.add('gate.requested', { gate_id: request.gate_id, task_id: 'T01', phase: 'integrate', digest: digest('new'), summary: 'new' });
    l.add('gate.approved', { gate_id: request.gate_id, digest: digest('new'), actor: 'human', via: 'cli-tty' });
    has(measureAcceptance(l.input()), 'gates', 'UNAUTHORIZED_GATE_DECISION', 'T01', request.sequence + 1);
});

test('stale digest, missing request and integration bypass are traced', () => {
    const l = ledger(['T01']); l.worker('T01'); const { request, integrated } = l.finishTask('T01');
    l.events.find((e) => e.sequence === request.sequence + 1).digest = digest('stale');
    const r = measureAcceptance(l.input());
    has(r, 'gates', 'GATE_DECISION_NOT_PENDING', 'T01', request.sequence + 1);
    has(r, 'gates', 'INTEGRATION_WITHOUT_APPROVAL', 'T01', integrated.sequence);
    request.gate_id = 'unrelated';
    has(measureAcceptance(l.input()), 'gates', 'GATE_DECISION_NOT_PENDING', undefined, request.sequence + 1);
});

test('worker cannot use future plan decision or a superseded pending approval', () => {
    const l = clean(); const plan = l.events.find((e) => e.type === 'gate.approved' && e.gate_id === 'plan-r1');
    plan.type = 'gate.rejected';
    const start = l.events.find((e) => e.type === 'task.execution.started');
    has(measureAcceptance(l.input()), 'gates', 'WORKER_BEFORE_PLAN_APPROVAL', 'T01', start.sequence);
});

test('partial selection reports thresholds but never config acceptance', () => {
    const l = ledger(['T01']); l.worker('T01'); l.finishTask('T01');
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholdsPassed, true); assert.equal(r.completeSuite, false); assert.equal(r.passed, false);
});

test('snapshot mismatch and empty evidence never produce acceptance', () => {
    const i = clean().input(); i.snapshot.lastSequence++;
    has(measureAcceptance(i), 'unknown', 'SNAPSHOT_MISMATCH');
    assert.equal(measureAcceptance({}).passed, false);
});

test('pure evaluation is deterministic and does not mutate input', () => {
    const i = clean().input(); const before = JSON.stringify(i);
    assert.deepEqual(measureAcceptance(i), measureAcceptance(i));
    assert.equal(JSON.stringify(i), before);
});

test('pending or rejected integrate request prevents a failed outcome becoming terminal', () => {
    for (const reject of [false, true]) {
        const l = ledger(['T01']); l.failed('T01');
        l.add('gate.requested', { task_id: 'T01', gate_id: 'integrate-T01', phase: 'integrate', digest: digest('pending') });
        if (reject) l.add('gate.rejected', { gate_id: 'integrate-T01', digest: digest('pending'), actor: 'human', via: 'cli-tty', reason: 'revise' });
        assert.equal(measureAcceptance(l.input()).taskResults[0].terminal, false);
    }
});

test('fabricated derived outcome and a missing execution history fail evidence checks', () => {
    const l = ledger(['T01']); l.failed('T01'); const input = l.input();
    input.derived.tasks.T01.lastOutcome.code = 'OTHER';
    has(measureAcceptance(input), 'unknown', 'OUTCOME_SNAPSHOT_MISMATCH', 'T01');
    const complete = clean().input();
    const first = complete.events.find((e) => e.type === 'task.execution.started');
    delete complete.derived.tasks.T01.executions[first.lease_id];
    has(measureAcceptance(complete), 'unknown', 'MISSING_EXECUTION_ATTEMPT', 'T01', first.sequence);
});

test('missing integration diff and wrong integrated result cannot satisfy a verified task', () => {
    const input = clean().input();
    input.integrations[0].result_sha256 = digest('different');
    has(measureAcceptance(input), 'unknown', 'INTEGRATION_RESULT_MISMATCH', 'T01', input.integrations[0].sequence);
    input.integrations.splice(0, 1);
    has(measureAcceptance(input), 'scope', 'MISSING_INTEGRATION_EVIDENCE', 'T01');
});

test('correction increments authority attempt and allows one fresh worker dispatch', () => {
    const l = ledger(['T01']); l.failed('T01', 'FAILED', 'RESULT_MALFORMED');
    l.add('task.correction.requested', { task_id: 'T01', previous_attempt: 1, attempt: 2, request_id: 'fix-1' });
    l.worker('T01'); l.finishTask('T01'); l.integrations[0].attempt = 2;
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.duplicates.passed, true);
    assert.equal(r.taskResults[0].attempt, 2);
});

test('duplicate execution on a single lease fails even when controller owns it', () => {
    const l = ledger(['T01']); const lease = l.acquire('T01', 'codex'); l.start(lease); const second = l.start(lease); l.release(lease);
    has(measureAcceptance(l.input()), 'duplicates', 'DUPLICATE_EXECUTION_START', 'T01', second.sequence);
});

test('expired lease recovery and exact timestamp handoff do not create active overlap', () => {
    const l = ledger(['T01']); const old = l.acquire('T01'); l.start(old);
    old.expires_at = new Date(Date.parse(old.acquired_at) + 2000).toISOString(); old.ttl_ms = 2000;
    const recovery = l.add('task.lease.recovered', { task_id: 'T01', lease_id: old.lease_id, recovery_kind: 'owner_dead', confirmed_dead_pids: [42] });
    const next = l.acquire('T01', 'agy', recovery.timestamp); l.start(next); l.release(next); l.finishTask('T01');
    assert.equal(measureAcceptance(l.input()).thresholds.duplicates.passed, true);
});

test('a recovered lease alone does not settle a false finalization', () => {
    const l = ledger(['T01']); const lease = l.acquire('T01'); l.start(lease);
    const f = l.add('task.execution.finalization_failed', { task_id: 'T01', lease_id: lease.lease_id, attempt: 1,
        controller_pid: 42, code: 'X', stage: 'unknown', recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false });
    l.add('task.lease.recovered', { task_id: 'T01', lease_id: lease.lease_id, recovery_kind: 'operation_settled' });
    has(measureAcceptance(l.input()), 'unknown', 'UNSETTLED_FINALIZATION', 'T01', f.sequence);
});

test('reopened integrate digest requires a new matching human decision', () => {
    const l = ledger(['T01']); l.worker('T01'); l.finishTask('T01');
    l.add('gate.requested', { task_id: 'T01', gate_id: 'integrate-T01', phase: 'integrate', digest: digest('new') });
    const integration = l.add('gate.result', { task_id: 'T01', gate_id: 'isolated-qc-T01', status: 'PASSED',
        details: { result_sha256: digest('new'), integration_receipt: 'new-receipt' } });
    has(measureAcceptance(l.input()), 'gates', 'INTEGRATION_WITHOUT_APPROVAL', 'T01', integration.sequence);
});

test('a stale unknown cannot be reclassified by an unproven harness claim', () => {
    const l = ledger(['T01']); l.failed('T01');
    const unknown = l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'unknown', phase: 'unclassified', failure_sha256: digest('old') });
    l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'harness', phase: 'outer_handoff', failure_sha256: digest('new') });
    has(measureAcceptance(l.input()), 'unknown', 'UNKNOWN_FAILURE', 'T01', unknown.sequence);
});

test('daemon-reclaimed orphan permits the production same-attempt resumption', () => {
    const l = ledger(['T01']); const old = l.acquire('T01'); l.start(old);
    old.expires_at = new Date(Date.parse(old.acquired_at) + 2000).toISOString(); old.ttl_ms = 2000;
    const recovered = l.add('task.lease.recovered', { task_id: 'T01', lease_id: old.lease_id, recovery_kind: 'daemon_reclaimed', confirmed_dead_pids: [42] });
    l.worker('T01'); l.finishTask('T01');
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.duplicates.passed, true);
    assert.equal(r.thresholds.unknown.passed, true);
    assert.equal(r.thresholds.duplicates.authorizedResumptions[0].evidence_sequence, recovered.sequence);
});

test('settlement of a different lease cannot reclassify the prior unknown cause', () => {
    const l = ledger(['T01']); l.failed('T01', 'FAILED', 'COLLECTION_FAILED');
    const unknown = l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'unknown', phase: 'unclassified', failure_sha256: digest('old') });
    const other = l.acquire('T01'); l.start(other);
    l.add('task.execution.finalization_failed', { task_id: 'T01', lease_id: other.lease_id, attempt: 1, controller_pid: 42,
        status: 'FAILED', code: 'COLLECTION_FAILED', summary: 'Recorded failure', stage: 'outer_handoff', settled: true, recovery: 'NONE' });
    l.add('task.failure.classified', { task_id: 'T01', attempt: 1, category: 'harness', phase: 'outer_handoff', failure_sha256: digest('new') });
    has(measureAcceptance(l.input()), 'unknown', 'UNKNOWN_FAILURE', 'T01', unknown.sequence);
});

test('derived finalization must match exact current ledger settlement', () => {
    const l = ledger(['T01']); const lease = l.acquire('T01'); l.start(lease);
    const finalization = l.add('task.execution.finalization_failed', { task_id: 'T01', lease_id: lease.lease_id, attempt: 1,
        controller_pid: 42, code: 'COLLECTION_FAILED', summary: 'Recorded failure', stage: 'outer_handoff', recovery: 'NONE', settled: true });
    const input = l.input(); input.derived.tasks.T01.finalization.settled = false;
    has(measureAcceptance(input), 'unknown', 'FINALIZATION_SNAPSHOT_MISMATCH', 'T01', finalization.sequence);
    assert.equal(measureAcceptance(input).taskResults[0].terminal, false);
});

test('missing lease expiry cannot disappear behind a released final snapshot', () => {
    const input = clean().input();
    const firstLease = input.events.find((e) => e.type === 'lease.acquired');
    delete firstLease.expires_at; delete input.derived.leases[firstLease.lease_id].expires_at;
    has(measureAcceptance(input), 'unknown', 'INVALID_LEASE_INTERVAL', 'T01', firstLease.sequence);
});

test('a caller cannot relabel one task as the complete ten-task acceptance suite', () => {
    const l = ledger(['T01']); l.worker('T01'); l.finishTask('T01');
    const input = l.input(); input.suiteTaskIds = ['T01'];
    const r = measureAcceptance(input);
    assert.equal(r.completeSuite, false);
    assert.equal(r.passed, false);
});

test('an integrated task that later fails still requires its captured source diff', () => {
    const l = ledger();
    for (const id of SUITE.slice(1)) { l.worker(id); l.finishTask(id); }
    l.worker('T01');
    const qc = l.acquire('T01', 'codex'); l.start(qc);
    l.add('gate.requested', { task_id: 'T01', gate_id: 'integrate-T01', phase: 'integrate', digest: digest('T01'), summary: 'Integrate' });
    l.add('gate.approved', { gate_id: 'integrate-T01', digest: digest('T01'), actor: 'human', via: 'cli-tty' });
    const receipt = l.add('gate.result', { task_id: 'T01', gate_id: 'isolated-qc-T01', status: 'PASSED',
        details: { integration_receipt: 'failed-operation-receipt', result_sha256: digest('T01') } });
    l.add('task.execution.outcome', { task_id: 'T01', lease_id: qc.lease_id, attempt: 1, status: 'FAILED', code: 'POST_INTEGRATION_FAILED', summary: 'Failure after source integration' });
    l.release(qc);
    const r = measureAcceptance(l.input());
    assert.equal(r.thresholds.requirements.met, 9);
    assert.equal(r.thresholds.requirements.passed, true);
    assert.equal(r.taskResults.find((t) => t.task_id === 'T01').effective_state, 'FAILED');
    assert.equal(r.passed, false);
    has(r, 'scope', 'MISSING_INTEGRATION_EVIDENCE', 'T01', receipt.sequence);
});

test('every distinct integration receipt needs a diff while duplicate gate evidence shares one operation', () => {
    const l = clean();
    const original = l.events.find((e) => e.type === 'gate.result' && e.task_id === 'T01');
    l.add('gate.result', { task_id: 'T01', gate_id: 'scope-T01', status: 'PASSED', details: { ...original.details } });
    assert.equal(measureAcceptance(l.input()).passed, true);
    const uncaptured = l.add('gate.result', { task_id: 'T01', gate_id: 'isolated-qc-T01', status: 'PASSED',
        details: { ...original.details, integration_receipt: 'another-source-operation' } });
    const r = measureAcceptance(l.input());
    assert.equal(r.passed, false);
    has(r, 'scope', 'MISSING_INTEGRATION_EVIDENCE', 'T01', uncaptured.sequence);
});

test('verified authority remains visible but a reopened pending or rejected gate is nonterminal', () => {
    for (const reject of [false, true]) {
        const l = clean();
        const reopened = l.add('gate.requested', { task_id: 'T01', gate_id: 'integrate-T01', phase: 'integrate', digest: digest('new-T01'), summary: 'New result needs approval' });
        if (reject) l.add('gate.rejected', { gate_id: 'integrate-T01', digest: reopened.digest, actor: 'human', via: 'cli-tty', reason: 'Revise new result' });
        const r = measureAcceptance(l.input());
        const task = r.taskResults.find((t) => t.task_id === 'T01');
        assert.equal(task.authority_state, 'TASK_VERIFIED');
        assert.equal(task.terminal, false);
        assert.equal(task.requirements_met, false);
        assert.equal(r.passed, false);
        has(r, 'unknown', 'TASK_NOT_TERMINAL', 'T01', reopened.sequence);
    }
});
