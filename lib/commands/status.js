'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const { MANIFEST_FILE, findConfigFile, loadManifest } = require('./helpers');

function handleStatus() {
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
}

function handleCommands() {
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
}

module.exports = { handleStatus, handleCommands };
