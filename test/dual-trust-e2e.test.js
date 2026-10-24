'use strict';

const { withDiscussion } = require('./helpers/dual-discussion-stub');

function createOrchestratorAdapter(options) {
    return createOrchestratorAdapterImpl(withDiscussion(options));
}

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
    startDaemonServer,
    createDaemonClient,
    createAuthorityStore,
    createOrchestratorAdapter: createOrchestratorAdapterImpl,
} = require('../lib/dual');
const { createDaemonServerOptions } = require('../bin/omni-daemon');
const { handleDualQc } = require('../lib/commands/dual');
const { createTrustedQualityRunner } = require('../lib/dual/quality-runner');
const { createTrustedUiAdapter } = require('../lib/dual/visual-qa');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function acceptancePolicy(required = false) {
    return {
        protocol_version: 1,
        checks: [],
        ui: {
            required,
            viewport_widths: [390, 768, 1024, 1440],
            reduced_motion_required: true,
        },
    };
}

function taskContract(overrides = {}) {
    return {
        task_id: 'TASK-1',
        title: 'Offline trust fixture',
        owner: 'agy',
        goal: 'Update the local fixture markup',
        execution_mode: 'isolated',
        dependency_mode: 'none',
        depends_on: [],
        category: 'feature',
        complexity: 'low',
        risk: 'low',
        allowed_files: ['index.html'],
        context_files: [],
        deny_patterns: ['forbidden/**'],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        ...overrides,
    };
}

function passingCapability() {
    return {
        status: 'PASSED',
        to_state: 'CAPABILITY_SAFE',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: {
            agy_version: '1.1.19-fixture',
            agy_model: 'gemini-3.7-flash-high',
            agy_evidence: { version: '1.1.19-fixture', model: 'gemini-3.7-flash-high' },
        },
    };
}

function writeOfflinePackage(root) {
    const packageJson = { name: 'dual-trust-e2e', version: '1.0.0', private: true };
    const lock = {
        name: packageJson.name,
        version: packageJson.version,
        lockfileVersion: 3,
        requires: true,
        packages: { '': packageJson },
    };
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify(lock)}\n`);
    fs.writeFileSync(path.join(root, '.npmrc'), 'offline=true\naudit=true\n');
}

function writeFakeAgy(root, options = {}) {
    const scriptPath = path.join(root, 'fake-agy.cjs');
    const delayMs = options.delayMs || 0;
    const delayPhase = options.delayPhase || null;
    const openQuestions = options.question ? [String(options.question)] : [];
    const content = `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const promptIndex = args.indexOf('--prompt');
const promptArg = args.find((arg) => arg.startsWith('--prompt=') || arg.startsWith('-p='));
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : (promptArg ? promptArg.slice(promptArg.indexOf('=') + 1) : '');
const readPath = String(prompt).match(/Read\\s+([^\\s]+)/i)?.[1];
let input = {};
let inputText = '';
try { inputText = fs.readFileSync(readPath, 'utf8'); input = JSON.parse(inputText); } catch {}
if (!input.task_id) {
  const inputArg = args.find((arg) => arg.startsWith('--input=') || arg.startsWith('-i='));
  try { input = JSON.parse(fs.readFileSync(inputArg.slice(inputArg.indexOf('=') + 1), 'utf8')); } catch {}
}
const taskId = input.task_id || inputText.match(/Task:\\s*(TASK-[A-Za-z0-9_-]+)/i)?.[1] || String(prompt).match(/TASK-[A-Za-z0-9_-]+/)?.[0] || 'TASK-1';
let registeredCommands = [{ program: 'node', args: ['--version'], cwd: '.' }];
try {
  const spec = JSON.parse(fs.readFileSync('.omni/codex-gemini/runs/' + taskId + '/spec.json', 'utf8'));
  if (Array.isArray(spec.validation_commands) && spec.validation_commands.length) registeredCommands = spec.validation_commands;
} catch {}
const commandNames = registeredCommands.map((command) => (command.program + ' ' + command.args.join(' ')).trim());
const snapshotId = inputText.match(/Baseline identity:\\s*([0-9a-f]{64})/i)?.[1];
const gitBase = inputText.match(/Base commit:\\s*([0-9a-f]{40})/i)?.[1];
const baseline = input.expected_baseline
  ? { expected_baseline: input.expected_baseline }
  : snapshotId ? { expected_baseline: { kind: 'snapshot', id: snapshotId } }
  : { expected_base_commit: input.expected_base_commit || gitBase || '0'.repeat(40) };
const phase = args.includes('scout') || /scout/i.test(prompt) ? 'scout'
  : args.includes('implement') || /implement/i.test(prompt) ? 'implement' : 'review';
const configuredQuestions = ${JSON.stringify(openQuestions)};
const effectiveQuestions = /Decision:/i.test(inputText) ? [] : configuredQuestions;
if (phase === 'implement' && ${JSON.stringify(Boolean(options.eagerImplementMutation))}) {
  fs.writeFileSync('index.html', '<html><body>Trusted offline change ' + taskId + '</body></html>\\n');
}
function emit(payload) { process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n'); }
function run() {
  if (phase === 'scout') return emit({
    schema_version: 1, task_id: taskId, ...baseline, summary: 'Offline scout complete',
    relevant_files: [{ path: 'index.html', description: 'Fixture entry' }],
    exact_symbols: [{ name: 'body', file: 'index.html', verified: true, kind: 'element' }],
    validation_commands: commandNames, constraints: ['offline fixture'], risks: [], open_questions: effectiveQuestions,
    research_trace: [
      { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns the fixture.' },
      { question: 'How is it checked?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'Runtime validation is local.' }
    ],
    alternatives_considered: [
      { option: 'Edit index.html', tradeoff: 'Smallest scope.' },
      { option: 'Add a module', tradeoff: 'Unnecessary.' }
    ], failure_modes: ['Markup could regress.']
  });
  if (phase === 'implement') {
    fs.writeFileSync('index.html', '<html><body>Trusted offline change ' + taskId + '</body></html>\\n');
    if (${JSON.stringify(Boolean(options.rogueForbiddenWrite))}) {
      fs.mkdirSync('forbidden', { recursive: true });
      fs.writeFileSync('forbidden/rogue.txt', 'worker ignored deny_patterns\\n');
    }
    return emit({ schema_version: 1, task_id: taskId, ...baseline, status: 'SUCCESS', modified_files: ['index.html'],
      command_outputs: commandNames.map((command) => ({ command, exit_code: 0, output: process.version })), unverified_items: [],
      self_review: { checks: ['scope inspected', 'edge challenged', 'validation passed'], remaining_risks: [] } });
  }
  return emit({ schema_version: 1, task_id: taskId, ...baseline, recommendation: 'APPROVE', risk_level: 'LOW',
    findings: [{ file: 'index.html', line: 1, description: 'Bounded fixture change', severity: 'INFO' }],
    review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'], challenge_summary: 'Offline fixture remained in scope.' });
}
setTimeout(run, ${JSON.stringify(delayPhase)} === null || phase === ${JSON.stringify(delayPhase)} ? ${delayMs} : 0);
`;
    fs.writeFileSync(scriptPath, content);
    return scriptPath;
}

function createFixture(t, options = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-trust-e2e-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeOfflinePackage(root);
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>Initial</body></html>\n');
    const planDir = path.join(root, '.omni', 'sdlc');
    fs.mkdirSync(planDir, { recursive: true });
    const planBytes = Buffer.from('# Offline trust fixture plan\n');
    const planPath = path.join(planDir, 'trust-plan.md');
    fs.writeFileSync(planPath, planBytes);
    const fakeAgy = writeFakeAgy(root, options);
    if (options.git) {
        execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'trust-e2e@example.invalid'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Trust E2E'], { cwd: root });
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '-m', 'fixture baseline'], { cwd: root, stdio: 'ignore' });
    }
    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    const authorityStore = createAuthorityStore(authorityDir, options.storeOptions || {});
    const orchestrator = createOrchestratorAdapter({
        workspaceRoot: root,
        authorityStore,
        agyCommand: process.execPath,
        agyPrefixArgs: [fakeAgy],
    });
    const runErrors = [];
    if (options.captureRunErrors) {
        const runTask = orchestrator.runTask.bind(orchestrator);
        orchestrator.runTask = async (...args) => {
            try { return await runTask(...args); }
            catch (error) { runErrors.push(error); throw error; }
        };
    }
    return { root, planBytes, authorityDir, authorityStore, orchestrator, runErrors };
}

async function startFixtureDaemon(t, fixture, options = {}) {
    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({
            workspaceRoot: fixture.root,
            authorityStore: fixture.authorityStore,
            orchestrator: fixture.orchestrator,
        }),
        preflightRunner: async () => passingCapability(),
        ...(options.serverOptions || {}),
    });
    t.after(async () => { try { await daemon.close(); } catch {} });
    const client = createDaemonClient({ workspaceRoot: fixture.root, timeoutMs: 20_000 });
    return { daemon, client };
}

async function restartFixtureDaemon(t, context, options = {}) {
    await context.daemon.close();
    const authorityStore = createAuthorityStore(context.authorityDir);
    const orchestrator = createOrchestratorAdapter({ workspaceRoot: context.root, authorityStore });
    const restarted = await startFixtureDaemon(t, { ...context, authorityStore, orchestrator }, options);
    return { ...context, ...restarted, authorityStore, orchestrator };
}

async function registerAndRun(t, options = {}) {
    const context = await beginAndRegister(t, options);
    await context.client.resumeSession(context.sessionId);
    await waitForTaskHandoff(context, options.waitTaskId || 'TASK-1');
    return context;
}

async function beginAndRegister(t, options = {}) {
    const fixture = createFixture(t, options);
    const { daemon, client } = await startFixtureDaemon(t, fixture, options);
    const begun = await client.beginSession({ workspace_root: fixture.root, mode: 'auto' });
    const policy = options.policy || acceptancePolicy(false);
    const tasks = options.tasks || [taskContract(options.task || {})];
    await client.registerPlan(begun.session_id, {
        plan_path: '.omni/sdlc/trust-plan.md',
        plan_sha256: sha(fixture.planBytes),
        plan_revision: 1,
        acceptance_policy: policy,
        tasks,
    });
    return { ...fixture, daemon, client, sessionId: begun.session_id, policy, task: tasks[0], tasks };
}

async function waitForTaskHandoff(context, taskId) {
    await waitUntil(() => context.authorityStore.readEvents().some((event) => event.type === 'task.workspace.handoff' && event.task_id === taskId), 30_000,
        () => {
            const events = context.authorityStore.readEvents();
            const prepared = events.find((event) => event.type === 'task.workspace.prepared' && event.task_id === taskId);
            let workerArtifacts = {};
            try {
                const binding = JSON.parse(fs.readFileSync(path.join(context.root, prepared.reference.bindingPath), 'utf8'));
                const runRoot = path.join(context.root, binding.workerPath, '.omni', 'codex-gemini', 'runs', taskId);
                workerArtifacts = Object.fromEntries(fs.readdirSync(runRoot).map((name) => {
                    const target = path.join(runRoot, name);
                    if (fs.statSync(target).isDirectory()) {
                        return [name, Object.fromEntries(fs.readdirSync(target).map((child) => [child,
                            fs.readFileSync(path.join(target, child), 'utf8')]))];
                    }
                    return [name, fs.readFileSync(target, 'utf8')];
                }));
            } catch {}
            return ({
            events: events.map((event) => ({
                type: event.type, task_id: event.task_id, code: event.code, status: event.status,
                ...(event.type === 'task.workspace.prepared' ? { reference: event.reference } : {}),
                ...(event.type === 'task.execution.outcome' ? { summary: event.summary } : {}),
            })),
            worker_artifacts: workerArtifacts,
        });
        });
}

async function waitUntil(predicate, timeoutMs, diagnostics) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try { if (await predicate()) return; } catch (error) { lastError = error; }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw lastError || new Error(`Timed out after ${timeoutMs}ms: ${JSON.stringify(diagnostics ? diagnostics() : {})}`);
}

async function runQcCli(t, context, taskId, options = {}) {
    const messages = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode;
    console.log = (...args) => messages.push(args.join(' '));
    process.exitCode = undefined;
    try {
        await handleDualQc(taskId, { cwd: context.root, client: context.client, json: true, ...options });
    } finally {
        console.log = originalLog;
        process.exitCode = originalExitCode;
    }
    assert.equal(messages.length, 1);
    return JSON.parse(messages[0]);
}

async function submitQualityCycle(context, cycle, client = context.client) {
    const execution = await client.executeQualityCycle(context.sessionId, cycle);
    return client.evaluateCompletion(context.sessionId, { quality_evidence: execution.quality_evidence });
}

function workerRootFor(context, taskId = 'TASK-1') {
    const prepared = context.authorityStore.readEvents()
        .find((event) => event.type === 'task.workspace.prepared' && event.task_id === taskId);
    const binding = JSON.parse(fs.readFileSync(path.join(context.root, prepared.reference.bindingPath), 'utf8'));
    return path.join(context.root, binding.workerPath);
}

function appendLegacyQualityCycles(context, diffFingerprint) {
    for (const cycle of [1, 2, 3]) {
        context.authorityStore.append({
            type: 'gate.result',
            gate_id: `quality-cycle-${cycle}`,
            status: 'PASSED',
            cycle_index: cycle,
            evidence_sha256: sha(`legacy-cycle-${cycle}`),
            reason: `Legacy quality cycle ${cycle} passed`,
            details: {
                required: true,
                cycle_index: cycle,
                attempt: 1,
                threshold: 1,
                total_tasks: 1,
                completed_task_ids: ['TASK-1'],
                plan_revision: 1,
                diff_fingerprint: diffFingerprint,
                commands: [{ command: 'node --version', exit_code: 0, duration_ms: 1 }],
                verdict: 'PASSED',
                blockers: [],
            },
        });
    }
}

test('E01 E07: CLI command handler and production server create one task, three fresh cycles, and one receipt', async (t) => {
    const context = await registerAndRun(t);
    const cliResult = await runQcCli(t, context);
    assert.equal(cliResult.verified, true);
    assert.match(cliResult.receipt, /^[0-9a-f]{64}$/);

    const events = context.authorityStore.readEvents();
    const cycles = events.filter((event) => event.type === 'gate.result' && /^quality-cycle-[123]$/.test(event.gate_id));
    assert.equal(cycles.length, 3);
    assert.deepEqual(cycles.map((event) => event.cycle_index), [1, 2, 3]);
    assert.equal(new Set(cycles.map((event) => event.details.provenance.execution_id)).size, 3);
    assert.equal(new Set(cycles.map((event) => event.evidence_sha256)).size, 3);
    assert.equal(events.filter((event) => event.type === 'session.verified').length, 1);
    assert.equal(events.filter((event) => event.type === 'task.completed' && event.task_id === 'TASK-1').length, 1);
    const isolatedGates = events.filter((event) => event.type === 'gate.result' && event.gate_id === 'isolated-qc-TASK-1');
    assert.equal(isolatedGates.length, 1);
    assert.equal(typeof isolatedGates[0].details.integration_receipt, 'string');
    const integrationReceipt = path.isAbsolute(isolatedGates[0].details.integration_receipt)
        ? isolatedGates[0].details.integration_receipt
        : path.join(context.root, isolatedGates[0].details.integration_receipt);
    assert.equal(fs.existsSync(integrationReceipt), true);
    const uiGate = events.find((event) => event.type === 'gate.result' && event.gate_id === 'responsive_visual_qa');
    assert.equal(uiGate.status, 'OPTIONAL_SKIPPED');
    assert.equal(uiGate.details.runtime_status, 'UNAVAILABLE');
    assert.doesNotMatch(uiGate.reason, /visual pass/i);

    const operationRecords = fs.readFileSync(path.join(context.authorityDir, 'operations.ndjson'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line).record);
    assert.deepEqual(operationRecords.map((record) => record.type), ['started', 'settled']);
    assert.equal(operationRecords[1].outcome, 'completed');
    const agyLease = Object.values(context.authorityStore.derive().leases).find((lease) => lease.owner === 'agy');
    assert.equal(agyLease.status, 'released');

    // A fully verified session (including its three real quality cycles and
    // receipt) is terminal for semantic rejection, even with matching hashes.
    const verified = context.authorityStore.derive();
    assert.equal(verified.sessionState, 'VERIFIED');
    const handoff = verified.tasks['TASK-1'].isolatedHandoff;
    const ledgerPath = path.join(context.authorityDir, 'events.ndjson');
    const ledgerBefore = fs.readFileSync(ledgerPath);
    const sourceBefore = fs.readFileSync(path.join(context.root, 'index.html'));
    const receiptBefore = fs.readFileSync(integrationReceipt);
    const { rejectTaskHandoff } = require('../lib/dual/handoff-rejection');
    assert.throws(() => rejectTaskHandoff({ workspaceRoot: context.root, authorityStore: context.authorityStore,
        session_id: context.sessionId, task_id: 'TASK-1', plan_revision: verified.planRevision,
        expected_attempt: handoff.attempt, request_id: 'reject-verified-session',
        expected_handoff_sha256: handoff.handoff_sha256, expected_result_sha256: handoff.result_sha256,
        findings: [{ id: 'F1', file: 'index.html', line: 1, requirement_id: 'R1', description: 'Terminal session veto attempt.' }] }),
    (error) => error.code === 'DUAL_HANDOFF_REJECTION_UNSAFE');
    assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBefore);
    assert.deepEqual(fs.readFileSync(path.join(context.root, 'index.html')), sourceBefore);
    assert.deepEqual(fs.readFileSync(integrationReceipt), receiptBefore);
    assert.equal(context.authorityStore.verifyIntegrity().valid, true);
});

test('E02: three dependent tasks execute and integrate in order before final acceptance', async (t) => {
    const tasks = [
        taskContract({ task_id: 'TASK-1', title: 'First dependency' }),
        taskContract({ task_id: 'TASK-2', title: 'Second dependency', depends_on: ['TASK-1'] }),
        taskContract({ task_id: 'TASK-3', title: 'Final dependency', depends_on: ['TASK-2'] }),
    ];
    const context = await beginAndRegister(t, { tasks });

    for (const taskId of ['TASK-1', 'TASK-2', 'TASK-3']) {
        await context.client.resumeSession({ session_id: context.sessionId, task_id: taskId, plan_revision: 1 });
        await waitForTaskHandoff(context, taskId);
        const taskQc = await runQcCli(t, context, taskId);
        assert.equal(taskQc.status, 'TASK_VERIFIED');
        assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'session.verified'), false);
    }

    const beforeAcceptance = context.authorityStore.readEvents();
    assert.deepEqual(
        beforeAcceptance.filter((event) => event.type === 'task.completed').map((event) => event.task_id),
        ['TASK-1', 'TASK-2', 'TASK-3'],
    );
    assert.equal(beforeAcceptance.some((event) => /^quality-cycle-/.test(event.gate_id || '')), false);
    const completionBeforeCycles = await context.client.evaluateCompletion(context.sessionId);
    assert.equal(completionBeforeCycles.verified, false);

    const accepted = await runQcCli(t, context);
    assert.equal(accepted.verified, true);
    assert.match(accepted.receipt, /^[0-9a-f]{64}$/);
    assert.equal(context.authorityStore.readEvents().filter((event) => event.type === 'session.verified').length, 1);
});

test('E03: explicit task QC is task-only and keeps the session pending', async (t) => {
    const context = await registerAndRun(t);
    const result = await runQcCli(t, context, 'TASK-1');

    assert.equal(result.status, 'TASK_VERIFIED');
    assert.equal(context.authorityStore.derive().sessionState, 'ACCEPTANCE');
    assert.equal(context.authorityStore.readEvents().some((event) => /^quality-cycle-/.test(event.gate_id || '')), false);
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'session.verified'), false);
    assert.equal(context.authorityStore.derive().receipt, null);
});

test('E11: duplicate completion preserves receipt and appends no duplicate events across server restart', async (t) => {
    const context = await registerAndRun(t);
    const first = await runQcCli(t, context);
    const before = context.authorityStore.readEvents().length;
    const duplicate = await context.client.evaluateCompletion(context.sessionId);
    assert.equal(duplicate.receipt.receipt_sha256, first.receipt);
    assert.equal(context.authorityStore.readEvents().length, before);

    await context.daemon.close();
    const reopenedStore = createAuthorityStore(context.authorityDir);
    const reopenedOrchestrator = createOrchestratorAdapter({ workspaceRoot: context.root, authorityStore: reopenedStore });
    const restarted = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: context.root, authorityStore: reopenedStore, orchestrator: reopenedOrchestrator }),
        preflightRunner: async () => passingCapability(),
    });
    t.after(async () => { try { await restarted.close(); } catch {} });
    const restartedClient = createDaemonClient({ workspaceRoot: context.root, timeoutMs: 20_000 });
    const afterRestart = await restartedClient.evaluateCompletion(context.sessionId);
    assert.equal(afterRestart.receipt.receipt_sha256, first.receipt);
    assert.equal(reopenedStore.readEvents().length, before);
});

test('E11: duplicate task QC and context replies are idempotent; changed content conflicts through real client', async (t) => {
    await t.test('task QC retry', async (st) => {
        const context = await registerAndRun(st);
        const first = await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
        assert.equal(first.status, 'TASK_VERIFIED');
        const before = context.authorityStore.readEvents().length;
        const duplicate = await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
        assert.equal(duplicate.status, 'TASK_VERIFIED');
        assert.equal(context.authorityStore.readEvents().length, before);
        assert.equal(context.authorityStore.readEvents().filter((event) => event.type === 'task.completed').length, 1);
    });

    await t.test('context reply retry and conflict', async (st) => {
        const context = await beginAndRegister(st, { question: 'Which local heading convention should be used?' });
        await context.client.resumeSession({ session_id: context.sessionId, task_id: 'TASK-1', plan_revision: 1 });
        await waitUntil(
            () => context.authorityStore.derive().tasks['TASK-1'].messages?.some((message) => message.kind === 'question'),
            20_000,
        );
        const question = context.authorityStore.derive().tasks['TASK-1'].messages.find((message) => message.kind === 'question');
        const reply = {
            task_id: 'TASK-1',
            plan_revision: 1,
            message_id: 'reply-1',
            reply_to: question.message_id,
            body: `Decision: keep the existing local heading convention. Source file/section: index.html body. Question ID: ${question.message_id}. Plan revision: 1.`,
        };

        const beforeReply = context.authorityStore.readEvents().length;
        const first = await context.client.replyToTask(context.sessionId, reply);
        assert.equal(first.reused, false);
        assert.equal(context.authorityStore.readEvents().length, beforeReply + 1);
        const duplicate = await context.client.replyToTask(context.sessionId, reply);
        assert.equal(duplicate.reused, true);
        const afterDuplicate = context.authorityStore.readEvents().length;
        assert.equal(afterDuplicate, beforeReply + 1);
        await assert.rejects(
            () => context.client.replyToTask(context.sessionId, { ...reply, body: `${reply.body} Changed.` }),
            (error) => error?.code === 'DUAL_MESSAGE_CONFLICT',
        );
        assert.equal(context.authorityStore.readEvents().length, afterDuplicate);

        await context.client.resumeSession({ session_id: context.sessionId, task_id: 'TASK-1', plan_revision: 1 });
        await waitForTaskHandoff(context, 'TASK-1');
        assert.equal(context.authorityStore.derive().tasks['TASK-1'].messages.filter((message) => message.kind === 'reply').length, 1);
    });
});

test('E06: required UI stays required when provider is missing, throws, or returns failed measurements', async (t) => {
    const cases = [
        ['missing', null, null, 'UNAVAILABLE'],
        ['throws', async () => { throw new Error('fixture browser failed'); }, null, 'UNAVAILABLE'],
        ['failed measurement', async ({ viewports, workspaceRoot, source_fingerprint: sourceFingerprint, artifactDir }) => {
            const screenshots = viewports.map((width) => {
                const target = path.join(artifactDir || path.join(workspaceRoot, '.omni', 'runs', 'ui-client'), `ui-${width}.png`);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, `fixture-${width}`);
                return { width, path: target };
            });
            return {
                success: true,
                source_fingerprint: sourceFingerprint,
                viewports: viewports.map((width) => ({ width, passed: false, horizontal_overflow: true })),
                reduced_motion: { tested: true, passed: true },
                screenshots,
            };
        }, 'trusted', 'FAILED'],
    ];

    for (const [label, browserAdapter, trustedMode, expectedStatus] of cases) {
        await t.test(label, async (st) => {
            const policy = acceptancePolicy(true);
            const serverOptions = trustedMode === 'trusted'
                ? { trustedUiAdapter: createTrustedUiAdapter({ headlessRunner: browserAdapter }) }
                : {};
            const context = await registerAndRun(st, { policy, serverOptions });
            const policyBefore = JSON.stringify(context.authorityStore.derive().plan.acceptance_policy);
            const result = await runQcCli(st, context, undefined, browserAdapter ? { browserAdapter } : {});
            assert.equal(result.verified, false, JSON.stringify(result));
            assert.equal(result.receipt, undefined);
            const derived = context.authorityStore.derive();
            assert.equal(derived.gates.responsive_visual_qa.status, expectedStatus);
            assert.equal(derived.gates.responsive_visual_qa.details.required, true);
            assert.equal(JSON.stringify(derived.plan.acceptance_policy), policyBefore);
            assert.equal(derived.receipt, null);
            assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'session.verified'), false);
        });
    }
});

test('E12: verified Git session accepts the frozen uncommitted diff then reports later workspace drift', async (t) => {
    const context = await registerAndRun(t, { git: true });
    assert.equal(context.authorityStore.derive().currentBaseline.kind, 'git');
    const first = await runQcCli(t, context);
    assert.equal(first.verified, true);
    const acceptedReceipt = first.receipt;
    const before = context.authorityStore.readEvents().length;

    fs.appendFileSync(path.join(context.root, 'index.html'), '<!-- later drift -->\n');
    const drift = await context.client.evaluateCompletion(context.sessionId);
    assert.equal(drift.verified, false);
    assert.equal(drift.session_state, 'VERIFIED');
    assert.ok(drift.blockers.some((blocker) => blocker.includes('WORKSPACE_DRIFT_AFTER_VERIFIED')));
    assert.equal(context.authorityStore.derive().receipt.receipt_sha256, acceptedReceipt);
    assert.equal(context.authorityStore.readEvents().length, before);
});

test('E04: daemon restarts after cycles 1 and 2 resume fresh identity-bound quality execution', async (t) => {
    const context = await registerAndRun(t);
    await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);

    let daemon = context.daemon;
    let client = context.client;
    let store = context.authorityStore;
    const executionIds = [];
    let previousExecution = null;
    for (const cycle of [1, 2, 3]) {
        if (cycle > 1) {
            await daemon.close();
            store = createAuthorityStore(context.authorityDir);
            daemon = await startDaemonServer({
                ...createDaemonServerOptions({
                    workspaceRoot: context.root,
                    authorityStore: store,
                    orchestrator: createOrchestratorAdapter({ workspaceRoot: context.root, authorityStore: store }),
                }),
                preflightRunner: async () => passingCapability(),
            });
            t.after(async () => { try { await daemon.close(); } catch {} });
            client = createDaemonClient({ workspaceRoot: context.root, timeoutMs: 20_000 });

            const priorEvidence = structuredClone(previousExecution.quality_evidence);
            const priorArtifactPath = path.join(context.authorityDir, 'quality', `${priorEvidence.provenance.execution_id}.json`);
            const priorBytes = fs.readFileSync(priorArtifactPath);
            const fakeArtifact = JSON.parse(priorBytes.toString('utf8'));
            fakeArtifact.commands[0].output_sha256 = 'f'.repeat(64);
            const fakeBytes = Buffer.from(`${JSON.stringify(fakeArtifact, null, 2)}\n`);
            fs.writeFileSync(priorArtifactPath, fakeBytes);
            priorEvidence.evidence_sha256 = sha(fakeBytes);
            const beforeFake = store.readEvents().length;
            await assert.rejects(
                () => client.evaluateCompletion(context.sessionId, { quality_evidence: priorEvidence }),
                // Restart replay now checks the durable authority digest before
                // any validator runs, so forged replacement bytes fail at the
                // anchor boundary rather than at fresh outcome comparison.
                (error) => error?.code === 'DUAL_QUALITY_ATTESTATION_INVALID',
            );
            assert.equal(store.readEvents().length, beforeFake, 'Fake command output must reject before append');
            fs.writeFileSync(priorArtifactPath, priorBytes);
        }

        const execution = await client.executeQualityCycle(context.sessionId, cycle);
        previousExecution = execution;
        const evidence = execution.quality_evidence;
        executionIds.push(evidence.provenance.execution_id);
        assert.equal(evidence.provenance.mode, 'fresh');
        assert.equal(evidence.provenance.input_fingerprint, evidence.diff_fingerprint);
        const artifactPath = path.join(context.authorityDir, 'quality', `${evidence.provenance.execution_id}.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.origin, 'omni-dual-quality-runner');
        assert.ok(artifact.commands.every((command) => /^[0-9a-f]{64}$/.test(command.output_sha256)));

        await client.evaluateCompletion(context.sessionId, { quality_evidence: evidence });
        assert.equal(store.derive().gates[`quality-cycle-${cycle}`].status, 'PASSED');
    }

    assert.equal(new Set(executionIds).size, 3);
    const completion = await client.evaluateCompletion(context.sessionId);
    assert.equal(completion.verified, true);
    assert.match(completion.receipt.receipt_sha256, /^[0-9a-f]{64}$/);
});

test('E05: source, plan, command, and dependency identity drift reject quality reuse before append', async (t) => {
    const mutations = [
        ['source', (context) => fs.appendFileSync(path.join(context.root, 'index.html'), '<!-- source drift -->\n')],
        ['plan', (context) => fs.appendFileSync(path.join(context.root, '.omni', 'sdlc', 'trust-plan.md'), '\nChanged plan bytes.\n')],
        ['registered command', (_context, artifactPath, evidence) => {
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            const registered = artifact.commands.find((command) => command.id.startsWith('registered-'));
            assert.ok(registered, 'fixture must persist its registered validation command identity');
            registered.args = ['-p', 'process.version'];
            const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
            fs.writeFileSync(artifactPath, bytes);
            evidence.evidence_sha256 = sha(bytes);
        }],
        ['dependency', (context) => fs.appendFileSync(path.join(context.root, 'package-lock.json'), ' ')],
    ];

    for (const [identity, mutate] of mutations) {
        await t.test(identity, async (st) => {
            let context = await registerAndRun(st);
            await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
            const execution = await context.client.executeQualityCycle(context.sessionId, 1);
            const evidence = structuredClone(execution.quality_evidence);
            const artifactPath = path.join(context.authorityDir, 'quality', `${execution.quality_evidence.provenance.execution_id}.json`);

            mutate(context, artifactPath, evidence);
            const rejectedArtifactBytes = fs.readFileSync(artifactPath);
            context = await restartFixtureDaemon(st, context);
            const before = context.authorityStore.readEvents().length;
            await assert.rejects(
                () => context.client.evaluateCompletion(context.sessionId, { quality_evidence: evidence }),
                (error) => /^DUAL_/.test(error?.code || ''),
            );
            assert.equal(context.authorityStore.readEvents().length, before, `${identity} drift must not append a gate`);
            assert.equal(context.authorityStore.derive().gates['quality-cycle-1'], undefined);
            assert.deepEqual(fs.readFileSync(artifactPath), rejectedArtifactBytes, `${identity} rejection must not rewrite preserved evidence bytes`);
        });
    }
});

test('E08: isolated QC rejects an equal-size worker mutation with restored mtime', async (t) => {
    const context = await registerAndRun(t);
    const workerFile = path.join(workerRootFor(context), 'index.html');
    const original = fs.readFileSync(workerFile, 'utf8');
    const stat = fs.statSync(workerFile);
    const mutated = original.replace('Trusted', 'Trvsted');
    assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
    fs.writeFileSync(workerFile, mutated);
    fs.utimesSync(workerFile, stat.atime, stat.mtime);

    const before = context.authorityStore.readEvents().length;
    await assert.rejects(
        () => context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1),
        (error) => /^DUAL_/.test(error?.code || ''),
    );
    assert.equal(context.authorityStore.readEvents().length, before);
    assert.notEqual(context.authorityStore.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
    assert.equal(fs.readFileSync(path.join(context.root, 'index.html'), 'utf8'), '<html><body>Initial</body></html>\n');
});

test('E09: official QC cleans safe caches and rejects cache link escape or cleanup denial', async (t) => {
    await t.test('root and nested safe caches are removed', async (st) => {
        const cacheCode = "f=require('fs');for(p of['node_modules/.vite/x','packages/app/node_modules/.cache/x'])f.mkdirSync(p,{recursive:true})";
        const validationCommands = [{ program: 'node', args: ['-e', cacheCode], cwd: '.' }];
        const context = await registerAndRun(st, { task: { dependency_mode: 'npm-ci', validation_commands: validationCommands } });
        const workerRoot = workerRootFor(context);

        const result = await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
        assert.equal(result.status, 'TASK_VERIFIED');
        assert.equal(fs.existsSync(path.join(workerRoot, 'node_modules', '.vite')), false);
        assert.equal(fs.existsSync(path.join(workerRoot, 'packages', 'app', 'node_modules', '.cache')), false);
    });

    await t.test('Windows junction or POSIX directory symlink escape is rejected', async (st) => {
        const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-trust-cache-outside-')));
        st.after(() => fs.rmSync(outside, { recursive: true, force: true }));
        fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve');
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        const linkCode = `const f=require('fs');f.mkdirSync('node_modules',{recursive:true});f.symlinkSync(${JSON.stringify(outside)},'node_modules/.cache',${JSON.stringify(linkType)})`;
        const context = await registerAndRun(st, { task: {
            validation_commands: [{ program: 'node', args: ['-e', linkCode], cwd: '.' }],
        } });

        const result = await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
        assert.equal(result.status, 'NEEDS_FIX');
        assert.ok(result.cleanup.failures.some((failure) => failure.includes('symlink/junction rejected')));
        assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'preserve');
        assert.equal(context.authorityStore.derive().gates['isolated-qc-TASK-1'], undefined);
        assert.equal(fs.readFileSync(path.join(context.root, 'index.html'), 'utf8'), '<html><body>Initial</body></html>\n');
    });

    await t.test('cache cleanup denial is blocking', async (st) => {
        const cacheCode = "const f=require('fs');f.mkdirSync('node_modules/.cache',{recursive:true});f.writeFileSync('node_modules/.cache/cache.json','{}')";
        const context = await registerAndRun(st, { task: {
            validation_commands: [{ program: 'node', args: ['-e', cacheCode], cwd: '.' }],
        } });
        const workerRoot = workerRootFor(context);
        const cacheRoot = path.join(workerRoot, 'node_modules', '.cache');
        const originalRm = fs.promises.rm;
        fs.promises.rm = async (target, options) => {
            if (path.resolve(target) === path.resolve(cacheRoot)) {
                const error = new Error('cleanup denied by fixture');
                error.code = 'EACCES';
                throw error;
            }
            return originalRm.call(fs.promises, target, options);
        };
        try {
            const result = await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
            assert.equal(result.status, 'NEEDS_FIX');
            assert.ok(result.cleanup.failures.some((failure) => failure.includes('cleanup node_modules/.cache')));
        } finally {
            fs.promises.rm = originalRm;
        }
        assert.equal(fs.existsSync(cacheRoot), true);
        assert.equal(context.authorityStore.derive().gates['isolated-qc-TASK-1'], undefined);
        assert.equal(fs.readFileSync(path.join(context.root, 'index.html'), 'utf8'), '<html><body>Initial</body></html>\n');
    });
});

test('E10: expired lease with unresolved operation stays fenced at the daemon recovery boundary', async (t) => {
    let nowMs = Date.parse('2026-09-10T12:00:00.000Z');
    const context = await beginAndRegister(t, {
        delayMs: 1500,
        delayPhase: 'implement',
        eagerImplementMutation: true,
        captureRunErrors: true,
        storeOptions: { clock: () => new Date(nowMs) },
    });
    await context.client.resumeSession(context.sessionId);
    await waitUntil(
        () => fs.existsSync(path.join(context.authorityDir, 'operations.ndjson'))
            && fs.readFileSync(path.join(context.authorityDir, 'operations.ndjson'), 'utf8').includes('"type":"started"')
            && fs.existsSync(path.join(workerRootFor(context), '.omni', 'codex-gemini', 'runs', 'TASK-1', 'raw', 'implement.1.input.md'))
            && (() => {
                // NOTE (Phase 3): scout/review now run over discussion transport and
                // spawn no OS child process, so the old ">= 2 process.started" trip
                // can never fire — only implement spawns a child. Catch the delayed
                // implement child while it is still active instead; the 'Trusted
                // offline change' mutation lands only when its delay elapses, so it
                // must NOT be part of this wait (it is asserted after the fence).
                const processEvents = context.authorityStore.readEvents();
                const exited = new Set(processEvents
                    .filter((event) => event.type === 'task.process.exited' && event.task_id === 'TASK-1')
                    .map((event) => event.process_id));
                return processEvents.some((event) => event.type === 'task.process.started'
                    && event.task_id === 'TASK-1' && !exited.has(event.process_id));
            })(),
        10_000,
    );
    const processEvents = context.authorityStore.readEvents();
    const exitedProcessIds = new Set(processEvents
        .filter((event) => event.type === 'task.process.exited' && event.task_id === 'TASK-1')
        .map((event) => event.process_id));
    const activeImplementProcesses = processEvents.filter((event) => event.type === 'task.process.started'
        && event.task_id === 'TASK-1' && !exitedProcessIds.has(event.process_id));
    assert.equal(activeImplementProcesses.length, 1, 'E10 must fence the one active implement child');
    const implementProcess = activeImplementProcesses[0];
    nowMs += 180_000;

    const recovery = await context.client.recoverTask(context.sessionId, 'TASK-1', 1);
    assert.ok(
        ['NEEDS_PROCESS_EVIDENCE', 'WAITING_FOR_PROCESS', 'NEEDS_PROCESS_TREE_EVIDENCE'].includes(recovery.status),
        JSON.stringify(recovery),
    );
    assert.notEqual(recovery.status, 'RECOVERED');
    const activeLease = Object.values(context.authorityStore.derive().leases).find((lease) => lease.owner === 'agy');
    assert.notEqual(activeLease.status, 'released');
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'task.lease.recovered'), false);
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'task.completed'), false);

    await assert.rejects(
        () => context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1),
        (error) => error?.code === 'DUAL_ISOLATED_QC_NOT_READY',
        'QC must reject while the stale operation is unresolved',
    );
    await waitUntil(() => context.authorityStore.readEvents().some((event) => event.type === 'task.process.exited'
        && event.task_id === 'TASK-1' && event.lease_id === implementProcess.lease_id
        && event.process_id === implementProcess.process_id), 10_000, () => ({
        operations: fs.existsSync(path.join(context.authorityDir, 'operations.ndjson'))
            ? fs.readFileSync(path.join(context.authorityDir, 'operations.ndjson'), 'utf8') : null,
        events: context.authorityStore.readEvents().map((event) => ({ type: event.type, status: event.status, code: event.code })),
    }));
    assert.deepEqual(context.runErrors?.map((error) => ({ code: error.code, message: error.message })), [{
        code: 'DUAL_ISOLATED_UNAUTHORIZED',
        message: 'Current controller task authority is required',
    }], 'The stale writer must receive the authority fence diagnostic');
    const records = fs.readFileSync(path.join(context.authorityDir, 'operations.ndjson'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line).record);
    assert.deepEqual(records.map((record) => record.type), ['started']);
    assert.match(fs.readFileSync(path.join(workerRootFor(context), 'index.html'), 'utf8'), /Trusted offline change/,
        'The stale worker produced a private mutation before attempting its fenced handoff');
    assert.equal(fs.readFileSync(path.join(context.root, 'index.html'), 'utf8'), '<html><body>Initial</body></html>\n');
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'task.lease.recovered'), false);
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'task.workspace.handoff'), false);
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'task.completed'), false);
    const finalizationFailures = context.authorityStore.readEvents()
        .filter((event) => event.type === 'task.execution.finalization_failed' && event.task_id === 'TASK-1');
    assert.equal(finalizationFailures.length, 1);
    assert.equal(finalizationFailures[0].settled, false);
    assert.equal(context.authorityStore.derive().leases[implementProcess.lease_id].status, 'expired');
});

test('E14: a worker that ignores deny_patterns is rejected before handoff, integration, or completion', async (t) => {
    const context = await beginAndRegister(t, { rogueForbiddenWrite: true });
    await context.client.resumeSession({ session_id: context.sessionId, task_id: 'TASK-1', plan_revision: 1 });
    await waitUntil(
        () => {
            const events = context.authorityStore.readEvents();
            return events.some((event) => event.type === 'task.execution.outcome'
                || event.type === 'task.workspace.handoff');
        },
        20_000,
        () => context.authorityStore.readEvents().map((event) => ({ type: event.type, code: event.code })),
    );
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'task.workspace.handoff'), false,
        'Denied worker output must not reach handoff');

    const acquired = context.authorityStore.readEvents().find((event) =>
        event.type === 'lease.acquired' && event.task_id === 'TASK-1');
    assert.ok(acquired?.lease_id);
    await waitUntil(() => context.authorityStore.readEvents().some((event) =>
        event.type === 'lease.released' && event.lease_id === acquired.lease_id
        && event.task_id === 'TASK-1'), 20_000);
    assert.equal(context.authorityStore.derive().leases[acquired.lease_id].status, 'released');

    const events = context.authorityStore.readEvents();
    const outcome = events.find((event) => event.type === 'task.execution.outcome');
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.code, 'DUAL_DENY_PATTERN');
    assert.equal(fs.existsSync(path.join(workerRootFor(context), 'forbidden', 'rogue.txt')), true,
        'Malicious private output is preserved for diagnosis');
    assert.equal(fs.existsSync(path.join(context.root, 'forbidden', 'rogue.txt')), false);
    assert.equal(events.some((event) => event.type === 'task.workspace.handoff'), false);
    assert.equal(events.some((event) => event.type === 'task.completed'), false);
    assert.equal(events.some((event) => event.gate_id === 'isolated-qc-TASK-1'), false);
    assert.notEqual(context.authorityStore.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
});

test('E13: legacy quality events remain readable but cannot issue a fresh receipt', async (t) => {
    const context = await registerAndRun(t);
    await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
    const measured = await context.client.executeQualityCycle(context.sessionId, 1);
    appendLegacyQualityCycles(context, measured.quality_evidence.diff_fingerprint);

    const legacyDerived = context.authorityStore.derive();
    assert.deepEqual(
        [1, 2, 3].map((cycle) => legacyDerived.gates[`quality-cycle-${cycle}`].status),
        ['PASSED', 'PASSED', 'PASSED'],
        'Legacy ledger must remain replayable and readable',
    );
    const before = context.authorityStore.readEvents().length;
    const completion = await context.client.evaluateCompletion(context.sessionId);

    assert.equal(completion.verified, false);
    assert.deepEqual(
        completion.blockers.filter((blocker) => blocker.startsWith('QUALITY_CYCLE_MISSING:')).sort(),
        [1, 2, 3].map((cycle) => `QUALITY_CYCLE_MISSING: Quality cycle ${cycle} has not been recorded`),
        'Unanchored legacy gates remain readable but do not belong to the required current generation',
    );
    assert.equal(context.authorityStore.readEvents().length, before, 'Legacy rejection must not append authority events');
    assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'session.verified'), false);
    assert.equal(context.authorityStore.derive().receipt, null);
    assert.equal(fs.existsSync(path.join(context.authorityDir, 'accepted-snapshot.json')), false);
});

test('E15: missing, malformed, tampered, and false-output-hash artifacts reject before gate append', async (t) => {
    const mutations = [
        ['missing', (artifactPath) => fs.rmSync(artifactPath)],
        ['malformed', (artifactPath) => fs.writeFileSync(artifactPath, '{')],
        ['tampered', (artifactPath) => fs.appendFileSync(artifactPath, ' ')],
        ['wrong output_sha256', (artifactPath, evidence) => {
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            artifact.commands[0].output_sha256 = 'f'.repeat(64);
            const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
            fs.writeFileSync(artifactPath, bytes);
            evidence.evidence_sha256 = sha(bytes);
        }],
    ];

    for (const [label, mutate] of mutations) {
        await t.test(label, async (st) => {
            let context = await registerAndRun(st);
            await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
            const execution = await context.client.executeQualityCycle(context.sessionId, 1);
            const evidence = structuredClone(execution.quality_evidence);
            const artifactPath = path.join(context.authorityDir, 'quality', `${evidence.provenance.execution_id}.json`);
            mutate(artifactPath, evidence);
            context = await restartFixtureDaemon(st, context);
            const before = context.authorityStore.readEvents().length;

            await assert.rejects(
                () => context.client.evaluateCompletion(context.sessionId, { quality_evidence: evidence }),
                (error) => /^DUAL_QUALITY_/.test(error?.code || ''),
            );
            assert.equal(context.authorityStore.readEvents().length, before, `${label} rejection must not append a gate`);
            assert.equal(context.authorityStore.derive().gates['quality-cycle-1'], undefined);
            assert.equal(context.authorityStore.readEvents().some((event) => event.type === 'session.verified'), false);
            assert.equal(context.authorityStore.derive().receipt, null);
        });
    }
});

test('E15: trusted runner recomputes output_sha256 from canonical command output', async (t) => {
    const canonicalOutput = 'canonical daemon output\n';
    const trustedQualityRunner = createTrustedQualityRunner({
        executeQualityPlanImpl: (plan) => plan.commands.map((command) => ({
            ...command,
            command: `${command.program} ${command.args.join(' ')}`.trim(),
            exit_code: 0,
            duration_ms: 1,
            ok: true,
            failure: null,
            signal: null,
            started_at: '2026-09-10T01:00:00.000Z',
            ended_at: '2026-09-10T01:00:00.001Z',
            stdout: canonicalOutput,
            stderr: '',
            output_sha256: 'f'.repeat(64),
        })),
    });
    const context = await registerAndRun(t, { serverOptions: { trustedQualityRunner } });
    await context.client.completeIsolatedTask(context.sessionId, 'TASK-1', 1);
    const execution = await context.client.executeQualityCycle(context.sessionId, 1);
    const artifactPath = path.join(
        context.authorityDir,
        'quality',
        `${execution.quality_evidence.provenance.execution_id}.json`,
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    assert.equal(artifact.commands[0].output_sha256, sha(canonicalOutput));
    assert.notEqual(artifact.commands[0].output_sha256, 'f'.repeat(64));
});
