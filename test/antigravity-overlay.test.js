'use strict';

const assert = require('node:assert');
const test = require('node:test');
const path = require('path');
const fs = require('fs');

const { 
    buildAntigravityCommands, 
    buildAntigravityWorkflows, 
    buildAntigravityHooks,
    buildAntigravityRules
} = require('../lib/init/strategies');

test('Antigravity Overlay Integration', async (t) => {
    await t.test('buildAntigravityCommands returns correct mapping', () => {
        const commands = buildAntigravityCommands('antigravity');
        assert.ok(commands, 'Should return commands');
        assert.ok(commands['om:cook.md'], 'Should contain om:cook.md');
        assert.ok(commands['om:cook.md'].includes('templates/overlays/antigravity/commands/om:cook.md'), 'Path should be correct');
    });

    await t.test('buildAntigravityWorkflows returns correct mapping', () => {
        const workflows = buildAntigravityWorkflows('antigravity');
        assert.ok(workflows, 'Should return workflows');
        assert.ok(workflows['coder-execution.md'], 'Should contain coder-execution.md');
        assert.ok(workflows['coder-execution.md'].includes('templates/overlays/antigravity/workflows/coder-execution.md'), 'Path should be correct');
    });

    await t.test('buildAntigravityHooks returns hooks content', () => {
        const hooks = buildAntigravityHooks('antigravity');
        assert.ok(hooks, 'Should return hooks');
        const parsed = JSON.parse(hooks);
        assert.ok(parsed.hooks.PostToolUse, 'Should contain PostToolUse hook');
    });

    await t.test('buildAntigravityRules returns correct rules', () => {
        const rules = buildAntigravityRules({ hasUI: true, hasBackend: true });
        assert.ok(rules, 'Should return rules');
        const names = rules.map(r => r.name);
        assert.ok(names.includes('antigravity-tools.md'), 'Should include antigravity-tools.md');
    });

    await t.test('buildAntigravityCommands returns null for non-antigravity ide', () => {
        const commands = buildAntigravityCommands('claudecode');
        assert.strictEqual(commands, null);
    });
});
