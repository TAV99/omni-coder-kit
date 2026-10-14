'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { orderedTasks } = require('./task-scheduler');
const { exactExternalOperation } = require('./external-operations');
const {
    hashAcceptancePolicy,
    validateReviewAttestation,
    evaluateAttestedReview,
    reviewAttestationEvidence,
} = require('./acceptance-policy');
const { bindOperationLifecycle } = require('./operation-lifecycle-capability');
const { bindValidatorLifecycle } = require('./validator-lifecycle-capability');

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

function sameQualityExecutionGeneration(execution, generation) {
    return Boolean(execution && generation
        && execution.session_id === generation.session_id
        && execution.workspace_id === generation.workspace_id
        && canonicalizeEvent(execution.expected_baseline) === canonicalizeEvent(generation.expected_baseline)
        && execution.plan_revision === generation.plan_revision
        && execution.policy_sha256 === generation.policy_sha256
        && execution.diff_fingerprint === generation.diff_fingerprint
        && execution.total_tasks === generation.total_tasks);
}

function qualityGateMatchesExecution(event, execution) {
    const match = /^quality-cycle-([1-3])$/.exec(event?.gate_id || '');
    const details = event?.details;
    const provenance = details?.provenance;
    if (!match || !execution || !details || !provenance) return false;
    const cycleIndex = Number(match[1]);
    const commandsPass = Array.isArray(details.commands) && details.commands.length > 0
        && details.commands.every((command) => command?.exit_code === 0);
    return event.type === 'gate.result'
        && event.cycle_index === cycleIndex
        && details.cycle_index === cycleIndex
        && details.required === true
        && details.attempt === execution.attempt
        && details.total_tasks === execution.total_tasks
        && details.plan_revision === execution.plan_revision
        && details.diff_fingerprint === execution.diff_fingerprint
        && details.threshold === Math.ceil(execution.total_tasks * cycleIndex / 3)
        && canonicalizeEvent(details.completed_task_ids) === canonicalizeEvent(execution.completed_task_ids)
        && provenance.mode === 'fresh'
        && provenance.execution_id === execution.execution_id
        && provenance.input_fingerprint === execution.diff_fingerprint
        && event.evidence_sha256 === execution.artifact_sha256
        && execution.cycle_index === cycleIndex
        && (event.status === 'PASSED'
            ? details.verdict === 'PASSED' && Array.isArray(details.blockers)
                && details.blockers.length === 0 && commandsPass
            : event.status === 'FAILED' && details.verdict === 'BLOCKED'
                && Array.isArray(details.blockers) && details.blockers.length > 0);
}

function qualityGateHistoryForGeneration(events, qualityExecutions, generation) {
    return events.filter((event) => {
        if (!/^quality-cycle-[1-3]$/.test(event?.gate_id || '')) return false;
        const executionId = event.details?.provenance?.execution_id;
        const execution = executionId ? qualityExecutions[executionId] : null;
        return qualityGateMatchesExecution(event, execution)
            && sameQualityExecutionGeneration(execution, generation);
    });
}

function computeEventHash(previousHash, event, cryptoImpl = crypto) {
    const canonicalPayload = canonicalizeEvent(event);
    return cryptoImpl.createHash('sha256').update(`${previousHash}${canonicalPayload}`).digest('hex');
}

const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);

// This internal event is parsed only by the authority store. It is a durable
// commitment in the main authority ledger, not a public producer contract.
const OperationLedgerCommitmentEventSchema = z.object({
    schema_version: z.literal(2),
    event_id: z.string().uuid(),
    causation_id: z.string().uuid(),
    sequence: z.number().int().positive(),
    workspace_id: z.string().min(1),
    session_id: z.string().min(1),
    plan_revision: z.number().int().positive(),
    expected_baseline: z.unknown(),
    timestamp: z.string().datetime({ offset: true }),
    type: z.literal('task.operation.ledger.committed'),
    task_id: z.string().min(1),
    lease_id: z.string().uuid(),
    operation_id: z.string().uuid(),
    operation_type: z.enum(['started', 'settled']),
    operation_count: z.number().int().positive(),
    operation_record_hash: Sha256Schema,
    operation_ledger_sha256: Sha256Schema,
}).strict();
const AuthorityEventSchema = z.union([SessionEventSchema, OperationLedgerCommitmentEventSchema]);

const EnvelopeSchema = z.object({
    previous_hash: Sha256Schema,
    event_hash: Sha256Schema,
    event: AuthorityEventSchema,
}).strict();

function operationError(message, details = {}) {
    return new DualAuthorityError('DUAL_OPERATION_CORRUPT', message, details);
}

function validateOperationRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw operationError('Operation record must be an object');
    }
    const required = ['schema_version', 'type', 'operation_id', 'session_id', 'workspace_id', 'plan_revision',
        'task_id', 'lease_id', 'timestamp'];
    const allowed = new Set([...required, 'outcome']);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) throw operationError(`Operation record contains unknown field '${key}'`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) throw operationError(`Operation record missing '${key}'`);
    }
    if (record.schema_version !== 1 || !['started', 'settled'].includes(record.type)
        || typeof record.session_id !== 'string' || !record.session_id
        || typeof record.workspace_id !== 'string' || !record.workspace_id
        || typeof record.task_id !== 'string' || !record.task_id
        || !OPERATION_UUID.test(record.operation_id) || !OPERATION_UUID.test(record.lease_id)
        || !Number.isSafeInteger(record.plan_revision) || record.plan_revision <= 0
        || typeof record.timestamp !== 'string' || Number.isNaN(new Date(record.timestamp).getTime())) {
        throw operationError('Operation record identity or timestamp is invalid');
    }
    if (record.type === 'started' && record.outcome !== undefined) {
        throw operationError('Started operation record cannot carry an outcome');
    }
    if (record.type === 'settled' && !OPERATION_OUTCOMES.has(record.outcome)) {
        throw operationError('Settled operation record must carry a valid outcome');
    }
    return record;
}

function validateOperationEnvelope(envelope, previousHash, cryptoImpl = crypto) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw operationError('Operation ledger envelope must be an object');
    }
    const keys = Object.keys(envelope);
    if (keys.length !== 3 || !keys.includes('previous_hash') || !keys.includes('record_hash') || !keys.includes('record')) {
        throw operationError('Operation ledger envelope has an invalid shape');
    }
    if (!OPERATION_SHA256.test(envelope.previous_hash) || !OPERATION_SHA256.test(envelope.record_hash)
        || envelope.previous_hash !== previousHash) {
        throw operationError('Operation ledger hash chain is invalid');
    }
    const record = validateOperationRecord(envelope.record);
    const computed = computeEventHash(envelope.previous_hash, record, cryptoImpl);
    if (computed !== envelope.record_hash) throw operationError('Operation ledger record hash is invalid');
    return record;
}

function operationLineageKey(record) {
    return [record.session_id, record.task_id, record.lease_id].join('\u0000');
}

function validateOperationSequence(records) {
    const states = new Map();
    const activeLineages = new Map();
    for (const record of records) {
        const prior = states.get(record.operation_id);
        if (record.type === 'started') {
            if (prior) throw operationError(`Operation ${record.operation_id} has duplicate or conflicting start`);
            const lineage = operationLineageKey(record);
            if (activeLineages.has(lineage)) {
                throw operationError(`Operation lineage already has an active operation: ${lineage}`);
            }
            activeLineages.set(lineage, record.operation_id);
            states.set(record.operation_id, { ...record, active: true, settled: false, outcome: null });
            continue;
        }
        if (!prior || prior.settled) throw operationError(`Operation ${record.operation_id} settled without one active start`);
        if (prior.session_id !== record.session_id || prior.workspace_id !== record.workspace_id
            || prior.plan_revision !== record.plan_revision || prior.task_id !== record.task_id
            || prior.lease_id !== record.lease_id) {
            throw operationError(`Operation ${record.operation_id} changed authority lineage`);
        }
        if (new Date(record.timestamp).getTime() < new Date(prior.timestamp).getTime()) {
            throw operationError(`Operation ${record.operation_id} settled before it started`);
        }
        const lineage = operationLineageKey(prior);
        if (activeLineages.get(lineage) !== record.operation_id) {
            throw operationError(`Operation ${record.operation_id} has no active lineage to settle`);
        }
        activeLineages.delete(lineage);
        states.set(record.operation_id, { ...prior, active: false, settled: true, outcome: record.outcome,
            settled_at: record.timestamp });
    }
    return states;
}

function validateOperationAuthorityLineage(records, authority) {
    for (const record of records) {
        if (record.session_id !== authority.sessionId || record.workspace_id !== authority.workspaceId
            || record.plan_revision !== authority.planRevision) {
            throw operationError(`Operation ${record.operation_id} does not match the current authority lineage`);
        }
        const task = authority.tasks?.[record.task_id];
        const lease = authority.leases?.[record.lease_id];
        const execution = task?.executions?.[record.lease_id];
        if (!task || !lease || lease.task_id !== record.task_id || lease.session_id !== record.session_id
            || !execution || execution.session_id !== record.session_id || execution.plan_revision !== record.plan_revision) {
            throw operationError(`Operation ${record.operation_id} does not match current task execution evidence`);
        }
    }
}

function validateOperationLedgerCommitment(operationLedger, commitments, { allowOnePendingRecord = false } = {}) {
    const records = operationLedger?.records || [];
    const recordHashes = operationLedger?.record_hashes || [];
    if (records.length === 0) {
        if (commitments.length > 0) throw operationError('Operation ledger commitment exists without operation records');
        return;
    }
    if (commitments.length === records.length) {
        const latest = commitments.at(-1);
        const record = records.at(-1);
        if (latest.operation_count !== records.length
            || latest.operation_id !== record.operation_id
            || latest.operation_type !== record.type
            || latest.operation_record_hash !== recordHashes.at(-1)
            || latest.operation_ledger_sha256 !== operationLedger.content_sha256) {
            throw operationError('Operation ledger commitment does not match the durable ledger');
        }
        return;
    }
    if (allowOnePendingRecord && commitments.length + 1 === records.length) {
        const latest = commitments.at(-1);
        const committedIndex = commitments.length - 1;
        if (latest && (latest.operation_count !== commitments.length
            || latest.operation_id !== records[committedIndex]?.operation_id
            || latest.operation_type !== records[committedIndex]?.type
            || latest.operation_record_hash !== recordHashes[committedIndex])) {
            throw operationError('Operation ledger commitment prefix does not match the durable ledger');
        }
        return;
    }
    throw operationError('Operation ledger commitment count does not match durable operation records');
}

function readOperationLedgerState(operationsPath, fsImpl, cryptoImpl = crypto) {
    if (!fsImpl.existsSync(operationsPath)) {
        return { exists: false, content: '', content_sha256: null, records: [], record_hashes: [], last_record_hash: null };
    }
    const content = fsImpl.readFileSync(operationsPath, 'utf8');
    const contentSha256 = cryptoImpl.createHash('sha256').update(content).digest('hex');
    if (content.length === 0) {
        return { exists: true, content, content_sha256: contentSha256, records: [], record_hashes: [], last_record_hash: null };
    }
    if (!content.endsWith('\n')) throw operationError('Operation ledger has an incomplete final record');
    const lines = content.slice(0, -1).split('\n');
    const records = [];
    const recordHashes = [];
    let previousHash = '0'.repeat(64);
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index]) throw operationError(`Operation ledger has a blank record at line ${index + 1}`);
        let envelope;
        try { envelope = JSON.parse(lines[index]); }
        catch (error) { throw operationError(`Malformed operation record at line ${index + 1}: ${error.message}`); }
        records.push(validateOperationEnvelope(envelope, previousHash, cryptoImpl));
        recordHashes.push(envelope.record_hash);
        previousHash = envelope.record_hash;
    }
    validateOperationSequence(records);
    return {
        exists: true, content, content_sha256: contentSha256, records, record_hashes: recordHashes,
        last_record_hash: recordHashes.at(-1) || null,
    };
}

function readOperationLedger(operationsPath, fsImpl, cryptoImpl = crypto) {
    return readOperationLedgerState(operationsPath, fsImpl, cryptoImpl).records;
}

const VALIDATOR_OUTCOMES = new Set(['passed', 'failed', 'aborted']);

function validatorError(message, details = {}) {
    return new DualAuthorityError('DUAL_VALIDATOR_CORRUPT', message, details);
}

function validateValidatorRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw validatorError('Validator record must be an object');
    }
    const baseRequired = [
        'schema_version', 'type', 'run_id', 'session_id', 'workspace_id', 'plan_revision',
        'baseline_id', 'baseline_kind', 'source_fingerprint', 'purpose', 'command_policy_digest',
        'timestamp'
    ];
    for (const key of baseRequired) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
            throw validatorError(`Validator record missing '${key}'`);
        }
    }
    if (record.schema_version !== 1 || !['started', 'settled'].includes(record.type)
        || typeof record.session_id !== 'string' || !record.session_id
        || typeof record.workspace_id !== 'string' || !record.workspace_id
        || !OPERATION_UUID.test(record.run_id)
        || !Number.isSafeInteger(record.plan_revision) || record.plan_revision <= 0
        || typeof record.baseline_id !== 'string' || !record.baseline_id
        || typeof record.baseline_kind !== 'string' || !record.baseline_kind
        || !OPERATION_SHA256.test(record.source_fingerprint)
        || !['quality', 'acceptance-correction', 'correction'].includes(record.purpose)
        || !OPERATION_SHA256.test(record.command_policy_digest)
        || typeof record.timestamp !== 'string' || Number.isNaN(new Date(record.timestamp).getTime())) {
        throw validatorError('Validator record identity or timestamp is invalid');
    }
    if (record.type === 'started') {
        const allowedStarted = new Set([...baseRequired, 'cycle', 'attempt', 'correction_id']);
        for (const key of Object.keys(record)) {
            if (!allowedStarted.has(key)) throw validatorError(`Started validator record contains unknown field '${key}'`);
        }
        if (record.outcome !== undefined) {
            throw validatorError('Started validator record cannot carry an outcome');
        }
    } else {
        const settledRequired = [
            ...baseRequired, 'outcome', 'duration_ms', 'stdout_bytes', 'stderr_bytes',
            'stdout_sha256', 'stderr_sha256', 'output_sha256', 'result_anchor_digest',
            'active_owned_processes', 'cleanup_verified'
        ];
        for (const key of settledRequired) {
            if (!Object.prototype.hasOwnProperty.call(record, key)) {
                throw validatorError(`Settled validator record missing '${key}'`);
            }
        }
        const allowedSettled = new Set([
            ...settledRequired, 'cycle', 'attempt', 'correction_id', 'exit_code', 'signal', 'failure'
        ]);
        for (const key of Object.keys(record)) {
            if (!allowedSettled.has(key)) throw validatorError(`Settled validator record contains unknown field '${key}'`);
        }
        if (!VALIDATOR_OUTCOMES.has(record.outcome)) {
            throw validatorError('Settled validator record must carry a valid outcome');
        }
        if (record.cleanup_verified !== true || record.active_owned_processes !== 0) {
            throw validatorError('Settled validator record has unproven process cleanup');
        }
        if (!OPERATION_SHA256.test(record.result_anchor_digest)) {
            throw validatorError('Settled validator record has invalid result_anchor_digest');
        }
    }
    return record;
}

function validateValidatorEnvelope(envelope, previousHash, cryptoImpl = crypto) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw validatorError('Validator ledger envelope must be an object');
    }
    const keys = Object.keys(envelope);
    if (keys.length !== 3 || !keys.includes('previous_hash') || !keys.includes('record_hash') || !keys.includes('record')) {
        throw validatorError('Validator ledger envelope has an invalid shape');
    }
    if (!OPERATION_SHA256.test(envelope.previous_hash) || !OPERATION_SHA256.test(envelope.record_hash)
        || envelope.previous_hash !== previousHash) {
        throw validatorError('Validator ledger hash chain is invalid');
    }
    const record = validateValidatorRecord(envelope.record);
    const computed = computeEventHash(envelope.previous_hash, record, cryptoImpl);
    if (computed !== envelope.record_hash) throw validatorError('Validator ledger record hash is invalid');
    return record;
}

function validateValidatorSequence(records) {
    const states = new Map();
    let activeRunId = null;
    for (const record of records) {
        const prior = states.get(record.run_id);
        if (record.type === 'started') {
            if (prior) throw validatorError(`Validator ${record.run_id} has duplicate or conflicting start`);
            if (activeRunId !== null) {
                throw validatorError(`Session already has an active validator run: ${activeRunId}`);
            }
            activeRunId = record.run_id;
            states.set(record.run_id, { ...record, active: true, settled: false, outcome: null });
            continue;
        }
        if (!prior || prior.settled) {
            throw validatorError(`Validator ${record.run_id} settled without active start`);
        }
        if (prior.session_id !== record.session_id || prior.workspace_id !== record.workspace_id
            || prior.plan_revision !== record.plan_revision || prior.purpose !== record.purpose) {
            throw validatorError(`Validator ${record.run_id} changed authority lineage`);
        }
        if (new Date(record.timestamp).getTime() < new Date(prior.timestamp).getTime()) {
            throw validatorError(`Validator ${record.run_id} settled before it started`);
        }
        activeRunId = null;
        states.set(record.run_id, {
            ...prior,
            active: false,
            settled: true,
            outcome: record.outcome,
            settled_at: record.timestamp,
            exit_code: record.exit_code,
            failure: record.failure,
        });
    }
    return states;
}

function readValidatorLedgerState(validatorsPath, fsImpl, cryptoImpl = crypto) {
    if (!fsImpl.existsSync(validatorsPath)) {
        return { exists: false, content: '', content_sha256: null, records: [], record_hashes: [], last_record_hash: null };
    }
    const content = fsImpl.readFileSync(validatorsPath, 'utf8');
    const contentSha256 = cryptoImpl.createHash('sha256').update(content).digest('hex');
    if (content.length === 0) {
        return { exists: true, content, content_sha256: contentSha256, records: [], record_hashes: [], last_record_hash: null };
    }
    if (!content.endsWith('\n')) throw validatorError('Validator ledger has an incomplete final record');
    const lines = content.slice(0, -1).split('\n');
    const records = [];
    const recordHashes = [];
    let previousHash = '0'.repeat(64);
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index]) throw validatorError(`Validator ledger has a blank record at line ${index + 1}`);
        let envelope;
        try { envelope = JSON.parse(lines[index]); }
        catch (error) { throw validatorError(`Malformed validator record at line ${index + 1}: ${error.message}`); }
        records.push(validateValidatorEnvelope(envelope, previousHash, cryptoImpl));
        recordHashes.push(envelope.record_hash);
        previousHash = envelope.record_hash;
    }
    validateValidatorSequence(records);
    return {
        exists: true, content, content_sha256: contentSha256, records, record_hashes: recordHashes,
        last_record_hash: recordHashes.at(-1) || null,
    };
}

function readValidatorLedger(validatorsPath, fsImpl, cryptoImpl = crypto) {
    return readValidatorLedgerState(validatorsPath, fsImpl, cryptoImpl).records;
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

function finalizationSettlement(execution, operationStates = new Map(), taskId, leaseId) {
    if ([...operationStates.values()].some((operation) => operation.active
        && operation.task_id === taskId && operation.lease_id === leaseId)) {
        return { recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false };
    }
    if (!execution) return { recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false };
    const children = Object.values(execution.processes || {});
    // An empty process set is not proof that the controller's child work settled.
    if (!children.length) return { recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false };
    if (children.some((child) => child.state === 'pending')) {
        return { recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false };
    }
    if (children.some((child) => child.state !== 'exited')) {
        return { recovery: 'NEEDS_PROCESS_TREE_EVIDENCE', settled: false };
    }
    if (children.some((child) => !Number.isSafeInteger(child.pid) || child.pid <= 0
        || !Number.isInteger(child.exit_code))) {
        return { recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false };
    }
    return { recovery: 'NONE', settled: true };
}

function finalizationSummary(stage, code, recovery) {
    return `Finalization failed at ${stage}; code=${code}; recovery=${recovery}.`;
}

function currentTaskAttempt(task) {
    return task?.isolatedWorkspace?.attempt || task?.correction?.attempt || 1;
}

function hasNewerLease(leases, taskId, leaseId, lease) {
    const acquiredSequence = lease?.acquired_sequence || 0;
    return Object.values(leases).some((candidate) => candidate.task_id === taskId
        && candidate.lease_id !== leaseId
        && (candidate.acquired_sequence > acquiredSequence
            || (!candidate.acquired_sequence && new Date(candidate.acquired_at).getTime() > new Date(lease.acquired_at).getTime()))
        );
}

function hasNewerExecution(task, leases, leaseId, lease) {
    const execution = task?.executions?.[leaseId];
    const startedSequence = execution?.started_sequence || 0;
    const acquiredSequence = lease?.acquired_sequence || 0;
    return Object.entries(task?.executions || {}).some(([candidateLeaseId, candidate]) => {
        if (candidateLeaseId === leaseId) return false;
        const candidateLease = leases[candidateLeaseId];
        return candidate.started_sequence > startedSequence
            || (!candidate.started_sequence && candidateLease?.acquired_sequence > acquiredSequence);
    });
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
    const operationRecords = options.operationRecords || [];
    const operationLedger = options.operationLedger || { records: operationRecords, record_hashes: [], content_sha256: null };
    const allowOnePendingOperationRecord = options.allowOnePendingOperationRecord === true;
    const operationStates = validateOperationSequence(operationRecords);
    const currentProcessId = options.processPid === undefined ? process.pid : options.processPid;

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
    const qualityGateHistory = [];
    const reviewExecutions = {};
    const reviewAttestations = {};
    const qualityExecutions = {};
    let blocked = null;
    let receipt = null;
    let activeAcceptanceCorrection = null;
    const acceptanceCorrections = [];
    let legacyAcceptanceCorrection = false;
    const operationCommitments = [];
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
            case 'review.execution.prepared': {
                const execution = event.execution;
                if (execution.session_id !== sessionId || execution.plan_revision !== planRevision
                    || !tasks[execution.task_id]) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Review execution binding mismatch at sequence ${event.sequence}`
                    );
                }
                const policySha = plan?.acceptancePolicySha256 || plan?.acceptance_policy_sha256;
                if (!policySha || execution.policy_sha256 !== policySha) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Review execution policy mismatch at sequence ${event.sequence}`
                    );
                }
                if (reviewExecutions[execution.review_execution_id]) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Duplicate review execution at sequence ${event.sequence}`
                    );
                }
                reviewExecutions[execution.review_execution_id] = execution;
                break;
            }
            case 'review.attested': {
                let attestation;
                try {
                    attestation = validateReviewAttestation(event.attestation);
                } catch (error) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Invalid review attestation at sequence ${event.sequence}: ${error.code || 'invalid'}`
                    );
                }
                const execution = reviewExecutions[attestation.review_execution_id];
                const bindingKeys = [
                    'schema_version', 'review_execution_id', 'session_id', 'task_id', 'plan_revision',
                    'policy_sha256', 'result_sha256', 'diff_fingerprint', 'review_phase',
                    'reviewer_role', 'provenance_mode',
                ];
                if (!execution || bindingKeys.some((key) => execution[key] !== attestation[key])) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Review attestation execution mismatch at sequence ${event.sequence}`
                    );
                }
                if (reviewAttestations[attestation.review_execution_id]) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Duplicate review attestation at sequence ${event.sequence}`
                    );
                }
                reviewAttestations[attestation.review_execution_id] = attestation;
                if (attestation.review_phase === 'post_integration') {
                    const policy = plan?.acceptancePolicy || plan?.acceptance_policy;
                    if (!policy) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                            `Post-integration review requires a registered policy at sequence ${event.sequence}`);
                    }
                    let evaluated;
                    try {
                        evaluated = evaluateAttestedReview(policy, reviewAttestationEvidence(attestation), {
                            reviewPhase: 'post_integration',
                            taskId: attestation.task_id,
                            resultSha256: attestation.result_sha256,
                        });
                    } catch (error) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                            `Post-integration review findings are invalid at sequence ${event.sequence}: ${error.code || 'invalid'}`);
                    }
                    if (evaluated.status === 'NEEDS_REVIEW') {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                            `Post-integration review is incomplete at sequence ${event.sequence}`);
                    }
                    const sessionReviewChecks = new Map((policy?.checks || [])
                        .filter((check) => check.phase === 'session' && check.kind === 'review')
                        .map((check) => [check.id, check]));
                    for (const checkResult of attestation.check_results) {
                        const check = sessionReviewChecks.get(checkResult.check_id);
                        if (!check) continue;
                        const status = checkResult.status === 'PASS' ? 'PASSED'
                            : (checkResult.status === 'FAIL' ? 'FAILED' : checkResult.status);
                        gates[`acceptance-${checkResult.check_id}`] = {
                            gateId: `acceptance-${checkResult.check_id}`,
                            gate_id: `acceptance-${checkResult.check_id}`,
                            status,
                            taskId: attestation.task_id,
                            task_id: attestation.task_id,
                            evidenceSha256: attestation.evidence_sha256,
                            evidence_sha256: attestation.evidence_sha256,
                            reason: checkResult.findings?.join('; ').slice(0, 256)
                                || `Post-integration acceptance review ${checkResult.status.toLowerCase()}`,
                            details: {
                                required: check.required,
                                check_id: checkResult.check_id,
                                policy_sha256: attestation.policy_sha256,
                                result_sha256: attestation.result_sha256,
                                task_result_sha256: tasks[attestation.task_id]?.diff_fingerprint
                                    || tasks[attestation.task_id]?.diffFingerprint,
                                review_phase: 'post_integration',
                                review_execution_id: attestation.review_execution_id,
                                review_attestation_sha256: attestation.attestation_sha256,
                                review_sequence: event.sequence,
                            },
                            timestamp: event.timestamp,
                        };
                    }
                }
                break;
            }
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
                    ...(event.acceptance_policy ? {
                        acceptancePolicy: event.acceptance_policy,
                        acceptance_policy: event.acceptance_policy,
                    } : {}),
                    ...(event.acceptance_policy_sha256 ? {
                        acceptancePolicySha256: event.acceptance_policy_sha256,
                        acceptance_policy_sha256: event.acceptance_policy_sha256,
                    } : {}),
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
                        routePlanRevision: event.plan_revision,
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
                tasks[event.task_id].routePlanRevision = event.plan_revision;
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
            case 'task.operation.ledger.committed': {
                operationCommitments.push(event);
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
                    const executionAttempt = currentTaskAttempt(task);
                    if ((lease.owner === 'agy' && task.owner !== 'agy') || event.plan_revision !== lease.plan_revision
                        || event.plan_revision !== task.routePlanRevision) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Execution owner is not pinned to the current task route');
                    }
                    task.executions[event.lease_id] = {
                        controller_pid: event.controller_pid,
                        session_id: event.session_id,
                        plan_revision: event.plan_revision,
                        attempt: executionAttempt,
                        started_sequence: event.sequence,
                        processes: {},
                    };
                    break;
                }
                const execution = task.executions[event.lease_id];
                if (!execution) {
                    if (event.type === 'task.lease.recovered') {
                        if (event.recovery_kind !== undefined && event.recovery_kind !== 'unexecuted') {
                            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Recovery kind requires recorded execution evidence');
                        }
                        if (event.recovery_kind === 'unexecuted'
                            && (timestamp < new Date(lease.expires_at).getTime() || event.confirmed_dead_pids.length !== 0)) {
                            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Unexecuted recovery requires an expired lease and no dead PID evidence');
                        }
                        if (event.recovery_kind === 'unexecuted'
                            && operationRecords.some((record) => record.task_id === event.task_id && record.lease_id === event.lease_id)) {
                            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Unexecuted recovery cannot discard operation evidence');
                        }
                        lease.released_at = event.timestamp;
                        lease.releasedAt = event.timestamp;
                        lease.releaseReason = lease.release_reason = 'recovered_unexecuted_lease';
                        lease.recovery_kind = event.recovery_kind || 'legacy';
                        break;
                    }
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Missing execution owner');
                }
                if (event.type === 'task.lease.recovered' && event.recovery_kind === undefined
                    && [...operationStates.values()].some((operation) => operation.active
                        && operation.task_id === event.task_id && operation.lease_id === event.lease_id)) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Legacy recovery cannot discard an active operation');
                }
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
                    if (event.type === 'task.lease.recovered' && event.recovery_kind === 'operation_settled') {
                        const operation = operationStates.get(event.operation_id);
                        const children = Object.values(execution.processes || {});
                        if (!operation || !operation.settled
                            || operation.session_id !== event.session_id
                            || operation.workspace_id !== event.workspace_id
                            || operation.plan_revision !== event.plan_revision
                            || operation.task_id !== event.task_id
                            || operation.lease_id !== event.lease_id
                            || operation.outcome !== event.operation_outcome
                            || timestamp < new Date(operation.settled_at).getTime()
                            || timestamp < new Date(lease.expires_at).getTime()
                            || children.some((child) => child.state !== 'exited')
                            || event.confirmed_dead_pids.includes(currentProcessId)) {
                            throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Operation-settled recovery lacks matching settled evidence');
                        }
                        lease.released_at = event.timestamp;
                        lease.releasedAt = event.timestamp;
                        lease.releaseReason = lease.release_reason = 'recovered_operation_settled';
                        lease.recovery_kind = event.recovery_kind;
                        lease.operation_id = event.operation_id;
                        lease.operation_outcome = event.operation_outcome;
                        execution.recovered = true;
                        break;
                    }
                    if (event.type === 'task.lease.recovered' && event.recovery_kind === 'unexecuted') {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Unexecuted recovery cannot have execution evidence');
                    }
                    if (event.type === 'task.lease.recovered' && event.recovery_kind === 'owner_dead'
                        && timestamp < new Date(lease.expires_at).getTime()) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Owner-dead recovery requires an expired lease');
                    }
                    if (event.type === 'task.lease.recovered' && event.recovery_kind === 'owner_dead'
                        && event.confirmed_dead_pids.includes(currentProcessId)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Recovery cannot claim the current daemon PID is dead');
                    }
                    if (event.type === 'task.lease.recovered' && event.recovery_kind === 'owner_dead'
                        && operationRecords.some((record) => record.type === 'settled'
                            && record.task_id === event.task_id && record.lease_id === event.lease_id)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Settled operation recovery must use operation_settled evidence');
                    }
                    if (event.type === 'task.lease.recovered' && event.recovery_kind === 'owner_dead'
                        && [...operationStates.values()].some((operation) => operation.active
                            && operation.task_id === event.task_id && operation.lease_id === event.lease_id)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Owner-dead recovery cannot discard an active operation');
                    }
                    const unexited = Object.values(execution.processes).filter((child) => child.state !== 'exited');
                    if (unexited.length > 0 && unexited.some((child) => child.pid)) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Direct PID death is not process-tree recovery evidence');
                    }
                    const required = [execution.controller_pid, ...unexited.map((child) => child.pid)];
                    if (required.some((pid) => !pid || !event.confirmed_dead_pids.includes(pid))) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Recovery lacks correlated dead process evidence');
                    }
                    lease.released_at = event.timestamp;
                    lease.releasedAt = event.timestamp;
                    lease.releaseReason = lease.release_reason = 'recovered_dead_execution';
                    lease.recovery_kind = event.recovery_kind || 'legacy';
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
                    || timestamp < new Date(lease.acquired_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Dependency receipt requires current prepared worker lease');
                }
                if (timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_LEASE_EXPIRED', 'Dependency receipt requires an unexpired worker lease');
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
                    || timestamp < new Date(lease.acquired_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Execution outcome requires the current task attempt and lease');
                }
                if (timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_LEASE_EXPIRED', 'Execution outcome requires an unexpired lease');
                }
                task.lastOutcome = { attempt: event.attempt, status: event.status, code: event.code, summary: event.summary };
                break;
            }
            case 'task.execution.finalization_failed': {
                const task = tasks[event.task_id], lease = leases[event.lease_id];
                const timestamp = new Date(event.timestamp).getTime();
                const attempt = currentTaskAttempt(task);
                const execution = task?.executions?.[event.lease_id];
                const priorFailure = task?.lastOutcome;
                const priorFinalization = task?.finalization;
                const matchingPriorFailure = priorFailure?.attempt === event.attempt
                    && priorFailure.status === 'FAILED' && priorFailure.code === event.code;
                const settlement = finalizationSettlement(execution, operationStates, event.task_id, event.lease_id);
                if (sessionState !== 'EXECUTING' || !task || task.state === 'TASK_VERIFIED'
                    || task.owner !== 'agy' || task.execution_mode !== 'isolated' || task.isolatedHandoff
                    || (task.lastOutcome && !matchingPriorFailure) || attempt !== event.attempt
                    || priorFinalization && (priorFinalization.stage !== event.stage || priorFinalization.settled
                        || !event.settled || !settlement.settled)
                    || !lease || lease.task_id !== event.task_id || lease.owner !== 'agy' || lease.released_at
                    || timestamp < new Date(lease.acquired_at).getTime()
                    || timestamp < new Date(lease.expires_at).getTime()
                    || !execution || execution.controller_pid !== event.controller_pid
                    || event.controller_pid <= 0
                    || execution.session_id !== event.session_id || lease.session_id !== event.session_id
                    || execution.plan_revision !== event.plan_revision || lease.plan_revision !== event.plan_revision
                    || task.routePlanRevision !== event.plan_revision
                    || execution.attempt !== event.attempt
                    || hasNewerLease(leases, event.task_id, event.lease_id, lease)
                    || hasNewerExecution(task, leases, event.lease_id, lease)) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Finalization failure requires the current unverified task, matching expired lease, and recorded controller execution');
                }
                if (settlement.recovery !== event.recovery || settlement.settled !== event.settled) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Finalization settlement does not match recorded process close evidence');
                }
                if (event.summary !== finalizationSummary(event.stage, event.code, event.recovery)) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Finalization failure diagnostic is not the bounded deterministic summary');
                }
                task.lastOutcome = { attempt: event.attempt, status: 'FAILED', code: event.code, summary: event.summary };
                task.finalization = { stage: event.stage, recovery: event.recovery, settled: event.settled };
                if (event.settled) {
                    lease.released_at = event.timestamp;
                    lease.releasedAt = event.timestamp;
                    lease.releaseReason = lease.release_reason = 'finalization_failed';
                }
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
                delete task.finalization;
                delete task.messages;
                delete gates[`isolated-qc-${event.task_id}`];
                break;
            }
            case 'task.questions': {
                const task = tasks[event.task_id], lease = leases[event.lease_id];
                const timestamp = new Date(event.timestamp).getTime();
                if (sessionState !== 'EXECUTING' || !task || task.state === 'TASK_VERIFIED'
                    || !lease || lease.task_id !== event.task_id || lease.owner !== 'agy' || lease.released_at
                    || timestamp < new Date(lease.acquired_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Question batch requires active worker authority');
                }
                if (timestamp >= new Date(lease.expires_at).getTime()) {
                    throw new DualAuthorityError('DUAL_LEASE_EXPIRED', 'Question batch requires active worker authority');
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
                        || timestamp < new Date(lease.acquired_at).getTime()) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Worker questions require their active lease');
                    }
                    if (timestamp >= new Date(lease.expires_at).getTime()) {
                        throw new DualAuthorityError('DUAL_LEASE_EXPIRED', 'Worker questions require an unexpired lease');
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
                    || timestamp < new Date(lease.acquired_at).getTime()) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT', 'Isolated task evidence requires a matching active AGY lease');
                }
                const leaseExpiresAtMs = new Date(lease.expires_at).getTime();
                if (timestamp >= leaseExpiresAtMs) {
                    const execution = task?.executions?.[event.lease_id];
                    const settlement = finalizationSettlement(execution);
                    const children = Object.values(execution?.processes || {});
                    const cleanExit = settlement.settled && children.length > 0 && children.every((c) => c.exit_code === 0);
                    const withinGrace = (timestamp - leaseExpiresAtMs) <= 120_000;
                    const isEligibleHandoffGrace = event.type === 'task.workspace.handoff'
                        && cleanExit
                        && withinGrace
                        && !hasNewerLease(leases, event.task_id, event.lease_id, lease);
                    if (!isEligibleHandoffGrace) {
                        throw new DualAuthorityError('DUAL_LEASE_EXPIRED', 'Isolated task evidence requires an unexpired AGY lease');
                    }
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
                    sessionId: event.session_id,
                    session_id: event.session_id,
                    planRevision: event.plan_revision,
                    plan_revision: event.plan_revision,
                    acquiredSequence: event.sequence,
                    acquired_sequence: event.sequence,
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
                if (/^quality-cycle-[1-3]$/.test(event.gate_id || '')) {
                    qualityGateHistory.push(event);
                }
                break;
            case 'quality.generation.invalidated':
                // Quality invalidation is intentionally append-only. It records
                // that a previous fingerprint can no longer authorize the tree;
                // historical gate.result events remain queryable and immutable.
                break;
            case 'quality.execution.attested': {
                const binding = {
                    execution_id: event.execution_id,
                    artifact_sha256: event.artifact_sha256,
                    policy_sha256: event.policy_sha256,
                    diff_fingerprint: event.diff_fingerprint,
                    cycle_index: event.cycle_index,
                    attempt: event.attempt,
                    total_tasks: event.total_tasks,
                    completed_task_ids: [...event.completed_task_ids],
                    session_id: event.session_id,
                    workspace_id: event.workspace_id,
                    plan_revision: event.plan_revision,
                    expected_baseline: event.expected_baseline,
                };
                const prior = qualityExecutions[event.execution_id];
                if (prior) {
                    if (canonicalizeEvent(prior) !== canonicalizeEvent(binding)) {
                        throw new DualAuthorityError(
                            'DUAL_INTEGRITY_CORRUPT',
                            `Conflicting quality execution attestation for ${event.execution_id} at sequence ${event.sequence}`
                        );
                    }
                    break;
                }
                if (!plan || !['EXECUTING', 'ACCEPTANCE'].includes(sessionState)) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                        `Quality execution attestation requires an executing or acceptance session at sequence ${event.sequence}`);
                }
                const acceptancePolicy = plan.acceptancePolicy || plan.acceptance_policy;
                const storedPolicySha = plan.acceptancePolicySha256 || plan.acceptance_policy_sha256;
                let canonicalPolicySha;
                if (acceptancePolicy) {
                    try {
                        canonicalPolicySha = hashAcceptancePolicy(acceptancePolicy);
                    } catch {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                            `Quality execution attestation requires a valid durable acceptance policy at sequence ${event.sequence}`);
                    }
                    if (storedPolicySha && storedPolicySha !== canonicalPolicySha) {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                            `Stored acceptance policy hash does not match the durable policy at sequence ${event.sequence}`);
                    }
                }
                const policySha = canonicalPolicySha || storedPolicySha;
                const taskIds = Object.keys(tasks);
                const allTasksVerified = taskIds.length > 0
                    && taskIds.every((taskId) => tasks[taskId].state === 'TASK_VERIFIED');
                const expectedSessionState = allTasksVerified ? 'ACCEPTANCE' : 'EXECUTING';
                const expectedCompletedIds = taskIds.filter((taskId) => event.completed_task_ids.includes(taskId));
                const uniqueCompletedIds = new Set(event.completed_task_ids);
                const minimumCompleted = Math.ceil(event.total_tasks * event.cycle_index / 3);
                if (!policySha || event.policy_sha256 !== policySha
                    || event.total_tasks !== taskIds.length || event.total_tasks !== plan.totalTasks
                    || event.session_id !== sessionId || event.workspace_id !== workspaceId
                    || event.plan_revision !== planRevision
                    || canonicalizeEvent(event.expected_baseline) !== canonicalizeEvent(currentBaseline)
                    || sessionState !== expectedSessionState
                    || event.completed_task_ids.length !== uniqueCompletedIds.size
                    || event.completed_task_ids.length < minimumCompleted
                    || canonicalizeEvent(event.completed_task_ids) !== canonicalizeEvent(expectedCompletedIds)
                    || event.completed_task_ids.some((taskId) => !tasks[taskId]
                        || tasks[taskId].state !== 'TASK_VERIFIED')) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                        `Quality execution attestation task or policy binding mismatch at sequence ${event.sequence}`);
                }
                const generation = {
                    session_id: event.session_id,
                    workspace_id: event.workspace_id,
                    expected_baseline: event.expected_baseline,
                    plan_revision: event.plan_revision,
                    policy_sha256: event.policy_sha256,
                    diff_fingerprint: event.diff_fingerprint,
                    total_tasks: event.total_tasks,
                };
                const generationGates = qualityGateHistoryForGeneration(qualityGateHistory, qualityExecutions, generation);
                for (let earlierCycle = 1; earlierCycle < event.cycle_index; earlierCycle += 1) {
                    const earlierEvents = generationGates.filter((qualityGate) => qualityGate.cycle_index === earlierCycle);
                    if (earlierEvents.length === 0 || earlierEvents[earlierEvents.length - 1].status !== 'PASSED') {
                        throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                            `Quality cycle ${event.cycle_index} attestation requires cycle ${earlierCycle} PASSED at sequence ${event.sequence}`);
                    }
                }
                const cycleEvents = generationGates.filter((qualityGate) => qualityGate.cycle_index === event.cycle_index);
                if (cycleEvents.some((qualityGate) => qualityGate.status === 'PASSED')) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                        `Quality cycle ${event.cycle_index} is already PASSED in this generation at sequence ${event.sequence}`);
                }
                const expectedAttempt = cycleEvents.length + 1;
                if (event.attempt !== expectedAttempt) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                        `Quality execution attempt mismatch at sequence ${event.sequence}: expected ${expectedAttempt}, got ${event.attempt}`);
                }
                const conflictingAttempt = Object.values(qualityExecutions).find((execution) =>
                    execution.cycle_index === event.cycle_index && execution.attempt === event.attempt
                    && execution.session_id === event.session_id
                    && execution.workspace_id === event.workspace_id
                    && execution.plan_revision === event.plan_revision
                    && canonicalizeEvent(execution.expected_baseline) === canonicalizeEvent(event.expected_baseline)
                    && execution.policy_sha256 === event.policy_sha256
                    && execution.diff_fingerprint === event.diff_fingerprint);
                if (conflictingAttempt) {
                    throw new DualAuthorityError('DUAL_INTEGRITY_CORRUPT',
                        `Quality cycle ${event.cycle_index} attempt ${event.attempt} already has a different durable execution`);
                }
                binding.completed_task_ids = Object.freeze(binding.completed_task_ids);
                qualityExecutions[event.execution_id] = Object.freeze(binding);
                break;
            }
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
                if (activeAcceptanceCorrection) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Cannot verify session while acceptance correction ${activeAcceptanceCorrection.correctionId} is active at sequence ${event.sequence}`
                    );
                }
                for (const taskId of allRegistered) {
                    const taskCorrections = acceptanceCorrections.filter((c) => c.taskId === taskId);
                    if (taskCorrections.length > 0) {
                        const lastCorr = taskCorrections[taskCorrections.length - 1];
                        if (lastCorr.status !== 'PASSED') {
                            throw new DualAuthorityError(
                                'DUAL_INTEGRITY_CORRUPT',
                                `Cannot verify session: task ${taskId} has unpassed acceptance correction (attempt ${lastCorr.attempt}) at sequence ${event.sequence}`
                            );
                        }
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
            case 'acceptance.correction.started': {
                if (sessionState !== 'ACCEPTANCE') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `acceptance.correction.started only allowed from ACCEPTANCE state, got ${sessionState} at sequence ${event.sequence}`
                    );
                }
                if (activeAcceptanceCorrection) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Cannot start acceptance correction: active correction ${activeAcceptanceCorrection.correctionId} is already in progress`
                    );
                }
                const task = tasks[event.task_id];
                if (!task) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Target task ${event.task_id} not found at sequence ${event.sequence}`
                    );
                }
                if (task.state !== 'TASK_VERIFIED') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Target task ${event.task_id} must be in TASK_VERIFIED state for acceptance correction, got ${task.state}`
                    );
                }
                const taskAllowed = (task.allowed_files || task.allowedFiles || []).map((f) => f.replace(/\\/g, '/'));
                for (const file of event.allowed_files) {
                    const norm = file.replace(/\\/g, '/');
                    if (!taskAllowed.includes(norm)) {
                        throw new DualAuthorityError(
                            'DUAL_INTEGRITY_CORRUPT',
                            `Correction allowed file ${file} is not within task ${event.task_id} registered allowed_files`
                        );
                    }
                }
                const priorAttempts = acceptanceCorrections.filter((c) => c.taskId === event.task_id);
                if (event.attempt !== priorAttempts.length + 1) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Invalid correction attempt ${event.attempt}: expected ${priorAttempts.length + 1}`
                    );
                }
                const legacyCorrection = event.failure_sequence === undefined
                    || event.failure_evidence_sha256 === undefined
                    || event.failure_result_sha256 === undefined;
                if (legacyCorrection) {
                    // Historical correction records remain readable for audit,
                    // but never recreate active write authority or consume a
                    // current correction attempt. A legacy start is inert.
                    legacyAcceptanceCorrection = true;
                    acceptanceCorrections.push({
                        correctionId: event.correction_id,
                        correction_id: event.correction_id,
                        taskId: event.task_id,
                        task_id: event.task_id,
                        attempt: event.attempt,
                        allowedFiles: event.allowed_files,
                        allowed_files: event.allowed_files,
                        reason: event.reason,
                        validationCommands: event.validation_commands || [],
                        validation_commands: event.validation_commands || [],
                        expectedSequence: event.expected_sequence,
                        expected_sequence: event.expected_sequence,
                        startFingerprint: event.start_fingerprint,
                        start_fingerprint: event.start_fingerprint,
                        startStateSha256: event.start_state_sha256,
                        start_state_sha256: event.start_state_sha256,
                        startFiles: event.start_files || [],
                        start_files: event.start_files || [],
                        startStateEntries: event.start_state_entries || {},
                        start_state_entries: event.start_state_entries || {},
                        failureCheckId: event.failure_check_id,
                        failure_check_id: event.failure_check_id,
                        legacy: true,
                        status: 'LEGACY_READ_ONLY',
                        startedAt: event.timestamp,
                        started_at: event.timestamp,
                    });
                    break;
                }
                if (event.expected_sequence !== event.sequence - 1) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Correction expected_sequence must bind immediately before start at sequence ${event.sequence}`
                    );
                }
                const acceptancePolicy = plan?.acceptancePolicy || plan?.acceptance_policy;
                const correctionGrant = acceptancePolicy?.correction_grants?.find((grant) =>
                    grant.task_id === event.task_id && grant.failure_check_id === event.failure_check_id);
                if (!correctionGrant
                    || canonicalizeEvent(correctionGrant.allowed_files) !== canonicalizeEvent(event.allowed_files)
                    || canonicalizeEvent(correctionGrant.validation_commands) !== canonicalizeEvent(event.validation_commands)) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Correction start does not match the registered policy grant at sequence ${event.sequence}`
                    );
                }
                const failureEnvelope = records.find((record) => record.event.sequence === event.failure_sequence);
                const failureEvent = failureEnvelope?.event;
                const attestedFailure = failureEvent?.type === 'review.attested'
                    ? failureEvent.attestation?.review_phase === 'post_integration'
                        && failureEvent.attestation.task_id === event.task_id
                        && failureEvent.attestation.result_sha256 === event.failure_result_sha256
                        && failureEvent.attestation.evidence_sha256 === event.failure_evidence_sha256
                        && failureEvent.attestation.check_results.some((result) => result.check_id === event.failure_check_id
                            && result.status === 'FAIL')
                    : false;
                const legacyGateFailure = failureEvent?.type === 'gate.result'
                    && failureEvent.status === 'FAILED'
                    && failureEvent.task_id === event.task_id
                    && failureEvent.details?.check_id === event.failure_check_id
                    && failureEvent.details?.review_phase === 'post_integration'
                    && failureEvent.details?.result_sha256 === event.failure_result_sha256
                    && failureEvent.evidence_sha256 === event.failure_evidence_sha256;
                if (!failureEvent || event.failure_sequence >= event.sequence
                    || (!attestedFailure && !legacyGateFailure)) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Correction start does not reference a durable failed review at sequence ${event.sequence}`
                    );
                }
                const priorFailureUses = acceptanceCorrections.filter((c) => c.failureSequence === event.failure_sequence
                    && c.failureCheckId === event.failure_check_id);
                if (priorFailureUses.length > 0) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Correction failure evidence was already consumed by a prior correction at sequence ${event.sequence}`
                    );
                }
                activeAcceptanceCorrection = {
                    correctionId: event.correction_id,
                    correction_id: event.correction_id,
                    taskId: event.task_id,
                    task_id: event.task_id,
                    attempt: event.attempt,
                    allowedFiles: event.allowed_files,
                    allowed_files: event.allowed_files,
                    reason: event.reason,
                    validationCommands: event.validation_commands || [],
                    validation_commands: event.validation_commands || [],
                    expectedSequence: event.expected_sequence,
                    expected_sequence: event.expected_sequence,
                    startFingerprint: event.start_fingerprint,
                    start_fingerprint: event.start_fingerprint,
                    startStateSha256: event.start_state_sha256,
                    start_state_sha256: event.start_state_sha256,
                    startFiles: event.start_files || [],
                    start_files: event.start_files || [],
                    startStateEntries: event.start_state_entries || {},
                    start_state_entries: event.start_state_entries || {},
                    failureCheckId: event.failure_check_id,
                    failure_check_id: event.failure_check_id,
                    failureSequence: event.failure_sequence,
                    failure_sequence: event.failure_sequence,
                    failureEvidenceSha256: event.failure_evidence_sha256,
                    failure_evidence_sha256: event.failure_evidence_sha256,
                    failureResultSha256: event.failure_result_sha256,
                    failure_result_sha256: event.failure_result_sha256,
                    status: 'CORRECTING',
                    startedAt: event.timestamp,
                };
                break;
            }
            case 'acceptance.correction.completed': {
                if (sessionState !== 'ACCEPTANCE') {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `acceptance.correction.completed only allowed from ACCEPTANCE state, got ${sessionState}`
                    );
                }
                if (!activeAcceptanceCorrection) {
                    const legacy = acceptanceCorrections.find((correction) => correction.legacy
                        && correction.correctionId === event.correction_id
                        && correction.taskId === event.task_id
                        && correction.attempt === event.attempt);
                    if (!legacy) {
                        throw new DualAuthorityError(
                            'DUAL_INTEGRITY_CORRUPT',
                            `No active acceptance correction to complete at sequence ${event.sequence}`
                        );
                    }
                    legacy.status = event.status === 'PASSED' ? 'LEGACY_READ_ONLY' : 'LEGACY_READ_ONLY';
                    legacy.completedAt = event.timestamp;
                    legacy.completed_at = event.timestamp;
                    legacy.diffFingerprint = event.diff_fingerprint;
                    legacy.diff_fingerprint = event.diff_fingerprint;
                    break;
                }
                if (activeAcceptanceCorrection.correctionId !== event.correction_id) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Correction ID mismatch: active is ${activeAcceptanceCorrection.correctionId}, got ${event.correction_id}`
                    );
                }
                if (activeAcceptanceCorrection.taskId !== event.task_id) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Task ID mismatch: active correction is for ${activeAcceptanceCorrection.taskId}, got ${event.task_id}`
                    );
                }
                if (activeAcceptanceCorrection.attempt !== event.attempt) {
                    throw new DualAuthorityError(
                        'DUAL_INTEGRITY_CORRUPT',
                        `Attempt mismatch: active correction is attempt ${activeAcceptanceCorrection.attempt}, got ${event.attempt}`
                    );
                }
                const record = {
                    correctionId: event.correction_id,
                    correction_id: event.correction_id,
                    taskId: event.task_id,
                    task_id: event.task_id,
                    attempt: event.attempt,
                    status: event.status,
                    summary: event.summary,
                    diffFingerprint: event.diff_fingerprint,
                    diff_fingerprint: event.diff_fingerprint,
                    failureCheckId: activeAcceptanceCorrection.failureCheckId,
                    failure_check_id: activeAcceptanceCorrection.failureCheckId,
                    failureSequence: activeAcceptanceCorrection.failureSequence,
                    failure_sequence: activeAcceptanceCorrection.failureSequence,
                    failureEvidenceSha256: activeAcceptanceCorrection.failureEvidenceSha256,
                    failure_evidence_sha256: activeAcceptanceCorrection.failureEvidenceSha256,
                    failureResultSha256: activeAcceptanceCorrection.failureResultSha256,
                    failure_result_sha256: activeAcceptanceCorrection.failureResultSha256,
                    legacy: Boolean(activeAcceptanceCorrection.legacy),
                    completedAt: event.timestamp,
                };
                acceptanceCorrections.push(record);
                if (event.status === 'PASSED') {
                    const task = tasks[event.task_id];
                    if (task) {
                        task.diffFingerprint = event.diff_fingerprint;
                        task.diff_fingerprint = event.diff_fingerprint;
                    }
                }
                activeAcceptanceCorrection = null;
                break;
            }
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

    validateOperationAuthorityLineage(operationRecords, { sessionId, workspaceId, planRevision, tasks, leases });
    validateOperationLedgerCommitment(operationLedger, operationCommitments, {
        allowOnePendingRecord: allowOnePendingOperationRecord,
    });

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
        qualityExecutions,
        quality_executions: qualityExecutions,
        reviewExecutions,
        review_executions: reviewExecutions,
        reviewAttestations,
        review_attestations: reviewAttestations,
        blocked,
        receipt,
        activeAcceptanceCorrection,
        active_acceptance_correction: activeAcceptanceCorrection,
        legacyAcceptanceCorrection,
        legacy_acceptance_correction: legacyAcceptanceCorrection,
        acceptanceCorrections,
        acceptance_corrections: acceptanceCorrections,
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
    const operationsPath = path.join(canonicalSessionDir, 'operations.ndjson');
    const validatorsPath = path.join(canonicalSessionDir, 'validators.ndjson');

    function readRaw() {
        return readRawRecords(eventsPath, fsImpl);
    }

    function readOperationRecords() {
        return readOperationLedger(operationsPath, fsImpl, cryptoImpl);
    }

    function readOperationLedgerStateCurrent() {
        return readOperationLedgerState(operationsPath, fsImpl, cryptoImpl);
    }

    function readValidatorRecords() {
        return readValidatorLedger(validatorsPath, fsImpl, cryptoImpl);
    }

    function readValidatorLedgerStateCurrent() {
        return readValidatorLedgerState(validatorsPath, fsImpl, cryptoImpl);
    }

    function replayCurrent(records = readRaw(), replayOptions = {}) {
        const operationLedger = readOperationLedgerStateCurrent();
        return replayAuthorityEvents(records, {
            cryptoImpl,
            clock,
            operationLedger,
            operationRecords: operationLedger.records,
            processPid: process.pid,
            ...replayOptions,
        });
    }

    function readEvents() {
        const records = readRaw();
        replayCurrent(records);
        return records.map((r) => r.event);
    }

    function derive() {
        return replayCurrent();
    }

    function verifyIntegrity() {
        const records = readRaw();
        const derived = replayCurrent(records);
        return {
            valid: true,
            eventCount: records.length,
            lastSequence: derived.lastSequence,
            lastHash: derived.lastHash,
            lastEventId: derived.lastEventId,
        };
    }

    function append(eventInput, appendOptions = {}) {
        const records = readRaw();
        const derived = replayCurrent(records, appendOptions);

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
            parsedEvent = parseContract(AuthorityEventSchema, eventPayload, 'session event');
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
        const nextDerived = replayCurrent(nextRecords, appendOptions);

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

    function appendOperationRecordInternal(recordInput, lifecycleType) {
        const operationLedger = readOperationLedgerStateCurrent();
        const operationRecords = operationLedger.records;
        const derived = replayCurrent();
        const record = validateOperationRecord({ ...recordInput });
        if (record.session_id !== derived.sessionId || record.workspace_id !== derived.workspaceId
            || record.plan_revision !== derived.planRevision) {
            throw new DualAuthorityError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation record does not match the current session authority');
        }
        const task = derived.tasks[record.task_id];
        const lease = derived.leases[record.lease_id];
        if (!task || !lease || lease.task_id !== record.task_id || lease.session_id !== record.session_id) {
            throw new DualAuthorityError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation record does not match the current task lease');
        }
        if (task.execution_mode !== 'isolated' || task.owner !== 'agy' || lease.owner !== 'agy') {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID', 'Operation lifecycle requires an isolated AGY task lease');
        }
        if (lease.status !== 'active') {
            throw new DualAuthorityError(lease.status === 'expired' ? 'DUAL_OPERATION_LEASE_EXPIRED' : 'DUAL_OPERATION_FENCED',
                `Operation lease is ${lease.status} and cannot be written`);
        }
        const execution = task.executions?.[record.lease_id];
        if (!execution || execution.session_id !== record.session_id || execution.plan_revision !== record.plan_revision) {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID', 'Operation record requires matching task.execution.started evidence');
        }
        const states = validateOperationSequence(operationRecords);
        const prior = states.get(record.operation_id);
        if (record.type === 'started') {
            const existingLineage = [...states.values()].find((state) => operationLineageKey(state) === operationLineageKey(record));
            if (existingLineage) {
                throw new DualAuthorityError(existingLineage.active ? 'DUAL_OPERATION_ACTIVE' : 'DUAL_OPERATION_SETTLED',
                    'Task lease already has a durable operation');
            }
            if (prior) throw new DualAuthorityError('DUAL_OPERATION_ACTIVE', 'Operation ID has already been registered');
        } else if (!prior || prior.settled) {
            throw new DualAuthorityError('DUAL_OPERATION_NOT_FOUND', 'Operation settle record has no active start');
        } else if (prior.session_id !== record.session_id || prior.workspace_id !== record.workspace_id
            || prior.plan_revision !== record.plan_revision || prior.task_id !== record.task_id
            || prior.lease_id !== record.lease_id) {
            throw new DualAuthorityError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation settle record changed authority lineage');
        }
        if (record.type === 'settled' && Object.values(execution.processes || {}).some((child) => child.state !== 'exited')) {
            throw new DualAuthorityError('DUAL_OPERATION_CHILDREN_ACTIVE', 'Operation cannot settle while tracked children are pending or live');
        }
        if (lifecycleType !== record.type) {
            throw new DualAuthorityError('DUAL_OPERATION_AUTHORIZATION_REQUIRED', 'Operation writes must pass through the lifecycle boundary');
        }
        validateOperationSequence([...operationRecords, record]);
        const chainHash = operationLedger.last_record_hash || '0'.repeat(64);
        const envelope = {
            previous_hash: chainHash,
            record_hash: computeEventHash(chainHash, record, cryptoImpl),
            record,
        };
        const line = JSON.stringify(envelope) + '\n';
        const buf = Buffer.from(line, 'utf8');
        const fd = fsImpl.openSync(operationsPath, 'a');
        try {
            let offset = 0;
            while (offset < buf.length) {
                const written = fsImpl.writeSync(fd, buf, offset, buf.length - offset, null);
                if (typeof written !== 'number' || written <= 0) {
                    throw new DualAuthorityError('DUAL_OPERATION_CORRUPT', 'Operation ledger write failed');
                }
                offset += written;
            }
            fsImpl.fsyncSync(fd);
        } finally {
            fsImpl.closeSync(fd);
        }
        const updatedContent = fsImpl.readFileSync(operationsPath, 'utf8');
        const operationLedgerSha256 = cryptoImpl.createHash('sha256').update(updatedContent).digest('hex');
        append({
            type: 'task.operation.ledger.committed', task_id: record.task_id, lease_id: record.lease_id,
            operation_id: record.operation_id, operation_type: record.type, operation_count: operationRecords.length + 1,
            operation_record_hash: envelope.record_hash, operation_ledger_sha256: operationLedgerSha256,
        }, { allowOnePendingOperationRecord: true });
        return record;
    }

    function currentOperationLineage(taskId, leaseId) {
        const derived = replayCurrent();
        const task = derived.tasks[taskId];
        const lease = derived.leases[leaseId];
        if (!task || !lease || lease.task_id !== taskId || lease.session_id !== derived.sessionId) {
            throw new DualAuthorityError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation does not match the current task lease lineage');
        }
        if (task.execution_mode !== 'isolated' || task.owner !== 'agy' || lease.owner !== 'agy') {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID', 'Operation lifecycle requires an isolated AGY task lease');
        }
        if (lease.status !== 'active') {
            throw new DualAuthorityError(lease.status === 'expired' ? 'DUAL_OPERATION_LEASE_EXPIRED' : 'DUAL_OPERATION_FENCED',
                `Operation lease is ${lease.status} and cannot be written`);
        }
        const execution = task.executions?.[leaseId];
        if (!execution || execution.session_id !== derived.sessionId || execution.plan_revision !== derived.planRevision) {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID', 'Operation lifecycle requires matching task.execution.started evidence');
        }
        return { derived, task, lease, execution };
    }

    function operationStatesCurrent() {
        return validateOperationSequence(readOperationLedgerStateCurrent().records);
    }

    function beginOperation({ taskId, leaseId, operationId } = {}) {
        if (typeof taskId !== 'string' || !taskId || !OPERATION_UUID.test(leaseId || '')
            || !OPERATION_UUID.test(operationId || '')) {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID', 'taskId, leaseId, and operationId must be valid authority identities');
        }
        const { derived, lease } = currentOperationLineage(taskId, leaseId);
        const states = operationStatesCurrent();
        const existing = states.get(operationId);
        if (existing) {
            throw new DualAuthorityError(existing.active ? 'DUAL_OPERATION_ACTIVE' : 'DUAL_OPERATION_SETTLED',
                'Operation ID cannot be registered more than once');
        }
        for (const state of states.values()) {
            if (state.session_id === derived.sessionId && state.task_id === taskId && state.lease_id === leaseId) {
                throw new DualAuthorityError(state.active ? 'DUAL_OPERATION_ACTIVE' : 'DUAL_OPERATION_SETTLED',
                    'The task lease already has a durable operation');
            }
        }
        appendOperationRecordInternal({
            schema_version: 1,
            type: 'started',
            operation_id: operationId,
            session_id: derived.sessionId,
            workspace_id: derived.workspaceId,
            plan_revision: derived.planRevision,
            task_id: taskId,
            lease_id: lease.lease_id,
            timestamp: new Date(clock()).toISOString(),
        }, 'started');
        return { active: true, settled: false, outcome: null, operation_id: operationId };
    }

    function settleOperation({ taskId, leaseId, operationId, outcome } = {}) {
        if (typeof taskId !== 'string' || !taskId || !OPERATION_UUID.test(leaseId || '')
            || !OPERATION_UUID.test(operationId || '')) {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID', 'taskId, leaseId, and operationId must be valid authority identities');
        }
        if (!OPERATION_OUTCOMES.has(outcome)) {
            throw new DualAuthorityError('DUAL_OPERATION_INVALID_OUTCOME', 'Operation outcome is invalid');
        }
        const { derived, task, lease, execution } = currentOperationLineage(taskId, leaseId);
        const state = operationStatesCurrent().get(operationId);
        if (!state) throw new DualAuthorityError('DUAL_OPERATION_NOT_FOUND', 'Operation has no durable start record');
        if (state.task_id !== taskId || state.lease_id !== leaseId) {
            throw new DualAuthorityError('DUAL_OPERATION_LINEAGE_MISMATCH', 'Operation ID is bound to a different task or lease');
        }
        if (state.settled) {
            if (state.outcome !== outcome) {
                throw new DualAuthorityError('DUAL_OPERATION_OUTCOME_CONFLICT', 'Operation outcome cannot change after settlement');
            }
            throw new DualAuthorityError('DUAL_OPERATION_FENCED', 'Operation was already settled; stale writers cannot re-submit it');
        }
        if (Object.values(execution.processes || {}).some((child) => child.state !== 'exited')) {
            throw new DualAuthorityError('DUAL_OPERATION_CHILDREN_ACTIVE', 'Operation cannot settle while tracked children are pending or live');
        }
        appendOperationRecordInternal({
            schema_version: 1,
            type: 'settled',
            operation_id: operationId,
            session_id: derived.sessionId,
            workspace_id: derived.workspaceId,
            plan_revision: derived.planRevision,
            task_id: taskId,
            lease_id: lease.lease_id,
            outcome,
            timestamp: new Date(clock()).toISOString(),
        }, 'settled');
        return { active: false, settled: true, outcome, operation_id: operationId };
    }

    function appendValidatorRecordInternal(recordInput, lifecycleType) {
        const validatorLedger = readValidatorLedgerStateCurrent();
        const derived = replayCurrent();
        const record = validateValidatorRecord({ ...recordInput });
        if (record.session_id !== derived.sessionId || record.workspace_id !== derived.workspaceId
            || record.plan_revision !== derived.planRevision) {
            throw new DualAuthorityError('DUAL_VALIDATOR_LINEAGE_MISMATCH', 'Validator record does not match the current session authority');
        }
        validateValidatorSequence([...validatorLedger.records, record]);
        const chainHash = validatorLedger.last_record_hash || '0'.repeat(64);
        const envelope = {
            previous_hash: chainHash,
            record_hash: computeEventHash(chainHash, record, cryptoImpl),
            record,
        };
        const line = JSON.stringify(envelope) + '\n';
        const buf = Buffer.from(line, 'utf8');
        const fd = fsImpl.openSync(validatorsPath, 'a');
        try {
            let offset = 0;
            while (offset < buf.length) {
                const written = fsImpl.writeSync(fd, buf, offset, buf.length - offset, null);
                if (typeof written !== 'number' || written <= 0) {
                    throw new DualAuthorityError('DUAL_VALIDATOR_CORRUPT', 'Validator ledger write failed');
                }
                offset += written;
            }
            fsImpl.fsyncSync(fd);
        } finally {
            fsImpl.closeSync(fd);
        }
        return record;
    }

    let inMemoryActiveValidatorRun = null;

    function beginValidatorRun(binding = {}) {
        if (!binding || typeof binding !== 'object') {
            throw new DualAuthorityError('DUAL_VALIDATOR_INVALID', 'Validator binding must be an object');
        }
        const {
            runId,
            sessionId,
            workspaceId,
            planRevision,
            baselineId,
            baselineKind,
            sourceFingerprint,
            purpose,
            commandPolicyDigest,
            cycle,
            attempt,
            correctionId,
        } = binding;

        if (typeof runId !== 'string' || !OPERATION_UUID.test(runId)) {
            throw new DualAuthorityError('DUAL_VALIDATOR_INVALID', 'runId must be a valid UUID');
        }
        if (purpose !== 'quality' && purpose !== 'correction' && purpose !== 'acceptance-correction') {
            throw new DualAuthorityError('DUAL_VALIDATOR_INVALID', 'purpose must be quality, acceptance-correction, or correction');
        }

        const derived = replayCurrent();
        if (!derived.sessionId) {
            throw new DualAuthorityError('DUAL_SESSION_NOT_INITIALIZED', 'Cannot begin validator before session is initialized');
        }
        if (sessionId !== derived.sessionId || workspaceId !== derived.workspaceId || planRevision !== derived.planRevision) {
            throw new DualAuthorityError('DUAL_VALIDATOR_LINEAGE_MISMATCH', 'Validator run does not match current authority lineage');
        }

        // Check if exact same in-process run is already active -> coalesce
        if (inMemoryActiveValidatorRun && inMemoryActiveValidatorRun.runId === runId) {
            return {
                capability: inMemoryActiveValidatorRun.capability,
                runId,
                active: true,
                settled: false,
                coalesced: true,
            };
        }

        // Check if ANY validator run is active/unresolved in durable ledger
        const ledger = readValidatorLedgerStateCurrent();
        const states = validateValidatorSequence(ledger.records);
        for (const state of states.values()) {
            if (state.active && !state.settled) {
                throw new DualAuthorityError('DUAL_VALIDATOR_RUN_CONFLICT', `Validator run ${state.run_id} is already active or unresolved in this session`);
            }
        }
        if (inMemoryActiveValidatorRun) {
            throw new DualAuthorityError('DUAL_VALIDATOR_RUN_CONFLICT', `Validator run ${inMemoryActiveValidatorRun.runId} is currently active in memory`);
        }

        const startedRecord = {
            schema_version: 1,
            type: 'started',
            run_id: runId,
            session_id: sessionId,
            workspace_id: workspaceId,
            plan_revision: planRevision,
            baseline_id: baselineId || derived.expectedBaseline?.id || '0'.repeat(64),
            baseline_kind: baselineKind || derived.expectedBaseline?.kind || 'snapshot',
            source_fingerprint: sourceFingerprint,
            purpose,
            command_policy_digest: commandPolicyDigest,
            ...(cycle !== undefined ? { cycle } : {}),
            ...(attempt !== undefined ? { attempt } : {}),
            ...(correctionId !== undefined ? { correction_id: correctionId } : {}),
            timestamp: new Date(clock()).toISOString(),
        };

        appendValidatorRecordInternal(startedRecord, 'started');

        const capability = Object.freeze({
            token: uuid(),
            runId,
            startedAt: startedRecord.timestamp,
        });

        inMemoryActiveValidatorRun = {
            runId,
            capability,
            binding: { ...binding },
            startedRecord,
        };

        return {
            capability,
            runId,
            active: true,
            settled: false,
        };
    }

    function settleValidatorRun({ capability, ownedResult, resultAnchor } = {}) {
        if (!capability || !inMemoryActiveValidatorRun || inMemoryActiveValidatorRun.capability !== capability) {
            throw new DualAuthorityError('DUAL_VALIDATOR_CAPABILITY_INVALID', 'Invalid or forged validator lifecycle capability');
        }
        if (!ownedResult || typeof ownedResult !== 'object') {
            throw new DualAuthorityError('DUAL_VALIDATOR_INVALID', 'ownedResult is required');
        }
        if (ownedResult.runId !== inMemoryActiveValidatorRun.runId) {
            throw new DualAuthorityError('DUAL_VALIDATOR_RESULT_MISMATCH', 'ownedResult.runId does not match the active validator run');
        }
        if (ownedResult.cleanupVerified !== true || (ownedResult.activeOwnedProcesses ?? 0) > 0) {
            throw new DualAuthorityError('DUAL_VALIDATOR_CLEANUP_UNPROVEN', 'Process cleanup was not proven or active processes remain');
        }
        if (!resultAnchor || typeof resultAnchor !== 'object' || !resultAnchor.digest || !OPERATION_SHA256.test(resultAnchor.digest)) {
            throw new DualAuthorityError('DUAL_VALIDATOR_INVALID', 'resultAnchor.digest must be a valid sha256');
        }

        let outcome = 'failed';
        if (ownedResult.exitCode === 0 && !ownedResult.failure) {
            outcome = 'passed';
        } else if (ownedResult.cancellationCode) {
            outcome = 'aborted';
        }

        const startedRecord = inMemoryActiveValidatorRun.startedRecord;
        const settledRecord = {
            schema_version: 1,
            type: 'settled',
            run_id: startedRecord.run_id,
            session_id: startedRecord.session_id,
            workspace_id: startedRecord.workspace_id,
            plan_revision: startedRecord.plan_revision,
            baseline_id: startedRecord.baseline_id,
            baseline_kind: startedRecord.baseline_kind,
            source_fingerprint: startedRecord.source_fingerprint,
            purpose: startedRecord.purpose,
            command_policy_digest: startedRecord.command_policy_digest,
            ...(startedRecord.cycle !== undefined ? { cycle: startedRecord.cycle } : {}),
            ...(startedRecord.attempt !== undefined ? { attempt: startedRecord.attempt } : {}),
            ...(startedRecord.correction_id !== undefined ? { correction_id: startedRecord.correction_id } : {}),
            outcome,
            exit_code: ownedResult.exitCode ?? null,
            signal: ownedResult.signal ?? null,
            failure: ownedResult.failure ?? null,
            duration_ms: ownedResult.durationMs ?? 0,
            stdout_bytes: ownedResult.stdoutBytes ?? 0,
            stderr_bytes: ownedResult.stderrBytes ?? 0,
            stdout_sha256: ownedResult.stdoutSha256 ?? '0'.repeat(64),
            stderr_sha256: ownedResult.stderrSha256 ?? '0'.repeat(64),
            output_sha256: ownedResult.outputSha256 ?? '0'.repeat(64),
            result_anchor_digest: resultAnchor.digest,
            active_owned_processes: 0,
            cleanup_verified: true,
            timestamp: new Date(clock()).toISOString(),
        };

        appendValidatorRecordInternal(settledRecord, 'settled');
        inMemoryActiveValidatorRun = null;

        return {
            runId: settledRecord.run_id,
            active: false,
            settled: true,
            outcome,
        };
    }

    function acquireLease(taskId, owner, options = {}) {
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

        const ttlMs = (options && (options.ttlMs || options.ttl_ms)) || 30000;
        if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
            throw new DualAuthorityError('DUAL_LEASE_INVALID', 'ttlMs must be a positive integer');
        }

        const now = new Date(clock());
        const nowMs = now.getTime();
        const nowIso = now.toISOString();
        const expiresAtIso = new Date(nowMs + ttlMs).toISOString();
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
            ttl_ms: ttlMs,
        };

        append(leaseEvent);

        return {
            leaseId,
            lease_id: leaseId,
            taskId,
            task_id: taskId,
            owner,
            sessionId: derived.sessionId,
            session_id: derived.sessionId,
            planRevision: derived.planRevision,
            plan_revision: derived.planRevision,
            acquiredAt: nowIso,
            acquired_at: nowIso,
            expiresAt: expiresAtIso,
            expires_at: expiresAtIso,
            ttlMs: ttlMs,
            ttl_ms: ttlMs,
            renewedAt: null,
            renewed_at: null,
            releasedAt: null,
            released_at: null,
            releaseReason: null,
            release_reason: null,
            status: 'active',
        };
    }

    function renewLease(leaseId, options = {}) {
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

        const ttlMs = (options && (options.ttlMs || options.ttl_ms)) || lease.ttl_ms || 30000;
        if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
            throw new DualAuthorityError('DUAL_LEASE_INVALID', 'ttlMs must be a positive integer');
        }

        const nowIso = now.toISOString();
        const newExpiresAtIso = new Date(nowMs + ttlMs).toISOString();

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
            ttl_ms: ttlMs,
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
            ttlMs: ttlMs,
            ttl_ms: ttlMs,
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

    function recordFinalizationFailure({ taskId, leaseId, attempt, code, stage = 'post_worker_collection' }) {
        const derived = derive();
        const existing = readRaw().map((record) => record.event)
            .filter((event) => event.type === 'task.execution.finalization_failed'
                && event.task_id === taskId && event.lease_id === leaseId && event.attempt === attempt).at(-1);
        if (!/^[A-Z0-9_]{1,128}$/.test(code || '')
            || !['unknown', 'post_worker_collection', 'outer_handoff'].includes(stage)) {
            throw new DualAuthorityError('DUAL_FINALIZATION_INVALID', 'Finalization failure code or stage is invalid');
        }
        const task = derived.tasks[taskId];
        const lease = derived.leases[leaseId];
        const execution = task?.executions?.[leaseId];
        const currentSettlement = finalizationSettlement(execution, operationStatesCurrent(), taskId, leaseId);
        const priorFailure = task?.lastOutcome;
        const lineageMatches = derived.sessionState === 'EXECUTING' && task && task.state !== 'TASK_VERIFIED'
            && task.owner === 'agy' && task.execution_mode === 'isolated' && !task.isolatedHandoff
            && (!priorFailure || (priorFailure.attempt === attempt && priorFailure.status === 'FAILED' && priorFailure.code === code))
            && lease && lease.task_id === taskId && lease.owner === 'agy'
            && currentTaskAttempt(task) === attempt
            && execution && execution.controller_pid === process.pid
            && execution.session_id === derived.sessionId && lease.session_id === derived.sessionId
            && execution.plan_revision === derived.planRevision && lease.plan_revision === derived.planRevision
            && task.routePlanRevision === derived.planRevision
            && execution.attempt === attempt
            && !hasNewerLease(derived.leases, taskId, leaseId, lease)
            && !hasNewerExecution(task, derived.leases, leaseId, lease);
        if (existing) {
            if (existing.code !== code || existing.stage !== stage) {
                throw new DualAuthorityError('DUAL_FINALIZATION_CONFLICT', 'Finalization failure already recorded with different lineage');
            }
            if (existing.summary !== finalizationSummary(existing.stage, existing.code, existing.recovery)) {
                throw new DualAuthorityError('DUAL_FINALIZATION_CONFLICT', 'Finalization failure diagnostic changed after recording');
            }
        }
        const historicalSettled = existing?.settled === true && lease?.status === 'released'
            && lease.release_reason === 'finalization_failed'
            && priorFailure?.attempt === attempt && priorFailure.status === 'FAILED' && priorFailure.code === code;
        if (historicalSettled) {
            if (existing.recovery !== currentSettlement.recovery || existing.settled !== currentSettlement.settled) {
                throw new DualAuthorityError('DUAL_FINALIZATION_CONFLICT', 'Settled finalization evidence cannot be changed');
            }
            return { ...existing, idempotent: true };
        }
        if (!lineageMatches || lease.status === 'released') {
            throw new DualAuthorityError('DUAL_FINALIZATION_UNSAFE', 'Finalization failure lacks current controller ownership and task lineage');
        }
        const now = new Date(clock());
        if (now.getTime() < new Date(lease.expires_at).getTime()) {
            throw new DualAuthorityError('DUAL_FINALIZATION_ACTIVE', 'Finalization failure settlement is only available after lease expiry');
        }
        if (existing) {
            if (!currentSettlement.settled && existing.recovery === currentSettlement.recovery) {
                return { ...existing, idempotent: true };
            }
            if (existing.settled || !currentSettlement.settled) {
                throw new DualAuthorityError('DUAL_FINALIZATION_CONFLICT', 'Only one unsettled finalization record may upgrade to a settled outcome');
            }
        }
        const settlement = currentSettlement;
        const summary = finalizationSummary(stage, code, settlement.recovery);
        const event = append({ schema_version: 2, type: 'task.execution.finalization_failed', task_id: taskId,
            lease_id: leaseId, attempt, controller_pid: execution.controller_pid, status: 'FAILED', stage, code,
            summary, recovery: settlement.recovery, settled: settlement.settled });
        return { ...event, idempotent: false };
    }

    const store = {
        append,
        readEvents,
        readOperationRecords,
        readValidatorRecords,
        now: () => new Date(clock()).toISOString(),
        derive,
        acquireLease,
        renewLease,
        releaseLease,
        recordFinalizationFailure,
        verifyIntegrity,
    };
    bindOperationLifecycle(store, { begin: beginOperation, settle: settleOperation });
    bindValidatorLifecycle(store, { begin: beginValidatorRun, settle: settleValidatorRun });
    return store;
}

module.exports = {
    DualAuthorityError,
    EnvelopeSchema,
    canonicalizeEvent,
    computeEventHash,
    computeLeaseStatus,
    replayAuthorityEvents,
    createAuthorityStore,
    readValidatorLedger,
    readValidatorLedgerState,
};
