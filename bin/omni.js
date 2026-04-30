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
    .description('Tải và đồng bộ kỹ năng ngoài (external) từ skills.sh')
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
    .command('customize <workflow>')
    .description('Copy a workflow from package to .omni/workflows/ for customization')
    .action(handleCustomize);

program.parseAsync();
