'use strict';

const { classifyFailure } = require('../../lib/dual/correction-policy');
const { isDelegatedDecision } = require('./acceptance-delegation');

const time = (value) => Date.parse(value);
const attemptOf = (task) => task?.isolatedWorkspace?.attempt || task?.correction?.attempt || task?.attempt || 1;
const lineage = (e) => [e.workspace_id, e.session_id, e.plan_revision, e.revision_id || '', e.task_id].join(':');
const attemptKey = (e, attempt) => `${lineage(e)}:${attempt}`;
const finalizationKey = (e) => `${attemptKey(e, e.attempt)}:${e.lease_id}:${e.controller_pid}:${e.stage}:${e.code}`;
const sameOutcome = (a, b) => a && b && a.attempt === b.attempt && a.status === b.status && a.code === b.code && a.summary === b.summary;
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
const trace = (e, extra = {}) => ({ ...(e?.task_id ? { task_id: e.task_id } : {}), sequence: e?.sequence ?? null,
    ...(e?.event_id ? { event_id: e.event_id } : {}), ...extra });

/** Evaluate one immutable, verified authority snapshot and captured integration diffs. */
function measureAcceptance(input = {}) {
    const { events = [], derived = {}, snapshot = {}, gatePolicy = {}, integrations = [], hiddenTests = {},
        taskContracts = [], suiteTaskIds = [] } = input;
    const thresholds = Object.fromEntries(['requirements', 'scope', 'unknown', 'duplicates', 'gates']
        .map((name) => [name, { passed: false, violations: [] }]));
    const add = (threshold, code, e, extra) => thresholds[threshold].violations.push({ code, ...trace(e, extra) });
    const evidence = (code, e, extra) => add('unknown', code, e, extra);
    thresholds.scope.blockedAttempts = [];
    thresholds.duplicates.authorizedResumptions = [];
    thresholds.duplicates.controllerStarts = [];
    thresholds.gates.evidenceMode = gatePolicy.delegation ? 'delegated-benchmark' : 'human-tty';
    thresholds.gates.provesHumanTty = !gatePolicy.delegation;
    if (input.sourceIntegrity) {
        const source = input.sourceIntegrity;
        if (source.passed !== true || source.violations?.length) {
            const violations = source.violations?.length ? source.violations : [{ code: 'ACCEPTANCE_SOURCE_OBSERVATION_INCOMPLETE' }];
            for (const violation of violations) add('scope', violation.code, null, { changed_files: violation.changed_files || [] });
        }
    }
    if (!Array.isArray(events) || !Array.isArray(taskContracts) || !Array.isArray(integrations) || !Array.isArray(suiteTaskIds)) {
        evidence('INVALID_INPUT');
        return { passed: false, thresholdsPassed: false, completeSuite: false, taskResults: [], thresholds };
    }
    const contracts = new Map(taskContracts.map((c) => [c.task_id, c]));
    if (!events.length || !contracts.size || !suiteTaskIds.length || contracts.size !== taskContracts.length
        || new Set(suiteTaskIds).size !== suiteTaskIds.length
        || taskContracts.some((c) => !c.task_id || !Array.isArray(c.allowed_files) || !suiteTaskIds.includes(c.task_id))) evidence('INCOMPLETE_EVIDENCE');
    if (!Number.isFinite(time(snapshot.endedAt)) || !Number.isInteger(snapshot.lastSequence)
        || events.at(-1)?.sequence !== snapshot.lastSequence || derived.lastSequence !== snapshot.lastSequence
        || ['sessionId', 'workspaceId', 'planRevision'].some((key) => !snapshot[key] || derived[key] !== snapshot[key])) evidence('SNAPSHOT_MISMATCH');

    const leases = new Map(), starts = new Map(), latestWorker = new Map(), approvals = new Map(), plans = new Map();
    const outcomes = new Map(), classifications = [], finalizations = new Map(), workspaces = new Map(), corrections = new Map();
    const currentFinalizations = new Map();
    const completions = new Map(), questions = new Map(), replies = new Map(), claims = new Map(), recoveryEvidence = [];
    const usedResumptions = new Set();
    const observedIntegrationTasks = new Set();
    const integrationOperations = new Map(), capturedOperations = new Set();
    const operationKey = (e, attempt, receipt, result) => `${attemptKey(e, attempt)}:${receipt}:${result}`;
    const integrationsAt = new Map();
    for (const integration of integrations) {
        const list = integrationsAt.get(integration.sequence) || [];
        list.push(integration); integrationsAt.set(integration.sequence, list);
        const contract = contracts.get(integration.task_id);
        if (!contract || !Array.isArray(integration.changed_files) || !integration.result_sha256
            || !Number.isInteger(integration.attempt) || !events.some((e) => e.sequence === integration.sequence && e.task_id === integration.task_id)) {
            add('scope', 'MISSING_INTEGRATION_EVIDENCE', integration); continue;
        }
        for (const file of integration.changed_files) {
            // Collectors supply both paths of a rename as separate changed files.
            if (typeof file !== 'string' || !Array.isArray(contract.allowed_files) || !contract.allowed_files.includes(file)) add('scope', 'OUT_OF_SCOPE_INTEGRATION', integration, { file });
        }
    }
    function approved(gateId, digest) {
        const gate = approvals.get(gateId);
        return gate?.status === 'approved' && gate.authorized && gate.digest === digest;
    }
    function currentAttempt(taskId) { return workspaces.get(taskId)?.attempt || corrections.get(taskId)?.attempt || 1; }
    function matchingExecution(e) {
        const execution = derived.tasks?.[e.task_id]?.executions?.[e.lease_id];
        if (!execution || !Number.isInteger(execution.attempt) || execution.attempt < 1
            || execution.started_sequence !== e.sequence || execution.attempt !== currentAttempt(e.task_id)) {
            evidence('MISSING_EXECUTION_ATTEMPT', e, { lease_id: e.lease_id });
            return null;
        }
        return execution.attempt;
    }
    function causalClassification(e) {
        const outcome = outcomes.get(e.task_id);
        const prior = classifications.filter((c) => !c.resolved && c.event.category === 'unknown'
            && attemptKey(c.event, c.event.attempt) === attemptKey(e, e.attempt));
        if (e.category !== 'unknown') {
            const finalization = [...finalizations.values()].find((f) => f.event.task_id === e.task_id
                && f.event.attempt === e.attempt && f.event.lease_id === outcome?.lease_id && f.settled);
            const expected = classifyFailure({ lastOutcome: outcome, finalization: finalization
                ? { settled: true, stage: finalization.event.stage } : undefined });
            if (outcome?.attempt === e.attempt && expected.category === e.category && expected.phase === e.phase) {
                for (const old of prior) {
                    if (old.outcome?.attempt === outcome.attempt && old.outcome.lease_id === outcome.lease_id && old.outcome.code === outcome.code
                        && old.outcome.status === outcome.status
                        && (sameOutcome(old.outcome, outcome) || finalization?.first.sequence > old.event.sequence)) old.resolved = true;
                }
            }
        }
        classifications.push({ event: e, outcome: outcome ? { ...outcome } : null, resolved: false });
    }
    function authorizeResumption(e, attempt, previous) {
        const priorLease = leases.get(previous.lease_id);
        if (!priorLease?.released_at || priorLease.release_sequence >= e.sequence) return null;
        const sameAttempt = (item) => item.event.sequence > previous.sequence && item.event.sequence < e.sequence
            && lineage(item.event) === lineage(e) && item.attempt === attempt && !usedResumptions.has(item.event.sequence);
        const recovery = recoveryEvidence.find((item) => sameAttempt(item) && item.lease_id === previous.lease_id);
        if (recovery) return recovery;
        const claim = claims.get(e.task_id);
        const priorQuestions = questions.get(previous.lease_id);
        if (!claim || claim.status !== 'claimed' || claim.event.attempt !== attempt || !priorQuestions?.ids.length
            || claim.event.sequence <= priorQuestions.event.sequence || claim.event.sequence <= previous.sequence
            || usedResumptions.has(claim.event.sequence) || !Array.isArray(claim.event.reply_ids)) return null;
        const replyEvents = priorQuestions.ids.map((id) => [...replies.values()].find((reply) => reply.task_id === e.task_id
            && reply.reply_to === id && reply.sequence > priorQuestions.event.sequence && reply.sequence < claim.event.sequence
            && typeof reply.body === 'string' && reply.body.trim()));
        if (replyEvents.some((reply) => !reply) || !sameSet(claim.event.reply_ids, replyEvents.map((reply) => reply.message_id))) return null;
        return { event: claim.event, kind: 'context', attempt, lease_id: previous.lease_id };
    }

    for (let index = 0; index < events.length; index++) {
        const e = events[index];
        if (!e || e.sequence !== index + 1 || e.session_id !== snapshot.sessionId || e.workspace_id !== snapshot.workspaceId
            || e.plan_revision !== snapshot.planRevision || !Number.isFinite(time(e.timestamp)) || time(e.timestamp) > time(snapshot.endedAt)
            || e.revision_id) evidence('EVENT_SNAPSHOT_MISMATCH', e);
        if (!e) continue;
        switch (e.type) {
            case 'plan.registered': plans.set(e.plan_revision, e); break;
            case 'lease.acquired': {
                if (leases.has(e.lease_id)) evidence('DUPLICATE_LEASE_ID', e, { lease_id: e.lease_id });
                if (!Number.isFinite(time(e.acquired_at)) || !Number.isFinite(time(e.expires_at)) || !(e.ttl_ms > 0)
                    || time(e.expires_at) !== time(e.acquired_at) + e.ttl_ms) evidence('INVALID_LEASE_INTERVAL', e, { lease_id: e.lease_id });
                leases.set(e.lease_id, { ...e, acquired_sequence: e.sequence, released_at: null });
                break;
            }
            case 'lease.renewed': {
                const lease = leases.get(e.lease_id);
                if (lease) lease.expires_at = e.expires_at;
                else evidence('UNKNOWN_LEASE', e, { lease_id: e.lease_id });
                break;
            }
            case 'lease.released': {
                const lease = leases.get(e.lease_id);
                if (lease) Object.assign(lease, { released_at: e.released_at, release_sequence: e.sequence });
                else evidence('UNKNOWN_LEASE', e, { lease_id: e.lease_id });
                break;
            }
            case 'task.execution.started': {
                const lease = leases.get(e.lease_id);
                const attempt = matchingExecution(e);
                if (!lease || lease.task_id !== e.task_id || lease.released_at
                    || time(e.timestamp) < time(lease.acquired_at) || time(e.timestamp) >= time(lease.expires_at)) evidence('INVALID_EXECUTION_LEASE', e, { lease_id: e.lease_id });
                if (starts.has(e.lease_id)) add('duplicates', 'DUPLICATE_EXECUTION_START', e, { lease_id: e.lease_id, related_sequences: [starts.get(e.lease_id).sequence, e.sequence] });
                starts.set(e.lease_id, e);
                if (outcomes.get(e.task_id)?.code === 'DUAL_WORKER_LOST'
                    && outcomes.get(e.task_id).attempt === attempt) outcomes.delete(e.task_id);
                if (lease?.owner === 'codex') thresholds.duplicates.controllerStarts.push(trace(e, { lease_id: e.lease_id, attempt }));
                else if (lease?.owner === 'agy') {
                    const plan = plans.get(e.plan_revision);
                    if (!plan || !approved(`plan-r${e.plan_revision}`, plan.plan_sha256)) add('gates', 'WORKER_BEFORE_PLAN_APPROVAL', e);
                    const key = attemptKey(e, attempt);
                    const previous = latestWorker.get(key);
                    if (previous) {
                        const resumption = authorizeResumption(e, attempt, previous);
                        if (!resumption) add('duplicates', 'DUPLICATE_WORKER_DISPATCH', e, { attempt, lease_id: e.lease_id, related_sequences: [previous.sequence, e.sequence] });
                        else {
                            usedResumptions.add(resumption.event.sequence);
                            thresholds.duplicates.authorizedResumptions.push(trace(e, { attempt, lease_id: e.lease_id,
                                previous_lease_id: previous.lease_id, kind: resumption.kind, evidence_sequence: resumption.event.sequence }));
                        }
                    }
                    latestWorker.set(key, e);
                } else evidence('UNKNOWN_EXECUTION_OWNER', e, { lease_id: e.lease_id });
                break;
            }
            case 'task.workspace.prepared': workspaces.set(e.task_id, e); break;
            case 'task.execution.outcome': outcomes.set(e.task_id, e); break;
            case 'task.execution.finalization_failed': {
                const key = finalizationKey(e), prior = finalizations.get(key);
                if (!prior) finalizations.set(key, { first: e, event: e, settled: e.settled === true });
                else if (!prior.settled && e.settled === true && e.recovery === 'NONE') Object.assign(prior, { event: e, settled: true });
                else evidence('INVALID_FINALIZATION_TRANSITION', e, { related_sequences: [prior.first.sequence, e.sequence] });
                outcomes.set(e.task_id, { ...e, status: 'FAILED' });
                currentFinalizations.set(e.task_id, e);
                const lease = leases.get(e.lease_id);
                if (lease && e.settled) Object.assign(lease, { released_at: e.timestamp, release_sequence: e.sequence });
                break;
            }
            case 'task.failure.classified': causalClassification(e); break;
            case 'task.execution.outcome.recovered': {
                const outcome = outcomes.get(e.task_id);
                const exact = outcome && attemptKey(e, e.previous_attempt) === attemptKey(outcome, outcome.attempt)
                    && e.previous_status === outcome.status && e.previous_code === outcome.code && e.previous_summary === outcome.summary
                    && ['scout', 'review'].includes(e.recovery_phase) && e.recovery_error_code === 'DUAL_DISCUSSION_FAILED';
                if (exact) {
                    for (const c of classifications) if (!c.resolved && lineage(c.event) === lineage(e)
                        && c.event.attempt === e.previous_attempt && sameOutcome(c.outcome, outcome)) c.resolved = true;
                    recoveryEvidence.push({ event: e, kind: 'outcome', attempt: e.previous_attempt, lease_id: outcome.lease_id });
                    outcomes.delete(e.task_id);
                } else evidence('OUTCOME_RECOVERY_MISMATCH', e);
                break;
            }
            case 'task.lease.recovered': {
                const lease = leases.get(e.lease_id);
                const started = starts.get(e.lease_id);
                if (!lease || lease.task_id !== e.task_id) evidence('UNKNOWN_LEASE', e, { lease_id: e.lease_id });
                else {
                    Object.assign(lease, { released_at: e.timestamp, release_sequence: e.sequence });
                    if (started && ['owner_dead', 'operation_settled', 'daemon_reclaimed'].includes(e.recovery_kind)) recoveryEvidence.push({ event: e,
                        kind: 'lease', lease_id: e.lease_id, attempt: derived.tasks?.[e.task_id]?.executions?.[e.lease_id]?.attempt });
                    // Replay creates this failure for a reclaimed daemon, then a
                    // matching new execution removes it without a correction.
                    if (e.recovery_kind === 'daemon_reclaimed') outcomes.set(e.task_id, { ...e, attempt: currentAttempt(e.task_id),
                        status: 'FAILED', code: 'DUAL_WORKER_LOST',
                        summary: 'Isolated worker was lost when its daemon died before settling; the orphaned operation was settled as failed and the attempt is eligible for a bounded correction.' });
                }
                break;
            }
            case 'task.correction.requested':
                corrections.set(e.task_id, e); workspaces.delete(e.task_id); outcomes.delete(e.task_id); currentFinalizations.delete(e.task_id); break;
            case 'task.questions': questions.set(e.lease_id, { event: e, ids: (e.questions || []).map((q) => q.message_id) }); break;
            case 'task.message':
                if (e.kind === 'reply') replies.set(e.message_id, e);
                else if (e.kind === 'question') {
                    const prior = questions.get(e.lease_id);
                    questions.set(e.lease_id, { event: e, ids: [...(prior?.ids || []), e.message_id] });
                }
                break;
            case 'task.context.dispatch.claimed': claims.set(e.task_id, { event: e, status: 'claimed' }); break;
            case 'task.context.dispatch.settled': {
                const claim = claims.get(e.task_id);
                if (claim?.event.execution_id === e.execution_id) claim.status = e.status;
                else evidence('CONTEXT_SETTLEMENT_MISMATCH', e);
                break;
            }
            case 'gate.requested': approvals.set(e.gate_id, { ...e, status: 'pending', authorized: false }); break;
            case 'gate.approved':
            case 'gate.rejected': {
                const gate = approvals.get(e.gate_id);
                if (!gate || gate.status !== 'pending' || gate.digest !== e.digest) {
                    add('gates', 'GATE_DECISION_NOT_PENDING', e, gate?.task_id ? { task_id: gate.task_id } : {}); break;
                }
                const policy = gatePolicy.phases?.[gate.phase];
                const human = e.actor === 'human' && e.via === 'cli-tty';
                const auto = e.type === 'gate.approved' && e.actor === 'auto' && e.via === 'pipeline-auto'
                    && gatePolicy.auto === true && ['spec', 'plan'].includes(gate.phase) && policy?.gated === true && policy.autoOk === true;
                const authorized = human || auto || isDelegatedDecision(gate, e, gatePolicy.delegation);
                if (!authorized) add('gates', 'UNAUTHORIZED_GATE_DECISION', e, { ...(gate.task_id ? { task_id: gate.task_id } : {}), gate_id: e.gate_id });
                Object.assign(gate, { status: e.type === 'gate.approved' ? 'approved' : 'rejected', authorized });
                break;
            }
            case 'gate.result':
                if (e.status === 'FAILED' && (e.gate_id === 'scope' || e.gate_id?.startsWith('scope-'))) thresholds.scope.blockedAttempts.push(trace(e, { gate_id: e.gate_id }));
                if (e.details?.integration_receipt) {
                    const attempt = currentAttempt(e.task_id);
                    const key = operationKey(e, attempt, e.details.integration_receipt, e.details.result_sha256);
                    // Production emits several gate results for the same source
                    // write; one captured diff covers that exact receipt only.
                    if (!integrationOperations.has(key)) integrationOperations.set(key, { event: e, attempt });
                    if (!approved(`integrate-${e.task_id}`, e.details.result_sha256)) add('gates', 'INTEGRATION_WITHOUT_APPROVAL', e);
                }
                break;
            case 'task.completed':
                completions.set(e.task_id, e);
                if (!approved(`integrate-${e.task_id}`, e.diff_fingerprint)) add('gates', 'INTEGRATION_WITHOUT_APPROVAL', e);
                break;
            default: break;
        }
        for (const integration of integrationsAt.get(e.sequence) || []) {
            const eventResult = e.type === 'task.completed' ? e.diff_fingerprint : e.details?.integration_receipt ? e.details.result_sha256 : null;
            if (integration.task_id !== e.task_id || integration.result_sha256 !== eventResult
                || integration.attempt !== currentAttempt(integration.task_id)) evidence('INTEGRATION_RESULT_MISMATCH', integration);
            else {
                observedIntegrationTasks.add(integration.task_id);
                if (e.details?.integration_receipt) capturedOperations.add(operationKey(e, integration.attempt,
                    e.details.integration_receipt, integration.result_sha256));
                else {
                    // A completion anchor belongs to the latest preceding
                    // receipt with that result and attempt, not every prior write.
                    const operation = [...integrationOperations.entries()].reverse().find(([, op]) => lineage(op.event) === lineage(e)
                        && op.attempt === integration.attempt && op.event.details.result_sha256 === integration.result_sha256);
                    if (operation) capturedOperations.add(operation[0]);
                }
            }
            if (!approved(`integrate-${integration.task_id}`, integration.result_sha256)) add('gates', 'INTEGRATION_WITHOUT_APPROVAL', integration);
        }
    }

    for (const [key, operation] of integrationOperations) if (!capturedOperations.has(key)) {
        add('scope', 'MISSING_INTEGRATION_EVIDENCE', operation.event, { attempt: operation.attempt,
            integration_receipt: operation.event.details.integration_receipt, result_sha256: operation.event.details.result_sha256 });
    }

    const allLeases = [...leases.values()];
    for (const lease of allLeases) {
        const stored = derived.leases?.[lease.lease_id];
        if (!stored || stored.task_id !== lease.task_id || (stored.released_at || null) !== (lease.released_at || null)
            || stored.expires_at !== lease.expires_at) evidence('LEASE_SNAPSHOT_MISMATCH', lease, { lease_id: lease.lease_id });
        if (!lease.released_at) evidence('UNRELEASED_LEASE', lease, { lease_id: lease.lease_id,
            status: time(lease.expires_at) <= time(snapshot.endedAt) ? 'expired' : 'active' });
    }
    for (const stored of Object.values(derived.leases || {})) if (!leases.has(stored.lease_id || stored.leaseId)) evidence('MISSING_LEASE_HISTORY',
        { task_id: stored.task_id, sequence: stored.acquired_sequence }, { lease_id: stored.lease_id || stored.leaseId });
    for (let i = 0; i < allLeases.length; i++) for (let j = i + 1; j < allLeases.length; j++) {
        const a = allLeases[i], b = allLeases[j];
        if (a.task_id !== b.task_id) continue;
        const endA = Math.min(time(a.expires_at), a.released_at ? time(a.released_at) : Infinity);
        const endB = Math.min(time(b.expires_at), b.released_at ? time(b.released_at) : Infinity);
        if (Math.max(time(a.acquired_at), time(b.acquired_at)) < Math.min(endA, endB)) add('duplicates', 'OVERLAPPING_LEASES', b,
            { lease_id: b.lease_id, other_lease_id: a.lease_id, related_sequences: [a.acquired_sequence, b.acquired_sequence] });
    }
    for (const f of finalizations.values()) if (!f.settled) evidence('UNSETTLED_FINALIZATION', f.first, { lease_id: f.first.lease_id, attempt: f.first.attempt });
    for (const c of classifications) if (c.event.category === 'unknown' && !c.resolved) evidence('UNKNOWN_FAILURE', c.event,
        { attempt: c.event.attempt, failure_sha256: c.event.failure_sha256 });

    const taskResults = taskContracts.map((contract) => {
        const id = contract.task_id, task = derived.tasks?.[id], outcome = task?.lastOutcome, attempt = attemptOf(task);
        const completion = completions.get(id), hasWorker = [...starts.values()].some((e) => e.task_id === id && leases.get(e.lease_id)?.owner === 'agy');
        const active = allLeases.some((lease) => lease.task_id === id && !lease.released_at);
        const recordedFinalization = currentFinalizations.get(id);
        if (Boolean(task?.finalization) !== Boolean(recordedFinalization) || recordedFinalization
            && ['stage', 'recovery', 'settled'].some((key) => task?.finalization?.[key] !== recordedFinalization[key])) {
            evidence('FINALIZATION_SNAPSHOT_MISMATCH', recordedFinalization || { task_id: id });
        }
        const unsettled = task?.finalization?.settled === false || [...finalizations.values()].some((f) => f.first.task_id === id && !f.settled);
        const claimed = claims.get(id)?.status === 'claimed';
        const gate = approvals.get(`integrate-${id}`);
        const gated = gate && gate.status !== 'approved';
        const recordedOutcome = outcomes.get(id);
        const outcomeMatches = (!outcome && !recordedOutcome) || sameOutcome(outcome, recordedOutcome);
        if (!outcomeMatches) evidence('OUTCOME_SNAPSHOT_MISMATCH', recordedOutcome || { task_id: id });
        let effective = task?.state || 'MISSING', terminal = ['TASK_VERIFIED', 'BLOCKED'].includes(effective);
        if (gated) {
            effective = gate.status === 'pending' ? 'AWAITING_HUMAN_APPROVAL' : 'INTEGRATION_REJECTED';
            terminal = false;
        }
        if (!terminal && !active && !unsettled && !claimed && !gated && outcomeMatches && outcome?.attempt === attempt) {
            effective = outcome.status; terminal = ['FAILED', 'CONFLICT'].includes(effective);
        }
        if (!terminal) evidence('TASK_NOT_TERMINAL', gated ? gate : { task_id: id, sequence: outcomes.get(id)?.sequence || null },
            { authority_state: task?.state || 'MISSING', effective_state: effective, ...(gated ? { gate_id: gate.gate_id } : {}) });
        if (claimed) evidence('UNSETTLED_CONTEXT_DISPATCH', claims.get(id).event);
        const hidden = hiddenTests[id]?.passed === true && hiddenTests[id]?.exitCode === 0;
        const verified = task?.state === 'TASK_VERIFIED' && completion?.authority_state === 'TASK_VERIFIED';
        const integrated = observedIntegrationTasks.has(id);
        if (task?.state === 'TASK_VERIFIED' && (!completion || !integrated || !hasWorker)) evidence('MISSING_TASK_EVIDENCE', completion || { task_id: id });
        if (completion && !integrated) add('scope', 'MISSING_INTEGRATION_EVIDENCE', completion);
        const supplemental = !input.supplementalTaskChecks?.[id] || input.supplementalTaskChecks[id].passed === true;
        const met = verified && terminal && hidden && supplemental && integrated && hasWorker;
        if (!met) add('requirements', 'REQUIREMENT_NOT_MET', completion || { task_id: id, sequence: outcomes.get(id)?.sequence || null },
            { verified: Boolean(verified), hidden_passed: hidden, supplemental_passed: supplemental });
        return { task_id: id, authority_state: task?.state || 'MISSING', effective_state: effective, terminal,
            attempt, hidden_passed: hidden, supplemental_passed: supplemental, requirements_met: met };
    });
    const met = taskResults.filter((t) => t.requirements_met).length, total = taskContracts.length;
    Object.assign(thresholds.requirements, { total, met, rate: total ? met / total : 0, minimum: 0.9 });
    thresholds.requirements.passed = total > 0 && met / total >= 0.9;
    for (const name of ['scope', 'unknown', 'duplicates', 'gates']) thresholds[name].passed = thresholds[name].violations.length === 0;
    const completeSuite = suiteTaskIds.length === 10 && sameSet(taskContracts.map((t) => t.task_id), suiteTaskIds);
    const thresholdsPassed = Object.values(thresholds).every((t) => t.passed);
    return { passed: completeSuite && thresholdsPassed, thresholdsPassed, completeSuite, taskResults, thresholds };
}

module.exports = { measureAcceptance };
