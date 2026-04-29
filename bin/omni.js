#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');
const { program } = require('commander');
const { execSync, execFileSync } = require('child_process');

const MANIFEST_FILE = path.join('.omni', 'manifest.json');
const PKG = require(path.join(__dirname, '..', 'package.json'));
const {
    IDE_AGENT_MAP, IDE_CONFIG_FILE, parseSource, isValidSkillName,
    createManifest, getAgentFlags, getOverlayNameForTarget, detectDNA,
} = require(path.join(__dirname, '..', 'lib', 'helpers'));
const {
    detectExistingProject, scanProject, generateMapSkeleton, refreshMap,
} = require(path.join(__dirname, '..', 'lib', 'scanner'));
const {
    UNIVERSAL_SKILLS, getTestSkillsForStack, buildSearchSuggestion,
} = require(path.join(__dirname, '..', 'lib', 'skills'));
const { parseRules, formatMarkdown, formatInject, syncRulesToConfig } = require(path.join(__dirname, '..', 'lib', 'rules'));
const { getOverlayDir, buildWorkflows } = require(path.join(__dirname, '..', 'lib', 'workflows'));
const {
    buildInitConfig, buildCommands, buildSettings, buildCodexConfig, buildCodexHooks,
    buildCursorMcp, buildCursorRules, buildCursorBootstrapRules, buildStrictnessBlock,
} = require(path.join(__dirname, '..', 'lib', 'init'));

// ========== HELPERS ==========

function findConfigFile() {
    const files = ['.cursorrules', '.windsurfrules', 'CLAUDE.md', 'GEMINI.md', 'AGENTS.md', 'SYSTEM_PROMPT.md'];
    for (const file of files) {
        if (fs.existsSync(path.join(process.cwd(), file))) return file;
    }
    return null;
}

const OMNI_GITIGNORE_PATTERNS = [
    '.omni/',
];

function ensureGitignore(ide) {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
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

function saveManifest(manifest) {
    const manifestPath = path.join(process.cwd(), MANIFEST_FILE);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    return writeFileSafe(manifestPath, JSON.stringify(manifest, null, 2));
}

const RULES_FILE = path.join('.omni', 'rules.md');


function findSkillConflict(manifest, skillName) {
    const ext = manifest.skills.external.find(s => s.name === skillName);
    if (ext) {
        return { type: 'external', name: ext.name, source: ext.source };
    }
    return null;
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
    .option('--dry-run', 'Xem trước danh sách files sẽ được tạo (không ghi)')
    .action(async (options) => {
        console.log(chalk.cyan.bold('\n🚀 Khởi tạo Omni-Coder Kit!\n'));

        // Detect existing project for Project Map generation
        let pendingMapGeneration = null;
        const detected = detectExistingProject(process.cwd());
        if (detected.detected) {
            const { generateMap } = await prompts({
                type: 'confirm',
                name: 'generateMap',
                message: `📁 Phát hiện project có sẵn (${detected.stats.files} files, ${detected.lang}). Tạo Project Map?`,
                initial: true,
            });
            if (generateMap) {
                console.log(chalk.gray('   Sẽ tạo Project Map sau khi init hoàn tất...\n'));
                pendingMapGeneration = true;
            }
        }

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

        // Sub-agent question (only for IDEs that support parallel agents)
        const supportsSubagents = ['claudecode', 'codex', 'dual'].includes(response.ide);
        let useSubagents = false;
        if (supportsSubagents) {
            const sa = await prompts({
                type: 'confirm',
                name: 'subagents',
                message: q(3, 4, 'Sử dụng sub-agents (parallel execution)? ⚠️ Tốn token hơn, nhưng nhanh hơn.'),
                initial: false,
            });
            useSubagents = !!sa.subagents;
        }
        const totalQ = supportsSubagents ? 4 : 3;

        // Personal Rules (guided + free-text)
        console.log(chalk.cyan(`\n${q(supportsSubagents ? 4 : 3, totalQ, 'Personal Rules')} ${chalk.gray('(Enter để bỏ qua từng mục)')}\n`));

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

        // Personal Rules: parse
        const parsedRules = parseRules(rulesPrompt);
        const rulesContent = formatMarkdown(parsedRules);

        // Build config via strategies
        const initResult = buildInitConfig(response.ide, {
            strictness: response.strictness,
            parsedRules,
            rulesContent,
            projectDir: process.cwd(),
            dnaProfile: null,
            subagents: useSubagents,
        });

        const { files: initFiles, dirs: initDirs, manifest } = initResult;

        if (options.dryRun) {
            console.log(chalk.cyan.bold('\n📋 Dry run — files that would be created:\n'));
            for (const file of initFiles) {
                const targetPath = path.join(process.cwd(), file.path);
                const exists = fs.existsSync(targetPath);
                const label = exists ? chalk.yellow('OVERWRITE') : chalk.green('CREATE   ');
                console.log(`  ${label}  ${file.path}`);
            }
            console.log(chalk.gray(`\n  Dirs: ${initDirs.join(', ')}`));
            console.log(chalk.gray('  No files were changed.\n'));
            return;
        }

        // Create directories
        for (const dir of initDirs) {
            fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
        }

        // Write files with overwrite prompts
        const configFiles = initFiles.filter(f => f.overwritePrompt);
        const nonPromptFiles = initFiles.filter(f => !f.overwritePrompt);

        for (const file of configFiles) {
            const targetPath = path.join(process.cwd(), file.path);
            if (fs.existsSync(targetPath)) {
                const { overwrite } = await prompts({
                    type: 'confirm',
                    name: 'overwrite',
                    message: `⚠️  File "${file.path}" đã tồn tại. Bạn có muốn ghi đè không?`,
                    initial: false
                });
                if (!overwrite) {
                    console.log(chalk.yellow(`   Bỏ qua ${file.path} (giữ nguyên file hiện tại).`));
                    continue;
                }
            }
            if (!writeFileSafe(targetPath, file.content)) return;
        }

        // Write non-prompt files (rules.md, workflows)
        for (const file of nonPromptFiles) {
            const targetPath = path.join(process.cwd(), file.path);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            if (file.sourcePath) {
                fs.copyFileSync(file.sourcePath, targetPath);
            } else if (file.content != null) {
                writeFileSafe(targetPath, file.content);
            }
        }

        const fileName = manifest.configFile;
        const isClaudeCode = response.ide === 'claudecode' || response.ide === 'dual';
        const isCodex = response.ide === 'codex' || response.ide === 'dual';

        if (response.ide === 'dual') {
            console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: CLAUDE.md + AGENTS.md`));
        } else {
            console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: ${fileName}`));
        }

        // Lưu manifest
        saveManifest(manifest);

        const workflowFiles = initFiles.filter(f => f.path.startsWith(path.join('.omni', 'workflows')));
        console.log(chalk.gray(`   Đã tạo manifest: ${MANIFEST_FILE}`));
        console.log(chalk.gray(`   Workflows: .omni/workflows/ (${workflowFiles.length} files — lazy-loaded)`));

        // Strictness block needed for Cursor advanced setup
        const strictnessBlock = buildStrictnessBlock(response.strictness);
        // finalRules needed for Cursor bootstrap
        const mainConfigFile = initFiles.find(f => f.path === fileName);
        const finalRules = mainConfigFile ? mainConfigFile.content : '';
        const targetPath = path.join(process.cwd(), fileName);

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

        // Cursor: progressive advanced setup
        if (response.ide === 'cursor') {
            const { cursorAdvanced } = await prompts({
                type: 'confirm',
                name: 'cursorAdvanced',
                message: '🔧 Cài đặt Cursor nâng cao? (MDC rules, MCP config, YOLO guardrails)',
                initial: false
            });

            if (cursorAdvanced) {
                const dnaProfile = detectDNA(process.cwd());

                const mdcRules = buildCursorRules(dnaProfile);
                if (mdcRules) {
                    const cursorRulesDir = path.join(process.cwd(), '.cursor', 'rules');
                    fs.mkdirSync(cursorRulesDir, { recursive: true });
                    for (const rule of mdcRules) {
                        fs.copyFileSync(rule.src, path.join(cursorRulesDir, rule.name));
                    }
                    console.log(chalk.green(`   ✅ .cursor/rules/ (${mdcRules.length} MDC rules)`));
                }

                const mcpConfig = buildCursorMcp(process.cwd());
                if (mcpConfig) {
                    const cursorDir = path.join(process.cwd(), '.cursor');
                    fs.mkdirSync(cursorDir, { recursive: true });
                    const mcpPath = path.join(cursorDir, 'mcp.json');
                    writeFileSafe(mcpPath, mcpConfig);
                    const serverCount = Object.keys(JSON.parse(mcpConfig).mcpServers).length;
                    console.log(chalk.green(`   ✅ .cursor/mcp.json (${serverCount} MCP servers)`));
                }

                const personalRulesBlock = rulesContent
                    ? `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n`
                    : '';
                const bootstrapRules = buildCursorBootstrapRules(finalRules, strictnessBlock, personalRulesBlock);
                writeFileSafe(targetPath, bootstrapRules);
                console.log(chalk.green(`   ✅ .cursorrules (bootstrap mode — rules in .cursor/rules/)`));
            }

            manifest.overlay = true;
            manifest.advanced = !!cursorAdvanced;
            saveManifest(manifest);
        }

        // Auto-install find-skills — skip nếu không có mạng (Gemini sandbox, offline)
        const findSkillsAgentFlags = getAgentFlags(manifest);
        const canReachNetwork = (() => {
            try {
                execFileSync('node', ['-e',
                    "const s=require('net').connect(443,'registry.npmjs.org');" +
                    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
                    "s.on('error',()=>process.exit(1));" +
                    "s.setTimeout(3000,()=>{s.destroy();process.exit(1)})"
                ], { stdio: 'pipe', timeout: 5000 });
                return true;
            } catch { return false; }
        })();

        if (canReachNetwork) {
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
                console.log(chalk.yellow(`   ⚠️  Không cài được find-skills. Cài sau: ${chalk.cyan('omni auto-equip')}`));
            }
        } else {
            console.log(chalk.gray(`   ⏭  Bỏ qua cài find-skills (không có mạng/sandbox)`));
            console.log(chalk.gray(`      Cài sau khi có mạng: ${chalk.cyan('omni auto-equip')}`));
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
                note: 'Mở Cursor trong thư mục dự án. MDC rules tự động activate theo file context.',
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
        // Generate Project Map if user opted in
        if (pendingMapGeneration) {
            console.log(chalk.cyan.bold('🔍 Đang tạo Project Map...'));
            const scan = scanProject(process.cwd());
            const projectName = path.basename(process.cwd());
            const skeleton = generateMapSkeleton(scan, projectName);
            const knowledgeDir = path.join(process.cwd(), '.omni', 'knowledge');
            fs.mkdirSync(knowledgeDir, { recursive: true });
            writeFileSafe(path.join(knowledgeDir, 'project-map.md'), skeleton);
            manifest.projectMap = true;
            manifest.mapGeneratedAt = new Date().toISOString();
            saveManifest(manifest);
            console.log(chalk.green('📁 Project Map: .omni/knowledge/project-map.md'));
            console.log(chalk.gray('   Chạy >om:map trong chat AI để AI điền mô tả chi tiết.\n'));
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
                message: `Cài đặt ${toInstall.length} skills trên? (y/N)`,
                initial: false
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

        // Phase 2: Detect tech stack → propose test skills
        const detected = detectExistingProject(process.cwd());
        if (!detected.detected) {
            console.log(chalk.gray('   ⚠️ Không phát hiện project — bỏ qua đề xuất test skills.\n'));
            return;
        }

        const scan = scanProject(process.cwd());
        if (!scan.techStack || !scan.techStack.language) {
            console.log(chalk.gray('   ℹ️ Không xác định được ngôn ngữ chính — bỏ qua test skills.\n'));
            return;
        }

        const testSkills = getTestSkillsForStack(scan.techStack);

        // Fallback: no curated skills for this language → suggest find-skills search
        if (testSkills.length === 0) {
            const keyword = buildSearchSuggestion(scan.techStack.language, scan.techStack.test);
            console.log(chalk.yellow(`\n   🔍 Chưa có curated test skill cho ${chalk.white(scan.techStack.language)}.`));
            console.log(chalk.gray(`      Gợi ý: dùng lệnh ${chalk.cyan('>om:equip')} hoặc tìm thủ công:`));
            console.log(chalk.cyan(`      npx skills search "${keyword}"\n`));
            return;
        }

        const installedNames = manifest.skills.external.map(s => s.name);
        const testToInstall = testSkills.filter(s => !installedNames.includes(s.name));

        if (testToInstall.length === 0) return;

        console.log(chalk.cyan.bold('🧪 Phát hiện tech stack — đề xuất test skills:\n'));
        const stackLabel = [scan.techStack.language, scan.techStack.test].filter(Boolean).join(' + ');
        console.log(chalk.gray(`   Stack: ${stackLabel}\n`));
        testToInstall.forEach((s, i) => {
            console.log(chalk.white(`   ${i + 1}. ${chalk.bold(s.name)} ${chalk.green('MỚI')}`));
            console.log(chalk.gray(`      └─ ${s.desc} (${s.source})`));
        });
        console.log('');

        if (!options.yes) {
            const { installTest } = await prompts({
                type: 'confirm',
                name: 'installTest',
                message: `Cài thêm ${testToInstall.length} test skill${testToInstall.length > 1 ? 's' : ''}? (y/N)`,
                initial: false
            });
            if (!installTest) return;
        } else {
            console.log(chalk.green(`⚡ Auto-install: ${testToInstall.length} test skill(s)\n`));
        }

        let testInstalled = 0;
        for (const skill of testToInstall) {
            console.log(chalk.cyan(`\n🧪 Đang cài: ${chalk.white(skill.name)}...`));
            try {
                const skillArgs = ['-y', 'skills', 'add', skill.source];
                if (agentFlags) {
                    skillArgs.push(...agentFlags.split(' '), '--skill', skill.name, '-y');
                } else {
                    skillArgs.push('--skill', skill.name, '-y');
                }
                execFileSync('npx', skillArgs, { stdio: 'inherit', timeout: 60000 });
                manifest.skills.external.push({
                    name: skill.name,
                    source: skill.source,
                    installedAt: new Date().toISOString(),
                    category: 'testing'
                });
                testInstalled++;
                console.log(chalk.green(`   ✓ ${skill.name}`));
            } catch {
                console.log(chalk.red(`   ✗ ${skill.name} — thất bại, bỏ qua`));
            }
        }

        if (testInstalled > 0) {
            saveManifest(manifest);
            console.log(chalk.green.bold(`\n   🧪 Test skills: ${testInstalled}/${testToInstall.length} cài thành công\n`));
        }
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
            { cmd: '>om:brainstorm', slash: '/om:brainstorm', role: 'Architect',  desc: 'Phỏng vấn yêu cầu → đề xuất Tech Stack → xuất .omni/sdlc/design-spec.md' },
            { cmd: '>om:equip',      slash: '/om:equip',      role: 'Skill Mgr',  desc: 'Cài universal skills + tìm & đề xuất skills từ skills.sh theo design-spec' },
            { cmd: '>om:plan',       slash: '/om:plan',        role: 'PM',          desc: 'Phân tích design-spec → micro-tasks trong .omni/sdlc/todo.md (<20 phút/task)' },
            { cmd: '>om:cook',       slash: '/om:cook',        role: 'Coder',       desc: 'Sub-agent parallel execution, dependency graph, worktree isolation' },
            { cmd: '>om:check',      slash: '/om:check',       role: 'QA Tester',   desc: 'Validation pipeline: security → lint → build → test → feature verify' },
            { cmd: '>om:fix',        slash: '/om:fix',          role: 'Debugger',    desc: 'Reproduce → root cause → surgical fix → verify (không shotgun-fix)' },
            { cmd: '>om:doc',        slash: '/om:doc',          role: 'Writer',      desc: 'Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt' },
            { cmd: '>om:learn',      slash: '/om:learn',        role: 'Learner',     desc: 'Đúc kết bài học từ bug fix → ghi vào knowledge-base.md (auto sau >om:fix)' },
            { cmd: '>om:map',        slash: '/om:map',          role: 'Architect',   desc: 'Quét codebase → sinh bản đồ dự án (.omni/knowledge/project-map.md)' },
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

// ---------- MAP (project mapping) ----------
program
    .command('map')
    .description('Quét codebase và tạo/cập nhật Project Map cho AI navigation')
    .option('--refresh', 'Cập nhật cấu trúc mà không cần AI (0 token)')
    .action((options) => {
        if (options.refresh) {
            const result = refreshMap(process.cwd());
            if (!result) {
                console.log(chalk.red.bold('\n❌ Không tìm thấy .omni/knowledge/project-map.md. Chạy "omni map" hoặc "omni init" trước.\n'));
                return;
            }
            fs.mkdirSync(path.join(process.cwd(), '.omni', 'knowledge'), { recursive: true });
            fs.writeFileSync(path.join(process.cwd(), '.omni', 'knowledge', 'project-map.md'), result, 'utf-8');
            console.log(chalk.green.bold('\n🔄 Project Map refreshed: .omni/knowledge/project-map.md'));
            console.log(chalk.gray('   Các thay đổi cấu trúc đã được đánh dấu [NEW]/[DELETED].'));
            console.log(chalk.gray('   Chạy >om:map để AI cập nhật mô tả.\n'));
            return;
        }

        const detected = detectExistingProject(process.cwd());
        if (!detected.detected) {
            console.log(chalk.yellow.bold('\n⚠️  Không phát hiện project (thiếu package.json, pyproject.toml, go.mod...).'));
            console.log(chalk.gray('   Chạy lệnh này trong thư mục gốc của dự án.\n'));
            return;
        }

        console.log(chalk.cyan.bold(`\n🔍 Đang quét project... (${detected.lang})`));
        const scan = scanProject(process.cwd());
        const projectName = path.basename(process.cwd());
        const skeleton = generateMapSkeleton(scan, projectName);

        fs.mkdirSync(path.join(process.cwd(), '.omni', 'knowledge'), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), '.omni', 'knowledge', 'project-map.md'), skeleton, 'utf-8');

        // Update manifest
        const manifest = loadManifest();
        manifest.projectMap = true;
        manifest.mapGeneratedAt = new Date().toISOString();
        saveManifest(manifest);

        console.log(chalk.green.bold('\n📁 Project Map skeleton: .omni/knowledge/project-map.md'));
        console.log(chalk.white(`   ${scan.stats.files} files | ${scan.stats.dirs} dirs | ~${scan.stats.loc} LOC`));
        console.log(chalk.white(`   ${scan.structure.filter(s => s.depth <= 2).length} directories mapped`));
        console.log(chalk.white(`   ${scan.entryPoints.length} entry points detected`));
        console.log(chalk.white(`   ${scan.landmines.length} landmines found`));
        console.log(chalk.cyan('\n   Chạy >om:map trong chat AI để điền mô tả chi tiết.\n'));
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
    .option('--dry-run', 'Xem trước kết quả sync (không ghi)')
    .action(async (action, options) => {
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

            const content = formatMarkdown(parseRules(rp));
            if (!content) {
                console.log(chalk.yellow('\n⚠️  Không có rules nào được nhập.\n'));
                return;
            }

            writeFileSafe(rulesPath, content);
            console.log(chalk.green.bold(`\n✅ Đã lưu ${RULES_FILE}`));

            if (configFile) {
                const syncResult = syncRulesToConfig(findConfigFile, process.cwd());
                if (syncResult === 'corrupt') {
                    console.log(chalk.red(`   ⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công rồi chạy ${chalk.cyan('omni rules sync')}.\n`));
                } else if (syncResult) {
                    console.log(chalk.green(`   ✅ Đã sync vào ${configFile}\n`));
                } else {
                    console.log(chalk.yellow(`   ⚠️  Không thể sync vào ${configFile}. Chạy ${chalk.cyan('omni rules sync')} thủ công.\n`));
                }
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
            if (options.dryRun) {
                const result = syncRulesToConfig(findConfigFile, process.cwd(), { dryRun: true });
                if (result.action === 'corrupt') {
                    console.log(chalk.red(`\n⚠️  ${configFile} có markers hỏng. Sửa thủ công trước khi sync.\n`));
                } else if (result.action === 'skip') {
                    console.log(chalk.yellow(`\nKhông có gì để sync.\n`));
                } else {
                    console.log(chalk.cyan.bold(`\n📋 Dry run — would ${result.action} rules in ${configFile}:\n`));
                    console.log(result.preview);
                    console.log(chalk.gray('\nNo files were changed.\n'));
                }
            } else {
                const syncResult = syncRulesToConfig(findConfigFile, process.cwd());
                if (syncResult === 'corrupt') {
                    console.log(chalk.red(`\n⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công trước khi sync.\n`));
                } else if (syncResult) {
                    console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
                } else {
                    console.log(chalk.red('\n❌ Sync thất bại.\n'));
                }
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

// ---------- CUSTOMIZE ----------
program
    .command('customize <workflow>')
    .description('Copy a workflow from package to .omni/workflows/ for customization')
    .action(async (workflow) => {
        const name = workflow.endsWith('.md') ? workflow : workflow + '.md';
        const pkgPath = path.join(__dirname, '..', 'templates', 'workflows', name);

        if (!fs.existsSync(pkgPath)) {
            const available = fs.readdirSync(path.join(__dirname, '..', 'templates', 'workflows'))
                .filter(f => f.endsWith('.md'))
                .map(f => f.replace('.md', ''));
            console.log(chalk.red(`\n❌ Workflow "${name}" không tồn tại.`));
            console.log(chalk.gray(`   Có sẵn: ${available.join(', ')}\n`));
            return;
        }

        const customDir = path.join(process.cwd(), '.omni', 'workflows');
        const customPath = path.join(customDir, name);

        if (fs.existsSync(customPath)) {
            console.log(chalk.yellow(`\n⚠️  .omni/workflows/${name} đã tồn tại — bỏ qua.\n`));
            return;
        }

        fs.mkdirSync(customDir, { recursive: true });
        fs.copyFileSync(pkgPath, customPath);
        console.log(chalk.green(`\n✅ Đã copy ${name} → .omni/workflows/${name}`));
        console.log(chalk.gray(`   Chỉnh sửa file này. Omni sẽ ưu tiên bản custom.\n`));
    });

program.parse(process.argv);
