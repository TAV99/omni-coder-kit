'use strict';

// Shared shape for runtime parseResult() (SPEC-SQUAD-P3 §4.1). A parser reads one
// finished headless turn ({ exitCode, stdout, stderr, timedOut }) and never throws.

function parseJsonObject(text) {
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

// Applies the checks every runtime shares, in order of severity, once the
// runtime-specific fields are read. `turn` is what the CLI itself reported.
function settle(raw, turn, { expectedSchema } = {}) {
    const base = {
        payload: turn.payload ?? null,
        sessionRef: turn.sessionRef ?? null,
        deniedActions: turn.deniedActions || [],
        usage: turn.usage ?? null,
    };
    const fail = (errorCode) => ({ completion: 'failed', ...base, errorCode });
    if (raw.timedOut) return fail('SQUAD_RUNTIME_TIMEOUT');
    if (raw.exitCode !== 0) return fail('SQUAD_RUNTIME_EXIT_NONZERO');
    if (turn.malformed) return fail('SQUAD_RUNTIME_OUTPUT_MALFORMED');
    if (turn.status === 'failed') return fail('SQUAD_RUNTIME_TURN_FAILED');
    // Q5: a denied tool call means the turn did not do what it was asked, even on SUCCESS.
    if (base.deniedActions.length > 0) return fail('SQUAD_RUNTIME_DENIED_ACTIONS');
    if (turn.status !== 'succeeded') return { completion: 'unknown', ...base, errorCode: 'SQUAD_RUNTIME_TURN_UNFINISHED' };
    if (expectedSchema) {
        if (base.payload === null) return fail('SQUAD_RUNTIME_NO_PAYLOAD');
        if (typeof expectedSchema.safeParse === 'function' && !expectedSchema.safeParse(base.payload).success) {
            return fail('SQUAD_RUNTIME_PAYLOAD_INVALID');
        }
    }
    return { completion: 'succeeded', ...base, errorCode: null };
}

module.exports = { parseJsonObject, settle };
