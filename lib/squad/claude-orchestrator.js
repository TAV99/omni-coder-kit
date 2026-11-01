'use strict';

// Claude Code as the dual orchestrator (SPEC-SQUAD-P4 §5): the same omni_dual
// MCP server and omni-hook bridge codex gets through .codex/, written where
// claude reads them. Verified against claude 2.1.316 (V28: hook payloads and
// deny output; V30: a project .mcp.json server listed in enabledMcpjsonServers
// loads in -p mode). Existing user settings are merged, never replaced.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = 'omni_dual';
const HOOK_SCRIPT = path.join(PACKAGE_ROOT, 'bin', 'omni-hook.js');
const TOOL_MATCHER = '^(Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*)$';
// Same events and budgets as templates/overlays/codex/hooks.template.json.
const HOOK_EVENTS = Object.freeze([
    ['SessionStart', null, 15, 'Omni Dual session start'],
    ['UserPromptSubmit', null, 15, 'Omni Dual prompt authority check'],
    ['PreToolUse', TOOL_MATCHER, 5, 'Omni Dual pre-tool authority check'],
    ['PostToolUse', TOOL_MATCHER, 5, 'Omni Dual post-tool scope observation'],
    ['Stop', null, 5, 'Omni Dual completion verification'],
]);

// claude runs hook commands through a POSIX shell (Git Bash on Windows).
// TODO(win32): confirm the quoting and forward-slash paths on real Windows.
function hookCommand(execPath = process.execPath) {
    const quote = (value) => `'${value.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
    return `${quote(execPath)} ${quote(HOOK_SCRIPT)}`;
}

function mcpServerEntry(projectRoot, execPath = process.execPath) {
    return { command: execPath, args: [path.join(PACKAGE_ROOT, 'lib', 'dual', 'mcp-server.mjs'), '--workspace', projectRoot] };
}

function readJsonObject(file, fsImpl) {
    if (!fsImpl.existsSync(file)) return {};
    const value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
    return value;
}

const isOmniGroup = (group) => Array.isArray(group?.hooks)
    && group.hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes('omni-hook.js'));

// Replaces omni's own hook groups and keeps every other hook the user has.
function mergeSettings(settings, command) {
    const hooks = { ...(settings.hooks || {}) };
    for (const [event, matcher, timeout, statusMessage] of HOOK_EVENTS) {
        const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((group) => !isOmniGroup(group));
        hooks[event] = [...kept, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout, statusMessage }] }];
    }
    const enabled = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [];
    return { ...settings, enabledMcpjsonServers: [...new Set([...enabled, SERVER])], hooks };
}

function writeClaudeOrchestratorConfig({ projectRoot, fsImpl = fs, execPath = process.execPath }) {
    const written = [];
    const warnings = [];
    const writeJson = (rel, value) => {
        const file = path.join(projectRoot, rel);
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        fsImpl.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
        written.push(rel);
    };
    const mcp = readJsonObject(path.join(projectRoot, '.mcp.json'), fsImpl);
    writeJson('.mcp.json', { ...mcp, mcpServers: { ...(mcp.mcpServers || {}), [SERVER]: mcpServerEntry(projectRoot, execPath) } });
    const settingsRel = path.join('.claude', 'settings.json');
    writeJson(settingsRel, mergeSettings(readJsonObject(path.join(projectRoot, settingsRel), fsImpl), hookCommand(execPath)));
    // The controller rules live in AGENTS.md (omni init --ide dual); claude reads them through an import.
    const claudeMd = path.join(projectRoot, 'CLAUDE.md');
    if (fsImpl.existsSync(path.join(projectRoot, 'AGENTS.md'))) {
        if (!fsImpl.existsSync(claudeMd)) {
            fsImpl.writeFileSync(claudeMd, '@AGENTS.md\n');
            written.push('CLAUDE.md');
        } else if (!/@AGENTS\.md\b/.test(fsImpl.readFileSync(claudeMd, 'utf8'))) {
            warnings.push({ code: 'SQUAD_CLAUDE_MD_NO_AGENTS', message: 'CLAUDE.md does not import AGENTS.md: add a line "@AGENTS.md" so the claude orchestrator reads the dual controller rules' });
        }
    }
    return { written, warnings };
}

// Whether the project carries the omni_dual MCP server for a claude orchestrator.
function hasClaudeOrchestratorMcp(projectRoot, fsImpl = fs) {
    try {
        const mcp = readJsonObject(path.join(projectRoot, '.mcp.json'), fsImpl);
        return Boolean(mcp.mcpServers && mcp.mcpServers[SERVER]);
    } catch {
        return false;
    }
}

module.exports = { writeClaudeOrchestratorConfig, hasClaudeOrchestratorMcp, mergeSettings, hookCommand, TOOL_MATCHER };
