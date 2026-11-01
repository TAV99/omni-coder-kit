'use strict';

// The discussion's worker slot keeps provider id 'agy' (P3b); the runtime bound
// to it decides which live adapter and seed actually run (SPEC-SQUAD-P3 §4.4).

const { createCodexAdapter, seedCodexConversation } = require('./live-codex-invoke');
const { createAgyAdapter, seedAgyConversation } = require('./live-agy-invoke');
const { createClaudeAdapter, seedClaudeConversation } = require('./live-claude-invoke');
const { MODEL_DEFAULT_EFFORT } = require('../agy-model');

// Codex as worker: own conversation (D18), read-only resume, isolated from the
// parent repo when it runs inside a worker root.
function codexWorkerOptions({ effort, isolatedRoot, ...options } = {}) {
    return { ...options, provider: 'agy', readOnlyResume: true, isolatedRoot: isolatedRoot === true,
        ...(typeof effort === 'string' && effort && effort !== MODEL_DEFAULT_EFFORT ? { effort } : {}) };
}

// Claude as worker (SPEC-SQUAD-P4 §4): read-only tool list, isolated like codex.
function claudeWorkerOptions({ isolatedRoot, ...options } = {}) {
    return { ...options, provider: 'agy', isolatedRoot: isolatedRoot === true };
}

function workerSlotAdapter(runtime, options = {}) {
    if (runtime === 'codex') return createCodexAdapter(codexWorkerOptions(options));
    if (runtime === 'claude') return createClaudeAdapter(claudeWorkerOptions(options));
    const { isolatedRoot, ...agyOptions } = options;
    return createAgyAdapter(agyOptions);
}

function workerSlotSeed(runtime) {
    if (runtime === 'codex') return (options) => seedCodexConversation(codexWorkerOptions(options));
    if (runtime === 'claude') return (options) => seedClaudeConversation(claudeWorkerOptions(options));
    return (options = {}) => {
        const { isolatedRoot, ...agyOptions } = options;
        return seedAgyConversation(agyOptions);
    };
}

module.exports = { workerSlotAdapter, workerSlotSeed };
