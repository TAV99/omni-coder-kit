'use strict';

// Dry-run provider (HARNESS-SPEC-PHASE-1 §2.6). No-op engine: lets the live loop
// exercise its full state machine + gates without invoking a real agent. Used by
// `--dry-run`/`--provider dry-run` and by tests.

function create() {
    return {
        name: 'dry-run',
        async runStep(step, ctx) {
            return {
                ok: true,
                exitCode: 0,
                summary: `[dry-run] would run >om:${step} via ${ctx && ctx.workflowPath ? ctx.workflowPath : '(unresolved workflow)'}`,
                durationMs: 0,
            };
        },
    };
}

module.exports = { create };
