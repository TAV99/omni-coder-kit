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
    handleDualCoverageInspect,
    handleDualCoverageApprove,
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
    handleDualRejectHandoff,
    handleDualMonitor,
    handleDualAcceptanceStart,
    handleDualAcceptanceReviewPrepare,
    handleDualAcceptanceReviewSubmit,
    handleDualAcceptanceComplete,
    handleDualBlock,
} = require('../lib/commands/dual');
const { handleSquadRuntimes, handleSquadSetup, handleSquadSkills, handleSquadPipeline, handleSquadApprove, handleSquadAuto } = require('../lib/commands/squad');
const { handleUi } = require('../lib/commands/ui');

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
    .option('--skill <selector>', 'Chọn chính xác một skill trong source multi-skill')
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

// Session commands shared by `omni dual` and `omni squad` (SPEC-SQUAD-P3 §6):
// one definition, same handlers, so both names always behave the same.
const SESSION_COMMANDS = ['run', 'resume', 'status', 'bootstrap', 'qc'];
function addSessionCommands(parent) {
    parent.command('run <task-id>')
        .description('Chạy tự động các phase hợp lệ cho task')
        .action(handleDualRun);
    parent.command('resume <task-id>')
        .description('Tiếp tục task từ trạng thái hiện tại')
        .action(handleDualResume);
    parent.command('status <task-id>')
        .description('Xem trạng thái, owner và bước tiếp theo của task')
        .action(handleDualStatus);
    parent.command('bootstrap')
        .description('Validate planning/setup, register the full typed task graph once, and resume Dual AUTO')
        .option('--json', 'Xuất một JSON object cho AUTO workflow')
        .option('--worker-model <model>', 'Tùy chọn worker model cho AGY (mặc định: gemini-3.7-flash-high)')
        .action(handleDualBootstrap);
    parent.command('qc [task-id]')
        .description('Tự động đo đạc snapshot diff, nộp QC Evidence và hoàn tất 3 chu kỳ Quality Gate')
        .option('--json', 'Xuất một JSON object cho AUTO workflow')
        .option('--review-submission <file>', 'Nộp untrusted review submission đã bind với daemon execution trước isolated integration')
        .option('--review-evidence <file>', 'Alias tương thích của --review-submission; caller-built evidence cũ bị từ chối')
        .action(handleDualQc);
}

// -- 7) dual -----------------------------------------------------------------
const dual = program
    .command('dual')
    .description('Điều phối Codex + worker (alias của omni squad, preset dual)');
addSessionCommands(dual);
// Nudge people toward the new name; stderr only, and only on a terminal, so
// agent-parsed stdout and --json output never change.
dual.hook('preAction', (_dual, action) => {
    if (SESSION_COMMANDS.includes(action.name()) && process.stderr.isTTY && !action.opts().json) {
        process.stderr.write(`(omni dual ${action.name()} = omni squad ${action.name()}, preset dual)\n`);
    }
});

const dualCoverage = dual.command('coverage').description('Inspect và approve decision coverage');
dualCoverage.command('inspect').action(handleDualCoverageInspect);
dualCoverage.command('approve')
    .requiredOption('--submission <file>', 'Explicit per-ID user decisions with candidate digest and provenance')
    .action(handleDualCoverageApprove);

dual.command('new <task-id>')
    .description('Tạo transaction mới cho task')
    .action(handleDualNew);

dual.command('phase <phase> <task-id>')
    .description('Chạy một phase cụ thể (preflight|scout|spec|route|implement|scope|review)')
    .action(handleDualPhase);

dual.command('reject-handoff')
    .description('Ghi nhận controller rejection cho released isolated handoff, trước integration')
    .requiredOption('--submission <file>', 'Strict JSON gồm current session/task/revision/attempt, candidate hashes và findings')
    .option('--json', 'Xuất exact negative acknowledgement')
    .action(handleDualRejectHandoff);

const dualAcceptance = dual
    .command('acceptance')
    .description('Điều khiển acceptance review/correction qua authority daemon');

dualAcceptance.command('start <task-id>')
    .description('Bắt đầu acceptance correction có policy/CAS/scope/validator ràng buộc')
    .requiredOption('--reason <text>', 'Lý do correction')
    .requiredOption('--expected-sequence <n>', 'Authority sequence hiện tại')
    .requiredOption('--start-fingerprint <sha256>', 'Current integrated diff fingerprint')
    .requiredOption('--failure-check-id <id>', 'Required failed acceptance check ID')
    .option('--json', 'Xuất một JSON object duy nhất')
    .action(handleDualAcceptanceStart);

dualAcceptance.command('submit <task-id>')
    .description('Nộp untrusted review findings cho daemon-owned review execution')
    .requiredOption('--plan-revision <n>', 'Plan revision của acceptance review')
    .option('--review-submission <file>', 'File JSON chứa review_execution_id và check_results')
    .option('--review-evidence <file>', 'Alias tương thích của --review-submission; evidence hash cũ bị từ chối')
    .option('--json', 'Xuất một JSON object duy nhất')
    .action(handleDualAcceptanceReviewSubmit);

dualAcceptance.command('prepare <task-id>')
    .description('Chuẩn bị daemon-owned review execution với candidate bindings hiện tại')
    .requiredOption('--plan-revision <n>', 'Plan revision của acceptance review')
    .option('--json', 'Xuất một JSON object duy nhất')
    .action(handleDualAcceptanceReviewPrepare);

dualAcceptance.command('complete <correction-id>')
    .description('Hoàn tất acceptance correction; status do daemon validator quyết định')
    .option('--summary <text>', 'Tóm tắt bounded của correction')
    .option('--json', 'Xuất một JSON object duy nhất')
    .action(handleDualAcceptanceComplete);

dual.command('block')
    .description('Ghi durable blocker và dừng session Dual')
    .requiredOption('--reason <text>', 'Lý do block')
    .requiredOption('--blocker-code <code>', 'Mã blocker bounded')
    .option('--json', 'Xuất một JSON object duy nhất')
    .action(handleDualBlock);

dual.command('monitor [workspace]')
    .description('Theo dõi real-time ledger và trạng thái Dual Authority session')
    .option('--poll <ms>', 'Chu kỳ polling ms (mặc định: 500)')
    .option('--json', 'Xuất từng event dạng raw JSON line')
    .action(handleDualMonitor);

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

// -- squad -------------------------------------------------------------------
const squad = program
    .command('squad')
    .description('Đội agent theo vai (3.2.0) — runtime registry, vai, pipeline');

squad.command('runtimes')
    .description('Kiểm tra CLI agent trên máy: version, đăng nhập, danh sách model')
    .option('--json', 'Xuất RuntimeReport[] dạng JSON')
    .option('--runtime <id>', 'Chỉ kiểm một runtime (vd. codex, agy)')
    .option('--timeout <ms>', 'Timeout cho mỗi lần probe (mặc định 15000)')
    .action(handleSquadRuntimes);

squad.command('setup')
    .description('Tạo file vai, gắn CLI/model/effort cho từng vai, mount bộ skill của orchestrator')
    .option('--preset <name>', 'dual (orchestrator + 1 worker) | squad (+ nhiều worker, reviewer)', 'dual')
    .option('--workers <n>', 'Số worker cho preset squad (1–8)')
    .option('--bind <role=runtime:model[:effort]>', 'Gắn không tương tác, lặp lại được (vd. worker=agy:gemini-3.8-flash-high)',
        (value, list) => [...list, value], [])
    .option('-y, --yes', 'Không hỏi: dùng --bind hoặc lựa chọn lần trước, đồng ý chuyển skill không thuộc orchestrator')
    .option('--keep-skills', 'Không chuyển skill không thuộc orchestrator ra khỏi thư mục skill của project')
    .action(handleSquadSetup);

squad.command('pipeline')
    .description('Xem pipeline đang dùng (phase → vai → cổng duyệt) và engine có chạy được không')
    .action(handleSquadPipeline);

squad.command('skills [action]')
    .description('Bộ skill theo vai: status (mặc định) | sync (mount lại bộ của orchestrator)')
    .action(handleSquadSkills);

addSessionCommands(squad);

squad.command('approve [gateId]')
    .description('Duyệt cổng spec/plan/integrate (cần terminal, gõ mã xác nhận); không có gateId → liệt kê cổng đang chờ')
    .option('--reject', 'Từ chối thay vì duyệt')
    .option('--reason <text>', 'Lý do từ chối (bắt buộc khi --reject)')
    .action(handleSquadApprove);

squad.command('auto [state]')
    .description('AUTO on|off: bỏ qua cổng có auto_ok (spec/plan); cổng integrate luôn chờ người')
    .action(handleSquadAuto);

program.command('ui')
    .description('Trang web local (chỉ đọc) cho project squad: vai, task, cổng duyệt, timeline')
    .option('--port <n>', 'Cổng lắng nghe trên 127.0.0.1 (mặc định: cổng trống bất kỳ)')
    .option('--no-open', 'Không tự mở trình duyệt')
    .action(handleUi);

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
