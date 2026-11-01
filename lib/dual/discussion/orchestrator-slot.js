'use strict';

// The discussion's orchestrator slot keeps provider id 'codex' and role astra;
// the runtime bound to the orchestrator role decides which live adapter and
// seed run (SPEC-SQUAD-P4 §5).

const { createCodexAdapter, seedCodexConversation } = require('./live-codex-invoke');
const { createClaudeAdapter, seedClaudeConversation } = require('./live-claude-invoke');

// Claude as astra: read-only tool list, and isolated so a copied
// .claude/settings.json never fires the omni hooks inside a discussion turn.
function claudeOrchestratorOptions(options = {}) {
    return { ...options, provider: 'codex', isolatedRoot: true };
}

function orchestratorSlotAdapter(runtime, options) {
    if (runtime === 'claude') return createClaudeAdapter(claudeOrchestratorOptions(options));
    return createCodexAdapter(options);
}

function orchestratorSlotSeed(runtime) {
    if (runtime === 'claude') return (options) => seedClaudeConversation(claudeOrchestratorOptions(options));
    return seedCodexConversation;
}

module.exports = { orchestratorSlotAdapter, orchestratorSlotSeed };
