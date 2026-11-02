'use strict';

// Codex as the dual orchestrator: the same omni_dual MCP server and omni hooks
// that `omni init --ide dual` writes, now also written by `omni squad setup`, so
// choosing codex there works without a separate init (as claude already did, P4).
// Existing files are merged: only omni's own MCP block and hook groups change.

const fs = require('node:fs');
const path = require('node:path');
const { buildCodexConfig, buildCodexHooks } = require('../init/strategies');

const SERVER_HEADER = '[mcp_servers.omni_dual]';

const isOmniGroup = (group) => Array.isArray(group?.hooks)
    && group.hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes('omni-hook.js'));

function omniConfig(projectRoot) {
    return buildCodexConfig('dual', true, { dualPair: 'codex-agy', mode: 'auto', projectDir: projectRoot });
}

// The omni_dual block of a generated config: from its header to the next table or the end.
function serverBlock(content) {
    const start = content.indexOf(SERVER_HEADER);
    return start === -1 ? '' : content.slice(start).trimEnd();
}

// Replaces omni's [mcp_servers.omni_dual] table and makes sure [features] hooks = true.
function mergeConfig(existing, generated) {
    const warnings = [];
    const lines = existing.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        const table = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
        if (table) skipping = table[1].trim() === 'mcp_servers.omni_dual';
        if (!skipping) out.push(line);
    }
    let text = out.join('\n').trimEnd();
    if (/^\s*codex_hooks\s*=/m.test(text)) {
        warnings.push({ code: 'SQUAD_CODEX_HOOKS_FLAG', message: '.codex/config.toml uses the old codex_hooks flag: remove it; omni sets [features] hooks = true' });
    }
    const features = /^\s*\[features\]\s*(#.*)?$/m.exec(text);
    if (!features) {
        text += '\n\n[features]\n# Required for .codex/hooks.json to run.\nhooks = true';
    } else {
        const sectionStart = features.index + features[0].length;
        const nextTable = text.slice(sectionStart).search(/^\s*\[[^\]]+\]/m);
        const sectionEnd = nextTable === -1 ? text.length : sectionStart + nextTable;
        const section = text.slice(sectionStart, sectionEnd);
        if (/^\s*hooks\s*=\s*true\b/m.test(section)) {
            // already on
        } else if (/^\s*hooks\s*=/m.test(section)) {
            text = text.slice(0, sectionStart) + section.replace(/^(\s*)hooks\s*=.*$/m, '$1hooks = true') + text.slice(sectionEnd);
            warnings.push({ code: 'SQUAD_CODEX_HOOKS_ENABLED', message: '.codex/config.toml had [features] hooks off: omni turned it on (its hooks guard the orchestrator)' });
        } else {
            text = `${text.slice(0, sectionStart)}\nhooks = true${text.slice(sectionStart)}`;
        }
    }
    return { content: `${text}\n\n${serverBlock(generated)}\n`, warnings };
}

function mergeHooks(existing, generated) {
    const hooks = { ...(existing.hooks || {}) };
    for (const [event, groups] of Object.entries(generated.hooks || {})) {
        const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((group) => !isOmniGroup(group));
        hooks[event] = [...kept, ...groups];
    }
    return { ...existing, hooks };
}

function readJsonObject(file, fsImpl) {
    if (!fsImpl.existsSync(file)) return {};
    const value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
    return value;
}

function writeCodexOrchestratorConfig({ projectRoot, fsImpl = fs }) {
    const written = [];
    const warnings = [];
    const configRel = path.join('.codex', 'config.toml');
    const hooksRel = path.join('.codex', 'hooks.json');
    const configFile = path.join(projectRoot, configRel);
    const generated = omniConfig(projectRoot);
    fsImpl.mkdirSync(path.dirname(configFile), { recursive: true });
    if (!fsImpl.existsSync(configFile)) {
        fsImpl.writeFileSync(configFile, generated);
    } else {
        const merged = mergeConfig(fsImpl.readFileSync(configFile, 'utf8'), generated);
        fsImpl.writeFileSync(configFile, merged.content);
        warnings.push(...merged.warnings);
    }
    written.push(configRel);
    const hooksFile = path.join(projectRoot, hooksRel);
    const omniHooks = JSON.parse(buildCodexHooks('dual', true, { dualPair: 'codex-agy', mode: 'auto', projectDir: projectRoot }));
    fsImpl.writeFileSync(hooksFile, `${JSON.stringify(mergeHooks(readJsonObject(hooksFile, fsImpl), omniHooks), null, 2)}\n`);
    written.push(hooksRel);
    if (!fsImpl.existsSync(path.join(projectRoot, 'AGENTS.md'))) {
        warnings.push({ code: 'SQUAD_AGENTS_MD_MISSING', message: 'AGENTS.md is missing: run "omni init --ide dual" so the orchestrator gets the dual controller rules' });
    }
    return { written, warnings };
}

// Whether the project carries the omni_dual MCP server and hooks for a codex orchestrator.
function hasCodexOrchestratorMcp(projectRoot, fsImpl = fs) {
    try {
        const config = fsImpl.readFileSync(path.join(projectRoot, '.codex', 'config.toml'), 'utf8');
        return config.includes(SERVER_HEADER) && /\[features\][^[]*\bhooks\s*=\s*true/.test(config)
            && fsImpl.existsSync(path.join(projectRoot, '.codex', 'hooks.json'));
    } catch {
        return false;
    }
}

module.exports = { writeCodexOrchestratorConfig, hasCodexOrchestratorMcp, mergeConfig, mergeHooks };
