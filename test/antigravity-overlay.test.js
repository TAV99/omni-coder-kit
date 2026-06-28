'use strict';

const assert = require('node:assert');
const test = require('node:test');
const path = require('path');
const fs = require('fs');

const {
    buildAntigravityCommands,
    buildAntigravityWorkflows,
    buildAntigravityHooks,
    buildAntigravityRules,
    buildAntigravityPolicy,
    buildAntigravityMcpConfig,
    buildAntigravityExtension,
    buildAntigravitySkills,
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

    await t.test('buildAntigravityHooks uses verified Gemini/agy schema (AfterTool, not PostToolUse)', () => {
        const hooks = buildAntigravityHooks('antigravity');
        assert.ok(hooks, 'Should return hooks');
        const parsed = JSON.parse(hooks);
        assert.ok(Array.isArray(parsed.hooks.AfterTool), 'Should use AfterTool array');
        assert.ok(!parsed.hooks.PostToolUse, 'Should NOT use Claude-style PostToolUse');
        const entry = parsed.hooks.AfterTool[0];
        assert.ok(entry.matcher, 'AfterTool entry has matcher');
        assert.ok(Array.isArray(entry.hooks) && entry.hooks[0].type === 'command', 'AfterTool entry has command hooks');
    });

    await t.test('buildAntigravityExtension is a valid gemini-extension.json manifest', () => {
        const manifest = JSON.parse(buildAntigravityExtension(process.cwd()));
        assert.strictEqual(manifest.name, 'omni-coder-kit');
        assert.ok(manifest.version && manifest.version !== '0.0.0', 'version read from package.json');
        assert.strictEqual(manifest.contextFileName, 'AGENTS.md');
        assert.ok(manifest.mcpServers.context7, 'seeds Context7 MCP server');
    });

    await t.test('buildAntigravityPolicy: TOML policy engine deny-list (rm -rf, force-push, hard-reset)', () => {
        const policy = buildAntigravityPolicy('antigravity');
        assert.ok(policy, 'Should return policy');
        assert.match(policy, /commandPrefix\s*=\s*"rm -rf"/);
        assert.match(policy, /git push .*--force/);
        assert.match(policy, /git reset --hard/);
        assert.match(policy, /decision\s*=\s*"deny"/);
        assert.match(policy, /decision\s*=\s*"ask_user"/);
        assert.match(policy, /decision\s*=\s*"allow"/);
        assert.ok(!/"PostToolUse"|"force_ask"/.test(policy), 'no Claude-style / blog-guessed keys');
    });

    await t.test('buildAntigravityPolicy returns null for non-antigravity ide', () => {
        assert.strictEqual(buildAntigravityPolicy('claudecode'), null);
    });

    await t.test('buildAntigravityMcpConfig has mcpServers shape', () => {
        const cfg = JSON.parse(buildAntigravityMcpConfig(process.cwd()));
        assert.ok(cfg.mcpServers, 'has mcpServers');
        assert.ok(cfg.mcpServers.context7.command === 'npx', 'context7 command server');
    });

    await t.test('buildAntigravitySkills emits native SKILL.md content incl. om-ship + Phase-4 trio', () => {
        const skills = buildAntigravitySkills('antigravity');
        assert.ok(skills, 'Should return skills');
        const names = skills.map(s => s.name);
        assert.ok(names.includes('om-cook'), 'has om-cook skill');
        assert.ok(names.includes('om-ship'), 'has om-ship skill (was missing)');
        // Phase-4 trio: go (all-in-one), intake (spec→requirements), accept (acceptance loop).
        assert.ok(names.includes('om-go'), 'has om-go skill (Phase-4)');
        assert.ok(names.includes('om-intake'), 'has om-intake skill (Phase-4)');
        assert.ok(names.includes('om-accept'), 'has om-accept skill (Phase-4)');
        const cook = skills.find(s => s.name === 'om-cook');
        assert.ok(cook.content.startsWith('---\nname: om-cook\n'), 'SKILL.md frontmatter');
        assert.ok(/description: .+/.test(cook.content), 'SKILL.md has description');
    });

    await t.test('buildAntigravitySkills returns null for non-antigravity ide', () => {
        assert.strictEqual(buildAntigravitySkills('claudecode'), null);
    });

    await t.test('om:ship command exists in antigravity overlay', () => {
        const commands = buildAntigravityCommands('antigravity');
        assert.ok(commands['om:ship.md'], 'Should contain om:ship.md');
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
