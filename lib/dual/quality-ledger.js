'use strict';

const ALLOWED_GATE_STATUSES = new Set([
    'PASSED', 'FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED'
]);
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REGISTERED_TASKS = 1024;

class DualQualityError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualQualityError';
        this.code = code;
        this.details = details;
    }
}

function isStrictPlainObject(obj) {
    if (obj === null || typeof obj !== 'object') return false;
    if (Object.getPrototypeOf(obj) !== Object.prototype) return false;
    if (Object.getOwnPropertySymbols(obj).length > 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    for (const key of Object.keys(descriptors)) {
        const desc = descriptors[key];
        if (typeof desc.get === 'function' || typeof desc.set === 'function') {
            return false;
        }
    }
    return true;
}

function validateExactKeys(obj, allowedKeyList, label) {
    const keys = Object.keys(obj);
    const allowedSet = new Set(allowedKeyList);
    for (const key of keys) {
        if (!allowedSet.has(key)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_KEY',
                `Unexpected key '${key}' in ${label}`
            );
        }
    }
}

function validateRequiredKeys(obj, requiredKeyList, label) {
    for (const key of requiredKeyList) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            throw new DualQualityError(
                'DUAL_QUALITY_MISSING_KEY',
                `Missing required key '${key}' in ${label}`
            );
        }
    }
}

function cycleThresholds(total) {
    if (
        typeof total !== 'number' ||
        !Number.isSafeInteger(total) ||
        total <= 0 ||
        total > MAX_REGISTERED_TASKS
    ) {
        throw new DualQualityError(
            'DUAL_QUALITY_INVALID_TOTAL',
            `Invalid total tasks: ${total}. Expected positive safe integer <= ${MAX_REGISTERED_TASKS}.`
        );
    }
    return [
        Math.ceil(total / 3),
        Math.ceil((2 * total) / 3),
        total,
    ];
}

function evaluateMandatoryGates(gates) {
    if (!Array.isArray(gates)) {
        throw new DualQualityError(
            'DUAL_QUALITY_INVALID_GATES',
            'Expected an array of gate records'
        );
    }
    if (gates.length === 0) {
        throw new DualQualityError(
            'DUAL_QUALITY_INVALID_GATES',
            'Gates array cannot be empty'
        );
    }
    if (gates.length > 256) {
        throw new DualQualityError(
            'DUAL_QUALITY_INVALID_GATES',
            `Gates array exceeds maximum length of 256 (got ${gates.length})`
        );
    }

    const seenIds = new Set();
    const blockers = [];

    for (let i = 0; i < gates.length; i++) {
        const item = gates[i];
        if (!isStrictPlainObject(item)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_GATE',
                `Gate at index ${i} is not a strict plain object`
            );
        }

        validateExactKeys(item, ['id', 'required', 'status', 'reason'], `gate at index ${i}`);
        validateRequiredKeys(item, ['id', 'required', 'status'], `gate at index ${i}`);

        const id = item.id;
        if (typeof id !== 'string' || !GATE_ID_PATTERN.test(id) || CONTROL_CHAR_PATTERN.test(id)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_GATE',
                `Gate at index ${i} has invalid id: must be non-empty string <= 128 chars without control characters`
            );
        }

        if (seenIds.has(id)) {
            throw new DualQualityError(
                'DUAL_QUALITY_DUPLICATE_GATE_ID',
                `Duplicate gate ID at index ${i}: ${id}`
            );
        }
        seenIds.add(id);

        if (typeof item.required !== 'boolean') {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_GATE',
                `Gate '${id}' missing or invalid boolean required property`
            );
        }

        if (typeof item.status !== 'string' || !ALLOWED_GATE_STATUSES.has(item.status)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_GATE_STATUS',
                `Gate '${id}' has invalid status: ${item.status}`
            );
        }

        let reason;
        if (item.reason !== undefined) {
            if (
                typeof item.reason !== 'string' ||
                item.reason.trim().length === 0 ||
                item.reason.length > 256 ||
                CONTROL_CHAR_PATTERN.test(item.reason)
            ) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_GATE',
                    `Gate '${id}' reason must be non-empty string <= 256 chars without control characters`
                );
            }
            reason = item.reason;
        }

        const required = item.required;
        const status = item.status;

        if (required) {
            if (status !== 'PASSED') {
                blockers.push({
                    id,
                    required: true,
                    status,
                    reason: reason || `Required gate ${id} ended with status ${status}`,
                });
            }
        } else {
            if (status !== 'PASSED' && status !== 'OPTIONAL_SKIPPED') {
                blockers.push({
                    id,
                    required: false,
                    status,
                    reason: reason || `Optional gate ${id} attempted and failed with status ${status}`,
                });
            }
        }
    }

    return {
        verdict: blockers.length === 0 ? 'PASSED' : 'BLOCKED',
        blockers,
    };
}

function validateQualityHistory(allEvents, currentCycleIndex, currentTotalTasks, currentPlanRevision, derivedTasks, mode = 'record') {
    if (!Array.isArray(allEvents)) {
        throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', 'readEvents did not return an array');
    }

    const qualityEvents = [];
    for (let idx = 0; idx < allEvents.length; idx++) {
        const ev = allEvents[idx];
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'gate.result' && typeof ev.gate_id === 'string' && ev.gate_id.startsWith('quality-cycle-')) {
            if (!isStrictPlainObject(ev)) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Quality event at index ${idx} is not a strict plain object`);
            }
            qualityEvents.push({ ev, rawIndex: idx });
        }
    }

    let maxSeenCycleIndex = 0;
    const cycleEventsMap = new Map();

    for (const { ev } of qualityEvents) {
        const match = /^quality-cycle-([1-3])$/.exec(ev.gate_id);
        if (!match) {
            throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Invalid quality gate_id: ${ev.gate_id}`);
        }
        const gateCycleIndex = Number(match[1]);
        if (ev.cycle_index !== gateCycleIndex) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_HISTORY',
                `gate_id '${ev.gate_id}' does not match cycle_index ${ev.cycle_index}`
            );
        }

        // Reject if a cycle index greater than currentCycleIndex already exists in history
        if (mode === 'record' && gateCycleIndex > currentCycleIndex) {
            throw new DualQualityError(
                'DUAL_QUALITY_LATER_CYCLE_EXISTS',
                `Quality cycle ${gateCycleIndex} event already exists in history when recording cycle ${currentCycleIndex}`
            );
        }

        if (gateCycleIndex < maxSeenCycleIndex) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_HISTORY',
                `Quality cycle ${gateCycleIndex} event appeared after cycle ${maxSeenCycleIndex} event in log`
            );
        }
        if (gateCycleIndex > maxSeenCycleIndex) {
            maxSeenCycleIndex = gateCycleIndex;
        }

        if (!cycleEventsMap.has(gateCycleIndex)) {
            cycleEventsMap.set(gateCycleIndex, []);
        }
        cycleEventsMap.get(gateCycleIndex).push(ev);
    }

    for (const [cIndex, events] of cycleEventsMap.entries()) {
        let hasPassed = false;
        const expectedThreshold = cycleThresholds(currentTotalTasks)[cIndex - 1];

        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (hasPassed) {
                throw new DualQualityError(
                    'DUAL_QUALITY_CYCLE_ALREADY_PASSED',
                    `Cycle ${cIndex} has event after PASSED status`
                );
            }

            if (
                typeof e.reason !== 'string' ||
                e.reason.trim().length === 0 ||
                e.reason.length > 256 ||
                CONTROL_CHAR_PATTERN.test(e.reason)
            ) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event has invalid reason`);
            }

            if (typeof e.evidence_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.evidence_sha256)) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event has invalid evidence_sha256`);
            }

            if (!isStrictPlainObject(e.details)) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details is not a plain object`);
            }

            validateExactKeys(
                e.details,
                [
                    'required',
                    'cycle_index',
                    'attempt',
                    'threshold',
                    'total_tasks',
                    'completed_task_ids',
                    'plan_revision',
                    'diff_fingerprint',
                    'commands',
                    'verdict',
                    'blockers',
                ],
                `Cycle ${cIndex} event details`
            );
            validateRequiredKeys(
                e.details,
                [
                    'required',
                    'cycle_index',
                    'attempt',
                    'threshold',
                    'total_tasks',
                    'completed_task_ids',
                    'plan_revision',
                    'diff_fingerprint',
                    'commands',
                    'verdict',
                    'blockers',
                ],
                `Cycle ${cIndex} event details`
            );

            if (e.details.cycle_index !== cIndex) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details.cycle_index mismatch`);
            }
            if (e.details.attempt !== i + 1) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} attempt mismatch at index ${i}: expected ${i + 1}, got ${e.details.attempt}`);
            }
            if (e.details.required !== true) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details.required must be true`);
            }
            if (e.details.threshold !== expectedThreshold) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details.threshold mismatch`);
            }
            if (e.details.total_tasks !== currentTotalTasks) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details.total_tasks mismatch`);
            }
            if (e.details.plan_revision !== currentPlanRevision) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details.plan_revision mismatch`);
            }
            if (typeof e.details.diff_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(e.details.diff_fingerprint)) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} event details.diff_fingerprint invalid`);
            }

            if (!Array.isArray(e.details.completed_task_ids)) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} completed_task_ids must be array`);
            }
            if (
                e.details.completed_task_ids.length < expectedThreshold ||
                e.details.completed_task_ids.length > currentTotalTasks
            ) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} completed_task_ids count invalid for threshold`);
            }

            const seenTaskIds = new Set();
            for (const taskId of e.details.completed_task_ids) {
                if (
                    typeof taskId !== 'string' ||
                    !TASK_ID_PATTERN.test(taskId) ||
                    CONTROL_CHAR_PATTERN.test(taskId) ||
                    seenTaskIds.has(taskId)
                ) {
                    throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} completed_task_ids contains invalid or duplicate ID`);
                }
                seenTaskIds.add(taskId);
                if (
                    !derivedTasks ||
                    !Object.prototype.hasOwnProperty.call(derivedTasks, taskId) ||
                    !isStrictPlainObject(derivedTasks[taskId]) ||
                    derivedTasks[taskId].state !== 'TASK_VERIFIED'
                ) {
                    throw new DualQualityError(
                        'DUAL_QUALITY_CORRUPT_HISTORY',
                        `Cycle ${cIndex} completed_task_ids contains unverified task ${taskId}`
                    );
                }
            }

            if (!Array.isArray(e.details.commands) || e.details.commands.length === 0 || e.details.commands.length > 32) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} commands invalid`);
            }
            for (let cIdx = 0; cIdx < e.details.commands.length; cIdx++) {
                const cmd = e.details.commands[cIdx];
                if (!isStrictPlainObject(cmd)) {
                    throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} command record at index ${cIdx} is not plain object`);
                }
                validateExactKeys(cmd, ['command', 'exit_code', 'duration_ms'], `Cycle ${cIndex} command record`);
                validateRequiredKeys(cmd, ['command', 'exit_code', 'duration_ms'], `Cycle ${cIndex} command record`);
                if (
                    typeof cmd.command !== 'string' ||
                    cmd.command.trim().length === 0 ||
                    cmd.command.length > 256 ||
                    CONTROL_CHAR_PATTERN.test(cmd.command) ||
                    !Number.isSafeInteger(cmd.exit_code) ||
                    !Number.isSafeInteger(cmd.duration_ms) ||
                    cmd.duration_ms < 0
                ) {
                    throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} command record invalid`);
                }
            }

            if (!Array.isArray(e.details.blockers) || e.details.blockers.length > 256) {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} blockers invalid`);
            }

            if (e.status === 'PASSED') {
                if (
                    e.details.verdict !== 'PASSED' ||
                    e.details.blockers.length !== 0 ||
                    !e.details.commands.every((c) => c.exit_code === 0)
                ) {
                    throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} status PASSED inconsistent with details`);
                }
                hasPassed = true;
            } else if (e.status === 'FAILED') {
                if (e.details.verdict !== 'BLOCKED' || e.details.blockers.length === 0) {
                    throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} status FAILED inconsistent with details`);
                }
            } else {
                throw new DualQualityError('DUAL_QUALITY_CORRUPT_HISTORY', `Cycle ${cIndex} invalid aggregate status: ${e.status}`);
            }
        }
    }

    for (let pCycle = 1; pCycle < currentCycleIndex; pCycle++) {
        const pEvents = cycleEventsMap.get(pCycle);
        if (!pEvents || pEvents.length === 0) {
            throw new DualQualityError(
                'DUAL_QUALITY_PRIOR_CYCLE_NOT_PASSED',
                `Prior cycle ${pCycle} has no recorded events`
            );
        }
        const lastEvent = pEvents[pEvents.length - 1];
        if (lastEvent.status !== 'PASSED') {
            throw new DualQualityError(
                'DUAL_QUALITY_PRIOR_CYCLE_NOT_PASSED',
                `Prior cycle ${pCycle} final status is ${lastEvent.status}, not PASSED`
            );
        }
    }

    const currentEvents = cycleEventsMap.get(currentCycleIndex) || [];
    if (mode === 'record') {
        if (currentEvents.length > 0) {
            const lastCurrent = currentEvents[currentEvents.length - 1];
            if (lastCurrent.status === 'PASSED') {
                throw new DualQualityError(
                    'DUAL_QUALITY_CYCLE_ALREADY_PASSED',
                    `Cycle ${currentCycleIndex} has already PASSED and cannot be recorded again`
                );
            }
        }
    }

    return {
        priorAttempts: currentEvents.length,
    };
}

function createQualityLedger(options = {}) {
    if (!isStrictPlainObject(options)) {
        throw new DualQualityError('DUAL_QUALITY_INVALID_OPTIONS', 'Options must be a strict plain object');
    }
    validateExactKeys(options, ['authorityStore', 'readDiffFingerprint'], 'createQualityLedger options');
    validateRequiredKeys(options, ['authorityStore', 'readDiffFingerprint'], 'createQualityLedger options');

    const { authorityStore, readDiffFingerprint } = options;
    if (
        !authorityStore ||
        typeof authorityStore.derive !== 'function' ||
        typeof authorityStore.readEvents !== 'function' ||
        typeof authorityStore.append !== 'function'
    ) {
        throw new DualQualityError(
            'DUAL_QUALITY_INVALID_OPTIONS',
            'authorityStore must be provided with derive, readEvents, and append methods'
        );
    }
    if (typeof readDiffFingerprint !== 'function') {
        throw new DualQualityError(
            'DUAL_QUALITY_INVALID_OPTIONS',
            'readDiffFingerprint must be an injected synchronous function'
        );
    }

    function recordCycle(input) {
        if (!isStrictPlainObject(input)) {
            throw new DualQualityError('DUAL_QUALITY_INVALID_INPUT', 'Cycle input must be a strict plain object');
        }

        validateExactKeys(
            input,
            [
                'cycle_index',
                'total_tasks',
                'completed_task_ids',
                'plan_revision',
                'diff_fingerprint',
                'gate_results',
                'commands',
                'evidence_sha256',
                'attempt',
            ],
            'recordCycle input'
        );
        validateRequiredKeys(
            input,
            [
                'cycle_index',
                'total_tasks',
                'completed_task_ids',
                'plan_revision',
                'diff_fingerprint',
                'gate_results',
                'commands',
                'evidence_sha256',
                'attempt',
            ],
            'recordCycle input'
        );

        const cycleIndex = input.cycle_index;
        if (typeof cycleIndex !== 'number' || ![1, 2, 3].includes(cycleIndex)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_CYCLE_INDEX',
                `Invalid cycle_index: ${cycleIndex}. Must be 1, 2, or 3.`
            );
        }

        const totalTasks = input.total_tasks;
        if (
            typeof totalTasks !== 'number' ||
            !Number.isSafeInteger(totalTasks) ||
            totalTasks <= 0 ||
            totalTasks > MAX_REGISTERED_TASKS
        ) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_TOTAL_TASKS',
                `Invalid total_tasks: ${totalTasks}. Must be positive safe integer <= ${MAX_REGISTERED_TASKS}.`
            );
        }

        const completedTaskIds = input.completed_task_ids;
        if (!Array.isArray(completedTaskIds)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_TASKS',
                'completed_task_ids must be an array of task IDs'
            );
        }
        if (completedTaskIds.length > totalTasks) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_TASKS',
                `completed_task_ids count (${completedTaskIds.length}) cannot exceed total_tasks (${totalTasks})`
            );
        }

        const seenTaskIds = new Set();
        for (const taskId of completedTaskIds) {
            if (
                typeof taskId !== 'string' ||
                !TASK_ID_PATTERN.test(taskId) ||
                CONTROL_CHAR_PATTERN.test(taskId)
            ) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_TASKS',
                    `Invalid task ID in completed_task_ids: ${taskId}`
                );
            }
            if (seenTaskIds.has(taskId)) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_TASKS',
                    `Duplicate task ID in completed_task_ids: ${taskId}`
                );
            }
            seenTaskIds.add(taskId);
        }

        const planRevision = input.plan_revision;
        if (typeof planRevision !== 'number' || !Number.isSafeInteger(planRevision) || planRevision <= 0) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_PLAN_REVISION',
                `Invalid plan_revision: ${planRevision}`
            );
        }

        const diffFingerprint = input.diff_fingerprint;
        if (typeof diffFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(diffFingerprint)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_DIFF',
                'diff_fingerprint must be a lowercase 64-hex SHA-256 string'
            );
        }

        const evidenceSha256 = input.evidence_sha256;
        if (typeof evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceSha256)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_EVIDENCE_SHA',
                'evidence_sha256 must be a lowercase 64-hex SHA-256 string'
            );
        }

        const attempt = input.attempt;
        if (typeof attempt !== 'number' || ![1, 2, 3].includes(attempt)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_ATTEMPT',
                `Invalid attempt: ${attempt}. Must be 1, 2, or 3.`
            );
        }

        const rawGates = input.gate_results;
        if (!Array.isArray(rawGates)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_GATES',
                'gate_results must be an array'
            );
        }

        const rawCommands = input.commands;
        if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.length > 32) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_COMMANDS',
                'commands must be a non-empty array of at most 32 records'
            );
        }
        const validatedCommands = [];
        const commandBlockers = [];

        for (let i = 0; i < rawCommands.length; i++) {
            const c = rawCommands[i];
            if (!isStrictPlainObject(c)) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_COMMANDS',
                    `Command record at index ${i} is not a strict plain object`
                );
            }
            validateExactKeys(c, ['command', 'exit_code', 'duration_ms'], `command record at index ${i}`);
            validateRequiredKeys(c, ['command', 'exit_code', 'duration_ms'], `command record at index ${i}`);

            if (
                typeof c.command !== 'string' ||
                c.command.trim().length === 0 ||
                c.command.length > 256 ||
                CONTROL_CHAR_PATTERN.test(c.command)
            ) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_COMMANDS',
                    `Invalid command string at index ${i}`
                );
            }
            if (typeof c.exit_code !== 'number' || !Number.isSafeInteger(c.exit_code)) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_COMMANDS',
                    `Invalid exit_code at index ${i}: must be a safe integer`
                );
            }
            if (
                typeof c.duration_ms !== 'number' ||
                !Number.isSafeInteger(c.duration_ms) ||
                c.duration_ms < 0
            ) {
                throw new DualQualityError(
                    'DUAL_QUALITY_INVALID_COMMANDS',
                    `Invalid duration_ms at index ${i}: must be a nonnegative safe integer`
                );
            }

            if (c.exit_code !== 0) {
                commandBlockers.push({
                    id: `command-${i + 1}`,
                    required: true,
                    status: 'FAILED',
                    reason: `Command '${c.command}' exited with nonzero code ${c.exit_code}`,
                });
            }

            validatedCommands.push({
                command: c.command,
                exit_code: c.exit_code,
                duration_ms: c.duration_ms,
            });
        }

        // Validate derived authority state & task counts
        const derived = authorityStore.derive();
        if (!isStrictPlainObject(derived)) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_AUTHORITY_STATE',
                'Derived authority state is not a strict plain object'
            );
        }
        if (!Number.isSafeInteger(derived.planRevision) || derived.planRevision <= 0) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_AUTHORITY_STATE',
                'Derived planRevision must be a positive safe integer'
            );
        }
        if (!isStrictPlainObject(derived.plan)) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_AUTHORITY_STATE',
                'Derived plan is not a strict plain object'
            );
        }
        const derivedPlanTotal = derived.plan.totalTasks ?? derived.plan.total_tasks;
        if (!Number.isSafeInteger(derivedPlanTotal) || derivedPlanTotal <= 0) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_AUTHORITY_STATE',
                'Derived plan totalTasks is invalid'
            );
        }
        if (
            derived.plan.totalTasks !== undefined &&
            derived.plan.total_tasks !== undefined &&
            derived.plan.totalTasks !== derived.plan.total_tasks
        ) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_AUTHORITY_STATE',
                'Derived plan totalTasks mismatch with total_tasks'
            );
        }
        if (!isStrictPlainObject(derived.tasks)) {
            throw new DualQualityError(
                'DUAL_QUALITY_CORRUPT_AUTHORITY_STATE',
                'Derived tasks is not a strict plain object'
            );
        }

        const ownTaskKeys = Object.keys(derived.tasks).filter(
            (k) => Object.prototype.hasOwnProperty.call(derived.tasks, k)
        );
        const registeredTaskCount = ownTaskKeys.length;

        if (totalTasks !== derivedPlanTotal || totalTasks !== registeredTaskCount) {
            throw new DualQualityError(
                'DUAL_QUALITY_TOTAL_TASKS_MISMATCH',
                `total_tasks mismatch: input=${totalTasks}, derived.plan=${derivedPlanTotal}, registered tasks=${registeredTaskCount}`
            );
        }

        if (derived.planRevision !== planRevision) {
            throw new DualQualityError(
                'DUAL_QUALITY_PLAN_REVISION_MISMATCH',
                `Plan revision mismatch: expected ${derived.planRevision}, got ${planRevision}`
            );
        }

        for (const taskId of completedTaskIds) {
            if (!Object.prototype.hasOwnProperty.call(derived.tasks, taskId)) {
                throw new DualQualityError(
                    'DUAL_QUALITY_UNVERIFIED_TASK',
                    `Task ${taskId} is not an own registered task in derived state`
                );
            }
            const task = derived.tasks[taskId];
            if (!isStrictPlainObject(task) || task.state !== 'TASK_VERIFIED') {
                throw new DualQualityError(
                    'DUAL_QUALITY_UNVERIFIED_TASK',
                    `Task ${taskId} is not TASK_VERIFIED in authority state`
                );
            }
        }

        // Check task count against threshold
        const thresholds = cycleThresholds(totalTasks);
        const requiredThreshold = thresholds[cycleIndex - 1];
        if (completedTaskIds.length < requiredThreshold) {
            throw new DualQualityError(
                'DUAL_QUALITY_INSUFFICIENT_TASKS',
                `Insufficient completed tasks for cycle ${cycleIndex}: required ${requiredThreshold}, got ${completedTaskIds.length}`
            );
        }

        // Check diff fingerprint
        const freshDiff = readDiffFingerprint();
        if (typeof freshDiff !== 'string' || !/^[0-9a-f]{64}$/.test(freshDiff)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_DIFF',
                'readDiffFingerprint() did not return a valid lowercase 64-hex SHA-256'
            );
        }
        if (diffFingerprint !== freshDiff) {
            throw new DualQualityError(
                'DUAL_QUALITY_DIFF_MISMATCH',
                `Diff fingerprint mismatch: fresh diff is ${freshDiff}, input got ${diffFingerprint}`
            );
        }

        // History validation (Review 3 Findings 1 & 2)
        const allEvents = authorityStore.readEvents();
        const { priorAttempts } = validateQualityHistory(
            allEvents,
            cycleIndex,
            totalTasks,
            planRevision,
            derived.tasks
        );

        if (priorAttempts >= 3) {
            throw new DualQualityError(
                'DUAL_QUALITY_MAX_ATTEMPTS_EXCEEDED',
                `Cycle ${cycleIndex} has reached the maximum of 3 attempts`
            );
        }

        const expectedAttempt = priorAttempts + 1;
        if (attempt !== expectedAttempt) {
            throw new DualQualityError(
                'DUAL_QUALITY_NON_MONOTONIC_ATTEMPT',
                `Monotonic attempt mismatch for cycle ${cycleIndex}: expected attempt ${expectedAttempt}, got ${attempt}`
            );
        }

        // Evaluate gates and commands
        const evalResult = evaluateMandatoryGates(rawGates);
        const combinedBlockers = [...evalResult.blockers, ...commandBlockers];
        const verdict = combinedBlockers.length === 0 ? 'PASSED' : 'BLOCKED';
        const aggregateStatus = verdict === 'PASSED' ? 'PASSED' : 'FAILED';
        const reason = verdict === 'PASSED'
            ? `Quality cycle ${cycleIndex} passed (attempt ${attempt})`
            : `Quality cycle ${cycleIndex} failed (attempt ${attempt}): ${combinedBlockers.length} blocker(s)`;

        const gateId = `quality-cycle-${cycleIndex}`;
        const eventPayload = {
            type: 'gate.result',
            gate_id: gateId,
            status: aggregateStatus,
            cycle_index: cycleIndex,
            details: {
                required: true,
                cycle_index: cycleIndex,
                attempt,
                threshold: requiredThreshold,
                total_tasks: totalTasks,
                completed_task_ids: [...completedTaskIds],
                plan_revision: planRevision,
                diff_fingerprint: diffFingerprint,
                commands: validatedCommands,
                verdict,
                blockers: combinedBlockers,
            },
            evidence_sha256: evidenceSha256,
            reason,
        };

        const ack = authorityStore.append(eventPayload);

        if (!isStrictPlainObject(ack)) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_APPEND_ACK',
                'Authority store append did not return a valid event object acknowledgement',
                { ack }
            );
        }

        if (
            ack.type !== 'gate.result' ||
            ack.gate_id !== eventPayload.gate_id ||
            ack.status !== eventPayload.status ||
            ack.cycle_index !== eventPayload.cycle_index ||
            ack.reason !== eventPayload.reason ||
            ack.evidence_sha256 !== eventPayload.evidence_sha256 ||
            !isStrictPlainObject(ack.details) ||
            ack.details.attempt !== eventPayload.details.attempt ||
            ack.details.plan_revision !== eventPayload.details.plan_revision ||
            ack.details.diff_fingerprint !== eventPayload.details.diff_fingerprint ||
            ack.details.verdict !== eventPayload.details.verdict
        ) {
            throw new DualQualityError(
                'DUAL_QUALITY_INVALID_APPEND_ACK',
                'Authority store append acknowledgement fields mismatch requested event',
                { requested: eventPayload, acknowledged: ack }
            );
        }

        return {
            event: ack,
            verdict,
            status: aggregateStatus,
            blockers: combinedBlockers,
            attempt,
        };
    }

    return {
        recordCycle,
    };
}

function evaluateQualityCompletion(options = {}) {
    if (!isStrictPlainObject(options)) {
        throw new DualQualityError('DUAL_QUALITY_INVALID_OPTIONS', 'Options must be a strict plain object');
    }
    validateExactKeys(options, ['allEvents', 'totalTasks', 'planRevision', 'diffFingerprint', 'derivedTasks'], 'evaluateQualityCompletion options');
    validateRequiredKeys(options, ['allEvents', 'totalTasks', 'planRevision', 'diffFingerprint', 'derivedTasks'], 'evaluateQualityCompletion options');

    const { allEvents, totalTasks, planRevision, diffFingerprint, derivedTasks } = options;

    if (!Array.isArray(allEvents)) {
        return {
            passed: false,
            blockers: ['QUALITY_LEDGER_MISSING: Authority event log is missing or invalid'],
        };
    }

    if (typeof totalTasks !== 'number' || !Number.isSafeInteger(totalTasks) || totalTasks <= 0) {
        return {
            passed: false,
            blockers: ['QUALITY_TOTAL_TASKS_INVALID: Plan total_tasks is missing or invalid'],
        };
    }

    const blockers = [];
    let thresholds;
    try {
        thresholds = cycleThresholds(totalTasks);
    } catch (err) {
        return {
            passed: false,
            blockers: [`QUALITY_TOTAL_TASKS_INVALID: ${err.message}`],
        };
    }

    const qualityEventsMap = new Map();
    for (const ev of allEvents) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'gate.result' && typeof ev.gate_id === 'string' && ev.gate_id.startsWith('quality-cycle-')) {
            const match = /^quality-cycle-([1-3])$/.exec(ev.gate_id);
            if (match) {
                const cIdx = Number(match[1]);
                if (!qualityEventsMap.has(cIdx)) {
                    qualityEventsMap.set(cIdx, []);
                }
                qualityEventsMap.get(cIdx).push(ev);
            }
        }
    }

    // Require all 3 cycles
    for (let c = 1; c <= 3; c++) {
        const events = qualityEventsMap.get(c);
        if (!events || events.length === 0) {
            blockers.push(`QUALITY_CYCLE_MISSING: Quality cycle ${c} has not been recorded`);
            continue;
        }

        const lastEv = events[events.length - 1];
        if (lastEv.status !== 'PASSED') {
            blockers.push(`QUALITY_CYCLE_UNMET: Quality cycle ${c} status is ${lastEv.status}, not PASSED`);
            continue;
        }

        const details = lastEv.details || {};
        if (details.plan_revision !== planRevision) {
            blockers.push(`QUALITY_CYCLE_STALE: Quality cycle ${c} plan revision (${details.plan_revision}) does not match current plan revision (${planRevision})`);
        }
        if (details.total_tasks !== totalTasks) {
            blockers.push(`QUALITY_CYCLE_STALE: Quality cycle ${c} total tasks (${details.total_tasks}) does not match current total tasks (${totalTasks})`);
        }
        if (details.threshold !== thresholds[c - 1]) {
            blockers.push(`QUALITY_CYCLE_THRESHOLD_MISMATCH: Quality cycle ${c} threshold (${details.threshold}) does not match expected (${thresholds[c - 1]})`);
        }
        if (diffFingerprint && details.diff_fingerprint && details.diff_fingerprint !== diffFingerprint) {
            blockers.push(`QUALITY_CYCLE_FINGERPRINT_MISMATCH: Quality cycle ${c} diff fingerprint (${details.diff_fingerprint}) does not match current workspace diff fingerprint (${diffFingerprint})`);
        }
        if (Array.isArray(details.commands)) {
            for (const cmd of details.commands) {
                if (cmd.exit_code !== 0) {
                    blockers.push(`QUALITY_CYCLE_COMMAND_FAILED: Quality cycle ${c} command '${cmd.command}' failed with exit code ${cmd.exit_code}`);
                }
            }
        }
    }

    if (blockers.length === 0) {
        try {
            validateQualityHistory(allEvents, 3, totalTasks, planRevision, derivedTasks, 'evaluate');
        } catch (err) {
            blockers.push(`QUALITY_HISTORY_CORRUPT: ${err.message}`);
        }
    }

    return {
        passed: blockers.length === 0,
        blockers,
    };
}

module.exports = {
    cycleThresholds,
    evaluateMandatoryGates,
    evaluateQualityCompletion,
    createQualityLedger,
    DualQualityError,
};
