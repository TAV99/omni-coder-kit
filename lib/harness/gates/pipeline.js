'use strict';

// ---------------------------------------------------------------------------
// Quality gate pipeline (HARNESS-SPEC-PHASE-1 §2.4 + PHASE-2 §2a).
//
// Strict priority order, blocking. P1 lint / P2 build / P3 test via
// build-test.runGateCommand; P0 security, P4 bundle, P5 content via dedicated
// handlers. Blocking policy: P0 + P1–P3 + P5-HIGH block (→ failures);
// P4 (bundle) and P5-LOW/MEDIUM are advisory (in results, not failures).
// Source rules: templates/workflows/qa-testing.md + validation-scripts.md.
// ---------------------------------------------------------------------------

const { runGateCommand } = require('../tools/build-test');
const { runSecurity } = require('./security');
const { runBundle } = require('./bundle');
const { runContent } = require('./content');

// kind → build-test command gate (blocking). handler → dedicated gate fn.
const GATES = [
    { id: 'P0', name: 'security', handler: 'security', blocking: true },
    { id: 'P1', name: 'lint', kind: 'lint', blocking: true },
    { id: 'P2', name: 'build', kind: 'build', blocking: true },
    { id: 'P3', name: 'test', kind: 'test', blocking: true },
    { id: 'P4', name: 'bundle', handler: 'bundle', blocking: false },
    { id: 'P5', name: 'content', handler: 'content', blocking: true },
];

function runPipeline(projectDir, opts = {}) {
    const {
        only = null,
        runGate = runGateCommand,
        runSecurity: secFn = runSecurity,
        runBundle: bundleFn = runBundle,
        runContent: contentFn = runContent,
    } = opts;

    const allow = only ? new Set([].concat(only).map((s) => String(s).toUpperCase())) : null;
    const handlers = { security: secFn, bundle: bundleFn, content: contentFn };

    const results = [];
    const failures = [];

    for (const gate of GATES) {
        if (allow && !allow.has(gate.id)) continue;

        const r = gate.kind ? runGate(projectDir, gate.kind) : handlers[gate.handler](projectDir);

        let status;
        if (!r.ran) {
            status = 'skipped';
        } else if (r.passed) {
            status = 'pass';
        } else if (gate.blocking) {
            status = 'fail';
            failures.push(gate.id);
        } else {
            status = 'advisory';
        }

        results.push({
            id: gate.id,
            name: gate.name,
            status,
            severity: r.severity || null,
            output: r.output || '',
            durationMs: r.durationMs || 0,
        });
    }

    return { passed: failures.length === 0, results, failures };
}

module.exports = { runPipeline, GATES };
