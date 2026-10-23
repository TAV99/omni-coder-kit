'use strict';
const { taskReadiness } = require('../dual/task-scheduler');
const { unansweredQuestions } = require('../dual/task-messages');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const chalk = require('chalk');

const { createDualOrchestrator } = require('../dual');
const { createDaemonClient } = require('../dual/daemon-client');
const { createAuthorityStore } = require('../dual/authority-store');
const { detectBaselineBackend } = require('../dual/baseline');
const { createGitBaseline } = require('../dual/baseline-git');
const { computeSnapshotRootHash, isDefaultIgnoredFile } = require('../dual/baseline-snapshot');
const { createConfiguredSnapshotBaseline, CANONICAL_CONTROL_PLANE_EXCLUDES } = require('../dual/snapshot-policy');
const { writeInitialSnapshot, readInitialSnapshot } = require('../dual/snapshot-store');
const { executeSetupManifest } = require('../dual/setup-command');
const { evaluateSetupReadiness } = require('../dual/setup-command');
const { inspectPrivateDependencyReadiness, inspectPrivateDependencyReadinessAsync } = require('../dual/private-dependencies');
const { DualPlanManifestSchema, TaskHandoffRejectionInputSchema, parseContract } = require('../dual/contracts');
const { execGit, normalizeRepoPath } = require('../dual/workspace');
const { captureDiffFingerprint } = require('../dual/scope-guard');
const { evaluateAdaptiveVisualQa } = require('../dual/visual-qa');
const {
    buildQualityPlan,
    deriveQualityExecutionId,
    executeQualityPlan,
    persistQualityExecutionArtifact,
    qualityGateResults,
    readQualityExecutionArtifact,
    runBoundedCommand,
} = require('../dual/quality-runner');
const { DualObserver } = require('../dual/observer');
const { hashAcceptancePolicy } = require('../dual/acceptance-policy');

const DUAL_ERROR_MESSAGES = {
    DUAL_CONTRACT_INVALID: 'Dữ liệu contract không hợp lệ.',
    DUAL_NOT_GIT_REPOSITORY: 'Thư mục hiện tại không phải là một Git repository hợp lệ.',
    DUAL_GIT_HEAD_MISSING: 'Git repository chưa có commit nào (HEAD missing). Cần commit trước khi chạy Dual.',
    DUAL_PATH_ESCAPE: 'Đường dẫn vượt ra ngoài phạm vi repository.',
    DUAL_WORKTREE_DIRTY: 'Thư mục làm việc đang có thay đổi chưa commit ngoài transaction.',
    DUAL_BASE_COMMIT_MISMATCH: 'Base commit của task không khớp với HEAD hiện tại.',
    DUAL_BASE_COMMIT_STALE: 'HEAD đã thay đổi so với expected base commit của task.',
    DUAL_DENY_PATTERN: 'File thay đổi khớp với mẫu bị cấm (deny pattern).',
    DUAL_SCOPE_VIOLATION: 'Phát hiện thay đổi ngoài danh sách allowed_files trong spec.',
    DUAL_REVIEW_MUTATION: 'Worker review đã thay đổi diff của mã nguồn.',
    DUAL_STATE_CAUSATION: 'Phase không thể chuyển trạng thái hiện tại.',
    DUAL_ARTIFACT_HASH: 'Mã băm SHA-256 của artifact không khớp hoặc file bị thiếu.',
    DUAL_EVENT_LOG_CORRUPT: 'Nhật ký sự kiện events.ndjson bị hỏng hoặc không đúng định dạng.',
    DUAL_EVENT_SEQUENCE: 'Thứ tự chuỗi sự kiện không liên tục.',
    DUAL_EVENT_CORRELATION: 'Sự kiện không khớp task_id hoặc expected_base_commit.',
    DUAL_PHASE_ALREADY_COMPLETED: 'Phase đã hoàn thành thành công trước đó, không thể chạy lại.',
    DUAL_ATTEMPT_SEQUENCE: 'Số thứ tự lần thử (attempt) không hợp lệ.',
    DUAL_STATE_TRANSITION: 'Chuyển đổi trạng thái không hợp lệ.',
    DUAL_ARTIFACT_EXISTS: 'File artifact bất biến đã tồn tại, không thể ghi đè.',
    DUAL_ARTIFACT_PATH: 'Đường dẫn artifact vượt ra ngoài thư mục task run.',
    DUAL_AGY_INPUT_SCOPE: 'Input hoặc schema của Agy nằm ngoài repository.',
    DUAL_AGY_TIMEOUT_INVALID: 'Timeout của Agy không hợp lệ.',
    DUAL_AGY_TIMEOUT: 'Agy đã quá thời gian thực thi (timeout).',
    DUAL_AGY_FAILED: 'Thực thi Agy thất bại.',
    DUAL_AGY_SPAWN: 'Không thể khởi chạy tiến trình Agy.',
    DUAL_AGY_EXIT_NONZERO: 'Tiến trình Agy thoát với mã lỗi non-zero.',
    DUAL_AGY_EMPTY_OUTPUT: 'Agy không trả về kết quả (stdout trống).',
    DUAL_AGY_OUTPUT_MALFORMED: 'Kết quả từ Agy không đúng định dạng JSON.',
    DUAL_AGY_CONTRACT_INVALID: 'Payload Agy không thỏa contract bắt buộc.',
    DUAL_TASK_EXISTS: 'Task ID đã tồn tại trong repository.',
    DUAL_TASK_NOT_FOUND: 'Không tìm thấy thông tin cho Task ID.',
    DUAL_PREFLIGHT_AGY_MISSING: 'Không tìm thấy Agy CLI hoặc lệnh agy --version thất bại.',
    DUAL_PREFLIGHT_MODEL_UNAVAILABLE: 'Model được cấu hình không khả dụng trong Agy.',
    DUAL_TRANSITION_INVALID: 'Không thể thực hiện phase này từ trạng thái hiện tại.',
    DUAL_SPEC_MISSING: 'Chưa tìm thấy file spec.json trong thư mục run của task.',
    DUAL_SPEC_INVALID: 'File spec.json không đúng định dạng JSON.',
    DUAL_SPEC_CORRELATION: 'spec.json không khớp task_id hoặc expected_base_commit.',
    DUAL_ROUTE_NOT_GEMINI: 'Task này thuộc quyền của Codex, không thể chạy implement qua Gemini.',
    DUAL_UNKNOWN_PHASE: 'Phase không xác định.',
    DUAL_WORKSPACE_ROOT_INVALID: 'Đường dẫn workspace không hợp lệ hoặc không tồn tại.',
    DUAL_DAEMON_NOT_RUNNING: 'Authority daemon chưa được khởi chạy hoặc không phản hồi.',
    DUAL_DAEMON_START_FAILED: 'Không thể khởi chạy authority daemon.',
    DUAL_DAEMON_STOP_FAILED: 'Không thể dừng authority daemon sau thời gian chờ.',
    DUAL_DISCOVERY_MISSING: 'Không tìm thấy file discovery của daemon.',
    DUAL_DISCOVERY_CORRUPT: 'File discovery của daemon bị hỏng hoặc không đúng định dạng.',
    DUAL_DISCOVERY_WORKSPACE_MISMATCH: 'File discovery thuộc về workspace khác.',
    DUAL_LOCK_CORRUPT: 'File lock của daemon bị hỏng.',
    DUAL_LOCK_WORKSPACE_MISMATCH: 'File lock thuộc về workspace khác.',
    DUAL_DAEMON_ACTIVE: 'Authority daemon đang hoạt động trên workspace này.',
    DUAL_PROMOTION_NOT_VERIFIED: 'Session chưa đạt trạng thái VERIFIED, không thể promote baseline.',
    DUAL_PROMOTION_BASELINE_NOT_SNAPSHOT: 'Baseline hiện tại không phải là snapshot, không thể promote.',
    DUAL_PROMOTION_RECEIPT_MISSING: 'Không tìm thấy receipt nghiệm thu của session.',
    DUAL_PROMOTION_ACCEPTED_SNAPSHOT_MISSING: 'Không tìm thấy file accepted-snapshot.json.',
    DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID: 'File accepted-snapshot.json không hợp lệ hoặc bị sửa đổi.',
    DUAL_PROMOTION_WORKSPACE_DIRTY: 'Workspace hiện tại có thay đổi khác so với accepted snapshot.',
    DUAL_PROMOTION_GIT_MISSING: 'Thư mục hiện tại chưa được khởi tạo Git repository bởi người dùng.',
    DUAL_PROMOTION_GIT_HEAD_MISSING: 'Git repository chưa có commit HEAD nào.',
    DUAL_PROMOTION_TREE_MISMATCH: 'Cây commit Git HEAD không khớp chính xác với accepted snapshot.',
    DUAL_PROMOTION_UNTRACKED_ACCEPTED_FILE: 'File được nghiệm thu trong accepted snapshot chưa được commit vào Git HEAD.',
    DUAL_PROMOTION_SYMLINK_REJECTED: 'Phát hiện symlink/submodule trong Git HEAD; không được hỗ trợ trong baseline promotion.',
    DUAL_PROMOTION_STOP_FAILED: 'Không thể dừng daemon an toàn trước khi promote baseline.',
    DUAL_PROMOTION_CONFLICT: 'Git HEAD khác với Git baseline đã promote trước đó.',
    DUAL_PROMOTION_BLOCKED: 'Baseline promotion bị chặn do không thỏa mãn điều kiện nghiệm thu.',
    DUAL_SETUP_MANIFEST_MISSING: 'Không tìm thấy file manifest .omni/sdlc/setup.json.',
    DUAL_SETUP_MANIFEST_INVALID: 'File manifest .omni/sdlc/setup.json không đúng định dạng hoặc vượt quá kích thước cho phép.',
    DUAL_SETUP_MANIFEST_MALFORMED: 'File manifest .omni/sdlc/setup.json chứa JSON không hợp lệ.',
    DUAL_SETUP_RECEIPT_CORRUPT: 'File receipt.json bị hỏng hoặc không đúng định dạng. Sử dụng --force để chạy lại.',
    DUAL_SETUP_LOCKED: 'Một tiến trình setup khác đang chạy trong workspace.',
    DUAL_SETUP_LOCK_CORRUPT: 'File runtime lock setup.lock bị hỏng hoặc không hợp lệ.',
    DUAL_SETUP_ACTION_FAILED: 'Thực thi setup action thất bại.',
    DUAL_SETUP_RESOLVE_FAILED: 'Không thể resolve executable cho setup action.',
    DUAL_SETUP_EXECUTABLE_UNTRUSTED: 'Executable không an toàn hoặc là shell wrapper không được phép.',
    DUAL_SETUP_NO_LOCKFILE: 'Không tìm thấy lockfile phù hợp để tự động nhận diện package manager.',
    DUAL_SETUP_LOCKFILE_CONFLICT: 'Phát hiện nhiều lockfile xung đột trong cùng thư mục.',
    DUAL_SETUP_PROGRAM_INVALID: 'Tên chương trình không hợp lệ trong setup manifest.',
    DUAL_SETUP_ACTIONS_INVALID: 'Danh sách actions không hợp lệ trong setup manifest.',
    DUAL_RECOVERY_UNSAFE: 'Không thể recovery vì session hoặc workspace đã có authority/work chưa được bảo toàn.',
    DUAL_RECOVERY_ARCHIVE_EXISTS: 'Archive của session này đã tồn tại; recovery bị chặn để tránh ghi đè.',
    DUAL_RECOVERY_FAILED: 'Recovery authority session thất bại; ledger cũ đã được giữ lại.',
    DUAL_BOOTSTRAP_PLAN_MISSING: 'Thiếu `.omni/sdlc/dual-plan.json`; planning phải hoàn tất trước authority bootstrap.',
    DUAL_BOOTSTRAP_PLAN_INVALID: 'Typed full-graph plan không hợp lệ.',
    DUAL_BOOTSTRAP_PLAN_CHANGED: 'Typed plan thay đổi trong lúc setup; bootstrap bị dừng để tránh đăng ký sai graph.',
    DUAL_BOOTSTRAP_SESSION_CONFLICT: 'Session hiện tại đã có plan khác và không đủ điều kiện legacy adoption.',
    DUAL_BOOTSTRAP_ADOPTION_UNSAFE: 'Không thể adoption session bootstrap cũ vì có source drift hoặc execution evidence.',
};

function formatNextAction(action, taskId) {
    switch (action) {
        case 'preflight':
            return `omni dual phase preflight ${taskId} (hoặc omni dual run ${taskId})`;
        case 'scout':
            return `omni dual phase scout ${taskId} (hoặc omni dual run ${taskId})`;
        case 'spec':
            return `Codex tạo .omni/codex-gemini/runs/${taskId}/spec.json`;
        case 'route':
            return `omni dual phase route ${taskId} (hoặc omni dual run ${taskId})`;
        case 'implement':
            return `omni dual phase implement ${taskId} (hoặc omni dual run ${taskId})`;
        case 'authority_resume':
            return `omni dual resume ${taskId} (authority controller)`;
        case 'wait_for_dependency':
            return 'Đợi task liên quan được Codex QC và tích hợp; không sửa hoặc reset ledger';
        case 'answer_worker_question':
            return 'Codex trả lời câu hỏi qua omni_dual_resume.context_reply rồi resume cùng task';
        case 'request_correction':
            return 'Codex kiểm tra outcome và yêu cầu correction có giới hạn qua omni_dual_resume.correction';
        case 'block_exhausted_attempts':
            return 'Giữ evidence; block session qua omni_dual_session_block vì attempt 3 đã bị reject';
        case 'scope':
            return `omni dual phase scope ${taskId} (hoặc omni dual run ${taskId})`;
        case 'review':
            return `omni dual phase review ${taskId} (hoặc omni dual run ${taskId})`;
        case 'codex_work':
            return `Codex thực hiện task (nằm ngoài phạm vi Gemini)`;
        case 'codex_qc':
            return `Codex tiến hành kiểm tra QC và chạy kiểm thử độc lập`;
        case 'wait_for_agy':
            return `Đợi AGY hoàn tất lease hiện tại; heartbeat/retry được authority daemon quản lý`;
        default:
            return action || 'hoàn tất';
    }
}

function formatAttempts(attempts) {
    if (!attempts || typeof attempts !== 'object') return '0';
    const entries = Object.entries(attempts);
    if (entries.length === 0) return '0';
    return entries.map(([p, a]) => `${p}: ${a}`).join(', ');
}

function deriveAuthorityTaskState(task, leases) {
    if (task.state === 'TASK_VERIFIED') return task.state;
    const taskLeases = Object.values(leases || {}).filter(
        (lease) => (lease.task_id || lease.taskId) === (task.task_id || task.taskId || task.id),
    );
    if (taskLeases.some((lease) => lease.owner === 'agy' && lease.status === 'active')) {
        return 'AGY_IN_PROGRESS';
    }
    if (task.lastOutcome) return task.lastOutcome.status;
    if (task.isolatedHandoff) return 'AWAITING_CODEX_QC';
    if (unansweredQuestions(task).length) return 'NEEDS_CONTEXT';
    if (taskLeases.some((lease) => (
        lease.owner === 'agy'
        &&
        lease.status === 'released'
        && (lease.release_reason || lease.releaseReason) === 'agy_reviewed_awaiting_codex_qc'
    ))) return 'AWAITING_CODEX_QC';
    if (taskLeases.some((lease) => lease.owner === 'agy' && lease.status === 'expired')) {
        return 'AGY_LEASE_EXPIRED';
    }
    return task.state || 'UNKNOWN';
}

function authorityNextAction(task, sessionState, derivedTaskState = task.state) {
    if (task.handoffRejection?.attempt === 3) return 'block_exhausted_attempts';
    if (['NEEDS_FIX', 'CONFLICT', 'FAILED'].includes(derivedTaskState)) return 'request_correction';
    if (derivedTaskState === 'NEEDS_CONTEXT') return 'answer_worker_question';
    if (derivedTaskState === 'WAITING_FOR_DEPENDENCY' || derivedTaskState === 'WAITING_FOR_SCOPE') return 'wait_for_dependency';
    if (derivedTaskState === 'TASK_VERIFIED') return 'hoàn tất';
    if (sessionState === 'BLOCKED') return 'kiểm tra blocker trong authority daemon';
    if (derivedTaskState === 'AWAITING_CODEX_QC') return 'codex_qc';
    if (derivedTaskState === 'AGY_IN_PROGRESS') return 'wait_for_agy';
    if (derivedTaskState === 'AGY_LEASE_EXPIRED') return 'kiểm tra blocker trong authority daemon';
    if (task.owner === 'codex') return 'codex_work';
    if (task.owner === 'agy') return 'authority_resume';
    return 'kiểm tra trạng thái authority daemon';
}

function normalizeAuthorityTaskStatus(status, taskId) {
    const tasks = status && status.tasks && typeof status.tasks === 'object' ? status.tasks : {};
    const task = tasks[taskId];
    if (!task) {
        const error = new Error(`Authority session does not contain task ${taskId}`);
        error.code = 'DUAL_TASK_NOT_FOUND';
        throw error;
    }

    const baseline = status.current_baseline || status.currentBaseline || null;
    const sessionState = status.state || status.session_state || status.sessionState || 'UNKNOWN';
    const receipt = status.receipt || null;
    let state = deriveAuthorityTaskState(task, status.leases);
    if (task.execution_mode === 'isolated' && state === 'ROUTED') {
        const readiness = taskReadiness({ tasks }, taskId);
        if (readiness.status !== 'READY') state = readiness.status;
    }
    return {
        taskId,
        sessionId: status.session_id || status.sessionId || null,
        planRevision: status.plan_revision || status.planRevision || null,
        state,
        baseline,
        attempts: task.attempts || {},
        owner: task.owner || 'unknown',
        controllerFindings: task.handoffRejection?.findings || [],
        nextAction: authorityNextAction(task, sessionState, state),
        sessionState,
        receiptSha256: receipt && (receipt.receipt_sha256 || receipt.receiptSha256) || null,
    };
}

async function readAuthorityTaskStatus(taskId, cwd = process.cwd()) {
    const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd);
    const client = createDaemonClient({ workspaceRoot: canonicalRoot });

    try {
        const health = await client.health();
        if (health && health.status === 'healthy' && health.session_id) {
            return normalizeAuthorityTaskStatus(await client.status(health.session_id), taskId);
        }
    } catch (error) {
        if (error.code !== 'DUAL_DISCOVERY_MISSING') throw error;
    }

    const authorityDir = path.join(canonicalRoot, '.omni', 'runs', 'dual-authority');
    const eventsPath = path.join(authorityDir, 'events.ndjson');
    if (!fs.existsSync(eventsPath)) return null;

    const store = createAuthorityStore(authorityDir);
    const integrity = store.verifyIntegrity();
    if (!integrity || !integrity.valid) {
        const error = new Error('Authority store integrity is invalid');
        error.code = 'DUAL_INTEGRITY_CORRUPT';
        throw error;
    }
    const derived = store.derive();
    if (!derived || !derived.sessionId) return null;
    return normalizeAuthorityTaskStatus(derived, taskId);
}

function handleDualError(error) {
    process.exitCode = 1;
    const code = error && error.code ? error.code : 'DUAL_ERROR';
    const vietnamese = DUAL_ERROR_MESSAGES[code] || (error && error.message) || 'Đã xảy ra lỗi trong quá trình thực thi Dual.';
    const details = error && error.details && Object.keys(error.details).length > 0
        ? ` (${JSON.stringify(error.details)})`
        : '';
    const extra = error && error.message && error.message !== vietnamese && !error.message.startsWith('Invalid ')
        ? ` - ${error.message}`
        : (error && error.message && error.message.startsWith('Invalid ') ? ` - ${error.message}` : '');
    console.error(chalk.red(`✗ [${code}] ${vietnamese}${extra}${details}`));
}

function getOrchestrator(overrides = {}) {
    const cwd = overrides.cwd || process.cwd();
    const agyCommand = process.env.OMNI_DUAL_AGY_COMMAND || 'agy';
    let agyPrefixArgs = [];
    if (process.env.OMNI_DUAL_AGY_PREFIX_ARGS) {
        try {
            agyPrefixArgs = JSON.parse(process.env.OMNI_DUAL_AGY_PREFIX_ARGS);
        } catch {
            agyPrefixArgs = [process.env.OMNI_DUAL_AGY_PREFIX_ARGS];
        }
    } else if (process.env.OMNI_DUAL_FAKE_AGY) {
        agyPrefixArgs = [process.env.OMNI_DUAL_FAKE_AGY];
    }

    const backend = overrides.backend || detectBaselineBackend(cwd);
    let initialSnapshot = overrides.initialSnapshot;
    if (backend === 'snapshot' && !initialSnapshot) {
        try {
            initialSnapshot = readInitialSnapshot({ authorityDir: path.join(cwd, ".omni", "runs", "dual-authority"), workspaceRoot: cwd });
        } catch {
            // ignore if snapshot is not yet written
        }
    }

    return createDualOrchestrator({
        cwd,
        backend,
        initialSnapshot,
        agyCommand,
        agyPrefixArgs,
        // CLI supplies enabled only; inject discussion.sessionResolver via overrides.
        // Resolver gets task/baseline context; host session/revision identity belongs in its closure.
        ...overrides,
        discussion: { enabled: process.env.OMNI_DUAL_DISCUSSION_ENABLED === '1', ...overrides.discussion },
    });
}

async function handleDualNew(taskId, options = {}) {
    try {
        const orch = getOrchestrator(options);
        const result = orch.newTask(taskId);
        console.log(chalk.green(`✓ Đã tạo Dual task thành công: ${chalk.bold(result.taskId)}`));
        console.log(chalk.white(`   State       : ${chalk.cyan(result.state)}`));
        console.log(chalk.white(`   Base commit : ${chalk.gray(result.expectedBaseCommit)}`));
        console.log(chalk.white(`   Owner       : ${chalk.yellow(result.owner)}`));
        console.log(chalk.white(`   Next action : ${chalk.green(formatNextAction(result.nextAction, result.taskId))}`));
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualRun(taskId, options = {}) {
    try {
        if (await handleAuthorityTaskContinuation(taskId, options)) return;
        const orch = getOrchestrator(options);
        const result = await orch.run(taskId);
        console.log(chalk.green(`✓ Dual run hoàn tất cho task: ${chalk.bold(result.taskId)}`));
        console.log(chalk.white(`   State       : ${chalk.cyan(result.state)}`));
        console.log(chalk.white(`   Owner       : ${chalk.yellow(result.owner)}`));
        console.log(chalk.white(`   Next action : ${chalk.green(formatNextAction(result.nextAction, result.taskId))}`));
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualResume(taskId, options = {}) {
    try {
        if (await handleAuthorityTaskContinuation(taskId, options)) return;
        const orch = getOrchestrator(options);
        const result = await orch.resume(taskId);
        console.log(chalk.green(`✓ Dual resume hoàn tất cho task: ${chalk.bold(result.taskId)}`));
        console.log(chalk.white(`   State       : ${chalk.cyan(result.state)}`));
        console.log(chalk.white(`   Owner       : ${chalk.yellow(result.owner)}`));
        console.log(chalk.white(`   Next action : ${chalk.green(formatNextAction(result.nextAction, result.taskId))}`));
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualStatus(taskId, options = {}) {
    try {
        const authority = await readAuthorityTaskStatus(taskId, options.cwd || process.cwd());
        if (authority) {
            const baseline = authority.baseline
                ? `${authority.baseline.kind} (${authority.baseline.id})`
                : 'none';
            console.log(chalk.cyan.bold(`\n📊 Trạng thái Dual Task: ${authority.taskId}\n`));
            console.log(chalk.white(`   Task        : ${chalk.bold(authority.taskId)}`));
            console.log(chalk.white(`   State       : ${chalk.cyan(authority.state)}`));
            console.log(chalk.white(`   Baseline    : ${chalk.gray(baseline)}`));
            console.log(chalk.white(`   Attempts    : ${chalk.yellow(formatAttempts(authority.attempts))}`));
            console.log(chalk.white(`   Owner       : ${chalk.yellow(authority.owner)}`));
            console.log(chalk.white(`   Session     : ${chalk.cyan(authority.sessionState)}`));
            for (const finding of authority.controllerFindings) {
                console.log(chalk.white(`   Finding     : [${finding.id}/${finding.requirement_id}] ${finding.file}:${finding.line} — ${finding.description}`));
            }
            if (authority.receiptSha256) {
                console.log(chalk.white(`   Receipt     : ${chalk.gray(authority.receiptSha256)}`));
            }
            console.log(chalk.white(`   Next action : ${chalk.green(formatNextAction(authority.nextAction, authority.taskId))}\n`));
            return;
        }

        const orch = getOrchestrator(options);
        const result = orch.status(taskId);
        console.log(chalk.cyan.bold(`\n📊 Trạng thái Dual Task: ${result.taskId}\n`));
        console.log(chalk.white(`   Task        : ${chalk.bold(result.taskId)}`));
        console.log(chalk.white(`   State       : ${chalk.cyan(result.state)}`));
        console.log(chalk.white(`   Base commit : ${chalk.gray(result.expectedBaseCommit)}`));
        console.log(chalk.white(`   Attempts    : ${chalk.yellow(formatAttempts(result.attempts))}`));
        console.log(chalk.white(`   Owner       : ${chalk.yellow(result.owner)}`));
        console.log(chalk.white(`   Next action : ${chalk.green(formatNextAction(result.nextAction, result.taskId))}\n`));
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualPhase(phase, taskId, options = {}) {
    try {
        if (await readAuthorityTaskStatus(taskId, options.cwd || process.cwd())) {
            throw bootstrapError('DUAL_AUTHORITY_PHASE_MANAGED',
                `Authority quản lý các phase; dùng omni dual resume ${taskId}, không chạy phase legacy trực tiếp.`);
        }
        const orch = getOrchestrator(options);
        const result = await orch.runPhase(phase, taskId);
        console.log(chalk.green(`✓ Phase ${chalk.bold(phase)} hoàn tất cho task: ${chalk.bold(result.taskId)}`));
        console.log(chalk.white(`   State       : ${chalk.cyan(result.state)}`));
        console.log(chalk.white(`   Owner       : ${chalk.yellow(result.owner)}`));
        console.log(chalk.white(`   Next action : ${chalk.green(formatNextAction(result.nextAction, result.taskId))}`));
        if (result.reused) {
            console.log(chalk.gray(`   (Kết quả phase trước đó đã được tái sử dụng - idempotent)`));
        }
    } catch (error) {
        handleDualError(error);
    }
}

function parseJsonFileForDual(filePath, label) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        const error = new Error(`${label} file is required`);
        error.code = 'DUAL_CONTRACT_INVALID';
        throw error;
    }
    const resolved = path.resolve(filePath);
    let raw;
    try {
        raw = fs.readFileSync(resolved, 'utf8');
    } catch (cause) {
        const error = new Error(`${label} file could not be read`);
        error.code = 'DUAL_CONTRACT_INVALID';
        error.cause = cause;
        throw error;
    }
    try {
        return JSON.parse(raw);
    } catch (cause) {
        const error = new Error(`${label} file is not valid JSON`);
        error.code = 'DUAL_CONTRACT_INVALID';
        error.cause = cause;
        throw error;
    }
}

async function getActiveDualSession(options = {}) {
    const rawRoot = options.cwd || process.cwd();
    if (!fs.existsSync(rawRoot)) {
        const error = new Error('Workspace root does not exist');
        error.code = 'DUAL_WORKSPACE_ROOT_INVALID';
        throw error;
    }
    const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
    const client = createDaemonClient({ workspaceRoot: canonicalRoot, timeoutMs: 15_000 });
    let health;
    try {
        health = await client.health();
    } catch (cause) {
        const error = new Error('Authority daemon is not healthy or not running');
        error.code = 'DUAL_DAEMON_NOT_RUNNING';
        error.cause = cause;
        throw error;
    }
    if (!health || health.status !== 'healthy' || typeof health.session_id !== 'string' || !health.session_id) {
        const error = new Error('No active Dual authority session');
        error.code = 'DUAL_SESSION_NOT_ACTIVE';
        throw error;
    }
    return { canonicalRoot, client, sessionId: health.session_id };
}

async function handleDualRejectHandoff(options = {}) {
    try {
        if (typeof options.submission !== 'string' || !options.submission.trim()) throw bootstrapError('DUAL_HANDOFF_REJECTION_INVALID', 'Submission file is required');
        const fd = fs.openSync(path.resolve(options.submission), 'r');
        let raw;
        try {
            const bytes = Buffer.alloc(64 * 1024 + 1);
            const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
            if (length > 64 * 1024) throw bootstrapError('DUAL_HANDOFF_REJECTION_INVALID', 'Submission exceeds 64 KiB');
            raw = bytes.subarray(0, length).toString('utf8');
        } finally { fs.closeSync(fd); }
        const parsed = TaskHandoffRejectionInputSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) throw bootstrapError('DUAL_HANDOFF_REJECTION_INVALID', 'Invalid rejection submission');
        const { client, sessionId } = await getActiveDualSession(options);
        if (sessionId !== parsed.data.session_id) throw bootstrapError('DUAL_SESSION_MISMATCH', 'Submission session does not match active authority');
        const result = await client.rejectTaskHandoff(parsed.data);
        if (!result || Object.keys(result).sort().join(',') !== 'acknowledged,attempt,reused,status,task_id'
            || result.acknowledged !== true || typeof result.reused !== 'boolean' || result.status !== 'NEEDS_FIX'
            || result.task_id !== parsed.data.task_id || result.attempt !== parsed.data.expected_attempt) {
            throw bootstrapError('DUAL_CLIENT_MALFORMED_RESPONSE', 'Invalid handoff rejection acknowledgement');
        }
        if (options.json) console.log(JSON.stringify(result));
        else console.log(`Handoff rejected: ${result.task_id} attempt ${result.attempt} — NEEDS_FIX; request bounded correction.`);
    } catch (error) {
        if (options.json) console.log(JSON.stringify({ ok: false, code: error.code || 'DUAL_HANDOFF_REJECTION_INVALID', message: 'Handoff rejection failed' }));
        else console.error('Handoff rejection failed. Inspect the current authority and bounded submission.');
        process.exitCode = 1;
    }
}

async function handleDualAcceptanceStart(taskId, options = {}) {
    const jsonMode = Boolean(options.json);
    try {
        const targetTaskId = typeof taskId === 'string' ? taskId.trim() : '';
        if (!targetTaskId) {
            const error = new Error('task-id is required');
            error.code = 'DUAL_CONTRACT_INVALID';
            throw error;
        }
        const expectedSequence = Number(options.expectedSequence);
        if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
            const error = new Error('--expected-sequence must be a non-negative integer');
            error.code = 'DUAL_CONTRACT_INVALID';
            throw error;
        }
        const { client, sessionId } = await getActiveDualSession(options);
        const result = await client.startAcceptanceCorrection(sessionId, {
            task_id: targetTaskId,
            reason: options.reason,
            expected_sequence: expectedSequence,
            start_fingerprint: options.startFingerprint,
            failure_check_id: options.failureCheckId,
        });
        if (jsonMode) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(chalk.green(`✓ Acceptance correction started: ${result.correction_id} (attempt ${result.attempt})`));
    } catch (error) {
        if (jsonMode) console.log(JSON.stringify({ ok: false, code: error.code || 'DUAL_ERROR', message: DUAL_ERROR_MESSAGES[error.code] || 'Acceptance correction start failed' }));
        handleDualError(error);
    }
}

async function handleDualAcceptanceReviewSubmit(taskId, options = {}) {
    const jsonMode = Boolean(options.json);
    try {
        const targetTaskId = typeof taskId === 'string' ? taskId.trim() : '';
        const planRevision = Number(options.planRevision);
        if (!targetTaskId || !Number.isSafeInteger(planRevision) || planRevision < 1) {
            const error = new Error('task-id and --plan-revision must be valid');
            error.code = 'DUAL_CONTRACT_INVALID';
            throw error;
        }
        if (options.reviewEvidence && options.reviewSubmission) {
            const error = new Error('Use only one of --review-submission or --review-evidence');
            error.code = 'DUAL_CONTRACT_INVALID';
            throw error;
        }
        const submissionPath = options.reviewSubmission || options.reviewEvidence;
        if (!submissionPath) {
            const error = new Error('--review-submission is required');
            error.code = 'DUAL_CONTRACT_INVALID';
            throw error;
        }
        const reviewSubmission = parseJsonFileForDual(submissionPath, 'Review submission');
        const { client, sessionId } = await getActiveDualSession(options);
        const result = await client.submitAcceptanceReview(sessionId, targetTaskId, planRevision, reviewSubmission);
        if (jsonMode) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(chalk.green(`✓ Acceptance review submitted for ${targetTaskId}: ${result.status}`));
    } catch (error) {
        if (jsonMode) console.log(JSON.stringify({ ok: false, code: error.code || 'DUAL_ERROR', message: DUAL_ERROR_MESSAGES[error.code] || 'Acceptance review submission failed' }));
        handleDualError(error);
    }
}

async function handleDualAcceptanceReviewPrepare(taskId, options = {}) {
    const jsonMode = Boolean(options.json);
    try {
        const targetTaskId = typeof taskId === 'string' ? taskId.trim() : '';
        const planRevision = Number(options.planRevision);
        if (!targetTaskId || !Number.isSafeInteger(planRevision) || planRevision < 1) {
            const error = new Error('task-id and --plan-revision must be valid');
            error.code = 'DUAL_CONTRACT_INVALID';
            throw error;
        }
        const { client, sessionId } = await getActiveDualSession(options);
        const result = await client.prepareAcceptanceReview(sessionId, targetTaskId, planRevision);
        if (jsonMode) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(chalk.green(`✓ Acceptance review prepared for ${targetTaskId}: ${result.review_execution_id}`));
    } catch (error) {
        if (jsonMode) console.log(JSON.stringify({ ok: false, code: error.code || 'DUAL_ERROR', message: DUAL_ERROR_MESSAGES[error.code] || 'Acceptance review preparation failed' }));
        handleDualError(error);
    }
}

async function handleDualAcceptanceComplete(correctionId, options = {}) {
    const jsonMode = Boolean(options.json);
    try {
        const { client, sessionId } = await getActiveDualSession(options);
        const result = await client.completeAcceptanceCorrection(sessionId, {
            correction_id: correctionId,
            ...(options.summary ? { summary: options.summary } : {}),
        });
        if (jsonMode) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(chalk.green(`✓ Acceptance correction ${result.correction_id} completed: ${result.status}`));
    } catch (error) {
        if (jsonMode) console.log(JSON.stringify({ ok: false, code: error.code || 'DUAL_ERROR', message: DUAL_ERROR_MESSAGES[error.code] || 'Acceptance correction completion failed' }));
        handleDualError(error);
    }
}

async function handleDualBlock(options = {}) {
    const jsonMode = Boolean(options.json);
    try {
        const { client, sessionId } = await getActiveDualSession(options);
        const result = await client.blockSession(sessionId, {
            reason: options.reason,
            blocker_code: options.blockerCode,
        });
        if (jsonMode) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(chalk.yellow(`⚠ Dual session blocked: ${result.blocker_code}`));
    } catch (error) {
        if (jsonMode) console.log(JSON.stringify({ ok: false, code: error.code || 'DUAL_ERROR', message: DUAL_ERROR_MESSAGES[error.code] || 'Dual session block failed' }));
        handleDualError(error);
    }
}

async function handleAuthorityTaskContinuation(taskId, options) {
    const cwd = options.cwd || process.cwd();
    let authority = await readAuthorityTaskStatus(taskId, cwd);
    if (!authority) return false;
    if (authority.sessionState === 'BLOCKED') {
        throw bootstrapError('DUAL_SESSION_BLOCKED', 'Authority session requires safe recovery before continuing.');
    }
    if (authority.nextAction === 'authority_resume') {
        const canonicalRoot = fs.realpathSync.native(cwd);
        const { client, health } = await ensureDaemonSession(canonicalRoot, authority.sessionId);
        const current = normalizeAuthorityTaskStatus(await client.status(health.session_id), taskId);
        if (current.planRevision !== authority.planRevision) {
            throw bootstrapError('DUAL_PLAN_REVISION_MISMATCH', 'Authority plan changed before task dispatch.');
        }
        if (current.nextAction === 'authority_resume') {
            const acknowledgment = await client.resumeSession({
                session_id: authority.sessionId, task_id: taskId, plan_revision: authority.planRevision,
            });
            if (acknowledgment.session_id !== authority.sessionId || acknowledgment.resumed !== true) {
                throw bootstrapError('DUAL_CLIENT_INVALID_RESPONSE', 'Authority did not acknowledge task continuation.');
            }
        }
        authority = normalizeAuthorityTaskStatus(await client.status(health.session_id), taskId);
    }
    console.log(chalk.cyan(`Authority task: ${authority.taskId}`));
    console.log(chalk.white(`   State       : ${authority.state}`));
    console.log(chalk.white(`   Owner       : ${authority.owner}`));
    console.log(chalk.white(`   Next action : ${formatNextAction(authority.nextAction, authority.taskId)}`));
    return true;
}

async function ensureDaemonSession(canonicalRoot, expectedSessionId) {
    const client = createDaemonClient({ workspaceRoot: canonicalRoot });
    let health = null;
    let isRunning = false;
    try {
        health = await client.health();
        if (health && health.status === 'healthy') isRunning = true;
    } catch (err) {
        if (
            err.code !== 'DUAL_DISCOVERY_MISSING' &&
            err.code !== 'DUAL_CLIENT_CONNECTION_REFUSED' &&
            err.code !== 'DUAL_CLIENT_TIMEOUT'
        ) throw err;
    }

    if (!isRunning) {
        const daemonEntrypoint = path.resolve(__dirname, '..', '..', 'bin', 'omni-daemon.js');
        const child = spawn(process.execPath, [daemonEntrypoint, '--workspace', canonicalRoot], {
            cwd: canonicalRoot,
            shell: false,
            windowsHide: true,
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        health = await client.waitForHealthy({ timeoutMs: 5000, intervalMs: 50 });
    }

    if (expectedSessionId && health.session_id !== expectedSessionId) {
        throw bootstrapError('DUAL_SESSION_MISMATCH', 'Authority lineage changed; refusing to create or resume another session.');
    }
    if (!health.session_id) {
        const backend = detectBaselineBackend(canonicalRoot);
        let identity;
        let manifest = null;
        if (backend === 'git') {
            identity = createGitBaseline({ root: canonicalRoot }).capture();
        } else {
            const { baseline: snapshotBaseline } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
            const captured = snapshotBaseline.capture();
            identity = captured.identity;
            manifest = captured.manifest;
        }
        const beginRes = await client.beginSession({
            session_id: crypto.randomUUID(),
            workspace_root: canonicalRoot,
            mode: 'auto',
            expected_baseline: identity,
        });
        if (backend === 'snapshot' && manifest) {
            writeInitialSnapshot({
                authorityDir: path.join(canonicalRoot, '.omni', 'runs', 'dual-authority'),
                sessionId: beginRes.session_id,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: beginRes.workspace_root || canonicalRoot,
                identity,
                manifest,
            });
        }
        health = await client.health();
    }
    return { client, health };
}

async function waitForDaemonStop(client) {
    await client.stop();
    const deadline = Date.now() + 5000;
    while (Date.now() <= deadline) {
        try {
            await client.health({ timeoutMs: 100 });
            await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (err) {
            if (
                err.code === 'DUAL_DISCOVERY_MISSING' ||
                err.code === 'DUAL_CLIENT_CONNECTION_REFUSED'
            ) return;
        }
    }
    const error = new Error('Authority daemon failed to stop within 5000ms timeout.');
    error.code = 'DUAL_DAEMON_STOP_FAILED';
    throw error;
}

function bootstrapError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function readDualPlanManifest(workspaceRoot, fsImpl = fs) {
    const relativePath = '.omni/sdlc/dual-plan.json';
    let normalizedPath;
    try {
        normalizedPath = normalizeRepoPath(workspaceRoot, relativePath);
    } catch (cause) {
        const code = fsImpl.existsSync(path.join(workspaceRoot, '.omni', 'sdlc', 'dual-plan.json'))
            ? 'DUAL_BOOTSTRAP_PLAN_INVALID'
            : 'DUAL_BOOTSTRAP_PLAN_MISSING';
        throw bootstrapError(code, 'Unable to resolve typed dual plan', { cause: cause.code });
    }
    const absolutePath = path.join(workspaceRoot, ...normalizedPath.split('/'));
    if (!fsImpl.existsSync(absolutePath)) {
        throw bootstrapError('DUAL_BOOTSTRAP_PLAN_MISSING', 'Typed dual plan does not exist');
    }
    const stat = fsImpl.lstatSync(absolutePath);
    if (!stat.isFile() || (stat.isSymbolicLink && stat.isSymbolicLink()) || stat.size > 256 * 1024) {
        throw bootstrapError('DUAL_BOOTSTRAP_PLAN_INVALID', 'Typed dual plan must be a bounded regular file');
    }
    let rawBytes;
    let parsed;
    try {
        rawBytes = fsImpl.readFileSync(absolutePath);
        parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch (cause) {
        throw bootstrapError('DUAL_BOOTSTRAP_PLAN_INVALID', 'Typed dual plan must contain valid JSON', { cause: cause.name });
    }
    let manifest;
    try {
        manifest = parseContract(DualPlanManifestSchema, parsed, 'dual plan manifest');
    } catch (cause) {
        throw bootstrapError('DUAL_BOOTSTRAP_PLAN_INVALID', 'Typed dual plan failed schema validation', { cause: cause.code });
    }
    return {
        manifest,
        relativePath: normalizedPath,
        sha256: crypto.createHash('sha256').update(rawBytes).digest('hex'),
    };
}

function isBootstrapPlanningPath(candidate) {
    const normalized = String(candidate || '').replace(/\\/g, '/').replace(/^\.\//, '');
    return (
        /^\.omni\/sdlc\/(design-spec\.md|content-source\.md|setup\.json|todo\.md|dual-plan\.json)$/u.test(normalized) ||
        /^docs\/superpowers\/plans\/[a-zA-Z0-9._-]+\.md$/u.test(normalized) ||
        normalized.startsWith('.agents/skills/') ||
        normalized.startsWith('.codex/skills/') ||
        normalized.startsWith('.omni/skills/') ||
        ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].includes(normalized)
    );
}

function assertLegacyBootstrapAdoptable(status, { setupReady, setupRequired, changedFiles } = {}) {
    const tasks = Object.values(status && status.tasks || {});
    const leases = Object.values(status && status.leases || {});
    const hasOnlyPlanningTasks = tasks.length > 0 && tasks.every((task) => (
        task &&
        task.owner === 'codex' &&
        ['REGISTERED', 'ROUTED'].includes(task.state) &&
        Array.isArray(task.allowed_files || task.allowedFiles) &&
        (task.allowed_files || task.allowedFiles).every(isBootstrapPlanningPath)
    ));
    const packageArtifacts = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
    const hasPackageDrift = Array.isArray(changedFiles) && changedFiles.some((file) => packageArtifacts.has(String(file).replace(/\\/g, '/')));
    const isPreExecutionBlocked = status && status.state === 'BLOCKED' && !status.receipt && leases.length === 0 && Object.keys(status.gates || {}).length === 0;
    const safeState = status && (['PLANNED', 'EXECUTING'].includes(status.state) || isPreExecutionBlocked);
    const safe = (
        status &&
        safeState &&
        !status.receipt &&
        Object.keys(status.gates || {}).length === 0 &&
        leases.length === 0 &&
        hasOnlyPlanningTasks &&
        setupReady === true &&
        (!hasPackageDrift || setupRequired === true) &&
        Array.isArray(changedFiles) &&
        changedFiles.every(isBootstrapPlanningPath)
    );
    if (!safe) {
        throw bootstrapError('DUAL_BOOTSTRAP_ADOPTION_UNSAFE', 'Legacy session contains non-planning authority or workspace changes');
    }
}

function collectLegacyBootstrapChanges(canonicalRoot, status) {
    const authorityDir = path.join(canonicalRoot, '.omni', 'runs', 'dual-authority');
    const baseline = status.current_baseline;
    if (!baseline) throw bootstrapError('DUAL_BOOTSTRAP_ADOPTION_UNSAFE', 'Legacy session baseline is missing');
    if (baseline.kind === 'snapshot') {
        const initial = readInitialSnapshot({
            authorityDir,
            sessionId: status.session_id,
            workspaceId: status.workspace_id,
            workspaceRoot: canonicalRoot,
        });
        const { baseline: snapshotBaseline } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
        return snapshotBaseline.diff(initial.identity, initial.manifest).map((entry) => entry.path);
    }
    if (baseline.kind === 'git') {
        return createGitBaseline({ root: canonicalRoot }).diff(baseline).map((entry) => entry.path);
    }
    throw bootstrapError('DUAL_BOOTSTRAP_ADOPTION_UNSAFE', 'Unsupported legacy baseline kind');
}

async function archiveLegacyBootstrapSession(canonicalRoot, client, status, deps = {}) {
    const evaluateSetup = deps.evaluateSetupReadiness || evaluateSetupReadiness;
    const collectChanges = deps.collectLegacyBootstrapChanges || collectLegacyBootstrapChanges;
    const ensureSession = deps.ensureDaemonSession || ensureDaemonSession;
    const setup = evaluateSetup(canonicalRoot);
    const changedFiles = collectChanges(canonicalRoot, status);
    assertLegacyBootstrapAdoptable(status, { setupReady: setup.ready, setupRequired: setup.required, changedFiles });

    const sessionId = String(status.session_id || '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) {
        throw bootstrapError('DUAL_BOOTSTRAP_ADOPTION_UNSAFE', 'Legacy session ID is unsafe');
    }
    const runsRoot = path.join(canonicalRoot, '.omni', 'runs');
    const authorityDir = path.join(runsRoot, 'dual-authority');
    const historyRoot = path.join(runsRoot, 'dual-history');
    const archivePath = path.join(historyRoot, sessionId);
    if (fs.existsSync(archivePath)) {
        throw bootstrapError('DUAL_RECOVERY_ARCHIVE_EXISTS', 'Legacy session archive already exists');
    }
    await waitForDaemonStop(client);
    fs.mkdirSync(historyRoot, { recursive: true });
    fs.renameSync(authorityDir, archivePath);
    try {
        return await ensureSession(canonicalRoot);
    } catch (cause) {
        try {
            if (fs.existsSync(authorityDir)) {
                fs.renameSync(authorityDir, path.join(historyRoot, `recovery-failed-${crypto.randomUUID()}`));
            }
            if (!fs.existsSync(authorityDir) && fs.existsSync(archivePath)) fs.renameSync(archivePath, authorityDir);
        } catch {
            // Preserve both ledgers under .omni/runs for explicit manual recovery.
        }
        throw bootstrapError('DUAL_RECOVERY_FAILED', 'Failed to create fresh authority after legacy adoption', { cause: cause.code });
    }
}

async function executeDualBootstrap({ workspaceRoot, workerModel } = {}, deps = {}) {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
        throw bootstrapError('DUAL_WORKSPACE_ROOT_INVALID', 'Workspace does not exist');
    }
    const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(workspaceRoot) : fs.realpathSync(workspaceRoot);
    if (workerModel && typeof workerModel === 'string' && workerModel.trim()) {
        const manifestPath = path.join(canonicalRoot, '.omni', 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                manifestData.workerModel = workerModel.trim();
                fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2) + '\n', 'utf8');
            } catch {}
        }
    }
    const readPlan = deps.readDualPlanManifest || readDualPlanManifest;
    const runSetup = deps.executeSetupManifest || executeSetupManifest;
    const ensureSession = deps.ensureDaemonSession || ensureDaemonSession;
    const adoptLegacy = deps.archiveLegacyBootstrapSession || archiveLegacyBootstrapSession;

    const beforeSetup = readPlan(canonicalRoot);
    const setupPath = path.join(canonicalRoot, '.omni', 'sdlc', 'setup.json');
    let setupResult = null;
    if (fs.existsSync(setupPath)) {
        setupResult = await runSetup({ workspaceRoot: canonicalRoot });
    }
    const plan = readPlan(canonicalRoot);
    if (plan.sha256 !== beforeSetup.sha256) {
        throw bootstrapError('DUAL_BOOTSTRAP_PLAN_CHANGED', 'Typed dual plan changed during setup');
    }

    // Diagnose known input/resource failures before consuming a worker attempt.
    // This source inspection is never reused as a private installation receipt.
    if (plan.manifest.tasks.some((task) => task.dependency_mode === 'npm-ci')) {
        await inspectPrivateDependencyReadinessAsync(canonicalRoot);
    }

    let session = await ensureSession(canonicalRoot);
    let status = await session.client.status(session.health.session_id);
    const existingPlan = status.plan || null;
    const samePlan = Boolean(
        existingPlan &&
        (existingPlan.plan_path || existingPlan.planPath) === plan.relativePath &&
        (existingPlan.plan_sha256 || existingPlan.planSha256) === plan.sha256 &&
        (existingPlan.total_tasks || existingPlan.totalTasks) === plan.manifest.tasks.length &&
        Number(status.plan_revision || status.planRevision || plan.manifest.plan_revision) === plan.manifest.plan_revision
    );
    let adoptedLegacySession = null;
    if (existingPlan && !samePlan) {
        adoptedLegacySession = status.session_id;
        session = await adoptLegacy(canonicalRoot, session.client, status);
        status = await session.client.status(session.health.session_id);
    }

    if (!samePlan || adoptedLegacySession) {
        if (status.plan) {
            throw bootstrapError('DUAL_BOOTSTRAP_SESSION_CONFLICT', 'Active session already contains a different plan');
        }
        await session.client.registerPlan(session.health.session_id, {
            plan_revision: plan.manifest.plan_revision,
            plan_path: plan.relativePath,
            plan_sha256: plan.sha256,
            tasks: plan.manifest.tasks,
            ...(plan.manifest.acceptance_policy !== undefined
                ? { acceptance_policy: plan.manifest.acceptance_policy }
                : {}),
        }, { timeoutMs: 35_000 });
    }
    const resumed = await session.client.resumeSession(session.health.session_id);
    return {
        bootstrapped: true,
        reused: samePlan && !adoptedLegacySession,
        session_id: session.health.session_id,
        state: resumed.state || resumed.session_state || 'EXECUTING',
        plan_revision: plan.manifest.plan_revision,
        total_tasks: plan.manifest.tasks.length,
        setup_status: setupResult ? (setupResult.status || 'SUCCESS') : 'NOT_DECLARED',
        ...(adoptedLegacySession ? { archived_session_id: adoptedLegacySession } : {}),
    };
}

async function handleDualBootstrap(options = {}) {
    try {
        const result = await executeDualBootstrap({
            workspaceRoot: options.cwd || process.cwd(),
            ...(options.workerModel ? { workerModel: options.workerModel } : {}),
        });
        if (options.json) console.log(JSON.stringify(result));
        else {
            console.log(chalk.green('✓ Dual bootstrap hoàn tất với full implementation graph.'));
            console.log(chalk.white(`   Session     : ${chalk.cyan(result.session_id)}`));
            console.log(chalk.white(`   Tasks       : ${chalk.yellow(result.total_tasks)}`));
            console.log(chalk.white(`   State       : ${chalk.cyan(result.state)}`));
        }
    } catch (error) {
        if (options.json) {
            process.exitCode = 1;
            const code = error && error.code ? error.code : 'DUAL_BOOTSTRAP_PLAN_INVALID';
            console.log(JSON.stringify({ bootstrapped: false, error: { code, message: DUAL_ERROR_MESSAGES[code] || 'Dual bootstrap failed' } }));
        } else {
            handleDualError(error);
        }
    }
}

async function handleDualDaemonStart(options = {}) {
    try {
        const rawRoot = options.cwd || process.cwd();
        if (!fs.existsSync(rawRoot)) {
            throw { code: 'DUAL_WORKSPACE_ROOT_INVALID', message: `Thư mục workspace không tồn tại: ${rawRoot}` };
        }
        const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
        const { health } = await ensureDaemonSession(canonicalRoot);

        console.log(chalk.green(`✓ Authority daemon đang chạy:`));
        console.log(chalk.white(`   PID         : ${chalk.yellow(health.pid)}`));
        console.log(chalk.white(`   Workspace   : ${chalk.gray(health.workspace_root)}`));
        console.log(chalk.white(`   Session ID  : ${chalk.cyan(health.session_id || 'chưa khởi tạo')}`));
        if (health.current_baseline) {
            console.log(chalk.white(`   Baseline    : ${chalk.gray(`${health.current_baseline.kind} (${health.current_baseline.id.slice(0, 8)}...)`)}`));
        }
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualDaemonStatus(options = {}) {
    try {
        const rawRoot = options.cwd || process.cwd();
        if (!fs.existsSync(rawRoot)) {
            throw {
                code: 'DUAL_WORKSPACE_ROOT_INVALID',
                message: `Thư mục workspace không tồn tại: ${rawRoot}`,
            };
        }
        const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
        const client = createDaemonClient({ workspaceRoot: canonicalRoot });

        let health;
        try {
            health = await client.health();
        } catch (err) {
            if (
                err.code === 'DUAL_DISCOVERY_MISSING' ||
                err.code === 'DUAL_CLIENT_CONNECTION_REFUSED' ||
                err.code === 'DUAL_CLIENT_TIMEOUT'
            ) {
                throw {
                    code: 'DUAL_DAEMON_NOT_RUNNING',
                    message: 'Authority daemon chưa được khởi chạy hoặc không phản hồi.',
                };
            }
            throw err;
        }

        if (!health || health.status !== 'healthy') {
            throw {
                code: 'DUAL_DAEMON_NOT_RUNNING',
                message: 'Authority daemon chưa được khởi chạy hoặc không phản hồi.',
            };
        }

        console.log(chalk.cyan.bold(`\n📊 Trạng thái Authority Daemon\n`));
        console.log(chalk.white(`   PID         : ${chalk.yellow(health.pid)}`));
        console.log(chalk.white(`   Protocol    : ${chalk.gray(`v${health.protocol_version}`)}`));
        console.log(chalk.white(`   Workspace   : ${chalk.gray(health.workspace_root)}`));

        if (health.session_id) {
            const status = await client.status(health.session_id);
            console.log(chalk.white(`   Session ID  : ${chalk.cyan(status.session_id)}`));
            console.log(chalk.white(`   State       : ${chalk.cyan(status.state)}`));
            const baseStr = status.current_baseline ? `${status.current_baseline.kind} (${status.current_baseline.id.slice(0, 8)}...)` : 'none';
            console.log(chalk.white(`   Baseline    : ${chalk.gray(baseStr)}`));
            console.log(chalk.white(`   Tasks       : ${chalk.yellow(Object.keys(status.tasks || {}).length)}`));
            console.log(chalk.white(`   Leases      : ${chalk.yellow(Object.keys(status.leases || {}).length)}`));
            console.log(chalk.white(`   Gates       : ${chalk.yellow(Object.keys(status.gates || {}).length)}`));
            const verifiedStr = status.receipt ? chalk.green('Đã nghiệm thu (VERIFIED)') : chalk.yellow('Chưa nghiệm thu');
            console.log(chalk.white(`   Verified    : ${verifiedStr}`));
            if (status.blocked) {
                console.log(chalk.red(`   Blocked     : [${status.blocked.blocker_code || 'BLOCKED'}] ${status.blocked.reason || ''}`));
            }
        } else {
            console.log(chalk.white(`   Session ID  : ${chalk.gray('chưa khởi tạo')}`));
            console.log(chalk.white(`   State       : ${chalk.gray('UNINITIALIZED')}`));
        }
        console.log();
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualDaemonStop(options = {}) {
    try {
        const rawRoot = options.cwd || process.cwd();
        if (!fs.existsSync(rawRoot)) {
            throw {
                code: 'DUAL_WORKSPACE_ROOT_INVALID',
                message: `Thư mục workspace không tồn tại: ${rawRoot}`,
            };
        }
        const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
        const client = createDaemonClient({ workspaceRoot: canonicalRoot });

        try {
            await client.health();
        } catch (err) {
            if (
                err.code === 'DUAL_DISCOVERY_MISSING' ||
                err.code === 'DUAL_CLIENT_CONNECTION_REFUSED' ||
                err.code === 'DUAL_CLIENT_TIMEOUT'
            ) {
                console.log(chalk.gray('Authority daemon đã dừng trước đó.'));
                return;
            }
            throw err;
        }

        await waitForDaemonStop(client);

        console.log(chalk.green('✓ Authority daemon đã dừng thành công.'));
    } catch (error) {
        handleDualError(error);
    }
}

function assertRecoveryEligible(canonicalRoot, status) {
    if (!status || !status.session_id || status.state === 'VERIFIED' || status.receipt) {
        const error = new Error('Only a non-verified session without receipt can be recovered');
        error.code = 'DUAL_RECOVERY_UNSAFE';
        throw error;
    }
    const unsettledLeases = Object.values(status.leases || {}).filter((lease) => lease && lease.status !== 'released');
    const tasks = Object.values(status.tasks || {});
    const hasTaskEvidence = tasks.some((task) => !task || !['REGISTERED', 'ROUTED'].includes(task.state));
    if (unsettledLeases.length > 0 || Object.keys(status.gates || {}).length > 0 || hasTaskEvidence) {
        const error = new Error('Session has leases, gates, or task execution evidence');
        error.code = 'DUAL_RECOVERY_UNSAFE';
        throw error;
    }

    const baseline = status.current_baseline;
    if (!baseline || !baseline.kind || !baseline.id) {
        const error = new Error('Session baseline is missing');
        error.code = 'DUAL_RECOVERY_UNSAFE';
        throw error;
    }
    let pristine = false;
    if (baseline.kind === 'snapshot') {
        const { baseline: snapshotBaseline } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
        pristine = snapshotBaseline.capture().identity.id === baseline.id;
    } else if (baseline.kind === 'git') {
        const gitBaseline = createGitBaseline({ root: canonicalRoot });
        const current = gitBaseline.capture();
        pristine = current.id === baseline.id && gitBaseline.diff(baseline).length === 0;
    }
    if (!pristine) {
        const error = new Error('Workspace no longer matches the authority baseline');
        error.code = 'DUAL_RECOVERY_UNSAFE';
        throw error;
    }
}

async function handleDualDaemonRecover(options = {}) {
    let canonicalRoot;
    let archivePath = null;
    let authorityDir = null;
    try {
        if (options.ifPristine !== true) {
            const error = new Error('Recovery requires --if-pristine');
            error.code = 'DUAL_RECOVERY_UNSAFE';
            throw error;
        }
        const rawRoot = options.cwd || process.cwd();
        if (!fs.existsSync(rawRoot)) {
            throw { code: 'DUAL_WORKSPACE_ROOT_INVALID', message: 'Workspace does not exist' };
        }
        canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
        const client = createDaemonClient({ workspaceRoot: canonicalRoot });
        const health = await client.health();
        if (!health || health.status !== 'healthy' || !health.session_id) {
            const error = new Error('Active initialized daemon session is required');
            error.code = 'DUAL_DAEMON_NOT_RUNNING';
            throw error;
        }
        const status = await client.status(health.session_id);
        assertRecoveryEligible(canonicalRoot, status);

        const safeSessionId = String(status.session_id);
        if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(safeSessionId)) {
            const error = new Error('Session ID is not safe for archival');
            error.code = 'DUAL_RECOVERY_UNSAFE';
            throw error;
        }
        const runsRoot = path.join(canonicalRoot, '.omni', 'runs');
        authorityDir = path.join(runsRoot, 'dual-authority');
        const historyRoot = path.join(runsRoot, 'dual-history');
        archivePath = path.join(historyRoot, safeSessionId);
        if (fs.existsSync(archivePath)) {
            const error = new Error('Session archive already exists');
            error.code = 'DUAL_RECOVERY_ARCHIVE_EXISTS';
            throw error;
        }

        await waitForDaemonStop(client);
        fs.mkdirSync(historyRoot, { recursive: true });
        fs.renameSync(authorityDir, archivePath);

        let fresh;
        try {
            fresh = await ensureDaemonSession(canonicalRoot);
        } catch (cause) {
            try {
                const failedDir = path.join(historyRoot, `recovery-failed-${crypto.randomUUID()}`);
                if (fs.existsSync(authorityDir)) fs.renameSync(authorityDir, failedDir);
                if (!fs.existsSync(authorityDir) && fs.existsSync(archivePath)) fs.renameSync(archivePath, authorityDir);
            } catch {
                // Both ledgers remain under .omni/runs for manual recovery.
            }
            const error = new Error('Unable to initialize fresh authority after archival', { cause });
            error.code = 'DUAL_RECOVERY_FAILED';
            throw error;
        }

        const payload = {
            recovered: true,
            archived_session_id: safeSessionId,
            session_id: fresh.health.session_id,
            state: fresh.health.session_state || 'DISCOVERED',
        };
        if (options.json) console.log(JSON.stringify(payload));
        else {
            console.log(chalk.green('✓ Authority session mồ côi đã được archive và khởi tạo lại.'));
            console.log(chalk.white(`   Archived    : ${chalk.gray(safeSessionId)}`));
            console.log(chalk.white(`   Session mới : ${chalk.cyan(payload.session_id)}`));
        }
    } catch (error) {
        if (options.json) {
            process.exitCode = 1;
            const code = error && error.code ? error.code : 'DUAL_RECOVERY_FAILED';
            console.log(JSON.stringify({ recovered: false, error: { code, message: DUAL_ERROR_MESSAGES[code] || 'Recovery failed' } }));
        } else {
            handleDualError(error);
        }
    }
}

function isCommittedPathIgnored(posixPath) {
    const segments = posixPath.split('/');
    for (let i = 0; i < segments.length - 1; i++) {
        if (segments[i] === 'node_modules' || segments[i] === '.git') {
            return true;
        }
    }
    if (segments[0] === 'node_modules' || segments[0] === '.git') {
        return true;
    }
    if (
        posixPath === '.omni/runtime' ||
        posixPath.startsWith('.omni/runtime/') ||
        posixPath === '.omni/runs' ||
        posixPath.startsWith('.omni/runs/')
    ) {
        return true;
    }
    if (CANONICAL_CONTROL_PLANE_EXCLUDES.some((prefix) => posixPath === prefix || posixPath.startsWith(`${prefix}/`))) {
        return true;
    }
    const fileName = segments[segments.length - 1];
    if (isDefaultIgnoredFile(fileName)) {
        return true;
    }
    return false;
}

const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function handleDualBaselinePromote(options = {}) {
    try {
        const rawRoot = options.cwd || process.cwd();
        if (!fs.existsSync(rawRoot)) {
            throw {
                code: 'DUAL_WORKSPACE_ROOT_INVALID',
                message: `Thư mục workspace không tồn tại: ${rawRoot}`,
            };
        }
        const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
        const authorityDir = path.join(canonicalRoot, '.omni', 'runs', 'dual-authority');
        const client = createDaemonClient({ workspaceRoot: canonicalRoot });

        // 1. Check active running daemon (or handle idempotent promotion if daemon was stopped)
        let health;
        try {
            health = await client.health();
        } catch (err) {
            // Check if baseline was already promoted to Git HEAD on disk before failing
            const eventsPath = path.join(authorityDir, 'events.ndjson');
            if (fs.existsSync(eventsPath)) {
                try {
                    const store = createAuthorityStore(authorityDir);
                    const derived = store.derive();
                    if (derived && derived.currentBaseline && derived.currentBaseline.kind === 'git') {
                        const head = String(execGit(['rev-parse', 'HEAD'], { cwd: canonicalRoot })).trim();
                        if (derived.currentBaseline.id === head) {
                            console.log(chalk.green(`✓ Baseline đã được promote trước đó tới Git HEAD (${head.slice(0, 8)}...) - Idempotent`));
                            return;
                        }
                        throw {
                            code: 'DUAL_PROMOTION_CONFLICT',
                            message: `Current Git baseline (${derived.currentBaseline.id}) conflicts with HEAD (${head})`,
                        };
                    }
                } catch (e) {
                    if (e && e.code === 'DUAL_PROMOTION_CONFLICT') throw e;
                }
            }

            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: `Authority daemon must be running for baseline promotion: ${err.message}`,
            };
        }

        if (!health || health.status !== 'healthy' || !health.session_id) {
            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: 'Active initialized daemon session is required for baseline promotion.',
            };
        }

        // 2. Query session status
        const status = await client.status(health.session_id);

        // Check if already promoted in active session
        if (status.current_baseline && status.current_baseline.kind === 'git') {
            let head;
            try {
                head = String(execGit(['rev-parse', 'HEAD'], { cwd: canonicalRoot })).trim();
            } catch {
                throw {
                    code: 'DUAL_PROMOTION_GIT_HEAD_MISSING',
                    message: 'Git repository has no HEAD commit.',
                };
            }
            if (status.current_baseline.id === head) {
                console.log(chalk.green(`✓ Baseline đã được promote trước đó tới Git HEAD (${head.slice(0, 8)}...) - Idempotent`));
                return;
            }
            throw {
                code: 'DUAL_PROMOTION_CONFLICT',
                message: `Current Git baseline (${status.current_baseline.id}) conflicts with HEAD (${head})`,
            };
        }

        // 3. Verify session state is VERIFIED
        if (status.state !== 'VERIFIED') {
            throw {
                code: 'DUAL_PROMOTION_NOT_VERIFIED',
                message: `Session state must be VERIFIED, got: ${status.state}`,
                details: { sessionState: status.state },
            };
        }
        const preStopState = status.state;
        const preStopSessionId = status.session_id;

        // 4. Current baseline kind must be snapshot
        if (!status.current_baseline || status.current_baseline.kind !== 'snapshot' || !status.current_baseline.id) {
            throw {
                code: 'DUAL_PROMOTION_BASELINE_NOT_SNAPSHOT',
                message: `Current baseline kind must be snapshot, got: ${status.current_baseline ? status.current_baseline.kind : 'none'}`,
            };
        }
        const preStopBaseline = status.current_baseline;

        // 5. Receipt must exist
        if (!status.receipt || !status.receipt.receipt_sha256) {
            throw {
                code: 'DUAL_PROMOTION_RECEIPT_MISSING',
                message: 'Session is missing verified completion receipt.',
            };
        }
        const receiptSha256 = status.receipt.receipt_sha256;

        // 6. Strict accepted-snapshot.json validation
        const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
        if (!fs.existsSync(acceptedPath)) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_MISSING',
                message: `Accepted snapshot file missing at ${acceptedPath}`,
            };
        }

        let rawAccepted;
        try {
            rawAccepted = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
        } catch (err) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: `Accepted snapshot JSON is corrupt: ${err.message}`,
            };
        }

        if (!rawAccepted || typeof rawAccepted !== 'object' || Array.isArray(rawAccepted)) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: 'Accepted snapshot must be a JSON object',
            };
        }

        const requiredKeys = ['schema_version', 'session_id', 'identity', 'manifest', 'receipt_sha256'];
        const actualKeys = Object.keys(rawAccepted);
        if (actualKeys.length !== requiredKeys.length || !requiredKeys.every((k) => actualKeys.includes(k))) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: `Accepted snapshot must contain exactly keys: ${requiredKeys.join(', ')}`,
            };
        }

        if (rawAccepted.schema_version !== 1) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: `Accepted snapshot schema_version must be 1, got ${rawAccepted.schema_version}`,
            };
        }

        if (rawAccepted.session_id !== preStopSessionId) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: `Accepted snapshot session_id does not match active session`,
            };
        }

        if (rawAccepted.receipt_sha256 !== receiptSha256) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: 'Accepted snapshot receipt_sha256 does not match session receipt',
            };
        }

        // 7. Validate accepted manifest/identity using snapshot adapter
        const acceptedIdentity = rawAccepted.identity;
        const acceptedManifest = rawAccepted.manifest;
        if (!acceptedIdentity || acceptedIdentity.kind !== 'snapshot' || typeof acceptedIdentity.id !== 'string') {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: 'Accepted snapshot identity must be a valid snapshot identity',
            };
        }

        const expectedManifestRootHash = computeSnapshotRootHash(acceptedManifest.files || []);
        if (expectedManifestRootHash !== acceptedIdentity.id) {
            throw {
                code: 'DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID',
                message: 'Accepted snapshot manifest files hash does not match identity id',
            };
        }

        const { baseline: snapshotBaseline } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
        const wsDiff = snapshotBaseline.diff(acceptedIdentity, acceptedManifest);
        if (wsDiff.length > 0) {
            throw {
                code: 'DUAL_PROMOTION_WORKSPACE_DIRTY',
                message: `Current workspace differs from accepted snapshot (${wsDiff.length} files changed)`,
                details: { diff: wsDiff },
            };
        }

        // 8. Check user-created Git repository with HEAD
        let rawTopLevel;
        try {
            rawTopLevel = execGit(['rev-parse', '--show-toplevel'], { cwd: canonicalRoot });
        } catch {
            throw {
                code: 'DUAL_PROMOTION_GIT_MISSING',
                message: 'Current directory is not inside a user-created Git repository.',
            };
        }
        const topLevel = String(rawTopLevel || '').trim();
        if (!topLevel) {
            throw {
                code: 'DUAL_PROMOTION_GIT_MISSING',
                message: 'Current directory is not inside a user-created Git repository.',
            };
        }

        let canonicalTopLevel;
        try {
            canonicalTopLevel = fs.realpathSync.native ? fs.realpathSync.native(topLevel) : fs.realpathSync(topLevel);
        } catch {
            canonicalTopLevel = path.resolve(topLevel);
        }
        if (canonicalTopLevel !== canonicalRoot) {
            throw {
                code: 'DUAL_PROMOTION_GIT_MISSING',
                message: `Git repository top-level (${canonicalTopLevel}) does not match workspace root (${canonicalRoot})`,
            };
        }

        let head;
        try {
            head = String(execGit(['rev-parse', 'HEAD'], { cwd: canonicalRoot })).trim();
        } catch {
            throw {
                code: 'DUAL_PROMOTION_GIT_HEAD_MISSING',
                message: 'Git repository has no HEAD commit.',
            };
        }
        if (!head || !GIT_OBJECT_PATTERN.test(head)) {
            throw {
                code: 'DUAL_PROMOTION_GIT_HEAD_MISSING',
                message: `Invalid Git HEAD commit hash: ${head}`,
            };
        }

        // 9. Prove committed HEAD tree exactly corresponds to accepted snapshot
        const rawLsTree = execGit(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: canonicalRoot, encoding: null });
        const treeBuffer = Buffer.isBuffer(rawLsTree) ? rawLsTree : Buffer.from(rawLsTree || '');

        const committedFiles = [];
        let start = 0;
        for (let i = 0; i <= treeBuffer.length; i++) {
            if (i === treeBuffer.length || treeBuffer[i] === 0) {
                if (i > start) {
                    const chunk = treeBuffer.subarray(start, i);
                    const tabIdx = chunk.indexOf(0x09);
                    if (tabIdx === -1) {
                        throw {
                            code: 'DUAL_PROMOTION_TREE_MISMATCH',
                            message: 'Malformed git ls-tree output',
                        };
                    }
                    const metaStr = chunk.subarray(0, tabIdx).toString('utf8');
                    const pathStr = chunk.subarray(tabIdx + 1).toString('utf8');
                    const metaParts = metaStr.split(/\s+/);
                    if (metaParts.length < 3) {
                        throw {
                            code: 'DUAL_PROMOTION_TREE_MISMATCH',
                            message: 'Malformed git ls-tree metadata entry',
                        };
                    }
                    const [mode, type, objectHash] = metaParts;

                    const posixPath = pathStr.replace(/\\/g, '/');
                    if (isCommittedPathIgnored(posixPath)) {
                        // Skip ignored runtime/temp/dependency paths
                    } else {
                        if (mode === '120000') {
                            throw {
                                code: 'DUAL_PROMOTION_SYMLINK_REJECTED',
                                message: `Symlinks in git tree are rejected for P0 baseline promotion: ${pathStr}`,
                            };
                        }
                        if (mode === '160000' || type === 'commit') {
                            throw {
                                code: 'DUAL_PROMOTION_SYMLINK_REJECTED',
                                message: `Submodules in git tree are rejected for P0 baseline promotion: ${pathStr}`,
                            };
                        }
                        if (type !== 'blob') {
                            throw {
                                code: 'DUAL_PROMOTION_TREE_MISMATCH',
                                message: `Non-blob object in git tree: ${pathStr} (${type})`,
                            };
                        }

                        const blobBytes = execGit(['cat-file', 'blob', objectHash], { cwd: canonicalRoot, encoding: null });
                        const blobBuf = Buffer.isBuffer(blobBytes) ? blobBytes : Buffer.from(blobBytes || '');
                        const hash = crypto.createHash('sha256').update(blobBuf).digest('hex');
                        committedFiles.push({
                            path: posixPath,
                            type: 'file',
                            size: blobBuf.length,
                            hash,
                            sha256: hash,
                        });
                    }
                }
                start = i + 1;
            }
        }

        const acceptedMap = new Map((acceptedManifest.files || []).map((f) => [f.path, f]));
        const committedMap = new Map(committedFiles.map((f) => [f.path, f]));

        for (const [p, accFile] of acceptedMap.entries()) {
            if (!committedMap.has(p)) {
                throw {
                    code: 'DUAL_PROMOTION_UNTRACKED_ACCEPTED_FILE',
                    message: `Accepted file is not committed in Git HEAD: ${p}`,
                    details: { path: p },
                };
            }
            const comFile = committedMap.get(p);
            if (comFile.size !== accFile.size || comFile.hash !== (accFile.hash || accFile.sha256)) {
                throw {
                    code: 'DUAL_PROMOTION_TREE_MISMATCH',
                    message: `Committed file ${p} content/size does not match accepted snapshot`,
                    details: { path: p, acceptedHash: accFile.hash, committedHash: comFile.hash },
                };
            }
        }

        for (const [p] of committedMap.entries()) {
            if (!acceptedMap.has(p)) {
                throw {
                    code: 'DUAL_PROMOTION_TREE_MISMATCH',
                    message: `Committed Git HEAD contains extra file not in accepted snapshot: ${p}`,
                    details: { path: p },
                };
            }
        }

        const committedRootHash = computeSnapshotRootHash(committedFiles);
        if (committedRootHash !== acceptedIdentity.id) {
            throw {
                code: 'DUAL_PROMOTION_TREE_MISMATCH',
                message: `Committed Git HEAD tree hash (${committedRootHash}) does not match accepted snapshot (${acceptedIdentity.id})`,
            };
        }

        // 10. Verification succeeded! Authenticate-stop daemon
        try {
            await client.stop();
        } catch (err) {
            throw {
                code: 'DUAL_PROMOTION_STOP_FAILED',
                message: `Failed to stop daemon prior to ledger append: ${err.message}`,
            };
        }

        let stopped = false;
        const stopDeadline = Date.now() + 5000;
        while (Date.now() <= stopDeadline) {
            try {
                await client.health({ timeoutMs: 100 });
                await new Promise((r) => setTimeout(r, 50));
            } catch (err) {
                if (
                    err.code === 'DUAL_DISCOVERY_MISSING' ||
                    err.code === 'DUAL_CLIENT_CONNECTION_REFUSED'
                ) {
                    stopped = true;
                    break;
                }
                await new Promise((r) => setTimeout(r, 50));
            }
        }

        if (!stopped) {
            throw {
                code: 'DUAL_PROMOTION_STOP_FAILED',
                message: 'Authority daemon failed to stop within 5000ms before baseline promotion.',
            };
        }

        // 11. Re-derive from store and append baseline.promoted event
        const store = createAuthorityStore(authorityDir);
        const integrity = store.verifyIntegrity();
        if (!integrity.valid) {
            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: 'Authority store integrity invalid',
            };
        }

        const derived = store.derive();

        if (derived.currentBaseline && derived.currentBaseline.kind === 'git') {
            if (derived.currentBaseline.id === head) {
                console.log(chalk.green(`✓ Baseline đã được promote trước đó tới Git HEAD (${head.slice(0, 8)}...) - Idempotent`));
                return;
            }
            throw {
                code: 'DUAL_PROMOTION_CONFLICT',
                message: `Current Git baseline (${derived.currentBaseline.id}) conflicts with HEAD (${head})`,
            };
        }

        if (derived.sessionId !== preStopSessionId || derived.sessionId !== rawAccepted.session_id) {
            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: `Derived session ID (${derived.sessionId}) does not match pre-stop session (${preStopSessionId})`,
            };
        }

        if (derived.sessionState !== 'VERIFIED') {
            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: `Derived session state must be VERIFIED, got: ${derived.sessionState}`,
            };
        }

        if (!derived.receipt || derived.receipt.receipt_sha256 !== receiptSha256 || derived.receipt.receipt_sha256 !== rawAccepted.receipt_sha256) {
            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: 'Derived receipt hash does not match pre-stop receipt or accepted snapshot',
            };
        }

        if (
            !derived.currentBaseline ||
            derived.currentBaseline.kind !== preStopBaseline.kind ||
            derived.currentBaseline.id !== preStopBaseline.id
        ) {
            throw {
                code: 'DUAL_PROMOTION_BLOCKED',
                message: `Derived baseline (${derived.currentBaseline ? `${derived.currentBaseline.kind}:${derived.currentBaseline.id}` : 'none'}) does not match pre-stop baseline (${preStopBaseline.kind}:${preStopBaseline.id})`,
            };
        }

        if (derived.currentBaseline.kind !== 'snapshot') {
            throw {
                code: 'DUAL_PROMOTION_BASELINE_NOT_SNAPSHOT',
                message: `Derived authority baseline must be snapshot, got: ${derived.currentBaseline.kind}`,
            };
        }

        store.append({
            schema_version: 2,
            type: 'baseline.promoted',
            from_baseline: derived.currentBaseline,
            to_baseline: { kind: 'git', id: head },
        });

        console.log(chalk.green(`✓ Đã promote baseline thành công sang Git HEAD: ${chalk.bold(head.slice(0, 8))}`));
    } catch (error) {
        handleDualError(error);
    }
}

async function handleDualSetupRun(options = {}) {
    try {
        const result = executeSetupManifest({
            workspaceRoot: options.cwd || process.cwd(),
            dryRun: Boolean(options.dryRun),
            force: Boolean(options.force),
            json: Boolean(options.json),
        });

        if (options.json) {
            console.log(JSON.stringify(result));
            return;
        }

        if (Array.isArray(result.repaired_actions) && result.repaired_actions.length > 0) {
            const repaired = result.repaired_actions
                .map((action) => `#${action.index} ${action.from_kind}→${action.to_kind}:${action.program}`)
                .join(', ');
            console.log(chalk.yellow(`↻ Setup manifest đã được self-heal an toàn (${repaired})`));
        }

        if (result.dryRun) {
            console.log(chalk.green(`✓ Setup dry-run hoàn tất (${result.action_count} actions đã được validate & resolve)`));
            console.log(chalk.white(`   Workspace : ${chalk.gray(result.workspace_root)}`));
            console.log(chalk.white(`   Actions   : ${chalk.yellow(result.action_count)}`));
            return;
        }

        if (result.reused) {
            console.log(chalk.green(`✓ Setup đã hoàn tất trước đó (tái sử dụng receipt - idempotent, ${result.action_count} actions)`));
            console.log(chalk.white(`   Workspace : ${chalk.gray(result.workspace_root)}`));
            console.log(chalk.white(`   Manifest  : ${chalk.gray(result.manifest_sha256.slice(0, 16))}...`));
            return;
        }

        console.log(chalk.green(`✓ Setup hoàn tất thành công (${result.action_count} actions)`));
        console.log(chalk.white(`   Workspace : ${chalk.gray(result.workspace_root)}`));
        console.log(chalk.white(`   Manifest  : ${chalk.gray(result.manifest_sha256.slice(0, 16))}...`));
        console.log(chalk.white(`   Actions   : ${chalk.yellow(result.action_count)}`));
    } catch (error) {
        if (options.json) {
            process.exitCode = 1;
            const code = error.code || 'DUAL_SETUP_ERROR';
            const safePayload = {
                ok: false,
                code,
                message: error.message || 'Setup execution failed',
            };
            if (typeof error.failedIndex === 'number') {
                safePayload.failedIndex = error.failedIndex;
            }
            if (error.failedAction && typeof error.failedAction === 'object') {
                safePayload.failedAction = {
                    index: typeof error.failedAction.index === 'number' ? error.failedAction.index : error.failedIndex,
                    program: error.failedAction.program,
                    kind: error.failedAction.kind,
                    status: error.failedAction.status,
                };
            }
            console.log(JSON.stringify(safePayload));
            return;
        }
        handleDualError(error);
    }
}

async function handleDualQc(taskIdArg, options = {}) {
    const jsonMode = Boolean(options.json || (typeof taskIdArg === 'object' && taskIdArg.json));
    const rawTaskId = typeof taskIdArg === 'string' ? taskIdArg.trim() : undefined;
    const rawRoot = options.cwd || process.cwd();

    try {
        if (!fs.existsSync(rawRoot)) {
            throw {
                code: 'DUAL_WORKSPACE_ROOT_INVALID',
                message: `Thư mục workspace không tồn tại: ${rawRoot}`,
            };
        }
        const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(rawRoot) : fs.realpathSync(rawRoot);
        const client = options.client || createDaemonClient({ workspaceRoot: canonicalRoot, timeoutMs: 10000 });

        let health;
        try {
            health = await client.health();
        } catch (err) {
            throw {
                code: 'DUAL_DAEMON_NOT_RUNNING',
                message: 'Authority daemon chưa được khởi chạy hoặc không phản hồi.',
            };
        }

        if (!health || health.status !== 'healthy' || !health.session_id) {
            throw {
                code: 'DUAL_SESSION_NOT_ACTIVE',
                message: 'Không tìm thấy phiên làm việc Dual nào đang active.',
            };
        }

        const sessionId = health.session_id;
        let status = await client.status(sessionId);

        if (!status || !status.tasks) {
            throw {
                code: 'DUAL_NO_TASKS_REGISTERED',
                message: 'Chưa có task nào được đăng ký trong session hiện tại.',
            };
        }

        // 1. Determine task to verify
        const tasks = status.tasks;
        let targetTaskId = rawTaskId;
        if (!targetTaskId) {
            const unverifiedTask = Object.values(tasks).find((t) => t.state !== 'TASK_VERIFIED');
            if (unverifiedTask) {
                targetTaskId = unverifiedTask.task_id;
            } else {
                targetTaskId = Object.keys(tasks)[0];
            }
        }

        const targetTask = tasks[targetTaskId];
        if (!targetTask) {
            throw {
                code: 'DUAL_TASK_NOT_FOUND',
                message: `Không tìm thấy task '${targetTaskId}' trong phiên làm việc.`,
            };
        }

        if (targetTask.execution_mode === 'isolated') {
            let isolatedResult;
            if (targetTask.state !== 'TASK_VERIFIED') {
                if (options.reviewEvidence && options.reviewSubmission) {
                    throw { code: 'DUAL_CONTRACT_INVALID', message: 'Use only one of --review-submission or --review-evidence' };
                }
                const submissionPath = options.reviewSubmission || options.reviewEvidence;
                if (submissionPath) {
                    const reviewSubmission = parseJsonFileForDual(submissionPath, 'Review submission');
                    await client.submitAcceptanceReview(sessionId, targetTaskId, status.plan_revision, reviewSubmission);
                }
                isolatedResult = await client.completeIsolatedTask(sessionId, targetTaskId, status.plan_revision);
                if (isolatedResult.status !== 'TASK_VERIFIED') {
                    if (jsonMode) console.log(JSON.stringify({ ok: false, ...isolatedResult }));
                    else console.log(`Isolated QC: ${targetTaskId} — ${isolatedResult.status}`);
                    process.exitCode = 1;
                    return;
                }
            }

            const updatedStatus = await client.status(sessionId);
            const remaining = Object.values(updatedStatus.tasks || {}).filter((t) => t.state !== 'TASK_VERIFIED');
            if (rawTaskId || remaining.length > 0) {
                if (isolatedResult) {
                    if (jsonMode) console.log(JSON.stringify({ ok: true, ...isolatedResult }));
                    else {
                        console.log(`Isolated QC: ${targetTaskId} — ${isolatedResult.status}`);
                        console.log('Task QC/integration is separate from session quality gates; session is not release-qualified.');
                    }
                } else {
                    if (jsonMode) console.log(JSON.stringify({ ok: true, status: targetTask.state, task_id: targetTaskId }));
                    else console.log(`Task ${targetTaskId} is already ${targetTask.state}.`);
                }
                return;
            }
            status = updatedStatus;
        }

        // 2. Measure workspace diff fingerprint and modified files
        let diffFingerprint;
        let modifiedFiles = [];
        const authorityDir = path.join(canonicalRoot, '.omni', 'runs', 'dual-authority');

        if (status.current_baseline && status.current_baseline.kind === 'snapshot') {
            const initialSnapshot = readInitialSnapshot({
                authorityDir,
                sessionId,
                workspaceId: status.workspace_id,
                workspaceRoot: canonicalRoot,
            });
            const { baseline, excludedPaths } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
            const fp = baseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths });
            diffFingerprint = fp.patchSha256;
            modifiedFiles = fp.files;
        } else {
            const diffInfo = captureDiffFingerprint({
                repoRoot: canonicalRoot,
                baseCommit: status.current_baseline ? status.current_baseline.id : undefined,
                excludedPaths: ['.omni'],
            });
            diffFingerprint = diffInfo.patchSha256;
            modifiedFiles = diffInfo.files;
        }

        function resolveCmdBinary(program) {
            if (process.platform === 'win32') {
                if (program === 'npm') return 'npm.cmd';
                if (program === 'npx') return 'npx.cmd';
                if (program === 'pnpm') return 'pnpm.cmd';
                if (program === 'yarn') return 'yarn.cmd';
                if (program === 'bun') return 'bun.cmd';
            }
            return program;
        }

        // 3. If task is not yet TASK_VERIFIED, execute validation commands and submit qc_evidence
        const commandOutputs = [];
        if (status.tasks?.[targetTaskId]?.state !== 'TASK_VERIFIED') {
            const valCommands = Array.isArray(targetTask.validation_commands) && targetTask.validation_commands.length > 0
                ? targetTask.validation_commands
                : [{ program: 'npm', args: ['test'], cwd: '.' }];

            for (const cmd of valCommands) {
                const startTime = Date.now();
                const cmdCwd = path.resolve(canonicalRoot, cmd.cwd || '.');
                const cmdArgs = cmd.args || [];
                const fullCmdStr = `${cmd.program} ${cmdArgs.join(' ')}`.trim();
                const proc = runBoundedCommand({ program: cmd.program, args: cmdArgs }, { cwd: cmdCwd });
                const duration_ms = Math.max(1, Date.now() - startTime);
                const exitCode = proc.exit_code;
                commandOutputs.push({
                    command: fullCmdStr,
                    duration_ms,
                    exit_code: exitCode,
                    output: (proc.output || (exitCode === 0 ? 'PASS' : proc.error || 'FAIL')).slice(0, 1000),
                });

                if (exitCode !== 0) {
                    throw {
                        code: 'DUAL_QC_VALIDATION_FAILED',
                        message: `Validation command '${fullCmdStr}' failed (${proc.failure || 'nonzero'}, exit code ${exitCode}):\n${proc.output || proc.error || ''}`,
                    };
                }
            }

            // Submit task QC evidence
            const qcResult = await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: targetTaskId,
                    plan_revision: status.plan_revision || 1,
                    verdict: 'SUCCESS',
                    diff_fingerprint: diffFingerprint,
                    modified_files: modifiedFiles,
                    command_outputs: commandOutputs,
                    findings: [],
                },
            });

            if (qcResult.error) {
                throw {
                    code: 'DUAL_QC_SUBMISSION_FAILED',
                    message: qcResult.error.message || 'Failed to submit task QC evidence',
                };
            }
        }

        // 4. Submit exactly three real quality cycles. Every cycle executes its
        // registered commands afresh; no output is copied into a later cycle.
        const registeredCommands = Object.values(status.tasks || {})
            .flatMap((task) => Array.isArray(task.validation_commands) ? task.validation_commands : []);
        const qualityPlanBuilder = options.buildQualityPlan || buildQualityPlan;
        const qualityPlan = qualityPlanBuilder(canonicalRoot, fs, { validationCommands: registeredCommands });
        const acceptancePolicy = status.plan?.acceptance_policy || status.plan?.acceptancePolicy;
        if (!acceptancePolicy) {
            throw { code: 'DUAL_UI_POLICY_REQUIRED', message: 'Session has no persisted acceptance policy; create a new run with explicit UI policy before qualification' };
        }
        const uiPolicy = acceptancePolicy.ui || {
            required: false,
            viewport_widths: [390, 768, 1024, 1440],
            reduced_motion_required: true,
        };
        const hasUiModifiedFiles = Array.isArray(modifiedFiles) && modifiedFiles.some((f) => {
            const ext = path.extname(f).toLowerCase();
            return ['.html', '.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.vue', '.svelte'].includes(ext);
        });
        const visualQaEvaluator = options.evaluateAdaptiveVisualQa || evaluateAdaptiveVisualQa;
        let visualQa = null;
        if (uiPolicy.required || hasUiModifiedFiles || options.browserAdapter) {
            visualQa = await visualQaEvaluator({
                workspaceRoot: canonicalRoot,
                viewports: uiPolicy.viewport_widths,
                policySha256: hashAcceptancePolicy(acceptancePolicy),
                sourceFingerprint: diffFingerprint,
                headlessRunner: options.browserAdapter || null,
                mcpClient: options.mcpClient || null,
            });
        }
        if (visualQa && visualQa.evidence) {
            const uiRequirement = {
                gate_id: 'responsive_visual_qa',
                required: uiPolicy.required,
                viewport_widths: [...uiPolicy.viewport_widths],
                reduced_motion_required: uiPolicy.reduced_motion_required,
            };
            const uiResult = await client.evaluateCompletion(sessionId, {
                ui_evidence: { requirement: uiRequirement, evidence: visualQa.evidence },
            });
            if (uiResult?.error) throw { code: 'DUAL_UI_GATE_SUBMISSION_FAILED', message: uiResult.error.message || 'Failed to submit UI evidence' };
        }
        let latestStatus = await client.status(sessionId);
        const registeredTaskIds = Object.keys(latestStatus.tasks || {});
        const completedTaskIds = registeredTaskIds.filter((id) => latestStatus.tasks[id]?.state === 'TASK_VERIFIED');
        if (completedTaskIds.length !== registeredTaskIds.length) {
            throw { code: 'DUAL_QC_UNVERIFIED_TASK', message: `Quality checks require every registered task to be TASK_VERIFIED; verified ${completedTaskIds.length}/${registeredTaskIds.length}` };
        }
        const totalTasks = registeredTaskIds.length;
        const planRevision = latestStatus.plan_revision || status.plan_revision || 1;
        const initialFingerprint = diffFingerprint;
        for (let c = 1; c <= 3; c++) {
            const priorCycle = latestStatus.gates && latestStatus.gates[`quality-cycle-${c}`];
            if (priorCycle?.status === 'PASSED') {
                const priorProvenance = priorCycle.details?.provenance;
                if (!priorProvenance
                    || priorProvenance.input_fingerprint !== initialFingerprint
                    || priorProvenance.mode !== 'fresh') {
                    throw { code: 'DUAL_QC_REUSE_UNAUTHORIZED', message: `Quality cycle ${c} is already PASSED without matching input identity/provenance` };
                }
                continue;
            }
            const attempt = priorCycle?.details?.attempt ? priorCycle.details.attempt + 1 : 1;
            if (attempt > 3) throw { code: 'DUAL_QC_ATTEMPT_EXHAUSTED', message: `Quality cycle ${c} has exhausted its three attempts` };
            let cycleFingerprint;
            if (latestStatus.current_baseline && latestStatus.current_baseline.kind === 'snapshot') {
                const initialSnapshot = readInitialSnapshot({ authorityDir, sessionId, workspaceId: latestStatus.workspace_id, workspaceRoot: canonicalRoot });
                const { baseline: snapBaseline, excludedPaths } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
                cycleFingerprint = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths }).patchSha256;
            } else {
                cycleFingerprint = captureDiffFingerprint({ repoRoot: canonicalRoot, baseCommit: latestStatus.current_baseline ? latestStatus.current_baseline.id : undefined, excludedPaths: ['.omni'] }).patchSha256;
            }
            if (cycleFingerprint !== initialFingerprint) throw { code: 'DUAL_QC_SOURCE_DRIFT', message: `Source diff fingerprint changed during quality cycle ${c}: ${initialFingerprint} -> ${cycleFingerprint}` };
            if (typeof client.executeQualityCycle === 'function') {
                const daemonExecution = await client.executeQualityCycle(sessionId, c);
                const daemonEvidence = daemonExecution?.quality_evidence;
                if (!daemonEvidence || daemonEvidence.cycle_index !== c
                    || daemonEvidence.attempt !== attempt
                    || daemonEvidence.plan_revision !== planRevision
                    || daemonEvidence.diff_fingerprint !== cycleFingerprint
                    || daemonEvidence.provenance?.input_fingerprint !== cycleFingerprint
                    || daemonEvidence.provenance?.mode !== 'fresh') {
                    throw { code: 'DUAL_QUALITY_ATTESTATION_INVALID', message: `Daemon-owned quality execution returned invalid identity for cycle ${c}` };
                }
                const qualityResult = await client.evaluateCompletion(sessionId, { quality_evidence: daemonEvidence });
                if (qualityResult?.error) throw { code: 'DUAL_QC_QUALITY_FAILED', message: qualityResult.error.message || `Quality cycle ${c} failed` };
                if (daemonEvidence.commands.some((result) => result.exit_code !== 0)
                    || daemonEvidence.gate_results.some((gate) => gate.required && gate.status !== 'PASSED')) {
                    throw { code: 'DUAL_QC_QUALITY_FAILED', message: `Quality cycle ${c} has one or more blocking command failures` };
                }
                latestStatus = await client.status(sessionId);
                continue;
            }
            const policySha256 = hashAcceptancePolicy(acceptancePolicy);
            const executionIdentityBuilder = options.deriveQualityExecutionId || deriveQualityExecutionId;
            const executionId = executionIdentityBuilder({
                workspaceRoot: canonicalRoot,
                sessionId,
                workspaceId: latestStatus.workspace_id,
                baseline: latestStatus.current_baseline,
                planRevision,
                policySha256,
                diffFingerprint: cycleFingerprint,
                cycleIndex: c,
                attempt,
                totalTasks,
                completedTaskIds,
                commandPlan: qualityPlan.commands,
            });
            let executionArtifact;
            let qualityCommandOutputs;
            let cycleGateResults;
            let runResults;
            const artifactReader = options.readQualityExecutionArtifact || readQualityExecutionArtifact;
            try {
                executionArtifact = artifactReader({ authorityDir, executionId });
                runResults = executionArtifact.artifact.commands.map((command) => ({
                    ...command,
                    ok: command.exit_code === 0 && command.failure === null && command.signal === null,
                }));
                qualityCommandOutputs = runResults.map(({ command, duration_ms, exit_code }) => ({ command, duration_ms, exit_code }));
                cycleGateResults = executionArtifact.artifact.gate_results.map((gate) => ({ ...gate }));
            } catch (artifactError) {
                if (artifactError?.code !== 'DUAL_QUALITY_ARTIFACT_MISSING') throw artifactError;
                const qualityPlanExecutor = options.executeQualityPlan || executeQualityPlan;
                const cycleStartedAt = new Date().toISOString();
                runResults = qualityPlanExecutor(qualityPlan, { workspaceRoot: canonicalRoot, cwd: canonicalRoot });
                const cycleEndedAt = new Date().toISOString();
                qualityCommandOutputs = runResults.map((result) => ({ command: result.command, duration_ms: result.duration_ms, exit_code: result.exit_code }));
                cycleGateResults = qualityGateResults(runResults);
                let postRunFingerprint;
                if (latestStatus.current_baseline && latestStatus.current_baseline.kind === 'snapshot') {
                    const initialSnapshot = readInitialSnapshot({ authorityDir, sessionId, workspaceId: latestStatus.workspace_id, workspaceRoot: canonicalRoot });
                    const { baseline: snapBaseline, excludedPaths } = createConfiguredSnapshotBaseline({ root: canonicalRoot });
                    postRunFingerprint = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths }).patchSha256;
                } else {
                    postRunFingerprint = captureDiffFingerprint({ repoRoot: canonicalRoot, baseCommit: latestStatus.current_baseline ? latestStatus.current_baseline.id : undefined, excludedPaths: ['.omni'] }).patchSha256;
                }
                if (postRunFingerprint !== cycleFingerprint) throw { code: 'DUAL_QC_SOURCE_DRIFT', message: `Source diff fingerprint changed during quality cycle ${c}: ${cycleFingerprint} -> ${postRunFingerprint}` };
                const artifactWriter = options.persistQualityExecutionArtifact || persistQualityExecutionArtifact;
                executionArtifact = artifactWriter({
                    authorityDir,
                    workspaceRoot: canonicalRoot,
                    sessionId,
                    workspaceId: latestStatus.workspace_id,
                    baseline: latestStatus.current_baseline,
                    planRevision,
                    policySha256,
                    diffFingerprint: cycleFingerprint,
                    cycleIndex: c,
                    attempt,
                    executionId,
                    totalTasks,
                    completedTaskIds,
                    gateResults: cycleGateResults,
                    startedAt: cycleStartedAt,
                    endedAt: cycleEndedAt,
                    results: runResults,
                });
            }
            qualityCommandOutputs = executionArtifact.artifact.commands
                .map(({ command, duration_ms, exit_code }) => ({ command, duration_ms, exit_code }));
            cycleGateResults = executionArtifact.artifact.gate_results.map((gate) => ({ ...gate }));
            const qualityResult = await client.evaluateCompletion(sessionId, {
                quality_evidence: {
                    cycle_index: c, total_tasks: totalTasks, plan_revision: planRevision, diff_fingerprint: cycleFingerprint,
                    commands: qualityCommandOutputs, completed_task_ids: completedTaskIds, evidence_sha256: executionArtifact.sha256, attempt,
                    provenance: { execution_id: executionId, input_fingerprint: cycleFingerprint, mode: 'fresh' },
                    gate_results: cycleGateResults,
                },
            });
            if (qualityResult?.error) throw { code: 'DUAL_QC_QUALITY_FAILED', message: qualityResult.error.message || `Quality cycle ${c} failed` };
            if (runResults.some((result) => !result.ok)) throw { code: 'DUAL_QC_QUALITY_FAILED', message: `Quality cycle ${c} has one or more blocking command failures` };
            latestStatus = await client.status(sessionId);
        }

        // 5. Query final verified status
        const finalStatus = await client.status(sessionId);
        const finalCompletion = await client.evaluateCompletion(sessionId);

        const receipt = finalCompletion.receipt ? finalCompletion.receipt.receipt_sha256 : (finalStatus.receipt ? finalStatus.receipt.receipt_sha256 : undefined);

        if (jsonMode) {
            console.log(JSON.stringify({
                ok: Boolean(finalCompletion.verified),
                session_id: sessionId,
                state: finalStatus.state,
                verified: finalCompletion.verified,
                task_id: targetTaskId,
                receipt,
                diff_fingerprint: diffFingerprint,
                modified_files: modifiedFiles,
            }));
            if (!finalCompletion.verified) process.exitCode = 1;
            return;
        }

        const completionLabel = finalCompletion.verified ? 'Đã nghiệm thu QC thành công' : 'QC đã ghi nhận nhưng phiên chưa VERIFIED';
        const completionColor = finalCompletion.verified ? chalk.green : chalk.yellow;
        console.log(completionColor.bold(`\n${completionLabel} cho task: ${chalk.cyan(targetTaskId)}`));
        console.log(chalk.white(`   Session ID       : ${chalk.gray(sessionId)}`));
        console.log(chalk.white(`   State            : ${chalk.green(finalStatus.state)}`));
        console.log(chalk.white(`   Diff Fingerprint : ${chalk.gray(diffFingerprint.slice(0, 16))}...`));
        console.log(chalk.white(`   Modified Files   : ${chalk.yellow(modifiedFiles.length)} files`));
        if (receipt) {
            console.log(chalk.white(`   Receipt SHA-256  : ${chalk.green.bold(receipt)}`));
        }
        if (finalCompletion.verified) {
            console.log(chalk.green.bold(`\n🎉 Phiên làm việc đã đạt trạng thái VERIFIED (100% Quality Gates Passed)!\n`));
        } else {
            console.log(chalk.yellow('\nPhiên chưa VERIFIED; kiểm tra blockers và chạy lại bounded QC khi đủ điều kiện.\n'));
            process.exitCode = 1;
        }
    } catch (error) {
        if (jsonMode) {
            process.exitCode = 1;
            console.log(JSON.stringify({
                ok: false,
                code: error.code || 'DUAL_QC_ERROR',
                message: error.message || 'QC evaluation failed',
            }));
            return;
        }
        handleDualError(error);
    }
}

async function handleDualMonitor(workspace, options = {}) {
    const canonicalRoot = workspace ? path.resolve(workspace) : process.cwd();
    const pollMs = Number(options.poll) || 500;
    const jsonMode = Boolean(options.json);

    const observer = new DualObserver({
        workspaceRoot: canonicalRoot,
        onEvent: (evt, formatted) => {
            if (jsonMode) {
                console.log(JSON.stringify(evt));
            } else {
                let color = chalk.white;
                if (evt.type.includes('error') || evt.type.includes('failed') || evt.type === 'session.blocked') {
                    color = chalk.red.bold;
                } else if (evt.type.includes('completed') || evt.type === 'session.verified' || evt.type === 'plan.registered') {
                    color = chalk.green.bold;
                } else if (evt.type.includes('started') || evt.type === 'routed') {
                    color = chalk.yellow;
                } else if (evt.type.includes('lease') || evt.type === 'correction') {
                    color = chalk.cyan;
                }
                console.log(color(formatted));
            }
        },
        onError: (err) => {
            if (!jsonMode) console.error(chalk.red(`[Observer Error] ${err.message}`));
        },
    });

    if (!jsonMode) {
        console.log(chalk.cyan(`Watching Dual Authority events for ${canonicalRoot} (poll: ${pollMs}ms)...`));
    }
    observer.start(pollMs);

    return new Promise((resolve) => {
        const cleanup = () => {
            observer.stop();
            if (!jsonMode) console.log(chalk.yellow('\nObserver stopped.'));
            resolve();
        };
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
    });
}

module.exports = {
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
    handleDualError,
    getOrchestrator,
    normalizeAuthorityTaskStatus,
    readDualPlanManifest,
    assertLegacyBootstrapAdoptable,
    assertRecoveryEligible,
    archiveLegacyBootstrapSession,
    collectLegacyBootstrapChanges,
    executeDualBootstrap,
};
