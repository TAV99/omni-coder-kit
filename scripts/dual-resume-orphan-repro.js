'use strict';

// LIVE repro for the dual daemon crash-recovery gap (coordinator brief, 2026-10-25).
//
// What it proves (daemon thật + kill thật; only the model worker is stubbed,
// with the repo's own discussion stub, because a real AGY call is not needed
// to expose a lease/operation settlement bug):
//
//   BUG 1: daemon #1 runs implement, is SIGKILLed mid-implement, its lease
//     expires, and daemon #2 (fresh process, stale lock reclaimed) resumes.
//     On base, resume never re-dispatches: no handoff, lease stays
//     expired-unreleased, implement is never invoked again.
//   BUG 2: after the same kill, task.correct is rejected with
//     DUAL_INTEGRITY_CORRUPT (no lastOutcome, unreleased attempt).
//
// Usage (run from the repo root; the script re-execs itself for the daemon):
//   node scripts/dual-resume-orphan-repro.js run [--fixture DIR]
//   node scripts/dual-resume-orphan-repro.js daemon --fixture DIR --mode hang|complete
//
// Exit code contract: 0 iff the BUG 1 section PASSES. Phase 4 is a negative
// check: after redispatch succeeds and handoff is recorded without an outcome,
// task.correct MUST be rejected with DUAL_INTEGRITY_CORRUPT (EXPECTED /
// REJECTED-AS-EXPECTED); this is reported separately and does not affect the exit code.
// The script only ever touches its own fresh fixture directory and only
// SIGKILLs the daemon pid it recorded in that directory (cmdline verified
// against the fixture path first). It never touches any other session.
//
// NOTE on the wait: the isolated AGY lease TTL is hardcoded to 120s in
// lib/dual/isolated-authority.js, so the script waits ~2 minutes after the
// kill for the lease to read as expired. That is the honest cost of a real
// kill repro; the unit test (test/dual-resume-orphan.test.js) uses a short
// TTL for fast iteration.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const { createAuthorityStore } = require(path.join(REPO_ROOT, 'lib/dual/authority-store'));
const { createOrchestratorAdapter } = require(path.join(REPO_ROOT, 'lib/dual/orchestrator-adapter'));
const { startDaemonServer } = require(path.join(REPO_ROOT, 'lib/dual/daemon-server'));
const { createDaemonClient } = require(path.join(REPO_ROOT, 'lib/dual/daemon-client'));
const { createDiscussionStub } = require(path.join(REPO_ROOT, 'test/helpers/dual-discussion-stub'));

const SESSION_ID = 'session-1';
const TASK_ID = 'TASK-1';
let currentFixture = null;

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
    if (!cmdline.includes('dual-resume-orphan-repro.js') || !cmdline.includes(fixture)) {
        throw new Error(`Refusing to kill pid ${pid}: cmdline does not match this repro fixture (${cmdline})`);
    }
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid), 15000, `daemon pid ${pid} to die`);
}
function implementCalls(fixture) {
    const callsPath = path.join(fixture, 'worker-calls.log');
    if (!fs.existsSync(callsPath)) return [];
    return fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function runMain(args) {
    try {
        await runMainInner(args);
    } catch (error) {
        // Never leak a daemon this script spawned: kill only pids recorded in
        // this run's own fixture pid files (cmdline verified by killDaemon).
        if (currentFixture) {
            for (const mode of ['hang', 'complete']) {
                const pidFile = path.join(currentFixture, `daemon-${mode}.pid`);
                if (fs.existsSync(pidFile)) {
                    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
                    if (Number.isSafeInteger(pid) && pidAlive(pid)) {
                        try { await killDaemon(currentFixture, pid); log(`cleaned up leaked daemon pid=${pid}`); }
                        catch (cleanupError) { log(`cleanup warning: ${cleanupError.message}`); }
                    }
                }
            }
        }
        throw error;
    }
}

async function runMainInner(args) {
    const fixture = args.fixture
        ? path.resolve(args.fixture)
        : path.join(os.homedir(), 'workspace/dual-fix-verify', `run-${Date.now()}`);
    if (args.fixture) {
        if (fs.existsSync(fixture)) {
            const stat = fs.statSync(fixture);
            if (!stat.isDirectory() || fs.readdirSync(fixture).length > 0) {
                throw new Error(`Refusing to use existing non-empty fixture path: ${fixture}`);
            }
        }
    }
    currentFixture = fixture;
    log(`fixture: ${fixture}`);
    const store = seedFixture(fixture);
    void store;
    const before = derive(fixture);
    const bindingBefore = null; // binding is created by the first dispatch; captured below

    // Phase 1: daemon #1 hangs in implement.
    const pid1 = spawnDaemon(fixture, 'hang');
    log(`daemon #1 spawned (launcher pid ${pid1}, detached)`);
    const daemonPid1 = await waitDaemonReady(fixture, 'hang');
    log(`daemon #1 ready pid=${daemonPid1}`);
    const client1 = createDaemonClient({ workspaceRoot: fixture });
    // The client's default RPC timeout is 500ms; worker dispatch legitimately
    // takes longer, so the repro (not the daemon) allows 30s here.
    const resume1 = await client1.resumeSession(SESSION_ID, { timeoutMs: 30000 });
    log(`resume #1: worker_running=${resume1.worker_running} resumed=${resume1.resumed}`);
    await waitFor(() => {
        // NOTE: the derived reference carries only hashes, not workerRoot;
        // resolve it through the binding like the production code does.
        const task = derive(fixture).tasks[TASK_ID];
        const reference = task?.isolatedWorkspace?.reference;
        if (!reference) return false;
        const { readTaskBinding } = require(path.join(REPO_ROOT, 'lib/dual/task-workspace'));
        let workerRoot;
        try { ({ workerRoot } = readTaskBinding(fixture, reference)); } catch { return false; }
        const eventsPath = path.join(workerRoot, '.omni/codex-gemini/runs', TASK_ID, 'events.ndjson');
        if (!fs.existsSync(eventsPath)) return false;
        const lines = fs.readFileSync(eventsPath, 'utf8');
        return lines.includes('"phase":"implement"') && lines.includes('"type":"phase.started"');
    }, 60000, 'implement phase.started under daemon #1');
    const orphan = derive(fixture).tasks[TASK_ID];
    const bindingSha = orphan.isolatedWorkspace.reference.bindingSha256;
    const baselineSha = orphan.isolatedWorkspace.reference.workerBaselineSha256;
    log(`orphan state captured: attempt=${orphan.isolatedWorkspace.attempt} binding=${bindingSha.slice(0, 16)}…`);
    log(`implement calls so far: ${implementCalls(fixture).length}`);

    // Phase 2: SIGKILL daemon #1, wait for the 120s lease to expire.
    await killDaemon(fixture, daemonPid1);
    log(`daemon #1 SIGKILLed; waiting for its 120s lease to expire…`);
    await waitFor(() => {
        const leases = Object.values(derive(fixture).leases);
        return leases.some((lease) => lease.task_id === TASK_ID && lease.status === 'expired');
    }, 200000, 'orphan lease to expire', () => log('  …still waiting for lease expiry'));
    const expired = derive(fixture);
    log(`lease expired; lastOutcome=${JSON.stringify(expired.tasks[TASK_ID].lastOutcome)} handoff=${JSON.stringify(expired.tasks[TASK_ID].isolatedHandoff)}`);

    // Phase 3: daemon #2 (fresh process, stale lock reclaimed) resumes.
    spawnDaemon(fixture, 'complete');
    const daemonPid2 = await waitDaemonReady(fixture, 'complete');
    log(`daemon #2 ready pid=${daemonPid2} (stale lock reclaimed)`);
    const client2 = createDaemonClient({ workspaceRoot: fixture });
    const resume2 = await client2.resumeSession(SESSION_ID, { timeoutMs: 30000 });
    log(`resume #2: worker_running=${resume2.worker_running} resumed=${resume2.resumed} worker_start=${JSON.stringify(resume2.worker_start)}`);
    await sleep(30000); // give the re-dispatched worker time to finish
    const after = derive(fixture);
    const taskAfter = after.tasks[TASK_ID];
    const callsAfter = implementCalls(fixture);
    const bug1Pass = Boolean(taskAfter.isolatedHandoff)
        && callsAfter.length >= 2
        && taskAfter.isolatedWorkspace?.attempt === 1
        && taskAfter.isolatedWorkspace?.reference?.bindingSha256 === bindingSha
        && taskAfter.isolatedWorkspace?.reference?.workerBaselineSha256 === baselineSha;
    log(`BUG 1 verdict: ${bug1Pass ? 'PASS' : 'FAIL'} (handoff=${Boolean(taskAfter.isolatedHandoff)} implementCalls=${callsAfter.length} attempt=${taskAfter.isolatedWorkspace?.attempt} bindingKept=${taskAfter.isolatedWorkspace?.reference?.bindingSha256 === bindingSha})`);

    // Phase 4: negative check (correction after redispatch must be rejected; reported only, exit code unchanged).
    let bug2Code = null;
    try {
        const corrected = await client2.correctTask(SESSION_ID, { task_id: TASK_ID, plan_revision: 1,
            request_id: `correct-after-kill-${crypto.randomUUID()}`, expected_attempt: 1, reason: 'Retry after daemon kill.' }, { timeoutMs: 15000 });
        bug2Code = `UNEXPECTED SUCCESS attempt=${corrected.attempt}`;
    } catch (error) {
        bug2Code = error.code || String(error.message || error);
    }
    const rejectedAsExpected = bug2Code === 'DUAL_INTEGRITY_CORRUPT';
    log(`Phase 4 negative check: task.correct -> ${bug2Code} (${rejectedAsExpected ? 'EXPECTED / REJECTED-AS-EXPECTED: correction after redispatch rejected as expected' : 'unexpected outcome'})`);

    // Cleanup: stop daemon #2 only (it is this script's own daemon).
    try { await client2.stop(); } catch {}
    if (pidAlive(daemonPid2)) { try { process.kill(daemonPid2, 'SIGTERM'); } catch {} }
    await sleep(1000);
    if (pidAlive(daemonPid2)) log(`WARNING: daemon #2 pid ${daemonPid2} still alive after stop; kill it manually`);
    log(`fixture kept at ${fixture}`);
    log(`SUMMARY: BUG1=${bug1Pass ? 'PASS' : 'FAIL'} CORRECTION_AFTER_REDISPATCH=${rejectedAsExpected ? 'EXPECTED (REJECTED-AS-EXPECTED)' : bug2Code}`);
    process.exit(bug1Pass ? 0 : 1);
}

async function main() {
    const [mode, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    if (mode === 'daemon') await daemonMain(args);
    else if (mode === 'run') await runMain(args);
    else { process.stderr.write('Usage: dual-resume-orphan-repro.js <run|daemon> [--fixture DIR] [--mode hang|complete]\n'); process.exit(2); }
}
main().catch((error) => { process.stderr.write(`[repro] FATAL: ${error.stack || error}\n`); process.exit(2); });
