'use strict';

// LIVE BUG 2 probe: WRITE/CHECK ONLY during the fix; a separate worker runs it.
// Usage: node scripts/dual-resume-orphan-bug2-probe.js run
// Every run creates ~/workspace/dual-fix-verify/run-bug2-<Date.now()> exclusively.
// Daemon resume immediately redispatches the same attempt. To prove correction
// in the window "settled, no new execution", a short separate Node process uses
// the production tryReclaimOrphanedTaskLease function and all its production
// guards. No daemon resumes between settlement and correction.
// Exit 0 iff correction is accepted as attempt 2 AND attempt 2 has a handoff.
// Only this fixture's recorded, cmdline-verified daemon PIDs may be killed.
// The original BUG 1 repro and its exit contract remain unchanged.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const { createAuthorityStore } = require(path.join(REPO_ROOT, 'lib/dual/authority-store'));
const { createOrchestratorAdapter } = require(path.join(REPO_ROOT, 'lib/dual/orchestrator-adapter'));
const { startDaemonServer } = require(path.join(REPO_ROOT, 'lib/dual/daemon-server'));
const { createDaemonClient } = require(path.join(REPO_ROOT, 'lib/dual/daemon-client'));
const { createDiscussionStub } = require(path.join(REPO_ROOT, 'test/helpers/dual-discussion-stub'));

const SESSION_ID = 'session-1';
const TASK_ID = 'TASK-1';


function log(msg) { process.stdout.write(`[repro] ${msg}\n`); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? true;
    }
    return out;
}
async function waitFor(condition, timeoutMs, label, onTick) {
    const deadline = Date.now() + timeoutMs;
    let lastTick = 0;
    while (Date.now() < deadline) {
        if (await condition()) return true;
        if (onTick && Date.now() - lastTick > 10000) { lastTick = Date.now(); onTick(); }
        await sleep(500);
    }
    throw new Error(`Timed out waiting for ${label}`);
}
function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
}
function pidCmdline(pid) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); }
    catch { return ''; }
}

// ---- shared stub worker (same payloads as test/dual-resume-orphan.test.js) ----
function discussionForWorker(worker) {
    return createDiscussionStub({
        async turn({ workerRoot, phase, taskId, env, spawnImpl }) {
            const runDir = path.join(workerRoot, '.omni/codex-gemini/runs', taskId);
            const prompt = fs.readFileSync(path.join(runDir, `raw/${phase}.1.input.md`), 'utf8');
            const result = await worker({ cwd: workerRoot, transport: 'discussion',
                args: [`-p=Execute the ${phase} phase. Read .omni/codex-gemini/runs/${taskId}/raw/${phase}.1.input.md\n${prompt}`] },
            { env, spawn: spawnImpl });
            return JSON.parse(result.stdout).structured_output;
        },
    });
}
function fakeWorker(fixture, mode) {
    return async (invocation, options) => {
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read index and spec',
            relevant_files: [{ path: 'index.js', description: 'return value' }], exact_symbols: [],
            validation_commands: ['node --check index.js'], constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'What to change?', source,
                source_type: 'REPOSITORY', conclusion: 'Return two' })),
            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
            failure_modes: ['wrong return value'] };
        else if (prompt.includes('implement phase')) {
            fs.appendFileSync(path.join(fixture, 'worker-calls.log'),
                `${JSON.stringify({ at: new Date().toISOString(), phase: 'implement', daemonPid: process.pid, mode })}\n`);
            if (mode === 'hang') return new Promise(() => {});
            fs.writeFileSync(path.join(invocation.cwd, spec.allowed_files[0]), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: [spec.allowed_files[0]],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}
function adapterFor(fixture, mode) {
    const worker = fakeWorker(fixture, mode);
    return createOrchestratorAdapter({ workspaceRoot: fixture, authorityStore: createAuthorityStore(path.join(fixture, '.omni/runs/dual-authority')),
        discussion: discussionForWorker(worker),
        processRunner: async (invocation, deps) => {
            if (!invocation.args.some((arg) => arg.startsWith('-p=') && arg.includes('implement phase'))) {
                throw new Error('Only implement may call processRunner in this repro');
            }
            return worker(invocation, deps);
        } });
}

// ---- daemon mode: a real separate daemon process for one fixture ----
async function daemonMain(args) {
    const fixture = fs.realpathSync.native(path.resolve(args.fixture));
    const mode = args.mode || 'hang';
    if (!['hang', 'complete'].includes(mode)) throw new Error(`Unknown daemon mode: ${mode}`);
    const store = createAuthorityStore(path.join(fixture, '.omni/runs/dual-authority'));
    const daemon = await startDaemonServer({ workspaceRoot: fixture, authorityStore: store,
        orchestrator: adapterFor(fixture, mode) });
    fs.writeFileSync(path.join(fixture, `daemon-${mode}.pid`), `${process.pid}\n`);
    log(`daemon up mode=${mode} pid=${process.pid} port=${daemon.address.port} fixture=${fixture}`);
    const shutdown = async () => { try { await daemon.close(); } catch {} process.exit(0); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

// ---- run mode: orchestrate kill + restart + verdicts ----
function seedFixture(fixture) {
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(path.join(fixture, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(fixture, 'spec.md'), 'Return the number two.\n');
    const { createConfiguredSnapshotBaseline } = require(path.join(REPO_ROOT, 'lib/dual/snapshot-policy'));
    const { writeInitialSnapshot } = require(path.join(REPO_ROOT, 'lib/dual/snapshot-store'));
    const dir = path.join(fixture, '.omni/runs/dual-authority');
    const snapshot = createConfiguredSnapshotBaseline({ root: fixture }).baseline.capture();
    const store = createAuthorityStore(dir);
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: fixture,
        workspace_id: 'workspace-test', session_id: SESSION_ID, plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: SESSION_ID, workspaceId: 'workspace-test',
        workspaceRoot: fixture, identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.8-flash-high' } });
    const task = { task_id: TASK_ID, model: 'gemini-3.8-flash-high', effort: 'high', goal: 'Return two',
        allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }],
        title: 'Task one', owner: 'agy', risk: 'low', execution_mode: 'isolated' };
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1, tasks: [task] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: TASK_ID, owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['index.js'], model: 'gemini-3.8-flash-high', effort: 'high', reason: 'Private task' });
    return store;
}
function derive(fixture) {
    return createAuthorityStore(path.join(fixture, '.omni/runs/dual-authority')).derive();
}
function spawnDaemon(fixture, mode) {
    const logPath = path.join(fixture, `daemon-${mode}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [__filename, 'daemon', '--fixture', fixture, '--mode', mode], {
        detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env },
    });
    fs.writeFileSync(path.join(fixture, `daemon-${mode}.pid`), `${child.pid}\n`);
    child.unref();
    if (typeof logFd === 'number') fs.closeSync(logFd);
    return child.pid;
}
async function waitDaemonReady(fixture, mode) {
    const discovery = path.join(fixture, '.omni/runtime/dual/daemon.json');
    const pidFile = path.join(fixture, `daemon-${mode}.pid`);
    await waitFor(() => {
        if (!fs.existsSync(pidFile) || !fs.existsSync(discovery)) return false;
        try {
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            return JSON.parse(fs.readFileSync(discovery, 'utf8')).pid === pid && pidAlive(pid);
        } catch { return false; }
    }, 30000, 'matching daemon pid + discovery files');
    await sleep(500);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!pidAlive(pid)) throw new Error(`Daemon ${mode} pid ${pid} died on startup; see ${path.join(fixture, `daemon-${mode}.log`)}`);
    return pid;
}
async function killDaemon(fixture, pid) {
    const cmdline = pidCmdline(pid);
    if (!cmdline.includes('dual-resume-orphan-bug2-probe.js') || !cmdline.includes(fixture)) {
        throw new Error(`Refusing to kill pid ${pid}: cmdline does not match this repro fixture (${cmdline})`);
    }
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid), 15000, `daemon pid ${pid} to die`);
}
// This mode is intentionally short-lived and never starts a daemon.
function settleMain(args) {
    const fixture = fs.realpathSync.native(path.resolve(args.fixture));
    const store = createAuthorityStore(path.join(fixture, '.omni/runs/dual-authority'));
    const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
    const { tryReclaimOrphanedTaskLease } = require('../lib/dual/isolated-authority');
    const lease = Object.values(store.derive().leases).find((candidate) =>
        candidate.task_id === TASK_ID && candidate.status === 'expired');
    if (!tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: TASK_ID, lease,
        operationWriter: createOperationLifecycleWriter(store) })) throw new Error('Production reclaim refused the orphan');
    const task = store.derive().tasks[TASK_ID];
    if (task.lastOutcome?.code !== 'DUAL_WORKER_LOST' || task.lastOutcome.attempt !== 1 || task.isolatedHandoff) {
        throw new Error('Settlement did not establish the worker-lost correction window');
    }
    log(`settled via production reclaim: ${JSON.stringify(task.lastOutcome)}`);
}

async function cleanup(fixture) {
    const client = createDaemonClient({ workspaceRoot: fixture });
    try { await client.stop(); } catch {}
    await sleep(1000);
    for (const mode of ['hang', 'complete']) {
        const pidFile = path.join(fixture, `daemon-${mode}.pid`);
        if (!fs.existsSync(pidFile)) continue;
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid recorded ${mode} daemon PID`);
        if (pidAlive(pid)) await killDaemon(fixture, pid);
    }
}

async function runMain() {
    const fixture = path.join(os.homedir(), 'workspace/dual-fix-verify', `run-bug2-${Date.now()}`);
    // Exclusive creation prevents reusing or overwriting any prior fixture.
    fs.mkdirSync(fixture);
    log(`fresh fixture: ${fixture}`);
    try {
        seedFixture(fixture);
        spawnDaemon(fixture, 'hang');
        const pid1 = await waitDaemonReady(fixture, 'hang');
        const client1 = createDaemonClient({ workspaceRoot: fixture });
        const first = await client1.resumeSession(SESSION_ID, { timeoutMs: 30000 });
        log(`resume #1: ${JSON.stringify(first)}`);
        await waitFor(() => {
            const reference = derive(fixture).tasks[TASK_ID]?.isolatedWorkspace?.reference;
            if (!reference) return false;
            const { readTaskBinding } = require('../lib/dual/task-workspace');
            let workerRoot;
            try { ({ workerRoot } = readTaskBinding(fixture, reference)); } catch { return false; }
            const eventsPath = path.join(workerRoot, '.omni/codex-gemini/runs', TASK_ID, 'events.ndjson');
            if (!fs.existsSync(eventsPath)) return false;
            return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').some((line) => {
                const event = JSON.parse(line);
                return event.type === 'phase.started' && event.phase === 'implement';
            });
        }, 60000, 'implement phase.started under daemon #1');
        await killDaemon(fixture, pid1);
        log('daemon #1 SIGKILLed; waiting for the 120s lease expiry');
        await waitFor(() => Object.values(derive(fixture).leases).some((lease) =>
            lease.task_id === TASK_ID && lease.status === 'expired'),
        200000, 'orphan lease expiry', () => log('still waiting for lease expiry'));

        const settled = spawnSync(process.execPath, [__filename, 'settle', '--fixture', fixture],
            { encoding: 'utf8', timeout: 30000 });
        if (settled.stdout) process.stdout.write(settled.stdout);
        if (settled.stderr) process.stderr.write(settled.stderr);
        if (settled.error || settled.status !== 0) throw new Error(`Settlement subprocess failed: ${settled.error?.message || settled.status}`);

        spawnDaemon(fixture, 'complete');
        await waitDaemonReady(fixture, 'complete');
        const client2 = createDaemonClient({ workspaceRoot: fixture });
        // Do not resume daemon #2 before correction: it would supersede the placeholder.
        const corrected = await client2.correctTask(SESSION_ID, { task_id: TASK_ID, plan_revision: 1,
            request_id: 'correct-after-kill', expected_attempt: 1, reason: 'Retry after daemon kill.' },
        { timeoutMs: 15000 });
        log(`correction: ${JSON.stringify(corrected)}`);
        if (corrected.attempt !== 2) throw new Error('Correction was not accepted as attempt 2');
        const resumed = await client2.resumeSession(SESSION_ID, { timeoutMs: 30000 });
        log(`resume #2: ${JSON.stringify(resumed)}`);
        await waitFor(() => {
            const task = derive(fixture).tasks[TASK_ID];
            return task.isolatedWorkspace?.attempt === 2 && Boolean(task.isolatedHandoff);
        }, 60000, 'attempt 2 handoff', () => log('waiting for attempt 2 handoff'));
        log('PASS: correction accepted as attempt 2; attempt 2 has a handoff');
    } finally {
        await cleanup(fixture);
        log(`fixture retained at ${fixture}`);
    }
}

async function main() {
    const [mode, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    if (mode === 'daemon') await daemonMain(args);
    else if (mode === 'settle') settleMain(args);
    else if (mode === 'run') await runMain();
    else throw new Error('Usage: dual-resume-orphan-bug2-probe.js run');
}
main().catch((error) => {
    process.stderr.write(`[probe] FATAL: ${error.stack || error}\n`);
    process.exitCode = 1;
});
