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
    maxAcceptanceRounds: 3,   // Phase-4: max ACCEPTANCE → COOK/FIX rounds before BLOCKED
    maxCostUsd: 5,            // token cost ceiling (Pha 2c — claude-sdk provider)
    maxTokens: null,          // optional total-token ceiling (null = no limit)
});

function createBudget(overrides = {}) {
    const b = { ...DEFAULT_BUDGET, ...overrides };
    for (const k of ['maxIterations', 'maxWallclockMs', 'maxFixAttempts', 'maxAcceptanceRounds', 'maxCostUsd']) {
        if (typeof b[k] !== 'number' || b[k] <= 0) {
            throw new Error(`budget.${k} phải là số dương`);
        }
    }
    if (b.maxTokens != null && (typeof b.maxTokens !== 'number' || b.maxTokens <= 0)) {
        throw new Error('budget.maxTokens phải là số dương hoặc null');
    }
    return b;
}

// Accumulate token/cost usage onto the state (Pha 2c). Tolerates first-call
// undefined accumulators. Mutates + returns state.
function addUsage(state, usage = {}) {
    const tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
    state.tokens = (state.tokens || 0) + tokens;
    state.costUsd = (state.costUsd || 0) + (usage.costUsd || 0);
    return state;
}

// Decide whether to stop. `elapsedMs` is required for wallclock limit check, defaulting to 0.
function checkBudget(state, budget = DEFAULT_BUDGET, { elapsedMs } = {}) {
    const elapsed = typeof elapsedMs === 'number' ? elapsedMs : 0;

    if (state.iterations >= budget.maxIterations) {
        return { stop: true, reason: `Đạt giới hạn ${budget.maxIterations} iterations` };
    }
    if (elapsed >= budget.maxWallclockMs) {
        return { stop: true, reason: `Đạt giới hạn thời gian phiên (${Math.round(budget.maxWallclockMs / 60000)} phút) — chạy 'omni run --resume' để cấp lại thời gian` };
    }
    if (state.fixAttempts >= budget.maxFixAttempts) {
        return { stop: true, reason: `Đạt giới hạn ${budget.maxFixAttempts} lần fix trong cycle ${state.cycle} → escalate BLOCKED` };
    }
    if (budget.maxCostUsd != null && (state.costUsd || 0) >= budget.maxCostUsd) {
        return { stop: true, reason: `Đạt giới hạn chi phí $${budget.maxCostUsd}` };
    }
    if (budget.maxTokens != null && (state.tokens || 0) >= budget.maxTokens) {
        return { stop: true, reason: `Đạt giới hạn ${budget.maxTokens} tokens` };
    }
    return { stop: false, reason: null };
}

module.exports = { DEFAULT_BUDGET, createBudget, checkBudget, addUsage };
