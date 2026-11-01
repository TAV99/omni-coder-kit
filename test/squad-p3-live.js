#!/usr/bin/env node
'use strict';

// Opt-in live run for the P3 DoD (SPEC-SQUAD-P3 §11). Never imported by
// node:test. A scripted controller drives the real daemon, real codex and the
// real worker CLI through one isolated task, and stops at the plan and
// integrate gates until a person approves them with `omni squad approve` in
// another terminal. The spec gate needs a v2 coverage plan built by Codex and
// is covered by test/dual-coverage-daemon.test.js instead.
//
//   OMNI_SQUAD_LIVE=1 node test/squad-p3-live.js <report.json> [--worker agy|codex|claude] [--orchestrator codex|claude] [--reviewer codex|agy|claude] [--second-worker agy|codex|claude] [--planted-bug] [--setup-only]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const TASK_ID = 'TASK-P3-LIVE';
// --second-worker (SPEC-SQUAD-P5 §4): a second task on its own file, bound to worker-2, runs beside the first.
const TASK_B = 'TASK-P5-B';
const DEADLINE_MS = 5_400_000; // includes up to 30 minutes waiting for each approval
const APPROVAL_WAIT_MS = 1_800_000;
const WORKERS = {
    agy: { bind: 'worker=agy:gemini-3.8-flash-high', model: 'gemini-3.8-flash-high', effort: 'high' },
    codex: { bind: 'worker=codex:gpt-6-luna:low', model: 'gpt-6-luna', effort: 'low' },
    claude: { bind: 'worker=claude:sonnet:low', model: 'sonnet', effort: 'low' },
};
// Claude as orchestrator (SPEC-SQUAD-P4 §5) fills the discussion's astra slot and gets .mcp.json + hooks from setup.
const ORCHESTRATORS = { codex: 'orchestrator=codex:gpt-6.1-sol:high', claude: 'orchestrator=claude:sonnet:low' };
// An independent reviewer (SPEC-SQUAD-P5 §2) switches setup to preset squad: QC by the reviewer before command QC.
const REVIEWERS = { claude: 'reviewer=claude:sonnet:low', codex: 'reviewer=codex:gpt-6-luna:low', agy: 'reviewer=agy:gemini-3.8-flash-high' };
const OMNI = path.resolve(__dirname, '../bin/omni.js');

const failure = (code, message = code) => Object.assign(new Error(message), { code });
const check = (value, code, message) => { if (!value) throw failure(code, message); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const records = (file) => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : []);

function stopTree(child) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
}

function parseArgs(argv) {
    const args = { report: null, worker: 'agy', orchestrator: 'codex', reviewer: null, secondWorker: null, plantedBug: false, setupOnly: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--worker') args.worker = argv[++i];
        else if (argv[i] === '--orchestrator') args.orchestrator = argv[++i];
        else if (argv[i] === '--reviewer') args.reviewer = argv[++i];
        else if (argv[i] === '--second-worker') args.secondWorker = argv[++i];
        else if (argv[i] === '--planted-bug') args.plantedBug = true;
        else if (argv[i] === '--setup-only') args.setupOnly = true;
        else if (!args.report && !argv[i].startsWith('--')) args.report = argv[i];
        else throw failure('BAD_ARGS', `Unknown argument ${argv[i]}`);
    }
    check(args.report, 'REPORT_PATH_REQUIRED');
    check(WORKERS[args.worker], 'BAD_WORKER', 'Use --worker agy, codex or claude');
    check(ORCHESTRATORS[args.orchestrator], 'BAD_ORCHESTRATOR', 'Use --orchestrator codex or claude');
    check(args.reviewer === null || REVIEWERS[args.reviewer], 'BAD_REVIEWER', 'Use --reviewer codex, agy or claude');
    check(args.secondWorker === null || WORKERS[args.secondWorker], 'BAD_WORKER', 'Use --second-worker agy, codex or claude');
    check(args.secondWorker === null || args.reviewer, 'REVIEWER_REQUIRED', '--second-worker uses preset squad, which needs --reviewer');
    // --planted-bug (SPEC-SQUAD-P5 V38): a scripted claude worker plants a bug the smoke test misses;
    // the real reviewer must send it back (NEEDS_FIX) and the correction must pass.
    check(!args.plantedBug || (args.worker === 'claude' && args.reviewer && args.reviewer !== 'claude' && !args.secondWorker),
        'BAD_PLANTED_BUG', '--planted-bug needs --worker claude and --reviewer codex|agy');
    return args;
}

async function main() {
    if (process.env.OMNI_SQUAD_LIVE !== '1') {
        console.log('Usage: OMNI_SQUAD_LIVE=1 node test/squad-p3-live.js <report.json> [--worker agy|codex|claude] [--orchestrator codex|claude] [--reviewer codex|agy|claude] [--second-worker agy|codex|claude] [--planted-bug] [--setup-only]');
        return;
    }
    const args = parseArgs(process.argv.slice(2));
    const worker = WORKERS[args.worker];
    const output = path.resolve(args.report);
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    const started = Date.now();
    const deadline = started + DEADLINE_MS;
    const report = { protocol: 'squad-p3-live-v1', startedAt: new Date(started).toISOString(), ok: false,
        orchestrator: args.orchestrator, reviewer: args.reviewer, worker: args.worker, workerModel: worker.model, secondWorker: args.secondWorker, plantedBug: args.plantedBug, taskId: TASK_ID, failedStage: null, errorCode: null, stages: {} };
    const save = () => {
        const temp = `${output}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, output);
    };
    let root, child, client, authority, exitResult, childError, exited;

    async function stage(name, timeoutMs, action) {
        const time = Date.now();
        console.error(`[${name}] started`);
        const limit = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
        let timer;
        try {
            const result = await Promise.race([action(limit), new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('STAGE_TIMEOUT', `${name} exceeded ${limit}ms`)), limit);
            })]);
            report.stages[name] = { ok: true, wallMs: Date.now() - time };
            console.error(`[${name}] OK`);
            return result;
        } catch (error) {
            report.failedStage ||= name;
            report.errorCode ||= error.code || 'LIVE_ERROR';
            report.stages[name] = { ok: false, wallMs: Date.now() - time, errorCode: error.code || 'LIVE_ERROR',
                errorMessage: require('../lib/dual/validator-security').redactDiagnostic(error.message) };
            console.error(`[${name}] ${report.stages[name].errorCode}: ${report.stages[name].errorMessage}`);
            throw error;
        } finally { clearTimeout(timer); save(); }
    }
    const second = args.secondWorker ? WORKERS[args.secondWorker] : null;
    const taskIds = second ? [TASK_ID, TASK_B] : [TASK_ID];
    const task = (id = TASK_ID) => authority.derive().tasks[id];
    // With --planted-bug a reviewer NEEDS_FIX outcome is the expected detour, not a failure.
    const expectedDetour = (outcome) => args.plantedBug && outcome.status === 'NEEDS_FIX' && outcome.code === 'DUAL_CONTROLLER_REVIEW_REJECTED';
    async function poll(predicate, limit, label) {
        const until = Date.now() + limit;
        while (Date.now() < until) {
            if (childError) throw childError;
            if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
            if (await predicate()) return;
            for (const id of authority ? taskIds : []) {
                const current = task(id);
                if (current?.lastOutcome && !expectedDetour(current.lastOutcome)) {
                    report.taskDiagnostic = current; throw failure('TASK_OUTCOME', JSON.stringify(current.lastOutcome));
                }
            }
            await pause(500);
        }
        throw failure('STAGE_TIMEOUT', `Timed out waiting for ${label}`);
    }
    // The harness plays the orchestrator: a scout NEEDS_CONTEXT question gets the
    // grounded reply Codex would give (dual-controller.md), at most three times.
    const answered = new Set();
    async function answerContext(taskId = TASK_ID) {
        const waiting = task(taskId).waitingContext;
        const open = waiting.question_ids.filter((id) => !answered.has(id));
        if (!open.length) return;
        if (answered.size + open.length > 3) throw failure('ISOLATED_CONTROLLER_REQUIRED', 'Worker keeps asking for context');
        for (const questionId of open) {
            const messageId = `reply-${answered.size + 1}`;
            const body = taskId === TASK_B
                ? 'Decision: The task context is complete: README.md, lib/count.js and test/count.test.js are in scope; no more reconnaissance is needed. '
                    + 'Change only lib/count.js: add an Array.isArray guard to countActive that throws TypeError("Expected array") for non-arrays and keep array behavior. '
                : 'Decision: The task context is complete: README.md, entry.js, lib/util.js and test/smoke.test.js are in scope; no more reconnaissance is needed. '
                    + 'Change only lib/util.js: add an Array.isArray guard to activeIds that throws TypeError("Expected array") for non-arrays and keep array behavior. ';
            const ack = await client.replyToTask(report.sessionId, { task_id: taskId, plan_revision: 1, message_id: `${taskId}-${messageId}`, reply_to: questionId,
                body: `${body}Source file/section: plans/plan.md; Question ID: ${questionId}; Plan revision: 1` });
            check(ack.acknowledged === true, 'CONTEXT_REPLY_REJECTED', JSON.stringify(ack));
            answered.add(questionId);
            report.contextReplies = [...(report.contextReplies || []), { questionId, messageId }];
            console.error(`[context] answered ${questionId}`);
        }
        await client.request('session.resume', { session_id: report.sessionId, task_id: taskId, plan_revision: 1 });
    }

    // The person approves in another terminal; the harness never approves.
    async function waitForApproval(gateId, limit) {
        const command = `cd ${root} && node ${OMNI} squad approve ${gateId}`;
        console.error(`\n>>> Cổng ${gateId} đang chờ. Mở terminal khác và chạy:\n    ${command}\n`);
        report.awaiting = { gateId, command };
        save();
        await poll(() => authority.derive().approvals?.[gateId]?.status !== 'pending', limit, `approval of ${gateId}`);
        const decided = authority.derive().approvals[gateId];
        report.decisions = [...(report.decisions || []), decided];
        check(decided.status === 'approved', 'GATE_REJECTED', `${gateId} was ${decided.status}: ${decided.reason || ''}`);
        check(decided.actor === 'human' && decided.via === 'cli-tty', 'GATE_NOT_HUMAN', `${decided.actor}/${decided.via}`);
        delete report.awaiting;
    }

    save();
    try {
        await stage('setup', 120_000, async () => {
            root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-squad-live-')), 'workspace');
            fs.mkdirSync(root);
            report.workspaceRoot = root;
            const { buildCodexConfig, buildCodexHooks } = require('../lib/init');
            const opts = { dualPair: 'codex-agy', mode: 'auto', projectDir: root };
            const fixture = {
                'entry.js': "'use strict';\nmodule.exports = require('./lib/util');\n",
                'lib/util.js': "'use strict';\nfunction activeIds(xs) {\n    return xs.filter(x => x.active).map(x => x.id);\n}\nmodule.exports = { activeIds };\n",
                'test/smoke.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { activeIds } = require('../entry');\ntest('active ids', () => assert.deepEqual(activeIds([{ id: 1, active: true }]), [1]));\n",
                'README.md': '# Live squad fixture\nactiveIds returns ids of active records. Run node --test test/smoke.test.js.\n',
                'plans/plan.md': '# Tiny task\nAdd an Array.isArray guard to activeIds in lib/util.js; throw TypeError("Expected array") for non-arrays. Preserve array behavior.\n'
                    + (args.secondWorker ? 'Also add the same guard to countActive in lib/count.js.\n' : ''),
                ...(args.secondWorker ? {
                    'lib/count.js': "'use strict';\nfunction countActive(xs) {\n    return xs.filter(x => x.active).length;\n}\nmodule.exports = { countActive };\n",
                    'test/count.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { countActive } = require('../lib/count');\ntest('count active', () => assert.equal(countActive([{ active: true }, { active: false }]), 1));\n",
                } : {}),
                '.codex/config.toml': buildCodexConfig('dual', true, opts),
                '.codex/hooks.json': buildCodexHooks('dual', true, opts),
                '.omni/manifest.json': JSON.stringify({ version: '3.2.0', ide: 'dual' }),
            };
            for (const [file, content] of Object.entries(fixture)) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.writeFileSync(path.join(root, file), content);
            }
            report.planSha256 = createHash('sha256').update(fixture['plans/plan.md']).digest('hex');
            // The real squad setup: roles, dual pipeline (spec/plan/integrate gates), binding, manifest.
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-squad-live-home-'));
            const setup = await require('../lib/squad/setup').runSetup({ projectRoot: root, homedir: home, yes: true,
                preset: args.reviewer || second ? 'squad' : 'dual', workers: second ? 2 : 1,
                binds: [ORCHESTRATORS[args.orchestrator], worker.bind.replace(/^worker=/, 'worker-1='),
                    ...(second ? [second.bind.replace(/^worker=/, 'worker-2=')] : []),
                    ...(args.reviewer ? [REVIEWERS[args.reviewer]] : [])] });
            // Two workers of the same CLI may run side by side here (default agy is 1).
            if (second && args.secondWorker === args.worker) {
                const bindingFile = path.join(root, '.omni', 'squad.local.json');
                const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
                fs.writeFileSync(bindingFile, JSON.stringify({ ...binding, limits: { concurrency: { [args.worker]: 2 } } }, null, 2));
            }
            report.setup = { engine: setup.engine, pipeline: setup.pipeline, binding: setup.binding.roles };
            check(setup.engine.supported, 'ENGINE_UNSUPPORTED', JSON.stringify(setup.engine.reasons));
            const manifest = JSON.parse(fs.readFileSync(path.join(root, '.omni/manifest.json'), 'utf8'));
            check(manifest.workerRuntime === args.worker && manifest.workerModel === worker.model, 'MANIFEST_NOT_BOUND', JSON.stringify(manifest));
            check(manifest.orchestratorRuntime === args.orchestrator, 'MANIFEST_NOT_BOUND', JSON.stringify(manifest));
            if (args.orchestrator === 'claude') {
                report.setup.orchestratorConfig = setup.orchestratorConfig;
                check(require('../lib/squad/claude-orchestrator').hasClaudeOrchestratorMcp(root), 'CLAUDE_MCP_MISSING');
            }
        });
        if (args.setupOnly) { report.ok = true; return; }
        await stage('binaryPreflight', 20_000, async () => {
            report.binaries = Object.fromEntries([...new Set([args.orchestrator, args.worker, ...(args.secondWorker ? [args.secondWorker] : []), ...(args.reviewer ? [args.reviewer] : [])])].map((name) => [name,
                execFileSync(name, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()]));
        });
        await stage('daemonListened', 20_000, async (limit) => {
            report.daemonLog = path.join(path.dirname(root), 'daemon.log');
            const log = fs.openSync(report.daemonLog, 'wx', 0o600);
            const env = { ...process.env };
            for (const key of ['OMNI_DUAL_WORKER_MODEL', 'OMNI_DUAL_WORKER_EFFORT', 'OMNI_DUAL_WORKER_RUNTIME', 'OMNI_DUAL_DISCUSSION_ENABLED']) delete env[key];
            if (args.plantedBug) env.OMNI_CLAUDE_PATH = path.join(__dirname, 'fixtures', 'fake-claude-worker.js');
            try {
                child = spawn(process.execPath, [path.resolve(__dirname, '../bin/omni-daemon.js'), '--workspace', root],
                    { env, detached: true, stdio: ['ignore', log, log] });
            } finally { fs.closeSync(log); }
            exited = new Promise((resolve) => child.once('close', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); }));
            child.on('error', (error) => { childError = error; });
            client = require('../lib/dual/daemon-client').createDaemonClient({ workspaceRoot: root, timeoutMs: 10_000 });
            await poll(() => { try { client.readDiscovery(); return true; } catch (error) {
                if (error.code !== 'DUAL_DISCOVERY_MISSING') throw error; return false; } }, limit, 'daemon discovery');
            check((await client.health()).status === 'healthy', 'DAEMON_UNHEALTHY');
            authority = require('../lib/dual/authority-store').createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
        });
        await stage('sessionBegun', 20_000, async (limit) => {
            const result = await client.beginSession({ workspace_root: root, mode: 'auto' }, { timeoutMs: limit });
            check(result.session_id, 'SESSION_ID_MISSING');
            report.sessionId = result.session_id;
        });
        await stage('planRegistered', 120_000, async (limit) => {
            const result = await client.registerPlan(report.sessionId, {
                plan_path: 'plans/plan.md', plan_sha256: report.planSha256, plan_revision: 1,
                acceptance_policy: { protocol_version: 1, checks: [], ui: { required: false,
                    viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } },
                // owner by role name (P3b); the bound runtime fills the worker slot (P3c).
                tasks: [{ task_id: TASK_ID, title: 'Add Array.isArray guard to activeIds',
                    owner: 'worker', execution_mode: 'isolated', model: worker.model, effort: worker.effort,
                    goal: 'Add Array.isArray guard in activeIds, throw TypeError("Expected array") for non-arrays, preserve array behavior.',
                    risk: 'low', complexity: 'low', category: 'feature', allowed_files: ['lib/util.js'], deny_patterns: [],
                    context_files: ['README.md', 'entry.js', 'lib/util.js', 'test/smoke.test.js'],
                    validation_commands: [{ program: 'node', args: ['--test', 'test/smoke.test.js'], cwd: '.' }] },
                ...(second ? [{ task_id: TASK_B, title: 'Add Array.isArray guard to countActive', worker: 'worker-2',
                    owner: 'worker', execution_mode: 'isolated', model: second.model, effort: second.effort,
                    goal: 'Add Array.isArray guard in countActive, throw TypeError("Expected array") for non-arrays, preserve array behavior.',
                    risk: 'low', complexity: 'low', category: 'feature', allowed_files: ['lib/count.js'], deny_patterns: [],
                    context_files: ['README.md', 'lib/count.js', 'test/count.test.js'],
                    validation_commands: [{ program: 'node', args: ['--test', 'test/count.test.js'], cwd: '.' }] }] : [])],
            }, { timeoutMs: limit });
            check(result.registered === true, 'PLAN_NOT_REGISTERED');
        });
        await stage('planGateHeld', 30_000, async (limit) => {
            await client.resumeSession(report.sessionId, { timeoutMs: limit });
            const status = await client.status(report.sessionId);
            report.planGate = status.approvals?.['plan-r1'];
            check(report.planGate?.status === 'pending', 'PLAN_GATE_MISSING', JSON.stringify(status.worker_start));
            check(status.worker_start?.state === 'awaiting_approval', 'PLAN_GATE_NOT_HOLDING', JSON.stringify(status.worker_start));
            check(!task()?.isolatedWorkspace, 'WORKER_STARTED_BEFORE_APPROVAL');
        });
        await stage('planApproved', APPROVAL_WAIT_MS, (limit) => waitForApproval('plan-r1', limit));
        await stage('isolatedHandoff', 1_200_000, async (limit) => {
            await poll(async () => {
                for (const id of taskIds) if (task(id)?.waitingContext) await answerContext(id);
                return taskIds.every((id) => task(id)?.isolatedHandoff) && !Object.values(authority.derive().leases).some((lease) => lease.status === 'active');
            }, limit, 'isolated handoff');
            report.handoff = task().isolatedHandoff;
            if (second) {
                // Worker leases of the two tasks must overlap in time (SPEC-SQUAD-P5 §4).
                const leases = Object.values(authority.derive().leases).filter((lease) => lease.owner === 'agy');
                const span = (id) => { const own = leases.filter((lease) => lease.task_id === id);
                    return [Math.min(...own.map((l) => Date.parse(l.acquired_at))), Math.max(...own.map((l) => Date.parse(l.released_at || l.expires_at)))]; };
                const [a, b] = taskIds.map(span);
                report.parallel = { [TASK_ID]: a.map((t) => new Date(t).toISOString()), [TASK_B]: b.map((t) => new Date(t).toISOString()),
                    overlapMs: Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])) };
                check(report.parallel.overlapMs > 0, 'NOT_PARALLEL', JSON.stringify(report.parallel));
            }
        });
        for (const extra of taskIds.slice(1)) {
            // Each extra task gets its own reviewer + command QC + integrate gate, one after another.
            await stage(`qc-${extra}`, 3_600_000, async (limit) => {
                let held = await client.completeIsolatedTask(report.sessionId, extra, 1, { timeoutMs: limit });
                while (held.status === 'AWAITING_REVIEW') {
                    await pause(5_000);
                    held = await client.completeIsolatedTask(report.sessionId, extra, 1, { timeoutMs: limit });
                }
                check(held.status === 'AWAITING_HUMAN_APPROVAL', held.status || 'QC_NOT_HELD', JSON.stringify(held).slice(0, 400));
                await waitForApproval(`integrate-${extra}`, APPROVAL_WAIT_MS);
                const done = await client.completeIsolatedTask(report.sessionId, extra, 1, { timeoutMs: limit });
                check(done.status === 'TASK_VERIFIED', done.status || 'QC_NOT_VERIFIED');
                report.extraTasks = { ...report.extraTasks, [extra]: { review: task(extra).qcReview, qc: done.status } };
            });
        }
        if (args.plantedBug) {
            await stage('reviewerSendsBack', 3_600_000, async (limit) => {
                // Attempt 1 is rejected by the reviewer, the daemon re-dispatches, attempt 2 must be approved.
                await poll(async () => {
                    if (task()?.waitingContext) await answerContext();
                    const current = task();
                    return current?.qcReview?.status === 'completed' && current.qcReview.verdict === 'APPROVE'
                        && current.qcReview.attempt === current.isolatedHandoff?.attempt;
                }, limit, 'reviewer approval after correction');
                report.reviewHistory = authority.readEvents().filter((event) => event.type === 'qc.review.completed')
                    .map((event) => ({ attempt: event.attempt, verdict: event.verdict, findings: event.findings_count }));
                report.rejections = authority.readEvents().filter((event) => event.type === 'task.handoff.rejected')
                    .map((event) => ({ attempt: event.attempt, findings: event.findings.map((finding) => finding.description) }));
                check(report.reviewHistory[0]?.verdict === 'NEEDS_FIX' && report.reviewHistory.at(-1).verdict === 'APPROVE'
                    && report.reviewHistory.at(-1).attempt >= 2, 'NO_NEEDS_FIX_LOOP', JSON.stringify(report.reviewHistory));
            });
        }
        await stage('qcHeldAtIntegrate', 1_800_000, async (limit) => {
            let held = await client.completeIsolatedTask(report.sessionId, TASK_ID, 1, { timeoutMs: limit });
            // With a reviewer, task.qc answers AWAITING_REVIEW until the pushed review settles.
            while (held.status === 'AWAITING_REVIEW') {
                await pause(5_000);
                held = await client.completeIsolatedTask(report.sessionId, TASK_ID, 1, { timeoutMs: limit });
            }
            if (args.reviewer) {
                report.review = task().qcReview;
                const verdictFile = path.join(path.dirname(path.join(root, task().isolatedWorkspace.reference.bindingPath)), 'qc-verdict.json');
                if (fs.existsSync(verdictFile)) report.reviewVerdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
                check(report.review?.verdict === 'APPROVE', 'REVIEW_NOT_APPROVED', JSON.stringify(report.review));
            }
            report.qcHeld = held;
            check(held.status === 'AWAITING_HUMAN_APPROVAL', held.status || 'QC_NOT_HELD', JSON.stringify(held).slice(0, 400));
            check(!fs.readFileSync(path.join(root, 'lib/util.js'), 'utf8').includes('Array.isArray'), 'SOURCE_CHANGED_BEFORE_APPROVAL');
        });
        await stage('integrateApproved', APPROVAL_WAIT_MS, (limit) => waitForApproval(`integrate-${TASK_ID}`, limit));
        await stage('codexQc', 1_800_000, async (limit) => {
            report.qcResult = await client.completeIsolatedTask(report.sessionId, TASK_ID, 1, { timeoutMs: limit });
            check(report.qcResult.status === 'TASK_VERIFIED', report.qcResult.status || 'QC_NOT_VERIFIED');
            check(task().state === 'TASK_VERIFIED', 'TASK_NOT_VERIFIED');
        });
        await stage('finalEvidence', 30_000, async () => {
            const util = path.join(root, 'lib/util.js');
            check(fs.readFileSync(util, 'utf8').includes('Array.isArray'), 'GUARD_MISSING');
            const { activeIds } = require(util);
            const assert = require('node:assert/strict');
            for (const value of [null, undefined, {}, 'x', 1]) {
                assert.throws(() => activeIds(value), (error) => error instanceof TypeError && error.message === 'Expected array');
            }
            assert.deepEqual(activeIds([{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true }]), [1, 3]);
            if (second) {
                const { countActive } = require(path.join(root, 'lib/count.js'));
                for (const value of [null, undefined, {}, 'x', 1]) {
                    assert.throws(() => countActive(value), (error) => error instanceof TypeError && error.message === 'Expected array');
                }
                assert.equal(countActive([{ active: true }, { active: true }, { active: false }]), 2);
            }
            report.smokeOutput = execFileSync(process.execPath, ['--test', 'test/smoke.test.js'], { cwd: root, encoding: 'utf8', timeout: 20_000 });
            const reference = task().isolatedWorkspace.reference;
            const { workerRoot } = require('../lib/dual/task-workspace').readTaskBinding(root, reference);
            const phases = records(path.join(workerRoot, '.omni/codex-gemini/runs', TASK_ID, 'events.ndjson'))
                .filter((event) => event.type === 'phase.completed').map((event) => event.phase);
            report.phasesCompleted = [...new Set(phases)];
            for (const phase of ['scout', 'implement', 'review']) check(phases.includes(phase), 'PHASE_MISSING', phase);
            const gates = authority.readEvents().filter((event) => event.type.startsWith('gate.') && event.type !== 'gate.result');
            report.gateEvents = gates.map((event) => ({ type: event.type, gate_id: event.gate_id, actor: event.actor, via: event.via }));
        });
        report.ok = true;
    } catch { /* the failing stage recorded its error */ }
    finally {
        if (child && !exitResult) {
            try {
                await client.stop({ timeoutMs: 5_000 });
                await Promise.race([exited, pause(10_000)]);
            } catch { /* fall through to a hard stop */ }
            if (!exitResult) stopTree(child);
        }
        if (!report.ok && report.daemonLog && fs.existsSync(report.daemonLog)) {
            report.daemonLogTail = require('../lib/dual/validator-security').redactDiagnostic(
                fs.readFileSync(report.daemonLog, 'utf8').slice(-16000), { maxLength: 16000 });
        }
        report.wallMs = Date.now() - started;
        save();
        console.error(`Report: ${output}; ${report.ok ? 'OK' : `${report.failedStage}: ${report.errorCode}`}`);
        process.exitCode = report.ok ? 0 : 1;
    }
}

main().catch((error) => {
    console.error(`Live run stopped: ${error.code || 'LIVE_ERROR'} ${error.message}`);
    process.exitCode = 1;
});
