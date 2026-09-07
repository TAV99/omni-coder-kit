'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { orderedTasks } = require('./task-scheduler');
const { exactExternalOperation } = require('./external-operations');

const {
    SessionEventSchema,
    Sha256Schema,
    parseContract,
} = require('./contracts');

class DualAuthorityError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualAuthorityError';
        this.code = code;
        this.details = details;
    }
}

const EnvelopeSchema = z.object({
    previous_hash: Sha256Schema,
    event_hash: Sha256Schema,
    event: SessionEventSchema,
}).strict();

function canonicalizeEvent(value) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map((item) => (item === undefined ? 'null' : canonicalizeEvent(item))).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const key of keys) {
        const val = value[key];
        if (val !== undefined) {
            entries.push(`${JSON.stringify(key)}:${canonicalizeEvent(val)}`);
        }
    }
    return '{' + entries.join(',') + '}';
}

function computeEventHash(previousHash, event, cryptoImpl = crypto) {
    const canonicalPayload = canonicalizeEvent(event);
    return cryptoImpl.createHash('sha256').update(`${previousHash}${canonicalPayload}`).digest('hex');
}

function computeLeaseStatus(lease, nowMs) {
    if (lease.released_at || lease.releasedAt) {
        return 'released';
    }
    const expiresAt = lease.expires_at || lease.expiresAt;
    const expiresAtMs = new Date(expiresAt).getTime();
    if (nowMs >= expiresAtMs) {
        return 'expired';
    }
    return 'active';
}

function readRawRecords(eventsPath, fsImpl) {
    if (!fsImpl.existsSync(eventsPath)) {
        return [];
    }
    const content = fsImpl.readFileSync(eventsPath, 'utf8');
    if (content.length === 0) {
        return [];
    }
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline === -1) {
        // Trailing incomplete line without newline is safely uncommitted
        return [];
    }
    const completeContent = content.slice(0, lastNewline);
    const lines = completeContent.split('\n');
    const records = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.endsWith('\r')) {
            line = line.slice(0, -1);
        }
        if (line.length === 0) {
            throw new DualAuthorityError(
                'DUAL_INTEGRITY_CORRUPT',
                `Committed blank NDJSON line at line ${i + 1}`
            );
        }
        try {
            records.push(JSON.parse(line));
        } catch (err) {
            throw new DualAuthorityError(
                'DUAL_INTEGRITY_CORRUPT',
                `Malformed JSON in complete record at line ${i + 1}: ${err.message}`
            );
        }
    }
    return records;
}

function replayAuthorityEvents(records, options = {}) {
    const cryptoImpl = options.cryptoImpl || crypto;
    const clock = options.clock || (() => new Date());

    const seenEventIds = new Set();
    let expectedPrevHash = '0'.repeat(64);
    let workspaceId = null;
    let sessionId = null;
    let workspaceRoot = null;
    let mode = null;
    let sessionState = null;
    let planRevision = 1;
    let currentBaseline = null;
    let capability = null;
    let plan = null;
    const tasks = {};
    const leases = {};
    const gates = {};
    let blocked = null;
    let receipt = null;
    let lastSequence = 0;
    let lastHash = null;
    let lastEventId = null;

    for (let index = 0; index < records.length; index++) {
        const rawEnvelope = records[index];
        if (!rawEnvelope || typeof rawEnvelope !== 'object' || Array.isArray(rawEnvelope)) {
            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', `Record ${index + 1} is not a valid envelope object`);
        }

        let envelope;
        try {
            envelope = parseContract(EnvelopeSchema, rawEnvelope, 'authority envelope');
        } catch (err) {
            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', `Record ${index + 1} failed envelope validation: ${err.message}`);
        }

        const event = envelope.event;
        const expectedSequence = index + 1;
        if (event.sequence !== expectedSequence) {
            throw new DualAuthorityError(
                'DUAL_INTEGRITY_CORRUPT',
                `Sequence gap at record ${index + 1}: expected ${expectedSequence}, got ${event.sequence}`
            );
        }

        if (envelope.previous_hash !== expectedPrevHash) {
            throw new DualAuthorityError(
                'DUAL_INTEGRITY_CORRUPT',
                `Hash chain broken at sequence ${event.sequence}: expected previous_hash ${expectedPrevHash}, got ${envelope.previous_hash}`
            );
        }

        const computedHash = computeEventHash(envelope.previous_hash, event, cryptoImpl);
        if (envelope.event_hash !== computedHash) {
            throw new DualAuthorityError(
                'DUAL_INTEGRITY_CORRUPT',
                `Event hash mismatch at sequence ${event.sequence}: computed ${computedHash}, got ${envelope.event_hash}`
            );
        }

        if (seenEventIds.has(event.event_id)) {
            throw new DualAuthorityError(
                'DUAL_INTEGRITY_CORRUPT',
                `Duplicate event_id at sequence ${event.sequence}: ${event.event_id}`
            );
        }

        if (index === 0) {
            if (event.type !== 'session.created') {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `First event must be session.created, got ${event.type}`
                );
            }
            if (event.state !== 'DISCOVERED') {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `First event state must be DISCOVERED, got ${event.state}`
                );
            }
            workspaceId = event.workspace_id;
            sessionId = event.session_id;
            workspaceRoot = event.workspace_root;
            mode = event.mode;
            sessionState = 'DISCOVERED';
            planRevision = event.plan_revision;
            currentBaseline = event.expected_baseline;
        } else {
            if (event.type === 'session.created') {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    'session.created may only occur at sequence 1'
                );
            }

            if (event.workspace_id !== workspaceId) {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `Workspace correlation mismatch at sequence ${event.sequence}: expected ${workspaceId}, got ${event.workspace_id}`
                );
            }
            if (event.session_id !== sessionId) {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `Session correlation mismatch at sequence ${event.sequence}: expected ${sessionId}, got ${event.session_id}`
                );
            }

            // CRITICAL causation check: strictly check against prior seen event IDs
            if (!seenEventIds.has(event.causation_id)) {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `Causation ID references unknown event at sequence ${event.sequence}: ${event.causation_id}`
                );
            }

            if (event.plan_revision < planRevision) {
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `Decreasing plan revision at sequence ${event.sequence}: was ${planRevision}, got ${event.plan_revision}`
                );
            }
            planRevision = event.plan_revision;

            if (event.type === 'baseline.promoted') {
                if (
                    event.expected_baseline.kind !== currentBaseline.kind ||
                    event.expected_baseline.id !== currentBaseline.id ||
                    event.from_baseline.kind !== currentBaseline.kind ||
                    event.from_baseline.id !== currentBaseline.id
                ) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `baseline.promoted baseline mismatch at sequence ${event.sequence}`
                    );
                }
                currentBaseline = event.to_baseline;
            } else {
                if (
                    event.expected_baseline.kind !== currentBaseline.kind ||
                    event.expected_baseline.id !== currentBaseline.id
                ) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Baseline drift without promotion at sequence ${event.sequence}`
                    );
                }
            }
        }

        // Event ID is recorded into seen set strictly after causation check
        seenEventIds.add(event.event_id);

        switch (event.type) {
            case 'session.created':
                break;
            case 'capability.result':
                if (sessionState !== 'DISCOVERED') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `capability.result only allowed from DISCOVERED, got ${sessionState} at sequence ${event.sequence}`
                    );
                }
                capability = {
                    status: event.status,
                    fromState: event.from_state,
                    from_state: event.from_state,
                    toState: event.to_state,
                    to_state: event.to_state,
                    checks: event.checks,
                    details: event.details || {},
                };
                sessionState = event.to_state;
                break;
            case 'plan.registered': {
                // Capability->plan registry has an implicit interview step;
                // accept plan.registered only after current CAPABILITY_SAFE,
                // then honor its literal INTERVIEWING -> PLANNED payload.
                if (sessionState !== 'CAPABILITY_SAFE') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `plan.registered only allowed from CAPABILITY_SAFE, got ${sessionState} at sequence ${event.sequence}`
                    );
                }
                const registeredTaskIds = new Set();
                try { orderedTasks(event.tasks); }
                catch { throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Registered task graph has invalid dependencies'); }
                for (const t of event.tasks) {
                    if (registeredTaskIds.has(t.task_id)) {
                        throw new DualAuthorityError(
                            'DUAL_INTEGRITY_CORRUPT',
                            `Duplicate task_id in plan.registered at sequence ${event.sequence}: ${t.task_id}`
                        );
                    }
                    registeredTaskIds.add(t.task_id);
                }
                sessionState = event.to_state;
                plan = {
                    planPath: event.plan_path,
                    plan_path: event.plan_path,
                    planSha256: event.plan_sha256,
                    plan_sha256: event.plan_sha256,
                    totalTasks: event.total_tasks,
                    total_tasks: event.total_tasks,
                };
                for (const t of event.tasks) {
                    tasks[t.task_id] = {
                        // Keep the validated execution contract across replay/restart.
                        // Derived routing/state fields below remain controller-owned.
                        ...t,
                        taskId: t.task_id,
                        task_id: t.task_id,
                        title: t.title,
                        owner: t.owner,
                        allowedFiles: t.allowed_files,
                        allowed_files: t.allowed_files,
                        state: 'REGISTERED',
                        planRevision: event.plan_revision,
                    };
                }
                break;
            }
            case 'task.routed': {
                if (!tasks[event.task_id]) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `task.routed references unregistered task at sequence ${event.sequence}: ${event.task_id}`
                    );
                }
                tasks[event.task_id].owner = event.owner;
                tasks[event.task_id].state = event.authority_state;
                tasks[event.task_id].allowedFiles = event.allowed_files;
                tasks[event.task_id].allowed_files = event.allowed_files;
                tasks[event.task_id].model = event.model ?? null;
                tasks[event.task_id].effort = event.effort ?? null;
                tasks[event.task_id].tokenBudget = event.token_budget ?? null;
                tasks[event.task_id].reason = event.reason;
                if (sessionState === 'PLANNED') {
                    sessionState = 'EXECUTING';
                }
                break;
            }
            case 'task.external.reserved':
            case 'task.external.observed': {
                const task = tasks[event.task_id];
                const grants = (task?.external_operations || []).map((grant) =>
                    exactExternalOperation(task, grant.tool_name, grant.tool_input));
                if (sessionState !== 'EXECUTING' || !task || !grants.some((grant) => grant?.fingerprint === event.fingerprint)) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'External operation requires current exact task authority');
                }
                task.externalReservations ||= {};
                const previous = task.externalReservations[event.fingerprint];
                if (event.type === 'task.external.reserved') {
                    if (previous) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'External operation already reserved');
                    task.externalReservations[event.fingerprint] = { observed: false };
                } else {
                    if (!previous) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'External operation was not reserved');
                    previous.observed = true;
                }
                break;
            }
            case 'task.execution.release_requested':
            case 'task.execution.started':
            case 'task.process.intent':
            case 'task.process.started':
            case 'task.process.exited':
            case 'task.lease.recovered': {
                const task = tasks[event.task_id], lease = leases[event.lease_id];
                if (!task || !lease || lease.task_id !== event.task_id || lease.released_at) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Process evidence requires its existing unreleased lease');
                }
                const timestamp = new Date(event.timestamp).getTime();
                if (!['task.process.exited', 'task.lease.recovered', 'task.execution.release_requested'].includes(event.type)
                    && (timestamp < new Date(lease.acquired_at).getTime() || timestamp >= new Date(lease.expires_at).getTime())) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Process start requires a live lease');
                }
                task.executions ||= {};
                if (event.type === 'task.execution.started') {
                    if (task.executions[event.lease_id]) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Duplicate execution owner');
                    task.executions[event.lease_id] = { controller_pid: event.controller_pid, processes: {} };
                    break;
                }
                const execution = task.executions[event.lease_id];
                if (!execution) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Missing execution owner');
                if (event.type === 'task.execution.release_requested') {
                    if (execution.release_reason) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Duplicate deferred release request');
                    execution.release_reason = event.reason;
                    break;
                }
                const process = execution.processes[event.process_id];
                if (event.type === 'task.process.intent') {
                    if (process) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Duplicate process intent');
                    execution.processes[event.process_id] = { state: 'pending' };
                } else if (event.type === 'task.process.started') {
                    if (process?.state !== 'pending') throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Process start lacks pending intent');
                    Object.assign(process, { state: 'running', pid: event.pid });
                } else if (event.type === 'task.process.exited') {
                    if (!process || process.state === 'exited') throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Duplicate or missing process exit');
                    Object.assign(process, { state: 'exited', exit_code: event.exit_code });
                } else {
                    if (Object.values(execution.processes).some((child) => child.pid)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Direct PID death is not process-tree recovery evidence');
                    }
                    const required = [execution.controller_pid, ...Object.values(execution.processes).filter((child) => child.state !== 'exited').map((child) => child.pid)];
                    if (required.some((pid) => !pid || !event.confirmed_dead_pids.includes(pid))) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Recovery lacks correlated dead process evidence');
                    }
                    lease.released_at = event.timestamp;
                    lease.releasedAt = event.timestamp;
                    lease.releaseReason = lease.release_reason = 'recovered_dead_execution';
                    execution.recovered = true;
                }
                break;
            }
            case 'task.dependencies.prepared': {
                const task = tasks[event.task_id], lease = leases[event.lease_id];
                const timestamp = new Date(event.timestamp).getTime();
                if (sessionState !== 'EXECUTING' || task?.dependency_mode !== 'npm-ci' || !task.isolatedWorkspace
                    || task.isolatedWorkspace.attempt !== event.attempt || task.isolatedWorkspace.reference.workerDependencies
                    || !lease || lease.task_id !== event.task_id || lease.owner !== 'agy' || lease.released_at
                    || timestamp < new Date(lease.acquired_at).getTime() || timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Dependency receipt requires current prepared worker lease');
                }
                task.isolatedWorkspace.reference.workerDependencies = {
                    mode: 'npm-ci', receiptPath: 'dependency-setup.json', receiptSha256: event.receipt_sha256,
                };
                break;
            }
            case 'task.execution.outcome': {
                const task = tasks[event.task_id], lease = leases[event.lease_id];
                const timestamp = new Date(event.timestamp).getTime();
                if (sessionState !== 'EXECUTING' || !task || task.state === 'TASK_VERIFIED'
                    || (task.isolatedWorkspace?.attempt || task.correction?.attempt || 1) !== event.attempt
                    || !lease || lease.task_id !== event.task_id || lease.released_at
                    || timestamp < new Date(lease.acquired_at).getTime() || timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Execution outcome requires the current task attempt and lease');
                }
                task.lastOutcome = { attempt: event.attempt, status: event.status, code: event.code, summary: event.summary };
                break;
            }
            case 'task.correction.requested': {
                const task = tasks[event.task_id];
                if (sessionState !== 'EXECUTING' || !task || task.execution_mode !== 'isolated' || task.state === 'TASK_VERIFIED'
                    || (task.isolatedWorkspace?.attempt || task.correction?.attempt || 1) !== event.previous_attempt
                    || (task.isolatedWorkspace?.reference.bindingSha256 || null) !== event.previous_binding_sha256
                    || !task.lastOutcome || task.lastOutcome.attempt !== event.previous_attempt
                    || event.attempt !== event.previous_attempt + 1
                    || Object.values(leases).some((lease) => lease.task_id === event.task_id && !lease.released_at)
                    || Object.values(tasks).some((item) => item.correction?.request_id === event.request_id
                        || item.previousAttempts?.some((attempt) => attempt.correction?.request_id === event.request_id))) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Correction requires a failed released attempt and unused sequential request');
                }
                task.previousAttempts = [...(task.previousAttempts || []), { workspace: task.isolatedWorkspace || null,
                    handoff: task.isolatedHandoff || null, outcome: task.lastOutcome,
                    messages: task.messages || [], correction: task.correction || null }];
                task.correction = { request_id: event.request_id, attempt: event.attempt, reason: event.reason,
                    previous_binding_sha256: event.previous_binding_sha256, outcome_code: task.lastOutcome.code };
                delete task.isolatedWorkspace;
                delete task.isolatedHandoff;
                delete task.lastOutcome;
                delete task.messages;
                delete gates[`isolated-qc-${event.task_id}`];
                break;
            }
            case 'task.questions': {
                const task = tasks[event.task_id], lease = leases[event.lease_id];
                const timestamp = new Date(event.timestamp).getTime();
                if (sessionState !== 'EXECUTING' || !task || task.state === 'TASK_VERIFIED'
                    || !lease || lease.task_id !== event.task_id || lease.owner !== 'agy' || lease.released_at
                    || timestamp < new Date(lease.acquired_at).getTime() || timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Question batch requires active worker authority');
                }
                const ids = new Set(Object.values(tasks).flatMap((item) => (item.messages || []).map((message) => message.message_id)));
                if ((task.messages || []).length + event.questions.length > 100) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Task message limit exceeded');
                }
                for (const question of event.questions) {
                    if (ids.has(question.message_id)) throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Duplicate question ID');
                    ids.add(question.message_id);
                }
                task.messages = [...(task.messages || []), ...event.questions.map((question) => ({ ...question,
                    kind: 'question', plan_revision: event.plan_revision }))];
                break;
            }
            case 'task.message': {
                const task = tasks[event.task_id];
                if (sessionState !== 'EXECUTING' || !task || task.state === 'TASK_VERIFIED') {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Messages require an executing unverified task');
                }
                const messages = task.messages || [];
                if (messages.length >= 100 || Object.values(tasks).some((item) => item.messages?.some((message) => message.message_id === event.message_id))) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Duplicate message or task message limit exceeded');
                }
                const timestamp = new Date(event.timestamp).getTime();
                if (event.kind === 'question') {
                    const lease = leases[event.lease_id];
                    if (!lease || lease.task_id !== event.task_id || lease.owner !== 'agy' || lease.released_at || event.reply_to
                        || timestamp < new Date(lease.acquired_at).getTime() || timestamp >= new Date(lease.expires_at).getTime()) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Worker questions require their active lease');
                    }
                } else if (event.lease_id || !messages.some((message) => message.message_id === event.reply_to && message.kind === 'question')
                    || messages.some((message) => message.reply_to === event.reply_to)
                    || Object.values(leases).some((lease) => lease.task_id === event.task_id && !lease.released_at)) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Controller reply requires an unanswered question and a released worker');
                }
                task.messages = [...messages, { message_id: event.message_id, kind: event.kind, body: event.body,
                    ...(event.reply_to ? { reply_to: event.reply_to } : {}), plan_revision: event.plan_revision }];
                break;
            }
            case 'task.workspace.prepared':
            case 'task.workspace.handoff': {
                const task = tasks[event.task_id];
                const lease = leases[event.lease_id];
                const timestamp = new Date(event.timestamp).getTime();
                if (sessionState !== 'EXECUTING' || !task || task.owner !== 'agy' || task.state === 'TASK_VERIFIED'
                    || !lease || lease.task_id !== event.task_id || lease.owner !== 'agy' || lease.released_at
                    || timestamp < new Date(lease.acquired_at).getTime() || timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Isolated task evidence requires a matching active AGY lease');
                }
                if (event.type === 'task.workspace.prepared') {
                    if (task.isolatedWorkspace || task.isolatedHandoff || event.attempt !== (task.correction?.attempt || 1)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Task already has a bound isolated workspace');
                    }
                    task.isolatedWorkspace = { attempt: event.attempt, reference: event.reference };
                } else {
                    if (!task.isolatedWorkspace || task.isolatedWorkspace.attempt !== event.attempt || task.isolatedHandoff) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Isolated handoff must match one prepared attempt');
                    }
                    task.isolatedHandoff = { attempt: event.attempt, handoff_path: event.handoff_path,
                        handoff_sha256: event.handoff_sha256, result_sha256: event.result_sha256 };
                }
                break;
            }
            case 'lease.acquired': {
                if (leases[event.lease_id]) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Duplicate lease_id at sequence ${event.sequence}: ${event.lease_id}`
                    );
                }
                const targetTask = tasks[event.task_id];
                if (!targetTask || targetTask.state === 'REGISTERED') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.acquired references unrouted/unknown task at sequence ${event.sequence}: ${event.task_id}`
                    );
                }
                if (targetTask.owner !== event.owner && event.owner !== 'codex') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.acquired owner mismatch at sequence ${event.sequence}: task owned by ${targetTask.owner}, got ${event.owner}`
                    );
                }
                if (targetTask.state === 'TASK_VERIFIED') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.acquired on already verified task at sequence ${event.sequence}: ${event.task_id}`
                    );
                }
                const acquiredAtMs = new Date(event.acquired_at).getTime();
                const expiresAtMs = new Date(event.expires_at).getTime();
                if (isNaN(acquiredAtMs) || isNaN(expiresAtMs) || expiresAtMs !== acquiredAtMs + event.ttl_ms) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.acquired expiry math mismatch at sequence ${event.sequence}: expires_at must equal acquired_at + ttl_ms`
                    );
                }
                for (const existing of Object.values(leases)) {
                    if (existing.task_id === event.task_id && !existing.released_at) {
                        const existingExpMs = new Date(existing.expires_at).getTime();
                        if (acquiredAtMs < existingExpMs) {
                            throw new DualAuthorityError(
                                'DUAL_INTEGRITY_CORRUPT',
                                `Task ${event.task_id} already has active lease ${existing.lease_id} at sequence ${event.sequence}`
                            );
                        }
                    }
                }
                leases[event.lease_id] = {
                    leaseId: event.lease_id,
                    lease_id: event.lease_id,
                    taskId: event.task_id,
                    task_id: event.task_id,
                    owner: event.owner,
                    acquiredAt: event.acquired_at,
                    acquired_at: event.acquired_at,
                    expiresAt: event.expires_at,
                    expires_at: event.expires_at,
                    ttlMs: event.ttl_ms,
                    ttl_ms: event.ttl_ms,
                    renewedAt: null,
                    renewed_at: null,
                    releasedAt: null,
                    released_at: null,
                    releaseReason: null,
                    release_reason: null,
                };
                break;
            }
            case 'lease.renewed': {
                const existingLease = leases[event.lease_id];
                if (!existingLease) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.renewed references unknown lease at sequence ${event.sequence}: ${event.lease_id}`
                    );
                }
                if (existingLease.task_id !== event.task_id) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.renewed task_id mismatch at sequence ${event.sequence}: expected ${existingLease.task_id}, got ${event.task_id}`
                    );
                }
                if (existingLease.released_at) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.renewed on already released lease at sequence ${event.sequence}: ${event.lease_id}`
                    );
                }
                const renewedAtMs = new Date(event.renewed_at).getTime();
                const priorExpiresAtMs = new Date(existingLease.expires_at).getTime();
                if (isNaN(renewedAtMs) || renewedAtMs >= priorExpiresAtMs) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.renewed timestamp must be before prior expiry at sequence ${event.sequence}`
                    );
                }
                const renewalExpiresAtMs = new Date(event.expires_at).getTime();
                if (isNaN(renewalExpiresAtMs) || renewalExpiresAtMs !== renewedAtMs + event.ttl_ms) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.renewed expiry math mismatch at sequence ${event.sequence}: expires_at must equal renewed_at + ttl_ms`
                    );
                }
                existingLease.renewedAt = event.renewed_at;
                existingLease.renewed_at = event.renewed_at;
                existingLease.expiresAt = event.expires_at;
                existingLease.expires_at = event.expires_at;
                existingLease.ttlMs = event.ttl_ms;
                existingLease.ttl_ms = event.ttl_ms;
                break;
            }
            case 'lease.released': {
                const existingLease = leases[event.lease_id];
                if (!existingLease) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.released references unknown lease at sequence ${event.sequence}: ${event.lease_id}`
                    );
                }
                if (existingLease.task_id !== event.task_id) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.released task_id mismatch at sequence ${event.sequence}: expected ${existingLease.task_id}, got ${event.task_id}`
                    );
                }
                if (existingLease.released_at) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.released on already released lease at sequence ${event.sequence}: ${event.lease_id}`
                    );
                }
                const releasedAtMs = new Date(event.released_at).getTime();
                const priorExpiresAtMs = new Date(existingLease.expires_at).getTime();
                if (isNaN(releasedAtMs) || releasedAtMs >= priorExpiresAtMs) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `lease.released timestamp must be before prior expiry at sequence ${event.sequence}`
                    );
                }
                existingLease.releasedAt = event.released_at;
                existingLease.released_at = event.released_at;
                existingLease.releaseReason = event.reason;
                existingLease.release_reason = event.reason;
                break;
            }
            case 'gate.result':
                gates[event.gate_id] = {
                    gateId: event.gate_id,
                    gate_id: event.gate_id,
                    status: event.status,
                    cycleIndex: event.cycle_index,
                    cycle_index: event.cycle_index,
                    taskId: event.task_id,
                    task_id: event.task_id,
                    details: event.details,
                    evidenceSha256: event.evidence_sha256,
                    evidence_sha256: event.evidence_sha256,
                    reason: event.reason,
                    timestamp: event.timestamp,
                };
                break;
            case 'task.completed': {
                const targetTask = tasks[event.task_id];
                if (!targetTask || targetTask.state === 'REGISTERED') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `task.completed references unrouted/unknown task at sequence ${event.sequence}: ${event.task_id}`
                    );
                }
                if (targetTask.owner !== event.owner) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `task.completed owner mismatch at sequence ${event.sequence}: expected ${targetTask.owner}, got ${event.owner}`
                    );
                }
                if (event.verified_by !== 'codex') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `task.completed must be verified_by codex, got '${event.verified_by}' at sequence ${event.sequence}`
                    );
                }
                if (targetTask.execution_mode === 'isolated' || targetTask.isolatedWorkspace) {
                    const qcGate = gates[`isolated-qc-${event.task_id}`];
                    if (!targetTask.isolatedHandoff || qcGate?.status !== 'PASSED'
                        || qcGate.details?.handoff_sha256 !== targetTask.isolatedHandoff.handoff_sha256
                        || qcGate.details?.result_sha256 !== targetTask.isolatedHandoff.result_sha256
                        || event.diff_fingerprint !== targetTask.isolatedHandoff.result_sha256
                        || !qcGate.details?.integration_receipt
                        || !Array.isArray(qcGate.details.commands) || !qcGate.details.commands.length
                        || qcGate.details.commands.some((command) => command.exit_code !== 0)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Isolated completion requires independent QC and integration evidence');
                    }
                }
                const eventTimestampMs = new Date(event.timestamp).getTime();
                let hasActiveLease = false;
                for (const lease of Object.values(leases)) {
                    if (lease.task_id === event.task_id && (lease.owner === event.owner || lease.owner === event.verified_by)) {
                        const acqMs = new Date(lease.acquired_at).getTime();
                        const expMs = new Date(lease.expires_at).getTime();
                        const relMs = lease.released_at ? new Date(lease.released_at).getTime() : Infinity;
                        if (acqMs <= eventTimestampMs && eventTimestampMs < expMs && eventTimestampMs <= relMs) {
                            hasActiveLease = true;
                            break;
                        }
                    }
                }
                if (!hasActiveLease) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `task.completed requires an active lease at event timestamp at sequence ${event.sequence}`
                    );
                }
                targetTask.owner = event.owner;
                targetTask.state = event.authority_state;
                targetTask.modifiedFiles = event.modified_files;
                targetTask.modified_files = event.modified_files;
                targetTask.diffFingerprint = event.diff_fingerprint;
                targetTask.diff_fingerprint = event.diff_fingerprint;
                targetTask.verdict = event.verdict;
                targetTask.verifiedBy = event.verified_by;
                targetTask.verified_by = event.verified_by;

                // When all registered tasks are TASK_VERIFIED, derive session state ACCEPTANCE
                const registeredKeys = Object.keys(tasks);
                if (
                    registeredKeys.length > 0 &&
                    registeredKeys.every((id) => tasks[id].state === 'TASK_VERIFIED')
                ) {
                    sessionState = 'ACCEPTANCE';
                }
                break;
            }
            case 'session.verified': {
                if (sessionState !== 'ACCEPTANCE') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `session.verified only allowed from ACCEPTANCE state, got ${sessionState} at sequence ${event.sequence}`
                    );
                }
                const allRegistered = Object.keys(tasks);
                const completedSet = new Set(event.completed_tasks);
                if (event.completed_tasks.length !== allRegistered.length || completedSet.size !== allRegistered.length) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `completed_tasks count (${event.completed_tasks.length}) does not match registered tasks count (${allRegistered.length}) at sequence ${event.sequence}`
                    );
                }
                for (const taskId of allRegistered) {
                    if (!completedSet.has(taskId)) {
                        throw new DualAuthorityError(
                            'DUAL_INTEGRITY_CORRUPT',
                            `completed_tasks missing registered task ${taskId} at sequence ${event.sequence}`
                        );
                    }
                    if (tasks[taskId].state !== 'TASK_VERIFIED') {
                        throw new DualAuthorityError(
                            'DUAL_INTEGRITY_CORRUPT',
                            `Task ${taskId} is not TASK_VERIFIED at sequence ${event.sequence}`
                        );
                    }
                }
                sessionState = event.to_state;
                receipt = {
                    receiptSha256: event.receipt_sha256,
                    receipt_sha256: event.receipt_sha256,
                    completedTasks: event.completed_tasks,
                    completed_tasks: event.completed_tasks,
                };
                break;
            }
            case 'session.blocked': {
                if (event.from_state !== sessionState) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `session.blocked from_state mismatch at sequence ${event.sequence}: expected ${sessionState}, got ${event.from_state}`
                    );
                }
                sessionState = event.to_state;
                blocked = {
                    fromState: event.from_state,
                    from_state: event.from_state,
                    toState: event.to_state,
                    to_state: event.to_state,
                    reason: event.reason,
                    blockerCode: event.blocker_code,
                    blocker_code: event.blocker_code,
                };
                break;
            }
            case 'baseline.promoted':
                break;
            default:
                throw new DualAuthorityError(
                    'DUAL_INTEGRITY_CORRUPT',
                    `Unknown event type at sequence ${event.sequence}: ${event.type}`
                );
        }

        expectedPrevHash = envelope.event_hash;
        lastSequence = event.sequence;
        lastHash = envelope.event_hash;
        lastEventId = event.event_id;
    }

    const nowMs = new Date(clock()).getTime();
    const derivedLeases = {};
    for (const [leaseId, lease] of Object.entries(leases)) {
        derivedLeases[leaseId] = {
            ...lease,
            status: computeLeaseStatus(lease, nowMs),
        };
    }

    return {
        sessionId,
        workspaceId,
        workspaceRoot,
        mode,
        sessionState,
        planRevision,
        currentBaseline,
        capability,
        plan,
        tasks,
        leases: derivedLeases,
        gates,
        blocked,
        receipt,
        lastSequence,
        lastHash,
        lastEventId,
    };
}

function createAuthorityStore(sessionDir, options = {}) {
    const fsImpl = options.fsImpl || fs;
    const cryptoImpl = options.cryptoImpl || crypto;
    const clock = options.clock || (() => new Date());
    const uuid = options.uuid || crypto.randomUUID;

    fsImpl.mkdirSync(sessionDir, { recursive: true });
    let canonicalSessionDir;
    try {
        canonicalSessionDir = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(sessionDir)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(sessionDir) : path.resolve(sessionDir));
    } catch {
        canonicalSessionDir = path.resolve(sessionDir);
    }
    const eventsPath = path.join(canonicalSessionDir, 'events.ndjson');

    function readRaw() {
        return readRawRecords(eventsPath, fsImpl);
    }

    function readEvents() {
        const records = readRaw();
        replayAuthorityEvents(records, { cryptoImpl, clock });
        return records.map((r) => r.event);
    }

    function derive() {
        const records = readRaw();
        return replayAuthorityEvents(records, { cryptoImpl, clock });
    }

    function verifyIntegrity() {
        const records = readRaw();
        const derived = replayAuthorityEvents(records, { cryptoImpl, clock });
        return {
            valid: true,
            eventCount: records.length,
            lastSequence: derived.lastSequence,
            lastHash: derived.lastHash,
            lastEventId: derived.lastEventId,
        };
    }

    function append(eventInput) {
        const records = readRaw();
        const derived = replayAuthorityEvents(records, { cryptoImpl, clock });

        let eventPayload = { ...eventInput };
        if (eventPayload.schema_version === undefined) {
            eventPayload.schema_version = 2;
        }
        if (eventPayload.event_id === undefined) {
            eventPayload.event_id = uuid();
        }
        if (eventPayload.timestamp === undefined) {
            eventPayload.timestamp = new Date(clock()).toISOString();
        }
        if (eventPayload.sequence === undefined) {
            eventPayload.sequence = records.length + 1;
        }
        if (eventPayload.workspace_id === undefined && derived.workspaceId) {
            eventPayload.workspace_id = derived.workspaceId;
        }
        if (eventPayload.session_id === undefined && derived.sessionId) {
            eventPayload.session_id = derived.sessionId;
        }
        if (eventPayload.plan_revision === undefined) {
            eventPayload.plan_revision = derived.planRevision || 1;
        }
        if (eventPayload.expected_baseline === undefined && derived.currentBaseline) {
            eventPayload.expected_baseline = derived.currentBaseline;
        }
        if (eventPayload.causation_id === undefined) {
            eventPayload.causation_id = records.length === 0 ? eventPayload.event_id : derived.lastEventId;
        }

        let parsedEvent;
        try {
            parsedEvent = parseContract(SessionEventSchema, eventPayload, 'session event');
        } catch (err) {
            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', `Invalid event contract: ${err.message}`);
        }

        const prevHash = records.length === 0 ? '0'.repeat(64) : derived.lastHash;
        const eventHash = computeEventHash(prevHash, parsedEvent, cryptoImpl);
        const envelope = {
            previous_hash: prevHash,
            event_hash: eventHash,
            event: parsedEvent,
        };

        const nextRecords = [...records, envelope];
        const nextDerived = replayAuthorityEvents(nextRecords, { cryptoImpl, clock });

        const line = JSON.stringify(envelope) + '\n';
        const buf = Buffer.from(line, 'utf8');
        const fd = fsImpl.openSync(eventsPath, 'a');
        try {
            let offset = 0;
            while (offset < buf.length) {
                const written = fsImpl.writeSync(fd, buf, offset, buf.length - offset, null);
                if (typeof written !== 'number' || written <= 0) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'fs.writeSync failed to write bytes');
                }
                offset += written;
            }
            fsImpl.fsyncSync(fd);
        } finally {
            fsImpl.closeSync(fd);
        }

        try {
            const tmpCachePath = path.join(canonicalSessionDir, `state.json.tmp.${uuid()}`);
            fsImpl.writeFileSync(tmpCachePath, JSON.stringify(nextDerived, null, 2), 'utf8');
            fsImpl.renameSync(tmpCachePath, path.join(canonicalSessionDir, 'state.json'));
        } catch {
            // cache is secondary; ignore failure
        }

        return parsedEvent;
    }

    function acquireLease(taskId, owner) {
        const derived = derive();
        if (!derived.sessionId) {
            throw new DualAuthorityError(
                'DUAL_SESSION_NOT_INITIALIZED',
                'Cannot acquire lease before session is initialized with session.created'
            );
        }
        if (owner !== 'codex' && owner !== 'agy') {
            throw new DualAuthorityError(
                'DUAL_LEASE_INVALID',
                `Invalid lease owner: must be 'codex' or 'agy', received: ${owner}`
            );
        }
        if (typeof taskId !== 'string' || !taskId) {
            throw new DualAuthorityError('DUAL_LEASE_INVALID', 'taskId must be a non-empty string');
        }
        const targetTask = derived.tasks[taskId];
        if (!targetTask || targetTask.state === 'REGISTERED') {
            throw new DualAuthorityError(
                'DUAL_LEASE_INVALID',
                `Cannot acquire lease on unrouted/unknown task: ${taskId}`
            );
        }
        if (targetTask.owner !== owner && owner !== 'codex') {
            throw new DualAuthorityError(
                'DUAL_LEASE_INVALID',
                `Task ${taskId} owner mismatch: task is owned by ${targetTask.owner}, not ${owner}`
            );
        }
        if (targetTask.state === 'TASK_VERIFIED') {
            throw new DualAuthorityError(
                'DUAL_LEASE_INVALID',
                `Task ${taskId} is already verified`
            );
        }
        for (const lease of Object.values(derived.leases)) {
            if (lease.task_id === taskId && lease.status === 'active') {
                throw new DualAuthorityError(
                    'DUAL_LEASE_ACTIVE',
                    `Task ${taskId} already has an active unexpired lease (${lease.lease_id}) owned by ${lease.owner}`
                );
            }
        }

        const now = new Date(clock());
        const nowMs = now.getTime();
        const nowIso = now.toISOString();
        const expiresAtIso = new Date(nowMs + 30000).toISOString();
        const leaseId = uuid();

        const leaseEvent = {
            schema_version: 2,
            event_id: uuid(),
            causation_id: derived.lastEventId,
            sequence: derived.lastSequence + 1,
            workspace_id: derived.workspaceId,
            session_id: derived.sessionId,
            plan_revision: derived.planRevision,
            expected_baseline: derived.currentBaseline,
            timestamp: nowIso,
            type: 'lease.acquired',
            lease_id: leaseId,
            task_id: taskId,
            owner: owner,
            acquired_at: nowIso,
            expires_at: expiresAtIso,
            ttl_ms: 30000,
        };

        append(leaseEvent);

        return {
            leaseId,
            lease_id: leaseId,
            taskId,
            task_id: taskId,
            owner,
            acquiredAt: nowIso,
            acquired_at: nowIso,
            expiresAt: expiresAtIso,
            expires_at: expiresAtIso,
            ttlMs: 30000,
            ttl_ms: 30000,
            renewedAt: null,
            renewed_at: null,
            releasedAt: null,
            released_at: null,
            releaseReason: null,
            release_reason: null,
            status: 'active',
        };
    }

    function renewLease(leaseId) {
        const derived = derive();
        const lease = derived.leases[leaseId];
        if (!lease) {
            throw new DualAuthorityError('DUAL_LEASE_NOT_FOUND', `Lease not found: ${leaseId}`);
        }
        if (lease.status === 'released' || lease.released_at) {
            throw new DualAuthorityError('DUAL_LEASE_RELEASED', `Cannot renew released lease: ${leaseId}`);
        }
        if (lease.status === 'expired') {
            throw new DualAuthorityError('DUAL_LEASE_EXPIRED', `Cannot renew expired lease: ${leaseId}`);
        }

        const now = new Date(clock());
        const nowMs = now.getTime();
        const expiresAtMs = new Date(lease.expires_at).getTime();
        if (nowMs >= expiresAtMs) {
            throw new DualAuthorityError('DUAL_LEASE_EXPIRED', `Cannot renew expired lease: ${leaseId}`);
        }

        const nowIso = now.toISOString();
        const newExpiresAtIso = new Date(nowMs + 30000).toISOString();

        const renewEvent = {
            schema_version: 2,
            event_id: uuid(),
            causation_id: derived.lastEventId,
            sequence: derived.lastSequence + 1,
            workspace_id: derived.workspaceId,
            session_id: derived.sessionId,
            plan_revision: derived.planRevision,
            expected_baseline: derived.currentBaseline,
            timestamp: nowIso,
            type: 'lease.renewed',
            lease_id: leaseId,
            task_id: lease.task_id,
            renewed_at: nowIso,
            expires_at: newExpiresAtIso,
            ttl_ms: 30000,
        };

        append(renewEvent);

        return {
            leaseId,
            lease_id: leaseId,
            taskId: lease.task_id,
            task_id: lease.task_id,
            owner: lease.owner,
            acquiredAt: lease.acquired_at,
            acquired_at: lease.acquired_at,
            expiresAt: newExpiresAtIso,
            expires_at: newExpiresAtIso,
            ttlMs: 30000,
            ttl_ms: 30000,
            renewedAt: nowIso,
            renewed_at: nowIso,
            releasedAt: null,
            released_at: null,
            releaseReason: null,
            release_reason: null,
            status: 'active',
        };
    }

    function releaseLease(leaseId, reason = 'completed') {
        const derived = derive();
        const lease = derived.leases[leaseId];
        if (!lease) {
            throw new DualAuthorityError('DUAL_LEASE_NOT_FOUND', `Lease not found: ${leaseId}`);
        }
        if (lease.status === 'released' || lease.released_at) {
            throw new DualAuthorityError('DUAL_LEASE_RELEASED', `Cannot release already released lease: ${leaseId}`);
        }
        if (lease.status === 'expired') {
            throw new DualAuthorityError('DUAL_LEASE_EXPIRED', `Cannot release expired lease: ${leaseId}`);
        }

        const now = new Date(clock());
        const nowMs = now.getTime();
        const expiresAtMs = new Date(lease.expires_at).getTime();
        if (nowMs >= expiresAtMs) {
            throw new DualAuthorityError('DUAL_LEASE_EXPIRED', `Cannot release expired lease: ${leaseId}`);
        }

        const releaseReason = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'released';
        const nowIso = now.toISOString();

        const releaseEvent = {
            schema_version: 2,
            event_id: uuid(),
            causation_id: derived.lastEventId,
            sequence: derived.lastSequence + 1,
            workspace_id: derived.workspaceId,
            session_id: derived.sessionId,
            plan_revision: derived.planRevision,
            expected_baseline: derived.currentBaseline,
            timestamp: nowIso,
            type: 'lease.released',
            lease_id: leaseId,
            task_id: lease.task_id,
            released_at: nowIso,
            reason: releaseReason,
        };

        append(releaseEvent);

        return {
            leaseId,
            lease_id: leaseId,
            taskId: lease.task_id,
            task_id: lease.task_id,
            owner: lease.owner,
            acquiredAt: lease.acquired_at,
            acquired_at: lease.acquired_at,
            expiresAt: lease.expires_at,
            expires_at: lease.expires_at,
            ttlMs: lease.ttl_ms,
            ttl_ms: lease.ttl_ms,
            renewedAt: lease.renewed_at,
            renewed_at: lease.renewed_at,
            releasedAt: nowIso,
            released_at: nowIso,
            releaseReason,
            release_reason: releaseReason,
            status: 'released',
        };
    }

    return {
        append,
        readEvents,
        derive,
        acquireLease,
        renewLease,
        releaseLease,
        verifyIntegrity,
    };
}

module.exports = {
    DualAuthorityError,
    EnvelopeSchema,
    canonicalizeEvent,
    computeEventHash,
    computeLeaseStatus,
    replayAuthorityEvents,
    createAuthorityStore,
};
