'use strict';

// agy effort rules, verified against agy 1.4.12 (SPEC-SQUAD-P2 appendix V10, §6.6).
// Shared by the agy adapter and dual's worker configuration (SPEC-SQUAD-P3 H7).

const { SquadRuntimeError } = require('./contract');

const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// A level suffix (`gemini-3.8-flash-high`) fixes the effort: agy rejects any
// other --effort with "conflicts with --effort", so the adapter omits the flag
// for suffixed ids. Claude models via agy reject --effort entirely.
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join('|')})$`);

function suffixEffort(modelId) {
    const match = EFFORT_SUFFIX.exec(modelId);
    return match ? match[1] : null;
}

const rejectsEffort = (modelId) => /^claude-/i.test(modelId);

function modelEfforts(modelId) {
    const suffix = suffixEffort(modelId);
    return suffix ? { efforts: [suffix], defaultEffort: suffix } : { efforts: null, defaultEffort: null };
}

// Why agy would refuse this model/effort pair, or null when it would run.
function effortConflict(model, effort) {
    const suffix = suffixEffort(model);
    if (suffix && effort !== undefined && effort !== suffix) {
        return `agy model ${model} already fixes effort "${suffix}"; effort "${effort}" would be rejected`;
    }
    if (!suffix && effort !== undefined && rejectsEffort(model)) return `agy does not accept --effort for ${model}`;
    return null;
}

function effortArgs(model, effort) {
    const conflict = effortConflict(model, effort);
    if (conflict) throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', conflict);
    return effort !== undefined && !suffixEffort(model) ? ['--effort', effort] : [];
}

module.exports = { EFFORTS, suffixEffort, rejectsEffort, modelEfforts, effortConflict, effortArgs };
