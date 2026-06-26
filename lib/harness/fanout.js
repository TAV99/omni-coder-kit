'use strict';

// ---------------------------------------------------------------------------
// Parallel fan-out (HARNESS-SPEC-PHASE-2 §2d; orchestration-patterns Pattern 3).
//
// Run N independent "lenses" concurrently on the same input and return their
// reports. The MERGE happens in the loop (depth = 1) — a lens NEVER spawns
// another lens (anti-pattern B/D). This is just the bounded-concurrency runner.
// ---------------------------------------------------------------------------

// lenses: [{ name, step, persona }]; runner(lens) → { lens, ok, findings, durationMs }
async function fanout(lenses, runner, { concurrency = 3 } = {}) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, lenses.length) }, async () => {
        while (next < lenses.length) {
            const idx = next++;
            const lens = lenses[idx];
            try {
                results[idx] = await runner(lens);
            } catch (e) {
                results[idx] = { lens: lens.name, ok: false, findings: [String((e && e.message) || e)], durationMs: 0 };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

// Default quality lenses (addyosmani agent personas, ADOPT T2.3) — distinct
// failure modes, each its own context/model. step drives claude-sdk model pick.
const CHECK_LENSES = Object.freeze([
    { name: 'code-review', step: 'check', persona: 'code-reviewer' },
    { name: 'security', step: 'security', persona: 'security-auditor' },
    { name: 'test', step: 'test', persona: 'test-engineer' },
]);

module.exports = { fanout, CHECK_LENSES };
