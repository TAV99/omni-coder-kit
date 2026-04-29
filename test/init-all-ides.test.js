const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Helpers extracted from omni.js ──────────────────────────────────────────

function getOverlayNameForTarget(ide, target) {
    if (target === 'claude-code') {
        return (ide === 'claudecode' || ide === 'dual') ? 'claude-code' : null;
    }
    if (target === 'codex') {
        return (ide === 'codex' || ide === 'dual') ? 'codex' : null;
    }
    if (target === 'cursor') {
        return (ide === 'cursor') ? 'cursor' : null;
    }
    return null;
}

function getOverlayDir(ide, target = null) {
    const overlayName = target
        ? getOverlayNameForTarget(ide, target)
        : ({ claudecode: 'claude-code', dual: 'claude-code', cursor: 'cursor' }[ide] || null);
    if (!overlayName) return null;
    const dir = path.join(TEMPLATES, 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide, target = null, options = {}) {
    const baseDir = path.join(TEMPLATES, 'workflows');
    const files = {};
    for (const f of fs.readdirSync(baseDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(baseDir, f);
    }
    const overlayDir = getOverlayDir(ide, target);
    if (overlayDir) {
        const overlayWorkflowDir = path.join(overlayDir, 'workflows');
        if (fs.existsSync(overlayWorkflowDir)) {
            for (const f of fs.readdirSync(overlayWorkflowDir).filter(f => f.endsWith('.md'))) {
                if (!options.subagents && f === 'coder-execution.md'
                    && path.basename(overlayDir) === 'claude-code') continue;
                files[f] = path.join(overlayWorkflowDir, f);
            }
        }
    }
    return files;
}

function buildCommands(ide) {
    if (!(ide === 'claudecode' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'claude-code');
    if (!overlayDir) return null;
    const commandsDir = path.join(overlayDir, 'commands');
    if (!fs.existsSync(commandsDir)) return null;
    const files = {};
    for (const f of fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(commandsDir, f);
    }
    return Object.keys(files).length > 0 ? files : null;
}

function buildSettings(ide, advanced) {
    if (!advanced) return null;
    const overlayDir = getOverlayDir(ide);
    if (!overlayDir) return null;
    const templatePath = path.join(overlayDir, 'settings.template.json');
    if (!fs.existsSync(templatePath)) return null;
    return fs.readFileSync(templatePath, 'utf-8');
}

function buildCodexConfig(ide, advanced) {
    if (!advanced || !(ide === 'codex' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'codex');
    if (!overlayDir) return null;
    const templatePath = path.join(overlayDir, 'config.template.toml');
    if (!fs.existsSync(templatePath)) return null;
    return fs.readFileSync(templatePath, 'utf-8');
}

function buildCodexHooks(ide, advanced) {
    if (!advanced || !(ide === 'codex' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'codex');
    if (!overlayDir) return null;
    const templatePath = path.join(overlayDir, 'hooks.template.json');
    if (!fs.existsSync(templatePath)) return null;
    return fs.readFileSync(templatePath, 'utf-8');
}

function readTemplate(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}

const OMNI_GITIGNORE_PATTERNS = [
    '.omni/',
];

function ensureGitignore(ide, cwd) {
    const gitignorePath = path.join(cwd, '.gitignore');
    const patterns = [...OMNI_GITIGNORE_PATTERNS];
    if (ide === 'claudecode' || ide === 'dual') patterns.push('.claude/');
    if (ide === 'codex' || ide === 'dual') patterns.push('.codex/');
    if (ide === 'cursor') patterns.push('.cursor/');

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
    }
    const existingLines = new Set(existing.split('\n').map(l => l.trim()));
    const missing = patterns.filter(p => !existingLines.has(p));
    if (missing.length === 0) return 0;

    const block = `\n# Omni-Coder Kit (generated)\n${missing.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, existing.trimEnd() + '\n' + block, 'utf-8');
    return missing.length;
}

// ─── Expected config file per IDE ────────────────────────────────────────────

const { IDE_CONFIG_FILE: IDE_CONFIG_MAP } = require(path.join(__dirname, '..', 'lib', 'helpers'));

// ─── Temp dir helper ─────────────────────────────────────────────────────────

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-init-test-'));
}

// ─── Simulate init for any IDE ───────────────────────────────────────────────

function simulateInit(ide, opts = {}) {
    const tmpDir = makeTmpDir();
    const result = { tmpDir, files: {} };

    const mindset = readTemplate(path.join(TEMPLATES, 'core', 'karpathy-mindset.md'));
    const hygiene = readTemplate(path.join(TEMPLATES, 'core', 'claudex-hygiene.md'));

    // Workflows
    const workflowsDir = path.join(tmpDir, '.omni', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    const workflowTarget = ide === 'codex' ? 'codex' : ide === 'gemini' ? 'gemini' : ide === 'cursor' ? 'cursor' : ide === 'dual' ? 'base' : null;
    const mergedWorkflows = buildWorkflows(ide, workflowTarget, { subagents: !!opts.subagents });
    for (const [name, srcPath] of Object.entries(mergedWorkflows)) {
        fs.copyFileSync(srcPath, path.join(workflowsDir, name));
    }
    result.files.workflows = Object.keys(mergedWorkflows);

    // Config file
    const fileName = IDE_CONFIG_MAP[ide];
    let content = `> Generated by Omni-Coder Kit\n\n${mindset}\n\n${hygiene}\n\n`;
    content += `## IDE SPECIFIC ADAPTERS\n`;

    fs.writeFileSync(path.join(tmpDir, fileName), content);
    result.files.configFile = fileName;

    // Slash commands (Claude Code only)
    const slashCommands = buildCommands(ide);
    if (slashCommands) {
        const claudeCommandsDir = path.join(tmpDir, '.claude', 'commands');
        fs.mkdirSync(claudeCommandsDir, { recursive: true });
        for (const [name, srcPath] of Object.entries(slashCommands)) {
            fs.copyFileSync(srcPath, path.join(claudeCommandsDir, name));
        }
        result.files.commands = Object.keys(slashCommands);
    }

    // Claude settings (advanced)
    if (opts.advanced) {
        const settings = buildSettings(ide, true);
        if (settings) {
            const claudeDir = path.join(tmpDir, '.claude');
            fs.mkdirSync(claudeDir, { recursive: true });
            fs.writeFileSync(path.join(claudeDir, 'settings.json'), settings);
            result.files.settings = true;
        }

        const codexConfig = buildCodexConfig(ide, true);
        const codexHooks = buildCodexHooks(ide, true);
        if (codexConfig || codexHooks) {
            const codexDir = path.join(tmpDir, '.codex');
            fs.mkdirSync(codexDir, { recursive: true });
            if (codexConfig) fs.writeFileSync(path.join(codexDir, 'config.toml'), codexConfig);
            if (codexHooks) fs.writeFileSync(path.join(codexDir, 'hooks.json'), codexHooks);
            result.files.codexConfig = !!codexConfig;
            result.files.codexHooks = !!codexHooks;
        }
    }

    // Cursor advanced
    if (ide === 'cursor' && opts.advanced) {
        const cursorRulesDir = path.join(tmpDir, '.cursor', 'rules');
        fs.mkdirSync(cursorRulesDir, { recursive: true });

        const overlayRulesDir = path.join(TEMPLATES, 'overlays', 'cursor', 'rules');
        if (fs.existsSync(overlayRulesDir)) {
            const dna = opts.dna || { hasUI: true, hasBackend: true };
            const alwaysInclude = ['core-mindset.mdc', 'workflow-commands.mdc', 'yolo-guardrails.mdc', 'agent-mode.mdc'];
            const conditionalMap = { 'frontend.mdc': dna.hasUI, 'backend.mdc': dna.hasBackend, 'testing.mdc': true };

            for (const f of alwaysInclude) {
                const src = path.join(overlayRulesDir, f);
                if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cursorRulesDir, f));
            }
            for (const [f, include] of Object.entries(conditionalMap)) {
                if (include) {
                    const src = path.join(overlayRulesDir, f);
                    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cursorRulesDir, f));
                }
            }
        }

        result.files.cursorRules = fs.readdirSync(cursorRulesDir);

        const cursorDir = path.join(tmpDir, '.cursor');
        const mcpConfig = { mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } };
        fs.writeFileSync(path.join(cursorDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
        result.files.mcpConfig = true;
    }

    // Dual mode: AGENTS.md
    if (ide === 'dual') {
        const agentsContent = `> Generated by Omni-Coder Kit (Codex CLI / Cross-tool)\n\n${mindset}\n\n${hygiene}\n`;
        fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), agentsContent);
        result.files.agentsMd = true;
    }

    // Manifest
    const manifest = {
        version: '2.1.0',
        configFile: fileName,
        ide,
        skills: { external: [] },
    };
    fs.writeFileSync(path.join(tmpDir, '.omni', 'manifest.json'), JSON.stringify(manifest, null, 2));
    result.manifest = manifest;

    // .gitignore
    result.gitignoreCount = ensureGitignore(ide, tmpDir);

    return result;
}

// ─── Claude Code init ────────────────────────────────────────────────────────

describe('E2E: claudecode init', () => {
    let result;

    beforeEach(() => { result = simulateInit('claudecode', { advanced: true, subagents: true }); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates CLAUDE.md', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, 'CLAUDE.md')));
    });

    it('CLAUDE.md includes mindset and hygiene', () => {
        const content = fs.readFileSync(path.join(result.tmpDir, 'CLAUDE.md'), 'utf-8');
        assert.ok(content.includes('CORE MINDSET'));
        assert.ok(content.includes('CONTEXT HYGIENE'));
    });

    it('creates all base workflows in .omni/workflows/', () => {
        const baseWorkflows = fs.readdirSync(path.join(TEMPLATES, 'workflows')).filter(f => f.endsWith('.md'));
        const outputWorkflows = fs.readdirSync(path.join(result.tmpDir, '.omni', 'workflows'));
        for (const wf of baseWorkflows) {
            assert.ok(outputWorkflows.includes(wf), `${wf} should exist`);
        }
    });

    it('applies claude-code workflow overlay (coder-execution.md) with subagents', () => {
        const content = fs.readFileSync(path.join(result.tmpDir, '.omni', 'workflows', 'coder-execution.md'), 'utf-8');
        const overlayContent = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.equal(content, overlayContent);
    });

    it('uses base coder-execution.md without subagents', () => {
        const noSubResult = simulateInit('claudecode', { advanced: true, subagents: false });
        try {
            const content = fs.readFileSync(
                path.join(noSubResult.tmpDir, '.omni', 'workflows', 'coder-execution.md'), 'utf-8'
            );
            const baseContent = fs.readFileSync(
                path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
            );
            assert.equal(content, baseContent);
        } finally {
            fs.rmSync(noSubResult.tmpDir, { recursive: true, force: true });
        }
    });

    it('creates 9 slash commands in .claude/commands/', () => {
        const cmdsDir = path.join(result.tmpDir, '.claude', 'commands');
        assert.ok(fs.existsSync(cmdsDir));
        const cmds = fs.readdirSync(cmdsDir).filter(f => f.endsWith('.md'));
        assert.equal(cmds.length, 9);
        assert.ok(cmds.includes('om:brainstorm.md'));
        assert.ok(cmds.includes('om:cook.md'));
        assert.ok(cmds.includes('om:plan.md'));
        assert.ok(cmds.includes('om:check.md'));
        assert.ok(cmds.includes('om:fix.md'));
        assert.ok(cmds.includes('om:doc.md'));
        assert.ok(cmds.includes('om:equip.md'));
        assert.ok(cmds.includes('om:learn.md'));
        assert.ok(cmds.includes('om:map.md'));
    });

    it('creates .claude/settings.json with advanced setup', () => {
        const settingsPath = path.join(result.tmpDir, '.claude', 'settings.json');
        assert.ok(fs.existsSync(settingsPath));
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        assert.ok(settings.permissions);
        assert.ok(settings.permissions.allow.length > 0);
        assert.ok(settings.permissions.deny.length > 0);
        assert.ok(settings.hooks);
    });

    it('settings.json deny list includes dangerous commands', () => {
        const settings = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.claude', 'settings.json'), 'utf-8')
        );
        const deny = settings.permissions.deny;
        assert.ok(deny.some(d => d.includes('rm -rf')));
        assert.ok(deny.some(d => d.includes('push --force')));
        assert.ok(deny.some(d => d.includes('reset --hard')));
    });

    it('creates manifest with correct IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'claudecode');
        assert.equal(manifest.configFile, 'CLAUDE.md');
    });

    it('does NOT create codex files', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.codex')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, 'AGENTS.md')));
    });
});

// ─── Claude Code overlay content integrity ───────────────────────────────────

describe('Claude Code overlay content integrity', () => {
    it('coder-execution.md references subagent delegation', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('sub-agent') || content.includes('subagent') || content.includes('Sub-Agent'));
    });

    it('superpower-sdlc.md references Claude Code slash commands', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'superpower-sdlc.md'), 'utf-8'
        );
        assert.ok(content.includes('/om:') || content.includes('>om:'));
    });

    it('all 9 slash command files reference workflow paths', () => {
        const cmdsDir = path.join(TEMPLATES, 'overlays', 'claude-code', 'commands');
        const cmds = fs.readdirSync(cmdsDir).filter(f => f.endsWith('.md'));
        for (const cmd of cmds) {
            const content = fs.readFileSync(path.join(cmdsDir, cmd), 'utf-8');
            assert.ok(
                content.includes('.omni/workflows/') || content.includes('omni/workflows'),
                `${cmd} should reference workflow file`
            );
        }
    });

    it('settings.template.json is valid JSON', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'claude-code', 'settings.template.json'), 'utf-8'
        );
        assert.doesNotThrow(() => JSON.parse(content));
    });
});

// ─── Subagent mode: Claude Code ─────────────────────────────────────────────

describe('Subagent mode: claudecode', () => {
    it('subagents=true applies claude-code overlay for coder-execution', () => {
        const wf = buildWorkflows('claudecode', null, { subagents: true });
        const coderPath = wf['coder-execution.md'];
        assert.ok(coderPath.includes(path.join('overlays', 'claude-code')));
    });

    it('subagents=false uses base coder-execution (no parallel agents)', () => {
        const wf = buildWorkflows('claudecode', null, { subagents: false });
        const coderPath = wf['coder-execution.md'];
        assert.ok(!coderPath.includes('overlays'));
    });

    it('subagents=false still applies non-coder-execution overlays', () => {
        const wf = buildWorkflows('claudecode', null, { subagents: false });
        const sdlcPath = wf['superpower-sdlc.md'];
        assert.ok(sdlcPath.includes(path.join('overlays', 'claude-code')));
    });

    it('codex overlay is not affected by subagents flag', () => {
        const wf = buildWorkflows('codex', 'codex', { subagents: false });
        const coderPath = wf['coder-execution.md'];
        assert.ok(coderPath.includes(path.join('overlays', 'codex')));
    });

    it('cursor overlay is not affected by subagents flag', () => {
        const wf = buildWorkflows('cursor', null, { subagents: false });
        const coderPath = wf['coder-execution.md'];
        assert.ok(coderPath.includes(path.join('overlays', 'cursor')));
    });
});

// ─── TDD + Verification content in workflows ──────────────────────────────

describe('TDD + Verification content embedded in workflows', () => {
    it('base coder-execution.md includes TDD discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('TDD Discipline'));
        assert.ok(content.includes('Red-Green-Refactor'));
    });

    it('base coder-execution.md includes verification discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('Verification Discipline'));
        assert.ok(content.includes('Evidence Before Claims'));
    });

    it('base qa-testing.md includes verification discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'workflows', 'qa-testing.md'), 'utf-8'
        );
        assert.ok(content.includes('Verification Discipline'));
    });

    it('claude-code overlay coder-execution.md includes TDD discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('TDD Discipline'));
    });

    it('codex overlay coder-execution.md includes TDD discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('TDD Discipline'));
    });

    it('cursor overlay coder-execution.md includes TDD discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'cursor', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('TDD Discipline'));
    });

    it('gemini qa-testing overlay includes verification discipline', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'gemini', 'workflows', 'qa-testing.md'), 'utf-8'
        );
        assert.ok(content.includes('Verification Discipline'));
    });
});

// ─── Dual init ───────────────────────────────────────────────────────────────

describe('E2E: dual init', () => {
    let result;

    beforeEach(() => { result = simulateInit('dual', { advanced: true }); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates both CLAUDE.md and AGENTS.md', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, 'CLAUDE.md')));
        assert.ok(fs.existsSync(path.join(result.tmpDir, 'AGENTS.md')));
    });

    it('creates Claude slash commands', () => {
        const cmdsDir = path.join(result.tmpDir, '.claude', 'commands');
        assert.ok(fs.existsSync(cmdsDir));
        assert.equal(fs.readdirSync(cmdsDir).filter(f => f.endsWith('.md')).length, 9);
    });

    it('creates Claude settings', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, '.claude', 'settings.json')));
    });

    it('creates Codex config and hooks', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, '.codex', 'config.toml')));
        assert.ok(fs.existsSync(path.join(result.tmpDir, '.codex', 'hooks.json')));
    });

    it('workflows use base (no overlay) for dual mode', () => {
        const content = fs.readFileSync(
            path.join(result.tmpDir, '.omni', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        const baseContent = fs.readFileSync(
            path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.equal(content, baseContent);
    });

    it('manifest records dual IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'dual');
    });
});

// ─── Antigravity init ────────────────────────────────────────────────────────

describe('E2E: antigravity init', () => {
    let result;

    beforeEach(() => { result = simulateInit('antigravity'); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates AGENTS.md', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, 'AGENTS.md')));
    });

    it('does NOT create CLAUDE.md', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, 'CLAUDE.md')));
    });

    it('does NOT create .claude/ directory', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.claude')));
    });

    it('does NOT create .codex/ directory', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.codex')));
    });

    it('creates all workflows', () => {
        const baseWorkflows = fs.readdirSync(path.join(TEMPLATES, 'workflows')).filter(f => f.endsWith('.md'));
        const outputWorkflows = fs.readdirSync(path.join(result.tmpDir, '.omni', 'workflows'));
        for (const wf of baseWorkflows) {
            assert.ok(outputWorkflows.includes(wf));
        }
    });

    it('uses base workflows (no overlay)', () => {
        const content = fs.readFileSync(
            path.join(result.tmpDir, '.omni', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        const baseContent = fs.readFileSync(
            path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.equal(content, baseContent);
    });

    it('manifest records antigravity IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'antigravity');
        assert.equal(manifest.configFile, 'AGENTS.md');
    });
});

// ─── Cursor init ─────────────────────────────────────────────────────────────

describe('E2E: cursor init', () => {
    let result;

    beforeEach(() => { result = simulateInit('cursor'); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates .cursorrules', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, '.cursorrules')));
    });

    it('.cursorrules includes mindset', () => {
        const content = fs.readFileSync(path.join(result.tmpDir, '.cursorrules'), 'utf-8');
        assert.ok(content.includes('CORE MINDSET'));
    });

    it('does NOT create .claude/ or .codex/', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.claude')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.codex')));
    });

    it('does NOT create slash commands', () => {
        assert.equal(result.files.commands, undefined);
    });

    it('manifest records cursor IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'cursor');
        assert.equal(manifest.configFile, '.cursorrules');
    });
});

// ─── Cursor advanced init ───────────────────────────────────────────────────

describe('E2E: cursor advanced init', () => {
    let result;

    beforeEach(() => { result = simulateInit('cursor', { advanced: true }); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates .cursor/rules/ with MDC files', () => {
        const rulesDir = path.join(result.tmpDir, '.cursor', 'rules');
        assert.ok(fs.existsSync(rulesDir));
        const files = fs.readdirSync(rulesDir);
        assert.ok(files.includes('core-mindset.mdc'));
        assert.ok(files.includes('workflow-commands.mdc'));
        assert.ok(files.includes('yolo-guardrails.mdc'));
        assert.ok(files.includes('agent-mode.mdc'));
        assert.ok(files.includes('testing.mdc'));
    });

    it('creates .cursor/mcp.json', () => {
        const mcpPath = path.join(result.tmpDir, '.cursor', 'mcp.json');
        assert.ok(fs.existsSync(mcpPath));
        const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        assert.ok(config.mcpServers);
        assert.ok(config.mcpServers.context7);
    });

    it('includes frontend.mdc and backend.mdc with fullstack DNA', () => {
        const rulesDir = path.join(result.tmpDir, '.cursor', 'rules');
        const files = fs.readdirSync(rulesDir);
        assert.ok(files.includes('frontend.mdc'));
        assert.ok(files.includes('backend.mdc'));
    });

    it('excludes frontend.mdc when hasUI=false', () => {
        fs.rmSync(result.tmpDir, { recursive: true, force: true });
        result = simulateInit('cursor', { advanced: true, dna: { hasUI: false, hasBackend: true } });
        const files = fs.readdirSync(path.join(result.tmpDir, '.cursor', 'rules'));
        assert.ok(!files.includes('frontend.mdc'));
        assert.ok(files.includes('backend.mdc'));
    });

    it('does NOT create .claude/ or .codex/', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.claude')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.codex')));
    });

    it('manifest records cursor IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'cursor');
        assert.equal(manifest.configFile, '.cursorrules');
    });
});

// ─── Cursor overlay content integrity ───────────────────────────────────────

describe('Cursor overlay content integrity', () => {
    it('coder-execution.md references YOLO mode', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'cursor', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('YOLO'));
    });

    it('coder-execution.md references @Files context gathering', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'cursor', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('@Files') || content.includes('@Codebase'));
    });

    it('superpower-sdlc.md references Cursor native tools', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'cursor', 'workflows', 'superpower-sdlc.md'), 'utf-8'
        );
        assert.ok(content.includes('@Codebase'));
        assert.ok(content.includes('@Files'));
        assert.ok(content.includes('Agent mode'));
    });
});

// ─── Cursor overlay template files exist ────────────────────────────────────

describe('Cursor overlay template files exist', () => {
    const requiredFiles = [
        'overlays/cursor/rules/core-mindset.mdc',
        'overlays/cursor/rules/workflow-commands.mdc',
        'overlays/cursor/rules/backend.mdc',
        'overlays/cursor/rules/frontend.mdc',
        'overlays/cursor/rules/testing.mdc',
        'overlays/cursor/rules/yolo-guardrails.mdc',
        'overlays/cursor/rules/agent-mode.mdc',
        'overlays/cursor/workflows/coder-execution.md',
        'overlays/cursor/workflows/superpower-sdlc.md',
    ];

    for (const file of requiredFiles) {
        it(`${file} exists`, () => {
            assert.ok(fs.existsSync(path.join(TEMPLATES, file)));
        });
    }
});

// ─── Windsurf init ───────────────────────────────────────────────────────────

describe('E2E: windsurf init', () => {
    let result;

    beforeEach(() => { result = simulateInit('windsurf'); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates .windsurfrules', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, '.windsurfrules')));
    });

    it('.windsurfrules includes hygiene', () => {
        const content = fs.readFileSync(path.join(result.tmpDir, '.windsurfrules'), 'utf-8');
        assert.ok(content.includes('CONTEXT HYGIENE'));
    });

    it('does NOT create .claude/ or .codex/', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.claude')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.codex')));
    });

    it('manifest records windsurf IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'windsurf');
        assert.equal(manifest.configFile, '.windsurfrules');
    });
});

// ─── Cross-tool (agents) init ────────────────────────────────────────────────

describe('E2E: agents init', () => {
    let result;

    beforeEach(() => { result = simulateInit('agents'); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates AGENTS.md', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, 'AGENTS.md')));
    });

    it('does NOT create CLAUDE.md', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, 'CLAUDE.md')));
    });

    it('manifest records agents IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'agents');
        assert.equal(manifest.configFile, 'AGENTS.md');
    });
});

// ─── Generic init ────────────────────────────────────────────────────────────

describe('E2E: generic init', () => {
    let result;

    beforeEach(() => { result = simulateInit('generic'); });
    afterEach(() => { fs.rmSync(result.tmpDir, { recursive: true, force: true }); });

    it('creates SYSTEM_PROMPT.md', () => {
        assert.ok(fs.existsSync(path.join(result.tmpDir, 'SYSTEM_PROMPT.md')));
    });

    it('does NOT create any tool-specific dirs', () => {
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.claude')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, '.codex')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, 'CLAUDE.md')));
        assert.ok(!fs.existsSync(path.join(result.tmpDir, 'AGENTS.md')));
    });

    it('manifest records generic IDE', () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(result.tmpDir, '.omni', 'manifest.json'), 'utf-8')
        );
        assert.equal(manifest.ide, 'generic');
        assert.equal(manifest.configFile, 'SYSTEM_PROMPT.md');
    });
});

// ─── Cross-IDE: no overlay contamination ─────────────────────────────────────

describe('Cross-IDE isolation', () => {
    const nonOverlayIDEs = ['antigravity', 'windsurf', 'agents', 'generic'];

    for (const ide of nonOverlayIDEs) {
        it(`${ide}: workflows are all base (no overlay)`, () => {
            const result = simulateInit(ide);
            try {
                const baseWorkflows = fs.readdirSync(path.join(TEMPLATES, 'workflows')).filter(f => f.endsWith('.md'));
                for (const wf of baseWorkflows) {
                    const outputContent = fs.readFileSync(
                        path.join(result.tmpDir, '.omni', 'workflows', wf), 'utf-8'
                    );
                    const baseContent = fs.readFileSync(
                        path.join(TEMPLATES, 'workflows', wf), 'utf-8'
                    );
                    assert.equal(outputContent, baseContent, `${ide}:${wf} should match base`);
                }
            } finally {
                fs.rmSync(result.tmpDir, { recursive: true, force: true });
            }
        });
    }
});

// ─── Overlay system: buildSettings edge cases ────────────────────────────────

describe('buildSettings', () => {
    it('returns settings for claudecode + advanced', () => {
        const s = buildSettings('claudecode', true);
        assert.ok(s);
        const parsed = JSON.parse(s);
        assert.ok(parsed.permissions);
    });

    it('returns settings for dual + advanced', () => {
        assert.ok(buildSettings('dual', true));
    });

    it('returns null when advanced is false', () => {
        assert.equal(buildSettings('claudecode', false), null);
    });

    it('returns null for codex (no claude settings)', () => {
        assert.equal(buildSettings('codex', true), null);
    });

    it('returns null for cursor', () => {
        assert.equal(buildSettings('cursor', true), null);
    });

    it('returns null for generic', () => {
        assert.equal(buildSettings('generic', true), null);
    });
});

// ─── Overlay template file completeness ──────────────────────────────────────

describe('Claude Code overlay template files exist', () => {
    const requiredFiles = [
        'overlays/claude-code/settings.template.json',
        'overlays/claude-code/commands/om:brainstorm.md',
        'overlays/claude-code/commands/om:cook.md',
        'overlays/claude-code/commands/om:plan.md',
        'overlays/claude-code/commands/om:check.md',
        'overlays/claude-code/commands/om:fix.md',
        'overlays/claude-code/commands/om:doc.md',
        'overlays/claude-code/commands/om:equip.md',
        'overlays/claude-code/workflows/coder-execution.md',
        'overlays/claude-code/workflows/superpower-sdlc.md',
    ];

    for (const file of requiredFiles) {
        it(`${file} exists`, () => {
            assert.ok(fs.existsSync(path.join(TEMPLATES, file)));
        });
    }
});

// ─── .gitignore generation ──────────────────────────────────────────────────

describe('.gitignore generation', () => {
    it('creates .gitignore with base patterns for all IDEs', () => {
        const result = simulateInit('cursor');
        try {
            const content = fs.readFileSync(path.join(result.tmpDir, '.gitignore'), 'utf-8');
            for (const p of OMNI_GITIGNORE_PATTERNS) {
                assert.ok(content.includes(p), `should contain ${p}`);
            }
        } finally {
            fs.rmSync(result.tmpDir, { recursive: true, force: true });
        }
    });

    it('claudecode adds .claude/ pattern', () => {
        const result = simulateInit('claudecode', { advanced: true });
        try {
            const content = fs.readFileSync(path.join(result.tmpDir, '.gitignore'), 'utf-8');
            assert.ok(content.includes('.claude/'));
            assert.ok(!content.includes('.codex/'));
        } finally {
            fs.rmSync(result.tmpDir, { recursive: true, force: true });
        }
    });

    it('codex adds .codex/ pattern', () => {
        const result = simulateInit('codex', { advanced: true });
        try {
            const content = fs.readFileSync(path.join(result.tmpDir, '.gitignore'), 'utf-8');
            assert.ok(content.includes('.codex/'));
            assert.ok(!content.includes('.claude/'));
        } finally {
            fs.rmSync(result.tmpDir, { recursive: true, force: true });
        }
    });

    it('dual adds both .claude/ and .codex/', () => {
        const result = simulateInit('dual', { advanced: true });
        try {
            const content = fs.readFileSync(path.join(result.tmpDir, '.gitignore'), 'utf-8');
            assert.ok(content.includes('.claude/'));
            assert.ok(content.includes('.codex/'));
        } finally {
            fs.rmSync(result.tmpDir, { recursive: true, force: true });
        }
    });

    it('cursor adds .cursor/ pattern', () => {
        const result = simulateInit('cursor', { advanced: true });
        try {
            const content = fs.readFileSync(path.join(result.tmpDir, '.gitignore'), 'utf-8');
            assert.ok(content.includes('.cursor/'));
            assert.ok(!content.includes('.claude/'));
            assert.ok(!content.includes('.codex/'));
        } finally {
            fs.rmSync(result.tmpDir, { recursive: true, force: true });
        }
    });

    it('merges with existing .gitignore without duplicates', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gi-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.omni/\n');
            ensureGitignore('cursor', tmpDir);
            const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
            assert.ok(content.includes('node_modules/'));
            const matches = content.match(/\.omni\//g);
            assert.equal(matches.length, 1, '.omni/ should not be duplicated');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips writing when all patterns already exist', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gi-test-'));
        try {
            const allPatterns = [...OMNI_GITIGNORE_PATTERNS, '.cursor/'].join('\n') + '\n';
            fs.writeFileSync(path.join(tmpDir, '.gitignore'), allPatterns);
            const count = ensureGitignore('cursor', tmpDir);
            assert.equal(count, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes Omni-Coder Kit header comment', () => {
        const result = simulateInit('generic');
        try {
            const content = fs.readFileSync(path.join(result.tmpDir, '.gitignore'), 'utf-8');
            assert.ok(content.includes('# Omni-Coder Kit'));
        } finally {
            fs.rmSync(result.tmpDir, { recursive: true, force: true });
        }
    });
});

// ─── Project Map — init integration ─────────────────────────────────────

describe('Project Map — init integration', () => {
    const { detectExistingProject, scanProject, generateMapSkeleton } = require(path.join(__dirname, '..', 'lib', 'scanner'));

    it('detectExistingProject returns true for this project', () => {
        const result = detectExistingProject(path.join(__dirname, '..'));
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('Node.js'));
    });

    it('scanProject returns valid structure for this project', () => {
        const result = scanProject(path.join(__dirname, '..'));
        assert.ok(result.stats.files > 10);
        assert.ok(result.structure.length > 0);
        assert.equal(result.techStack.runtime, 'Node.js');
    });

    it('generateMapSkeleton produces valid markdown', () => {
        const scan = scanProject(path.join(__dirname, '..'));
        const md = generateMapSkeleton(scan, 'omni-coder-kit');
        assert.ok(md.startsWith('# Project Map'));
        assert.ok(md.includes('## Tech Stack'));
        assert.ok(md.includes('## Structure'));
        assert.ok(md.includes('[PENDING]'));
    });

    it('base project-map.md workflow exists', () => {
        const baseWorkflow = path.join(__dirname, '..', 'templates', 'workflows', 'project-map.md');
        assert.ok(fs.existsSync(baseWorkflow), 'Base project-map.md workflow should exist');
    });
});
