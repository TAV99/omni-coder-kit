'use strict';

// P4c (SPEC-SQUAD-P4 §5): Claude Code in the orchestrator role. It gets the same
// omni_dual MCP server and hook bridge as codex, written where claude reads them,
// and fills the discussion's astra slot (provider id 'codex' stays internal).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { writeClaudeOrchestratorConfig, hasClaudeOrchestratorMcp, TOOL_MATCHER } = require('../lib/squad/claude-orchestrator');
const { classifyTool, validateHookInput, evaluateHook } = require('../lib/dual/hook-bridge');
const { resolveConfiguredOrchestrator } = require('../lib/dual/agy-model');
const { orchestratorSlotAdapter, orchestratorSlotSeed } = require('../lib/dual/discussion/orchestrator-slot');
const { engineSupport, legacyManifestFields, checkBinding } = require('../lib/squad/bindings');
const { runSetup } = require('../lib/squad/setup');
const { loadRoles } = require('../lib/squad/roles');
const { defaultRegistry } = require('../lib/squad/runtimes');
const { tempDir, writeSkill, readyReports, registryWith } = require('./helpers/squad-project');

const payloads = fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', 'claude-hook-payloads.ndjson'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
const payload = (event, tool) => payloads.find((p) => p.hook_event_name === event && (!tool || p.tool_name === tool));

test('config: .mcp.json server, hooks on every event, enabled server, CLAUDE.md importing AGENTS.md', (t) => {
    const root = tempDir(t, 'claude-orch-');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
    const result = writeClaudeOrchestratorConfig({ projectRoot: root, execPath: '/opt/node' });
    assert.deepEqual(result, { written: ['.mcp.json', path.join('.claude', 'settings.json'), 'CLAUDE.md'], warnings: [] });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.omni_dual.command, '/opt/node');
    assert.match(mcp.mcpServers.omni_dual.args[0], /lib[\\/]dual[\\/]mcp-server\.mjs$/);
    assert.deepEqual(mcp.mcpServers.omni_dual.args.slice(1), ['--workspace', root]);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.enabledMcpjsonServers, ['omni_dual'], 'V30: a project server must be enabled to load in -p mode');
    assert.deepEqual(Object.keys(settings.hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    assert.equal(settings.hooks.PreToolUse[0].matcher, TOOL_MATCHER);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /^'\/opt\/node' '.*bin\/omni-hook\.js'$/);
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.equal(hasClaudeOrchestratorMcp(root), true);
});

test('config: merges with the user\'s own servers and hooks, and stays idempotent', (t) => {
    const root = tempDir(t, 'claude-orch-');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# my own notes\n');
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] },
        enabledMcpjsonServers: ['mine'], hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    writeClaudeOrchestratorConfig({ projectRoot: root, execPath: '/opt/node' });
    const second = writeClaudeOrchestratorConfig({ projectRoot: root, execPath: '/opt/node' });
    assert.deepEqual(second.warnings.map((w) => w.code), ['SQUAD_CLAUDE_MD_NO_AGENTS'], 'an existing CLAUDE.md is never rewritten');
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# my own notes\n');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers), ['mine', 'omni_dual']);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
    assert.deepEqual(settings.enabledMcpjsonServers, ['mine', 'omni_dual']);
    assert.equal(settings.hooks.Stop.length, 2, 'the user hook stays, omni appears once');
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo mine');
    assert.equal(settings.hooks.PreToolUse.length, 1);
});

test('hook bridge: real claude payloads validate (V28)', () => {
    for (const p of payloads) assert.doesNotThrow(() => validateHookInput(p), p.hook_event_name);
});

test('hook bridge: claude edit tools are writes to one file, outside paths are denied', () => {
    const workspaceRoot = '/work/project';
    const write = payload('PreToolUse', 'Write');
    assert.deepEqual(classifyTool(write.tool_name, write.tool_input, { workspaceRoot }),
        { classification: 'write', paths: ['note.txt'], phaseOperation: 'source' });
    const edit = payload('PreToolUse', 'Edit');
    assert.deepEqual(classifyTool(edit.tool_name, edit.tool_input, { workspaceRoot }).paths, ['note.txt']);
    assert.equal(classifyTool('MultiEdit', { file_path: 'src/a.js', edits: [] }, { workspaceRoot }).classification, 'write');
    assert.deepEqual(classifyTool('NotebookEdit', { notebook_path: '/work/project/n.ipynb' }, { workspaceRoot }).paths, ['n.ipynb']);
    assert.equal(classifyTool('Write', { file_path: '/etc/passwd', content: 'x' }, { workspaceRoot }).classification, 'denied');
    assert.equal(classifyTool('Edit', { file_path: '../out.txt' }, { workspaceRoot }).classification, 'denied');
    // codex apply_patch keeps its patch parsing.
    assert.deepEqual(classifyTool('apply_patch', { command: '*** Begin Patch\n*** Update File: a.js\n*** End Patch' }, { workspaceRoot }).paths, ['a.js']);
});

test('hook bridge: a claude Bash call to approve a gate is denied without asking the daemon', async (t) => {
    const root = tempDir(t, 'claude-orch-hook-');
    const bash = payload('PreToolUse', 'Bash');
    const out = await evaluateHook({ ...bash, cwd: root, tool_input: { ...bash.tool_input, command: 'omni squad approve plan-r1' } },
        { createClient: () => assert.fail('the rule must not depend on the daemon') });
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
});

test('engine and manifest: claude can hold the orchestrator role; its model reaches astra', (t) => {
    const binding = { roles: { orchestrator: { runtime: 'claude', model: 'opus', effort: 'high' },
        worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } };
    assert.deepEqual(engineSupport(binding), { supported: true, reasons: [] });
    assert.deepEqual(engineSupport({ roles: { ...binding.roles, orchestrator: { runtime: 'agy', model: 'x' } } }).reasons,
        ['orchestrator must be codex or claude']);
    const fields = legacyManifestFields(binding, []);
    assert.deepEqual([fields.orchestratorRuntime, fields.orchestratorModel, fields.orchestratorEffort], ['claude', 'opus', 'high']);
    const root = tempDir(t, 'claude-orch-manifest-');
    assert.deepEqual(resolveConfiguredOrchestrator(root), { runtime: 'codex' });
    fs.mkdirSync(path.join(root, '.omni'));
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ orchestratorRuntime: 'claude', orchestratorModel: 'opus' }));
    assert.deepEqual(resolveConfiguredOrchestrator(root), { runtime: 'claude', model: 'opus', effort: undefined });
});

test('bindings accept a full claude-… id beyond the alias list (V31)', () => {
    const roles = loadRoles(path.join(__dirname, '..', 'templates', 'squad', 'roles'));
    const reports = readyReports({ claudeModels: ['sonnet', 'opus'] });
    const check = (model, effort) => checkBinding({ roles: { orchestrator: { runtime: 'claude', model, ...(effort ? { effort } : {}) },
        worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } },
    { roles, registry: defaultRegistry, reports }).errors.map((e) => e.message);
    assert.deepEqual(check('sonnet', 'high'), []);
    assert.deepEqual(check('claude-opus-5-5', 'max'), []);
    assert.match(check('claude-opus-5-5', 'ultra')[0], /effort "ultra" is not supported by claude/);
    assert.match(check('gpt-6.1-sol')[0], /not offered by claude/);
});

test('setup with a claude orchestrator writes its MCP/hook config and mounts .claude/skills', async (t) => {
    const root = tempDir(t, 'claude-orch-setup-');
    for (const name of ['om-think', 'karpathy-guidelines', 'om-cook']) writeSkill(path.join(root, '.agents', 'skills'), name);
    fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ version: '3.2.0', ide: 'dual' }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# rules\n');
    const result = await runSetup({ projectRoot: root, homedir: tempDir(t, 'claude-orch-home-'), yes: true,
        binds: ['orchestrator=claude:sonnet:high', 'worker=agy:gemini-3.8-flash-high'],
        registry: registryWith(readyReports({ claudeModels: ['sonnet'] })), now: () => new Date('2026-11-01T10:00:00Z') });
    assert.deepEqual(result.engine, { supported: true, reasons: [] });
    assert.deepEqual(result.orchestratorConfig, ['.mcp.json', path.join('.claude', 'settings.json'), 'CLAUDE.md']);
    assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'om-think', 'SKILL.md')), 'orchestrator skills mount into .claude/skills');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.omni', 'manifest.json'), 'utf8'));
    assert.deepEqual([manifest.orchestratorRuntime, manifest.orchestratorModel, manifest.orchestratorEffort], ['claude', 'sonnet', 'high']);
});

function capture(stdout) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0, null); });
        return child;
    };
    return { calls, spawnImpl };
}

test('discussion astra slot: claude answers as provider codex, read-only, hooks off; codex stays the default', async () => {
    const session = '1eb02a05-afa5-4c0a-9059-d55e991f2372';
    const reply = (body) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session,
        result: JSON.stringify({ schema_version: 1, kind: 'reply', body }), permission_denials: [], usage: { input_tokens: 1, output_tokens: 1 } });
    const cwd = path.resolve('/work/project');
    const seedRun = capture(reply('ready'));
    const seeded = await orchestratorSlotSeed('claude')({ cwd, command: '/opt/claude', model: 'opus', spawnImpl: seedRun.spawnImpl });
    assert.equal(seeded.conversationId, session);
    const seedArgs = seedRun.calls[0].args;
    assert.equal(seedArgs[seedArgs.indexOf('--model') + 1], 'opus');
    assert.equal(JSON.parse(seedArgs[seedArgs.indexOf('--settings') + 1]).disableAllHooks, true);

    const turnRun = capture(reply('answer'));
    const adapter = orchestratorSlotAdapter('claude', { cwd, command: '/opt/claude', spawnImpl: turnRun.spawnImpl });
    assert.equal(adapter.provider, 'codex');
    const binding = { provider: 'codex', role: 'astra', model: 'opus', effort: 'medium', conversation_id: session,
        session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1, snapshot_sha256: crypto.createHash('sha256').update('ctx').digest('hex') };
    const raw = await adapter.invoke({ binding, snapshot: { text: 'ctx', sha256: binding.snapshot_sha256 }, envelope: { kind: 'question', body: 'why?' },
        invocationId: 'inv-1', timeoutMs: 10_000, signal: new AbortController().signal, markNudged() {} });
    assert.equal(adapter.classify(raw, binding, 'inv-1').completion, 'succeeded');
    const args = turnRun.calls[0].args;
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill');
    assert.deepEqual(args.slice(-2), ['--resume', session]);
    assert.equal(orchestratorSlotAdapter('codex').id, 'codex-live-v1');
});
