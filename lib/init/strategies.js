'use strict';

const fs = require('fs');
const path = require('path');

const { IDE_CONFIG_FILE, createManifest } = require('../helpers');
const { formatInject } = require('../rules');
const { buildWorkflows, getOverlayDir } = require('../workflows');

// ========== TEMPLATE READER ==========

function readTemplate(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        throw new Error(`Không đọc được template ${path.basename(filePath)}: ${err.message}`);
    }
}

// ========== OVERLAY SYSTEM ==========

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

function buildCodexConfig(ide, advanced, opts = {}) {
    if (!advanced || !(ide === 'codex' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'codex');
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'config.template.toml');
    if (!fs.existsSync(templatePath)) return null;

    let content = fs.readFileSync(templatePath, 'utf-8');

    const isExactDualAuto = ide === 'dual' && opts.dualPair === 'codex-agy' && opts.mode === 'auto';
    if (isExactDualAuto) {
        const packageRoot = path.resolve(__dirname, '..', '..');
        const mcpServerPath = path.join(packageRoot, 'lib', 'dual', 'mcp-server.mjs');
        const escapedMcpPath = JSON.stringify(mcpServerPath);
        const nodeExec = JSON.stringify(process.execPath);
        const projectDir = opts.projectDir ? path.resolve(opts.projectDir) : '.';
        const escapedProjectDir = JSON.stringify(projectDir);
        content += [
            '',
            '[mcp_servers.omni_dual]',
            `command = ${nodeExec}`,
            `args = [${escapedMcpPath}, "--workspace", ${escapedProjectDir}]`,
            '',
        ].join('\n');
    }

    return content;
}

function buildCodexHooks(ide, advanced, opts = {}) {
    if (!advanced || !(ide === 'codex' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'codex');
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'hooks.template.json');
    if (!fs.existsSync(templatePath)) return null;

    const isExactDualAuto = ide === 'dual' && opts.dualPair === 'codex-agy' && opts.mode === 'auto';
    if (!isExactDualAuto) {
        return null;
    }

    let template = fs.readFileSync(templatePath, 'utf-8');
    const packageRoot = path.resolve(__dirname, '..', '..');
    const hookPath = path.join(packageRoot, 'bin', 'omni-hook.js');

    const quotePosix = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    const posixCmd = `${quotePosix(process.execPath.replace(/\\/g, '/'))} ${quotePosix(hookPath.replace(/\\/g, '/'))}`;
    const winCmd = `& "${process.execPath}" "${hookPath}"`;

    const jsonPosix = JSON.stringify(posixCmd).slice(1, -1);
    const jsonWin = JSON.stringify(winCmd).slice(1, -1);

    template = template.replaceAll('__OMNI_HOOK_COMMAND_POSIX__', jsonPosix);
    template = template.replaceAll('__OMNI_HOOK_COMMAND_WINDOWS__', jsonWin);

    return template;
}

function buildCursorMcp(projectDir) {
    const servers = {};
    servers.context7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Warning: cannot read package.json: ${err.message}`);
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;

    if (hasDep('@supabase/supabase-js'))
        servers.supabase = { command: 'npx', args: ['-y', 'supabase-mcp-server'] };
    if (hasDep('prisma') || fs.existsSync(path.join(projectDir, 'prisma', 'schema.prisma')))
        servers.prisma = { command: 'npx', args: ['-y', '@anthropic/mcp-prisma'] };
    if (hasDep('next'))
        servers.vercel = { command: 'npx', args: ['-y', '@vercel/mcp'] };
    if (hasDep('firebase') || hasDep('firebase-admin'))
        servers.firebase = { command: 'npx', args: ['-y', '@anthropic/mcp-firebase'] };
    if (fs.existsSync(path.join(projectDir, 'Dockerfile')) || fs.existsSync(path.join(projectDir, 'docker-compose.yml')))
        servers.docker = { command: 'npx', args: ['-y', '@anthropic/mcp-docker'] };
    if (fs.existsSync(path.join(projectDir, '.git')))
        servers.github = { command: 'npx', args: ['-y', '@anthropic/mcp-github'] };

    return JSON.stringify({ mcpServers: servers }, null, 2);
}

function buildCursorRules(dnaProfile) {
    const overlayDir = path.join(__dirname, '..', '..', 'templates', 'overlays', 'cursor', 'rules');
    if (!fs.existsSync(overlayDir)) return null;

    const alwaysInclude = ['core-mindset.mdc', 'workflow-commands.mdc', 'yolo-guardrails.mdc', 'agent-mode.mdc'];
    const conditionalMap = {
        'frontend.mdc': dnaProfile.hasUI,
        'backend.mdc': dnaProfile.hasBackend,
        'testing.mdc': true,
    };

    const result = [];
    for (const f of alwaysInclude) {
        const src = path.join(overlayDir, f);
        if (fs.existsSync(src)) result.push({ name: f, src });
    }
    for (const [f, include] of Object.entries(conditionalMap)) {
        if (include) {
            const src = path.join(overlayDir, f);
            if (fs.existsSync(src)) result.push({ name: f, src });
        }
    }

    return result.length > 0 ? result : null;
}

function buildGeminiModules() {
    const overlayDir = path.join(__dirname, '..', '..', 'templates', 'overlays', 'gemini', 'modules');
    if (!fs.existsSync(overlayDir)) return null;

    const modules = ['core-mindset.md', 'workflow-commands.md', 'gemini-tools.md'];
    const result = [];
    for (const f of modules) {
        const src = path.join(overlayDir, f);
        if (fs.existsSync(src)) result.push({ name: f, src });
    }
    return result.length > 0 ? result : null;
}

function buildGeminiBootstrapContent(modeBlock, personalRulesBlock) {
    let content = `> Generated by Omni-Coder Kit\n\n`;
    content += modeBlock + '\n';
    content += `@./.gemini/core-mindset.md\n\n`;
    content += `@./.gemini/workflow-commands.md\n\n`;
    content += `@./.gemini/gemini-tools.md\n\n`;
    if (personalRulesBlock) {
        content += personalRulesBlock + '\n';
    }
    return content;
}

function buildAntigravityCommands(ide) {
    if (ide !== 'antigravity') return null;
    const overlayDir = getOverlayDir(ide, 'antigravity');
    if (!overlayDir) return null;

    const commandsDir = path.join(overlayDir, 'commands');
    if (!fs.existsSync(commandsDir)) return null;

    const files = {};
    for (const f of fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(commandsDir, f);
    }

    return Object.keys(files).length > 0 ? files : null;
}

function buildAntigravityWorkflows(ide) {
    if (ide !== 'antigravity') return null;
    const overlayDir = getOverlayDir(ide, 'antigravity');
    if (!overlayDir) return null;

    const workflowsDir = path.join(overlayDir, 'workflows');
    if (!fs.existsSync(workflowsDir)) return null;

    const files = {};
    for (const f of fs.readdirSync(workflowsDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(workflowsDir, f);
    }

    return Object.keys(files).length > 0 ? files : null;
}

function buildAntigravityHooks(ide) {
    if (ide !== 'antigravity') return null;
    const overlayDir = getOverlayDir(ide, 'antigravity');
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'hooks.template.json');
    if (!fs.existsSync(templatePath)) return null;

    return fs.readFileSync(templatePath, 'utf-8');
}

// Recommended permission policy (sub-task C) — VERIFIED agy/Gemini CLI TOML
// policy engine, NOT a Claude-style allow/deny JSON. Deny destructive ops,
// ask on state-changing ops, allow read-only verification.
function buildAntigravityPolicy(ide) {
    if (ide !== 'antigravity') return null;
    const overlayDir = getOverlayDir(ide, 'antigravity');
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'policy.template.toml');
    if (!fs.existsSync(templatePath)) return null;

    return fs.readFileSync(templatePath, 'utf-8');
}

// Detect MCP servers from the project's tech-stack DNA. Shared shape with the
// Cursor overlay (mcp_config.json schema: { mcpServers: {...} } — verified for
// agy/Gemini CLI). Always seeds Context7 for live docs.
function detectMcpServers(projectDir) {
    const servers = {};
    servers.context7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Warning: cannot read package.json: ${err.message}`);
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;

    if (hasDep('@supabase/supabase-js'))
        servers.supabase = { command: 'npx', args: ['-y', 'supabase-mcp-server'] };
    if (hasDep('prisma') || fs.existsSync(path.join(projectDir, 'prisma', 'schema.prisma')))
        servers.prisma = { command: 'npx', args: ['-y', '@anthropic/mcp-prisma'] };
    if (hasDep('next'))
        servers.vercel = { command: 'npx', args: ['-y', '@vercel/mcp'] };
    if (hasDep('firebase') || hasDep('firebase-admin'))
        servers.firebase = { command: 'npx', args: ['-y', '@anthropic/mcp-firebase'] };
    if (fs.existsSync(path.join(projectDir, 'Dockerfile')) || fs.existsSync(path.join(projectDir, 'docker-compose.yml')))
        servers.docker = { command: 'npx', args: ['-y', '@anthropic/mcp-docker'] };
    if (fs.existsSync(path.join(projectDir, '.git')))
        servers.github = { command: 'npx', args: ['-y', '@anthropic/mcp-github'] };

    return servers;
}

// agy/Gemini CLI MCP config — written to ~/.gemini/config/mcp_config.json on
// global opt-in, or shipped as a project-level template.
function buildAntigravityMcpConfig(projectDir) {
    return JSON.stringify({ mcpServers: detectMcpServers(projectDir) }, null, 2);
}

// gemini-extension.json — the VERIFIED Gemini CLI / agy extension manifest
// (NOT a "plugin.json"). Bundles the MCP servers + points the agent at AGENTS.md.
function buildAntigravityExtension(projectDir) {
    let version = '0.0.0';
    try {
        version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')).version || version;
    } catch { /* keep default */ }
    return JSON.stringify({
        name: 'omni-coder-kit',
        version,
        description: 'Omni-Coder Kit — SDLC mindset, workflow commands, and skills for agy.',
        contextFileName: 'AGENTS.md',
        mcpServers: detectMcpServers(projectDir),
    }, null, 2);
}

// Short "when to use" hooks so agy surfaces each om-* skill at the right moment.
const ANTIGRAVITY_SKILL_DESC = {
    'om-go': 'One-shot full SDLC pipeline (brainstorm/intake → cook → check → acceptance → doc). Requirements-aware. Use when the user wants the whole thing done in one prompt.',
    'om-spec': 'Convert a customer spec / Q&A into .omni/sdlc/requirements.md (atomic, verifiable checklist). Use to lock the contract before coding.',
    'om-pass': 'Acceptance loop — grade product vs each requirement (test/agent+debate), write conformance.md, loop until 100% met. Use after >om-check passes when requirements.md exists.',
    'om-think': 'Interview the user and advise on architecture before any code. Use at the start of a new feature/project.',
    'om-plan': 'Break the goal into a concrete task plan (todo.md). Use after brainstorming, before coding.',
    'om-cook': 'Implement the next task strictly per the SDLC coder-execution workflow. Use to write/modify code.',
    'om-check': 'Run the quality gate (tests, lint, review). Use after coding to verify the build.',
    'om-fix': 'Diagnose and repair failing checks. Use when >om-check reports failures.',
    'om-ship': 'Stage a safe release (version, changelog, rollback plan). Use only after checks pass.',
    'om-doc': 'Write/update documentation for the change. Use before shipping.',
    'om-map': 'Generate or refresh the project map. Use to (re)build codebase knowledge.',
    'om-memo': 'Persist findings into the knowledge base. Use to capture reusable patterns/solutions.',
    'om-skill': 'Find and install relevant skills. Use to extend the agent for the current stack.',
    'om-scan': 'Onboard onto an existing codebase. Use when starting on an unfamiliar repo.',
};

// Convert the om-* command bodies into VERIFIED agy native skills:
//   .agents/skills/<name>/SKILL.md (frontmatter name+description) → /<name>.
// Returns [{ name, content }] or null.
function buildAntigravitySkills(ide) {
    if (ide !== 'antigravity') return null;
    const overlayDir = getOverlayDir(ide, 'antigravity');
    if (!overlayDir) return null;
    const commandsDir = path.join(overlayDir, 'commands');
    if (!fs.existsSync(commandsDir)) return null;

    const skills = [];
    for (const f of fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
        const cmd = f.replace('.md', '');            // e.g. "om-cook"
        const skillName = cmd;                        // "om-cook" → /om-cook
        const body = fs.readFileSync(path.join(commandsDir, f), 'utf-8').trim();
        const originalCmd = cmd.replace('om-', 'om:');
        const desc = ANTIGRAVITY_SKILL_DESC[originalCmd] || `Omni-Coder Kit ${originalCmd} workflow.`;
        const content = `---\nname: ${skillName}\ndescription: ${desc}\n---\n\n${body}\n`;
        skills.push({ name: skillName, content });
    }
    return skills.length > 0 ? skills : null;
}

function buildWindsurfRules(dnaProfile) {
    const overlayDir = path.join(__dirname, '..', '..', 'templates', 'overlays', 'windsurf', 'rules');
    if (!fs.existsSync(overlayDir)) return null;

    const alwaysInclude = ['core-mindset.md', 'workflow-commands.md', 'yolo-guardrails.md', 'cascade-mode.md'];
    const conditionalMap = {
        'frontend.md': dnaProfile.hasUI,
        'backend.md': dnaProfile.hasBackend,
        'testing.md': true,
    };

    const result = [];
    for (const f of alwaysInclude) {
        const src = path.join(overlayDir, f);
        if (fs.existsSync(src)) result.push({ name: f, src });
    }
    for (const [f, include] of Object.entries(conditionalMap)) {
        if (include) {
            const src = path.join(overlayDir, f);
            if (fs.existsSync(src)) result.push({ name: f, src });
        }
    }

    return result.length > 0 ? result : null;
}

function buildWindsurfBootstrapRules(modeBlock, personalRulesBlock) {
    let bootstrap = `> Generated by Omni-Coder Kit\n\n`;
    bootstrap += modeBlock + '\n';
    bootstrap += `## RULES SYSTEM\n`;
    bootstrap += `This project uses modular rules in \`.windsurf/rules/\`.\n`;
    bootstrap += `- Core rules (always_on) are loaded on every message\n`;
    bootstrap += `- Context-specific rules activate based on file glob patterns\n`;
    bootstrap += `- See \`.windsurf/rules/\` for full rule definitions\n\n`;
    bootstrap += `## WORKFLOW COMMANDS\n`;
    bootstrap += `Type \`>om-*\` commands in chat. Full registry in \`.windsurf/rules/workflow-commands.md\`.\n\n`;
    if (personalRulesBlock) {
        bootstrap += personalRulesBlock + '\n';
    }
    bootstrap += `## IDE SPECIFIC ADAPTERS\n`;
    bootstrap += `- **Cascade Rules:** Utilize Windsurf's context awareness. Do not duplicate existing logic.\n`;
    bootstrap += `- **Cascade Mode:** Quality loop runs automatically. See \`.windsurf/rules/cascade-mode.md\`.\n`;
    bootstrap += `- **Safety Guardrails:** Destructive operation warnings in \`.windsurf/rules/yolo-guardrails.md\`.\n`;
    return bootstrap;
}

function buildCursorBootstrapRules(fullRules, modeBlock, personalRulesBlock) {
    let bootstrap = `> Generated by Omni-Coder Kit\n\n`;
    bootstrap += modeBlock + '\n';
    bootstrap += `## RULES SYSTEM\n`;
    bootstrap += `This project uses layered MDC rules in \`.cursor/rules/\`.\n`;
    bootstrap += `- Core rules are always active\n`;
    bootstrap += `- Context-specific rules activate based on file patterns\n`;
    bootstrap += `- See \`.cursor/rules/\` for full rule definitions\n\n`;
    bootstrap += `## WORKFLOW COMMANDS\n`;
    bootstrap += `Type \`>om-*\` commands in chat. Full registry in \`.cursor/rules/workflow-commands.mdc\`.\n`;
    bootstrap += `Use @Files to read workflow files from \`.omni/workflows/\`.\n\n`;
    if (personalRulesBlock) {
        bootstrap += personalRulesBlock + '\n';
    }
    bootstrap += `## IDE SPECIFIC ADAPTERS\n`;
    bootstrap += `- **Context Gathering:** Use @Codebase, @Files, @Git, @Docs, @Web for context.\n`;
    bootstrap += `- **Agent Mode:** Cook-check-fix loop runs automatically. See \`.cursor/rules/agent-mode.mdc\`.\n`;
    bootstrap += `- **YOLO Safety:** Destructive operation warnings in \`.cursor/rules/yolo-guardrails.mdc\`.\n`;
    return bootstrap;
}

function buildAntigravityRules(dnaProfile) {
    const overlayDir = path.join(__dirname, '..', '..', 'templates', 'overlays', 'antigravity', 'rules');
    if (!fs.existsSync(overlayDir)) return null;

    const alwaysInclude = ['core-mindset.md', 'workflow-commands.md', 'antigravity-tools.md', 'yolo-guardrails.md'];
    const result = [];
    for (const f of alwaysInclude) {
        const src = path.join(overlayDir, f);
        if (fs.existsSync(src)) result.push({ name: f, src });
    }

    return result.length > 0 ? result : null;
}

function buildAntigravityBootstrapRules(modeBlock, personalRulesBlock) {
    let bootstrap = `> Generated by Omni-Coder Kit\n\n`;
    bootstrap += modeBlock + '\n';
    bootstrap += `## RULES SYSTEM\n`;
    bootstrap += `This project uses modular rules in \`.agents/rules/\`.\n`;
    bootstrap += `- Core rules are automatically loaded by Antigravity from \`.agents/rules/\`\n`;
    bootstrap += `- Keep total configuration lightweight and focused\n`;
    bootstrap += `- See \`.agents/rules/\` for modular rule definitions\n\n`;
    bootstrap += `## WORKFLOW COMMANDS\n`;
    bootstrap += `Type \`>om-*\` commands in chat. Full registry in \`.agents/rules/workflow-commands.md\`.\n\n`;
    if (personalRulesBlock) {
        bootstrap += personalRulesBlock + '\n';
    }
    bootstrap += `## IDE SPECIFIC ADAPTERS\n`;
    bootstrap += `- **Knowledge Items:** Persist architecture decisions, debugging solutions, and implementation patterns as Knowledge Items (KIs) — see \`.agents/rules/antigravity-tools.md\`.\n`;
    bootstrap += `- **Multi-Agent (Manager View):** Spawn specialized agents using \`Cmd+E\` / \`Ctrl+E\`. Each agent runs in an isolated workspace.\n`;
    bootstrap += `- **Browser Testing:** Use the integrated browser to visually verify UI changes.\n`;
    bootstrap += `- **Safety Guardrails:** Destructive operation warnings in \`.agents/rules/yolo-guardrails.md\`.\n`;
    return bootstrap;
}

function buildModeBlock(mode) {
    const common = '## RUN MODE\n'
        + '- Brainstorm KHÔNG bắt buộc. Người dùng có thể code trực tiếp hoặc gọi `>om-` ở bất kỳ bước nào.\n'
        + '- Khi người dùng gọi `>om-think`, PHẢI kích hoạt đầy đủ quy trình phỏng vấn (DNA detection + adaptive interview) như thường.\n';
    if (mode === 'auto') {
        return common
            + '- **Chế độ AUTO:** Ngay sau khi phần hỏi–đáp của `>om-think` kết thúc (đã đủ thông tin, đã ghi design-spec), '
            + 'TỰ ĐỘNG chạy tiếp chuỗi mà KHÔNG hỏi giữa các bước: '
            + '`>om-skill` (tự cài, không cần xác nhận) → `>om-plan` → `>om-cook` (đã gồm auto check→fix). '
            + 'Chỉ dừng khi: hết task & qua quality gate, hoặc gặp lỗi nghiêm trọng/BLOCKED cần người dùng.\n';
    }
    return common
        + '- **Chế độ MANUAL:** Giữ flow thủ công — người dùng tự gõ từng lệnh `>om-` '
        + '(think → skill → plan → cook → check → doc). KHÔNG tự nối chuỗi.\n';
}

const WORKFLOW_COMMANDS = [
    { cmd: 'think', file: 'requirement-analysis.md', role: 'Architect' },
    { cmd: 'skill', file: 'skill-manager.md',       role: 'Skill Manager' },
    { cmd: 'plan',  file: 'task-planning.md',        role: 'PM' },
    { cmd: 'cook',  file: 'coder-execution.md',      role: 'Coder' },
    { cmd: 'check', file: 'qa-testing.md',           role: 'QA Tester' },
    { cmd: 'fix',   file: 'debugger-workflow.md',     role: 'Debugger' },
    { cmd: 'doc',   file: 'documentation-writer.md',  role: 'Writer' },
    { cmd: 'memo',  file: 'knowledge-learn.md',       role: 'Learner' },
    { cmd: 'map',   file: 'project-map.md',           role: 'Architect' },
];

// Codex discovers each directory below .codex/skills as a native `$name` skill.
// Keep these descriptors thin: `.omni/workflows/` remains the single source of
// truth for the full workflow instructions shared across every supported IDE.
const CODEX_NATIVE_WORKFLOW_SKILLS = [
    { name: 'om-go',    file: 'go.md',                   description: 'Run the end-to-end Omni SDLC workflow.' },
    { name: 'om-think', file: 'requirement-analysis.md',  description: 'Interview and shape an implementation design.' },
    { name: 'om-spec',  file: 'intake.md',                description: 'Convert an approved request into verifiable requirements.' },
    { name: 'om-skill', file: 'skill-manager.md',         description: 'Find and install the skills needed for the task.' },
    { name: 'om-plan',  file: 'task-planning.md',         description: 'Create a concrete implementation plan.' },
    { name: 'om-cook',  file: 'coder-execution.md',       description: 'Implement the next task using the Omni SDLC workflow.' },
    { name: 'om-check', file: 'qa-testing.md',            description: 'Run Omni quality gates and review current changes.' },
    { name: 'om-fix',   file: 'debugger-workflow.md',     description: 'Diagnose and repair failed quality checks.' },
    { name: 'om-pass',  file: 'acceptance.md',            description: 'Verify acceptance against the locked requirements.' },
    { name: 'om-doc',   file: 'documentation-writer.md',  description: 'Update project documentation for the change.' },
    { name: 'om-memo',  file: 'knowledge-learn.md',       description: 'Capture reusable project knowledge.' },
    { name: 'om-map',   file: 'project-map.md',           description: 'Generate or refresh the project map.' },
    { name: 'om-ship',  file: 'shipping.md',              description: 'Prepare a safe release after checks pass.' },
];

function buildCodexNativeWorkflowSkills() {
    const workflowsDir = path.join(__dirname, '..', '..', 'templates', 'workflows');
    return CODEX_NATIVE_WORKFLOW_SKILLS
        .filter(({ file }) => fs.existsSync(path.join(workflowsDir, file)))
        .map(({ name, file, description }) => ({
            path: path.join('.codex', 'skills', name, 'SKILL.md'),
            content: [
                '---',
                `name: ${name}`,
                `description: ${description}`,
                '---',
                '',
                `# ${name}`,
                '',
                `Read \`.omni/workflows/${file}\` fully before acting. It is the canonical Omni workflow for this skill.`,
                '',
                '- Follow that workflow exactly, including its safety, approval, and verification gates.',
                '- Do not duplicate, summarize, or silently replace the workflow with this descriptor.',
                '- If the workflow file is missing, report the setup problem instead of inventing an alternative process.',
                '- Native skill invocation is `$' + name + '`; custom `/om-*` slash commands are not part of this integration.',
                '',
            ].join('\n'),
            overwritePrompt: false,
        }));
}

function buildSupportingSection(sdlcDesc) {
    return [
        '',
        'Supporting files (referenced by workflows as needed):',
        '- `.omni/workflows/pm-templates.md` - Output format standards',
        '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
        `- \`.omni/workflows/superpower-sdlc.md\` - ${sdlcDesc}`,
        '- `.omni/knowledge/knowledge-base.md` - Project lessons learned (auto-captured by >om-memo)',
        '',
        '**Recommended:** For larger tasks, run `>om-think` and `>om-plan` first. Brainstorm/plan are OPTIONAL — direct coding is allowed. Guard kept: do NOT `>om-ship` before `>om-check` passes.',
        '**Quality Pipeline:** `>om-cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
    ];
}

function buildRoleTable() {
    return [
        '| Command | Workflow File | Role |',
        '|---------|--------------|------|',
        ...WORKFLOW_COMMANDS.map(w => `| \`>om-${w.cmd}\` | \`.omni/workflows/${w.file}\` | ${w.role} |`),
    ];
}

const CLAUDE_STRATEGY = { cook: 'Main -> sub-agents (parallel)', map: 'Architect' };
const GEMINI_TOOLS = {
    think: '`ask_user`, `save_memory`', skill: '`google_web_search`',
    plan: '`tracker_create_task`', cook: '`tracker_update_task`, `enter_plan_mode`',
    check: '`run_shell_command`', fix: '`systematic-debugging`',
    doc: '`read_file`', memo: '`save_memory`', map: '`read_file`, `save_memory`',
};
const CURSOR_HINTS = {
    think: '@Codebase for project scan', skill: '@Web for skill discovery',
    plan: '@Git for recent changes', cook: '@Files for scope, Agent mode',
    check: '@Git for diff review', fix: '@Web for error research',
    doc: '@Codebase for API surface', memo: '@Git for fix history',
    map: '@Codebase for structure scan',
};

function buildCommandRegistry(ide) {
    if (ide === 'claudecode' || ide === 'dual') {
        return [
            '## WORKFLOW COMMANDS',
            '> Claude Code: dung `/om-*` slash commands (auto-complete) hoac `>om-*` trong chat.',
            '',
            'When the user invokes a `>om-` command or `/om-` slash command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Slash | Agent Strategy | Workflow File |',
            '|---------|-------|---------------|---------------|',
            ...WORKFLOW_COMMANDS.map(w => {
                const strategy = CLAUDE_STRATEGY[w.cmd] || 'Main session';
                return `| \`>om-${w.cmd}\` | \`/om-${w.cmd}\` | ${strategy} | \`.omni/workflows/${w.file}\` |`;
            }),
            ...buildSupportingSection('Full SDLC overview and pipeline diagram'),
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (ide === 'gemini') {
        return [
            '## WORKFLOW COMMANDS',
            '> Gemini CLI: type `>om-*` as normal chat text.',
            '',
            'When the user invokes a `>om-` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Agent Strategy | Gemini Tools |',
            '|---------|--------------|----------------|--------------|',
            ...WORKFLOW_COMMANDS.map(w => {
                const strategy = w.cmd === 'map' ? 'Architect' : 'Main session';
                return `| \`>om-${w.cmd}\` | \`.omni/workflows/${w.file}\` | ${strategy} | ${GEMINI_TOOLS[w.cmd]} |`;
            }),
            ...buildSupportingSection('Gemini-aware SDLC overview'),
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (ide === 'codex') {
        return [
            '## WORKFLOW COMMANDS',
            '> Codex CLI: preferred native skills are `$om-think`, `$om-plan`, `$om-cook`, and the other `$om-*` entries. `>om-*` remains a compatibility text alias. Codex custom project `/om-*` slash commands are not assumed in this setup.',
            '',
            'When the user invokes a native `$om-*` skill, read the corresponding workflow file and follow its instructions.',
            'For a compatibility `>om-*` token, route it to the matching native `$om-*` skill.',
            'Ignore `$om-*` tokens inside inline backticks or fenced code blocks.',
            'If multiple valid commands appear, execute only the first valid command in non-code text order.',
            '',
            ...buildRoleTable(),
            '',
            'Codex native helpers:',
            '- Use `/plan` for Codex-native planning before edits.',
            '- Use `/review` for Codex-native review of current changes.',
            '- Use `/permissions` to inspect approval behavior.',
            '- Use `/agent` only when the user explicitly asks for subagents.',
            '- Use `/mcp` and `/plugins` to inspect connected tools.',
            ...buildSupportingSection('Codex-aware SDLC overview'),
            '**Token Budget:** Keep `AGENTS.md` compact; long instructions belong in `.omni/workflows/`.',
        ].join('\n');
    }

    if (ide === 'antigravity') {
        return [
            '## WORKFLOW COMMANDS',
            '> Antigravity: type `>om-*` in chat (run with `agy --dangerously-skip-permissions`). Use modular rules in `.agents/rules/` for instructions.',
            '',
            'When the user types a `>om-` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Role |',
            '|---------|--------------|------|',
            ...WORKFLOW_COMMANDS.map(w => `| \`>om-${w.cmd}\` | \`.omni/workflows/${w.file}\` | ${w.role} |`),
            ...buildSupportingSection('Antigravity-aware SDLC overview'),
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (ide === 'cursor') {
        return [
            '## WORKFLOW COMMANDS',
            '> Cursor: type `>om-*` in chat. Use @Files to read workflow files.',
            '',
            'When the user types a `>om-` command, use @Files to read the corresponding workflow file, then follow its instructions.',
            '',
            '| Command | Workflow File | Context Hints |',
            '|---------|--------------|---------------|',
            ...WORKFLOW_COMMANDS.map(w => `| \`>om-${w.cmd}\` | \`.omni/workflows/${w.file}\` | ${CURSOR_HINTS[w.cmd]} |`),
            ...buildSupportingSection('Cursor-aware SDLC overview'),
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    return [
        '## WORKFLOW COMMANDS',
        'When the user invokes a `>om-` command, read the corresponding workflow file and follow its instructions.',
        '',
        ...buildRoleTable(),
        ...buildSupportingSection('Full SDLC overview and pipeline diagram'),
        '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
    ].join('\n');
}

// ========== PER-IDE BUILDERS ==========

const WORKFLOW_TARGET = { codex: 'codex', gemini: 'gemini', cursor: 'cursor', dual: 'base' };

function collectWorkflowFiles(ide, opts) {
    const workflowTarget = WORKFLOW_TARGET[ide] || null;
    const mergedWorkflows = buildWorkflows(ide, workflowTarget, { subagents: opts.subagents || false });
    const files = [];
    for (const [name, src] of Object.entries(mergedWorkflows)) {
        files.push({
            path: path.join('.omni', 'workflows', name),
            content: null,
            sourcePath: src,
            overwritePrompt: false,
        });
    }
    return files;
}

function buildMainConfigContent(ide, modeBlock, mindset, hygiene, commandRegistry, parsedRules, rulesContent) {
    let finalRules = `> Generated by Omni-Coder Kit\n\n${modeBlock}\n${mindset}\n\n${hygiene}\n\n${commandRegistry}\n\n`;

    if (rulesContent) {
        finalRules += `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n\n`;
    }

    const fileName = IDE_CONFIG_FILE[ide] || 'SYSTEM_PROMPT.md';
    finalRules += `## IDE SPECIFIC ADAPTERS\n`;
    const integrationFile = path.join(__dirname, '..', '..', 'templates', 'integrations', `${ide}.md`);
    finalRules += fs.existsSync(integrationFile) ? readTemplate(integrationFile) : '';

    return { fileName, content: finalRules };
}

function buildDualAgentsContent(modeBlock, mindset, hygiene, parsedRules, rulesContent) {
    const codexCommandRegistry = buildCommandRegistry('codex');
    let agentsRules = `> Generated by Omni-Coder Kit (Codex CLI / Cross-tool)\n\n${modeBlock}\n${mindset}\n\n${hygiene}\n\n${codexCommandRegistry}\n\n`;

    if (rulesContent) {
        agentsRules += `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n\n`;
    }

    agentsRules += `## IDE SPECIFIC ADAPTERS\n`;
    agentsRules += `- **Codex CLI Agent Mode:** This file is auto-discovered by Codex CLI walking from project root to cwd. Keep total content under 32 KiB.\n`;
    agentsRules += `- **Preferred Native Omni Skills:** Invoke \`$om-think\`, \`$om-plan\`, \`$om-cook\`, etc. Each skill loads its canonical \`.omni/workflows/\` file. Do not rely on custom \`/om-*\` slash commands in Codex.\n`;
    agentsRules += `- **Compatibility Alias:** \`>om-*\` remains supported as normal chat text for existing habits; route it to the matching native \`$om-*\` skill.\n`;
    agentsRules += `- **Token Escape:** Ignore \`$om-*\` and \`>om-*\` tokens inside inline backticks and fenced code blocks.\n`;
    agentsRules += `- **Native Codex Commands:** Use \`/plan\`, \`/review\`, \`/permissions\`, \`/agent\`, \`/mcp\`, and \`/plugins\` when they help the current workflow.\n`;
    agentsRules += `- **Permission Awareness:** Codex uses permission profiles (read-only, workspace-write, or full-access). Do not attempt network calls or external writes unless the active profile allows them.\n`;
    agentsRules += `- **Model Recommendations:** codex-1 (flagship, default), GPT-5.5 (complex reasoning). Use \`/model\` to switch.\n`;
    agentsRules += `- **Cross-Tool Compatibility:** This file is also read by Antigravity, Gemini CLI, and other AGENTS.md-compatible tools.\n`;

    return agentsRules;
}

function buildCodexGeminiFiles() {
    const codexGeminiDir = path.join(__dirname, '..', '..', 'templates', 'codex-gemini');
    if (!fs.existsSync(codexGeminiDir)) return [];

    const result = [];
    const skillPath = path.join(codexGeminiDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
        result.push({
            path: path.join('.codex', 'skills', 'omni-codex-gemini', 'SKILL.md'),
            content: fs.readFileSync(skillPath, 'utf-8'),
            overwritePrompt: false,
        });
    }

    const flowPath = path.join(codexGeminiDir, 'ai-flow.ps1');
    if (fs.existsSync(flowPath)) {
        result.push({
            path: path.join('.omni', 'codex-gemini', 'ai-flow.ps1'),
            content: fs.readFileSync(flowPath, 'utf-8'),
            overwritePrompt: false,
        });
    }

    return result;
}

// ========== MAIN BUILD FUNCTION ==========

/**
 * Build the full init configuration for a given IDE.
 *
 * @param {string} ide - The IDE key (claudecode, codex, dual, cursor, gemini, windsurf, generic, etc.)
 * @param {object} opts - Options object
 * @param {string} opts.mode - 'auto' or 'manual'
 * @param {object|null} opts.parsedRules - Parsed personal rules object (from parseRules)
 * @param {string|null} opts.rulesContent - Formatted markdown rules (from formatMarkdown)
 * @param {string} opts.projectDir - Absolute path to the project directory
 * @param {object} opts.dnaProfile - DNA profile from detectDNA (used for cursor)
 * @param {boolean} opts.subagents - Whether sub-agents are enabled
 * @param {string|null} opts.dualPair - Pairing mode for dual IDE ('claude-codex' or 'codex-agy')
 * @returns {{ files: Array<{path: string, content: string|null, sourcePath?: string, overwritePrompt: boolean}>, dirs: string[], manifest: object }}
 */
function buildInitConfig(ide, opts) {
    const {
        mode = 'manual',
        parsedRules = null,
        rulesContent = null,
        projectDir = process.cwd(),
        dnaProfile = null,
        subagents = false,
        dualPair = null,
    } = opts || {};

    const templatesDir = path.join(__dirname, '..', '..', 'templates');
    const mindset = readTemplate(path.join(templatesDir, 'core', 'karpathy-mindset.md'));
    const hygiene = readTemplate(path.join(templatesDir, 'core', 'claudex-hygiene.md'));

    const modeBlock = buildModeBlock(mode);
    const commandRegistry = buildCommandRegistry(ide);

    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    // Main config file
    const { fileName, content } = buildMainConfigContent(
        ide, modeBlock, mindset, hygiene, commandRegistry, parsedRules, rulesContent
    );
    files.push({
        path: fileName,
        content,
        overwritePrompt: true,
    });

    if (ide === 'codex' || ide === 'dual') {
        const nativeWorkflowSkills = buildCodexNativeWorkflowSkills();
        if (ide === 'dual' && dualPair === 'codex-agy' && mode === 'auto') {
            const thinkSkill = nativeWorkflowSkills.find(({ path: skillPath }) => skillPath === path.join('.codex', 'skills', 'om-think', 'SKILL.md'));
            if (thinkSkill) {
                thinkSkill.content += [
                    '',
                    '## Dual Auto Router',
                    '',
                    'After the user-approved design is complete, continue automatically through skill selection and typed planning. Generate `.omni/sdlc/setup.json`, `.omni/sdlc/todo.md`, and the complete `.omni/sdlc/dual-plan.json`, then call exactly `omni dual bootstrap --json`. The controller executes/reuses typed setup, creates authority afterward, registers the full graph once, and resumes.',
                    '- The setup runner may self-heal only the exact legacy `native` plus `npm`/`pnpm`/`yarn`/`bun` kind mismatch. Ambiguous or security-sensitive failures remain fail-closed without a shell fallback.',
                    '- Planning artifacts remain outside the execution ledger. Never create `bootstrap-plan-artifacts`, and do not call `omni_dual_begin` or `omni_dual_register_plan` directly during AUTO bootstrap.',
                    '- Check status using `omni_dual_status`; eligible tasks are resumed by the controller.',
                    '- Eligible tasks are routed to AGY and executed automatically with worker model `gemini-3.7-flash-high` and high effort.',
                    '- Keep architecture, security, migrations, cross-module, ambiguous, and final-QC work in Codex.',
                    '- For Codex token economy, consume semantic artifacts first (`context.json`, `spec.json`, `evidence.json`, `review.json`, and bounded MCP summaries). Read raw stdout/stderr only on failure, hash/correlation mismatch, or crash recovery.',
                    '- The controller may adopt only a legacy planning-only session with a matching setup receipt and bounded planning/package drift; otherwise it fails closed without deleting the old ledger.',
                    '- While AGY owns an active lease, Codex coordinates only: no source, build, or browser writes. Wait until the AGY lease is released and the task reaches `CODEX_QC` before Codex verification or correction.',
                    '- Evaluate completion via `omni_dual_completion`.',
                    '- CLI compatibility: `omni dual status`, `omni dual resume`, and `omni dual run <task-id>` remain available for CLI workflows.',
                    '- Gemini worker runs with `--dangerously-skip-permissions` through the Node orchestrator, while Codex retains final QC and commit authority. Gemini never commits, pushes, or deploys.',
                    '',
                ].join('\n');
            }
        }
        files.push(...nativeWorkflowSkills);
        dirs.push(...nativeWorkflowSkills.map(({ path: skillPath }) => path.dirname(skillPath)));
    }

    // Dual mode: also produce AGENTS.md
    if (ide === 'dual') {
        const agentsContent = buildDualAgentsContent(
            modeBlock, mindset, hygiene, parsedRules, rulesContent
        );
        files.push({
            path: 'AGENTS.md',
            content: agentsContent,
            overwritePrompt: true,
        });

        if (dualPair === 'codex-agy') {
            const codexGeminiFiles = buildCodexGeminiFiles();
            files.push(...codexGeminiFiles);
            dirs.push(
                path.join('.codex', 'skills', 'omni-codex-gemini')
            );

            if (mode === 'auto') {
                const codexConfigContent = buildCodexConfig('dual', true, { dualPair, mode, projectDir });
                if (codexConfigContent) {
                    files.push({
                        path: path.join('.codex', 'config.toml'),
                        content: codexConfigContent,
                        overwritePrompt: true,
                    });
                }
                const codexHooksContent = buildCodexHooks('dual', true, { dualPair, mode, projectDir });
                if (codexHooksContent) {
                    files.push({
                        path: path.join('.codex', 'hooks.json'),
                        content: codexHooksContent,
                        overwritePrompt: true,
                    });
                }
                dirs.push('.codex');
            }
        }
    }

    // Personal rules file
    if (rulesContent) {
        files.push({
            path: path.join('.omni', 'rules.md'),
            content: rulesContent,
            overwritePrompt: false,
        });
    }

    // Workflow copy files
    const workflowFiles = collectWorkflowFiles(ide, { subagents });
    files.push(...workflowFiles);

    // Manifest
    const manifest = createManifest();
    manifest.configFile = fileName;
    manifest.ide = ide;
    manifest.mode = mode;
    const supportsSubagents = ['claudecode', 'codex', 'dual'].includes(ide);
    if (supportsSubagents) manifest.subagents = subagents;
    if (ide === 'dual' && dualPair === 'codex-agy') {
        manifest.dualPair = 'codex-agy';
        manifest.workerProvider = 'antigravity';
        manifest.workerPermissions = 'dangerous-auto';
        manifest.dualOrchestrator = 'omni-dual-v1';
    }

    return { files, dirs, manifest };
}

module.exports = {
    buildCommands,
    buildSettings,
    buildCodexConfig,
    buildCodexHooks,
    buildCursorMcp,
    buildCursorRules,
    buildCursorBootstrapRules,
    buildWindsurfRules,
    buildWindsurfBootstrapRules,
    buildGeminiModules,
    buildGeminiBootstrapContent,
    buildAntigravityRules,
    buildAntigravityBootstrapRules,
    buildAntigravityCommands,
    buildAntigravityWorkflows,
    buildAntigravityHooks,
    buildAntigravityPolicy,
    buildAntigravityMcpConfig,
    buildAntigravityExtension,
    buildAntigravitySkills,
    buildModeBlock,
    buildCommandRegistry,
    buildInitConfig,
    readTemplate,
};
