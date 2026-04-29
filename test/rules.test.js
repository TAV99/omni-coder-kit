'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseRules } = require('../lib/rules/parse');
const { formatMarkdown, formatInject } = require('../lib/rules/format');
const { syncRulesToConfig } = require('../lib/rules/sync');

// ---------------------------------------------------------------------------
// parseRules
// ---------------------------------------------------------------------------

test('parseRules: parses all fields correctly', () => {
    const input = {
        language: 'TypeScript',
        codingStyle: 'functional; immutable',
        forbidden: 'any; eval',
        custom: 'commit tiếng Việt',
    };
    const result = parseRules(input);
    assert.equal(result.language, 'TypeScript');
    assert.deepEqual(result.codingStyle, ['functional', 'immutable']);
    assert.deepEqual(result.forbidden, ['any', 'eval']);
    assert.deepEqual(result.custom, ['commit tiếng Việt']);
});

test('parseRules: handles null/undefined fields — all arrays empty', () => {
    const result = parseRules({ language: null });
    assert.equal(result.language, null);
    assert.deepEqual(result.codingStyle, []);
    assert.deepEqual(result.forbidden, []);
    assert.deepEqual(result.custom, []);
});

test('parseRules: filters empty entries from semicolon-separated string', () => {
    const result = parseRules({ codingStyle: '; foo ; ; bar ;' });
    assert.deepEqual(result.codingStyle, ['foo', 'bar']);
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

test('formatMarkdown: formats all sections with correct headers and bullets', () => {
    const parsed = {
        language: 'Go',
        codingStyle: ['gofmt', 'short vars'],
        forbidden: ['panic', 'global state'],
        custom: ['doc in English'],
    };
    const result = formatMarkdown(parsed);
    assert.ok(result.startsWith('# Personal Rules'));
    assert.ok(result.includes('## Ngôn ngữ'));
    assert.ok(result.includes('- Go'));
    assert.ok(result.includes('## Coding Style'));
    assert.ok(result.includes('- gofmt'));
    assert.ok(result.includes('- short vars'));
    assert.ok(result.includes('## Forbidden Patterns'));
    assert.ok(result.includes('- panic'));
    assert.ok(result.includes('## Custom Rules'));
    assert.ok(result.includes('- doc in English'));
});

test('formatMarkdown: returns null when all sections empty', () => {
    const parsed = { language: null, codingStyle: [], forbidden: [], custom: [] };
    const result = formatMarkdown(parsed);
    assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// formatInject
// ---------------------------------------------------------------------------

test('formatInject: formats lines for config injection', () => {
    const parsed = {
        language: 'Go',
        codingStyle: ['gofmt'],
        forbidden: ['panic'],
        custom: ['item'],
    };
    const result = formatInject(parsed);
    assert.ok(result.includes('- **Ngôn ngữ:** Go'));
    assert.ok(result.includes('- gofmt'));
    assert.ok(result.includes('- **KHÔNG:** panic'));
    assert.ok(result.includes('- item'));
});

test('formatInject: returns empty string when all empty', () => {
    const parsed = { language: null, codingStyle: [], forbidden: [], custom: [] };
    const result = formatInject(parsed);
    assert.equal(result, '');
});

// ---------------------------------------------------------------------------
// syncRulesToConfig
// ---------------------------------------------------------------------------

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-rules-test-'));
}

test('syncRulesToConfig: injects rules between existing markers', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Existing\n\n<!-- omni:rules -->\nold content\n<!-- /omni:rules -->\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n- rule two\n', 'utf-8');

    const result = syncRulesToConfig(() => 'CLAUDE.md', dir);
    assert.equal(result, true);

    const content = fs.readFileSync(claudePath, 'utf-8');
    assert.ok(content.includes('<!-- omni:rules -->'));
    assert.ok(content.includes('<!-- /omni:rules -->'));
    assert.ok(content.includes('- rule one'));
    assert.ok(content.includes('- rule two'));
    assert.ok(!content.includes('old content'));
});

test('syncRulesToConfig: appends markers when not present in config', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config file\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule alpha\n', 'utf-8');

    const result = syncRulesToConfig(() => 'CLAUDE.md', dir);
    assert.equal(result, true);

    const content = fs.readFileSync(claudePath, 'utf-8');
    assert.ok(content.includes('<!-- omni:rules -->'));
    assert.ok(content.includes('<!-- /omni:rules -->'));
    assert.ok(content.includes('- rule alpha'));
});

test('syncRulesToConfig: returns false when no config file found', () => {
    const dir = makeTmpDir();
    const result = syncRulesToConfig(() => null, dir);
    assert.equal(result, false);
});

test('syncRulesToConfig: returns corrupt when only start marker present', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config\n\n<!-- omni:rules -->\nold rules here\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n', 'utf-8');

    const original = fs.readFileSync(claudePath, 'utf-8');
    const result = syncRulesToConfig(() => 'CLAUDE.md', dir);
    assert.equal(result, 'corrupt');

    const after = fs.readFileSync(claudePath, 'utf-8');
    assert.equal(after, original, 'file should not be modified when corrupt');
});

test('syncRulesToConfig: returns corrupt when only end marker present', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config\n\n<!-- /omni:rules -->\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n', 'utf-8');

    const original = fs.readFileSync(claudePath, 'utf-8');
    const result = syncRulesToConfig(() => 'CLAUDE.md', dir);
    assert.equal(result, 'corrupt');

    const after = fs.readFileSync(claudePath, 'utf-8');
    assert.equal(after, original, 'file should not be modified when corrupt');
});
