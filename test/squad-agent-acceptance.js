#!/usr/bin/env node
'use strict';

// P7f / V50: real-orchestrator acceptance tier (SPEC-SQUAD-P7 §3.1, §10 P7f).
// A real orchestrator CLI gets requirements.md for four bookshelf tasks and
// plans and drives the work itself through the omni_dual MCP server, the way a
// user runs it. The harness only prepares the project, owns the daemon, shows
// the person the one approval command for spec/plan gates, and grades the
// result afterwards with the hidden tests. Integrate gates of the
// human-approved plan are delegated (test/helpers/agent-delegation.js).
//
//   OMNI_SQUAD_LIVE=1 node test/squad-agent-acceptance.js <out-dir> --preset dual|squad

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { FIXTURE, prepareAcceptanceProject } = require('./helpers/acceptance-project');
const { createPoller, spawnDaemon, stopTree, failure } = require('./helpers/squad-live');
const { collectRuntimeEvidence, redactReport } = require('./helpers/acceptance-evidence');
const { createAgentDelegation, humanPlanApproval, isAgentDelegatedDecision } = require('./helpers/agent-delegation');
const { runHiddenTests } = require('./squad-acceptance');
const { resolveBinary } = require('../lib/squad/runtimes/resolve-binary');

const TASK_IDS = Object.freeze(['T01', 'T03', 'T06', 'T09']);
const TOTAL_MS = 4 * 3600000 - 60000;
const ORCHESTRATOR_MS = 3.5 * 3600000;
const MAX_CONTINUATIONS = 60;
const OMNI = path.resolve(__dirname, '../bin/omni.js');
const MCP_SERVER = path.resolve(__dirname, '../lib/dual/mcp-server.mjs');
// dual: codex orchestrator + claude worker (config B); squad: claude orchestrator
// + claude worker + codex reviewer (config E). Neither uses the agy slot.
const PRESETS = Object.freeze({ dual: 'B', squad: 'E' });
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function parseArgs(argv) {
    const args = { outDir: null, preset: null, delegateAllGates: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--preset') args.preset = argv[++i];
        else if (argv[i] === '--delegate-all-gates') args.delegateAllGates = true;
        else if (!argv[i].startsWith('--') && !args.outDir) args.outDir = path.resolve(argv[i]);
        else throw failure('ACCEPTANCE_BAD_ARGS', `Unknown argument ${argv[i]}`);
    }
    if (!args.outDir || !Object.hasOwn(PRESETS, args.preset)) throw failure('ACCEPTANCE_BAD_ARGS', 'Use <out-dir> --preset dual|squad');
    return args;
}

// What a user would hand the orchestrator: the four requirements, no task
// metadata, no file lists and no hint of the hidden tests.
function requirementsMarkdown() {
    const suite = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'tasks.json'), 'utf8'));
    const items = suite.tasks.filter((task) => TASK_IDS.includes(task.id));
    return ['# Bookshelf requirements', '',
        'Deliver each requirement below in this repository. Keep all existing behaviour and visible tests passing (`node --test`).', '',
        ...items.flatMap((task, index) => [`## R${index + 1} — ${task.title}`, '', task.goal, '']),
    ].join('\n');
}

function orchestratorPrompt(root) {
    return [
        'You are the Omni orchestrator for this repository. Read AGENTS.md and .omni/workflows/dual-controller.md first and follow them.',
        'Goal: deliver every requirement in requirements.md end to end in AUTO mode through the Omni dual authority, exactly as that workflow describes.',
        `Workspace root: ${root}. Prepare the planning artifacts the workflow names and start with \`omni dual bootstrap --json\` (its single AUTO entrypoint), then drive every task with the omni_dual MCP tools (status, resume, completion) until each task is TASK_VERIFIED.`,
        'A person approves spec/plan gates in a terminal with `omni squad approve`; never try to approve a gate yourself. When only a human gate or a running worker is pending, end your turn with one line saying so; you will be resumed in this same conversation.',
        'Do not edit source files yourself; workers implement. Answer worker questions only from requirements.md. Stop when every task is TASK_VERIFIED or when you are blocked, and end with a short summary of the final state.',
    ].join('\n\n');
}

// What a person types when the orchestrator ended its turn early: carry on in
// the same conversation. The harness never answers questions or gates here.
function continuationPrompt(summary) {
    return [`Continue the same Omni AUTO session. Current authority state: ${summary}.`,
        'Keep driving with the omni_dual tools: check status, answer worker questions from requirements.md, request QC/completion and corrections as the workflow says.',
        'If only a human gate or a running worker is pending, end your turn with one line saying so; you will be resumed later. Stop when every task is TASK_VERIFIED.'].join(' ');
}

// `resume` = { sessionRef, prompt } continues the orchestrator's own conversation.
function orchestratorCommand({ preset, root, binding, resume }) {
    const role = binding.roles.orchestrator;
    if (preset === 'squad') {
        const claude = resolveBinary(require('../lib/squad/runtimes/claude').binary);
        if (!claude.found) throw failure('ORCHESTRATOR_MISSING', 'claude not found');
        // Project .mcp.json and .claude/settings.json hooks are written by `omni squad setup` (V30).
        return { command: claude.command, args: [...claude.prefixArgs, '-p', resume ? resume.prompt : orchestratorPrompt(root),
            ...(resume ? ['--resume', resume.sessionRef] : []), '--model', role.model,
            '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
            '--allowedTools', 'mcp__omni_dual__*', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] };
    }
    const codex = resolveBinary(require('../lib/squad/runtimes/codex').binary);
    if (!codex.found) throw failure('ORCHESTRATOR_MISSING', 'codex not found');
    // codex exec ignores the project's .codex/config.toml in a folder the user has
    // not trusted (P7f V48 finding), so the same MCP server is passed as session flags.
    const flags = ['--json', '--skip-git-repo-check', '-m', role.model,
        '-c', `model_reasoning_effort="${role.effort}"`, '-c', 'sandbox_mode="workspace-write"',
        '-c', `mcp_servers.omni_dual.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.omni_dual.args=${JSON.stringify([MCP_SERVER, '--workspace', root])}`,
        // Same as the generated project config (lib/init/strategies.js).
        '-c', 'mcp_servers.omni_dual.default_tools_approval_mode="approve"',
        // Stands in for the person approving the escalation `omni dual bootstrap`
        // needs to reach the loopback daemon (P7f dual-2: EPERM in the default
        // network-off workspace-write sandbox). Writes stay workspace-confined.
        '-c', 'sandbox_workspace_write.network_access=true'];
    return { command: codex.command, args: resume
        ? [...codex.prefixArgs, 'exec', 'resume', ...flags, resume.sessionRef, resume.prompt]
        : [...codex.prefixArgs, 'exec', ...flags, orchestratorPrompt(root)] };
}

// The orchestrator conversation id from its own JSON event stream.
function sessionRefFrom(logText, preset) {
    for (const line of logText.split('\n')) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (preset === 'squad' && typeof event.session_id === 'string') return event.session_id;
        if (preset === 'dual' && event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
    }
    return null;
}

function changedSourceFiles(root, baselineCommit) {
    const tracked = execFileSync('git', ['diff', '--name-only', baselineCommit], { cwd: root, encoding: 'utf8' }).split('\n');
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n');
    const generated = /^(\.omni\/|\.codex\/|\.claude\/|\.agents\/|\.mcp\.json$|\.gitignore$|AGENTS\.md$|CLAUDE\.md$|GEMINI\.md$|hidden\/|plans\/|requirements\.md$)/;
    return [...new Set([...tracked, ...untracked].filter(Boolean))].filter((file) => !generated.test(file)).sort();
}

async function runAgentAcceptance(args, { log = console.error, signal } = {}) {
    const outDir = args.outDir;
    if (fs.existsSync(outDir)) throw failure('ACCEPTANCE_OUTPUT_EXISTS');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const privateDir = path.join(outDir, 'private'); fs.mkdirSync(privateDir, { mode: 0o700 });
    const started = Date.now(), deadline = started + TOTAL_MS;
    const report = { protocol: 'squad-agent-acceptance-v1', preset: args.preset, config: PRESETS[args.preset], taskIds: TASK_IDS,
        approvalMode: args.delegateAllGates ? 'delegated-all-gates' : 'human-plan-delegated-integrate',
        provesHumanTty: args.delegateAllGates ? false : 'plan/spec gates only',
        startedAt: new Date(started).toISOString(), ok: false, errorCode: null, humanGates: [] };
    const redaction = { secrets: [] };
    const save = () => fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(redactReport(report, redaction), null, 2) + '\n', { mode: 0o600 });
    let daemon, orchestrator, root, prepared, stopped = false;
    const poll = createPoller({ beforeCheck: () => { if (signal?.aborted) throw failure('ACCEPTANCE_INTERRUPTED'); } });
    save();
    try {
        prepared = await prepareAcceptanceProject({ config: PRESETS[args.preset], taskIds: TASK_IDS, auto: false });
        root = prepared.root;
        const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', timeout: 20_000 });
        // The orchestrator plans from requirements.md alone: drop the scripted ten-task plan.
        git('rm', '-q', 'plans/plan.md');
        fs.writeFileSync(path.join(root, 'requirements.md'), requirementsMarkdown());
        // A user commits what `omni init`/`omni squad setup` wrote before handing the
        // project to an orchestrator (.omni/ itself stays ignored). P7f dual-3: an
        // untracked setup file makes the Git-baseline coverage scout refuse to start.
        git('add', '-A'); git('commit', '-q', '-m', 'P7f agent baseline: omni setup + requirements only');
        const baselineCommit = git('rev-parse', 'HEAD').trim();
        Object.assign(report, { workspaceRoot: root, container: prepared.container, baselineCommit, binding: prepared.binding, setup: prepared.setup });
        save();
        const delegationRef = createAgentDelegation({ root, baselineCommit, privateDir, deadline, preset: args.preset,
            scope: args.delegateAllGates ? 'all-gates' : 'integrate' });
        report.delegation = delegationRef;
        report.daemonLog = path.join(prepared.container, 'daemon.log');
        report.captureDir = path.join(prepared.container, 'runtime-capture');
        daemon = spawnDaemon({ root, logFile: report.daemonLog, entryPoint: path.resolve(__dirname, 'agent-acceptance-daemon.js'),
            argvPrefix: ['--agent-delegation', delegationRef.path, '--sha256', delegationRef.sha256],
            envOverrides: { OMNI_SQUAD_ACCEPTANCE_EVIDENCE: report.captureDir } });
        await daemon.waitUntilReady(poll, 20_000);
        const authority = daemon.authority;
        // `omni` on the orchestrator's PATH must be this checkout, not a globally installed release.
        const shimDir = path.join(privateDir, 'bin'); fs.mkdirSync(shimDir, { mode: 0o700 });
        fs.writeFileSync(path.join(shimDir, 'omni'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(OMNI)} "$@"\n`, { mode: 0o700 });
        const orchestratorEnv = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };
        const orchestratorLog = path.join(privateDir, 'orchestrator.jsonl');
        fs.writeFileSync(orchestratorLog, '', { flag: 'wx', mode: 0o600 });
        const launch = (resume) => {
            const invocation = orchestratorCommand({ preset: args.preset, root, binding: prepared.binding, resume });
            const fd = fs.openSync(orchestratorLog, 'a', 0o600);
            try { orchestrator = spawn(invocation.command, invocation.args, { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: orchestratorEnv }); }
            finally { fs.closeSync(fd); }
            const child = orchestrator;
            return new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
        };
        report.orchestrator = { runtime: prepared.binding.roles.orchestrator.runtime, model: prepared.binding.roles.orchestrator.model,
            startedAt: new Date().toISOString(), log: path.relative(outDir, orchestratorLog), turns: [] };
        let exited = launch(null);
        report.orchestrator.turns.push({ kind: 'initial', pid: orchestrator.pid, startedAt: new Date().toISOString() });
        save();
        log(`P7f ${args.preset}: orchestrator started in ${root}`);
        const announced = new Set();
        const until = Math.min(deadline - 15 * 60000, Date.now() + ORCHESTRATOR_MS);
        const allVerified = (derived) => Object.keys(derived.tasks || {}).length > 0
            && Object.values(derived.tasks).every((task) => task.state === 'TASK_VERIFIED');
        let running = true, idleSince = null, lastFingerprint = null;
        for (;;) {
            if (signal?.aborted) throw failure('ACCEPTANCE_INTERRUPTED');
            const derived = authority.derive();
            const pending = Object.values(derived.approvals || {}).filter((gate) => gate.status === 'pending' && gate.phase !== 'integrate');
            const key = pending.map((gate) => `${gate.gate_id}:${gate.digest}`).sort().join(',');
            if (pending.length && !announced.has(key)) {
                announced.add(key);
                const command = `cd ${quote(root)} && ${quote(process.execPath)} ${quote(OMNI)} squad approve --all`;
                report.humanGates.push({ requestedAt: new Date().toISOString(), gates: pending.map((gate) => ({ gate_id: gate.gate_id, phase: gate.phase })), command });
                fs.writeFileSync(path.join(outDir, 'NEEDS_HUMAN.txt'), `${pending.map((g) => g.gate_id).join(', ')}\n${command}\n`, { mode: 0o600 });
                save();
                log(`Human approval needed (${pending.map((g) => g.gate_id).join(', ')}):\n${command}`);
            } else if (!pending.length && fs.existsSync(path.join(outDir, 'NEEDS_HUMAN.txt'))) fs.unlinkSync(path.join(outDir, 'NEEDS_HUMAN.txt'));
            const states = Object.fromEntries(Object.entries(derived.tasks || {}).map(([id, task]) => [id, task.state]));
            report.progress = { at: new Date().toISOString(), tasks: states };
            save();
            if (Date.now() >= until) { if (running) stopTree(orchestrator); report.orchestratorTimedOut = true; await exited; break; }
            if (running) {
                const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000, null))]);
                if (exit) {
                    running = false; idleSince = Date.now();
                    report.orchestrator.turns.at(-1).exit = exit; report.orchestrator.turns.at(-1).endedAt = new Date().toISOString();
                    lastFingerprint = JSON.stringify([states, key, derived.lastSequence]);
                    if (exit.code !== 0) break;
                }
                continue;
            }
            if (allVerified(derived)) break;
            // Like a person nudging an idle agent: resume when the authority moved,
            // a gate was decided, or two quiet minutes passed; never while a gate waits.
            const fingerprint = JSON.stringify([states, key, derived.lastSequence]);
            const due = !pending.length && (fingerprint !== lastFingerprint || Date.now() - idleSince >= 120_000);
            if (due && report.orchestrator.turns.length < MAX_CONTINUATIONS) {
                const sessionRef = sessionRefFrom(fs.readFileSync(orchestratorLog, 'utf8'), args.preset);
                if (!sessionRef) { report.continuationError = 'ORCHESTRATOR_SESSION_UNKNOWN'; break; }
                const summary = Object.entries(states).map(([id, state]) => `${id}=${state}`).join(', ') || 'no tasks registered';
                exited = launch({ sessionRef, prompt: continuationPrompt(summary) });
                report.orchestrator.turns.push({ kind: 'continue', pid: orchestrator.pid, startedAt: new Date().toISOString(), summary });
                running = true; save();
            } else if (report.orchestrator.turns.length >= MAX_CONTINUATIONS) { report.continuationLimit = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        report.orchestrator.endedAt = new Date().toISOString();
        // Let a last dispatched worker settle before grading.
        await poll(() => !Object.values(authority.derive().leases || {}).some((lease) => lease.status === 'active'), 10 * 60000, 'lease settlement').catch(() => { report.leasesUnsettled = true; });
        await daemon.stop(); stopped = true;
        const final = authority.derive();
        const tasks = Object.values(final.tasks || {});
        report.tasks = tasks.map((task) => ({ task_id: task.task_id, title: task.title, allowed_files: task.allowed_files, state: task.state,
            attempt: task.isolatedWorkspace?.attempt || null, worker: task.worker || null }));
        const planGate = humanPlanApproval(final);
        report.gates = Object.values(final.approvals || {}).map((gate) => ({ gate_id: gate.gate_id, phase: gate.phase, status: gate.status,
            actor: gate.actor, via: gate.via, delegated: isAgentDelegatedDecision(gate, gate, JSON.parse(fs.readFileSync(delegationRef.path, 'utf8'))) }));
        const delegatedPlan = report.gates.find((gate) => gate.gate_id === `plan-r${final.planRevision}` && gate.status === 'approved' && gate.delegated);
        const changed = changedSourceFiles(root, baselineCommit);
        const allowed = new Set(tasks.flatMap((task) => task.allowed_files || []));
        report.hiddenTests = await runHiddenTests({ root, taskIds: TASK_IDS, privateDir, deadline, signal });
        const met = TASK_IDS.filter((id) => report.hiddenTests[id]?.passed).length;
        const capture = collectRuntimeEvidence(report.captureDir, redaction, { daemonLog: report.daemonLog });
        report.runtimeFailures = capture.runtimeFailures;
        report.capture = { complete: capture.complete, problems: capture.problems };
        report.thresholds = {
            requirements: { met, total: TASK_IDS.length, passed: met / TASK_IDS.length >= 0.9 },
            scope: { changed, outside: changed.filter((file) => !allowed.has(file)), passed: changed.every((file) => allowed.has(file)) },
            unknown: { unsettled: tasks.filter((task) => task.state !== 'TASK_VERIFIED').map((task) => task.task_id), passed: tasks.length > 0 && tasks.every((task) => task.state === 'TASK_VERIFIED') },
            gates: { humanPlan: Boolean(planGate), delegatedPlan: Boolean(delegatedPlan),
                passed: Boolean(planGate || delegatedPlan) && report.gates.every((gate) => gate.status !== 'approved'
                    || gate.delegated || (gate.actor === 'human' && gate.via === 'cli-tty')) },
        };
        report.ok = Object.values(report.thresholds).every((item) => item.passed) && !report.orchestratorTimedOut;
        report.orchestrator.continuations = report.orchestrator.turns.length - 1;
    } catch (error) {
        report.errorCode = error.code || 'ACCEPTANCE_ERROR'; report.errorMessage = error.message;
    } finally {
        if (orchestrator && orchestrator.exitCode === null && orchestrator.signalCode === null) stopTree(orchestrator);
        if (daemon && !stopped) { try { await daemon.stop(); } catch { /* reported by state */ } }
        report.endedAt = new Date().toISOString(); report.wallMs = Date.now() - started; save();
        log(`Report: ${path.join(outDir, 'report.json')}; ${report.ok ? 'PASS' : `FAIL (${report.errorCode || 'thresholds'})`}`);
    }
    return report;
}

async function main() {
    if (process.env.OMNI_SQUAD_LIVE !== '1') { console.log('Usage: OMNI_SQUAD_LIVE=1 node test/squad-agent-acceptance.js <out-dir> --preset dual|squad'); return; }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try { process.exitCode = (await runAgentAcceptance(parseArgs(process.argv.slice(2)), { signal: controller.signal })).ok ? 0 : 1; }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (require.main === module) main().catch((error) => { console.error(`${error.code || 'ACCEPTANCE_ERROR'}: ${error.message}`); process.exitCode = 1; });

module.exports = { parseArgs, requirementsMarkdown, orchestratorPrompt, orchestratorCommand, continuationPrompt, sessionRefFrom, changedSourceFiles, TASK_IDS, PRESETS };
