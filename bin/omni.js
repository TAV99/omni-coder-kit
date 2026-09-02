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
const { handleDoctor } = require('../lib/commands/doctor');
const { handleAgentFiles } = require('../lib/commands/agent-files');
const { handleRun, handleTrace, handleGate, handleStats, handleAccept } = require('../lib/commands/run');
const {
    handleDualNew,
    handleDualRun,
    handleDualResume,
    handleDualStatus,
    handleDualPhase,
    handleDualDaemonStart,
    handleDualDaemonStatus,
    handleDualDaemonStop,
    handleDualDaemonRecover,
    handleDualBaselinePromote,
    handleDualSetupRun,
    handleDualBootstrap,
    handleDualQc,
} = require('../lib/commands/dual');

// `omni skills` no-arg = auto-equip + status (one-stop "show me my skills").
async function handleSkillsDefault(options = {}) {
    await handleAutoEquip(options);
    await handleStatus();
}

program
    .name('omni')
    .description('Trình quản lý hệ tư tưởng Omni-Coder Kit (CLI gọn — nhóm lệnh chính + harness)')
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
    .option('--reintake', 'Ghi đè requirements.md kể cả khi đã tồn tại (hoặc tự động làm nếu file cũ thoái hoá/rác)')
    .option('--accept <specs>', 'Provider participants cho acceptance debate (mặc định = --debate)')
    .option('--max-accept-rounds <n>', 'Số vòng ACCEPTANCE → COOK trước BLOCKED (mặc định 3)')
    .option('--max-time <minutes>', 'Ngân sách thời gian mỗi phiên chạy (phút, mặc định 60)')
    .option('--step-timeout <minutes>', 'Timeout mỗi bước agent (cook/fix/check…) phút (mặc định 10)')
    .option('--yolo', 'Mọi host-cli agent bỏ qua MỌI permission (claude/codex dùng --dangerously-skip-permissions như agy). Cho autonomous run; harness vẫn chặn lệnh nguy hiểm.')
    .option('--stream', 'Đẩy raw output của agent ra terminal (prefix │) realtime. Tắt spinner heartbeat (output cuộn).')
    .option('--no-progress', 'Tắt spinner heartbeat; chỉ in lỗi + task xong (alias: --quiet)')
    .option('--quiet', 'Bí danh của --no-progress')
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
    .option('--max-time <minutes>', 'Ngân sách thời gian mỗi phiên chạy (phút, mặc định 60)')
    .option('--step-timeout <minutes>', 'Timeout mỗi bước agent (cook/fix/check…) phút (mặc định 10)')
    .option('--yolo', 'Agent bỏ qua mọi permission (xem `omni run --help`)')
    .option('--no-progress', 'Tắt spinner heartbeat; chỉ in lỗi + task xong')
    .option('--quiet', 'Bí danh của --no-progress')
    .action(handleAccept);

// -- 3) skills + subcommands -------------------------------------------------
const skills = program
    .command('skills')
    .description('Quản lý skills (no-arg = auto-equip + status)')
    .option('-y, --yes', 'Tự động đồng ý cài đặt universal skills (không hỏi lại)')
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

// -- 6) agent-files (hide/show root agent config via .gitignore) -------------
program
    .command('agent-files [action]')
    .description('Ẩn/hiện file agent (AGENTS.md, CLAUDE.md, …) khỏi git qua .gitignore')
    .action(handleAgentFiles);

// -- 7) dual -----------------------------------------------------------------
const dual = program
    .command('dual')
    .description('Điều phối Codex + Gemini qua agy');

dual.command('new <task-id>')
    .description('Tạo transaction mới cho task')
    .action(handleDualNew);

dual.command('run <task-id>')
    .description('Chạy tự động các phase hợp lệ cho task')
    .action(handleDualRun);

dual.command('resume <task-id>')
    .description('Tiếp tục task từ trạng thái hiện tại')
    .action(handleDualResume);

dual.command('status <task-id>')
    .description('Xem trạng thái, owner và bước tiếp theo của task')
    .action(handleDualStatus);

dual.command('phase <phase> <task-id>')
    .description('Chạy một phase cụ thể (preflight|scout|spec|route|implement|scope|review)')
    .action(handleDualPhase);

dual.command('bootstrap')
    .description('Validate planning/setup, register the full typed task graph once, and resume Dual AUTO')
    .option('--json', 'Xuất một JSON object cho AUTO workflow')
    .option('--worker-model <model>', 'Tùy chọn worker model cho AGY (mặc định: gemini-3.7-flash-high)')
    .action(handleDualBootstrap);

dual.command('qc [task-id]')
    .description('Tự động đo đạc snapshot diff, nộp QC Evidence và hoàn tất 3 chu kỳ Quality Gate')
    .option('--json', 'Xuất một JSON object cho AUTO workflow')
    .action(handleDualQc);

const dualDaemon = dual
    .command('daemon')
    .description('Quản lý vòng đời authority daemon (start|status|stop|recover)');

dualDaemon.command('start')
    .description('Khởi chạy authority daemon cho workspace')
    .action(handleDualDaemonStart);

dualDaemon.command('status')
    .description('Xem trạng thái hoạt động của authority daemon')
    .action(handleDualDaemonStatus);

dualDaemon.command('stop')
    .description('Dừng authority daemon của workspace')
    .action(handleDualDaemonStop);

dualDaemon.command('recover')
    .description('Archive session mồ côi và tạo authority mới khi workspace còn pristine')
    .requiredOption('--if-pristine', 'Chỉ recovery khi workspace khớp baseline và chưa có execution evidence')
    .option('--json', 'Xuất một JSON object cho AUTO workflow')
    .action(handleDualDaemonRecover);

const dualBaseline = dual
    .command('baseline')
    .description('Quản lý baseline và promotion');

dualBaseline.command('promote')
    .description('Chuyển đổi baseline từ snapshot sang Git commit đã được nghiệm thu')
    .action(handleDualBaselinePromote);

const dualSetup = dual
    .command('setup')
    .description('Quản lý và thực thi setup manifest cho workspace');

dualSetup.command('run')
    .description('Chạy setup manifest (.omni/sdlc/setup.json) cho workspace')
    .option('--dry-run', 'Kiểm tra và resolve các action mà không thực thi hoặc ghi receipt')
    .option('--force', 'Ép chạy lại toàn bộ action kể cả khi receipt hợp lệ')
    .option('--json', 'Xuất kết quả dưới dạng JSON object duy nhất ra stdout')
    .action(handleDualSetupRun);

// ---------------------------------------------------------------------------
// Hidden utility commands (not aliases of the main groups — power-user tools)
// ---------------------------------------------------------------------------

program.command('commands', { hidden: true })
    .action(handleCommands);

program.command('update', { hidden: true })
    .description('Kiểm tra và cập nhật omni-coder-kit lên phiên bản mới nhất')
    .action(handleUpdate);

program.command('customize <workflow>', { hidden: true })
    .description('Copy a workflow from package to .omni/workflows/ for customization')
    .action(handleCustomize);

program.parseAsync();
