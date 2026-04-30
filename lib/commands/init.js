'use strict';

'use strict';

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');
const { execFileSync } = require('child_process');

const { getAgentFlags } = require('../helpers');
const { detectExistingProject, scanProject, generateMapSkeleton } = require('../scanner');
const { parseRules, formatMarkdown } = require('../rules');
const { resolvePartials, readWorkflow } = require('../workflows');
const { buildInitConfig, buildCommands } = require('../init');
const {
    MANIFEST_FILE, findConfigFile, ensureGitignore, writeFileSafe, loadManifest, saveManifest,
} = require('./helpers');
const { setupClaudeAdvanced, setupCodexAdvanced, setupCursorAdvanced } = require('./init-setup');

const STARTUP_HINTS = {
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

function printStartupHints(ide) {
    const hint = STARTUP_HINTS[ide];
    if (!hint) return;
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

function canReachNetwork() {
    try {
        execFileSync('node', ['-e',
            "const s=require('net').connect(443,'registry.npmjs.org');" +
            "s.on('connect',()=>{s.destroy();process.exit(0)});" +
            "s.on('error',()=>process.exit(1));" +
            "s.setTimeout(3000,()=>{s.destroy();process.exit(1)})"
        ], { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch { return false; }
}

function installFindSkills(manifest) {
    const findSkillsAgentFlags = getAgentFlags(manifest);
    if (!canReachNetwork()) {
        console.log(chalk.gray(`   ⏭  Bỏ qua cài find-skills (không có mạng/sandbox)`));
        console.log(chalk.gray(`      Cài sau khi có mạng: ${chalk.cyan('omni auto-equip')}`));
        return;
    }
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
        console.error(chalk.yellow(`   ⚠️  Không cài được find-skills. Cài sau: ${chalk.cyan('omni auto-equip')}`));
    }
}

function generateProjectMap(manifest, projectDir) {
    console.log(chalk.cyan.bold('🔍 Đang tạo Project Map...'));
    const scan = scanProject(projectDir);
    const projectName = path.basename(projectDir);
    const skeleton = generateMapSkeleton(scan, projectName);
    const knowledgeDir = path.join(projectDir, '.omni', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    writeFileSafe(path.join(knowledgeDir, 'project-map.md'), skeleton);
    manifest.projectMap = true;
    manifest.mapGeneratedAt = new Date().toISOString();
    saveManifest(manifest);
    console.log(chalk.green('📁 Project Map: .omni/knowledge/project-map.md'));
    console.log(chalk.gray('   Chạy >om:map trong chat AI để AI điền mô tả chi tiết.\n'));
}

async function handleInit(options) {
    console.log(chalk.cyan.bold('\n🚀 Khởi tạo Omni-Coder Kit!\n'));

    const projectDir = process.cwd();
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    let pendingMapGeneration = null;
    const detected = detectExistingProject(projectDir);
    if (detected.detected) {
        const { generateMap } = await prompts({
            type: 'confirm',
            name: 'generateMap',
            message: `📁 Phát hiện project có sẵn (${detected.stats.files} files, ${detected.lang}). Tạo Project Map?`,
            initial: true,
        }, { onCancel });
        if (cancelled) return;
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
    ], { onCancel });

    if (cancelled || !response.ide) {
        console.error(chalk.red('Hủy bỏ.'));
        return;
    }

    const supportsSubagents = ['claudecode', 'codex', 'dual'].includes(response.ide);
    let useSubagents = false;
    if (supportsSubagents) {
        const sa = await prompts({
            type: 'confirm',
            name: 'subagents',
            message: q(3, 4, 'Sử dụng sub-agents (parallel execution)? ⚠️ Tốn token hơn, nhưng nhanh hơn.'),
            initial: false,
        }, { onCancel });
        if (cancelled) return;
        useSubagents = !!sa.subagents;
    }
    const totalQ = supportsSubagents ? 4 : 3;

    console.log(chalk.cyan(`\n${q(supportsSubagents ? 4 : 3, totalQ, 'Personal Rules')} ${chalk.gray('(Enter để bỏ qua từng mục)')}\n`));

    console.log(chalk.gray('📝 Ngôn ngữ AI dùng để trả lời bạn. Có thể ghi nhiều ngôn ngữ.'));
    console.log(chalk.dim('   VD React dev: "Tiếng Việt, technical terms giữ English"'));
    console.log(chalk.dim('   VD Python team: "English only"'));
    const rl = await prompts({ type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp (AI trả lời bằng ngôn ngữ nào)?', initial: '' }, { onCancel });
    if (cancelled) return;

    console.log(chalk.gray('\n📝 Quy tắc viết code mà AI phải tuân theo trong dự án.'));
    console.log(chalk.gray('   Bao gồm: naming convention, indent, format, patterns ưa thích.'));
    console.log(chalk.dim('   VD React frontend: "camelCase, 2-space indent, prefer FC + hooks, no class components"'));
    console.log(chalk.dim('   VD Node.js backend: "snake_case cho DB fields, camelCase cho JS, ESM imports, async/await"'));
    console.log(chalk.dim('   VD Python ML: "PEP8, type hints bắt buộc, docstring Google style"'));
    const rc = await prompts({ type: 'text', name: 'codingStyle', message: 'Coding style / conventions?', initial: '' }, { onCancel });
    if (cancelled) return;

    console.log(chalk.gray('\n📝 Những patterns/thói quen mà AI KHÔNG ĐƯỢC sử dụng.'));
    console.log(chalk.gray('   Ghi rõ cái gì bị cấm — AI sẽ tránh hoàn toàn.'));
    console.log(chalk.dim('   VD React: "không dùng any, không dùng class component, không inline styles"'));
    console.log(chalk.dim('   VD Backend: "không console.log trong production code, không dùng var, không SQL thô"'));
    console.log(chalk.dim('   VD Chung: "không tự ý refactor code ngoài scope, không thêm comments thừa"'));
    const rf = await prompts({ type: 'text', name: 'forbidden', message: 'Forbidden patterns (những gì KHÔNG được làm)?', initial: '' }, { onCancel });
    if (cancelled) return;

    console.log(chalk.gray('\n📝 Các quy tắc riêng khác không thuộc mục trên. Phân cách bằng dấu ;'));
    console.log(chalk.dim('   VD: "commit message bằng tiếng Việt; mỗi PR tối đa 300 dòng thay đổi"'));
    console.log(chalk.dim('   VD: "luôn viết unit test trước khi code; dùng pnpm thay npm"'));
    console.log(chalk.dim('   VD: "giải thích bằng ví dụ cụ thể; không dùng emoji trong code"'));
    const ru = await prompts({ type: 'text', name: 'custom', message: 'Custom rules (tùy ý, phân cách bằng dấu ;)?', initial: '' }, { onCancel });
    if (cancelled) return;

    const rulesPrompt = {
        language: rl.language,
        codingStyle: rc.codingStyle,
        forbidden: rf.forbidden,
        custom: ru.custom,
    };

    const parsedRules = parseRules(rulesPrompt);
    const rulesContent = formatMarkdown(parsedRules);

    const initResult = buildInitConfig(response.ide, {
        strictness: response.strictness,
        parsedRules,
        rulesContent,
        projectDir,
        dnaProfile: null,
        subagents: useSubagents,
    });

    const { files: initFiles, dirs: initDirs, manifest } = initResult;

    if (options.dryRun) {
        console.log(chalk.cyan.bold('\n📋 Dry run — files that would be created:\n'));
        for (const file of initFiles) {
            const targetPath = path.join(projectDir, file.path);
            const exists = fs.existsSync(targetPath);
            const label = exists ? chalk.yellow('OVERWRITE') : chalk.green('CREATE   ');
            console.log(`  ${label}  ${file.path}`);
        }
        console.log(chalk.gray(`\n  Dirs: ${initDirs.join(', ')}`));
        console.log(chalk.gray('  No files were changed.\n'));
        return;
    }

    for (const dir of initDirs) {
        fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
    }

    const configFiles = initFiles.filter(f => f.overwritePrompt);
    const nonPromptFiles = initFiles.filter(f => !f.overwritePrompt);

    for (const file of configFiles) {
        const targetPath = path.join(projectDir, file.path);
        if (fs.existsSync(targetPath)) {
            const { overwrite } = await prompts({
                type: 'confirm',
                name: 'overwrite',
                message: `⚠️  File "${file.path}" đã tồn tại. Bạn có muốn ghi đè không?`,
                initial: false
            }, { onCancel });
            if (cancelled) return;
            if (!overwrite) {
                console.log(chalk.yellow(`   Bỏ qua ${file.path} (giữ nguyên file hiện tại).`));
                continue;
            }
        }
        if (!writeFileSafe(targetPath, file.content)) return;
    }

    for (const file of nonPromptFiles) {
        const targetPath = path.join(projectDir, file.path);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        if (file.sourcePath) {
            const raw = readWorkflow(file.sourcePath);
            fs.writeFileSync(targetPath, resolvePartials(raw), 'utf-8');
        } else if (file.content != null) {
            writeFileSafe(targetPath, file.content);
        }
    }

    const fileName = manifest.configFile;
    const isCodex = response.ide === 'codex' || response.ide === 'dual';

    if (response.ide === 'dual') {
        console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: CLAUDE.md + AGENTS.md`));
    } else {
        console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: ${fileName}`));
    }

    saveManifest(manifest);

    const workflowFiles = initFiles.filter(f => f.path.startsWith(path.join('.omni', 'workflows')));
    console.log(chalk.gray(`   Đã tạo manifest: ${MANIFEST_FILE}`));
    console.log(chalk.gray(`   Workflows: .omni/workflows/ (${workflowFiles.length} files — lazy-loaded)`));

    const gitignoreCount = ensureGitignore(response.ide);
    if (gitignoreCount > 0) {
        console.log(chalk.gray(`   .gitignore: ${gitignoreCount} patterns added`));
    }

    const slashCommands = buildCommands(response.ide);
    if (slashCommands) {
        await setupClaudeAdvanced(manifest, response.ide);
    }

    if (isCodex) {
        await setupCodexAdvanced(manifest, response.ide);
    }

    if (response.ide === 'cursor') {
        await setupCursorAdvanced(manifest, response.ide, initFiles, parsedRules, rulesContent, response.strictness, fileName);
    }

    installFindSkills(manifest);

    console.log(chalk.white(`\n💡 Gõ ${chalk.cyan.bold('>om:brainstorm')} để AI phỏng vấn và tư vấn kiến trúc.`));
    console.log(chalk.gray(`   Thêm skill: ${chalk.yellow('omni equip <source>')} hoặc ${chalk.yellow('omni auto-equip')}`));
    if (rulesContent) {
        console.log(chalk.gray(`   Sửa rules: ${chalk.yellow('omni rules')}`));
    } else {
        console.log(chalk.gray(`   Thêm personal rules: ${chalk.yellow('omni rules')}`));
    }
    console.log(chalk.gray(`💡 Xem toàn bộ lệnh >om: bằng: `) + chalk.yellow('omni commands'));

    printStartupHints(response.ide);

    if (pendingMapGeneration) {
        generateProjectMap(manifest, projectDir);
    }
    console.log('');
}

module.exports = { handleInit };
