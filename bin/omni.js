#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { program } = require('commander');
const { execSync } = require('child_process');

const PKG = require(path.join(__dirname, '..', 'package.json'));
const { detectExistingProject, scanProject, generateMapSkeleton, refreshMap } = require(path.join(__dirname, '..', 'lib', 'scanner'));
const {
    MANIFEST_FILE, findConfigFile, writeFileSafe, loadManifest, saveManifest,
} = require(path.join(__dirname, '..', 'lib', 'commands', 'helpers'));
const { handleInit } = require(path.join(__dirname, '..', 'lib', 'commands', 'init'));
const { handleEquip, handleAutoEquip } = require(path.join(__dirname, '..', 'lib', 'commands', 'equip'));
const { handleRules } = require(path.join(__dirname, '..', 'lib', 'commands', 'rules'));

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
    .action(handleInit);

// ---------- EQUIP ----------
program
    .command('equip <source>')
    .description('Tải và đồng bộ kỹ năng ngoài (external) từ skills.sh')
    .option('-n, --name <name>', 'Đặt tên ngắn gọn cho kỹ năng (mặc định: tự sinh từ source)')
    .option('-f, --force', 'Bỏ qua cảnh báo xung đột để cài đè')
    .action(handleEquip);

// ---------- AUTO-EQUIP ----------
program
    .command('auto-equip')
    .description('Cài đặt universal skills (skill chuyên sâu do AI đề xuất qua >om:equip + find-skills)')
    .option('-y, --yes', 'Tự động cài đặt không cần xác nhận')
    .action(handleAutoEquip);

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

// ---------- COMMANDS ----------
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

// ---------- MAP ----------
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

// ---------- RULES ----------
program
    .command('rules [action]')
    .description('Quản lý personal rules (xem/sửa/sync/reset)')
    .option('--dry-run', 'Xem trước kết quả sync (không ghi)')
    .action(handleRules);

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
