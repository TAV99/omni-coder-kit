#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');
const { program } = require('commander');

const MANIFEST_FILE = '.omni-manifest.json';

// ========== HELPERS ==========

function findConfigFile() {
    const files = ['.cursorrules', '.windsurfrules', 'CLAUDE.md', '.codexrules', '.antigravityrules', 'SYSTEM_PROMPT.md'];
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

// Kiểm tra source hợp lệ cho equip (format: owner/repo hoặc owner/repo/skill)
function isValidSource(source) {
    if (source.includes('..')) return false;
    return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(\/.+)?$/.test(source);
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
    return { version: '1.0.0', configFile: null, skills: { local: [], external: [] } };
}

function saveManifest(manifest) {
    return writeFileSafe(path.join(process.cwd(), MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

// Tìm xung đột: kiểm tra skill đã tồn tại trong manifest chưa (cả local và external)
function findSkillConflict(manifest, skillName) {
    if (manifest.skills.local.includes(skillName)) {
        return { type: 'local', name: skillName };
    }
    const ext = manifest.skills.external.find(s => s.name === skillName);
    if (ext) {
        return { type: 'external', name: ext.name, source: ext.source };
    }
    return null;
}

// Mapping domain tags để phát hiện xung đột chéo giữa local và external
const SKILL_DOMAIN_MAP = {
    'react-next': ['react', 'nextjs', 'frontend'],
    'hono-pg': ['hono', 'postgresql', 'backend', 'api'],
    'automation-bot': ['telegram', 'bot', 'automation', 'google-sheets'],
    'payment-gateway': ['payment', 'vnpay', 'stripe', 'paypal']
};

function findDomainConflict(manifest, skillName, incomingType) {
    const newDomains = SKILL_DOMAIN_MAP[skillName] || [skillName];
    // Kiểm tra nguồn đối lập (local kiểm tra external và ngược lại)
    const others = incomingType === 'local'
        ? manifest.skills.external.map(s => s.name)
        : manifest.skills.local;

    for (const existingName of others) {
        const existingDomains = SKILL_DOMAIN_MAP[existingName] || [existingName];
        const overlap = newDomains.filter(d => existingDomains.includes(d));
        if (overlap.length > 0) {
            return { name: existingName, overlapping: overlap };
        }
    }
    return null;
}

// ========== CONFIG FILE SKILL MARKERS ==========

function getMarkers(skillName) {
    return {
        start: `<!-- omni:skill:${skillName} -->`,
        end: `<!-- /omni:skill:${skillName} -->`
    };
}

function isSkillInConfigFile(configPath, skillName) {
    if (!fs.existsSync(configPath)) return false;
    const content = fs.readFileSync(configPath, 'utf-8');
    return content.includes(getMarkers(skillName).start);
}

function appendSkillToConfig(configPath, skillName, skillContent) {
    const { start, end } = getMarkers(skillName);
    const wrapped = `\n\n${start}\n${skillContent}\n${end}\n`;
    try {
        fs.appendFileSync(configPath, wrapped, 'utf-8');
        return true;
    } catch (err) {
        console.log(chalk.red.bold(`\n❌ Lỗi khi ghi vào config file`));
        console.log(chalk.red(`   Chi tiết: ${err.message}\n`));
        return false;
    }
}

// ========== CLI COMMANDS ==========

program
    .name('omni')
    .description('Trình quản lý hệ tư tưởng Omni-Coder Kit')
    .version('1.0.0');

// ---------- INIT ----------
program
    .command('init')
    .description('Khởi tạo DNA và workflow cho dự án mới')
    .action(async () => {
        console.log(chalk.cyan.bold('\n🚀 Khởi tạo Omni-Coder Kit!\n'));

        const response = await prompts([
            {
                type: 'select',
                name: 'ide',
                message: 'Bạn đang sử dụng AI IDE/Công cụ nào?',
                choices: [
                    { title: 'Claude Code (CLI) / OpenCode', value: 'claudecode' },
                    { title: 'CodeX', value: 'codex' },
                    { title: 'Antigravity', value: 'antigravity' },
                    { title: 'Cursor', value: 'cursor' },
                    { title: 'Windsurf', value: 'windsurf' },
                    { title: 'Generic (SYSTEM_PROMPT.md)', value: 'generic' }
                ],
            },
            {
                type: 'select',
                name: 'strictness',
                message: 'Mức độ kỷ luật?',
                choices: [
                    { title: 'Hardcore (Ép 100% SDLC)', value: 'hardcore' },
                    { title: 'Flexible (Cho phép bypass lỗi vặt)', value: 'flexible' }
                ]
            },
            {
                type: 'multiselect',
                name: 'stacks',
                message: 'Chọn Tech Stack (BẤM ENTER ĐỂ BỎ QUA - NẾU MUỐN AI TƯ VẤN TRƯỚC):',
                choices: [
                    { title: 'React / Next.js', value: 'react-next' },
                    { title: 'Hono + PostgreSQL', value: 'hono-pg' },
                    { title: 'Automation (Bot/Sheets)', value: 'automation-bot' },
                    { title: 'Payment Gateway', value: 'payment-gateway' }
                ],
                instructions: false,
                hint: '- Space để chọn, Enter để xác nhận'
            }
        ]);

        if (!response.ide) {
            console.log(chalk.red('Hủy bỏ.'));
            return;
        }

        const templatesDir = path.join(__dirname, '..', 'templates');

        const mindset = readTemplate(path.join(templatesDir, 'core', 'karpathy-mindset.md'));
        const hygiene = readTemplate(path.join(templatesDir, 'core', 'claudex-hygiene.md'));
        const sdlc = readTemplate(path.join(templatesDir, 'workflows', 'superpower-sdlc.md'));
        const reqAnalysis = readTemplate(path.join(templatesDir, 'workflows', 'requirement-analysis.md'));
        const skillManager = readTemplate(path.join(templatesDir, 'workflows', 'skill-manager.md'));
        const pmTemplates = readTemplate(path.join(templatesDir, 'workflows', 'pm-templates.md'));

        let finalRules = `> Generated by Omni-Coder Kit\n\n${mindset}\n\n${hygiene}\n\n${sdlc}\n\n${reqAnalysis}\n\n${skillManager}\n\n${pmTemplates}\n\n`;

        // Khởi tạo manifest mới cho project
        const manifest = createManifest();

        if (response.stacks && response.stacks.length > 0) {
            finalRules += `## TECH STACK SPECIFIC RULES\n\n`;
            for (const stack of response.stacks) {
                const content = readTemplate(path.join(templatesDir, 'stacks', `${stack}.md`));
                const { start, end } = getMarkers(stack);
                finalRules += `${start}\n${content}\n${end}\n\n`;
                manifest.skills.local.push(stack);
            }
        }

        let fileName = '';
        finalRules += `## IDE SPECIFIC ADAPTERS\n`;

        switch (response.ide) {
            case 'claudecode':
                fileName = 'CLAUDE.md';
                finalRules += `- **Claude/OpenCode CLI Safety:** DO NOT execute destructive terminal commands (e.g., rm -rf) without explicit user permission.\n`;
                break;
            case 'codex':
                fileName = '.codexrules';
                finalRules += `- **CodeX Optimization:** Always explicitly state the logic and constraints in comments BEFORE writing the actual code to maximize inline completion accuracy.\n`;
                break;
            case 'antigravity':
                fileName = '.antigravityrules';
                finalRules += `- **Antigravity Agentic Limits:** Maintain strict context hygiene. Summarize previous actions before executing complex terminal operations. Always ask for confirmation before major refactoring.\n`;
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

        if (response.strictness === 'flexible') {
            finalRules += `\n## FAST-TRACK MODE\n- **[/om:hotfix]:** Use to bypass PM/Architect planning for minor fixes. Add note in \`tech-debt.md\`.\n`;
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

        // Lưu manifest
        manifest.configFile = fileName;
        saveManifest(manifest);

        console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: ${fileName}`));
        console.log(chalk.gray(`   Đã tạo manifest: ${MANIFEST_FILE}`));

        if (!response.stacks || response.stacks.length === 0) {
            console.log(chalk.yellow(`\n💡 Gợi ý: Bạn chưa chọn Tech Stack. Hãy gõ ${chalk.cyan('/om:brainstorm')} để AI phỏng vấn và tư vấn kiến trúc.`));
            console.log(chalk.yellow(`Sau khi chốt Stack, dùng ${chalk.cyan('omni add <tên-stack>')} hoặc ${chalk.cyan('omni equip <source>')} để bơm luật!\n`));
        } else {
            console.log(chalk.white(`\nBắt đầu trò chuyện với AI bằng lệnh: `) + chalk.cyan.bold(`/om:brainstorm\n`));
        }
    });

// ---------- ADD (local stacks) ----------
program
    .command('add <skill>')
    .description('Bơm thêm kỹ năng cục bộ (local stack) vào file cấu hình')
    .action((skill) => {
        if (!isValidSkillName(skill)) {
            console.log(chalk.red.bold('\n❌ Tên kỹ năng không hợp lệ. Chỉ chấp nhận chữ thường (a-z), số (0-9), và dấu gạch ngang (-).\n'));
            return;
        }

        const configFile = findConfigFile();
        if (!configFile) {
            console.log(chalk.red.bold('\n❌ Không tìm thấy file Omni. Hãy chạy "omni init" trước.\n'));
            return;
        }

        const manifest = loadManifest();

        // Kiểm tra trùng lặp chính xác
        const conflict = findSkillConflict(manifest, skill);
        if (conflict) {
            const via = conflict.type === 'local' ? 'omni add' : 'omni equip';
            console.log(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skill}" đã được cài đặt trước đó (qua ${via}).`));
            console.log(chalk.yellow(`   Bỏ qua để tránh trùng lặp. Dùng ${chalk.cyan('omni status')} để xem chi tiết.\n`));
            return;
        }

        // Kiểm tra xung đột domain với external skills
        const domainConflict = findDomainConflict(manifest, skill, 'local');
        if (domainConflict) {
            console.log(chalk.yellow(`\n⚠️  Cảnh báo: "${skill}" có thể xung đột với kỹ năng external "${domainConflict.name}" (lĩnh vực trùng: ${domainConflict.overlapping.join(', ')}).`));
            console.log(chalk.yellow(`   Tiếp tục thêm nhưng hãy kiểm tra lại nếu có luật mâu thuẫn.\n`));
        }

        const skillPath = path.join(__dirname, '..', 'templates', 'stacks', `${skill}.md`);
        if (!fs.existsSync(skillPath)) {
            console.log(chalk.red.bold(`\n❌ Kỹ năng "${skill}" không tồn tại. Dùng ${chalk.cyan('omni list')} để xem danh sách.\n`));
            return;
        }

        const configPath = path.join(process.cwd(), configFile);

        // Kiểm tra markers trong config file (phòng trường hợp manifest bị mất)
        if (isSkillInConfigFile(configPath, skill)) {
            console.log(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skill}" đã có trong file ${configFile}. Bỏ qua.\n`));
            if (!manifest.skills.local.includes(skill)) {
                manifest.skills.local.push(skill);
                manifest.configFile = configFile;
                saveManifest(manifest);
                console.log(chalk.gray(`   Đã đồng bộ lại manifest.\n`));
            }
            return;
        }

        const skillContent = readTemplate(skillPath);
        if (!appendSkillToConfig(configPath, skill, skillContent)) return;

        // Cập nhật manifest
        manifest.skills.local.push(skill);
        manifest.configFile = configFile;
        saveManifest(manifest);

        console.log(chalk.green.bold(`\n✅ Đã bơm kỹ năng [${skill}] vào file ${configFile} thành công!`));
        console.log(chalk.gray(`   Đã đồng bộ manifest (${MANIFEST_FILE})\n`));
    });

// ---------- EQUIP (external skills from skills.sh) ----------
program
    .command('equip <source>')
    .description('Tải và đồng bộ kỹ năng ngoài (external) từ skills.sh')
    .option('-n, --name <name>', 'Đặt tên ngắn gọn cho kỹ năng (mặc định: tự sinh từ source)')
    .action(async (source, options) => {
        // Kiểm tra source format (owner/repo)
        if (!isValidSource(source)) {
            console.log(chalk.red.bold(`\n❌ Source không hợp lệ. Định dạng đúng: owner/repo (ví dụ: cursor-tools/react-best-practices).\n`));
            return;
        }

        // Sinh tên skill từ source nếu không có --name
        const skillName = options.name || source.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-');

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

        // Kiểm tra trùng lặp chính xác
        const conflict = findSkillConflict(manifest, skillName);
        if (conflict) {
            const via = conflict.type === 'local' ? 'omni add' : 'omni equip';
            console.log(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skillName}" đã được cài đặt trước đó (qua ${via}).`));
            if (conflict.type === 'external') {
                console.log(chalk.yellow(`   Source: ${conflict.source}`));
            }
            console.log(chalk.yellow(`   Bỏ qua để tránh trùng lặp. Dùng ${chalk.cyan('omni status')} để xem chi tiết.\n`));
            return;
        }

        // Kiểm tra xung đột domain với local stacks
        const domainConflict = findDomainConflict(manifest, skillName, 'external');
        if (domainConflict) {
            console.log(chalk.yellow(`\n⚠️  Cảnh báo: "${skillName}" có thể xung đột với kỹ năng local "${domainConflict.name}" (lĩnh vực trùng: ${domainConflict.overlapping.join(', ')}).`));
            console.log(chalk.yellow(`   Cân nhắc dùng ${chalk.cyan('omni status')} để xem kỹ năng đã cài.\n`));
        }

        console.log(chalk.cyan.bold(`\n🔧 Cài đặt kỹ năng external: ${chalk.white(source)}\n`));
        console.log(chalk.white(`   Chạy lệnh sau để tải kỹ năng từ skills.sh:\n`));
        console.log(chalk.cyan(`   npx skills add ${source}\n`));

        const { confirmed } = await prompts({
            type: 'confirm',
            name: 'confirmed',
            message: 'Bạn đã chạy lệnh trên và kỹ năng đã được cài thành công?',
            initial: false
        });

        if (!confirmed) {
            console.log(chalk.yellow('\n⚠️  Hủy bỏ. Kỹ năng chưa được đồng bộ vào manifest.\n'));
            return;
        }

        // Đăng ký vào manifest
        manifest.skills.external.push({
            name: skillName,
            source: source,
            installedAt: new Date().toISOString()
        });
        manifest.configFile = configFile;
        saveManifest(manifest);

        console.log(chalk.green.bold(`\n✅ Kỹ năng [${skillName}] đã được đồng bộ vào manifest thành công!`));
        console.log(chalk.gray(`   Source: ${source}`));
        console.log(chalk.gray(`   Manifest: ${MANIFEST_FILE}\n`));
    });

// ---------- STATUS ----------
program
    .command('status')
    .description('Xem trạng thái tất cả kỹ năng đã cài đặt (local + external)')
    .action(() => {
        const manifest = loadManifest();
        const configFile = findConfigFile();

        console.log(chalk.cyan.bold('\n📊 Trạng thái Omni-Coder Kit\n'));
        console.log(chalk.white(`   Config file : ${configFile || chalk.red('(chưa init)')}`));
        console.log(chalk.white(`   Manifest    : ${fs.existsSync(path.join(process.cwd(), MANIFEST_FILE)) ? chalk.green('✓ có') : chalk.yellow('✗ chưa tạo')}\n`));

        // Local skills
        console.log(chalk.cyan.bold('   📦 Kỹ năng cục bộ (omni add):'));
        if (manifest.skills.local.length === 0) {
            console.log(chalk.gray('      (chưa có)'));
        } else {
            manifest.skills.local.forEach(s => {
                console.log(chalk.green(`      ✓ ${s}`));
            });
        }

        // External skills
        console.log(chalk.cyan.bold('\n   🌐 Kỹ năng ngoài (omni equip):'));
        if (manifest.skills.external.length === 0) {
            console.log(chalk.gray('      (chưa có)'));
        } else {
            manifest.skills.external.forEach(s => {
                const date = new Date(s.installedAt).toLocaleDateString('vi-VN');
                console.log(chalk.green(`      ✓ ${s.name}`) + chalk.gray(` ← ${s.source} (${date})`));
            });
        }

        const total = manifest.skills.local.length + manifest.skills.external.length;
        console.log(chalk.white(`\n   Tổng: ${total} kỹ năng đã cài đặt.\n`));
    });

// ---------- LIST ----------
program
    .command('list')
    .description('Xem danh sách các kỹ năng (skills) đang có sẵn trong kho')
    .action(() => {
        const stacksDir = path.join(__dirname, '..', 'templates', 'stacks');
        if (!fs.existsSync(stacksDir)) {
            console.log(chalk.red('\n❌ Không tìm thấy thư mục templates/stacks.\n'));
            return;
        }

        let files;
        try {
            files = fs.readdirSync(stacksDir).filter(f => f.endsWith('.md'));
        } catch (err) {
            console.log(chalk.red.bold('\n❌ Lỗi khi đọc danh sách kỹ năng.'));
            console.log(chalk.red(`   Chi tiết: ${err.message}\n`));
            return;
        }

        const manifest = loadManifest();

        console.log(chalk.cyan.bold('\n📦 Danh sách kỹ năng cục bộ có sẵn:\n'));

        if (files.length === 0) {
            console.log(chalk.yellow('  (Chưa có kỹ năng nào được tạo)'));
        } else {
            files.forEach(file => {
                const skillName = file.replace('.md', '');
                const installed = manifest.skills.local.includes(skillName);
                const marker = installed ? chalk.green('✓') : chalk.gray('○');
                console.log(`  ${marker} ${installed ? chalk.green(skillName) : chalk.white(skillName)}`);
            });
        }
        console.log(chalk.white(`\n💡 Dùng ${chalk.yellow('omni add <tên>')} để bơm kỹ năng cục bộ.`));
        console.log(chalk.white(`💡 Dùng ${chalk.yellow('omni equip <source>')} để tải kỹ năng ngoài từ skills.sh.\n`));
    });

program.parse(process.argv);