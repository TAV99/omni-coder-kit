#!/usr/bin/env node
'use strict';

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
const { handleRun, handleTrace, handleGate } = require('../lib/commands/run');

program
    .name('omni')
    .description('Trình quản lý hệ tư tưởng Omni-Coder Kit')
    .version(PKG.version);

program
    .command('init')
    .description('Khởi tạo DNA và workflow cho dự án mới')
    .option('--dry-run', 'Xem trước danh sách files sẽ được tạo (không ghi)')
    .action(handleInit);

program
    .command('equip <source>')
    .description('Cài skill từ nhiều nguồn: owner/repo | URL | gh:owner/repo/path.md | ./local.md')
    .option('-n, --name <name>', 'Đặt tên ngắn gọn cho kỹ năng (mặc định: tự sinh từ source)')
    .option('-f, --force', 'Bỏ qua cảnh báo xung đột để cài đè')
    .action(handleEquip);

program
    .command('auto-equip')
    .description('Cài đặt universal skills (skill chuyên sâu do AI đề xuất qua >om:equip + find-skills)')
    .option('-y, --yes', 'Tự động cài đặt không cần xác nhận')
    .action(handleAutoEquip);

program
    .command('status')
    .description('Xem trạng thái skills đã cài đặt')
    .action(handleStatus);

program
    .command('commands')
    .description('Hiển thị danh sách các lệnh >om: dùng trong chat với AI')
    .action(handleCommands);

program
    .command('map')
    .description('Quét codebase và tạo/cập nhật Project Map cho AI navigation')
    .option('--refresh', 'Cập nhật cấu trúc mà không cần AI (0 token)')
    .action(handleMap);

program
    .command('update')
    .description('Kiểm tra và cập nhật omni-coder-kit lên phiên bản mới nhất')
    .action(handleUpdate);

program
    .command('rules [action]')
    .description('Quản lý personal rules (xem/sửa/sync/reset)')
    .option('--dry-run', 'Xem trước kết quả sync (không ghi)')
    .action(handleRules);

program
    .command('onboard')
    .description('Onboard dự án hiện có — deep scan + sinh report cho AI')
    .option('--skip-init', 'Bỏ qua auto-init (assume đã init)')
    .option('--refresh', 'Chạy lại scan, ghi đè report cũ')
    .action(handleOnboard);

program
    .command('customize <workflow>')
    .description('Copy a workflow from package to .omni/workflows/ for customization')
    .action(handleCustomize);

program
    .command('skills:doctor')
    .description('Kiểm tra sức khỏe registry skill (nguồn sống/chết) + validate skill đã cài')
    .option('--offline', 'Bỏ qua kiểm tra mạng, chỉ validate skill local')
    .action(handleDoctor);

program
    .command('run')
    .description('Harness loop — lái SDLC cook→check→fix; pause trước SHIP. Dùng --dry-run để chỉ xem kế hoạch')
    .option('--dry-run', 'In chuỗi state dự kiến, không thực thi, không ghi state')
    .option('--from <state>', 'Bắt đầu từ một state cụ thể (INIT|BRAINSTORM|...|SHIP)')
    .option('--resume', 'Tiếp tục từ .omni/run/state.json (fallback: events.ndjson)')
    .option('--provider <name>', 'Provider động cơ: host-cli | dry-run', 'host-cli')
    .option('--yes-ship', 'Cho phép đi vào SHIP mà không pause (vẫn KHÔNG tự push/deploy)')
    .option('--max-iterations <n>', 'Giới hạn số transition trước khi pause (mặc định 60)')
    .action(handleRun);

program
    .command('trace')
    .description('In nhật ký event của lần chạy harness gần nhất (.omni/run/events.ndjson)')
    .option('--limit <n>', 'Số event cuối cần in (mặc định 50)')
    .action(handleTrace);

program
    .command('gate')
    .description('Chỉ chạy quality pipeline P1–P3 (lint/build/test) và exit 0/1 — CI-friendly')
    .option('--only <ids>', 'Chỉ chạy các gate theo id, vd: "P3" hoặc "P1,P3"')
    .action(handleGate);

program.parseAsync();
