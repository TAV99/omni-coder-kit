'use strict';

const { parseContract } = require('./contracts');

class DualAgyOutputError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'DualAgyOutputError';
        this.code = code;
    }
}

function parseJson(value, code) {
    try {
        return JSON.parse(value);
    } catch (cause) {
        throw new DualAgyOutputError(code, 'Agy returned malformed JSON', { cause });
    }
}

function validatePayload(candidate, schema) {
    try {
        return parseContract(schema, candidate, 'Agy payload');
    } catch (cause) {
        throw new DualAgyOutputError(
            'DUAL_AGY_CONTRACT_INVALID',
            'Agy payload does not satisfy the required contract',
            { cause },
        );
    }
}

function extractFencedJson(response) {
    const match = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return match ? match[1] : null;
}

function extractAgyPayload({ exitCode, stdout }, schema) {
    if (exitCode !== 0) {
        throw new DualAgyOutputError('DUAL_AGY_EXIT_NONZERO', 'Agy process exited unsuccessfully');
    }
    if (typeof stdout !== 'string' || stdout.trim().length === 0) {
        throw new DualAgyOutputError('DUAL_AGY_EMPTY_OUTPUT', 'Agy process returned empty output');
    }

    const envelope = parseJson(stdout.trim(), 'DUAL_AGY_OUTPUT_MALFORMED');
    const warnings = [];
    let candidate;
    let extractionMode;

    if (envelope && typeof envelope === 'object' && envelope.structured_output !== undefined) {
        candidate = envelope.structured_output;
        extractionMode = 'structured_output';
        if (envelope.status === 'error') warnings.push('outer_error_valid_payload');
    } else if (envelope && typeof envelope.response === 'string') {
        try {
            candidate = JSON.parse(envelope.response);
            extractionMode = 'response_json';
            warnings.push('response_json');
        } catch {
            const fenced = extractFencedJson(envelope.response);
            if (fenced === null) {
                throw new DualAgyOutputError(
                    'DUAL_AGY_OUTPUT_MALFORMED',
                    'Agy response did not contain an extractable JSON payload',
                );
            }
            candidate = parseJson(fenced, 'DUAL_AGY_OUTPUT_MALFORMED');
            extractionMode = 'legacy_fenced_json';
            warnings.push('legacy_fenced_json');
        }
    } else {
        throw new DualAgyOutputError(
            'DUAL_AGY_OUTPUT_MALFORMED',
            'Agy output did not contain a supported payload field',
        );
    }

    return {
        payload: validatePayload(candidate, schema),
        extractionMode,
        warnings,
    };
}

module.exports = {
    DualAgyOutputError,
    extractAgyPayload,
};
