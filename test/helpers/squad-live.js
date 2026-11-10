'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { redactDiagnostic } = require('../../lib/dual/validator-security');
const { isDelegatedDecision } = require('./acceptance-delegation');

const failure = (code, message = code) => Object.assign(new Error(message), { code });
const check = (value, code, message) => { if (!value) throw failure(code, message); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Only read completed worker artifacts here; concurrent authority ledgers use derive/readEvents.
const records = (file) => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : []);

function stopTree(child) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
}

// Initial exclusive creation and report redaction belong to the caller.
function saveReport(output, report) {
    const temp = `${output}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
        fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, output);
}

function createStageRunner({ report, save, deadline, now = Date.now, log = console.error, redact = redactDiagnostic }) {
    return async function stage(name, timeoutMs, action) {
        const time = now();
        log(`[${name}] started`);
        const limit = Math.max(1, Math.min(timeoutMs, deadline - now()));
        let timer;
        try {
            const result = await Promise.race([action(limit), new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('STAGE_TIMEOUT', `${name} exceeded ${limit}ms`)), limit);
            })]);
            report.stages[name] = { ok: true, wallMs: now() - time };
            log(`[${name}] OK`);
            return result;
        } catch (error) {
            report.failedStage ||= name;
            report.errorCode ||= error.code || 'LIVE_ERROR';
            report.stages[name] = { ok: false, wallMs: now() - time, errorCode: error.code || 'LIVE_ERROR',
                errorMessage: redact(error.message) };
            log(`[${name}] ${report.stages[name].errorCode}: ${report.stages[name].errorMessage}`);
            throw error;
        } finally { clearTimeout(timer); save(); }
    };
}

function createPoller({ beforeCheck = () => {}, afterCheck = () => {}, pauseImpl = pause, now = Date.now, intervalMs = 500 } = {}) {
    return async function poll(predicate, limit, label) {
        const until = now() + limit;
        while (now() < until) {
            await beforeCheck();
            if (await predicate()) return;
            await afterCheck();
            await pauseImpl(intervalMs);
        }
        throw failure('STAGE_TIMEOUT', `Timed out waiting for ${label}`);
    };
}

function spawnDaemon({ root, logFile, env = process.env, envOverrides = {}, spawnImpl = spawn,
    entryPoint = path.resolve(__dirname, '../../bin/omni-daemon.js'), argvPrefix = [],
    createClient = require('../../lib/dual/daemon-client').createDaemonClient,
    createAuthority = require('../../lib/dual/authority-store').createAuthorityStore,
    pauseImpl = pause, stopTreeImpl = stopTree }) {
    const log = fs.openSync(logFile, 'wx', 0o600);
    const childEnv = { ...env };
    for (const key of ['OMNI_DUAL_WORKER_MODEL', 'OMNI_DUAL_WORKER_EFFORT', 'OMNI_DUAL_WORKER_RUNTIME', 'OMNI_DUAL_DISCUSSION_ENABLED']) delete childEnv[key];
    Object.assign(childEnv, envOverrides);
    let child, client, authority, exitResult, childError;
    try {
        child = spawnImpl(process.execPath, [entryPoint, ...argvPrefix, '--workspace', root],
            { env: childEnv, detached: true, stdio: ['ignore', log, log] });
    } finally { fs.closeSync(log); }
    const exited = new Promise((resolve) => child.once('close', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); }));
    child.on('error', (error) => { childError = error; });
    // Keep ownership even if client creation fails, so callers can still clean up.
    try { client = createClient({ workspaceRoot: root, timeoutMs: 10_000 }); }
    catch (error) { childError = error; }
    return {
        child, get client() { return client; }, get authority() { return authority; },
        get exitResult() { return exitResult; }, get childError() { return childError; }, exited,
        async waitUntilReady(poll, limit) {
            if (childError) throw childError;
            await poll(() => { try { client.readDiscovery(); return true; } catch (error) {
                if (error.code !== 'DUAL_DISCOVERY_MISSING') throw error; return false; } }, limit, 'daemon discovery');
            check((await client.health()).status === 'healthy', 'DAEMON_UNHEALTHY');
            authority = createAuthority(path.join(root, '.omni/runs/dual-authority'));
        },
        async stop() {
            if (exitResult) return;
            try {
                await client?.stop({ timeoutMs: 5_000 });
                await Promise.race([exited, pauseImpl(10_000)]);
            } catch { /* fall through to a hard stop */ }
            if (!exitResult) stopTreeImpl(child);
        },
    };
}

async function waitForApproval({ authority, report, save, poll, limit, command, gateIds, allowAutoPlan = false, delegation, log = console.error }) {
    const ids = Array.isArray(gateIds) ? gateIds : [gateIds];
    check(ids.length && ids.every((id) => typeof id === 'string' && id.length), 'GATE_ID_REQUIRED');
    const label = ids.join(', ');
    if (delegation) {
        const approvals = authority.derive().approvals;
        check(ids.every(id => approvals?.[id] && approvals[id].status !== 'pending'), 'ACCEPTANCE_DELEGATED_GATE_PENDING');
    } else {
        log(`\n>>> Cổng ${label} đang chờ. Mở terminal khác và chạy:\n    ${command}\n`);
        report.awaiting = ids.length === 1 ? { gateId: ids[0], command } : { gateIds: ids, command };
        save();
        await poll(() => {
            const approvals = authority.derive().approvals;
            return ids.every((id) => approvals?.[id] && approvals[id].status !== 'pending');
        }, limit, `approval of ${label}`);
    }
    const approvals = authority.derive().approvals;
    for (const gateId of ids) {
        const decided = approvals?.[gateId];
        check(decided, 'GATE_MISSING', gateId);
        report.decisions = [...(report.decisions || []), decided];
        check(decided.status === 'approved', 'GATE_REJECTED', `${gateId} was ${decided.status}: ${decided.reason || ''}`);
        const autoPlan = allowAutoPlan && /^plan-r\d+$/.test(gateId) && decided.phase === 'plan'
            && decided.actor === 'auto' && decided.via === 'pipeline-auto';
        check((decided.actor === 'human' && decided.via === 'cli-tty') || autoPlan || isDelegatedDecision(decided, decided, delegation),
            'GATE_NOT_HUMAN', `${decided.actor}/${decided.via}`);
    }
    delete report.awaiting;
}

async function answerContext({ waitingQuestionIds, answered, client, sessionId, taskId, planRevision = 1,
    maxReplies = 3, roundState, maxRounds = 3, maxQuestionsPerRound = 20, body, report, log = console.error }) {
    const open = waitingQuestionIds.filter((id) => !answered.has(id));
    if (!open.length) return;
    let round;
    if (roundState) {
        check(Number.isInteger(roundState.count) && roundState.count >= 0 && roundState.count < maxRounds
            && open.length <= maxQuestionsPerRound, 'ISOLATED_CONTROLLER_REQUIRED', 'Context round budget exceeded');
        roundState.count++;
        round = { number: roundState.count, questionIds: [...open], acknowledgedQuestionIds: [], complete: false };
        roundState.history.push(round);
    } else check(answered.size + open.length <= maxReplies, 'ISOLATED_CONTROLLER_REQUIRED', 'Worker keeps asking for context');
    for (const questionId of open) {
        const messageId = `reply-${answered.size + 1}`;
        const ack = await client.replyToTask(sessionId, { task_id: taskId, plan_revision: planRevision,
            message_id: `${taskId}-${messageId}`, reply_to: questionId, body: await body({ questionId, messageId, taskId, planRevision }) });
        check(ack.acknowledged === true, 'CONTEXT_REPLY_REJECTED', JSON.stringify(ack));
        answered.add(questionId);
        if (round) round.acknowledgedQuestionIds.push(questionId);
        report.contextReplies = [...(report.contextReplies || []), { questionId, messageId }];
        log(`[context] answered ${questionId}`);
    }
    if (round) round.complete = true;
    await client.request('session.resume', { session_id: sessionId, task_id: taskId, plan_revision: planRevision, projection: 'ack' });
}

module.exports = { failure, check, pause, records, stopTree, saveReport, createStageRunner, createPoller,
    spawnDaemon, waitForApproval, answerContext };
