'use strict';

// ---------------------------------------------------------------------------
// Budget & stop conditions (HARNESS-UPGRADE-PLAN §4.1 budget.js, §7 risk).
//
// Hard ceilings so the loop can never "run hoang". Pha 0 wires iteration /
// wallclock / fix-attempt limits; token/cost limits land with the provider
// adapter in Pha 2.
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET = Object.freeze({
    maxIterations: 60,        // total state transitions
    maxWallclockMs: 30 * 60 * 1000, // 30 min
    maxFixAttempts: 3,        // per COOK→CHECK cycle (matches superpower-sdlc)
});

function createBudget(overrides = {}) {
    const b = { ...DEFAULT_BUDGET, ...overrides };
    for (const k of ['maxIterations', 'maxWallclockMs', 'maxFixAttempts']) {
        if (typeof b[k] !== 'number' || b[k] <= 0) {
            throw new Error(`budget.${k} phải là số dương`);
        }
    }
    return b;
}

// Decide whether to stop. `elapsedMs` defaults to now − state.startedAt.
function checkBudget(state, budget = DEFAULT_BUDGET, { elapsedMs } = {}) {
    const elapsed = typeof elapsedMs === 'number'
        ? elapsedMs
        : (state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0);

    if (state.iterations >= budget.maxIterations) {
        return { stop: true, reason: `Đạt giới hạn ${budget.maxIterations} iterations` };
    }
    if (elapsed >= budget.maxWallclockMs) {
        return { stop: true, reason: `Đạt giới hạn thời gian ${Math.round(budget.maxWallclockMs / 60000)} phút` };
    }
    if (state.fixAttempts >= budget.maxFixAttempts) {
        return { stop: true, reason: `Đạt giới hạn ${budget.maxFixAttempts} lần fix trong cycle ${state.cycle} → escalate BLOCKED` };
    }
    return { stop: false, reason: null };
}

module.exports = { DEFAULT_BUDGET, createBudget, checkBudget };
