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
            const badge = s.sourceType && s.sourceType !== 'registry' ? chalk.cyan(` [${s.sourceType}]`) : '';
            const cat = s.category ? chalk.magenta(` (${s.category})`) : '';
            console.log(chalk.green(`      ✓ ${s.name}`) + badge + cat + chalk.gray(` ← ${s.source} (${date})`));
        });
    }

    const total = manifest.skills.external.length;
    console.log(chalk.white(`\n   Tổng: ${total} skills đã cài đặt.\n`));

    console.log(chalk.cyan.bold('   📋 Onboard:'));
    if (manifest.onboard && manifest.onboard.status === 'completed') {
        const date = new Date(manifest.onboard.onboardedAt).toLocaleDateString('vi-VN');
        const gen = manifest.onboard.generated || {};
        const parts = [];
        if (gen.onboardReport) parts.push('report');
        if (gen.rules) parts.push('rules.md');
        if (gen.skills && gen.skills.length > 0) parts.push(`${gen.skills.length} skill(s)`);
        if (gen.designSpec) parts.push('design-spec.md');
        if (gen.todo) parts.push('todo.md');
        if (gen.projectMap) parts.push('project-map.md');
        console.log(chalk.green(`      ✓ Onboarded : ${date}`));
        if (parts.length > 0) {
            console.log(chalk.white(`      Generated   : ${parts.join(', ')}`));
        }
    } else {
        console.log(chalk.gray('      ✗ Chưa onboard (chạy: omni onboard)'));
    }
    console.log('');
}

function handleCommands() {
    console.log(chalk.cyan.bold('\n📋 Danh sách lệnh >om: (gõ trong chat với AI)\n'));

    const commands = [
        { cmd: '>om:onboard',    slash: '/om:onboard',    role: 'Architect',  desc: 'Onboard dự án cũ — scan code, interview, sinh rules + skills + spec' },
        { cmd: '>om:brainstorm', slash: '/om:brainstorm', role: 'Architect',  desc: 'Phỏng vấn yêu cầu → đề xuất Tech Stack → xuất .omni/sdlc/design-spec.md' },
        { cmd: '>om:equip',      slash: '/om:equip',      role: 'Skill Mgr',  desc: 'Cài universal skills + tìm & đề xuất skills từ skills.sh theo design-spec' },
        { cmd: '>om:plan',       slash: '/om:plan',        role: 'PM',          desc: 'Phân tích design-spec → micro-tasks trong .omni/sdlc/todo.md (<20 phút/task)' },
        { cmd: '>om:cook',       slash: '/om:cook',        role: 'Coder',       desc: 'Sub-agent parallel execution, dependency graph, worktree isolation' },
        { cmd: '>om:check',      slash: '/om:check',       role: 'QA Tester',   desc: 'Validation pipeline: security → lint → build → test → feature verify' },
        { cmd: '>om:fix',        slash: '/om:fix',          role: 'Debugger',    desc: 'Reproduce → root cause → surgical fix → verify (không shotgun-fix)' },
        { cmd: '>om:doc',        slash: '/om:doc',          role: 'Writer',      desc: 'Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt' },
        { cmd: '>om:ship',       slash: '/om:ship',         role: 'Release Eng', desc: 'Sau khi check pass: version + changelog, CI gate, rollout + rollback plan → .omni/sdlc/ship-report.md' },
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
    console.log(chalk.white('  Workflow: ') + chalk.cyan('onboard (legacy) | brainstorm (new) → equip → plan → cook → check → fix → doc → ship'));
    console.log(chalk.gray('\n  Lưu ý: Các lệnh >om: được gõ trực tiếp trong chat AI (Claude, Codex, Cursor...),'));
    console.log(chalk.gray('  không phải lệnh terminal. Claude Code users: dùng /om:* (auto-complete).'));
    console.log(chalk.gray('  Chạy ') + chalk.yellow('omni init') + chalk.gray(' trước để tạo file luật cho AI.\n'));
}

module.exports = { handleStatus, handleCommands };
