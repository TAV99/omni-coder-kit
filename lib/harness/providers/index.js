'use strict';

// Provider factory + interface (HARNESS-SPEC-PHASE-1 §2.5).
//
// Provider = { name, runStep(stepName, ctx) → Promise<{ ok, exitCode, summary, durationMs }> }
//   stepName ∈ 'brainstorm'|'equip'|'plan'|'cook'|'check'|'fix'|'doc'|'ship'
//   ctx = { projectDir, state, workflowPath, sharedBrief }
// Neutral interface so Pha 2 can slot a claude-sdk / openai / gemini adapter in.

const dryRun = require('./dry-run');
const hostCli = require('./host-cli');

function getProvider(name, opts = {}) {
    switch (name) {
        case 'dry-run': return dryRun.create(opts);
        case 'host-cli': return hostCli.create(opts);
        default: throw new Error(`Provider không hỗ trợ: ${name} (dùng 'host-cli' | 'dry-run')`);
    }
}

module.exports = { getProvider };
