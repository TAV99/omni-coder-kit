'use strict';

// Codex as orchestrator through `omni squad setup` alone: .codex/config.toml gets
// the omni_dual MCP server and [features] hooks = true, .codex/hooks.json the omni
// hooks; anything the user already had is kept, and a second run changes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeCodexOrchestratorConfig, hasCodexOrchestratorMcp } = require('../lib/squad/codex-orchestrator');
const { runSetup } = require('../lib/squad/setup');
const { tempDir, writeSkill, readyReports, registryWith } = require('./helpers/squad-project');

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// The same checks capability-preflight runs before a session (mcp_and_hook_setup, project config).
const preflightOk = (root) => {
    const config = read(root, '.codex/config.toml');
    const hooks = JSON.parse(read(root, '.codex/hooks.json'));
    return config.includes('[mcp_servers.omni_dual]') && /\[features\][\s\S]*?\bhooks\s*=\s*true/.test(config)
        && !config.includes('codex_hooks') && hooks.hooks && typeof hooks.hooks === 'object';
};
const omniGroups = (hooks, event) => hooks.hooks[event].filter((group) => group.hooks.some((hook) => hook.command.includes('omni-hook.js')));

test('fresh project: config and hooks written, preflight checks pass, AGENTS.md missing is reported', (t) => {
    const root = tempDir(t, 'codex-orch-');
    assert.equal(hasCodexOrchestratorMcp(root), false);
    const result = writeCodexOrchestratorConfig({ projectRoot: root });
    assert.deepEqual(result.written, [path.join('.codex', 'config.toml'), path.join('.codex', 'hooks.json')]);
    assert.deepEqual(result.warnings.map((w) => w.code), ['SQUAD_AGENTS_MD_MISSING']);
    const config = read(root, '.codex/config.toml');
    assert.match(config, /\[mcp_servers\.omni_dual\]\ncommand = ".+"\nargs = \[".+mcp-server\.mjs", "--workspace", ".+"\]/);
    assert.ok(config.includes(JSON.stringify(root)), 'bound to this project');
    const hooks = JSON.parse(read(root, '.codex/hooks.json'));
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.equal(omniGroups(hooks, 'PreToolUse')[0].matcher, '^(Bash|apply_patch|mcp__.*)$');
    assert.equal(preflightOk(root), true);
    assert.equal(hasCodexOrchestratorMcp(root), true);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
    assert.deepEqual(writeCodexOrchestratorConfig({ projectRoot: root }).warnings, []);
});

test('existing config: user settings stay, omni block replaced not duplicated, second run is a no-op', (t) => {
    const root = tempDir(t, 'codex-orch-');
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), [
        'model = "gpt-6.1-sol"', '', '[mcp_servers.mine]', 'command = "mine"', '',
        '[mcp_servers.omni_dual]', 'command = "/old/node"', 'args = ["/old/mcp-server.mjs"]', '',
        '[features]', 'web_search = true', '', '[profiles.x]', 'model = "y"', ''].join('\n'));
    fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] },
            { matcher: 'x', hooks: [{ type: 'command', command: "'/old/node' '/old/bin/omni-hook.js'" }] }] } }));
    writeCodexOrchestratorConfig({ projectRoot: root });
    const config = read(root, '.codex/config.toml');
    for (const kept of ['model = "gpt-6.1-sol"', '[mcp_servers.mine]', 'command = "mine"', 'web_search = true', '[profiles.x]']) {
        assert.ok(config.includes(kept), kept);
    }
    assert.equal(config.match(/\[mcp_servers\.omni_dual\]/g).length, 1);
    assert.equal(config.includes('/old/mcp-server.mjs'), false, 'the stale omni block is replaced');
    assert.match(config, /\[features\]\nhooks = true\nweb_search = true/);
    assert.equal(preflightOk(root), true);
    const hooks = JSON.parse(read(root, '.codex/hooks.json'));
    assert.deepEqual(hooks.hooks.PreToolUse.map((group) => group.hooks[0].command.includes('omni-hook.js') ? 'omni' : group.hooks[0].command), ['my-guard', 'omni']);
    assert.equal(omniGroups(hooks, 'PreToolUse')[0].hooks[0].command.includes('/old/'), false);
    const before = [read(root, '.codex/config.toml'), read(root, '.codex/hooks.json')];
    writeCodexOrchestratorConfig({ projectRoot: root });
    assert.deepEqual([read(root, '.codex/config.toml'), read(root, '.codex/hooks.json')], before,
        'stable: codex asks to re-review hooks only when they change (V42)');
});

test('hooks turned off or the old flag: hooks are turned on and the person is told', (t) => {
    const root = tempDir(t, 'codex-orch-');
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[features]\nhooks = false\ncodex_hooks = true\n');
    const { warnings } = writeCodexOrchestratorConfig({ projectRoot: root });
    assert.deepEqual(warnings.map((w) => w.code).sort(), ['SQUAD_CODEX_HOOKS_ENABLED', 'SQUAD_CODEX_HOOKS_FLAG']);
    assert.match(read(root, '.codex/config.toml'), /\[features\]\nhooks = true\n/);
});

test('setup with a codex orchestrator writes its config; a claude one does not touch .codex', async (t) => {
    const setup = async (orchestrator) => {
        const root = tempDir(t, 'codex-orch-setup-');
        for (const name of ['om-think', 'karpathy-guidelines', 'om-cook']) writeSkill(path.join(root, '.agents', 'skills'), name);
        fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ version: '3.2.0', ide: 'dual' }));
        fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
        const result = await runSetup({ projectRoot: root, homedir: tempDir(t, 'codex-orch-home-'), yes: true,
            binds: [orchestrator, 'worker=agy:gemini-3.8-flash-high'],
            registry: registryWith(readyReports({ claudeModels: ['sonnet'] })), now: () => new Date('2026-11-02T10:00:00Z') });
        return { root, result };
    };
    const codex = await setup('orchestrator=codex:gpt-6.1-sol:high');
    assert.deepEqual(codex.result.orchestratorConfig, [path.join('.codex', 'config.toml'), path.join('.codex', 'hooks.json')]);
    assert.equal(preflightOk(codex.root), true);
    const claude = await setup('orchestrator=claude:sonnet:high');
    assert.equal(fs.existsSync(path.join(claude.root, '.codex')), false);
});
