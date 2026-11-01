#!/usr/bin/env node
'use strict';

// Opt-in live run for the P3 DoD (SPEC-SQUAD-P3 §11). Never imported by
// node:test. A scripted controller drives the real daemon, real codex and the
// real worker CLI through one isolated task, and stops at the plan and
// integrate gates until a person approves them with `omni squad approve` in
// another terminal. The spec gate needs a v2 coverage plan built by Codex and
// is covered by test/dual-coverage-daemon.test.js instead.
//
//   OMNI_SQUAD_LIVE=1 node test/squad-p3-live.js <report.json> [--worker agy|codex|claude] [--orchestrator codex|claude] [--reviewer codex|agy|claude] [--setup-only]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const TASK_ID = 'TASK-P3-LIVE';
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
    const args = { report: null, worker: 'agy', orchestrator: 'codex', reviewer: null, setupOnly: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--worker') args.worker = argv[++i];
        else if (argv[i] === '--orchestrator') args.orchestrator = argv[++i];
        else if (argv[i] === '--reviewer') args.reviewer = argv[++i];
        else if (argv[i] === '--setup-only') args.setupOnly = true;
        else if (!args.report && !argv[i].startsWith('--')) args.report = argv[i];
        else throw failure('BAD_ARGS', `Unknown argument ${argv[i]}`);
    }
    check(args.report, 'REPORT_PATH_REQUIRED');
    check(WORKERS[args.worker], 'BAD_WORKER', 'Use --worker agy, codex or claude');
    check(ORCHESTRATORS[args.orchestrator], 'BAD_ORCHESTRATOR', 'Use --orchestrator codex or claude');
    check(args.reviewer === null || REVIEWERS[args.reviewer], 'BAD_REVIEWER', 'Use --reviewer codex, agy or claude');
    return args;
}

async function main() {
    if (process.env.OMNI_SQUAD_LIVE !== '1') {
        console.log('Usage: OMNI_SQUAD_LIVE=1 node test/squad-p3-live.js <report.json> [--worker agy|codex|claude] [--orchestrator codex|claude] [--reviewer codex|agy|claude] [--setup-only]');
        return;
    }
    const args = parseArgs(process.argv.slice(2));
    const worker = WORKERS[args.worker];
    const output = path.resolve(args.report);
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    const started = Date.now();
    const deadline = started + DEADLINE_MS;
    const report = { protocol: 'squad-p3-live-v1', startedAt: new Date(started).toISOString(), ok: false,
        orchestrator: args.orchestrator, reviewer: args.reviewer, worker: args.worker, workerModel: worker.model, taskId: TASK_ID, failedStage: null, errorCode: null, stages: {} };
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
    const task = () => authority.derive().tasks[TASK_ID];
    async function poll(predicate, limit, label) {
        const until = Date.now() + limit;
        while (Date.now() < until) {
            if (childError) throw childError;
            if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
            if (await predicate()) return;
            const current = authority && task();
            if (current?.lastOutcome) { report.taskDiagnostic = current; throw failure('TASK_OUTCOME', JSON.stringify(current.lastOutcome)); }
            await pause(500);
        }
        throw failure('STAGE_TIMEOUT', `Timed out waiting for ${label}`);
    }
    // The harness plays the orchestrator: a scout NEEDS_CONTEXT question gets the
    // grounded reply Codex would give (dual-controller.md), at most three times.
    const answered = new Set();
    async function answerContext() {
        const waiting = task().waitingContext;
        const open = waiting.question_ids.filter((id) => !answered.has(id));
        if (!open.length) return;
        if (answered.size + open.length > 3) throw failure('ISOLATED_CONTROLLER_REQUIRED', 'Worker keeps asking for context');
        for (const questionId of open) {
            const messageId = `reply-${answered.size + 1}`;
            const ack = await client.replyToTask(report.sessionId, { task_id: TASK_ID, plan_revision: 1, message_id: messageId, reply_to: questionId,
                body: 'Decision: The task context is complete: README.md, entry.js, lib/util.js and test/smoke.test.js are in scope; no more reconnaissance is needed. '
                    + 'Change only lib/util.js: add an Array.isArray guard to activeIds that throws TypeError("Expected array") for non-arrays and keep array behavior. '
                    + `Source file/section: plans/plan.md; Question ID: ${questionId}; Plan revision: 1` });
            check(ack.acknowledged === true, 'CONTEXT_REPLY_REJECTED', JSON.stringify(ack));
            answered.add(questionId);
            report.contextReplies = [...(report.contextReplies || []), { questionId, messageId }];
            console.error(`[context] answered ${questionId}`);
        }
        await client.request('session.resume', { session_id: report.sessionId, task_id: TASK_ID, plan_revision: 1 });
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
                'plans/plan.md': '# Tiny task\nAdd an Array.isArray guard to activeIds in lib/util.js; throw TypeError("Expected array") for non-arrays. Preserve array behavior.\n',
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
                preset: args.reviewer ? 'squad' : 'dual',
                binds: [ORCHESTRATORS[args.orchestrator], worker.bind, ...(args.reviewer ? [REVIEWERS[args.reviewer]] : [])] });
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
            report.binaries = Object.fromEntries([...new Set([args.orchestrator, args.worker, ...(args.reviewer ? [args.reviewer] : [])])].map((name) => [name,
                execFileSync(name, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()]));
        });
        await stage('daemonListened', 20_000, async (limit) => {
            report.daemonLog = path.join(path.dirname(root), 'daemon.log');
            const log = fs.openSync(report.daemonLog, 'wx', 0o600);
            const env = { ...process.env };
            for (const key of ['OMNI_DUAL_WORKER_MODEL', 'OMNI_DUAL_WORKER_EFFORT', 'OMNI_DUAL_WORKER_RUNTIME', 'OMNI_DUAL_DISCUSSION_ENABLED']) delete env[key];
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
                    validation_commands: [{ program: 'node', args: ['--test', 'test/smoke.test.js'], cwd: '.' }] }],
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
                if (task()?.waitingContext) await answerContext();
                return task()?.isolatedHandoff && !Object.values(authority.derive().leases).some((lease) => lease.status === 'active');
            }, limit, 'isolated handoff');
            report.handoff = task().isolatedHandoff;
        });
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
