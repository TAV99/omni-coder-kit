'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    EventSchema,
    PhaseSchema,
    parseContract,
    normalizeBaselineCorrelation,
    emitBaselineCorrelation,
} = require('./contracts');
const { createArtifactStore } = require('./artifacts');

const STATES = Object.freeze([
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

const TRANSITIONS = Object.freeze({
    NEW: Object.freeze(['PREFLIGHT_SAFE']),
    PREFLIGHT_SAFE: Object.freeze(['SCOUT_VALID']),
    SCOUT_VALID: Object.freeze(['SPEC_VALID']),
    SPEC_VALID: Object.freeze(['ROUTED']),
    ROUTED: Object.freeze(['CODEX_OWNED', 'IMPLEMENT_VALID']),
    CODEX_OWNED: Object.freeze([]),
    IMPLEMENT_VALID: Object.freeze(['SCOPE_VALID']),
    SCOPE_VALID: Object.freeze(['REVIEW_VALID']),
    REVIEW_VALID: Object.freeze(['CODEX_QC']),
    CODEX_QC: Object.freeze([]),
});

const PHASE_TRANSITIONS = Object.freeze({
    preflight: Object.freeze([['NEW', 'PREFLIGHT_SAFE']]),
    scout: Object.freeze([['PREFLIGHT_SAFE', 'SCOUT_VALID']]),
    spec: Object.freeze([['SCOUT_VALID', 'SPEC_VALID']]),
    route: Object.freeze([['SPEC_VALID', 'ROUTED'], ['ROUTED', 'CODEX_OWNED']]),
    implement: Object.freeze([['ROUTED', 'IMPLEMENT_VALID']]),
    scope: Object.freeze([['IMPLEMENT_VALID', 'SCOPE_VALID']]),
    review: Object.freeze([['SCOPE_VALID', 'REVIEW_VALID'], ['REVIEW_VALID', 'CODEX_QC']]),
});

class DualStateError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DualStateError';
        this.code = code;
    }
}

function canTransition(from, to) {
    return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function validatePhaseTransition(event) {
    const allowed = PHASE_TRANSITIONS[event.phase] || [];
    if (!allowed.some(([from, to]) => from === event.from_state && to === event.to_state)) {
        throw new DualStateError(
            'DUAL_STATE_CAUSATION',
            `Phase ${event.phase} cannot cause ${event.from_state} -> ${event.to_state}`,
        );
    }
}

function verifyArtifactHashes(event, runDir, sha256) {
    if (!runDir || event.type !== 'phase.completed') {
        return;
    }
    for (const [relativePath, expectedHash] of Object.entries(event.artifact_hashes)) {
        if (
            path.isAbsolute(relativePath)
            || path.win32.isAbsolute(relativePath)
            || path.posix.isAbsolute(relativePath)
            || relativePath.includes('\0')
        ) {
            throw new DualStateError('DUAL_ARTIFACT_HASH', 'Artifact hash references an unsafe path');
        }
        const target = path.resolve(runDir, relativePath);
        const relative = path.relative(runDir, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new DualStateError('DUAL_ARTIFACT_HASH', 'Artifact hash references a path outside the run');
        }
        let content;
        try {
            content = fs.readFileSync(target);
        } catch {
            throw new DualStateError('DUAL_ARTIFACT_HASH', 'Referenced artifact is missing');
        }
        if (sha256(content) !== expectedHash) {
            throw new DualStateError('DUAL_ARTIFACT_HASH', 'Referenced artifact hash does not match');
        }
    }
}

function replay(events, options = {}) {
    if (!Array.isArray(events)) {
        throw new DualStateError('DUAL_EVENT_LOG_CORRUPT', 'Event log must contain an array of events');
    }

    let state = null;
    let taskId = options.taskId || null;
    let expectedBaseline = null;
    if (options.expectedBaseline) {
        expectedBaseline = normalizeBaselineCorrelation(options.expectedBaseline);
    } else if (options.expectedBaseCommit) {
        expectedBaseline = normalizeBaselineCorrelation({ expected_base_commit: options.expectedBaseCommit });
    }
    const lastAttempt = new Map();
    const activeAttempts = new Map();
    const successfulAttempts = new Map();

    events.forEach((rawEvent, index) => {
        let event;
        try {
            event = parseContract(EventSchema, rawEvent, 'dual event');
        } catch (err) {
            throw new DualStateError('DUAL_EVENT_LOG_CORRUPT', `Invalid event contract at index ${index}: ${err.message}`);
        }
        const expectedSequence = index + 1;
        if (event.sequence !== expectedSequence) {
            throw new DualStateError('DUAL_EVENT_SEQUENCE', 'Event sequence is not contiguous');
        }

        const evBaseline = normalizeBaselineCorrelation(event);
        if (taskId === null) taskId = event.task_id;
        if (expectedBaseline === null) expectedBaseline = evBaseline;
        if (
            event.task_id !== taskId ||
            evBaseline.kind !== expectedBaseline.kind ||
            evBaseline.id !== expectedBaseline.id
        ) {
            throw new DualStateError('DUAL_EVENT_CORRELATION', 'Event correlation does not match the transaction');
        }

        if (index === 0) {
            if (event.type !== 'transaction.created' || event.state !== 'NEW') {
                throw new DualStateError('DUAL_EVENT_LOG_CORRUPT', 'First event must create the transaction');
            }
            state = 'NEW';
            return;
        }
        if (event.type === 'transaction.created') {
            throw new DualStateError('DUAL_EVENT_LOG_CORRUPT', 'Transaction may only be created once');
        }

        if (event.type === 'handoff.completed') {
            const validHandoff = (
                event.from_state === 'ROUTED'
                && event.to_state === 'CODEX_OWNED'
                && event.reason === 'codex_route'
            ) || (
                event.from_state === 'REVIEW_VALID'
                && event.to_state === 'CODEX_QC'
                && event.reason === 'final_qc'
            );
            if (!validHandoff || event.from_state !== state || !canTransition(event.from_state, event.to_state)) {
                throw new DualStateError('DUAL_STATE_TRANSITION', 'Handoff contains an illegal state transition');
            }
            state = event.to_state;
            return;
        }

        if (event.type === 'phase.started') {
            if (successfulAttempts.has(event.phase)) {
                throw new DualStateError('DUAL_PHASE_ALREADY_COMPLETED', 'Successful phase cannot be started again');
            }
            const expectedAttempt = (lastAttempt.get(event.phase) || 0) + 1;
            if (event.attempt !== expectedAttempt || activeAttempts.has(event.phase)) {
                throw new DualStateError('DUAL_ATTEMPT_SEQUENCE', 'Phase attempt is not monotonic');
            }
            lastAttempt.set(event.phase, event.attempt);
            activeAttempts.set(event.phase, event.attempt);
            return;
        }

        if (activeAttempts.get(event.phase) !== event.attempt) {
            throw new DualStateError('DUAL_ATTEMPT_SEQUENCE', 'Phase result does not match a started attempt');
        }
        activeAttempts.delete(event.phase);

        if (event.type === 'phase.failed') {
            return;
        }

        if (event.from_state !== state || !canTransition(event.from_state, event.to_state)) {
            throw new DualStateError('DUAL_STATE_TRANSITION', 'Completed phase contains an illegal state transition');
        }
        validatePhaseTransition(event);
        verifyArtifactHashes(event, options.runDir, options.sha256);
        successfulAttempts.set(event.phase, event);
        state = event.to_state;
    });

    return {
        state,
        taskId,
        expectedBaseline,
        expectedBaseCommit: expectedBaseline && expectedBaseline.kind === 'git' ? expectedBaseline.id : undefined,
        lastAttempt,
        successfulAttempts,
    };
}

function deriveState(events, options) {
    return replay(events, options).state;
}

function createStateStore(runDir, options = {}) {
    fs.mkdirSync(runDir, { recursive: true });
    const canonicalRunDir = fs.realpathSync.native(runDir);
    const eventsPath = path.join(canonicalRunDir, 'events.ndjson');
    const artifacts = createArtifactStore(canonicalRunDir);
    const clock = options.clock || (() => new Date());
    const uuid = options.uuid || crypto.randomUUID;

    function readRawRecords({ repairTail = false } = {}) {
        if (!fs.existsSync(eventsPath)) return [];
        const content = fs.readFileSync(eventsPath, 'utf8');
        const lastNewline = content.lastIndexOf('\n');
        const completeContent = lastNewline === -1 ? '' : content.slice(0, lastNewline + 1);
        if (repairTail && completeContent.length !== content.length) {
            fs.truncateSync(eventsPath, Buffer.byteLength(completeContent, 'utf8'));
        }
        if (completeContent.length === 0) return [];

        return completeContent.split('\n').filter(Boolean).map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                throw new DualStateError('DUAL_EVENT_LOG_CORRUPT', 'Event log contains malformed JSON');
            }
        });
    }

    function replayCurrent(events) {
        return replay(events, {
            taskId: options.taskId,
            expectedBaseline: options.expectedBaseline,
            expectedBaseCommit: options.expectedBaseCommit,
            runDir: canonicalRunDir,
            sha256: artifacts.sha256,
        });
    }

    function readEvents() {
        const events = readRawRecords();
        replayCurrent(events);
        return events;
    }

    function writeCache(result, lastSequence) {
        if (result.state === null) return;
        const baselineData = result.expectedBaseline
            ? emitBaselineCorrelation(result.expectedBaseline)
            : (result.expectedBaseCommit ? { expected_base_commit: result.expectedBaseCommit } : {});
        artifacts.writeJsonAtomic('state.json', {
            schema_version: 1,
            task_id: result.taskId,
            ...baselineData,
            state: result.state,
            last_sequence: lastSequence,
        });
    }

    function append(payload) {
        const events = readRawRecords({ repairTail: true });
        const existing = replayCurrent(events);
        const taskId = options.taskId || existing.taskId || payload.task_id;
        const baselineSource = options.expectedBaseline
            || options.expectedBaseCommit
            || existing.expectedBaseline
            || existing.expectedBaseCommit
            || payload;
        const expectedBaseline = normalizeBaselineCorrelation(baselineSource);

        if (payload.expected_baseline || payload.expected_base_commit) {
            const payloadBaseline = normalizeBaselineCorrelation(payload);
            if (
                expectedBaseline &&
                (payloadBaseline.kind !== expectedBaseline.kind || payloadBaseline.id !== expectedBaseline.id)
            ) {
                throw new DualStateError('DUAL_EVENT_CORRELATION', 'Event correlation does not match the transaction');
            }
        }
        if (payload.task_id && taskId && payload.task_id !== taskId) {
            throw new DualStateError('DUAL_EVENT_CORRELATION', 'Event correlation does not match the transaction');
        }

        const baselineData = emitBaselineCorrelation(expectedBaseline);

        const event = parseContract(EventSchema, {
            ...payload,
            schema_version: 1,
            task_id: taskId,
            ...baselineData,
            event_id: uuid(),
            sequence: events.length + 1,
            timestamp: clock().toISOString(),
        }, 'dual event');
        const nextEvents = [...events, event];
        const next = replayCurrent(nextEvents);

        fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
        writeCache(next, event.sequence);
        return event;
    }

    function current() {
        return replayCurrent(readRawRecords()).state;
    }

    function nextAttempt(phase) {
        parseContract(PhaseSchema, phase, 'phase');
        const result = replayCurrent(readRawRecords());
        return (result.lastAttempt.get(phase) || 0) + 1;
    }

    function hasSuccessfulPhase(phase) {
        parseContract(PhaseSchema, phase, 'phase');
        const result = replayCurrent(readRawRecords());
        return result.successfulAttempts.get(phase) || null;
    }

    return {
        readEvents,
        append,
        current,
        nextAttempt,
        hasSuccessfulPhase,
    };
}

module.exports = {
    STATES,
    TRANSITIONS,
    DualStateError,
    canTransition,
    deriveState,
    createStateStore,
};
