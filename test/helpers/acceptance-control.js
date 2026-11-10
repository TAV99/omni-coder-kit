'use strict';

const { taskReadiness } = require('../../lib/dual/task-scheduler');
const { continuationCheckpoint } = require('../../lib/dual/task-continuation');
const { classifyFailure } = require('../../lib/dual/correction-policy');
// Like a real controller ("Immediate Bounded Correction"), the driver asks for a
// correction of a worker-classified failure within the worker budget (attempts 2
// and 3). Harness/unknown failures stay terminal for a person to decide.
const MAX_DRIVER_ATTEMPT = 3;
const { failure, pause } = require('./squad-live');

function taskProjection(derived, id) {
    const task = derived.tasks?.[id], attempt = task?.isolatedWorkspace?.attempt || task?.correction?.attempt || 1;
    const active = Object.values(derived.leases || {}).some(lease => lease.task_id === id && !lease.released_at && lease.status !== 'released');
    const gate = derived.approvals?.[`integrate-${id}`];
    if (gate && gate.status !== 'approved') return { terminal: false, effective_state: gate.status === 'pending' ? 'AWAITING_HUMAN_APPROVAL' : 'INTEGRATION_REJECTED', attempt };
    if (!active && task?.finalization?.settled !== false && task?.contextDispatch?.status !== 'claimed') {
        if (['TASK_VERIFIED', 'BLOCKED'].includes(task?.state)) return { terminal: true, effective_state: task.state, attempt };
        if (task?.lastOutcome?.attempt === attempt && ['FAILED', 'CONFLICT'].includes(task.lastOutcome.status)) {
            return { terminal: true, effective_state: task.lastOutcome.status, attempt };
        }
    }
    return { terminal: false, effective_state: task?.state || 'MISSING', attempt };
}

/** Drive public RPCs only; human approval and source evidence remain caller-owned. */
async function driveAcceptance({ authority, client, sessionId, taskIds, planRevision = 1, deadline, now = Date.now,
    pauseImpl = pause, pollIntervalMs = 500, serviceContext = async () => {}, waitForGates,
    captureSource, collectIntegration, onIntegration = () => {}, beforeCheck = () => {}, onProgress = () => {},
    beforeQc = () => {}, afterQc = () => {} }) {
    const integrations = [], frontiers = [], captured = new Set(), corrections = [];
    const remaining = () => Math.max(1, deadline - now());
    const read = () => {
        const derived = authority.derive();
        if (derived.sessionId !== sessionId || derived.planRevision !== planRevision) throw failure('ACCEPTANCE_AUTHORITY_CHANGED');
        return derived;
    };
    const quiescent = derived => {
        return !Object.values(derived.leases || {}).some(lease => !lease.released_at && lease.status !== 'released')
            && Object.entries(derived.tasks || {}).every(([id, task]) => task.finalization?.settled !== false
                && task.contextDispatch?.status !== 'claimed'
                && !(task.qcReview?.attempt === taskProjection(derived, id).attempt && task.qcReview.status === 'running'));
    };
    function checkDecision(id, expected, attempt, result) {
        if (!['REVIEW_REJECTED', 'REVIEW_BUDGET_EXHAUSTED'].includes(result?.status)) return;
        const derived = read(), task = derived.tasks[id], review = task?.qcReview;
        if (!quiescent(derived) || taskProjection(derived, id).attempt !== attempt
            || !task?.isolatedHandoff || !expected.isolatedHandoff
            || ['attempt', 'handoff_sha256', 'result_sha256'].some(key => task.isolatedHandoff[key] !== expected.isolatedHandoff[key])
            || review?.attempt === attempt && review.status === 'completed' && review.verdict === 'APPROVE'
            || ['attempt', 'status', 'input_sha256', 'verdict', 'verdict_sha256', 'finished_at']
                .some(key => result.qc_review?.[key] !== review?.[key])
            || result.status === 'REVIEW_REJECTED' && task.handoffRejection?.attempt !== attempt) return;
        const error = failure('ACCEPTANCE_NEEDS_DECISION', `${id}: ${result.status}; no automatic correction remains scheduled`);
        error.partial = { integrations, frontiers, taskResults: taskIds.map(id => ({ task_id: id, ...taskProjection(derived, id) })),
            decision: { task_id: id, attempt, status: result.status, qc_review: result.qc_review || null } };
        throw error;
    }
    async function performQc(id) {
        const current = read().tasks[id], attempt = taskProjection(read(), id).attempt;
        const sequenceBefore = read().lastSequence;
        const before = await captureSource({ taskId: id, phase: 'before' });
        let result, error;
        try { result = await client.completeIsolatedTask(sessionId, id, planRevision, { timeoutMs: remaining() }); }
        catch (caught) { error = caught; }
        // Even an RPC error can follow a successful source write. Capture it
        // before propagating the error, using the actual receipt event sequence.
        const after = await captureSource({ taskId: id, phase: 'after' });
        const events = authority.readEvents().filter(e => e.sequence > sequenceBefore && e.task_id === id);
        const anchors = events.filter(e => e.type === 'gate.result' && e.status === 'PASSED' && e.details?.integration_receipt && e.details?.result_sha256);
        if (!anchors.length) {
            const completion = events.find(e => e.type === 'task.completed' && e.diff_fingerprint);
            if (completion) anchors.push(completion);
        }
        const operations = new Map();
        for (const anchor of anchors) {
            const receipt = anchor.details?.integration_receipt || null, digest = anchor.details?.result_sha256 || anchor.diff_fingerprint;
            const key = `${id}:${attempt}:${receipt}:${digest}`;
            if (!captured.has(key) && !operations.has(key)) operations.set(key, { anchor, digest, receipt });
        }
        if (operations.size > 1) throw failure('ACCEPTANCE_AMBIGUOUS_INTEGRATION');
        for (const [key, { anchor, digest, receipt }] of operations) {
            const record = await collectIntegration({ task_id: id, taskId: id, attempt, result_sha256: digest,
                sequence: anchor.sequence, integration_receipt: receipt, before, after });
            delete record.taskId;
            integrations.push(record); captured.add(key); await onIntegration(record);
        }
        if (!operations.size && JSON.stringify([...before]) !== JSON.stringify([...after])) throw failure('ACCEPTANCE_UNANCHORED_INTEGRATION');
        if (error) throw error;
        await onProgress({ taskId: id, attempt, status: result?.status, result_sha256: current?.isolatedHandoff?.result_sha256 });
        checkDecision(id, current, attempt, result);
        return result;
    }
    async function qc(id) {
        await beforeQc(id);
        try { return await performQc(id); }
        finally { await afterQc(id); }
    }
    while (now() < deadline) {
        await beforeCheck();
        let derived = read();
        for (const id of taskIds) if (derived.tasks[id]?.waitingContext) {
            await serviceContext({ taskId: id, task: derived.tasks[id], remainingMs: remaining() });
            await beforeCheck();
        }
        derived = read();
        // A rejected handoff is deliberately outside the integration frontier.
        // Probe its public decision status so NEEDS_FIX cannot become a silent wait.
        for (const id of taskIds) if (derived.tasks[id]?.handoffRejection
            && !taskProjection(derived, id).terminal && quiescent(derived)) {
            await qc(id);
            derived = read();
        }
        if (quiescent(derived) && typeof client.correctTask === 'function') {
            let corrected = false;
            for (const id of taskIds) {
                const projection = taskProjection(derived, id), task = derived.tasks[id];
                if (!projection.terminal || projection.effective_state !== 'FAILED' || projection.attempt >= MAX_DRIVER_ATTEMPT
                    || task?.revision_id || classifyFailure(task).category !== 'worker') continue;
                const request = { task_id: id, plan_revision: planRevision, expected_attempt: projection.attempt,
                    request_id: `acceptance-${id}-${projection.attempt}`,
                    reason: `Bounded correction after ${task.lastOutcome.code}: redo the attempt and return the exact strict JSON contract.` };
                await client.correctTask(sessionId, request, { timeoutMs: remaining() });
                corrections.push({ ...request, at: new Date(now()).toISOString() });
                await onProgress({ taskId: id, attempt: projection.attempt, status: `CORRECTION_REQUESTED:${task.lastOutcome.code}` });
                corrected = true;
            }
            if (corrected) {
                await client.resumeSession({ session_id: sessionId, projection: 'ack' }, { timeoutMs: remaining() });
                await beforeCheck();
                continue;
            }
        }
        const results = taskIds.map(id => ({ task_id: id, ...taskProjection(derived, id) }));
        if (results.every(task => task.terminal)) return { complete: true, taskResults: results, integrations, frontiers, corrections };
        const active = Object.values(derived.leases || {}).some(lease => !lease.released_at && lease.status !== 'released');
        if (!active) {
            const frontier = taskIds.filter(id => !taskProjection(derived, id).terminal && derived.tasks[id]?.isolatedHandoff
                && !derived.tasks[id].handoffRejection && derived.tasks[id].contextDispatch?.status !== 'claimed'
                && continuationCheckpoint(derived, id).status === 'QC'
                && taskReadiness(derived, id).status === 'READY');
            const held = [];
            for (const id of frontier) {
                const result = await qc(id);
                if (result?.status === 'AWAITING_HUMAN_APPROVAL') held.push(`integrate-${id}`);
                else if (result?.status === 'INTEGRATION_REJECTED') throw failure('GATE_REJECTED', `integrate-${id}`);
                if (now() >= deadline) break;
            }
            if (held.length && now() < deadline) {
                const fresh = read();
                const gates = held.map(id => fresh.approvals?.[id]).filter(gate => gate?.status === 'pending');
                if (gates.length) {
                    frontiers.push(gates.map(gate => gate.gate_id));
                    await waitForGates({ gates, gateIds: gates.map(gate => gate.gate_id), remainingMs: remaining() });
                    await beforeCheck();
                }
                // Re-enter QC from fresh authority; a changed digest will open
                // another pending gate and must return to the person.
                continue;
            }
            if (frontier.some(id => read().tasks[id]?.state === 'TASK_VERIFIED')) {
                await beforeCheck();
                await client.resumeSession({ session_id: sessionId, projection: 'ack' }, { timeoutMs: remaining() });
                await beforeCheck();
            }
        }
        await pauseImpl(Math.min(pollIntervalMs, remaining()));
    }
    const error = failure('ACCEPTANCE_INCOMPLETE', 'Run deadline reached with nonterminal tasks');
    error.partial = { integrations, frontiers, corrections, taskResults: taskIds.map(id => ({ task_id: id, ...taskProjection(read(), id) })) };
    throw error;
}

module.exports = { taskProjection, driveAcceptance };
