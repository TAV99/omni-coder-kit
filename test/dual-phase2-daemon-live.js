#!/usr/bin/env node
'use strict';

// Standalone opt-in script. Never imported by the node:test suites.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const DEADLINE_MS = 600000;
const TASK_ID = 'TASK-DAEMON-LIVE';
const MODEL = 'gemini-3.8-flash-high';
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function records(file) {
    if (!fs.existsSync(file)) return [];
    // A concurrently written last line is not yet durable evidence.
    return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
}
function check(value, code, message) { if (!value) throw failure(code, message); }

async function daemonChild(workspaceRoot) {
    const { startDaemonServer } = require('../lib/dual/daemon-server');
    const { createAuthorityStore } = require('../lib/dual/authority-store');
    const { createDaemonServerOptions } = require('../bin/omni-daemon');
    // Omit orchestrator so the production factory wires the default-on host.
    // No injected preflight, providers, seeds, ledger, or artifact verifier.
    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot,
            authorityStore: createAuthorityStore(path.join(workspaceRoot, '.omni/runs/dual-authority')) }),
        agyCommand: 'agy',
    });
    process.send({ ready: true, address: daemon.address, pid: process.pid,
        discussionEnvUnset: process.env.OMNI_DUAL_DISCUSSION_ENABLED === undefined });
    const shutdown = () => daemon.close().catch(error => {
        process.stderr.write(`Shutdown failed: ${error.code || 'ERROR'}\n`);
        process.exitCode = 1;
    });
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await daemon.stopped;
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    process.disconnect();
}

// Provider runners may detach their process groups. Reap descendants on timeout.
function stopTree(child) {
    if (!child?.pid) return;
    const ids = new Set([child.pid]);
    try {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
            .trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
        let added;
        do {
            added = false;
            for (const [pid, ppid] of rows) if (ids.has(ppid) && !ids.has(pid)) {
                ids.add(pid); added = true;
            }
        } while (added);
    } catch { /* Still kill the known daemon process/group. */ }
    for (const pid of [...ids].reverse()) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* Not a group leader. */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
}

async function main() {
    if (process.env.OMNI_DUAL_LIVE !== '1') {
        console.log('Usage: OMNI_DUAL_LIVE=1 node test/dual-phase2-daemon-live.js <report-json-path>');
        return;
    }
    if (process.argv[2] === '--daemon-child') return daemonChild(process.argv[3]);
    check(process.argv.length === 3 && !process.argv[2].startsWith('--'), 'REPORT_PATH_REQUIRED');
    const output = path.resolve(process.argv[2]);
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    const started = Date.now();
    const deadline = started + DEADLINE_MS;
    const names = ['setup', 'daemonListened', 'sessionBegun', 'planRegistered', 'taskStarted',
        'scoutCompleted', 'discussionJournal', 'attemptTransport', 'taskCompleted', 'daemonShutdown'];
    const report = { protocol: 'p2-g4-daemon-live-v1', startedAt: new Date(started).toISOString(),
        ok: false, errorCode: null, errorMessage: null, failedStage: null,
        deadlineMs: DEADLINE_MS, taskId: TASK_ID, phasesExecuted: [], phasesCompleted: [],
        executionScope: 'session.resume runs the complete task; no phase-scoped client API',
        environment: { node: process.version, agyCommand: 'agy', codexCommand: '/usr/bin/codex',
            workerModel: MODEL, discussionEnabledEnv: 'unset' },
        stages: Object.fromEntries(names.map(name => [name,
            { ok: false, errorCode: 'NOT_RUN', errorMessage: 'Stage has not run' }])) };
    const save = () => {
        const temp = `${output}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, output);
    };
    let child, client, exited, childError, exitResult, root, runDir;
    let activeStage = 'setup';
    let forceTimer;
    const rememberError = (name, error) => {
        if (report.failedStage) return;
        report.failedStage = name;
        report.errorCode = error.code || 'LIVE_ERROR';
        report.errorMessage = require('../lib/dual/validator-security').redactDiagnostic(error.message);
    };
    async function stage(name, timeoutMs, action) {
        activeStage = name;
        const time = Date.now();
        console.error(`[${name}] started`);
        const limit = Math.max(1, Math.min(timeoutMs, deadline - Date.now()
            - (name === 'daemonShutdown' ? 0 : 15000)));
        let timer;
        const controller = new AbortController();
        try {
            const result = await Promise.race([action(limit, controller.signal), new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('STAGE_TIMEOUT', `${name} exceeded ${limit}ms`)), limit);
            })]);
            report.stages[name] = { ok: true, errorCode: null, errorMessage: null, wallMs: Date.now() - time };
            console.error(`[${name}] OK`);
            return result;
        } catch (error) {
            rememberError(name, error);
            report.stages[name] = { ok: false, errorCode: error.code || 'LIVE_ERROR',
                errorMessage: require('../lib/dual/validator-security').redactDiagnostic(error.message),
                wallMs: Date.now() - time };
            console.error(`[${name}] ${report.stages[name].errorCode}`);
            throw error;
        } finally { controller.abort(); clearTimeout(timer); save(); }
    }
    const taskEvents = () => records(path.join(runDir, 'events.ndjson'));
    async function waitTask(predicate, timeoutMs, signal) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            if (signal.aborted) throw failure('STAGE_CANCELLED');
            const events = taskEvents();
            if (predicate(events)) return;
            const failed = events.find(event => event.type === 'phase.failed');
            if (failed) {
                report.taskFailure = failed;
                throw failure(failed.error_code || 'TASK_PHASE_FAILED', `${failed.phase} failed`);
            }
            const leases = Object.values((await client.status(report.sessionId, { timeoutMs: 3000 })).leases || {});
            const released = leases.find(lease => lease.task_id === TASK_ID && lease.status === 'released');
            if (released) throw failure('TASK_INCOMPLETE', released.release_reason || 'Task lease released before completion');
            if (childError) throw childError;
            if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
            await pause(250);
        }
        throw failure('STAGE_TIMEOUT', 'Task evidence did not arrive within the stage deadline');
    }
    save();
    const heartbeat = setInterval(() => console.error(`[${activeStage}] elapsed ${Math.round((Date.now() - started) / 1000)}s`), 30000);
    try {
        await stage('setup', 10000, async () => {
            root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-daemon-live-')), 'workspace');
            fs.mkdirSync(root);
            report.workspaceRoot = root; // Retain evidence for inspection after failure/success.
            runDir = path.join(root, '.omni/codex-gemini/runs', TASK_ID);
            const { buildCodexConfig, buildCodexHooks } = require('../lib/init');
            const opts = { dualPair: 'codex-agy', mode: 'auto', projectDir: root };
            const fixture = {
                'entry.js': "'use strict';\nmodule.exports = require('./lib/util');\n",
                'lib/util.js': "'use strict';\nfunction activeIds(xs) {\n    return xs.filter(x => x.active).map(x => x.id);\n}\nmodule.exports = { activeIds };\n",
                'test/smoke.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { activeIds } = require('../entry');\ntest('active ids', () => assert.deepEqual(activeIds([{ id: 1, active: true }]), [1]));\n",
                'README.md': '# Live daemon fixture\nactiveIds returns ids of active records. Run node --test test/smoke.test.js.\n',
                'plans/plan.md': '# Tiny task\nAdd an Array.isArray guard to activeIds in lib/util.js; throw TypeError("Expected array") for non-arrays. Preserve array behavior.\n',
                '.codex/config.toml': buildCodexConfig('dual', true, opts),
                '.codex/hooks.json': buildCodexHooks('dual', true, opts),
                '.omni/manifest.json': JSON.stringify({ workerModel: MODEL, workerEffort: 'high' }),
            };
            for (const [file, content] of Object.entries(fixture)) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.writeFileSync(path.join(root, file), content);
            }
            report.planSha256 = createHash('sha256').update(fixture['plans/plan.md']).digest('hex');
        });
        await stage('daemonListened', 15000, async () => {
            const env = { ...process.env, PATH: path.join(os.homedir(), '.local/bin') + path.delimiter + (process.env.PATH || ''),
                OMNI_DUAL_WORKER_MODEL: MODEL, OMNI_DUAL_WORKER_EFFORT: 'high' };
            delete env.OMNI_DUAL_DISCUSSION_ENABLED;
            report.daemonLog = path.join(path.dirname(root), 'daemon.log');
            const log = fs.openSync(report.daemonLog, 'wx', 0o600);
            try {
                child = fork(__filename, ['--daemon-child', root], { env, detached: true,
                    stdio: ['ignore', log, log, 'ipc'] });
            } finally { fs.closeSync(log); }
            exited = new Promise(resolve => child.once('close', (code, signal) => {
                exitResult = { code, signal }; resolve(exitResult);
            }));
            child.on('error', error => { childError = error; });
            forceTimer = setTimeout(() => stopTree(child), Math.max(1, deadline - Date.now()));
            const ready = await new Promise((resolve, reject) => {
                child.once('message', resolve);
                child.once('error', reject);
                child.once('exit', (code, signal) => reject(failure('DAEMON_START_FAILED', `exit=${code} signal=${signal}`)));
            });
            if (ready.errorCode) throw failure(ready.errorCode, ready.errorMessage);
            check(ready.ready && ready.address?.host === '127.0.0.1' && ready.address.port > 0
                && ready.discussionEnvUnset, 'DAEMON_READY_INVALID');
            report.daemon = { pid: ready.pid, ...ready.address };
            const { createDaemonClient } = require('../lib/dual/daemon-client');
            client = createDaemonClient({ workspaceRoot: root, timeoutMs: 5000 });
            check(client.readDiscovery().port === ready.address.port, 'DISCOVERY_PORT_MISMATCH');
            check((await client.health()).status === 'healthy', 'DAEMON_UNHEALTHY');
        });
        await stage('sessionBegun', 15000, async limit => {
            const result = await client.beginSession({ workspace_root: root, mode: 'auto' }, { timeoutMs: limit });
            check(result.session_id, 'SESSION_ID_MISSING');
            report.sessionId = result.session_id;
            report.baseline = result.expected_baseline;
        });
        await stage('planRegistered', 60000, async limit => {
            const result = await client.registerPlan(report.sessionId, {
                plan_path: 'plans/plan.md', plan_sha256: report.planSha256, plan_revision: 1,
                acceptance_policy: { protocol_version: 1, checks: [], ui: { required: false,
                    viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } },
                tasks: [{ task_id: TASK_ID, title: 'Add Array.isArray guard to activeIds; throw TypeError("Expected array") for non-arrays; preserve array behavior.',
                    owner: 'agy', risk: 'low', complexity: 'low', category: 'feature',
                    allowed_files: ['lib/util.js'], deny_patterns: [],
                    context_files: ['README.md', 'entry.js', 'lib/util.js', 'test/smoke.test.js'],
                    validation_commands: [{ program: 'node', args: ['--test', 'test/smoke.test.js'], cwd: '.' }] }],
            }, { timeoutMs: limit });
            check(result.registered === true, 'PLAN_NOT_REGISTERED');
            check(result.tasks.find(task => task.task_id === TASK_ID)?.owner === 'agy', 'TASK_NOT_AGY_OWNED');
        });
        await stage('taskStarted', 10000, async limit => {
            check((await client.resumeSession(report.sessionId, { timeoutMs: limit })).resumed === true, 'TASK_NOT_RESUMED');
        });
        await stage('scoutCompleted', 240000, async (limit, signal) => {
            await waitTask(events => events.some(event => event.type === 'phase.completed' && event.phase === 'scout'), limit, signal);
            const { ContextSchema, normalizeBaselineCorrelation } = require('../lib/dual/contracts');
            const context = ContextSchema.parse(json(path.join(runDir, 'context.json')));
            check(context.task_id === TASK_ID && JSON.stringify(normalizeBaselineCorrelation(context))
                === JSON.stringify(report.baseline), 'SCOUT_CORRELATION_INVALID');
        });
    } catch { /* The failing stage has already recorded its exact error. */ }
    finally {
        // Inspect independently even if SCOUT/provider execution failed.
        if (runDir && report.stages.taskStarted.ok) {
            try {
                await stage('discussionJournal', 5000, async () => {
                    const { inspectJournal } = require('../lib/dual/discussion/journal');
                    const dir = path.join(root, '.omni/runs/dual-discussion');
                    const journals = [];
                    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
                        const stateDir = path.join(dir, name);
                        const journal = await inspectJournal({ stateDir });
                        const events = journal.events.map(record => record.event);
                        const opened = events.find(event => event.type === 'registered');
                        if (!opened?.bindings?.every(binding => binding.task_id === TASK_ID
                            && binding.session_id === report.sessionId)) continue;
                        const questions = events.filter(event => event.type === 'received' && event.envelope.kind === 'question')
                            .map(event => event.envelope);
                        const replies = events.filter(event => event.type === 'response').map(event => event.response_envelope);
                        const pairs = questions.filter(question => replies.some(reply => reply?.kind === 'reply'
                            && reply.reply_to === question.message_id)).length;
                        journals.push({ path: path.join(stateDir, 'journal.jsonl'), pairs });
                    }
                    report.journals = journals;
                    check(journals.some(journal => journal.pairs >= 1), 'DISCUSSION_PAIR_MISSING');
                });
            } catch { /* Preserve primary blockage. */ }
            try {
                await stage('attemptTransport', 5000, async () => {
                    const dir = path.join(runDir, 'raw');
                    report.scoutAttempts = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
                        .filter(file => /^scout\.\d+\.meta\.json$/.test(file))
                        .map(file => ({ path: path.join(dir, file), meta: json(path.join(dir, file)) }));
                    check(report.scoutAttempts.some(({ meta }) => meta.task_id === TASK_ID
                        && meta.phase === 'scout' && meta.transport === 'discussion'), 'DISCUSSION_TRANSPORT_MISSING');
                });
            } catch { /* Preserve primary blockage. */ }
            if (report.stages.scoutCompleted.ok) {
                try {
                    // Budget evidence (25/10/2026, 2 live runs): nominal post-scout
                    // chain (implement ~115-154s + review ~25-80s) ≈ 180s, but the
                    // provider-latency tail exceeds 240s (run 1: implement never
                    // returned inside 240s). 480s keeps the proof from flaking on
                    // tail latency; the overall 600s deadline cap still applies.
                    await stage('taskCompleted', 480000, async (limit, signal) => {
                        await waitTask(events => events.some(event => event.type === 'phase.completed' && event.phase === 'review'), limit, signal);
                        report.taskState = json(path.join(runDir, 'state.json')).state;
                        check(['CODEX_QC', 'REVIEW_VALID'].includes(report.taskState), 'TASK_FLOW_INCOMPLETE');
                    });
                } catch { /* Preserve primary blockage. */ }
            }
        }
        try {
            await stage('daemonShutdown', 10000, async limit => {
                check(child && client, 'DAEMON_UNAVAILABLE', 'Daemon did not reach client readiness');
                check(!exitResult, 'DAEMON_ALREADY_EXITED');
                await client.stop({ timeoutMs: Math.min(limit, 5000) });
                const result = await exited;
                report.daemonExit = result;
                check(result.code === 0 && result.signal === null, 'DAEMON_UNCLEAN_EXIT');
                let missing = false;
                try { client.readDiscovery(); } catch (error) { missing = error.code === 'DUAL_DISCOVERY_MISSING'; }
                check(missing, 'DAEMON_DISCOVERY_NOT_REMOVED');
            });
        } catch { if (child && !exitResult) stopTree(child); }
        clearTimeout(forceTimer);
        clearInterval(heartbeat);
        if (runDir) {
            const events = taskEvents();
            report.phasesExecuted = [...new Set(events.filter(event => event.type === 'phase.started').map(event => event.phase))];
            report.phasesCompleted = [...new Set(events.filter(event => event.type === 'phase.completed').map(event => event.phase))];
        }
        report.ok = names.every(name => report.stages[name].ok);
        report.wallMs = Date.now() - started;
        save();
        console.error(`Report: ${output}; ${report.ok ? 'OK' : `${report.failedStage}: ${report.errorCode}`}`);
        process.exitCode = report.ok ? 0 : 1;
    }
}

main().catch(error => {
    if (process.argv[2] === '--daemon-child' && process.connected) {
        process.send({ errorCode: error.code || 'DAEMON_START_FAILED',
            errorMessage: require('../lib/dual/validator-security').redactDiagnostic(error.message) }, () => process.disconnect());
    }
    console.error(`Live daemon stopped: ${error.code || 'LIVE_ERROR'}`);
    process.exitCode = 1;
});
