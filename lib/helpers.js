'use strict';

const fs = require('fs');
const path = require('path');

const PKG = require(path.join(__dirname, '..', 'package.json'));

const IDE_AGENT_MAP = {
    claudecode:  ['claude-code'],
    gemini:      ['gemini'],
    codex:       ['codex'],
    dual:        ['claude-code', 'codex'],
    antigravity: ['antigravity'],
    cursor:      ['cursor'],
    windsurf:    ['windsurf'],
    agents:      ['claude-code', 'codex', 'antigravity'],
    generic:     null,
};

const IDE_CONFIG_FILE = {
    claudecode: 'CLAUDE.md',
    gemini:     'GEMINI.md',
    codex:      'AGENTS.md',
    dual:       'CLAUDE.md',
    antigravity:'AGENTS.md',
    agents:     'AGENTS.md',
    cursor:     '.cursorrules',
    windsurf:   '.windsurfrules',
    generic:    'SYSTEM_PROMPT.md',
};

function parseSource(raw) {
    if (!raw) return null;
    let cleaned = raw.trim().replace(/\/+$/, '');
    const urlMatch = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(?:\/.+)?)$/);
    if (urlMatch) cleaned = urlMatch[1];
    const sshMatch = cleaned.match(/^git@github\.com:([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/);
    if (sshMatch) cleaned = sshMatch[1];
    cleaned = cleaned.replace(/\.git$/, '');
    if (cleaned.includes('..')) return null;
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(\/.+)?$/.test(cleaned)) return null;
    return cleaned;
}

function isValidSkillName(name) {
    return /^[a-z0-9-]+$/.test(name);
}

function createManifest() {
    return { version: PKG.version, configFile: null, skills: { external: [] } };
}

function getAgentFlags(manifest) {
    const agents = IDE_AGENT_MAP[manifest.ide];
    if (!agents) return '';
    return `--agent ${agents.join(' ')}`;
}

const OVERLAY_TARGET_MAP = {
    'claude-code': { claudecode: 'claude-code', dual: 'claude-code' },
    'codex':       { codex: 'codex', dual: 'codex' },
    'cursor':      { cursor: 'cursor' },
    'gemini':      { gemini: 'gemini' },
};

function getOverlayNameForTarget(ide, target) {
    const mapping = OVERLAY_TARGET_MAP[target];
    return (mapping && mapping[ide]) || null;
}

const IDE_SKILL_DIR = {
    claudecode:  '.claude/skills',
    gemini:      '.gemini/skills',
    codex:       '.codex/skills',
    dual:        '.claude/skills',
    antigravity: '.codex/skills',
    agents:      '.claude/skills',
    cursor:      '.cursor/skills',
    windsurf:    '.windsurf/skills',
    generic:     '.claude/skills',
};

function classifySource(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();

    if (/^https?:\/\//i.test(trimmed)) {
        return { type: 'url', value: trimmed };
    }

    if (trimmed.startsWith('gh:')) {
        const rest = trimmed.slice(3);
        const parts = rest.split('/');
        if (parts.length < 3) return null;
        return { type: 'github', value: { owner: parts[0], repo: parts[1], path: parts.slice(2).join('/') } };
    }

    if (/^(\.\.?\/|\/)\S+\.md$/i.test(trimmed)) {
        return { type: 'local', value: path.resolve(trimmed) };
    }

    const parsed = parseSource(trimmed);
    if (parsed) return { type: 'registry', value: parsed };

    return null;
}

function getSkillDir(manifest) {
    const ide = manifest.ide || 'claudecode';
    return IDE_SKILL_DIR[ide] || '.claude/skills';
}

function fetchContentSync(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-fsSL', '-A', 'omni-coder-kit', '--max-time', '30', url], {
        encoding: 'utf-8',
        timeout: 35000,
    });
}

function githubRawURL(owner, repo, filePath, branch) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${filePath}`;
}

function detectDNA(projectDir) {
    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Warning: cannot read package.json: ${err.message}`);
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;
    const dirExists = (name) => fs.existsSync(path.join(projectDir, name));
    return {
        hasUI: hasDep('react') || hasDep('vue') || hasDep('svelte') || hasDep('next') || hasDep('@angular/core'),
        hasBackend: hasDep('express') || hasDep('fastify') || hasDep('hono') || hasDep('prisma') || hasDep('@supabase/supabase-js') || dirExists('server') || dirExists('api'),
        hasAPI: hasDep('express') || hasDep('fastify') || hasDep('hono') || dirExists('routes') || dirExists('controllers'),
    };
}

module.exports = {
    IDE_AGENT_MAP,
    IDE_CONFIG_FILE,
    IDE_SKILL_DIR,
    parseSource,
    isValidSkillName,
    createManifest,
    getAgentFlags,
    getOverlayNameForTarget,
    classifySource,
    getSkillDir,
    fetchContentSync,
    githubRawURL,
    detectDNA,
};
