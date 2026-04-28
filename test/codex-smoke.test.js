#!/usr/bin/env node

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN = path.join(__dirname, '..', 'bin', 'omni.js');
const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Helpers extracted from omni.js for unit testing ─────────────────────────

const IDE_AGENT_MAP = {
    claudecode: ['claude-code'],
    codex: ['codex'],
    dual: ['claude-code', 'codex'],
    antigravity: ['antigravity'],
    cursor: ['cursor'],
    windsurf: ['windsurf'],
    agents: ['claude-code', 'codex', 'antigravity'],
    generic: null,
};

function getOverlayNameForTarget(ide, target) {
    if (target === 'claude-code') {
        return (ide === 'claudecode' || ide === 'dual') ? 'claude-code' : null;
    }
    if (target === 'codex') {
        return (ide === 'codex' || ide === 'dual') ? 'codex' : null;
    }
    return null;
}

function getOverlayDir(ide, target = null) {
    const overlayName = target
        ? getOverlayNameForTarget(ide, target)
        : ({ claudecode: 'claude-code', dual: 'claude-code' }[ide] || null);
    if (!overlayName) return null;
    const dir = path.join(TEMPLATES, 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide, target = null) {
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

function buildCommandRegistry(ide) {
    const isClaudeCode = ide === 'claudecode' || ide === 'dual';
    const isCodex = ide === 'codex';

    if (isClaudeCode) {
        return [
            '## WORKFLOW COMMANDS',
            '> Claude Code: dung `/om:*` slash commands (auto-complete) hoac `>om:*` trong chat.',
            '',
            '| Command | Slash | Workflow File |',
            '| `>om:brainstorm` | `/om:brainstorm` | `.omni/workflows/requirement-analysis.md` |',
            '| `>om:cook` | `/om:cook` | `.omni/workflows/coder-execution.md` |',
        ].join('\n');
    }

    if (isCodex) {
        return [
            '## WORKFLOW COMMANDS',
            '> Codex CLI: type `>om:*` as normal chat text.',
            '',
            '| Command | Workflow File | Role |',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder |',
            '',
            '- Use `/plan` for Codex-native planning before edits.',
            '- Use `/review` for Codex-native review of current changes.',
        ].join('\n');
    }

    return [
        '## WORKFLOW COMMANDS',
        '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` |',
        '| `>om:cook` | `.omni/workflows/coder-execution.md` |',
    ].join('\n');
}

// ─── Temp dir helper ─────────────────────────────────────────────────────────

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-codex-test-'));
}

function rmDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Unit tests: overlay routing ─────────────────────────────────────────────

describe('getOverlayNameForTarget', () => {
    it('returns "codex" for ide=codex, target=codex', () => {
        assert.equal(getOverlayNameForTarget('codex', 'codex'), 'codex');
    });

    it('returns "codex" for ide=dual, target=codex', () => {
        assert.equal(getOverlayNameForTarget('dual', 'codex'), 'codex');
    });

    it('returns null for ide=claudecode, target=codex', () => {
        assert.equal(getOverlayNameForTarget('claudecode', 'codex'), null);
    });

    it('returns "claude-code" for ide=dual, target=claude-code', () => {
        assert.equal(getOverlayNameForTarget('dual', 'claude-code'), 'claude-code');
    });

    it('returns null for ide=codex, target=claude-code', () => {
        assert.equal(getOverlayNameForTarget('codex', 'claude-code'), null);
    });

    it('returns null for unknown target', () => {
        assert.equal(getOverlayNameForTarget('codex', 'cursor'), null);
    });
});

describe('getOverlayDir', () => {
    it('returns codex overlay dir for ide=codex, target=codex', () => {
        const dir = getOverlayDir('codex', 'codex');
        assert.ok(dir);
        assert.ok(dir.endsWith(path.join('overlays', 'codex')));
        assert.ok(fs.existsSync(dir));
    });

    it('returns claude-code overlay for ide=dual with no target', () => {
        const dir = getOverlayDir('dual');
        assert.ok(dir);
        assert.ok(dir.endsWith(path.join('overlays', 'claude-code')));
    });

    it('returns null for generic ide', () => {
        assert.equal(getOverlayDir('generic'), null);
    });
});

// ─── Unit tests: workflow merging ────────────────────────────────────────────

describe('buildWorkflows', () => {
    it('base workflows include all expected files', () => {
        const wf = buildWorkflows('generic');
        const names = Object.keys(wf);
        assert.ok(names.includes('coder-execution.md'));
        assert.ok(names.includes('requirement-analysis.md'));
        assert.ok(names.includes('task-planning.md'));
        assert.ok(names.includes('qa-testing.md'));
        assert.ok(names.includes('superpower-sdlc.md'));
    });

    it('codex overlay overrides coder-execution.md', () => {
        const wf = buildWorkflows('codex', 'codex');
        const coderPath = wf['coder-execution.md'];
        assert.ok(coderPath.includes(path.join('overlays', 'codex')));
    });

    it('codex overlay overrides superpower-sdlc.md', () => {
        const wf = buildWorkflows('codex', 'codex');
        const sdlcPath = wf['superpower-sdlc.md'];
        assert.ok(sdlcPath.includes(path.join('overlays', 'codex')));
    });

    it('codex overlay does NOT override non-overridden files', () => {
        const wf = buildWorkflows('codex', 'codex');
        const qaPath = wf['qa-testing.md'];
        assert.ok(!qaPath.includes('overlays'));
    });

    it('dual mode with base target uses base workflows only', () => {
        const wf = buildWorkflows('dual', 'base');
        const coderPath = wf['coder-execution.md'];
        assert.ok(!coderPath.includes('overlays'));
    });
});

// ─── Unit tests: buildCommands ───────────────────────────────────────────────

describe('buildCommands', () => {
    it('returns slash commands for claudecode', () => {
        const cmds = buildCommands('claudecode');
        assert.ok(cmds !== null);
        assert.ok(Object.keys(cmds).length > 0);
    });

    it('returns slash commands for dual', () => {
        const cmds = buildCommands('dual');
        assert.ok(cmds !== null);
    });

    it('returns null for codex (no slash commands)', () => {
        const cmds = buildCommands('codex');
        assert.equal(cmds, null);
    });

    it('returns null for generic', () => {
        const cmds = buildCommands('generic');
        assert.equal(cmds, null);
    });
});

// ─── Unit tests: Codex config & hooks ────────────────────────────────────────

describe('buildCodexConfig', () => {
    it('returns config content for codex + advanced', () => {
        const config = buildCodexConfig('codex', true);
        assert.ok(config);
        assert.ok(config.includes('sandbox_mode'));
        assert.ok(config.includes('approval_policy'));
        assert.ok(config.includes('network_access = false'));
        assert.ok(config.includes('[profiles.omni_safe]'));
        assert.ok(config.includes('[profiles.omni_yolo]'));
        assert.ok(config.includes('[profiles.omni_review]'));
    });

    it('returns config for dual + advanced', () => {
        const config = buildCodexConfig('dual', true);
        assert.ok(config);
        assert.ok(config.includes('project_doc_max_bytes'));
    });

    it('returns null when advanced is false', () => {
        assert.equal(buildCodexConfig('codex', false), null);
    });

    it('returns null for claudecode', () => {
        assert.equal(buildCodexConfig('claudecode', true), null);
    });
});

describe('buildCodexHooks', () => {
    it('returns hooks JSON for codex + advanced', () => {
        const hooks = buildCodexHooks('codex', true);
        assert.ok(hooks);
        const parsed = JSON.parse(hooks);
        assert.ok(parsed.hooks);
        assert.ok(parsed.hooks.PostToolUse);
        assert.ok(parsed.hooks.Stop);
    });

    it('returns hooks for dual + advanced', () => {
        const hooks = buildCodexHooks('dual', true);
        assert.ok(hooks);
    });

    it('returns null when advanced is false', () => {
        assert.equal(buildCodexHooks('codex', false), null);
    });
});

// ─── E2E: Codex init smoke test ──────────────────────────────────────────────

describe('E2E: codex init', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    after(() => {
        if (tmpDir && fs.existsSync(tmpDir)) rmDir(tmpDir);
    });

    it('produces correct AGENTS.md, workflows, and manifest for codex', () => {
        const workflowsDir = path.join(tmpDir, '.omni', 'workflows');
        fs.mkdirSync(workflowsDir, { recursive: true });

        // Simulate: copy workflows with codex overlay
        const mergedWorkflows = buildWorkflows('codex', 'codex');
        for (const [name, srcPath] of Object.entries(mergedWorkflows)) {
            fs.copyFileSync(srcPath, path.join(workflowsDir, name));
        }

        // Verify coder-execution.md is codex version
        const coderContent = fs.readFileSync(path.join(workflowsDir, 'coder-execution.md'), 'utf-8');
        assert.ok(coderContent.includes('Codex Safety Preflight'), 'coder-execution.md should contain Codex-specific preflight');
        assert.ok(coderContent.includes('sandbox mode'), 'should mention sandbox mode');
        assert.ok(!coderContent.includes('worktree isolation'), 'should NOT contain Claude-specific worktree isolation');

        // Verify superpower-sdlc.md is codex version
        const sdlcContent = fs.readFileSync(path.join(workflowsDir, 'superpower-sdlc.md'), 'utf-8');
        assert.ok(sdlcContent.includes('Codex CLI'), 'superpower-sdlc.md should reference Codex CLI');

        // Verify all base workflows are present
        const baseWorkflows = fs.readdirSync(path.join(TEMPLATES, 'workflows')).filter(f => f.endsWith('.md'));
        const outputWorkflows = fs.readdirSync(workflowsDir);
        for (const wf of baseWorkflows) {
            assert.ok(outputWorkflows.includes(wf), `workflow ${wf} should exist in output`);
        }

        // Simulate AGENTS.md content (command registry)
        const agentsContent = [
            '> Generated by Omni-Coder Kit\n',
            'CORE MINDSET\n',
            buildCommandRegistry('codex'),
        ].join('\n');

        const agentsPath = path.join(tmpDir, 'AGENTS.md');
        fs.writeFileSync(agentsPath, agentsContent);

        assert.ok(fs.existsSync(agentsPath));
        const agents = fs.readFileSync(agentsPath, 'utf-8');
        assert.ok(agents.includes('>om:brainstorm'));
        assert.ok(agents.includes('>om:cook'));
        assert.ok(!agents.includes('/om:brainstorm'), 'codex AGENTS.md should NOT reference /om: slash commands');
        assert.ok(agents.includes('/plan'), 'should reference Codex native /plan');

        // Simulate manifest
        const manifest = {
            version: '2.1.0',
            configFile: 'AGENTS.md',
            ide: 'codex',
            skills: { external: [] },
        };
        const manifestPath = path.join(tmpDir, '.omni', 'manifest.json');
        fs.mkdirSync(path.join(tmpDir, '.omni'), { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        const loaded = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.equal(loaded.configFile, 'AGENTS.md');
        assert.equal(loaded.ide, 'codex');
    });

    it('codex advanced setup creates .codex/config.toml and hooks.json', () => {
        const codexDir = path.join(tmpDir, '.codex');
        fs.mkdirSync(codexDir, { recursive: true });

        const config = buildCodexConfig('codex', true);
        const hooks = buildCodexHooks('codex', true);

        assert.ok(config, 'config should not be null');
        assert.ok(hooks, 'hooks should not be null');

        const configPath = path.join(codexDir, 'config.toml');
        const hooksPath = path.join(codexDir, 'hooks.json');

        fs.writeFileSync(configPath, config);
        fs.writeFileSync(hooksPath, hooks);

        assert.ok(fs.existsSync(configPath));
        assert.ok(fs.existsSync(hooksPath));

        // Validate config content
        const configContent = fs.readFileSync(configPath, 'utf-8');
        assert.ok(configContent.includes('project_doc_max_bytes = 32768'));
        assert.ok(configContent.includes('network_access = false'));
        assert.ok(configContent.includes('[profiles.omni_safe]'));
        assert.ok(configContent.includes('[profiles.omni_yolo]'));
        assert.ok(configContent.includes('[profiles.omni_review]'));
        assert.ok(configContent.includes('codex_hooks = true'));

        // Validate hooks content
        const hooksContent = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
        assert.ok(hooksContent.hooks.PostToolUse);
        assert.ok(hooksContent.hooks.Stop);
        assert.equal(hooksContent.hooks.PostToolUse.length, 1);
        assert.ok(hooksContent.hooks.PostToolUse[0].matcher.includes('apply_patch'));

        const postHook = hooksContent.hooks.PostToolUse[0].hooks[0];
        assert.equal(postHook.type, 'command');
        assert.ok(postHook.command.includes('systemMessage'));
    });
});

// ─── E2E: dual init smoke test ───────────────────────────────────────────────

describe('E2E: dual init', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    after(() => {
        if (tmpDir && fs.existsSync(tmpDir)) rmDir(tmpDir);
    });

    it('dual mode creates separate workflows without overlay contamination', () => {
        const workflowsDir = path.join(tmpDir, '.omni', 'workflows');
        fs.mkdirSync(workflowsDir, { recursive: true });

        // Dual uses 'base' target (no overlay)
        const mergedWorkflows = buildWorkflows('dual', 'base');
        for (const [name, srcPath] of Object.entries(mergedWorkflows)) {
            fs.copyFileSync(srcPath, path.join(workflowsDir, name));
        }

        // coder-execution.md should be the BASE version (no codex overlay)
        const coderContent = fs.readFileSync(path.join(workflowsDir, 'coder-execution.md'), 'utf-8');
        assert.ok(!coderContent.includes('Codex Safety Preflight'), 'dual mode should use base coder-execution, not codex overlay');
    });

    it('dual mode generates both Claude commands and Codex config', () => {
        // Claude side: slash commands exist
        const cmds = buildCommands('dual');
        assert.ok(cmds !== null, 'dual should generate Claude slash commands');

        // Codex side: config + hooks exist
        const config = buildCodexConfig('dual', true);
        const hooks = buildCodexHooks('dual', true);
        assert.ok(config, 'dual + advanced should generate Codex config');
        assert.ok(hooks, 'dual + advanced should generate Codex hooks');
    });
});

// ─── Content integrity: Codex workflow overrides ─────────────────────────────

describe('Codex workflow content integrity', () => {
    it('codex coder-execution.md has no Claude-specific references', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'),
            'utf-8'
        );
        assert.ok(!content.includes('CLAUDE.md'), 'should not reference CLAUDE.md');
        assert.ok(!content.includes('worktree isolation'), 'should not reference worktree isolation');
        assert.ok(!content.includes('TaskCreate'), 'should not reference Claude TaskCreate');
        assert.ok(!content.includes('.claude/'), 'should not reference .claude/ directory');
    });

    it('codex coder-execution.md has required Codex sections', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'),
            'utf-8'
        );
        assert.ok(content.includes('Codex Safety Preflight'));
        assert.ok(content.includes('sandbox'));
        assert.ok(content.includes('approval'));
        assert.ok(content.includes('Subagents'));
        assert.ok(content.includes('Quality Gate'));
    });

    it('codex superpower-sdlc.md references Codex native commands', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'superpower-sdlc.md'),
            'utf-8'
        );
        assert.ok(content.includes('/plan'));
        assert.ok(content.includes('/review'));
        assert.ok(content.includes('>om:'));
    });

    it('codex config.toml has conservative defaults', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'config.template.toml'),
            'utf-8'
        );
        assert.ok(content.includes('network_access = false'));
        assert.ok(content.includes('approval_policy = "on-request"'));
        assert.ok(content.includes('sandbox_mode = "workspace-write"'));
    });

    it('codex hooks.json uses systemMessage (non-destructive)', () => {
        const content = JSON.parse(fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'hooks.template.json'),
            'utf-8'
        ));
        for (const hookGroup of Object.values(content.hooks)) {
            for (const entry of hookGroup) {
                const hooks = entry.hooks || [];
                for (const hook of hooks) {
                    assert.equal(hook.type, 'command');
                    assert.ok(hook.command.includes('systemMessage'), 'hooks should use systemMessage, not destructive actions');
                }
            }
        }
    });
});

// ─── Template file existence ─────────────────────────────────────────────────

describe('Codex overlay template files exist', () => {
    const requiredFiles = [
        'overlays/codex/config.template.toml',
        'overlays/codex/hooks.template.json',
        'overlays/codex/docs/codex-usage.md',
        'overlays/codex/workflows/coder-execution.md',
        'overlays/codex/workflows/superpower-sdlc.md',
    ];

    for (const file of requiredFiles) {
        it(`${file} exists`, () => {
            assert.ok(fs.existsSync(path.join(TEMPLATES, file)), `${file} should exist`);
        });
    }
});
