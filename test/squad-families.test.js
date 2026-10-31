'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelFamily } = require('../lib/squad/runtimes/families');

test('model family follows the vendor prefix, not the CLI', () => {
    const cases = {
        'gpt-5.6-sol': 'openai',
        'codex-auto-review': 'openai',
        'o3-mini': 'openai',
        'gpt-oss-120b-medium': 'openai-oss',
        'gemini-3.8-flash-high': 'google',
        'claude-sonnet-4-6': 'anthropic',
        'deepseek-v4': 'deepseek',
        'qwen3-coder': 'alibaba',
        'Claude-Opus-4-6-thinking': 'anthropic',
        'mystery-model': 'unknown',
        'ollama-local': 'unknown',
    };
    for (const [id, family] of Object.entries(cases)) assert.equal(modelFamily(id), family, id);
});

test('non-string ids are unknown', () => {
    assert.equal(modelFamily(undefined), 'unknown');
    assert.equal(modelFamily(42), 'unknown');
});
