'use strict';

const REQUIRED_VIEWPORT_WIDTHS = Object.freeze([390, 768, 1024, 1440]);
const ALLOWED_RUNTIME_STATUSES = new Set(['AVAILABLE', 'UNAVAILABLE', 'BLOCKED']);
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const GATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class DualUiGateError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualUiGateError';
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
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_KEY',
                `Unexpected key '${key}' in ${label}`
            );
        }
    }
}

function validateRequiredKeys(obj, requiredKeyList, label) {
    for (const key of requiredKeyList) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            throw new DualUiGateError(
                'DUAL_UI_GATE_MISSING_KEY',
                `Missing required key '${key}' in ${label}`
            );
        }
    }
}

function evaluateUiEvidence(requirement, evidence) {
    if (!isStrictPlainObject(requirement)) {
        throw new DualUiGateError('DUAL_UI_GATE_INVALID_REQUIREMENT', 'Requirement must be a strict plain object');
    }
    if (!isStrictPlainObject(evidence)) {
        throw new DualUiGateError('DUAL_UI_GATE_INVALID_EVIDENCE', 'Evidence must be a strict plain object');
    }

    validateExactKeys(
        requirement,
        ['gate_id', 'required', 'viewport_widths', 'reduced_motion_required'],
        'requirement'
    );
    validateRequiredKeys(
        requirement,
        ['gate_id', 'required', 'viewport_widths', 'reduced_motion_required'],
        'requirement'
    );

    const gateId = requirement.gate_id;
    if (typeof gateId !== 'string' || !GATE_ID_PATTERN.test(gateId) || CONTROL_CHAR_PATTERN.test(gateId)) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_REQUIREMENT',
            'Requirement gate_id must be a non-empty string <= 128 chars without control characters'
        );
    }

    if (typeof requirement.required !== 'boolean') {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_REQUIREMENT',
            'Requirement required must be a boolean'
        );
    }

    const rawViewportWidths = requirement.viewport_widths;
    if (
        !Array.isArray(rawViewportWidths) ||
        rawViewportWidths.length !== REQUIRED_VIEWPORT_WIDTHS.length ||
        !REQUIRED_VIEWPORT_WIDTHS.every((w, i) => rawViewportWidths[i] === w)
    ) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_REQUIREMENT',
            `Requirement viewport_widths must be exactly [${REQUIRED_VIEWPORT_WIDTHS.join(', ')}]`
        );
    }

    if (requirement.reduced_motion_required !== true) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_REQUIREMENT',
            'Requirement reduced_motion_required must literally be boolean true'
        );
    }

    if (typeof evidence.runtime_status !== 'string' || !ALLOWED_RUNTIME_STATUSES.has(evidence.runtime_status)) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_EVIDENCE',
            `Invalid runtime_status '${evidence.runtime_status}'. Expected AVAILABLE, UNAVAILABLE, or BLOCKED`
        );
    }

    const runtimeStatus = evidence.runtime_status;

    if (runtimeStatus === 'AVAILABLE') {
        validateExactKeys(
            evidence,
            ['runtime_status', 'evidence_sha256', 'viewports', 'reduced_motion', 'reason'],
            'available runtime evidence'
        );
        validateRequiredKeys(
            evidence,
            ['runtime_status', 'evidence_sha256', 'viewports', 'reduced_motion'],
            'available runtime evidence'
        );
    } else {
        validateExactKeys(
            evidence,
            ['runtime_status', 'evidence_sha256', 'reason'],
            `${runtimeStatus} runtime evidence`
        );
        validateRequiredKeys(
            evidence,
            ['runtime_status', 'evidence_sha256'],
            `${runtimeStatus} runtime evidence`
        );
    }

    const evidenceSha256 = evidence.evidence_sha256;
    if (typeof evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceSha256)) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_EVIDENCE',
            'Evidence evidence_sha256 must be a lowercase 64-hex SHA-256 string'
        );
    }

    if (evidence.reason !== undefined) {
        if (
            typeof evidence.reason !== 'string' ||
            evidence.reason.trim().length === 0 ||
            evidence.reason.length > 256 ||
            CONTROL_CHAR_PATTERN.test(evidence.reason)
        ) {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                'Evidence reason must be a non-empty string <= 256 chars without control characters'
            );
        }
    }

    if (runtimeStatus === 'UNAVAILABLE') {
        const status = requirement.required ? 'UNAVAILABLE' : 'OPTIONAL_SKIPPED';
        const defaultReason = requirement.required
            ? 'Required UI browser runtime is unavailable or failed to start'
            : 'Optional UI gate skipped because browser runtime is unavailable';
        const reason = evidence.reason || defaultReason;

        return {
            gate_id: gateId,
            status,
            reason,
            details: {
                required: requirement.required,
                viewport_widths: [...REQUIRED_VIEWPORT_WIDTHS],
                reduced_motion_required: true,
                runtime_status: 'UNAVAILABLE',
            },
            evidence_sha256: evidenceSha256,
        };
    }

    if (runtimeStatus === 'BLOCKED') {
        const reason = evidence.reason || 'UI gate execution blocked by external prerequisite';
        return {
            gate_id: gateId,
            status: 'BLOCKED',
            reason,
            details: {
                required: requirement.required,
                viewport_widths: [...REQUIRED_VIEWPORT_WIDTHS],
                reduced_motion_required: true,
                runtime_status: 'BLOCKED',
            },
            evidence_sha256: evidenceSha256,
        };
    }

    // runtimeStatus === 'AVAILABLE'
    const rawViewports = evidence.viewports;
    if (!Array.isArray(rawViewports) || rawViewports.length !== REQUIRED_VIEWPORT_WIDTHS.length) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_EVIDENCE',
            `Evidence viewports must be an array of ${REQUIRED_VIEWPORT_WIDTHS.length} records`
        );
    }

    const seenWidths = new Set();
    const failures = [];
    const viewportsSummary = [];

    for (let i = 0; i < rawViewports.length; i++) {
        const v = rawViewports[i];
        if (!isStrictPlainObject(v)) {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                `Viewport record at index ${i} is not a strict plain object`
            );
        }

        validateExactKeys(v, ['width', 'passed', 'horizontal_overflow'], `viewport record at index ${i}`);
        validateRequiredKeys(v, ['width', 'passed', 'horizontal_overflow'], `viewport record at index ${i}`);

        if (typeof v.width !== 'number' || !REQUIRED_VIEWPORT_WIDTHS.includes(v.width)) {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                `Invalid viewport width ${v.width} at index ${i}`
            );
        }
        if (seenWidths.has(v.width)) {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                `Duplicate viewport width ${v.width} at index ${i}`
            );
        }
        seenWidths.add(v.width);

        if (typeof v.passed !== 'boolean') {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                `Viewport record ${v.width}px passed must be boolean`
            );
        }
        if (typeof v.horizontal_overflow !== 'boolean') {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                `Viewport record ${v.width}px horizontal_overflow must be boolean`
            );
        }

        if (v.horizontal_overflow) {
            failures.push(`Horizontal overflow detected at width ${v.width}px`);
        }
        if (!v.passed) {
            failures.push(`Viewport assertion failed at width ${v.width}px`);
        }

        viewportsSummary.push({
            width: v.width,
            passed: v.passed && !v.horizontal_overflow,
            horizontal_overflow: v.horizontal_overflow,
        });
    }

    for (const expectedWidth of REQUIRED_VIEWPORT_WIDTHS) {
        if (!seenWidths.has(expectedWidth)) {
            throw new DualUiGateError(
                'DUAL_UI_GATE_INVALID_EVIDENCE',
                `Missing required viewport width: ${expectedWidth}px`
            );
        }
    }

    const rm = evidence.reduced_motion;
    if (!isStrictPlainObject(rm)) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_EVIDENCE',
            'Evidence reduced_motion must be a strict plain object'
        );
    }
    validateExactKeys(rm, ['tested', 'passed'], 'reduced_motion');
    validateRequiredKeys(rm, ['tested', 'passed'], 'reduced_motion');

    if (typeof rm.tested !== 'boolean') {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_EVIDENCE',
            'Evidence reduced_motion tested must be boolean'
        );
    }
    if (typeof rm.passed !== 'boolean') {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_EVIDENCE',
            'Evidence reduced_motion passed must be boolean'
        );
    }

    if (!rm.tested) {
        failures.push('Reduced motion was not tested');
    }
    if (!rm.passed) {
        failures.push('Reduced motion verification failed');
    }

    if (failures.length > 0) {
        return {
            gate_id: gateId,
            status: 'FAILED',
            reason: `UI gate failed: ${failures.join('; ')}`.slice(0, 256),
            details: {
                required: requirement.required,
                viewport_widths: [...REQUIRED_VIEWPORT_WIDTHS],
                reduced_motion_required: true,
                runtime_status: 'AVAILABLE',
                viewports_summary: viewportsSummary,
                reduced_motion_passed: rm.tested && rm.passed,
                failures: failures.slice(0, 8),
            },
            evidence_sha256: evidenceSha256,
        };
    }

    return {
        gate_id: gateId,
        status: 'PASSED',
        reason: evidence.reason || 'UI gate passed across all required viewports (390, 768, 1024, 1440) and reduced-motion',
        details: {
            required: requirement.required,
            viewport_widths: [...REQUIRED_VIEWPORT_WIDTHS],
            reduced_motion_required: true,
            runtime_status: 'AVAILABLE',
            viewports_summary: viewportsSummary,
            reduced_motion_passed: true,
        },
        evidence_sha256: evidenceSha256,
    };
}

function recordUiEvidence(options = {}) {
    if (!isStrictPlainObject(options)) {
        throw new DualUiGateError('DUAL_UI_GATE_INVALID_OPTIONS', 'Options must be a strict plain object');
    }
    validateExactKeys(options, ['authorityStore', 'requirement', 'evidence'], 'recordUiEvidence options');
    validateRequiredKeys(options, ['authorityStore', 'requirement', 'evidence'], 'recordUiEvidence options');

    const { authorityStore, requirement, evidence } = options;
    if (!authorityStore || typeof authorityStore.append !== 'function') {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_STORE',
            'authorityStore must be provided with an append method'
        );
    }

    const gateResult = evaluateUiEvidence(requirement, evidence);

    const eventPayload = {
        type: 'gate.result',
        gate_id: gateResult.gate_id,
        status: gateResult.status,
        reason: gateResult.reason,
        details: gateResult.details,
        evidence_sha256: gateResult.evidence_sha256,
    };

    const ack = authorityStore.append(eventPayload);

    if (!isStrictPlainObject(ack)) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_APPEND_ACK',
            'Authority store append did not return a valid event object acknowledgement',
            { ack }
        );
    }

    if (
        ack.type !== 'gate.result' ||
        ack.gate_id !== eventPayload.gate_id ||
        ack.status !== eventPayload.status ||
        ack.reason !== eventPayload.reason ||
        ack.evidence_sha256 !== eventPayload.evidence_sha256 ||
        !isStrictPlainObject(ack.details) ||
        ack.details.required !== eventPayload.details.required ||
        ack.details.runtime_status !== eventPayload.details.runtime_status
    ) {
        throw new DualUiGateError(
            'DUAL_UI_GATE_INVALID_APPEND_ACK',
            'Authority store append acknowledgement fields mismatch requested event',
            { requested: eventPayload, acknowledged: ack }
        );
    }

    return ack;
}

module.exports = {
    evaluateUiEvidence,
    recordUiEvidence,
    DualUiGateError,
    REQUIRED_VIEWPORT_WIDTHS,
};
