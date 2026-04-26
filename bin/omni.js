#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');
const { program } = require('commander');
const { execSync, execFileSync } = require('child_process');

const MANIFEST_FILE = '.omni-manifest.json';
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

// ========== UNIVERSAL SKILLS (skills.sh) ==========

const UNIVERSAL_SKILLS = [
    { source: 'vercel-labs/skills', name: 'find-skills', desc: 'Tìm kiếm & cài đặt skills tự động từ skills.sh' },
    { source: 'forrestchang/andrej-karpathy-skills', name: 'karpathy-guidelines', desc: 'Karpathy mindset: Think → Simplify → Surgical → Goal-Driven' },
    { source: 'obra/superpowers', name: 'systematic-debugging', desc: 'Debugging có hệ thống' },
    { source: 'obra/superpowers', name: 'test-driven-development', desc: 'Phát triển hướng test (TDD)' },
    { source: 'obra/superpowers', name: 'requesting-code-review', desc: 'Quy trình review code chuyên nghiệp' },
    { source: 'obra/superpowers', name: 'using-git-worktrees', desc: 'Quản lý Git worktrees hiệu quả' },
];

// ========== HELPERS ==========

function findConfigFile() {
    const files = ['.cursorrules', '.windsurfrules', 'CLAUDE.md', 'GEMINI.md', 'AGENTS.md', 'SYSTEM_PROMPT.md'];
    for (const file of files) {
        if (fs.existsSync(path.join(process.cwd(), file))) return file;
    }
    return null;
}

function readTemplate(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        console.log(chalk.red.bold(`\n❌ Lỗi khi đọc file template: ${path.basename(filePath)}`));
        console.log(chalk.red(`   Chi tiết: ${err.message}\n`));
        process.exit(1);
    }
}

const OMNI_GITIGNORE_PATTERNS = [
    '.omni/',
    '.omni-manifest.json',
    '.omni-rules.md',
    'design-spec.md',
    'todo.md',
    'test-report.md',
];

function ensureGitignore(ide) {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const patterns = [...OMNI_GITIGNORE_PATTERNS];
    if (ide === 'claudecode' || ide === 'dual') patterns.push('.claude/');
    if (ide === 'codex' || ide === 'dual') patterns.push('.codex/');

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

function writeFileSafe(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    } catch (err) {
        console.log(chalk.red.bold(`\n❌ Lỗi khi ghi file: ${path.basename(filePath)}`));
        console.log(chalk.red(`   Chi tiết: ${err.message}\n`));
        return false;
    }
}

function isValidSkillName(name) {
    return /^[a-z0-9-]+$/.test(name);
}

// Parse source: hỗ trợ cả URL GitHub lẫn owner/repo format
function parseSource(raw) {
    if (!raw) return null;
    let cleaned = raw.trim().replace(/\/+$/, ''); // bỏ trailing slashes

    // Hỗ trợ full GitHub URL: https://github.com/owner/repo[/...]
    const urlMatch = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(?:\/.+)?)$/);
    if (urlMatch) cleaned = urlMatch[1];

    // Hỗ trợ git@ SSH format: git@github.com:owner/repo.git
    const sshMatch = cleaned.match(/^git@github\.com:([a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/);
    if (sshMatch) cleaned = sshMatch[1];

    // Bỏ .git suffix nếu còn sót
    cleaned = cleaned.replace(/\.git$/, '');

    // Validate format cuối cùng: owner/repo hoặc owner/repo/path
    if (cleaned.includes('..')) return null;
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(\/.+)?$/.test(cleaned)) return null;

    return cleaned;
}

// ========== MANIFEST SYSTEM ==========

function loadManifest() {
    const p = path.join(process.cwd(), MANIFEST_FILE);
    if (fs.existsSync(p)) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch {
            return createManifest();
        }
    }
    return createManifest();
}

function createManifest() {
    return { version: '2.1.0', configFile: null, skills: { external: [] } };
}

function saveManifest(manifest) {
    return writeFileSafe(path.join(process.cwd(), MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

function getAgentFlags(manifest) {
    const agents = IDE_AGENT_MAP[manifest.ide];
    if (!agents) return '';
    return `--agent ${agents.join(' ')}`;
}

const RULES_FILE = '.omni-rules.md';

function buildRulesContent(rp) {
    const sections = [];
    if (rp.language) sections.push(`## Ngôn ngữ\n- ${rp.language}`);
    if (rp.codingStyle) sections.push(`## Coding Style\n${rp.codingStyle.split(';').map(r => r.trim()).filter(Boolean).map(r => `- ${r}`).join('\n')}`);
    if (rp.forbidden) sections.push(`## Forbidden Patterns\n${rp.forbidden.split(';').map(r => r.trim()).filter(Boolean).map(r => `- ${r}`).join('\n')}`);
    if (rp.custom) sections.push(`## Custom Rules\n${rp.custom.split(';').map(r => r.trim()).filter(Boolean).map(r => `- ${r}`).join('\n')}`);
    if (sections.length === 0) return null;
    return `# Personal Rules\n> Generated by Omni-Coder Kit | Last updated: ${new Date().toISOString().split('T')[0]}\n\n${sections.join('\n\n')}\n`;
}

function extractRulesForInject(rp) {
    const lines = [];
    if (rp.language) lines.push(`- **Ngôn ngữ:** ${rp.language}`);
    if (rp.codingStyle) rp.codingStyle.split(';').map(r => r.trim()).filter(Boolean).forEach(r => lines.push(`- ${r}`));
    if (rp.forbidden) rp.forbidden.split(';').map(r => r.trim()).filter(Boolean).forEach(r => lines.push(`- **KHÔNG:** ${r}`));
    if (rp.custom) rp.custom.split(';').map(r => r.trim()).filter(Boolean).forEach(r => lines.push(`- ${r}`));
    return lines.join('\n');
}

function syncRulesToConfig() {
    const configFile = findConfigFile();
    if (!configFile) return false;
    const configPath = path.join(process.cwd(), configFile);
    const rulesPath = path.join(process.cwd(), RULES_FILE);
    if (!fs.existsSync(rulesPath)) return false;

    const rulesRaw = fs.readFileSync(rulesPath, 'utf-8');
    const lines = rulesRaw.split('\n').filter(l => l.startsWith('- ')).join('\n');
    if (!lines) return false;

    let config = fs.readFileSync(configPath, 'utf-8');
    const startMarker = '<!-- omni:rules -->';
    const endMarker = '<!-- /omni:rules -->';
    const injection = `${startMarker}\n## PERSONAL RULES\n${lines}\n${endMarker}`;

    if (config.includes(startMarker) && config.includes(endMarker)) {
        const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
        config = config.replace(regex, injection);
    } else {
        config += `\n\n${injection}\n`;
    }
    return writeFileSafe(configPath, config);
}

function findSkillConflict(manifest, skillName) {
    const ext = manifest.skills.external.find(s => s.name === skillName);
    if (ext) {
        return { type: 'external', name: ext.name, source: ext.source };
    }
    return null;
}

// ========== OVERLAY SYSTEM ==========

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
    const dir = path.join(__dirname, '..', 'templates', 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide, target = null) {
    const templatesDir = path.join(__dirname, '..', 'templates');
    const baseDir = path.join(templatesDir, 'workflows');
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

function detectDNA(projectDir) {
    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch {}

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;
    const dirExists = (name) => fs.existsSync(path.join(projectDir, name));

    return {
        hasUI: hasDep('react') || hasDep('vue') || hasDep('svelte') || hasDep('next') || hasDep('@angular/core'),
        hasBackend: hasDep('express') || hasDep('fastify') || hasDep('hono') || hasDep('prisma') || hasDep('@supabase/supabase-js') || dirExists('server') || dirExists('api'),
        hasAPI: hasDep('express') || hasDep('fastify') || hasDep('hono') || dirExists('routes') || dirExists('controllers'),
    };
}

function buildCommandRegistry(ide) {
    const isClaudeCode = ide === 'claudecode' || ide === 'dual';
    const isCodex = ide === 'codex';
    const isGemini = ide === 'gemini';

    if (isClaudeCode) {
        return [
            '## WORKFLOW COMMANDS',
            '> Claude Code: dung `/om:*` slash commands (auto-complete) hoac `>om:*` trong chat.',
            '',
            'When the user invokes a `>om:` command or `/om:` slash command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Slash | Agent Strategy | Workflow File |',
            '|---------|-------|---------------|---------------|',
            '| `>om:brainstorm` | `/om:brainstorm` | Main session | `.omni/workflows/requirement-analysis.md` |',
            '| `>om:equip` | `/om:equip` | Main session | `.omni/workflows/skill-manager.md` |',
            '| `>om:plan` | `/om:plan` | Main session | `.omni/workflows/task-planning.md` |',
            '| `>om:cook` | `/om:cook` | Main -> sub-agents (parallel) | `.omni/workflows/coder-execution.md` |',
            '| `>om:check` | `/om:check` | Main session | `.omni/workflows/qa-testing.md` |',
            '| `>om:fix` | `/om:fix` | Main session | `.omni/workflows/debugger-workflow.md` |',
            '| `>om:doc` | `/om:doc` | Main session | `.omni/workflows/documentation-writer.md` |',
            '| `>om:learn` | `/om:learn` | Main session | `.omni/workflows/knowledge-learn.md` |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Full SDLC overview and pipeline diagram',
            '- `.omni/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (isGemini) {
        return [
            '## WORKFLOW COMMANDS',
            '> Gemini CLI: type `>om:*` as normal chat text.',
            '',
            'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Agent Strategy | Gemini Tools |',
            '|---------|--------------|----------------|--------------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Main session | `ask_user`, `save_memory` |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | Main session | `google_web_search` |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | Main session | `tracker_create_task` |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | Main session | `tracker_update_task`, `enter_plan_mode` |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | Main session | `run_shell_command` |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Main session | `systematic-debugging` |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Main session | `read_file` |',
            '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Main session | `save_memory` |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Gemini-aware SDLC overview',
            '- `.omni/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (isCodex) {
        return [
            '## WORKFLOW COMMANDS',
            '> Codex CLI: type `>om:*` as normal chat text. Codex custom project `/om:*` slash commands are not assumed in this setup.',
            '',
            'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Role |',
            '|---------|--------------|------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill Manager |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | PM |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | QA Tester |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugger |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Writer |',
            '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner |',
            '',
            'Codex native helpers:',
            '- Use `/plan` for Codex-native planning before edits.',
            '- Use `/review` for Codex-native review of current changes.',
            '- Use `/permissions` to inspect approval behavior.',
            '- Use `/agent` only when the user explicitly asks for subagents.',
            '- Use `/mcp` and `/plugins` to inspect connected tools.',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Codex-aware SDLC overview',
            '- `.omni/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Token Budget:** Keep `AGENTS.md` compact; long instructions belong in `.omni/workflows/`.',
        ].join('\n');
    }

    const isCursor = ide === 'cursor';
    if (isCursor) {
        return [
            '## WORKFLOW COMMANDS',
            '> Cursor: type `>om:*` in chat. Use @Files to read workflow files.',
            '',
            'When the user types a `>om:` command, use @Files to read the corresponding workflow file, then follow its instructions.',
            '',
            '| Command | Workflow File | Context Hints |',
            '|---------|--------------|---------------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | @Codebase for project scan |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | @Web for skill discovery |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | @Git for recent changes |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | @Files for scope, Agent mode |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | @Git for diff review |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | @Web for error research |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | @Codebase for API surface |',
            '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | @Git for fix history |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Cursor-aware SDLC overview',
            '- `.omni/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    return [
        '## WORKFLOW COMMANDS',
        'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
        '',
        '| Command | Workflow File | Role |',
        '|---------|--------------|------|',
        '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect |',
        '| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill Manager |',
        '| `>om:plan` | `.omni/workflows/task-planning.md` | PM |',
        '| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder |',
        '| `>om:check` | `.omni/workflows/qa-testing.md` | QA Tester |',
        '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugger |',
        '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Writer |',
        '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner |',
        '',
        'Supporting files (referenced by workflows as needed):',
        '- `.omni/workflows/pm-templates.md` - Output format standards',
        '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
        '- `.omni/workflows/superpower-sdlc.md` - Full SDLC overview and pipeline diagram',
        '- `.omni/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
        '',
        '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
        '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
        '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
    ].join('\n');
}

// ========== CLI COMMANDS ==========

program
    .name('omni')
    .description('Trình quản lý hệ tư tưởng Omni-Coder Kit')
    .version(PKG.version);

// ---------- INIT ----------
program
    .command('init')
    .description('Khởi tạo DNA và workflow cho dự án mới')
    .action(async () => {
        console.log(chalk.cyan.bold('\n🚀 Khởi tạo Omni-Coder Kit!\n'));

        const q = (n, total, text) => `${chalk.whiteBright.bold(`[${n}/${total}]`)} ${text}`;

        const response = await prompts([
            {
                type: 'select',
                name: 'ide',
                message: q(1, 3, 'Bạn đang sử dụng AI IDE/Công cụ nào?'),
                choices: [
                    { title: 'Claude Code (CLI) / OpenCode', value: 'claudecode' },
                    { title: 'Gemini CLI (Google)', value: 'gemini' },
                    { title: 'Antigravity', value: 'antigravity' },
                    { title: 'Cursor', value: 'cursor' },
                    { title: 'Windsurf', value: 'windsurf' },
                    { title: 'Codex CLI (OpenAI)', value: 'codex' },
                    { title: 'Claude Code + Codex (dual)', value: 'dual' },
                    { title: 'Cross-tool (AGENTS.md)', value: 'agents' },
                    { title: 'Generic (SYSTEM_PROMPT.md)', value: 'generic' }
                ],
            },
            {
                type: 'select',
                name: 'strictness',
                message: q(2, 3, 'Mức độ kỷ luật?'),
                choices: [
                    { title: 'Hardcore (Ép 100% SDLC - Khuyên dùng)', value: 'hardcore' },
                    { title: 'Flexible (Cho phép bypass lỗi vặt - Cần tự định nghĩa giới hạn trong Personal Rules)', value: 'flexible' }
                ]
            },
        ]);

        if (!response.ide) {
            console.log(chalk.red('Hủy bỏ.'));
            return;
        }

        // Personal Rules (guided + free-text)
        console.log(chalk.cyan(`\n${q(3, 3, 'Personal Rules')} ${chalk.gray('(Enter để bỏ qua từng mục)')}\n`));

        console.log(chalk.gray('📝 Ngôn ngữ AI dùng để trả lời bạn. Có thể ghi nhiều ngôn ngữ.'));
        console.log(chalk.dim('   VD React dev: "Tiếng Việt, technical terms giữ English"'));
        console.log(chalk.dim('   VD Python team: "English only"'));
        const rl = await prompts({ type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp (AI trả lời bằng ngôn ngữ nào)?', initial: '' });

        console.log(chalk.gray('\n📝 Quy tắc viết code mà AI phải tuân theo trong dự án.'));
        console.log(chalk.gray('   Bao gồm: naming convention, indent, format, patterns ưa thích.'));
        console.log(chalk.dim('   VD React frontend: "camelCase, 2-space indent, prefer FC + hooks, no class components"'));
        console.log(chalk.dim('   VD Node.js backend: "snake_case cho DB fields, camelCase cho JS, ESM imports, async/await"'));
        console.log(chalk.dim('   VD Python ML: "PEP8, type hints bắt buộc, docstring Google style"'));
        const rc = await prompts({ type: 'text', name: 'codingStyle', message: 'Coding style / conventions?', initial: '' });

        console.log(chalk.gray('\n📝 Những patterns/thói quen mà AI KHÔNG ĐƯỢC sử dụng.'));
        console.log(chalk.gray('   Ghi rõ cái gì bị cấm — AI sẽ tránh hoàn toàn.'));
        console.log(chalk.dim('   VD React: "không dùng any, không dùng class component, không inline styles"'));
        console.log(chalk.dim('   VD Backend: "không console.log trong production code, không dùng var, không SQL thô"'));
        console.log(chalk.dim('   VD Chung: "không tự ý refactor code ngoài scope, không thêm comments thừa"'));
        const rf = await prompts({ type: 'text', name: 'forbidden', message: 'Forbidden patterns (những gì KHÔNG được làm)?', initial: '' });

        console.log(chalk.gray('\n📝 Các quy tắc riêng khác không thuộc mục trên. Phân cách bằng dấu ;'));
        console.log(chalk.dim('   VD: "commit message bằng tiếng Việt; mỗi PR tối đa 300 dòng thay đổi"'));
        console.log(chalk.dim('   VD: "luôn viết unit test trước khi code; dùng pnpm thay npm"'));
        console.log(chalk.dim('   VD: "giải thích bằng ví dụ cụ thể; không dùng emoji trong code"'));
        const ru = await prompts({ type: 'text', name: 'custom', message: 'Custom rules (tùy ý, phân cách bằng dấu ;)?', initial: '' });

        const rulesPrompt = {
            language: rl.language,
            codingStyle: rc.codingStyle,
            forbidden: rf.forbidden,
            custom: ru.custom,
        };

        const templatesDir = path.join(__dirname, '..', 'templates');

        const mindset = readTemplate(path.join(templatesDir, 'core', 'karpathy-mindset.md'));
        const hygiene = readTemplate(path.join(templatesDir, 'core', 'claudex-hygiene.md'));

        const omniWorkflowsDir = path.join(process.cwd(), '.omni', 'workflows');
        fs.mkdirSync(omniWorkflowsDir, { recursive: true });
        const workflowTarget = response.ide === 'codex'
            ? 'codex'
            : response.ide === 'gemini'
                ? 'gemini'
                : response.ide === 'cursor'
                    ? 'cursor'
                    : response.ide === 'dual'
                        ? 'base'
                        : null;
        const mergedWorkflows = buildWorkflows(response.ide, workflowTarget);
        const workflowFiles = Object.keys(mergedWorkflows);
        for (const wf of workflowFiles) {
            fs.copyFileSync(mergedWorkflows[wf], path.join(omniWorkflowsDir, wf));
        }

        const isClaudeCode = response.ide === 'claudecode' || response.ide === 'dual';
        const isCodex = response.ide === 'codex' || response.ide === 'dual';
        const commandRegistry = buildCommandRegistry(response.ide);

        let strictnessBlock = '';
        if (response.strictness === 'hardcore') {
            strictnessBlock = '## STRICTNESS LEVEL: HARDCORE (Kỷ luật tuyệt đối)\n- MỌI thay đổi mã nguồn, tính năng, hoặc sửa lỗi BẤT KỲ đều PHẢI thông qua toàn bộ luồng SDLC (`>om:brainstorm` -> `>om:plan` -> `>om:cook` -> `>om:check`).\n- Bạn BỊ CẤM bỏ qua quy trình này, ngay cả khi người dùng yêu cầu sửa chữa một lỗi cực nhỏ.\n- Hãy kiên quyết từ chối yêu cầu code trực tiếp nếu không tuân thủ quy trình.\n';
        } else {
            strictnessBlock = '## STRICTNESS LEVEL: FLEXIBLE (Kỷ luật linh hoạt)\n- Bạn nên ưu tiên tuân thủ luồng SDLC (`>om:brainstorm` -> `>om:plan` -> `>om:cook` -> `>om:check`).\n- Tuy nhiên, bạn ĐƯỢC PHÉP bỏ qua các bước lên kế hoạch và kiểm tra toàn diện NẾU VÀ CHỈ NẾU phạm vi công việc là RẤT NHỎ (như sửa lỗi chính tả, thay đổi CSS, hoặc logic dưới 10 dòng) VÀ không ảnh hưởng đến kiến trúc tổng thể.\n- Đối với các thay đổi lớn hơn, LUÔN LUÔN phải trở lại luồng chuẩn.\n';
        }

        let finalRules = `> Generated by Omni-Coder Kit\n\n${strictnessBlock}\n${mindset}\n\n${hygiene}\n\n${commandRegistry}\n\n`;

        // Khởi tạo manifest mới cho project
        const manifest = createManifest();

        // Personal Rules: sinh .omni-rules.md + inject vào config
        const rulesContent = buildRulesContent(rulesPrompt);
        if (rulesContent) {
            const rulesPath = path.join(process.cwd(), '.omni-rules.md');
            writeFileSafe(rulesPath, rulesContent);
            finalRules += `\n<!-- omni:rules -->\n## PERSONAL RULES\n${extractRulesForInject(rulesPrompt)}\n<!-- /omni:rules -->\n\n`;
        }

        let fileName = '';
        finalRules += `## IDE SPECIFIC ADAPTERS\n`;

        switch (response.ide) {
            case 'claudecode':
                fileName = 'CLAUDE.md';
                finalRules += `### Claude Code Integration\n`;
                finalRules += `- **Native Commands:** Dùng \`/om:brainstorm\`, \`/om:cook\`, ... (auto-complete) hoặc gõ \`>om:brainstorm\`, \`>om:cook\` trong chat — cả hai đều hoạt động.\n`;
                finalRules += `- **Sub-Agent Execution:** Khi \`/om:cook\` chạy, phân tích dependency graph trong \`todo.md\` và spawn parallel agents (worktree isolation) cho tasks độc lập. Xem chi tiết: \`.omni/workflows/coder-execution.md\`\n`;
                finalRules += `- **Task Tracking:** Dùng TaskCreate/TaskUpdate để track progress khi thực thi tasks, thay vì chỉ dựa vào \`todo.md\` checkboxes.\n`;
                finalRules += `- **Safety:** KHÔNG thực thi destructive commands (rm -rf, git push --force, git reset --hard) mà không có permission user.\n`;
                finalRules += `- **Workflow Files:** Tất cả logic nằm trong \`.omni/workflows/\`. Khi nhận lệnh \`>om:*\` hoặc \`/om:*\`, đọc file tương ứng rồi thực thi.\n`;
                break;
            case 'gemini':
                fileName = 'GEMINI.md';
                finalRules += `### Gemini CLI Integration\n`;
                finalRules += `- **Workflow Interaction:** Type \`>om:brainstorm\`, \`>om:plan\`, \`>om:cook\`, etc. as normal chat text.\n`;
                finalRules += `- **Plan Mode:** Use \`enter_plan_mode\` for research and \`exit_plan_mode\` to return to execution.\n`;
                finalRules += `- **Task Tracking:** Use \`tracker_create_task\` and \`tracker_update_task\` tools to manage progress. This is the primary source of truth for task status.\n`;
                finalRules += `- **Context Efficiency:** Use \`save_memory\` (project scope) for long-term project facts to keep the main context lean.\n`;
                finalRules += `- **Interactive Tools:** Use \`ask_user\` for making decisions and \`google_web_search\` for documentation search.\n`;
                finalRules += `- **Workflow Files:** All logic is in \`.omni/workflows/\`. Read corresponding files when receiving \`>om:*\` commands.\n`;
                break;
            case 'codex':
                fileName = 'AGENTS.md';
                finalRules += `- **Codex CLI Agent Mode:** This file is auto-discovered by Codex CLI walking from project root to cwd. Keep total content under 32 KiB.\n`;
                finalRules += `- **Stable Omni Commands:** Type \`>om:brainstorm\`, \`>om:plan\`, \`>om:cook\`, etc. as normal chat text. Do not rely on custom \`/om:*\` slash commands in Codex.\n`;
                finalRules += `- **Native Codex Commands:** Use \`/plan\`, \`/review\`, \`/permissions\`, \`/agent\`, \`/mcp\`, and \`/plugins\` when they help the current workflow.\n`;
                finalRules += `- **Sandbox Awareness:** Codex may run in read-only or workspace-write sandbox modes. Do not attempt network calls or external writes unless the active profile allows them.\n`;
                finalRules += `- **Approval Policy:** Respect the configured approval mode. In stricter modes, present risky commands for review instead of forcing execution.\n`;
                finalRules += `- **Workflow Files:** Long instructions live in \`.omni/workflows/\`; read them lazily only when needed.\n`;
                break;
            case 'dual':
                fileName = 'CLAUDE.md';
                finalRules += `### Claude Code Integration\n`;
                finalRules += `- **Native Commands:** Dùng \`/om:brainstorm\`, \`/om:cook\`, ... (auto-complete) hoặc gõ \`>om:brainstorm\`, \`>om:cook\` trong chat — cả hai đều hoạt động.\n`;
                finalRules += `- **Sub-Agent Execution:** Khi \`/om:cook\` chạy, phân tích dependency graph trong \`todo.md\` và spawn parallel agents (worktree isolation) cho tasks độc lập. Xem chi tiết: \`.omni/workflows/coder-execution.md\`\n`;
                finalRules += `- **Task Tracking:** Dùng TaskCreate/TaskUpdate để track progress khi thực thi tasks, thay vì chỉ dựa vào \`todo.md\` checkboxes.\n`;
                finalRules += `- **Safety:** KHÔNG thực thi destructive commands (rm -rf, git push --force, git reset --hard) mà không có permission user.\n`;
                finalRules += `- **Workflow Files:** Tất cả logic nằm trong \`.omni/workflows/\`. Khi nhận lệnh \`>om:*\` hoặc \`/om:*\`, đọc file tương ứng rồi thực thi.\n`;
                break;
            case 'antigravity':
                fileName = 'AGENTS.md';
                finalRules += `- **AGENTS.md Discovery:** Antigravity auto-discovers this file from project root. Rules, skills, and workflows go in \`.agents/\` directory.\n`;
                finalRules += `- **Knowledge Items:** Persist architecture decisions, debugging solutions, and implementation patterns as Knowledge Items (KIs) — they survive across sessions unlike chat history.\n`;
                finalRules += `- **Multi-Agent (Manager View):** For complex tasks, spawn specialized agents from Manager View (\`Cmd+E\` / \`Ctrl+E\`). Each agent gets its own isolated workspace.\n`;
                finalRules += `- **Browser Testing:** Use the integrated browser to visually verify UI changes before confirming completion. Agents can take screenshots and detect visual regressions.\n`;
                finalRules += `- **Workflows:** Place reusable workflows in \`.agents/workflows/\` and trigger via \`/workflow-name\` in chat.\n`;
                finalRules += `- **Confirmation Policy:** ALWAYS require explicit confirmation before destructive operations (database writes, deployments, \`rm -rf\`, force push).\n`;
                break;
            case 'agents':
                fileName = 'AGENTS.md';
                finalRules += `- **Cross-Tool Compatibility:** This file is read by Antigravity, Claude Code, Cursor, Windsurf, Gemini CLI, and CodeX. Keep rules tool-agnostic.\n`;
                finalRules += `- **CLI Safety:** DO NOT execute destructive terminal commands without explicit user permission.\n`;
                break;
            case 'cursor':
                fileName = '.cursorrules';
                finalRules += `- **Context Gathering:** ALWAYS use \`@Files\` and \`@Codebase\` to verify context before generating code.\n`;
                break;
            case 'windsurf':
                fileName = '.windsurfrules';
                finalRules += `- **Cascade Rules:** Utilize Windsurf's context awareness. Do not duplicate existing logic.\n`;
                break;
            default:
                fileName = 'SYSTEM_PROMPT.md';
                finalRules += `- **General AI Rules:** Adhere strictly to the defined workflow.\n`;
        }

        // Xác nhận trước khi ghi đè
        const targetPath = path.join(process.cwd(), fileName);
        if (fs.existsSync(targetPath)) {
            const { overwrite } = await prompts({
                type: 'confirm',
                name: 'overwrite',
                message: `⚠️  File "${fileName}" đã tồn tại. Bạn có muốn ghi đè không?`,
                initial: false
            });
            if (!overwrite) {
                console.log(chalk.yellow('\n⚠️  Hủy bỏ. File hiện tại được giữ nguyên.\n'));
                return;
            }
        }

        if (!writeFileSafe(targetPath, finalRules)) return;

        // Handle dual-agent: viết thêm AGENTS.md cho Codex CLI
        if (response.ide === 'dual') {
            const codexCommandRegistry = buildCommandRegistry('codex');
            let agentsRules = `> Generated by Omni-Coder Kit (Codex CLI / Cross-tool)\n\n${strictnessBlock}\n${mindset}\n\n${hygiene}\n\n${codexCommandRegistry}\n\n`;

            if (rulesContent) {
                agentsRules += `\n<!-- omni:rules -->\n## PERSONAL RULES\n${extractRulesForInject(rulesPrompt)}\n<!-- /omni:rules -->\n\n`;
            }

            agentsRules += `## IDE SPECIFIC ADAPTERS\n`;
            agentsRules += `- **Codex CLI Agent Mode:** This file is auto-discovered by Codex CLI walking from project root to cwd. Keep total content under 32 KiB.\n`;
            agentsRules += `- **Stable Omni Commands:** Type \`>om:brainstorm\`, \`>om:plan\`, \`>om:cook\`, etc. as normal chat text. Do not rely on custom \`/om:*\` slash commands in Codex.\n`;
            agentsRules += `- **Native Codex Commands:** Use \`/plan\`, \`/review\`, \`/permissions\`, \`/agent\`, \`/mcp\`, and \`/plugins\` when they help the current workflow.\n`;
            agentsRules += `- **Sandbox Awareness:** Codex may run in read-only or workspace-write sandbox modes. Do not attempt network calls or external writes unless the active profile allows them.\n`;
            agentsRules += `- **Cross-Tool Compatibility:** This file is also read by Antigravity, Gemini CLI, and other AGENTS.md-compatible tools.\n`;

            const agentsPath = path.join(process.cwd(), 'AGENTS.md');
            let writeAgents = true;
            if (fs.existsSync(agentsPath)) {
                const { overwriteAgents } = await prompts({
                    type: 'confirm',
                    name: 'overwriteAgents',
                    message: `⚠️  File "AGENTS.md" đã tồn tại. Bạn có muốn ghi đè không?`,
                    initial: false
                });
                writeAgents = !!overwriteAgents;
            }

            if (writeAgents) {
                writeFileSafe(agentsPath, agentsRules);
                console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: CLAUDE.md + AGENTS.md`));
            } else {
                console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: CLAUDE.md`));
                console.log(chalk.yellow(`   Bỏ qua AGENTS.md (giữ nguyên file hiện tại).`));
            }
        } else {
            console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: ${fileName}`));
        }

        // Lưu manifest
        manifest.configFile = fileName;
        manifest.ide = response.ide;
        saveManifest(manifest);

        console.log(chalk.gray(`   Đã tạo manifest: ${MANIFEST_FILE}`));
        console.log(chalk.gray(`   Workflows: .omni/workflows/ (${workflowFiles.length} files — lazy-loaded)`));

        const gitignoreCount = ensureGitignore(response.ide);
        if (gitignoreCount > 0) {
            console.log(chalk.gray(`   .gitignore: ${gitignoreCount} patterns added`));
        }

        // Claude Code: generate slash commands
        const slashCommands = buildCommands(response.ide);
        if (slashCommands) {
            const claudeCommandsDir = path.join(process.cwd(), '.claude', 'commands');
            fs.mkdirSync(claudeCommandsDir, { recursive: true });
            for (const [name, srcPath] of Object.entries(slashCommands)) {
                fs.copyFileSync(srcPath, path.join(claudeCommandsDir, name));
            }
            manifest.commands = Object.keys(slashCommands).map(f => f.replace('.md', ''));
            saveManifest(manifest);
            console.log(chalk.gray(`   Commands: .claude/commands/ (${Object.keys(slashCommands).length} slash commands)`));
        }

        // Claude Code: progressive advanced setup
        if (slashCommands) {
            const { advanced } = await prompts({
                type: 'confirm',
                name: 'advanced',
                message: '🔧 Cài đặt Claude Code nâng cao? (permissions allowlist, quality gate hooks)',
                initial: false
            });

            const settingsContent = buildSettings(response.ide, advanced);
            if (settingsContent) {
                const claudeDir = path.join(process.cwd(), '.claude');
                fs.mkdirSync(claudeDir, { recursive: true });
                const settingsPath = path.join(claudeDir, 'settings.json');
                let writeSettings = true;
                if (fs.existsSync(settingsPath)) {
                    const { overwriteSettings } = await prompts({
                        type: 'confirm',
                        name: 'overwriteSettings',
                        message: '⚠️  File ".claude/settings.json" đã tồn tại. Ghi đè?',
                        initial: false
                    });
                    writeSettings = !!overwriteSettings;
                }
                if (writeSettings) {
                    writeFileSafe(settingsPath, settingsContent);
                    console.log(chalk.green(`   ✅ .claude/settings.json (permissions + hooks)`));
                }
            }

            manifest.overlay = true;
            manifest.advanced = !!advanced;
            saveManifest(manifest);
        }

        // Codex CLI: progressive advanced setup
        if (isCodex) {
            const { codexAdvanced } = await prompts({
                type: 'confirm',
                name: 'codexAdvanced',
                message: 'Codex CLI nang cao? (.codex/config.toml + hooks)',
                initial: false
            });

            const codexConfig = buildCodexConfig(response.ide, codexAdvanced);
            const codexHooks = buildCodexHooks(response.ide, codexAdvanced);

            if (codexConfig || codexHooks) {
                const codexDir = path.join(process.cwd(), '.codex');
                fs.mkdirSync(codexDir, { recursive: true });

                if (codexConfig) {
                    const configPath = path.join(codexDir, 'config.toml');
                    let writeConfig = true;
                    if (fs.existsSync(configPath)) {
                        const { overwriteCodexConfig } = await prompts({
                            type: 'confirm',
                            name: 'overwriteCodexConfig',
                            message: 'File ".codex/config.toml" da ton tai. Ghi de?',
                            initial: false
                        });
                        writeConfig = !!overwriteCodexConfig;
                    }
                    if (writeConfig) {
                        writeFileSafe(configPath, codexConfig);
                        console.log(chalk.green(`   ✓ .codex/config.toml (Codex profiles + hooks flag)`));
                    }
                }

                if (codexHooks) {
                    const hooksPath = path.join(codexDir, 'hooks.json');
                    let writeHooks = true;
                    if (fs.existsSync(hooksPath)) {
                        const { overwriteCodexHooks } = await prompts({
                            type: 'confirm',
                            name: 'overwriteCodexHooks',
                            message: 'File ".codex/hooks.json" da ton tai. Ghi de?',
                            initial: false
                        });
                        writeHooks = !!overwriteCodexHooks;
                    }
                    if (writeHooks) {
                        writeFileSafe(hooksPath, codexHooks);
                        console.log(chalk.green(`   ✓ .codex/hooks.json (Codex hook reminders)`));
                    }
                }
            }

            manifest.codexOverlay = true;
            manifest.codexAdvanced = !!codexAdvanced;
            saveManifest(manifest);
        }

        // Auto-install find-skills (tìm kiếm & cài skills tự động)
        const findSkillsAgentFlags = getAgentFlags(manifest);
        const findSkillsCmd = `npx skills add vercel-labs/skills${findSkillsAgentFlags ? ' ' + findSkillsAgentFlags : ''} --skill find-skills -y`;

        try {
            console.log(chalk.gray(`   Đang cài find-skills...`));
            const initArgs = ['-y', 'skills', 'add', 'vercel-labs/skills'];
            if (findSkillsAgentFlags) initArgs.push(...findSkillsAgentFlags.split(' '));
            initArgs.push('--skill', 'find-skills', '-y');
            execFileSync('npx', initArgs, { stdio: 'pipe', timeout: 30000 });
            manifest.skills.external.push({
                name: 'find-skills',
                source: 'vercel-labs/skills',
                installedAt: new Date().toISOString()
            });
            saveManifest(manifest);
            console.log(chalk.green(`   ✓ find-skills — AI có thể tìm & cài skills tự động`));
        } catch {
            console.log(chalk.yellow(`   ⚠️  Không cài được find-skills (sandbox/mạng). Cài sau: ${findSkillsCmd}`));
        }

        console.log(chalk.white(`\n💡 Gõ ${chalk.cyan.bold('>om:brainstorm')} để AI phỏng vấn và tư vấn kiến trúc.`));
        console.log(chalk.gray(`   Thêm skill: ${chalk.yellow('omni equip <source>')} hoặc ${chalk.yellow('omni auto-equip')}`));
        if (rulesContent) {
            console.log(chalk.gray(`   Sửa rules: ${chalk.yellow('omni rules')}`));
        } else {
            console.log(chalk.gray(`   Thêm personal rules: ${chalk.yellow('omni rules')}`));
        }
        console.log(chalk.gray(`💡 Xem toàn bộ lệnh >om: bằng: `) + chalk.yellow('omni commands'));

        const startupHints = {
            claudecode: {
                name: 'Claude Code',
                cmd: 'claude --dangerously-skip-permissions',
                note: 'Bỏ qua tất cả permission prompts (chỉ dùng khi tin tưởng prompt)',
            },
            gemini: {
                name: 'Gemini CLI',
                cmd: 'gemini --yolo',
                note: 'Tự động approve mọi thao tác. Gõ >om:brainstorm để bắt đầu.',
            },
            codex: {
                name: 'Codex CLI',
                cmd: 'codex --yolo',
                note: 'Tự động approve mọi thao tác (file, shell, network)',
            },
            dual: [
                {
                    name: 'Claude Code',
                    cmd: 'claude --dangerously-skip-permissions',
                    note: 'Bỏ qua permission prompts',
                },
                {
                    name: 'Codex CLI',
                    cmd: 'codex --yolo',
                    note: 'Full auto mode',
                },
            ],
            antigravity: {
                name: 'Antigravity',
                cmd: 'antigravity',
                note: 'Dùng AGENTS.md + .agents/ directory. Gõ >om:brainstorm trong chat để bắt đầu.',
            },
            cursor: {
                name: 'Cursor',
                cmd: null,
                note: 'Mở Cursor trong thư mục dự án, file .cursorrules sẽ tự động được đọc',
            },
            windsurf: {
                name: 'Windsurf',
                cmd: null,
                note: 'Mở Windsurf trong thư mục dự án, file .windsurfrules sẽ tự động được đọc',
            },
        };

        const hint = startupHints[response.ide];
        if (hint) {
            console.log(chalk.cyan.bold('\n🚀 Khởi động nhanh:\n'));
            const entries = Array.isArray(hint) ? hint : [hint];
            for (const h of entries) {
                if (h.cmd) {
                    console.log(`   ${chalk.green(h.name)}: ${chalk.cyan.bold(h.cmd)}`);
                    console.log(chalk.gray(`   └─ ${h.note}`));
                } else {
                    console.log(`   ${chalk.green(h.name)}: ${chalk.gray(h.note)}`);
                }
            }
        }
        console.log('');
    });

// ---------- EQUIP (external skills from skills.sh) ----------
program
    .command('equip <source>')
    .description('Tải và đồng bộ kỹ năng ngoài (external) từ skills.sh')
    .option('-n, --name <name>', 'Đặt tên ngắn gọn cho kỹ năng (mặc định: tự sinh từ source)')
    .option('-f, --force', 'Bỏ qua cảnh báo xung đột để cài đè')
    .action(async (source, options) => {
        const parsedSource = parseSource(source);
        if (!parsedSource) {
            console.log(chalk.red.bold(`\n❌ Source không hợp lệ. Định dạng đúng: owner/repo hoặc URL GitHub.\n`));
            return;
        }

        // Sinh tên skill từ source nếu không có --name
        const skillName = options.name || parsedSource.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-');

        if (!isValidSkillName(skillName)) {
            console.log(chalk.red.bold(`\n❌ Tên kỹ năng "${skillName}" không hợp lệ. Dùng --name <tên> để đặt tên thủ công.\n`));
            return;
        }

        const configFile = findConfigFile();
        if (!configFile) {
            console.log(chalk.red.bold('\n❌ Không tìm thấy file Omni. Hãy chạy "omni init" trước.\n'));
            return;
        }

        const manifest = loadManifest();

        // Kiểm tra trùng lặp
        const conflict = findSkillConflict(manifest, skillName);
        if (conflict && !options.force) {
            const via = 'omni equip';
            console.log(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skillName}" đã được cài đặt trước đó (qua ${via}).`));
            console.log(chalk.yellow(`   Dùng thêm cờ ${chalk.cyan('--force')} nếu bạn muốn ghi đè.\n`));
            return;
        }

        const agentFlags = getAgentFlags(manifest);
        console.log(chalk.cyan.bold(`\n🔧 Đang cài đặt kỹ năng external: ${chalk.white(parsedSource)}`));
        if (agentFlags) console.log(chalk.gray(`   Target: ${agentFlags}`));
        console.log('');

        try {
            const args = ['skills', 'add', parsedSource];
            if (agentFlags) args.push(...agentFlags.split(' '));
            execFileSync('npx', args, { stdio: 'inherit' });
        } catch (err) {
            console.log(chalk.red.bold(`\n❌ Quá trình cài đặt thất bại. Vui lòng kiểm tra lại source hoặc mạng.\n`));
            return;
        }

        // Đăng ký vào manifest
        if (!conflict) {
            manifest.skills.external.push({
                name: skillName,
                source: parsedSource,
                installedAt: new Date().toISOString()
            });
        } else if (conflict.type === 'external') {
            const ext = manifest.skills.external.find(s => s.name === skillName);
            if (ext) {
                ext.source = parsedSource;
                ext.installedAt = new Date().toISOString();
            }
        }

        manifest.configFile = configFile;
        saveManifest(manifest);

        console.log(chalk.green.bold(`\n✅ Kỹ năng [${skillName}] đã được cài đặt và đồng bộ thành công!`));
        console.log(chalk.gray(`   Source: ${parsedSource}`));
        console.log(chalk.gray(`   Manifest: ${MANIFEST_FILE}\n`));
    });

// ---------- AUTO-EQUIP ----------
program
    .command('auto-equip')
    .description('Cài đặt universal skills (skill chuyên sâu do AI đề xuất qua >om:equip + find-skills)')
    .option('-y, --yes', 'Tự động cài đặt không cần xác nhận')
    .action(async (options) => {
        const configFile = findConfigFile();
        if (!configFile) {
            console.log(chalk.red.bold('\n❌ Không tìm thấy file Omni. Hãy chạy "omni init" trước.\n'));
            return;
        }

        const manifest = loadManifest();
        const alreadyInstalled = manifest.skills.external.map(s => s.name);
        const toInstall = UNIVERSAL_SKILLS.filter(s => !alreadyInstalled.includes(s.name));

        if (toInstall.length === 0) {
            console.log(chalk.green.bold('\n✅ Tất cả skills đã được cài đặt rồi! Dùng "omni status" để xem chi tiết.\n'));
            return;
        }

        console.log(chalk.cyan.bold('📦 Danh sách skills sẽ được cài từ skills.sh:\n'));
        toInstall.forEach((s, i) => {
            const badge = alreadyInstalled.includes(s.name) ? chalk.gray('(đã có)') : chalk.green('MỚI');
            console.log(chalk.white(`   ${i + 1}. ${chalk.bold(s.name)} ${badge}`));
            console.log(chalk.gray(`      └─ ${s.desc} (${s.source})`));
        });
        console.log('');

        const agentFlags = getAgentFlags(manifest);

        if (!options.yes) {
            const { confirmed } = await prompts({
                type: 'confirm',
                name: 'confirmed',
                message: `Cài đặt ${toInstall.length} skills trên?`,
                initial: true
            });

            if (!confirmed) {
                console.log(chalk.yellow('\n⚠️  Hủy bỏ.\n'));
                return;
            }
        } else {
            console.log(chalk.green(`⚡ Auto-install: ${toInstall.length} skills (project-level)\n`));
        }

        let installed = 0;
        let failed = 0;

        if (agentFlags) {
            console.log(chalk.gray(`   Target: ${agentFlags}\n`));
        }

        for (const skill of toInstall) {
            console.log(chalk.cyan(`\n🔧 [${installed + failed + 1}/${toInstall.length}] Đang cài: ${chalk.white(skill.name)}...`));
            try {
                const skillArgs = ['-y', 'skills', 'add', skill.source];
                if (agentFlags) {
                    skillArgs.push(...agentFlags.split(' '), '--skill', '*', '-y');
                } else if (options.yes) {
                    skillArgs.push('--all');
                }
                execFileSync('npx', skillArgs, { stdio: 'inherit', timeout: 60000 });
                manifest.skills.external.push({
                    name: skill.name,
                    source: skill.source,
                    installedAt: new Date().toISOString()
                });
                installed++;
                console.log(chalk.green(`   ✓ ${skill.name}`));
            } catch {
                failed++;
                console.log(chalk.red(`   ✗ ${skill.name} — thất bại, bỏ qua`));
            }
        }

        manifest.configFile = configFile;
        saveManifest(manifest);

        console.log(chalk.cyan.bold('\n' + '─'.repeat(45)));
        console.log(chalk.green.bold(`   ✅ Thành công: ${installed}/${toInstall.length} skills`));
        if (failed > 0) {
            console.log(chalk.red(`   ❌ Thất bại: ${failed} skills`));

            const failedSkills = toInstall.filter(s => !manifest.skills.external.some(e => e.name === s.name));
            if (failedSkills.length > 0) {
                const scriptName = 'install-skills.sh';
                const scriptPath = path.join(process.cwd(), scriptName);
                let script = '#!/bin/bash\n';
                script += '# Generated by Omni-Coder Kit — retry failed skills\n';
                script += `# Failed: ${failedSkills.length} skills\n\n`;
                script += 'set -e\n\n';

                for (const skill of failedSkills) {
                    const installCmd = agentFlags
                        ? `npx -y skills add ${skill.source} ${agentFlags} --skill '*' -y`
                        : `npx -y skills add ${skill.source} --all`;
                    script += `echo "🔧 Đang cài: ${skill.name} (${skill.source})..."\n`;
                    script += `${installCmd}\n`;
                    script += `echo "   ✓ ${skill.name}"\n\n`;
                }

                script += `echo ""\necho "✅ Hoàn tất! Đã cài ${failedSkills.length} skills."\n`;
                script += `echo "💡 Chạy 'omni status' để xem trạng thái."\n`;

                if (writeFileSafe(scriptPath, script)) {
                    try { fs.chmodSync(scriptPath, '755'); } catch {}
                    console.log(chalk.yellow(`\n   💡 Đã tạo ${chalk.white(scriptName)} cho ${failedSkills.length} skill thất bại.`));
                    console.log(chalk.yellow(`      Có thể do sandbox chặn mạng (Codex CLI, etc.).`));
                    console.log(chalk.white(`      Chạy ngoài sandbox: `) + chalk.cyan.bold(`bash ${scriptName}`));
                }
            }
        }
        console.log(chalk.gray(`   Manifest: ${MANIFEST_FILE}`));
        console.log(chalk.cyan.bold('─'.repeat(45) + '\n'));
    });

// ---------- STATUS ----------
program
    .command('status')
    .description('Xem trạng thái skills đã cài đặt')
    .action(() => {
        const manifest = loadManifest();
        const configFile = findConfigFile();

        console.log(chalk.cyan.bold('\n📊 Trạng thái Omni-Coder Kit\n'));
        console.log(chalk.white(`   Config file : ${configFile || chalk.red('(chưa init)')}`));
        console.log(chalk.white(`   Manifest    : ${fs.existsSync(path.join(process.cwd(), MANIFEST_FILE)) ? chalk.green('✓ có') : chalk.yellow('✗ chưa tạo')}\n`));

        // Skills (external via omni equip / auto-equip)
        console.log(chalk.cyan.bold('   🌐 Skills đã cài (omni equip / auto-equip):'));
        if (manifest.skills.external.length === 0) {
            console.log(chalk.gray('      (chưa có)'));
        } else {
            manifest.skills.external.forEach(s => {
                const date = new Date(s.installedAt).toLocaleDateString('vi-VN');
                console.log(chalk.green(`      ✓ ${s.name}`) + chalk.gray(` ← ${s.source} (${date})`));
            });
        }

        const total = manifest.skills.external.length;
        console.log(chalk.white(`\n   Tổng: ${total} skills đã cài đặt.\n`));
    });

// ---------- COMMANDS (>om: workflow reference) ----------
program
    .command('commands')
    .description('Hiển thị danh sách các lệnh >om: dùng trong chat với AI')
    .action(() => {
        console.log(chalk.cyan.bold('\n📋 Danh sách lệnh >om: (gõ trong chat với AI)\n'));

        const commands = [
            { cmd: '>om:brainstorm', slash: '/om:brainstorm', role: 'Architect',  desc: 'Phỏng vấn yêu cầu → đề xuất Tech Stack → xuất design-spec.md' },
            { cmd: '>om:equip',      slash: '/om:equip',      role: 'Skill Mgr',  desc: 'Cài universal skills + tìm & đề xuất skills từ skills.sh theo design-spec' },
            { cmd: '>om:plan',       slash: '/om:plan',        role: 'PM',          desc: 'Phân tích design-spec → micro-tasks trong todo.md (<20 phút/task)' },
            { cmd: '>om:cook',       slash: '/om:cook',        role: 'Coder',       desc: 'Sub-agent parallel execution, dependency graph, worktree isolation' },
            { cmd: '>om:check',      slash: '/om:check',       role: 'QA Tester',   desc: 'Validation pipeline: security → lint → build → test → feature verify' },
            { cmd: '>om:fix',        slash: '/om:fix',          role: 'Debugger',    desc: 'Reproduce → root cause → surgical fix → verify (không shotgun-fix)' },
            { cmd: '>om:doc',        slash: '/om:doc',          role: 'Writer',      desc: 'Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt' },
            { cmd: '>om:learn',      slash: '/om:learn',        role: 'Learner',     desc: 'Đúc kết bài học từ bug fix → ghi vào knowledge-base.md (auto sau >om:fix)' },
        ];

        const maxCmd   = Math.max(...commands.map(c => c.cmd.length));
        const maxSlash = Math.max(...commands.map(c => c.slash.length));
        const maxRole  = Math.max(...commands.map(c => c.role.length));

        commands.forEach(({ cmd, slash, role, desc }) => {
            const paddedCmd   = cmd.padEnd(maxCmd);
            const paddedSlash = slash.padEnd(maxSlash);
            const paddedRole  = role.padEnd(maxRole);
            console.log(`  ${chalk.yellow.bold(paddedCmd)}  ${chalk.cyan(paddedSlash)}  ${chalk.gray('│')} ${chalk.green(paddedRole)}  ${chalk.gray('│')} ${chalk.white(desc)}`);
        });

        console.log(chalk.gray('\n  ─────────────────────────────────────────────────────'));
        console.log(chalk.white('  Workflow: ') + chalk.cyan('brainstorm → equip → plan → cook → check → fix → doc'));
        console.log(chalk.gray('\n  Lưu ý: Các lệnh >om: được gõ trực tiếp trong chat AI (Claude, Codex, Cursor...),'));
        console.log(chalk.gray('  không phải lệnh terminal. Claude Code users: dùng /om:* (auto-complete).'));
        console.log(chalk.gray('  Chạy ') + chalk.yellow('omni init') + chalk.gray(' trước để tạo file luật cho AI.\n'));
    });

// ---------- UPDATE ----------
program
    .command('update')
    .description('Kiểm tra và cập nhật omni-coder-kit lên phiên bản mới nhất')
    .action(() => {
        const current = PKG.version;
        console.log(chalk.cyan(`\n🔍 Phiên bản hiện tại: ${chalk.white.bold('v' + current)}`));
        console.log(chalk.gray('   Đang kiểm tra phiên bản mới trên npm...\n'));

        let latest;
        try {
            latest = execSync('npm view omni-coder-kit version', { encoding: 'utf-8' }).trim();
        } catch {
            console.log(chalk.red.bold('❌ Không thể kiểm tra npm. Kiểm tra kết nối mạng.\n'));
            return;
        }

        if (current === latest) {
            console.log(chalk.green.bold(`✅ Đã là phiên bản mới nhất (v${current}).\n`));
            return;
        }

        console.log(chalk.yellow(`   Phiên bản mới: ${chalk.white.bold('v' + latest)} (hiện tại: v${current})\n`));
        console.log(chalk.cyan('   Đang cập nhật...'));

        try {
            execSync('npm install -g omni-coder-kit@latest', { stdio: 'inherit', timeout: 60000 });
            console.log(chalk.green.bold(`\n✅ Đã cập nhật lên v${latest}!\n`));
        } catch {
            console.log(chalk.red.bold('\n❌ Cập nhật thất bại. Thử chạy thủ công:'));
            console.log(chalk.cyan('   npm install -g omni-coder-kit@latest\n'));
        }
    });

// ---------- RULES (personal rules management) ----------
program
    .command('rules [action]')
    .description('Quản lý personal rules (xem/sửa/sync/reset)')
    .action(async (action) => {
        const rulesPath = path.join(process.cwd(), RULES_FILE);
        const configFile = findConfigFile();

        if (!action) {
            // Menu chính
            const { choice } = await prompts({
                type: 'select',
                name: 'choice',
                message: 'Personal Rules — chọn thao tác:',
                choices: [
                    { title: '📋 Xem rules hiện tại', value: 'view' },
                    { title: '✏️  Sửa rules', value: 'edit' },
                    { title: '🔄 Sync vào config file', value: 'sync' },
                    { title: '🗑️  Reset (xóa rules)', value: 'reset' },
                ],
            });
            action = choice;
        }

        if (!action) return;

        if (action === 'view') {
            if (!fs.existsSync(rulesPath)) {
                console.log(chalk.yellow(`\n⚠️  Chưa có personal rules. Chạy ${chalk.cyan('omni rules edit')} hoặc ${chalk.cyan('omni init')} để tạo.\n`));
                return;
            }
            console.log(chalk.cyan.bold('\n📋 Personal Rules:\n'));
            console.log(fs.readFileSync(rulesPath, 'utf-8'));
            return;
        }

        if (action === 'edit') {
            console.log(chalk.cyan.bold('\n✏️  Sửa Personal Rules') + chalk.gray(' (Enter để giữ nguyên)\n'));

            let existing = { language: '', codingStyle: '', forbidden: '', custom: '' };
            if (fs.existsSync(rulesPath)) {
                const content = fs.readFileSync(rulesPath, 'utf-8');
                const extractSection = (name) => {
                    const regex = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`);
                    const match = content.match(regex);
                    return match ? match[1].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2)).join('; ') : '';
                };
                existing.language = extractSection('Ngôn ngữ');
                existing.codingStyle = extractSection('Coding Style');
                existing.forbidden = extractSection('Forbidden Patterns');
                existing.custom = extractSection('Custom Rules');
            }

            const rp = await prompts([
                { type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp? (VD: "Tiếng Việt", "English only")', initial: existing.language },
                { type: 'text', name: 'codingStyle', message: 'Coding style / conventions? (VD: "camelCase, 2-space indent, prefer const")', initial: existing.codingStyle },
                { type: 'text', name: 'forbidden', message: 'Forbidden patterns? (VD: "không dùng any, không inline styles")', initial: existing.forbidden },
                { type: 'text', name: 'custom', message: 'Custom rules (phân cách bằng ;)? (VD: "commit message tiếng Việt; luôn viết test")', initial: existing.custom },
            ]);

            const content = buildRulesContent(rp);
            if (!content) {
                console.log(chalk.yellow('\n⚠️  Không có rules nào được nhập.\n'));
                return;
            }

            writeFileSafe(rulesPath, content);
            console.log(chalk.green.bold(`\n✅ Đã lưu ${RULES_FILE}`));

            if (configFile && syncRulesToConfig()) {
                console.log(chalk.green(`   ✅ Đã sync vào ${configFile}\n`));
            } else if (configFile) {
                console.log(chalk.yellow(`   ⚠️  Không thể sync vào ${configFile}. Chạy ${chalk.cyan('omni rules sync')} thủ công.\n`));
            }
            return;
        }

        if (action === 'sync') {
            if (!fs.existsSync(rulesPath)) {
                console.log(chalk.red(`\n❌ Không tìm thấy ${RULES_FILE}. Chạy ${chalk.cyan('omni rules edit')} trước.\n`));
                return;
            }
            if (!configFile) {
                console.log(chalk.red(`\n❌ Không tìm thấy config file. Chạy ${chalk.cyan('omni init')} trước.\n`));
                return;
            }
            if (syncRulesToConfig()) {
                console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
            } else {
                console.log(chalk.red('\n❌ Sync thất bại.\n'));
            }
            return;
        }

        if (action === 'reset') {
            if (!fs.existsSync(rulesPath)) {
                console.log(chalk.yellow('\n⚠️  Không có rules để xóa.\n'));
                return;
            }
            const { confirm } = await prompts({
                type: 'confirm',
                name: 'confirm',
                message: `Xóa ${RULES_FILE} và remove rules khỏi config file?`,
                initial: false,
            });
            if (!confirm) {
                console.log(chalk.yellow('\n⚠️  Hủy bỏ.\n'));
                return;
            }

            fs.unlinkSync(rulesPath);
            console.log(chalk.green(`   ✅ Đã xóa ${RULES_FILE}`));

            if (configFile) {
                const configPath = path.join(process.cwd(), configFile);
                let config = fs.readFileSync(configPath, 'utf-8');
                const startMarker = '<!-- omni:rules -->';
                const endMarker = '<!-- /omni:rules -->';
                if (config.includes(startMarker)) {
                    const regex = new RegExp(`\\n*${startMarker}[\\s\\S]*?${endMarker}\\n*`, 'g');
                    config = config.replace(regex, '\n');
                    writeFileSafe(configPath, config);
                    console.log(chalk.green(`   ✅ Đã remove rules khỏi ${configFile}`));
                }
            }
            console.log('');
            return;
        }

        console.log(chalk.red(`\n❌ Action không hợp lệ: ${action}. Dùng: view, edit, sync, reset\n`));
    });

program.parse(process.argv);
