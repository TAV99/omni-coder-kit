'use strict';

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');

const { detectDNA } = require('../helpers');
const { formatInject } = require('../rules');
const {
    buildCommands, buildSettings, buildCodexConfig, buildCodexHooks,
    buildCursorMcp, buildCursorRules, buildCursorBootstrapRules,
    buildWindsurfRules, buildWindsurfBootstrapRules,
    buildGeminiModules, buildGeminiBootstrapContent,
    buildAntigravityRules, buildAntigravityBootstrapRules,
    buildAntigravityCommands, buildAntigravityWorkflows, buildAntigravityHooks,
    buildAntigravityPolicy, buildAntigravityMcpConfig, buildAntigravityExtension, buildAntigravitySkills,
    buildStrictnessBlock,
} = require('../init');
const os = require('os');
const { writeFileSafe, saveManifest } = require('./helpers');

async function setupClaudeAdvanced(manifest, ide) {
    const slashCommands = buildCommands(ide);
    if (!slashCommands) return;

    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const claudeCommandsDir = path.join(projectDir, '.claude', 'commands');
    fs.mkdirSync(claudeCommandsDir, { recursive: true });
    for (const [name, srcPath] of Object.entries(slashCommands)) {
        fs.copyFileSync(srcPath, path.join(claudeCommandsDir, name));
    }
    manifest.commands = Object.keys(slashCommands).map(f => f.replace('.md', ''));
    saveManifest(manifest);
    console.log(chalk.gray(`   Commands: .claude/commands/ (${Object.keys(slashCommands).length} slash commands)`));

    const { advanced } = await prompts({
        type: 'confirm',
        name: 'advanced',
        message: '🔧 Cài đặt Claude Code nâng cao? (permissions allowlist, quality gate hooks)',
        initial: false
    }, { onCancel });
    if (cancelled) return;

    const settingsContent = buildSettings(ide, advanced);
    if (settingsContent) {
        const claudeDir = path.join(projectDir, '.claude');
        fs.mkdirSync(claudeDir, { recursive: true });
        const settingsPath = path.join(claudeDir, 'settings.json');
        let writeSettings = true;
        if (fs.existsSync(settingsPath)) {
            const { overwriteSettings } = await prompts({
                type: 'confirm',
                name: 'overwriteSettings',
                message: '⚠️  File ".claude/settings.json" đã tồn tại. Ghi đè?',
                initial: false
            }, { onCancel });
            if (cancelled) return;
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

async function setupCodexAdvanced(manifest, ide) {
    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const { codexAdvanced } = await prompts({
        type: 'confirm',
        name: 'codexAdvanced',
        message: 'Codex CLI nang cao? (.codex/config.toml + hooks)',
        initial: false
    }, { onCancel });
    if (cancelled) return;

    const codexConfig = buildCodexConfig(ide, codexAdvanced);
    const codexHooks = buildCodexHooks(ide, codexAdvanced);

    if (codexConfig || codexHooks) {
        const codexDir = path.join(projectDir, '.codex');
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
                }, { onCancel });
                if (cancelled) return;
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
                }, { onCancel });
                if (cancelled) return;
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

async function setupCursorAdvanced(manifest, ide, initFiles, parsedRules, rulesContent, strictness, fileName) {
    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const { cursorAdvanced } = await prompts({
        type: 'confirm',
        name: 'cursorAdvanced',
        message: '🔧 Cài đặt Cursor nâng cao? (MDC rules, MCP config, YOLO guardrails)',
        initial: false
    }, { onCancel });
    if (cancelled) return;

    if (cursorAdvanced) {
        const dnaProfile = detectDNA(projectDir);

        const mdcRules = buildCursorRules(dnaProfile);
        if (mdcRules) {
            const cursorRulesDir = path.join(projectDir, '.cursor', 'rules');
            fs.mkdirSync(cursorRulesDir, { recursive: true });
            for (const rule of mdcRules) {
                fs.copyFileSync(rule.src, path.join(cursorRulesDir, rule.name));
            }
            console.log(chalk.green(`   ✅ .cursor/rules/ (${mdcRules.length} MDC rules)`));
        }

        const mcpConfig = buildCursorMcp(projectDir);
        if (mcpConfig) {
            const cursorDir = path.join(projectDir, '.cursor');
            fs.mkdirSync(cursorDir, { recursive: true });
            const mcpPath = path.join(cursorDir, 'mcp.json');
            writeFileSafe(mcpPath, mcpConfig);
            const serverCount = Object.keys(JSON.parse(mcpConfig).mcpServers).length;
            console.log(chalk.green(`   ✅ .cursor/mcp.json (${serverCount} MCP servers)`));
        }

        const personalRulesBlock = rulesContent
            ? `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n`
            : '';
        const strictnessBlock = buildStrictnessBlock(strictness);
        const mainConfigFile = initFiles.find(f => f.path === fileName);
        const finalRules = mainConfigFile ? mainConfigFile.content : '';
        const bootstrapRules = buildCursorBootstrapRules(finalRules, strictnessBlock, personalRulesBlock);
        const targetPath = path.join(projectDir, fileName);
        writeFileSafe(targetPath, bootstrapRules);
        console.log(chalk.green(`   ✅ .cursorrules (bootstrap mode — rules in .cursor/rules/)`));
    }

    manifest.overlay = true;
    manifest.advanced = !!cursorAdvanced;
    saveManifest(manifest);
}

async function setupWindsurfAdvanced(manifest, ide, initFiles, parsedRules, rulesContent, strictness, fileName) {
    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const { windsurfAdvanced } = await prompts({
        type: 'confirm',
        name: 'windsurfAdvanced',
        message: '🔧 Cài đặt Windsurf nâng cao? (Modular rules in .windsurf/rules/)',
        initial: false
    }, { onCancel });
    if (cancelled) return;

    if (windsurfAdvanced) {
        const dnaProfile = detectDNA(projectDir);

        const wsRules = buildWindsurfRules(dnaProfile);
        if (wsRules) {
            const wsRulesDir = path.join(projectDir, '.windsurf', 'rules');
            fs.mkdirSync(wsRulesDir, { recursive: true });
            for (const rule of wsRules) {
                fs.copyFileSync(rule.src, path.join(wsRulesDir, rule.name));
            }
            console.log(chalk.green(`   ✅ .windsurf/rules/ (${wsRules.length} rule files)`));
        }

        const personalRulesBlock = rulesContent
            ? `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n`
            : '';
        const strictnessBlock = buildStrictnessBlock(strictness);
        const bootstrapRules = buildWindsurfBootstrapRules(strictnessBlock, personalRulesBlock);
        const targetPath = path.join(projectDir, fileName);
        writeFileSafe(targetPath, bootstrapRules);
        console.log(chalk.green(`   ✅ .windsurfrules (bootstrap mode — rules in .windsurf/rules/)`));
    }

    manifest.overlay = true;
    manifest.advanced = !!windsurfAdvanced;
    saveManifest(manifest);
}

async function setupGeminiAdvanced(manifest, ide, initFiles, parsedRules, rulesContent, strictness, fileName) {
    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const { geminiAdvanced } = await prompts({
        type: 'confirm',
        name: 'geminiAdvanced',
        message: '🔧 Cài đặt Gemini nâng cao? (Modular GEMINI.md with @file imports)',
        initial: false
    }, { onCancel });
    if (cancelled) return;

    if (geminiAdvanced) {
        const modules = buildGeminiModules();
        if (modules) {
            const geminiDir = path.join(projectDir, '.gemini');
            fs.mkdirSync(geminiDir, { recursive: true });
            for (const mod of modules) {
                fs.copyFileSync(mod.src, path.join(geminiDir, mod.name));
            }
            console.log(chalk.green(`   ✅ .gemini/ (${modules.length} module files)`));
        }

        const personalRulesBlock = rulesContent
            ? `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n`
            : '';
        const strictnessBlock = buildStrictnessBlock(strictness);
        const bootstrapContent = buildGeminiBootstrapContent(strictnessBlock, personalRulesBlock);
        const targetPath = path.join(projectDir, fileName);
        writeFileSafe(targetPath, bootstrapContent);
        console.log(chalk.green(`   ✅ GEMINI.md (modular mode — modules in .gemini/)`));
    }

    manifest.overlay = true;
    manifest.advanced = !!geminiAdvanced;
    saveManifest(manifest);
}

// Opt-in: install agy config where the CLI actually reads it (verified paths):
//   ~/.gemini/config/hooks.json · ~/.gemini/config/mcp_config.json ·
//   ~/.gemini/extensions/omni-coder-kit/ (gemini-extension.json + skills)
// Never clobber existing files — skip with a notice (respects user's global setup).
async function maybeInstallAntigravityGlobal({ extension, mcpConfig, hooks, policy, skills, onCancel }) {
    const { installGlobal } = await prompts({
        type: 'confirm',
        name: 'installGlobal',
        message: '🌐 Cài cấu hình global vào ~/.gemini/ (hooks + MCP + extension) để agy nhận diện & active ngay?',
        initial: false,
    }, { onCancel });
    if (!installGlobal) return;

    const home = os.homedir();
    const configDir = path.join(home, '.gemini', 'config');
    const extDir = path.join(home, '.gemini', 'extensions', 'omni-coder-kit');

    const writeIfAbsent = (target, content, label) => {
        if (fs.existsSync(target)) {
            console.log(chalk.yellow(`   ⏭  ${label} đã tồn tại — giữ nguyên (${target})`));
            return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        console.log(chalk.green(`   ✅ ${label} → ${target}`));
    };

    if (hooks) writeIfAbsent(path.join(configDir, 'hooks.json'), hooks, 'hooks.json');
    if (mcpConfig) writeIfAbsent(path.join(configDir, 'mcp_config.json'), mcpConfig, 'mcp_config.json');
    if (policy) writeIfAbsent(path.join(configDir, 'policy.toml'), policy, 'policy.toml (apply via /permissions)');
    if (extension) writeIfAbsent(path.join(extDir, 'gemini-extension.json'), extension, 'extension manifest');
    if (skills) {
        for (const s of skills) {
            writeIfAbsent(path.join(extDir, 'skills', s.name, 'SKILL.md'), s.content, `skill ${s.name}`);
        }
    }
    console.log(chalk.gray('   Mở agy và chạy /mcp, /skills, /hooks để xác nhận.'));
}

async function setupAntigravityAdvanced(manifest, ide, initFiles, parsedRules, rulesContent, strictness, fileName) {
    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const { antigravityAdvanced } = await prompts({
        type: 'confirm',
        name: 'antigravityAdvanced',
        message: '🔧 Cài đặt Antigravity nâng cao? (Modular rules in .agents/rules/)',
        initial: false
    }, { onCancel });
    if (cancelled) return;

    if (antigravityAdvanced) {
        const dnaProfile = detectDNA(projectDir);
        const rules = buildAntigravityRules(dnaProfile);
        if (rules) {
            const rulesDir = path.join(projectDir, '.agents', 'rules');
            fs.mkdirSync(rulesDir, { recursive: true });
            for (const r of rules) {
                fs.copyFileSync(r.src, path.join(rulesDir, r.name));
            }
            console.log(chalk.green(`   ✅ .agents/rules/ (${rules.length} rule files)`));
        }

        const slashCommands = buildAntigravityCommands(ide);
        const customWorkflows = buildAntigravityWorkflows(ide);
        if (slashCommands || customWorkflows) {
            const agentsWorkflowsDir = path.join(projectDir, '.agents', 'workflows');
            fs.mkdirSync(agentsWorkflowsDir, { recursive: true });
            const registeredCommands = [];

            if (slashCommands) {
                for (const [name, srcPath] of Object.entries(slashCommands)) {
                    const baseName = name.replace('.md', '');
                    const cleanName = baseName.replace('om:', '');
                    
                    fs.copyFileSync(srcPath, path.join(agentsWorkflowsDir, name));
                    fs.copyFileSync(srcPath, path.join(agentsWorkflowsDir, `om-${cleanName}.md`));
                    fs.copyFileSync(srcPath, path.join(agentsWorkflowsDir, `${cleanName}.md`));

                    registeredCommands.push(baseName, `om-${cleanName}`, cleanName);
                }
            }

            if (customWorkflows) {
                for (const [name, srcPath] of Object.entries(customWorkflows)) {
                    fs.copyFileSync(srcPath, path.join(agentsWorkflowsDir, name));
                }
            }

            manifest.commands = registeredCommands;
            console.log(chalk.green(`   ✅ .agents/workflows/ (${registeredCommands.length} slash commands + ${Object.keys(customWorkflows || {}).length} custom workflows)`));
        }

        const hooks = buildAntigravityHooks(ide);
        if (hooks) {
            fs.writeFileSync(path.join(projectDir, '.agents', 'hooks.json'), hooks);
            console.log(chalk.green(`   ✅ .agents/hooks.json (AfterTool verify — install globally to activate)`));
        }

        // Recommended permission policy (TOML policy engine — apply via /permissions)
        const policy = buildAntigravityPolicy(ide);
        if (policy) {
            fs.writeFileSync(path.join(projectDir, '.agents', 'policy.toml'), policy);
            console.log(chalk.green(`   ✅ .agents/policy.toml (deny rm -rf / force-push / hard-reset)`));
        }

        // Native agy skills: .agents/skills/<name>/SKILL.md → /<name>
        const skills = buildAntigravitySkills(ide);
        if (skills) {
            for (const s of skills) {
                const skillDir = path.join(projectDir, '.agents', 'skills', s.name);
                fs.mkdirSync(skillDir, { recursive: true });
                fs.writeFileSync(path.join(skillDir, 'SKILL.md'), s.content);
            }
            console.log(chalk.green(`   ✅ .agents/skills/ (${skills.length} native skills — /om-*)`));
        }

        // gemini-extension.json manifest (+ DNA-based mcp_config.json template)
        const extension = buildAntigravityExtension(projectDir);
        fs.writeFileSync(path.join(projectDir, 'gemini-extension.json'), extension);
        const mcpConfig = buildAntigravityMcpConfig(projectDir);
        fs.writeFileSync(path.join(projectDir, '.agents', 'mcp_config.json'), mcpConfig);
        console.log(chalk.green(`   ✅ gemini-extension.json + .agents/mcp_config.json (MCP per stack)`));

        await maybeInstallAntigravityGlobal({ extension, mcpConfig, hooks, policy, skills, onCancel });
        if (cancelled) return;

        const personalRulesBlock = rulesContent
            ? `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n`
            : '';
        const strictnessBlock = buildStrictnessBlock(strictness);
        const bootstrapContent = buildAntigravityBootstrapRules(strictnessBlock, personalRulesBlock);
        const targetPath = path.join(projectDir, fileName);
        writeFileSafe(targetPath, bootstrapContent);
        console.log(chalk.green(`   ✅ AGENTS.md (modular mode — rules in .agents/rules/)`));
    }

    manifest.overlay = true;
    manifest.advanced = !!antigravityAdvanced;
    saveManifest(manifest);
}

module.exports = { setupClaudeAdvanced, setupCodexAdvanced, setupCursorAdvanced, setupWindsurfAdvanced, setupGeminiAdvanced, setupAntigravityAdvanced };
