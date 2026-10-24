#!/usr/bin/env node
'use strict';

// Standalone opt-in script. Never imported by the node:test suites.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// Live measurements 25/10/2026: scout 77–80s, implement 115–154s nominal
// with tails >240s, review 25–80s. Allow 900s handoff and 1800s QC
// (below the client ~50 minute RPC timeout), within a 3000s overall cap.
const DEADLINE_MS = 3000000;
const TASK_ID = 'TASK-FULLCYCLE-LIVE';
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
        console.log('Usage: OMNI_DUAL_LIVE=1 node test/dual-daemon-fullcycle-live.js <report-json-path>');
        return;
    }
    check(process.argv.length === 3 && !process.argv[2].startsWith('--'), 'REPORT_PATH_REQUIRED');
    const output = path.resolve(process.argv[2]);
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    const started = Date.now();
    const deadline = started + DEADLINE_MS;
    const names = ['setup', 'binaryPreflight', 'daemonListened', 'sessionBegun', 'planRegistered',
        'taskStarted', 'isolatedHandoff', 'codexQc', 'finalEvidence', 'daemonShutdown'];
    const report = { protocol: 'dual-daemon-fullcycle-live-v1', startedAt: new Date(started).toISOString(),
        ok: false, errorCode: null, errorMessage: null, failedStage: null,
        deadlineMs: DEADLINE_MS, taskId: TASK_ID, phasesExecuted: [], phasesCompleted: [],
        executionScope: 'session.resume runs the complete task; no phase-scoped client API',
        environment: { node: process.version, agyCommand: 'agy', codexCommand: '/usr/bin/codex',
            workerModel: MODEL, workerEffort: 'high', discussionEnabledEnv: 'unset' },
        stages: Object.fromEntries(names.map(name => [name,
            { ok: false, wallMs: 0, errorCode: 'NOT_RUN', errorMessage: 'Stage has not run' }])) };
    const save = () => {
        const temp = `${output}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, output);
    };
    let child, client, exited, childError, exitResult, root, runDir, authority, daemonEnv;
    report.phaseTimestamps = {};
    report.budgets = { handoffMs: 900000, qcMs: 1800000, overallMs: DEADLINE_MS };
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
    const taskEvents = () => runDir ? records(path.join(runDir, 'events.ndjson')) : [];
    function observe() {
        const task = authority?.derive().tasks[TASK_ID];
        // Binding identity is immutable per attempt: resolve the private
        // worker root once per binding instead of re-reading + re-hashing
        // binding.json on every 250ms poll (AGY review).
        if (task?.isolatedWorkspace && task.isolatedWorkspace.reference?.bindingSha256 !== report.workerBindingSha256) {
            const { workerRoot } = require('../lib/dual/task-workspace').readTaskBinding(root, task.isolatedWorkspace.reference);
            runDir = path.join(workerRoot, '.omni/codex-gemini/runs', TASK_ID);
            report.workerRoot = workerRoot;
            report.workerBindingSha256 = task.isolatedWorkspace.reference.bindingSha256;
        }
        for (const event of taskEvents()) {
            if (!['phase.started', 'phase.completed'].includes(event.type)) continue;
            const key = `${event.phase}:${event.type}`;
            report.phaseTimestamps[key] ||= { observedAt: new Date().toISOString(), event };
        }
        return task;
    }
    async function poll(predicate, limit, signal) {
        const until = Date.now() + limit;
        while (Date.now() < until && !signal.aborted) {
            if (childError) throw childError;
            if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
            const task = authority ? observe() : undefined;
            if (await predicate(task)) return;
            const failed = taskEvents().find(event => event.type === 'phase.failed');
            if (failed) { report.taskFailure = failed; throw failure(failed.error_code || 'TASK_PHASE_FAILED'); }
            if (task?.lastOutcome || task?.messages?.some(message => message.kind === 'question')) {
                report.taskDiagnostic = task;
                throw failure('ISOLATED_CONTROLLER_REQUIRED', 'Inspect taskDiagnostic for outcome or unanswered context');
            }
            await pause(250);
        }
        throw failure('STAGE_TIMEOUT', 'Evidence deadline reached');
    }
    save();
    const heartbeat = setInterval(() => {
        console.error(`[${activeStage}] elapsed ${Math.round((Date.now() - started) / 1000)}s`);
        try { if (authority) observe(); save(); } catch { /* Stage polling reports evidence errors. */ }
    }, 30000);
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
        await stage('binaryPreflight', 10000, async () => {
            daemonEnv = { ...process.env,
                PATH: [path.join(os.homedir(), '.local/bin'), '/usr/bin', process.env.PATH || ''].join(path.delimiter),
                OMNI_DUAL_WORKER_MODEL: MODEL, OMNI_DUAL_WORKER_EFFORT: 'high' };
            delete daemonEnv.OMNI_DUAL_DISCUSSION_ENABLED;
            const binary = daemonEnv.PATH.split(path.delimiter).map(dir => path.join(dir, 'codex')).find(file => {
                try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
            });
            check(binary && fs.realpathSync(binary) === fs.realpathSync('/usr/bin/codex'), 'CODEX_NOT_NPM');
            // Version probe only; all task/provider execution belongs to the daemon.
            const version = execFileSync(binary, ['--version'], { env: daemonEnv, encoding: 'utf8', timeout: 5000 }).trim();
            report.binary = { path: binary, realpath: fs.realpathSync(binary), version };
            check(version === 'codex-cli 0.164.0', 'CODEX_NOT_NPM', version);
        });
        await stage('daemonListened', 15000, async (limit, signal) => {
            report.daemonLog = path.join(path.dirname(root), 'daemon.log');
            const log = fs.openSync(report.daemonLog, 'wx', 0o600);
            try {
                child = spawn(process.execPath, [path.resolve(__dirname, '../bin/omni-daemon.js'), '--workspace', root],
                    { env: daemonEnv, detached: true, stdio: ['ignore', log, log] });
            } finally { fs.closeSync(log); }
            exited = new Promise(resolve => child.once('close', (code, signal) => {
                exitResult = { code, signal }; resolve(exitResult);
            }));
            child.on('error', error => { childError = error; });
            forceTimer = setTimeout(() => stopTree(child), Math.max(1, deadline - Date.now()));
            client = require('../lib/dual/daemon-client').createDaemonClient({ workspaceRoot: root, timeoutMs: 5000 });
            await poll(() => {
                try { report.daemon = client.readDiscovery(); return true; }
                catch (error) { if (error.code !== 'DUAL_DISCOVERY_MISSING') throw error; return false; }
            }, limit, signal);
            check((await client.health()).status === 'healthy', 'DAEMON_UNHEALTHY');
            authority = require('../lib/dual/authority-store').createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
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
                    owner: 'agy', execution_mode: 'isolated', model: MODEL, effort: 'high',
                    goal: 'Add Array.isArray guard in activeIds, throw TypeError("Expected array") for non-arrays, preserve array behavior.', risk: 'low', complexity: 'low', category: 'feature',
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
        await stage('isolatedHandoff', 900000, async (limit, signal) => {
            await poll(task => task?.isolatedHandoff && !Object.values(authority.derive().leases)
                .some(lease => lease.status === 'active'), limit, signal);
            report.handoff = observe().isolatedHandoff;
            report.handoffObservedAt = new Date().toISOString();
        });
        await stage('codexQc', 1800000, async (limit, signal) => {
            report.qcStartedAt = new Date().toISOString();
            report.qcResult = await client.completeIsolatedTask(report.sessionId, TASK_ID, 1, { timeoutMs: limit });
            // QC is a blocking synchronous RPC: non-verified outcomes arrive
            // as HTTP 200 payloads (WAITING_FOR_LEASE, WAITING_FOR_DEPENDENCY,
            // WAITING_FOR_SCOPE, NEEDS_FIX, CONFLICT), never as exceptions.
            // Fail fast on the actual status instead of polling up to 1800s
            // for a task.completed event that will never arrive (AGY review).
            check(report.qcResult.status === 'TASK_VERIFIED', report.qcResult.status || 'QC_NOT_VERIFIED',
                `Isolated QC did not verify: ${report.qcResult.status}`);
            // task.completed is written synchronously inside the QC RPC, so a
            // short bounded poll only covers event visibility, not QC work.
            await poll(() => authority.readEvents().some(event => event.type === 'task.completed'
                && event.task_id === TASK_ID && event.authority_state === 'TASK_VERIFIED'
                && event.verdict === 'SUCCESS' && event.verified_by === 'codex'), 10000, signal);
            check(observe().state === 'TASK_VERIFIED', 'TASK_NOT_VERIFIED');
            report.completion = authority.readEvents().findLast(event => event.type === 'task.completed' && event.task_id === TASK_ID);
            report.qcCompletedAt = new Date().toISOString();
        });
        await stage('finalEvidence', 15000, async () => {
            observe();
            for (const phase of ['scout', 'review', 'implement']) {
                check(taskEvents().some(event => event.type === 'phase.completed' && event.phase === phase), 'PHASE_MISSING', phase);
            }
            const util = path.join(root, 'lib/util.js');
            check(fs.readFileSync(util, 'utf8').includes('Array.isArray'), 'GUARD_MISSING');
            const { activeIds } = require(util);
            const assert = require('node:assert/strict');
            for (const value of [null, undefined, {}, 'x', 1]) assert.throws(() => activeIds(value),
                error => error instanceof TypeError && error.message === 'Expected array');
            assert.deepEqual(activeIds([]), []);
            assert.deepEqual(activeIds([{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true }]), [1, 3]);
            report.smokeOutput = execFileSync(process.execPath, ['--test', 'test/smoke.test.js'],
                { cwd: root, encoding: 'utf8', timeout: 10000 });
            const task = observe();
            const handoff = require('../lib/dual/isolated-authority').readAuthorityHandoff(root, task, authority.derive(), { readOnly: true });
            const evidence = json(path.join(runDir, 'evidence.json'));
            report.modifiedFiles = handoff.result.changes.map(change => change.path).sort();
            check(JSON.stringify(report.modifiedFiles) === JSON.stringify([...evidence.modified_files].sort()), 'MODIFIED_FILES_MISMATCH');
            check(JSON.stringify(report.modifiedFiles) === JSON.stringify(['lib/util.js']), 'UNEXPECTED_MODIFIED_FILES');
            for (const change of handoff.result.changes) check(createHash('sha256').update(fs.readFileSync(path.join(root, change.path)))
                .digest('hex') === change.afterSha256, 'INTEGRATED_HASH_MISMATCH');
            const dir = path.join(root, '.omni/runs/dual-discussion/isolated');
            report.journals = [];
            const { inspectJournal } = require('../lib/dual/discussion/journal');
            for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
                if (!name.endsWith('.manifest.json')) continue;
                const manifest = json(path.join(dir, name));
                if (manifest.namespace !== 'isolated' || manifest.session_id !== report.sessionId
                    || manifest.task_id !== TASK_ID || manifest.plan_revision !== 1
                    || manifest.workspace_binding_sha256 !== task.isolatedWorkspace.reference.bindingSha256) continue;
                const stateDir = path.join(dir, name.slice(0, -'.manifest.json'.length));
                const journal = await inspectJournal({ stateDir });
                const events = journal.events.map(record => record.event);
                const questions = events.filter(event => event.type === 'received' && event.envelope.kind === 'question').map(event => event.envelope);
                const replies = events.filter(event => event.type === 'response').map(event => event.response_envelope);
                const pairs = questions.filter(question => replies.some(reply => reply?.kind === 'reply' && reply.reply_to === question.message_id)).length;
                report.journals.push({ manifestPath: path.join(dir, name), stateDir, manifest, pairs });
            }
            check(report.journals.some(journal => journal.pairs >= 1), 'ISOLATED_DISCUSSION_PAIR_MISSING');
        });
    } catch { /* The failing stage has already recorded its exact error. */ }
    finally {
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
        try {
            if (authority) {
                observe();
                report.authorityTask = authority.derive().tasks[TASK_ID];
                report.authorityEvents = authority.readEvents();
            }
            if (!report.ok && report.daemonLog && fs.existsSync(report.daemonLog)) {
                report.daemonLogTail = require('../lib/dual/validator-security').redactDiagnostic(
                    fs.readFileSync(report.daemonLog, 'utf8').slice(-16000), { maxLength: 16000 });
            }
        } catch (error) { report.diagnosticError = error.code || error.message; }
        if (runDir) {
            const events = taskEvents();
            report.phasesExecuted = [...new Set(events.filter(event => event.type === 'phase.started').map(event => event.phase))];
            report.phasesCompleted = [...new Set(events.filter(event => event.type === 'phase.completed').map(event => event.phase))];
        }
        if (report.qcStartedAt) report.phasesExecuted.push('QC');
        if (report.stages.codexQc.ok) report.phasesCompleted.push('QC');
        report.ok = names.every(name => report.stages[name].ok);
        report.wallMs = Date.now() - started;
        save();
        console.error(`Report: ${output}; ${report.ok ? 'OK' : `${report.failedStage}: ${report.errorCode}`}`);
        process.exitCode = report.ok ? 0 : 1;
    }
}

main().catch(error => {
    console.error(`Live daemon stopped: ${error.code || 'LIVE_ERROR'}`);
    process.exitCode = 1;
});
