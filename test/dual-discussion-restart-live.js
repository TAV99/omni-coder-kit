#!/usr/bin/env node
'use strict';

// Standalone opt-in proof; never import from node:test. Requires real providers.
// Scope: full restart (daemon AND every worker die), analogous to VM restart.
// Daemon-only death with detached live orphan workers is NOT proved here.
// Both cases wait >5 real minutes; never backdate locks or lower the mtime rule.
// Shared completion means all worker phases through review, awaiting Codex QC;
// the shared adapter does not grant TASK_VERIFIED automatically.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { inspectJournal } = require('../lib/dual/discussion/journal');
const { redactDiagnostic } = require('../lib/dual/validator-security');

const MODEL = 'gemini-3.8-flash-high';
const OVERALL_MS = 4800000;
const PROVIDER_MS = 1200000; // Measured implement tails exceed 240s.
const STALE_WAIT_MS = 301000;
let activeCleanup;
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const check = (value, code, message) => { if (!value) throw failure(code, message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const records = file => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : [];
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function processRows() {
    return execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 })
        .trim().split('\n').filter(Boolean).map(row => row.trim().split(/\s+/).map(Number));
}
function descendants(rootPid, rows) {
    const ids = new Set([rootPid]);
    let added;
    do {
        added = false;
        for (const [pid, ppid] of rows) if (ids.has(ppid) && !ids.has(pid)) {
            ids.add(pid); added = true;
        }
    } while (added);
    return ids;
}
function signal(pid, name) {
    try { process.kill(pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
}
// Stop the parent before enumerating so it cannot create fresh worker branches.
// Enumerate/freeze descendants twice before killing, including detached groups.
function killTree(child, knownPids) {
    if (!child?.pid) return [];
    signal(child.pid, 'SIGSTOP');
    const found = descendants(child.pid, processRows());
    for (const pid of found) { knownPids.add(pid); signal(pid, 'SIGSTOP'); }
    for (const pid of descendants(child.pid, processRows())) {
        found.add(pid); knownPids.add(pid); signal(pid, 'SIGSTOP');
    }
    for (const pid of [...found].reverse()) signal(pid, 'SIGKILL');
    return [...found];
}
async function waitDead(pids, deadline) {
    while (Date.now() < deadline) {
        const rows = execFileSync('ps', ['-eo', 'pid=,stat='], { encoding: 'utf8', timeout: 3000 })
            .trim().split('\n').map(row => row.trim().split(/\s+/));
        // Zombies are terminal and cannot invoke providers; parents may reap later.
        if (!rows.some(([pid, stat]) => pids.includes(Number(pid)) && !stat.startsWith('Z'))) return;
        await pause(100);
    }
    throw failure('WORKER_TREE_STILL_ALIVE');
}

async function runCase(kind, report, save, overallDeadline) {
    const taskId = `TASK-RESTART-${kind.toUpperCase()}`;
    const item = report.cases[kind] = { taskId, ok: false, stages: {}, evidence: {}, wallMs: 0 };
    const started = Date.now();
    const knownPids = new Set();
    let child, client, childError, exitResult, root, runDir, before, stateDir, killedAt, originalSource;
    let forceTimer;
    const deadline = Math.min(overallDeadline, started + 2300000);
    const env = { ...process.env,
        PATH: [path.join(os.homedir(), '.local/bin'), '/usr/bin', process.env.PATH || ''].join(path.delimiter),
        OMNI_DUAL_WORKER_MODEL: MODEL, OMNI_DUAL_WORKER_EFFORT: 'high' };
    delete env.OMNI_DUAL_DISCUSSION_ENABLED;
    delete env.OMNI_DUAL_DISCUSSION_RECLAIM_STALE_OWNER;
    const taskEvents = () => records(path.join(runDir, 'events.ndjson'));
    async function stage(name, budget, action) {
        const time = Date.now();
        const until = Math.min(deadline, time + budget);
        const controller = new AbortController();
        let timer;
        item.activeStage = name;
        console.error(`[${kind}/${name}] started`);
        try {
            await Promise.race([action(until, controller.signal), new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('STAGE_TIMEOUT', `${kind}/${name}`)), Math.max(1, until - Date.now()));
            })]);
            item.stages[name] = { ok: true, wallMs: Date.now() - time };
        } catch (error) {
            item.stages[name] = { ok: false, wallMs: Date.now() - time,
                errorCode: error.code || 'LIVE_ERROR', errorMessage: redactDiagnostic(error.message) };
            throw error;
        } finally { controller.abort(); clearTimeout(timer); save(); }
    }
    async function poll(predicate, until, abort, allowFailure = false) {
        while (!abort.aborted && Date.now() < until) {
            if (childError) throw childError;
            if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
            if (await predicate()) return;
            const failed = taskEvents().find(event => event.type === 'phase.failed' && event.retryable !== true);
            if (failed && !allowFailure) {
                item.taskFailure = failed;
                throw failure(failed.error_code || 'TASK_PHASE_FAILED', failed.phase);
            }
            await pause(25);
        }
        throw failure('STAGE_TIMEOUT', 'Expected durable state was not observed');
    }
    async function findJournal() {
        const directory = path.join(root, '.omni/runs/dual-discussion');
        for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
            const candidate = path.join(directory, name);
            if (!fs.statSync(candidate).isDirectory() || name === 'isolated') continue;
            // Read complete lines only while a provider may be appending. Final
            // assertions use inspectJournal's full parser, hash chain and caps.
            const events = records(path.join(candidate, 'journal.jsonl'));
            const registration = events[0]?.event;
            if (registration?.type === 'registered' && registration.bindings.every(binding =>
                binding.task_id === taskId && binding.session_id === item.sessionId)) return candidate;
        }
        return null;
    }
    async function startDaemon(recovery, until, abort) {
        childError = null; exitResult = null;
        const logPath = path.join(path.dirname(root), recovery ? 'daemon-restart.log' : 'daemon-initial.log');
        item.evidence[recovery ? 'restartLog' : 'initialLog'] = logPath;
        const fd = fs.openSync(logPath, 'wx', 0o600);
        try {
            child = spawn(process.execPath, [path.resolve(__dirname, '../bin/omni-daemon.js'), '--workspace', root],
                { detached: true, env: { ...env, ...(recovery ? { OMNI_DUAL_DISCUSSION_RECLAIM_STALE_OWNER: '1' } : {}) },
                    stdio: ['ignore', fd, fd] });
        } finally { fs.closeSync(fd); }
        knownPids.add(child.pid);
        child.once('error', error => { childError = error; });
        child.once('close', (code, signalName) => { exitResult = { code, signal: signalName }; });
        client = require('../lib/dual/daemon-client').createDaemonClient({ workspaceRoot: root, timeoutMs: 5000 });
        await poll(async () => {
            try {
                const discovery = client.readDiscovery();
                if (discovery.pid !== child.pid) return false;
                return (await client.health({ timeoutMs: 1000 })).status === 'healthy';
            } catch (error) {
                if (['DUAL_DISCOVERY_MISSING', 'ECONNREFUSED', 'DUAL_DAEMON_UNAVAILABLE'].includes(error.code)) return false;
                throw error;
            }
        }, until, abort);
        item[recovery ? 'restartPid' : 'initialPid'] = child.pid;
    }
    activeCleanup = () => {
        if (child && !exitResult) killTree(child, knownPids);
        for (const pid of knownPids) signal(pid, 'SIGKILL');
    };
    forceTimer = setTimeout(() => {
        try { killTree(child, knownPids); } catch { for (const pid of knownPids) { try { signal(pid, 'SIGKILL'); } catch { /* best effort */ } } }
    }, Math.max(1, deadline - Date.now()));
    try {
        await stage('setup', 10000, async () => {
            root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `omni-shared-${kind}-`)), 'workspace');
            fs.mkdirSync(root);
            runDir = path.join(root, '.omni/codex-gemini/runs', taskId);
            item.evidence.workspaceRoot = root;
            item.evidence.taskEvents = path.join(runDir, 'events.ndjson');
            item.evidence.authorityDir = path.join(root, '.omni/runs/dual-authority');
            const { buildCodexConfig, buildCodexHooks } = require('../lib/init');
            const options = { dualPair: 'codex-agy', mode: 'auto', projectDir: root };
            const files = {
                'entry.js': "'use strict';\nmodule.exports = require('./lib/util');\n",
                'lib/util.js': "'use strict';\nfunction activeIds(xs) { return xs.filter(x => x.active).map(x => x.id); }\nmodule.exports = { activeIds };\n",
                'test/smoke.test.js': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { activeIds } = require('../entry');\ntest('active ids', () => assert.deepEqual(activeIds([{ id: 1, active: true }]), [1]));\n",
                'README.md': '# Restart fixture\nactiveIds returns active record ids. Validate with node --test test/smoke.test.js.\n',
                'plans/plan.md': '# Guard\nAdd Array.isArray guard to activeIds, throwing TypeError("Expected array") for non-arrays. Preserve array behavior.\n',
                '.codex/config.toml': buildCodexConfig('dual', true, options),
                '.codex/hooks.json': buildCodexHooks('dual', true, options),
                '.omni/manifest.json': JSON.stringify({ workerModel: MODEL, workerEffort: 'high' }),
            };
            for (const [file, contents] of Object.entries(files)) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.writeFileSync(path.join(root, file), contents);
            }
            originalSource = files['lib/util.js'];
            item.planSha256 = createHash('sha256').update(files['plans/plan.md']).digest('hex');
        });
        await stage('daemonInitial', 15000, (until, abort) => startDaemon(false, until, abort));
        await stage('register', 60000, async until => {
            const begun = await client.beginSession({ workspace_root: root, mode: 'auto' }, { timeoutMs: until - Date.now() });
            item.sessionId = begun.session_id;
            check(item.sessionId, 'SESSION_ID_MISSING');
            const result = await client.registerPlan(item.sessionId, {
                plan_path: 'plans/plan.md', plan_sha256: item.planSha256, plan_revision: 1,
                acceptance_policy: { protocol_version: 1, checks: [], ui: { required: false,
                    viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } },
                tasks: [{ task_id: taskId, owner: 'agy', model: MODEL, effort: 'high',
                    title: 'Add Array.isArray guard to activeIds, throwing TypeError("Expected array") for non-arrays. Preserve array behavior.',
                    risk: 'low', complexity: 'low', category: 'feature', allowed_files: ['lib/util.js'], deny_patterns: [],
                    context_files: ['README.md', 'entry.js', 'lib/util.js', 'test/smoke.test.js'],
                    validation_commands: [{ program: 'node', args: ['--test', 'test/smoke.test.js'], cwd: '.' }] }],
            }, { timeoutMs: until - Date.now() });
            check(result.registered, 'PLAN_NOT_REGISTERED');
            check((await client.resumeSession(item.sessionId)).resumed, 'TASK_NOT_RESUMED');
        });
        await stage('killAtJournalState', PROVIDER_MS, async (until, abort) => {
            await poll(async () => {
                stateDir ||= await findJournal();
                if (!stateDir) return false;
                // A torn append is transient before stopping the tree, never proof.
                let view;
                try { view = await inspectJournal({ stateDir }); }
                catch (error) { if (error.code === 'JOURNAL_INVALID') return false; throw error; }
                const events = view.events.map(record => record.event);
                const receivedQuestion = events.some(event => event.type === 'received' && event.envelope.kind === 'question');
                const ready = kind === 'dirty' ? view.hasUnresolvedUnknown && receivedQuestion
                    : !view.hasUnresolvedUnknown && events.some(event => event.type === 'response')
                        && taskEvents().some(event => event.type === 'phase.started' && event.phase === 'implement')
                        && !taskEvents().some(event => event.type === 'phase.completed' && event.phase === 'implement')
                        && fs.readFileSync(path.join(root, 'lib/util.js'), 'utf8') === originalSource;
                if (!ready) return false;
                item.killedPids = killTree(child, knownPids);
                killedAt = Date.now();
                await waitDead(item.killedPids, Math.min(until, Date.now() + 10000));
                // These PIDs have terminal evidence. Never signal them again
                // after the five-minute wait, when a PID could have been reused.
                knownPids.clear();
                before = await inspectJournal({ stateDir });
                check(kind === 'dirty' ? before.hasUnresolvedUnknown : !before.hasUnresolvedUnknown, 'KILL_STATE_RACED');
                // Existing baseline gates require an unmodified workspace when
                // restarting an unfinished implement. Do not restore worker edits.
                if (kind === 'clean') check(fs.readFileSync(path.join(root, 'lib/util.js'), 'utf8') === originalSource,
                    'KILL_AFTER_WORKSPACE_MUTATION', 'Worker changed source before full-tree kill; retain evidence and rerun');
                item.killEvidence = { killedAt: new Date(killedAt).toISOString(),
                    journalEvents: before.events.length, lastHash: before.lastHash,
                    unknown: before.unresolvedInvocations, owner: before.owner,
                    taskEvents: taskEvents() };
                item.evidence.journal = path.join(stateDir, 'journal.jsonl');
                item.evidence.ownerLock = path.join(stateDir, 'owner.lock');
                return true;
            }, until, abort);
        });
        await stage('realStaleWait', STALE_WAIT_MS + 15000, async (until, abort) => {
            const lockMtime = fs.statSync(path.join(stateDir, 'owner.lock')).mtimeMs;
            const resumeAfter = Math.max(killedAt + STALE_WAIT_MS, lockMtime + STALE_WAIT_MS);
            while (Date.now() < resumeAfter && !abort.aborted) {
                check(Date.now() < until, 'STALE_WAIT_TIMEOUT');
                await pause(Math.min(1000, resumeAfter - Date.now()));
            }
            check(!abort.aborted && Date.now() - killedAt > 300000, 'REAL_WAIT_TOO_SHORT');
            item.realWaitMs = Date.now() - killedAt;
            item.lockAgeMs = Date.now() - lockMtime;
        });
        await stage('daemonRestart', 15000, (until, abort) => startDaemon(true, until, abort));
        await stage('resume', 120000, async (until, abort) => {
            const beforeStatus = await client.status(item.sessionId, { timeoutMs: 5000 });
            const knownLeases = new Set(Object.keys(beforeStatus.leases || {}));
            const previousReleases = new Map(Object.entries(beforeStatus.leases || {})
                .map(([id, lease]) => [id, lease.released_at || lease.releasedAt || null]));
            const phaseSequence = Math.max(0, ...taskEvents().map(event => event.sequence));
            item.resume = await client.resumeSession(item.sessionId, { timeoutMs: Math.min(15000, until - Date.now()) });
            let status = item.resume;
            const notStarted = () => {
                // Reclaim can release a pre-restart lease too. Preserve that
                // lease.released reason, rather than looking only at new IDs.
                const released = Object.entries(status.leases || {}).findLast(([id, lease]) =>
                    lease.task_id === taskId && (lease.status === 'released' || lease.released_at || lease.releasedAt)
                    && (!knownLeases.has(id) || (lease.released_at || lease.releasedAt || null) !== previousReleases.get(id)))?.[1];
                const reason = released?.release_reason || released?.releaseReason
                    || status.worker_start?.error?.message || 'No new lease or phase event within 120s';
                item.resumeFailure = { code: 'WORKER_NOT_STARTED', reason,
                    lease: released || null, worker_start: status.worker_start || null };
                return failure('WORKER_NOT_STARTED', reason);
            };
            while (!abort.aborted && Date.now() < until - 250) {
                if (childError) throw childError;
                if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
                status = await client.status(item.sessionId, { timeoutMs: Math.max(1, Math.min(3000, until - Date.now() - 100)) });
                const newLease = Object.entries(status.leases || {}).find(([id, lease]) =>
                    !knownLeases.has(id) && lease.task_id === taskId);
                const events = taskEvents();
                const newPhase = events.find(event => event.sequence > phaseSequence
                    && event.type.startsWith('phase.'));
                const expectedDirtyBlock = kind === 'dirty' && events.some(event =>
                    event.sequence > phaseSequence && event.type === 'phase.failed'
                    && event.error_code === 'OUTCOME_UNKNOWN');
                if (status.worker_start?.state === 'failed' && !expectedDirtyBlock) throw notStarted();
                if (newLease || newPhase) {
                    item.resumeProgress = { lease: newLease?.[1] || null, phaseEvent: newPhase || null,
                        worker_start: status.worker_start };
                    return;
                }
                if (status.worker_start?.state === 'failed' || status.worker_start?.state === 'completed') throw notStarted();
                await pause(100);
            }
            throw notStarted();
        });
        await stage('terminalEvidence', PROVIDER_MS, async (until, abort) => {
            await poll(async () => {
                const view = await inspectJournal({ stateDir });
                const events = taskEvents();
                if (kind === 'clean') {
                    if (!events.some(event => event.type === 'phase.completed' && event.phase === 'review')) return false;
                    const status = await client.status(item.sessionId);
                    const leases = Object.values(status.leases || {});
                    return leases.some(lease => lease.task_id === taskId && lease.status === 'released'
                        && lease.release_reason === 'agy_reviewed_awaiting_codex_qc')
                        && !leases.some(lease => lease.task_id === taskId && lease.status === 'active');
                }
                const failed = events.findLast(event => event.type === 'phase.failed');
                return view.hasUnresolvedUnknown && failed?.error_code === 'OUTCOME_UNKNOWN';
            }, until, abort, kind === 'dirty');
            const after = await inspectJournal({ stateDir });
            const events = after.events.map(record => record.event);
            const registrations = events.filter(event => event.type === 'registered');
            check(registrations.length === 1, 'CONVERSATION_RESEEDED');
            assert.deepEqual(registrations[0], before.events[0].event);
            assert.deepEqual(after.events.slice(0, before.events.length), before.events);
            const intents = events.filter(event => event.type === 'dispatch_intent');
            check(new Set(intents.map(event => event.invocation_id)).size === intents.length, 'DUPLICATE_INVOCATION');
            check(new Set(intents.map(event => event.message_id)).size === intents.length, 'DUPLICATE_MESSAGE_DISPATCH');
            const archives = fs.readdirSync(stateDir).filter(name => /^owner\.lock\.reclaimed\./.test(name));
            check(archives.length > 0, 'RECLAIM_ARCHIVE_MISSING');
            item.evidence.archives = archives.map(name => path.join(stateDir, name));
            const namespace = path.dirname(stateDir);
            const matchingDirectories = [];
            for (const name of fs.readdirSync(namespace)) {
                const candidate = path.join(namespace, name);
                if (name === 'isolated' || !fs.statSync(candidate).isDirectory()) continue;
                const registered = records(path.join(candidate, 'journal.jsonl')).filter(record => record.event.type === 'registered');
                for (const record of registered) if (record.event.bindings?.some(binding => binding.task_id === taskId
                    && binding.session_id === item.sessionId)) matchingDirectories.push(candidate);
            }
            assert.deepEqual(matchingDirectories, [stateDir], 'No alternate execution namespace or fresh seed registration');
            item.registration = registrations[0];
            item.dispatchesBefore = before.events.filter(record => record.event.type === 'dispatch_intent').length;
            item.dispatchesAfter = intents.length;
            if (kind === 'dirty') {
                check(intents.length === item.dispatchesBefore, 'DIRTY_REDISPATCH');
                assert.deepEqual(after.unresolvedInvocations, before.unresolvedInvocations);
                item.blocked = { status: 'BLOCKED', reason: 'Unknown provider outcome; no durable terminal proof',
                    unknownRefs: after.unresolvedInvocations, phaseFailure: taskEvents().findLast(event => event.type === 'phase.failed') };
            } else {
                check(!after.hasUnresolvedUnknown, 'CLEAN_BECAME_UNKNOWN');
                for (const phase of ['scout', 'implement', 'review']) check(taskEvents().filter(event =>
                    event.type === 'phase.completed' && event.phase === phase).length === 1, 'DUPLICATE_OR_MISSING_PHASE', phase);
                const review = json(path.join(runDir, 'review.json'));
                check(review.recommendation === 'APPROVE', 'REVIEW_NOT_APPROVED');
                item.workerState = json(path.join(runDir, 'state.json')).state;
                check(['CODEX_QC', 'REVIEW_VALID'].includes(item.workerState), 'WORKER_FLOW_INCOMPLETE');
                item.smokeOutput = execFileSync(process.execPath, ['--test', 'test/smoke.test.js'],
                    { cwd: root, encoding: 'utf8', timeout: 10000 });
            }
            item.status = await client.status(item.sessionId);
        });
        item.ok = true;
    } catch (error) {
        item.errorCode = error.code || 'LIVE_ERROR';
        item.errorMessage = redactDiagnostic(error.message);
    } finally {
        await stage('cleanup', 15000, async () => {
            // Dirty relay intentionally retains its lock; SIGKILL performs full
            // process cleanup even when graceful daemon close rejects unknown.
            if (child && !exitResult) item.cleanupPids = killTree(child, knownPids);
            for (const pid of knownPids) signal(pid, 'SIGKILL');
            await waitDead([...knownPids], Date.now() + 10000);
        }).catch(error => { item.ok = false; item.cleanupError = error.code || error.message; });
        clearTimeout(forceTimer);
        activeCleanup = undefined;
        if (runDir) item.phases = taskEvents();
        item.wallMs = Date.now() - started;
        delete item.activeStage;
        save();
    }
}

async function main() {
    if (process.env.OMNI_DUAL_LIVE !== '1') {
        console.log('Usage: OMNI_DUAL_LIVE=1 node test/dual-discussion-restart-live.js <new-report.json> [clean|dirty|both]');
        return;
    }
    const selection = process.argv[3] || 'both';
    check(process.argv[2] && ['clean', 'dirty', 'both'].includes(selection) && process.argv.length <= 4, 'ARGUMENTS_INVALID');
    const output = path.resolve(process.argv[2]);
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    const started = Date.now();
    const report = { protocol: 'dual-discussion-restart-live-v1', startedAt: new Date(started).toISOString(),
        ok: false, wallMs: 0, cases: {}, budgets: { overallMs: OVERALL_MS, providerMs: PROVIDER_MS, realWaitMs: STALE_WAIT_MS },
        executionScope: 'shared worker phases through review; awaiting Codex QC',
        restartScope: 'daemon and worker tree dead; daemon-only crash with live orphans is not proved',
        recoveryEnvironment: 'OMNI_DUAL_DISCUSSION_RECLAIM_STALE_OWNER=1 on restarted daemon only' };
    const save = () => {
        report.wallMs = Date.now() - started;
        const temp = `${output}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, output);
    };
    const interrupted = name => {
        report.interrupted = name;
        report.ok = false;
        try { activeCleanup?.(); } catch (error) { report.cleanupError = error.code || error.message; }
        save();
        process.exit(name === 'SIGINT' ? 130 : 143);
    };
    const onInt = () => interrupted('SIGINT');
    const onTerm = () => interrupted('SIGTERM');
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    const heartbeat = setInterval(() => {
        console.error(`Restart proof elapsed ${Math.round((Date.now() - started) / 1000)}s`);
        save();
    }, 30000);
    try {
        for (const kind of selection === 'both' ? ['clean', 'dirty'] : [selection]) {
            await runCase(kind, report, save, started + OVERALL_MS);
        }
        report.ok = Object.values(report.cases).every(item => item.ok);
    } finally {
        clearInterval(heartbeat);
        process.removeListener('SIGINT', onInt);
        process.removeListener('SIGTERM', onTerm);
        save();
    }
    console.error(`Report: ${output}; ${report.ok ? 'OK' : 'FAILED'}`);
    process.exitCode = report.ok ? 0 : 1;
}
main().catch(error => { console.error(redactDiagnostic(`${error.code || 'LIVE_ERROR'}: ${error.message}`)); process.exitCode = 1; });
