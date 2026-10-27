'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reduceRevisionEvent, revisionDigest } = require('../lib/dual/revision-policy');
const h = (v) => revisionDigest(v);
function fixture() {
    const task = { task_id: 'task-1', state: 'TASK_VERIFIED', owner: 'agy', allowed_files: ['a.js'],
        current_verified_version: { version_id: h('parent'), source_fingerprint: h('source') } };
    return { task, context: { tasks: { 'task-1': task }, sessionState: 'ACCEPTANCE', sessionId: 'session', planRevision: 1,
        leases: {}, gates: {}, verifySourceFingerprint: () => true, activeAcceptanceCorrection: null } };
}
function request(task, n = 1) {
    const contract = { schema_version: 2, reason: 'Change title', allowed_files: ['a.js'],
        affected_dimensions: ['content'], acceptance_criteria: ['Title changed'], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        parent_version_id: task.current_verified_version.version_id, source_fingerprint: task.current_verified_version.source_fingerprint,
        changes: 'files', dependency_contract_changed: false,
        candidate_plan: { schema_version: 2, plan_revision: 1,
            coverage: { path: 'coverage.json', sha256: h('coverage'), catalog_version: 1 },
            acceptance_policy: { protocol_version: 1, checks: [{ id: 'check', requirement_id: 'req', phase: 'session', kind: 'command', required: true,
                command: { program: 'node', args: ['--version'], cwd: '.' } }] },
            tasks: [{ task_id: task.task_id, title: 'Title', goal: 'Goal', owner: 'agy', category: 'frontend', complexity: 'medium', risk: 'low',
                allowed_files: ['a.js'], context_files: [], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }], decision_ids: [] }] } };
    const event = { type: 'task.revision.requested', task_id: task.task_id, session_id: 'session', plan_revision: 1, sequence: n,
        expected_sequence: n - 1, revision_id: `revision-${n}`, request_id: `request-${n}`, parent_version_id: contract.parent_version_id,
        source_fingerprint: contract.source_fingerprint, contract, contract_sha256: h(contract) };
    event.approval = { approved_by: 'user', grant_id: `grant-${n}`, revision_id: event.revision_id, parent_version_id: event.parent_version_id,
        contract_sha256: event.contract_sha256, source_fingerprint: event.source_fingerprint };
    event.request_sha256 = h({ revision_id: event.revision_id, parent_version_id: event.parent_version_id,
        source_fingerprint: event.source_fingerprint, contract_sha256: event.contract_sha256, approval: event.approval });
    return event;
}
function start(event) { return { ...event, type: 'task.revision.started', sequence: event.sequence + 1,
    expected_sequence: event.sequence, grant_id: event.approval.grant_id }; }
test('revision lifetime counts starts, including failure/cancellation; request replay is bound to payload', () => {
    const { task, context } = fixture();
    for (let i = 1; i <= 4; i++) {
        const event = request(task, i * 3);
        reduceRevisionEvent(task, event, context);
        reduceRevisionEvent(task, event, context);
        assert.throws(() => reduceRevisionEvent(task, { ...event, request_sha256: h('other') }, context), /conflict/i);
        if (i === 4) { assert.throws(() => reduceRevisionEvent(task, start(event), context), /budget/i); break; }
        reduceRevisionEvent(task, start(event), context);
        assert.equal(task.revisions_started, i);
        assert.throws(() => reduceRevisionEvent(task, start(event), context), /grant|start/i);
        reduceRevisionEvent(task, { ...start(event), type: i === 2 ? 'task.revision.cancelled' : 'task.revision.failed', attempt: 1, reason: 'closed' }, context);
        assert.equal(task.state, 'TASK_VERIFIED');
    }
});
test('revision requires user-approved v2 and exact single-use grant bindings', () => {
    for (const field of ['revision_id', 'parent_version_id', 'contract_sha256', 'source_fingerprint']) {
        const { task, context } = fixture(); const event = request(task);
        reduceRevisionEvent(task, event, context);
        assert.throws(() => reduceRevisionEvent(task, { ...start(event), [field]: h('wrong') }, context));
    }
    const { task, context } = fixture(); const event = request(task); event.contract.schema_version = 1;
    assert.throws(() => reduceRevisionEvent(task, event, context), /v2|contract/i);
});
test('one active revision per session and acceptance correction mutual exclusion', () => {
    const { task, context } = fixture(); const event = request(task);
    context.activeAcceptanceCorrection = { correctionId: 'busy' };
    assert.throws(() => reduceRevisionEvent(task, event, context), /correction/i);
    context.activeAcceptanceCorrection = null; reduceRevisionEvent(task, event, context);
    const next = { ...task, task_id: 'task-2', active_revision: undefined, revision_requests: undefined };
    context.tasks['task-2'] = next;
    assert.throws(() => reduceRevisionEvent(next, request(next, 2), context), /active revision/i);
});
test('phase changes require controller evidence, candidate digest, and parent CAS on promotion', () => {
    const { task, context } = fixture(); const event = request(task);
    reduceRevisionEvent(task, event, context); reduceRevisionEvent(task, start(event), context);
    assert.throws(() => reduceRevisionEvent(task, { ...start(event), type: 'task.revision.phase.changed', from: 'EXECUTING', to: 'READY', attempt: 1,
        evidence: { controller_verified: true, candidate_sha256: h('candidate') } }, context), /evidence|phase/i);
    task.active_revision.state = 'PROMOTING'; task.active_revision.candidate_sha256 = h('candidate');
    task.current_verified_version = { version_id: h('changed') };
    assert.throws(() => reduceRevisionEvent(task, { ...start(event), type: 'task.revision.promoted', attempt: 1,
        candidate_sha256: h('candidate') }, context), /parent|CAS/i);
});

test('successful promotion preserves lifetime counter and immutable parent history', () => {
    const { task, context } = fixture(); const event = request(task);
    reduceRevisionEvent(task, event, context); reduceRevisionEvent(task, start(event), context);
    const original = task.current_verified_version;
    const digest = h('new bytes');
    context.verifyRevisionEvidence = () => true;
    task.active_revision.isolatedHandoff = { result_sha256: digest };
    const change = (from, to, kind) => ({ type: 'task.revision.phase.changed', session_id: 'session', plan_revision: 1,
        task_id: task.task_id, revision_id: event.revision_id, attempt: 1, from, to,
        evidence: { candidate_sha256: digest, kind, reference: 'evidence.json', sha256: h(kind) } });
    reduceRevisionEvent(task, change('EXECUTING', 'QC', 'handoff'), context);
    context.gates[`revision-${event.revision_id}-1-isolated-qc-${task.task_id}`] = { status: 'PASSED', details: { result_sha256: digest, commands: [{ exit_code: 0 }] } };
    reduceRevisionEvent(task, change('QC', 'READY', 'qc'), context);
    reduceRevisionEvent(task, change('READY', 'PROMOTING', 'promotion'), context);
    reduceRevisionEvent(task, { ...start(event), type: 'task.revision.promoted', attempt: 1,
        candidate_sha256: digest, version_id: h('version2'), integrated_source_fingerprint: h('integrated'), expected_sequence: event.sequence, evidence: change('READY', 'PROMOTING', 'integration').evidence }, context);
    assert.equal(task.revisions_started, 1);
    assert.equal(task.current_verified_version.parent_version_id, original.version_id);
    assert.equal(task.verified_versions[0], original);
    assert.equal(task.state, 'TASK_VERIFIED');
});

test('candidate recovery caps worker at two, harness at one, total at three independently of parent', () => {
    const { authorizeCorrection, applyCorrectionBudget, failureEvidence } = require('../lib/dual/correction-policy');
    const candidate = { task_id: 'task-1', revision_id: 'revision-1', attempt: 1,
        recoveryPolicy: { policy_version: 1, worker_limit: 2, harness_limit: 1, total_limit: 3 },
        lastOutcome: { attempt: 1, code: 'RESULT_MALFORMED', status: 'FAILED' } };
    const context = { sessionId: 'session', planRevision: 1 };
    function classify() {
        candidate.failureClassification = { attempt: candidate.attempt,
            category: candidate.lastOutcome.code === 'RESULT_MALFORMED' ? 'worker' : 'harness',
            phase: candidate.lastOutcome.code === 'RESULT_MALFORMED' ? 'worker_result' : 'outer_handoff',
            failure_sha256: failureEvidence(candidate, context) };
    }
    classify(); assert.equal(authorizeCorrection(candidate, { expectedAttempt: 1, ...context }).budget_class, 'worker');
    candidate.previousAttempts = [{ correction: { budget_class: 'worker' } }, { correction: { budget_class: 'worker' } }];
    assert.throws(() => authorizeCorrection(candidate, { expectedAttempt: 1, ...context }), /Worker correction budget/);
    candidate.lastOutcome.code = 'HARNESS_ERROR'; candidate.finalization = { settled: true, stage: 'outer_handoff' }; classify();
    candidate.recoveryGrants = [{ grant_id: 'single', consumed: false, attempt: 2, failure_sha256: candidate.failureClassification.failure_sha256, policy_version: 1 }];
    const metadata = authorizeCorrection(candidate, { expectedAttempt: 1, grantId: 'single', ...context });
    applyCorrectionBudget(candidate, { previous_attempt: 1, ...metadata }, context);
    assert.equal(candidate.recoveryGrants[0].consumed, true);
    assert.throws(() => authorizeCorrection(candidate, { expectedAttempt: 1, grantId: 'single', ...context }), /single-use/);
    candidate.previousAttempts.push({ correction: { budget_class: 'harness' } });
    assert.throws(() => authorizeCorrection(candidate, { expectedAttempt: 1, grantId: 'single', ...context }), /Total recovery budget/);
    candidate.recoveryPolicy.total_limit = 4;
    assert.throws(() => authorizeCorrection(candidate, { expectedAttempt: 1, grantId: 'single', ...context }), /fixed/);
});

function authorityFixture(t) {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { createAuthorityStore } = require('../lib/dual/authority-store');
    const { revisionSourceFingerprint } = require('../lib/dual/task-revision-integration');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'a.js'), 'module.exports=1;\n');
    const directory = path.join(root, '.omni/runs/session'); fs.mkdirSync(directory, { recursive: true });
    const store = createAuthorityStore(directory);
    store.append({ type: 'session.created', workspace_id: 'workspace', session_id: 'session', workspace_root: root,
        expected_baseline: { kind: 'snapshot', id: h('baseline') }, state: 'DISCOVERED', mode: 'auto' });
    store.append({ type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED', checks: [{ name: 'safe', status: 'PASSED' }] });
    store.append({ type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED', plan_path: 'plan.json', plan_sha256: h('plan'), total_tasks: 1,
        tasks: [{ task_id: 'task-1', title: 'Title', owner: 'agy', allowed_files: ['a.js'] }] });
    store.append({ type: 'task.routed', task_id: 'task-1', owner: 'agy', authority_state: 'ROUTED', allowed_files: ['a.js'], reason: 'implement' });
    const lease = store.acquireLease('task-1', 'agy');
    store.append({ type: 'task.completed', task_id: 'task-1', owner: 'agy', authority_state: 'TASK_VERIFIED', modified_files: ['a.js'], diff_fingerprint: h('parent'), verdict: 'SUCCESS', verified_by: 'codex' });
    store.releaseLease(lease.lease_id, 'completed');
    const task = store.derive().tasks['task-1'];
    const event = request(task, store.verifyIntegrity().lastSequence + 1);
    event.source_fingerprint = revisionSourceFingerprint(root); event.contract.source_fingerprint = event.source_fingerprint;
    event.contract_sha256 = h(event.contract); event.approval.source_fingerprint = event.source_fingerprint;
    event.approval.contract_sha256 = event.contract_sha256;
    event.request_sha256 = h({ revision_id: event.revision_id, parent_version_id: event.parent_version_id,
        source_fingerprint: event.source_fingerprint, contract_sha256: event.contract_sha256, approval: event.approval });
    return { root, fs, path, store, event };
}
test('durable reducer blocks session verification and acceptance correction while candidate is requested', t => {
    const { store, event } = authorityFixture(t);
    store.append(event);
    assert.throws(() => store.append({ type: 'session.verified', from_state: 'ACCEPTANCE', to_state: 'VERIFIED',
        completed_tasks: ['task-1'], receipt_sha256: h('receipt') }), { code: 'DUAL_REVISION_ACTIVE' });
    assert.throws(() => store.append({ type: 'acceptance.correction.started', correction_id: '10000000-0000-4000-8000-000000000001', task_id: 'task-1', attempt: 1, allowed_files: ['a.js'], reason: 'competing' }), /revision/);
    assert.equal(store.derive().sessionState, 'ACCEPTANCE');
});
test('durable candidate questions, outcomes and leases remain isolated from verified parent across replay', t => {
    const { store, event } = authorityFixture(t); store.append(event);
    const started = start(event); delete started.contract; delete started.approval; delete started.request_id; delete started.request_sha256;
    store.append(started);
    const scoped = store.forRevision('task-1', event.revision_id), lease = scoped.acquireLease('task-1', 'agy');
    scoped.append({ type: 'task.questions', task_id: 'task-1', lease_id: lease.lease_id, questions: [{ message_id: 'question-1', body: 'Which title?' }] });
    scoped.append({ type: 'task.message', task_id: 'task-1', kind: 'reply', message_id: 'reply-1', body: 'Approved title', reply_to: 'question-1',
        context_scope: { contract_sha256: event.contract_sha256, disposition: 'within_contract' } });
    const parent = store.derive().tasks['task-1'];
    assert.equal(parent.state, 'TASK_VERIFIED'); assert.equal(parent.messages, undefined);
    assert.equal(parent.active_revision.waitingContext.revision_id, event.revision_id);
    assert.equal(parent.active_revision.waitingContext.contract_sha256, event.contract_sha256);
    assert.equal(store.derive().leases[lease.lease_id].revision_id, event.revision_id);
    scoped.append({ type: 'task.execution.outcome', lease_id: lease.lease_id, attempt: 1, status: 'FAILED', code: 'RESULT_MALFORMED', summary: 'candidate only' });
    assert.equal(store.derive().tasks['task-1'].lastOutcome, undefined);
    assert.equal(store.derive().tasks['task-1'].active_revision.lastOutcome.code, 'RESULT_MALFORMED');
    assert.equal(store.verifyIntegrity().valid, true);
});
test('durable start rejects source drift without consuming budget', t => {
    const { root, fs, path, store, event } = authorityFixture(t); store.append(event);
    fs.writeFileSync(path.join(root, 'a.js'), 'changed');
    const started = start(event); delete started.contract; delete started.approval; delete started.request_id; delete started.request_sha256;
    assert.throws(() => store.append(started), /fingerprint/);
    assert.equal(store.derive().tasks['task-1'].revisions_started || 0, 0);
});

test('phase reducer rejects forged caller pass and enforces hash-bound artifact identity', t => {
    const { root, fs, path, store, event } = authorityFixture(t); store.append(event);
    const started = start(event); delete started.contract; delete started.approval; delete started.request_id; delete started.request_sha256;
    store.append(started);
    const reference = '.omni/runs/fake.json', candidateDigest = h('candidate');
    const bytes = JSON.stringify({ session_id: 'session', task_id: 'task-1', revision_id: 'WRONG', attempt: 1,
        candidate_sha256: candidateDigest, kind: 'handoff', verified_by: 'codex' });
    fs.writeFileSync(path.join(root, reference), bytes);
    const crypto = require('node:crypto');
    assert.throws(() => store.append({ type: 'task.revision.phase.changed', task_id: 'task-1', revision_id: event.revision_id,
        attempt: 1, from: 'EXECUTING', to: 'QC', evidence: { kind: 'handoff', candidate_sha256: candidateDigest, reference,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex') } }), { code: 'DUAL_REVISION_EVIDENCE_REQUIRED' });
    assert.equal(store.derive().tasks['task-1'].active_revision.state, 'EXECUTING');
});
test('candidate reply requires explicit pinned-scope declaration and amendment parks execution', t => {
    const { store, event } = authorityFixture(t); store.append(event);
    const started = start(event); delete started.contract; delete started.approval; delete started.request_id; delete started.request_sha256;
    store.append(started);
    const scoped = store.forRevision('task-1', event.revision_id), lease = scoped.acquireLease('task-1', 'agy');
    scoped.append({ type: 'task.questions', lease_id: lease.lease_id, questions: [{ message_id: 'scope-question', body: 'May I add another file?' }] });
    const reply = { type: 'task.message', kind: 'reply', message_id: 'scope-reply', body: 'Add an out-of-scope file', reply_to: 'scope-question' };
    assert.throws(() => scoped.append(reply), { code: 'DUAL_REVISION_AMENDMENT_REVIEW_REQUIRED' });
    scoped.append({ ...reply, context_scope: { contract_sha256: event.contract_sha256, disposition: 'amendment_required' } });
    assert.equal(store.derive().tasks['task-1'].active_revision.amendment_required, true);
    assert.throws(() => scoped.append({ type: 'task.execution.started', lease_id: lease.lease_id, controller_pid: process.pid }), { code: 'DUAL_REVISION_AMENDMENT_REVIEW_REQUIRED' });
    assert.equal(store.derive().tasks['task-1'].state, 'TASK_VERIFIED');
});
