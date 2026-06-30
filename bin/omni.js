#!/usr/bin/env node
'use strict';

const chalk = require('chalk');
const { program } = require('commander');

const PKG = require('../package.json');
const { handleInit } = require('../lib/commands/init');
const { handleEquip, handleAutoEquip } = require('../lib/commands/equip');
const { handleRules } = require('../lib/commands/rules');
const { handleStatus, handleCommands } = require('../lib/commands/status');
const { handleMap } = require('../lib/commands/map');
const { handleUpdate } = require('../lib/commands/update');
const { handleCustomize } = require('../lib/commands/customize');
const { handleOnboard } = require('../lib/commands/onboard');
const { handleDoctor } = require('../lib/commands/doctor');
const { handleRun, handleTrace, handleGate, handleStats, handleAccept } = require('../lib/commands/run');

// Wrap any legacy handler so calling it prints a single-line deprecation hint.
// Hidden alias commands route through this so power-users learn the new name.
function deprecate(oldCmd, newCmd, handler) {
    return (...args) => {
        console.error(chalk.yellow(`⚠  \`omni ${oldCmd}\` đã đổi tên → dùng \`omni ${newCmd}\`. (Lệnh cũ vẫn chạy.)`));
        return handler(...args);
    };
}

// `omni skills` no-arg = auto-equip + status (one-stop "show me my skills").
async function handleSkillsDefault(options = {}) {
    await handleAutoEquip(options);
    await handleStatus();
}

program
    .name('omni')
    .description('Trình quản lý hệ tư tưởng Omni-Coder Kit (CLI gọn — 5 nhóm lệnh)')
    .version(PKG.version);

// -- 1) init -----------------------------------------------------------------
program
    .command('init')
    .description('Khởi tạo DNA + workflow; auto onboard khi dự án legacy (dùng --onboard để ép)')
    .option('--dry-run', 'Xem trước danh sách files sẽ được tạo (không ghi)')
    .option('--onboard', 'Ép chạy onboard deep-scan sau init (kể cả khi không phải dự án lớn)')
    .action(handleInit);

// -- 2) run + subcommands ----------------------------------------------------
const run = program
    .command('run')
    .description('Harness loop — lái SDLC (intake → cook → check → acceptance → doc → ship)')
    .option('--dry-run', 'In chuỗi state dự kiến, không thực thi, không ghi state')
    .option('--from <state>', 'Bắt đầu từ một state cụ thể (INIT|BRAINSTORM|...|SHIP)')
    .option('--resume', 'Tiếp tục từ .omni/run/state.json (fallback: events.ndjson)')
    .option('--provider <name>', 'Provider động cơ: host-cli | claude-sdk | manual-relay | dry-run', 'host-cli')
    .option('--yes-ship', 'Cho phép đi vào SHIP mà không pause (vẫn KHÔNG tự push/deploy)')
    .option('--max-iterations <n>', 'Giới hạn số transition trước khi pause (mặc định 60)')
    .option('--max-cost <usd>', 'Giới hạn chi phí token (USD) cho provider claude-sdk (mặc định 5)')
    .option('--debate <specs>', 'Debate đối kháng chéo-provider, vd: "host-cli:claudecode,host-cli:antigravity"')
    .option('--debate-on <phases>', 'Bật debate ở phase nào: "check,ship" (mặc định check)')
    .option('--debate-rounds <n>', 'Số vòng tranh luận (mặc định 2)')
    // Phase-4 ------------------------------------------------------------------
    .option('--spec <file>', 'Đọc file spec/Q&A khách hàng → sinh .omni/sdlc/requirements.md trước khi chạy')
    .option('--accept <specs>', 'Provider participants cho acceptance debate (mặc định = --debate)')
    .option('--max-accept-rounds <n>', 'Số vòng ACCEPTANCE → COOK trước BLOCKED (mặc định 3)')
    .option('--yolo', 'Mọi host-cli agent bỏ qua MỌI permission (claude/codex dùng --dangerously-skip-permissions như agy). Cho autonomous run; harness vẫn chặn lệnh nguy hiểm.')
    .option('--stream', 'Đẩy raw output của agent ra terminal (prefix │) realtime. Heartbeat ⏳ luôn bật dù không có cờ này.')
    .action(handleRun);

run.command('gate')
    .description('Chỉ chạy quality pipeline P0–P5 (lint/build/test) và exit 0/1 — CI-friendly')
    .option('--only <ids>', 'Chỉ chạy các gate theo id, vd: "P3" hoặc "P1,P3"')
    .action(handleGate);

run.command('log')
    .description('In nhật ký event của lần chạy harness gần nhất (.omni/run/events.ndjson)')
    .option('--limit <n>', 'Số event cuối cần in (mặc định 50)')
    .option('--follow', 'Theo dõi live (tail -f): in event mới khi xuất hiện (Ctrl-C để dừng)')
    .action(handleTrace);

run.command('stats')
    .description('Tổng hợp token/chi phí/thời gian theo state từ event log')
    .action(handleStats);

run.command('accept')
    .description('Chạy state ACCEPTANCE riêng trên build hiện tại (CI: exit 0 nếu 100% met)')
    .option('--accept <specs>', 'Provider participants cho acceptance debate')
    .option('--yolo', 'Agent bỏ qua mọi permission (xem `omni run --help`)')
    .action(handleAccept);

// -- 3) skills + subcommands -------------------------------------------------
const skills = program
    .command('skills')
    .description('Quản lý skills (no-arg = auto-equip + status)')
    .action(handleSkillsDefault);

skills.command('add <source>')
    .description('Cài skill từ nhiều nguồn: owner/repo | URL | gh:owner/repo/path.md | ./local.md')
    .option('-n, --name <name>', 'Đặt tên ngắn gọn cho kỹ năng (mặc định: tự sinh từ source)')
    .option('-f, --force', 'Bỏ qua cảnh báo xung đột để cài đè')
    .action(handleEquip);

skills.command('doctor')
    .description('Kiểm tra sức khỏe registry skill (nguồn sống/chết) + validate skill đã cài')
    .option('--offline', 'Bỏ qua kiểm tra mạng, chỉ validate skill local')
    .action(handleDoctor);

// -- 4) map ------------------------------------------------------------------
program
    .command('map')
    .description('Quét codebase và tạo/cập nhật Project Map cho AI navigation')
    .option('--refresh', 'Cập nhật cấu trúc mà không cần AI (0 token)')
    .action(handleMap);

// -- 5) rules ----------------------------------------------------------------
program
    .command('rules [action]')
    .description('Quản lý personal rules (xem/sửa/sync/reset)')
    .option('--dry-run', 'Xem trước kết quả sync (không ghi)')
    .action(handleRules);

// ---------------------------------------------------------------------------
// Hidden aliases (backward-compat). Each prints a one-line deprecation hint
// then delegates to the original handler — no feature is lost.
// ---------------------------------------------------------------------------

program.command('equip <source>', { hidden: true })
    .option('-n, --name <name>')
    .option('-f, --force')
    .action(deprecate('equip', 'skills add', handleEquip));

program.command('auto-equip', { hidden: true })
    .option('-y, --yes')
    .action(deprecate('auto-equip', 'skills', handleAutoEquip));

program.command('status', { hidden: true })
    .action(deprecate('status', 'skills', handleStatus));

program.command('skills:doctor', { hidden: true })
    .option('--offline')
    .action(deprecate('skills:doctor', 'skills doctor', handleDoctor));

program.command('gate', { hidden: true })
    .option('--only <ids>')
    .action(deprecate('gate', 'run gate', handleGate));

program.command('trace', { hidden: true })
    .option('--limit <n>')
    .action(deprecate('trace', 'run log', handleTrace));

program.command('stats', { hidden: true })
    .action(deprecate('stats', 'run stats', handleStats));

program.command('onboard', { hidden: true })
    .option('--skip-init')
    .option('--refresh')
    .action(deprecate('onboard', 'init --onboard', handleOnboard));

// `commands` still useful (lists chat-side >om: commands) — keep hidden + quiet.
program.command('commands', { hidden: true })
    .action(handleCommands);

program.command('update', { hidden: true })
    .description('Kiểm tra và cập nhật omni-coder-kit lên phiên bản mới nhất')
    .action(handleUpdate);

program.command('customize <workflow>', { hidden: true })
    .description('Copy a workflow from package to .omni/workflows/ for customization')
    .action(handleCustomize);

program.parseAsync();
