'use strict';

// Model family by id prefix (SPEC-SQUAD-P1 §6). The family is the model's
// vendor, not the CLI that serves it: agy listing `claude-sonnet-4-6` is
// "anthropic". Order matters — `gpt-oss-` must match before `gpt-`.
const RULES = [
    [/^gpt-oss-/i, 'openai-oss'],
    [/^(gpt-|codex-|o\d)/i, 'openai'],
    [/^gemini-/i, 'google'],
    [/^claude-/i, 'anthropic'],
    [/^deepseek/i, 'deepseek'],
    [/^qwen/i, 'alibaba'],
];

function modelFamily(modelId) {
    if (typeof modelId !== 'string') return 'unknown';
    const id = modelId.trim();
    for (const [pattern, family] of RULES) {
        if (pattern.test(id)) return family;
    }
    return 'unknown';
}

module.exports = { modelFamily };
