'use strict';

// Provider factory + interface (HARNESS-SPEC-PHASE-1 §2.5).
//
// Provider = { name, runStep(stepName, ctx) → Promise<{ ok, exitCode, summary, durationMs }> }
//   stepName ∈ 'brainstorm'|'equip'|'plan'|'cook'|'check'|'fix'|'doc'|'ship'
//   ctx = { projectDir, state, workflowPath, sharedBrief }
// Neutral interface so Pha 2 can slot a claude-sdk / openai / gemini adapter in.

const dryRun = require('./dry-run');
const hostCli = require('./host-cli');
const claudeSdk = require('./claude-sdk');
const manualRelay = require('./manual-relay');

function getProvider(name, opts = {}) {
    switch (name) {
        case 'dry-run': return dryRun.create(opts);
        case 'host-cli': return hostCli.create(opts);
        case 'claude-sdk': return claudeSdk.create(opts);
        case 'manual-relay': return manualRelay.create(opts);
        default: throw new Error(`Provider không hỗ trợ: ${name} (dùng 'host-cli' | 'claude-sdk' | 'manual-relay' | 'dry-run')`);
    }
}

// Parse a debate provider-spec "name:ide" (e.g. "host-cli:antigravity") into a
// concrete provider. Bare "name" works too. Returns { id, host, provider }.
function getProviderFromSpec(spec, opts = {}) {
    const [name, ide] = String(spec).split(':');
    const merged = ide ? { ...opts, ide } : { ...opts };
    return { id: spec, host: ide || name, provider: getProvider(name, merged) };
}

module.exports = { getProvider, getProviderFromSpec };
