#!/usr/bin/env node
'use strict';

// Opt-in scripted acceptance. Only a person using the CLI can decide gates.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { ALL_TASK_IDS, FIXTURE, parseAcceptanceArgs, prepareAcceptanceProject } = require('./helpers/acceptance-project');
const { failure, check, createStageRunner, createPoller, spawnDaemon, waitForApproval, answerContext, stopTree } = require('./helpers/squad-live');
const { driveAcceptance } = require('./helpers/acceptance-control');
const { measureAcceptance } = require('./helpers/acceptance-metrics');
const { collectRuntimeEvidence, writeAcceptanceReport, redactReport } = require('./helpers/acceptance-evidence');
const { archiveAcceptanceEvidence } = require('./helpers/acceptance-archive');
const { createSourceGuard } = require('./helpers/acceptance-source');

const TOTAL_MS = 4 * 60 * 60 * 1000;
const APPROVAL_MS = 30 * 60 * 1000;
const OMNI = path.resolve(__dirname, '../bin/omni.js');
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

function snapshotSource(root) {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, timeout: 20_000 }).toString().split('\0').filter(Boolean);
    const result = new Map();
    for (const file of [...new Set(files)].sort()) {
        // Hash link text, never the target. A malicious parent link is rejected.
        let current = root;
        const parts = file.split('/');
        const full = path.join(root, file);
        let stat;
        try {
            for (const part of parts.slice(0, -1)) {
                current = path.join(current, part);
                if (fs.lstatSync(current).isSymbolicLink()) throw failure('ACCEPTANCE_SOURCE_SYMLINK');
            }
            stat = fs.lstatSync(full);
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() && !stat.isSymbolicLink()) throw failure('ACCEPTANCE_SOURCE_FILE_TYPE');
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
        result.set(file, `${stat.mode}:${createHash('sha256').update(bytes).digest('hex')}`);
    }
    return result;
}

function changedFiles(before, after) {
    return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort();
}

function sourceContextBody({ task, questionId, planRevision = 1 }) {
    const finance = task.task_id === 'T08';
    const source = finance ? 'plans/finance-format.md' : 'plans/plan.md and registered task goal';
    const content = finance ? fs.readFileSync(path.join(FIXTURE, 'bookshelf/plans/finance-format.md'), 'utf8') : task.goal;
    return `Source file/section: ${source}; Question ID: ${questionId}; Plan revision: ${planRevision}\n${content}`;
}

function coherentAuthoritySnapshot(authority, endedAt = new Date().toISOString()) {
    for (let retry = 0; retry < 20; retry++) {
        const derived = authority.derive(), events = authority.readEvents();
        if (derived.lastSequence === events.at(-1)?.sequence) return { derived, events, snapshot: {
            sessionId: derived.sessionId, workspaceId: derived.workspaceId, planRevision: derived.planRevision,
            lastSequence: derived.lastSequence, endedAt,
        } };
    }
    throw failure('ACCEPTANCE_SNAPSHOT_UNSTABLE');
}

async function runHiddenTests({ root, taskIds, privateDir, deadline, signal }) {
    check(!signal?.aborted, 'ACCEPTANCE_INTERRUPTED');
    const hidden = path.join(root, 'hidden');
    check(!fs.existsSync(hidden), 'ACCEPTANCE_HIDDEN_ALREADY_PRESENT');
    fs.mkdirSync(hidden, { mode: 0o700 });
    fs.copyFileSync(path.join(FIXTURE, 'hidden/helpers.cjs'), path.join(hidden, 'helpers.cjs'));
    const results = {};
    for (const id of taskIds) {
        check(Date.now() < deadline, 'ACCEPTANCE_INCOMPLETE');
        fs.copyFileSync(path.join(FIXTURE, `hidden/${id}.test.js`), path.join(hidden, `${id}.test.js`));
        const logFile = path.join(privateDir, `hidden-${id}.log`), fd = fs.openSync(logFile, 'wx', 0o600);
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE;
        const started = Date.now();
        let child;
        try {
            results[id] = await new Promise((resolve) => {
                let done = false, timedOut = false;
                const interrupt = () => stopTree(child);
                const finish = value => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', interrupt); resolve(value); };
                child = spawn(process.execPath, ['--test', `hidden/${id}.test.js`], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
                const timer = setTimeout(() => { timedOut = true; stopTree(child); }, Math.max(1, deadline - started));
                signal?.addEventListener('abort', interrupt, { once: true });
                child.once('error', error => finish({ exitCode: null, passed: false, errorCode: error.code }));
                child.once('close', (exitCode, exitSignal) => finish({ exitCode, signal: exitSignal, timedOut, passed: exitCode === 0 && !timedOut && !signal?.aborted }));
            });
        } finally { fs.closeSync(fd); }
        results[id].wallMs = Date.now() - started;
        results[id].evidence = path.relative(path.dirname(privateDir), logFile);
    }
    return results;
}

async function runAcceptance(args, deps = {}) {
    const outDir = path.resolve(args.outDir), log = deps.log || console.error;
    if (fs.existsSync(outDir) && (fs.lstatSync(outDir).isSymbolicLink() || !fs.statSync(outDir).isDirectory() || fs.readdirSync(outDir).length)) throw failure('ACCEPTANCE_OUTPUT_EXISTS');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 }); fs.chmodSync(outDir, 0o700);
    const privateDir = path.join(outDir, 'private'); fs.mkdirSync(privateDir, { mode: 0o700 });
    const started = Date.now(), deadline = started + TOTAL_MS;
    const report = { protocol: 'squad-acceptance-v1', config: args.config, auto: args.auto, taskIds: args.taskIds,
        partial: args.taskIds.length !== ALL_TASK_IDS.length, completeSuite: args.taskIds.length === ALL_TASK_IDS.length,
        startedAt: new Date(started).toISOString(), ok: false, selectedPassed: false, failedStage: null, errorCode: null,
        stages: {}, integrations: [], contextReplies: [], runtimeFailures: [], observer: { autoStart: false } };
    const redaction = { secrets: [] };
    const save = () => writeAcceptanceReport(outDir, report, redaction);
    const stage = createStageRunner({ report, save, deadline, log, redact: text => redactReport(text, redaction) });
    let prepared, root, container, ui, daemon, authority, client, stopped = false, driveResult, sourceGuard, sourceError, stopPromise, sourceObservationComplete = false;
    const stop = async () => {
        if (daemon && !stopped) {
            stopPromise ||= Promise.resolve().then(() => daemon.stop()).then(() => { stopped = true; });
            await stopPromise;
        }
    };
    const beforeCheck = () => {
        if (sourceError) throw sourceError;
        sourceGuard?.check();
        if (deps.signal?.aborted) throw failure('ACCEPTANCE_INTERRUPTED');
        if (daemon?.childError) throw daemon.childError;
        if (!stopped && daemon?.exitResult) throw failure('DAEMON_EXIT', JSON.stringify(daemon.exitResult));
    };
    const poll = createPoller({ beforeCheck });
    save();
    try {
        await stage('setup', 120_000, async () => {
            prepared = await (deps.prepare || prepareAcceptanceProject)({ config: args.config, taskIds: args.taskIds, auto: args.auto,
                onCreated: created => { ({ root, container } = created); report.workspaceRoot = root; report.container = container; save(); } });
            ({ root, container } = prepared);
            Object.assign(report, { workspaceRoot: root, container, baselineCommit: prepared.baselineCommit, suiteVersion: prepared.suiteVersion,
                planSha256: prepared.planSha256, binding: prepared.binding, setup: prepared.setup });
            check(prepared.setup.engine.supported, 'ENGINE_UNSUPPORTED');
        });
        sourceGuard = createSourceGuard({ root, capture: () => snapshotSource(root),
            authority: { derive: () => authority.derive(), readEvents: () => authority.readEvents() } });
        sourceGuard.start({ onFailure: error => {
            sourceError = error;
            report.sourceIntegrity = sourceGuard.summary(); save();
            // Stop owned processes even if a runtime RPC has not returned yet.
            void stop().catch(() => {});
        } });
        await stage('observer', 20_000, async () => {
            ui = await (deps.startUi || require('../lib/ui/server').startUiServer)({ projectRoot: root, autoStart: false });
            redaction.secrets.push(ui.token); report.observer.url = ui.url;
            log(`UI quan sát: ${ui.url}\nKhông khởi động orchestrator trong UI khi harness đang chạy.`);
        });
        await stage('daemon', 20_000, async limit => {
            beforeCheck();
            report.daemonLog = path.join(container, 'daemon.log');
            report.captureDir = path.join(container, 'runtime-capture');
            daemon = (deps.startDaemon || spawnDaemon)({ root, logFile: report.daemonLog,
                envOverrides: { OMNI_SQUAD_ACCEPTANCE_EVIDENCE: report.captureDir } });
            client = daemon.client; await daemon.waitUntilReady(poll, limit); authority = daemon.authority;
        });
        await stage('session', 20_000, async limit => {
            beforeCheck();
            const result = await client.beginSession({ workspace_root: root, mode: 'auto' }, { timeoutMs: limit });
            check(result.session_id, 'SESSION_ID_MISSING'); report.sessionId = result.session_id;
        });
        await stage('plan', 120_000, async limit => {
            beforeCheck();
            const registered = await client.registerPlan(report.sessionId, { plan_path: 'plans/plan.md', plan_sha256: prepared.planSha256,
                plan_revision: 1, tasks: prepared.tasks, acceptance_policy: { protocol_version: 1, checks: [], ui: {
                    required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } } }, { timeoutMs: limit });
            check(registered.registered, 'PLAN_NOT_REGISTERED');
            await client.resumeSession({ session_id: report.sessionId, projection: 'ack' }, { timeoutMs: limit });
        });
        const approvalCommand = gate => `cd ${quote(root)} && ${quote(process.execPath)} ${quote(OMNI)} squad approve ${gate}`;
        const wait = (gateIds, limit, allowAutoPlan = false) => {
            beforeCheck();
            return waitForApproval({ authority, report, save, poll, limit,
                gateIds, allowAutoPlan, command: approvalCommand(Array.isArray(gateIds) ? '--all' : gateIds),
                log: text => log(`${text}Nhập mã vừa in trong terminal; không dùng lại mã cũ.`) });
        };
        await stage('planApproval', APPROVAL_MS, async limit => {
            beforeCheck();
            const gate = authority.derive().approvals?.['plan-r1'];
            if (gate?.status === 'approved') {
                check(gate.actor === 'human' && gate.via === 'cli-tty' || args.auto && gate.actor === 'auto' && gate.via === 'pipeline-auto' && gate.phase === 'plan', 'GATE_NOT_HUMAN');
                report.decisions = [gate];
            } else await wait('plan-r1', limit, args.auto);
        });
        beforeCheck();
        const answered = new Map();
        // The driver has its own total deadline, including each human wait.
        driveResult = await (deps.drive || driveAcceptance)({ authority, client, sessionId: report.sessionId, taskIds: args.taskIds,
            deadline, beforeCheck, captureSource: () => snapshotSource(root),
            beforeQc: id => sourceGuard.beginQc(id), afterQc: () => sourceGuard.endQc(),
            collectIntegration: ({ before, after, ...record }) => {
                sourceGuard.acceptIntegration(record);
                return { ...record, changed_files: changedFiles(before, after) };
            },
            onIntegration: record => { report.integrations.push(record); save(); },
            onProgress: ({ taskId, status }) => { log(`[${taskId}] ${status}`); report.lastProgress = { taskId, status, at: new Date().toISOString() }; save(); },
            waitForGates: ({ gateIds, remainingMs }) => wait(gateIds, Math.min(APPROVAL_MS, remainingMs)),
            serviceContext: async ({ taskId, task, remainingMs }) => {
                if (!answered.has(taskId)) answered.set(taskId, new Set());
                await answerContext({ waitingQuestionIds: task.waitingContext.question_ids, answered: answered.get(taskId),
                    client, sessionId: report.sessionId, taskId, report, log,
                    body: details => sourceContextBody({ ...details, task: prepared.tasks.find(item => item.task_id === taskId) }) });
                report.contextByTask = Object.fromEntries([...answered].map(([id, ids]) => [id, [...ids]])); save();
                check(remainingMs > 0, 'ACCEPTANCE_INCOMPLETE');
            } });
        report.drive = driveResult;
        await stop();
        beforeCheck();
        sourceGuard.close();
        sourceObservationComplete = true;
        report.sourceIntegrity = sourceGuard.summary();
        const final = authority.derive();
        check(driveResult.complete && !Object.values(final.leases || {}).some(lease => !lease.released_at && lease.status !== 'released'), 'ACCEPTANCE_NOT_SETTLED');
        await stage('hidden', Math.max(1, deadline - Date.now()), async () => {
            report.hiddenTests = await (deps.hidden || runHiddenTests)({ root, taskIds: args.taskIds, privateDir, deadline, signal: deps.signal });
            check(!deps.signal?.aborted, 'ACCEPTANCE_INTERRUPTED');
        });
    } catch (error) {
        if (sourceError) error = sourceError;
        report.errorCode ||= error.code || 'ACCEPTANCE_ERROR'; report.errorMessage = error.message;
        report.failedStage ||= 'drive'; if (error.partial) report.drive = error.partial;
    } finally {
        try { await stop(); } catch (error) { report.errorCode ||= error.code || 'DAEMON_STOP_FAILED'; }
        sourceGuard?.close();
        if (sourceGuard && !sourceObservationComplete) {
            try { sourceGuard.check(); } catch (error) { sourceError ||= error; }
        }
        if (sourceGuard) report.sourceIntegrity = sourceGuard.summary();
        if (sourceError) { report.errorCode = sourceError.code; report.errorMessage = sourceError.message; }
        try {
            const capture = report.captureDir ? (deps.collect || collectRuntimeEvidence)(report.captureDir, redaction, { daemonLog: report.daemonLog }) : { complete: false, problems: [{ code: 'CAPTURE_NOT_STARTED' }], turns: [], runtimeFailures: [] };
            report.runtimeFailures = capture.runtimeFailures; report.capture = { complete: capture.complete, problems: capture.problems, status: capture.status };
            report.usage = capture.turns.map(turn => ({ turnId: turn.turnId, taskId: turn.taskId, runtime: turn.runtime, role: turn.role, usage: turn.usage ?? null }));
            if (root) report.evidence = await (deps.archive || archiveAcceptanceEvidence)({ root, outDir, captureDir: report.captureDir,
                daemonLog: report.daemonLog, turns: capture.turns, sessionId: report.sessionId });
            if (authority && prepared) {
                const snapshot = coherentAuthoritySnapshot(authority);
                const policy = deps.gatePolicy || require('../lib/dual/approval-gates').phaseGatePolicy;
                report.measurements = (deps.measure || measureAcceptance)({ ...snapshot, taskContracts: prepared.tasks, suiteTaskIds: ALL_TASK_IDS,
                    gatePolicy: { auto: args.auto, phases: Object.fromEntries(['spec', 'plan', 'integrate'].map(phase => [phase, policy(root, phase)])) },
                    integrations: report.integrations, hiddenTests: report.hiddenTests || {}, sourceIntegrity: report.sourceIntegrity });
                report.tasks = prepared.tasks.map(task => {
                    const own = snapshot.events.filter(event => event.task_id === task.task_id);
                    const start = own.find(event => event.type === 'task.execution.started'), end = own.findLast(event => event.type === 'task.completed' || event.type === 'task.execution.outcome');
                    return { task_id: task.task_id, attempts: snapshot.derived.tasks[task.task_id]?.isolatedWorkspace?.attempt || null,
                        wallMs: start && end ? Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp)) : null,
                        reviewerVerdicts: own.filter(event => event.type === 'qc.review.completed').map(event => ({ attempt: event.attempt, verdict: event.verdict, sequence: event.sequence })) };
                });
                report.checks = { t08Context: !args.taskIds.includes('T08') || (report.contextByTask?.T08?.length || 0) > 0,
                    sourceIntegrity: report.sourceIntegrity?.passed === true };
                report.selectedPassed = Boolean(!report.errorCode && driveResult?.complete && capture.complete && !report.evidence?.problems.length
                    && report.checks.t08Context && report.checks.sourceIntegrity && report.measurements.thresholdsPassed);
                report.ok = report.selectedPassed && report.measurements.passed;
            }
        } catch (error) { report.errorCode ||= error.code || 'EVIDENCE_FAILED'; report.errorMessage ||= error.message; report.ok = false; }
        try { await ui?.close(); } catch (error) { report.errorCode ||= error.code || 'UI_CLOSE_FAILED'; report.ok = false; }
        report.endedAt = new Date().toISOString(); report.wallMs = Date.now() - started; save();
        log(`Report: ${path.join(outDir, 'report.json')}; ${report.ok ? 'PASS' : report.partial && report.selectedPassed ? 'PARTIAL: selected checks passed' : `INCOMPLETE / FAIL (${report.errorCode || 'thresholds'})`}`);
    }
    return report;
}

async function main() {
    if (process.env.OMNI_SQUAD_LIVE !== '1') {
        console.log('Usage: OMNI_SQUAD_LIVE=1 node test/squad-acceptance.js <out-dir> --config A|B|C|D [--tasks T01,T03] [--auto]'); return;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
        const report = await runAcceptance(parseAcceptanceArgs(process.argv.slice(2)), { signal: controller.signal });
        process.exitCode = report.ok || report.partial && report.selectedPassed ? 0 : 1;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (require.main === module) main().catch(error => { console.error(`${error.code || 'ACCEPTANCE_ERROR'}: ${error.message}`); process.exitCode = 1; });

module.exports = { runAcceptance, snapshotSource, changedFiles, sourceContextBody, coherentAuthoritySnapshot, runHiddenTests };
