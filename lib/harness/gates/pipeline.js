'use strict';

// ---------------------------------------------------------------------------
// Quality gate pipeline (HARNESS-SPEC-PHASE-1 §2.4).
//
// Runs in strict priority order, blocking. Pha 1 implements P1 lint / P2 build
// / P3 test via build-test.runGateCommand; P0 security, P4 bundle, P5 content
// are placeholders (status 'skipped') until Pha 2. Source rules:
// templates/workflows/qa-testing.md + validation-scripts.md.
// ---------------------------------------------------------------------------

const { runGateCommand } = require('../tools/build-test');

// id → { name, kind|null }. kind null = placeholder gate (skipped in Pha 1).
const GATES = [
    { id: 'P0', name: 'security', kind: null },
    { id: 'P1', name: 'lint', kind: 'lint' },
    { id: 'P2', name: 'build', kind: 'build' },
    { id: 'P3', name: 'test', kind: 'test' },
    { id: 'P4', name: 'bundle', kind: null },
    { id: 'P5', name: 'content', kind: null },
];

// runGate injectable for tests. `only` = array/string of ids to restrict to.
function runPipeline(projectDir, { only = null, runGate = runGateCommand } = {}) {
    const allow = only ? new Set([].concat(only).map((s) => String(s).toUpperCase())) : null;
    const results = [];
    const failures = [];

    for (const gate of GATES) {
        if (allow && !allow.has(gate.id)) continue;

        if (!gate.kind) {
            results.push({ id: gate.id, name: gate.name, status: 'skipped', output: 'placeholder (Pha 2)', durationMs: 0 });
            continue;
        }
        const r = runGate(projectDir, gate.kind);
        if (!r.ran) {
            results.push({ id: gate.id, name: gate.name, status: 'skipped', output: r.output, durationMs: r.durationMs || 0 });
            continue;
        }
        const status = r.passed ? 'pass' : 'fail';
        if (status === 'fail') failures.push(gate.id);
        results.push({ id: gate.id, name: gate.name, status, output: r.output, durationMs: r.durationMs || 0 });
    }

    return { passed: failures.length === 0, results, failures };
}

module.exports = { runPipeline, GATES };
