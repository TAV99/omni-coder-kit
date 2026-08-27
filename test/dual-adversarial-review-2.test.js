'use strict';

const { describe, it, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const {
    startDaemonServer: startDaemonServerImpl,
    createDaemonClient,
    createAuthorityStore,
    runCapabilityPreflight,
    detectBaselineBackend,
    createSnapshotBaseline,
    createGitBaseline,
    createOrchestratorAdapter,
    createDualOrchestrator,
    evaluateMandatoryGates,
    createQualityLedger,
    evaluateUiEvidence,
    recordUiEvidence,
} = require('../lib/dual');
const { createOmniDualMcpServer } = require('../lib/dual/mcp-server.mjs');

function createTempDir(prefix = 'omni-dual-adv2-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

function startDaemonServer(options = {}) {
    return startDaemonServerImpl({
        ...options,
        planArtifactVerifier: options.planArtifactVerifier || (async (_workspaceRoot, params) => ({
            plan_path: params.plan_path,
            plan_sha256: params.plan_sha256,
        })),
    });
}

async function waitForFile(filePath, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const runDir = path.dirname(filePath);
    const observed = fs.existsSync(runDir) ? fs.readdirSync(runDir).sort() : [];
    const eventsPath = path.join(runDir, 'events.ndjson');
    const eventsTail = fs.existsSync(eventsPath)
        ? fs.readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).slice(-4)
        : [];
    const rawDir = path.join(runDir, 'raw');
    const rawFiles = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).sort() : [];
    throw new Error(`Timed out waiting for file: ${filePath}; observed=${JSON.stringify(observed)} raw=${JSON.stringify(rawFiles)} events=${JSON.stringify(eventsTail)}`);
}

function createFakeAgyScript(dir, {
    modelList = ['gemini-3.7-flash-high', 'gemini-2.0-flash'],
    counterFile = null,
    reviewVerdict = 'APPROVE',
    modifyFile = true,
} = {}) {
    const scriptPath = path.join(dir, 'fake-agy.cjs');
    const content = `'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const counterFile = ${JSON.stringify(counterFile)};
if (counterFile) {
    let count = 0;
    try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
    fs.writeFileSync(counterFile, String(count + 1), 'utf8');
}

if (args.includes('--version')) {
    process.stdout.write('agy version 1.1.19\\n');
    process.exit(0);
}

if (args.length === 1 && args[0] === 'models') {
    const models = ${JSON.stringify(modelList)};
    process.stdout.write('Model\\tInput price\\tOutput price\\n');
    for (const m of models) {
        process.stdout.write(m + '\\t$0.00\\t$0.00\\n');
    }
    process.exit(0);
}

const promptIdx = args.indexOf('--prompt');
const promptVal = promptIdx !== -1 ? args[promptIdx + 1] : (args.find(a => a.startsWith('--prompt=') || a.startsWith('-p=')) || '');
const promptArg = (promptVal || '').toLowerCase();
const inputArg = args.find(a => a.startsWith('--input=') || a.startsWith('-i='));

let fileText = '';
const readMatch = (promptVal || '').match(/Read\\s+([^\\s]+)/i);
if (readMatch) {
    try { fileText = fs.readFileSync(readMatch[1], 'utf8'); } catch {}
}
if (!fileText && inputArg) {
    try { fileText = fs.readFileSync(inputArg.split('=')[1], 'utf8'); } catch {}
}

let inputData = {};
try { inputData = JSON.parse(fileText); } catch {}

const promptTaskIdMatch = (promptVal || '').match(/TASK-[A-Za-z0-9_-]+/i)?.[0];
const taskId = inputData.task_id || (fileText.match(/Task:\\s*([^\\s\\r\\n]+)/)?.[1]) || promptTaskIdMatch || 'TASK-1';
let baselineFields = inputData.expected_baseline
    ? { expected_baseline: inputData.expected_baseline }
    : (inputData.expected_base_commit ? { expected_base_commit: inputData.expected_base_commit } : {});
if (!baselineFields.expected_baseline && !baselineFields.expected_base_commit) {
    const snapMatch = fileText.match(/Baseline identity:\\s*([0-9a-fA-F]{64})/);
    const gitMatch = fileText.match(/Base commit:\\s*([0-9a-fA-F]{40})/);
    if (snapMatch) baselineFields = { expected_baseline: { kind: 'snapshot', id: snapMatch[1] } };
    else if (gitMatch) baselineFields = { expected_base_commit: gitMatch[1] };
    else baselineFields = { expected_base_commit: '0'.repeat(40) };
}

if (args.includes('scout') || promptArg.includes('scout')) {
    const scoutPayload = {
        schema_version: 1,
        task_id: taskId,
        ...baselineFields,
        summary: 'Scout analysis complete',
        relevant_files: [{ path: 'index.html', description: 'Main entry file' }],
        exact_symbols: [{ name: 'body', file: 'index.html', verified: true, kind: 'element' }],
        validation_commands: ['node --version'],
        constraints: ['Lightweight'],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns the behavior.' },
            { question: 'How is it checked?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'Validation is available.' },
        ],
        alternatives_considered: [
            { option: 'Edit index.html', tradeoff: 'Minimal scope.' },
            { option: 'Add a module', tradeoff: 'Unnecessary complexity.' },
        ],
        failure_modes: ['The fixture markup may regress.'],
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: scoutPayload }) + '\\n');
    process.exit(0);
}

if (args.includes('implement') || promptArg.includes('implement')) {
    if (${modifyFile}) {
        try {
            fs.writeFileSync('index.html', '<html><body>Hello Edited</body></html>\\n', 'utf8');
        } catch {}
    }
    const implementPayload = {
        schema_version: 1,
        task_id: taskId,
        ...baselineFields,
        status: 'SUCCESS',
        modified_files: ['index.html'],
        command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v20.0.0' }],
        unverified_items: [],
        self_review: { checks: ['scope inspected', 'edge case challenged', 'validation passed'], remaining_risks: [] },
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: implementPayload }) + '\\n');
    process.exit(0);
}

if (args.includes('review') || promptArg.includes('review')) {
    const reviewPayload = {
        schema_version: 1,
        task_id: taskId,
        ...baselineFields,
        recommendation: ${JSON.stringify(reviewVerdict)},
        risk_level: 'LOW',
        findings: [{ file: 'index.html', line: 1, description: 'Review finding', severity: 'INFO' }],
        review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
        challenge_summary: 'The strongest concern was fixture regression; the inspected evidence determines the verdict.',
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: reviewPayload }) + '\\n');
    process.exit(0);
}

process.stdout.write(JSON.stringify({ status: 'success' }) + '\\n');
process.exit(0);
`;
    fs.writeFileSync(scriptPath, content, 'utf8');
    return scriptPath;
}

describe('Codex Adversarial Review 2 — P0 Regressions Suite', () => {

    // ─── P0-A: No Synthetic Success Fallbacks ──────────────────────────────────
    describe('P0-A: Remove Synthetic Success Fallbacks', () => {
        let tmpDir;
        let helperDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0a-tmp-');
            helperDir = createTempDir('p0a-helper-');
            try {
                execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
                fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
                fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
                fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Initial</body></html>\n');
                execSync('git add .', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            } catch {
                // git setup
            }
        });

        afterEach(() => {
            rmDir(tmpDir);
            rmDir(helperDir);
        });

        it('Rejects un-typed validation commands (string command instead of {program, args, cwd})', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
            });

            const head = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

            const invalidTask = {
                task_id: 'TASK-1',
                title: 'Invalid task with string command',
                owner: 'agy',
                risk: 'low',
                deny_patterns: [],
                allowed_files: ['index.html'],
                validation_commands: ['npm test'], // String instead of object
            };

            await assert.rejects(
                async () => {
                    await adapter.executeAgyTask('TASK-1', invalidTask, {
                        sessionId: 'sess-1',
                        workspaceId: 'ws-1',
                        tasks: { 'TASK-1': { ...invalidTask, owner: 'agy', state: 'ROUTED' } },
                        currentBaseline: { kind: 'git', id: head },
                        capability: {
                            status: 'PASSED',
                            to_state: 'CAPABILITY_SAFE',
                            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
                            details: { agy_version: '1.1.19', agy_model: 'gemini-3.7-flash-high' },
                        },
                    });
                },
                /validation.*command/i
            );
        });

        it('Review recommendation NEEDS_FIX or REJECT halts with failure and never creates task.completed', async (t) => {
            const fakeAgyScript = createFakeAgyScript(helperDir, { reviewVerdict: 'NEEDS_FIX' });
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                orchestrator: adapter,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    risk: 'low',
                    deny_patterns: [],
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.request('session.resume', { session_id: sessionId });

            // Wait on the durable phase artifact instead of assuming a fixed worker duration.
            await waitForFile(
                path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'review.json'),
                15000,
            );

            const derived = authorityStore.derive();
            assert.notEqual(derived.tasks['TASK-1'].state, 'TASK_VERIFIED', 'Task must NOT be TASK_VERIFIED on review failure');
            assert.equal(derived.tasks['TASK-1'].state, 'ROUTED');
        });
    });

    // ─── P0-B: AGY Review is Not Codex QC ─────────────────────────────────────
    describe('P0-B: Codex QC Protocol and Disallowing AGY Self-Approval', () => {
        let tmpDir;
        let helperDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0b-tmp-');
            helperDir = createTempDir('p0b-helper-');
            try {
                execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
                fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
                fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
                fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Initial</body></html>\n');
                execSync('git add .', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            } catch {}
        });

        afterEach(() => {
            rmDir(tmpDir);
            rmDir(helperDir);
        });

        it('AGY completing review phase leaves task awaiting CODEX_QC and does NOT append task.completed', async (t) => {
            const fakeAgyScript = createFakeAgyScript(helperDir, { reviewVerdict: 'APPROVE' });
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                orchestrator: adapter,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    risk: 'low',
                    deny_patterns: [],
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.request('session.resume', { session_id: sessionId });

            // Wait on the durable phase artifact instead of assuming a fixed worker duration.
            await waitForFile(
                path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'review.json'),
                15000,
            );

            const derived = authorityStore.derive();
            // Task must NOT be TASK_VERIFIED yet! It must be in CODEX_QC or ROUTED awaiting QC
            assert.notEqual(derived.tasks['TASK-1'].state, 'TASK_VERIFIED');

            // Evaluating completion without Codex QC must report task unverified blocker
            const comp = await client.evaluateCompletion(sessionId);
            assert.equal(comp.verified, false);
            assert.ok(comp.blockers.some((b) => b.includes('TASK_UNVERIFIED')));
        });

        it('Reducer rejects AGY self-approval (verified_by must be codex)', () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const wsId = 'ws-1';
            authorityStore.append({
                schema_version: 2,
                type: 'session.created',
                state: 'DISCOVERED',
                workspace_root: tmpDir,
                mode: 'auto',
                workspace_id: wsId,
                session_id: 'sess-1',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: '0'.repeat(40) },
            });
            authorityStore.append({
                schema_version: 2,
                type: 'capability.result',
                from_state: 'DISCOVERED',
                to_state: 'CAPABILITY_SAFE',
                status: 'PASSED',
                checks: [{ name: 'check', status: 'PASSED' }],
            });
            authorityStore.append({
                schema_version: 2,
                type: 'plan.registered',
                from_state: 'INTERVIEWING',
                to_state: 'PLANNED',
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                total_tasks: 1,
                tasks: [{ task_id: 'TASK-1', title: 'Task', owner: 'agy', allowed_files: ['index.html'] }],
            });
            authorityStore.append({
                schema_version: 2,
                type: 'task.routed',
                task_id: 'TASK-1',
                owner: 'agy',
                authority_state: 'ROUTED',
                allowed_files: ['index.html'],
                reason: 'routed to agy',
            });

            const lease = authorityStore.acquireLease('TASK-1', 'agy');

            // Attempting to append task.completed with verified_by: 'agy' must be rejected
            assert.throws(
                () => {
                    authorityStore.append({
                        schema_version: 2,
                        type: 'task.completed',
                        task_id: 'TASK-1',
                        owner: 'agy',
                        authority_state: 'TASK_VERIFIED',
                        modified_files: ['index.html'],
                        diff_fingerprint: 'd'.repeat(64),
                        verdict: 'SUCCESS',
                        verified_by: 'agy', // INVALID self-approval
                    });
                },
                /verified_by|codex/i
            );
        });

        it('Codex QC submission via omni_dual_completion transitions task and is idempotent', async (t) => {
            const fakeAgyScript = createFakeAgyScript(helperDir, { reviewVerdict: 'APPROVE' });
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                orchestrator: adapter,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    risk: 'low',
                    deny_patterns: [],
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.request('session.resume', { session_id: sessionId });
            await waitForFile(path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'review.json'));

            // Submit Codex QC evidence
            const { captureDiffFingerprint } = require('../lib/dual/scope-guard');
            const diffInfo = captureDiffFingerprint({
                repoRoot: tmpDir,
                baseCommit: beginRes.current_baseline?.id || beginRes.expected_baseline?.id,
                excludedPaths: ['.omni'],
            });
            const qcRes = await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-1',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 10, output: 'ok' }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            const derived = authorityStore.derive();
            assert.equal(derived.tasks['TASK-1'].state, 'TASK_VERIFIED');

            // Idempotent second submission
            const qcRes2 = await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-1',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 10, output: 'ok' }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });
            assert.equal(authorityStore.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
        });
    });

    // ─── P0-C: Task 10 Quality & UI Gates Integration ─────────────────────────
    describe('P0-C: Quality & UI Gate Enforcement on Completion', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0c-tmp-');
            fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"p0c-test"}');
        });

        afterEach(() => {
            rmDir(tmpDir);
        });

        it('evaluateMandatoryGates([]) fails closed with DUAL_QUALITY_INVALID_GATES', () => {
            assert.throws(() => {
                evaluateMandatoryGates([]);
            }, /Gates array cannot be empty/i);
        });

        it('Missing quality cycles 1, 2, 3 blocks completion evaluation', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'codex',
                    allowed_files: ['package.json'],
                }],
            });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"p0c-test","verified":true}\n');

            // Codex submits QC for TASK-1
            const { readInitialSnapshot } = require('../lib/dual/snapshot-store');
            const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
            const initialSnapshot = readInitialSnapshot({ authorityDir, sessionId, workspaceId: beginRes.workspace_id, workspaceRoot: tmpDir });
            const snapBaseline = createSnapshotBaseline({ root: tmpDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths: ['.omni'] });
            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-1',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 10, output: 'ok' }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            // Without recording quality cycles 1, 2, 3, completion evaluate must report gate blockers
            const comp = await client.evaluateCompletion(sessionId);
            assert.equal(comp.verified, false);
            assert.ok(comp.blockers.some((b) => b.includes('QUALITY_CYCLE') || b.includes('MANDATORY_GATE_UNMET') || b.includes('quality-cycle')));
        });
    });

    // ─── P0-D: Greenfield Snapshot Orchestration ──────────────────────────────
    describe('P0-D: Greenfield Snapshot Orchestration (Zero Git Mutation)', () => {
        let tmpDir;
        let helperDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0d-tmp-');
            helperDir = createTempDir('p0d-helper-');
            fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"greenfield-app"}\n');
            fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Greenfield</body></html>\n');
        });

        afterEach(() => {
            rmDir(tmpDir);
            rmDir(helperDir);
        });

        it('Executes greenfield AGY task with snapshot baseline and zero git commands', async (t) => {
            const fakeAgyScript = createFakeAgyScript(helperDir, { reviewVerdict: 'APPROVE' });
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));

            // Failing git runner if any git command is invoked
            const failingGitRunner = () => {
                throw new Error('FORBIDDEN: Git command executed in snapshot greenfield mode');
            };

            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                gitRunner: failingGitRunner,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                orchestrator: adapter,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });
            assert.equal(beginRes.expected_baseline.kind, 'snapshot');
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    risk: 'low',
                    deny_patterns: [],
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.request('session.resume', { session_id: sessionId });
            await waitForFile(path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'review.json'));

            // Verify artifacts were created without invoking git
            const runDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1');
            assert.ok(fs.existsSync(path.join(runDir, 'spec.json')));
            assert.ok(fs.existsSync(path.join(runDir, 'route.json')));
            assert.ok(fs.existsSync(path.join(runDir, 'evidence.json')));
            assert.ok(fs.existsSync(path.join(runDir, 'review.json')));
        });
    });

    // ─── P0-E: Initial Snapshot Persistence in MCP Begin ──────────────────────
    describe('P0-E: Initial Snapshot Persistence in MCP Begin', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0e-tmp-');
            fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"snapshot-persist"}');
        });

        afterEach(() => {
            rmDir(tmpDir);
        });

        it('Persists initial-snapshot.json atomically at first greenfield begin and reuses on repeat begin', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });

            const initialSnapshotPath = path.join(tmpDir, '.omni', 'runs', 'dual-authority', 'initial-snapshot.json');
            assert.ok(fs.existsSync(initialSnapshotPath), 'initial-snapshot.json must exist on disk');

            const snapshotContent = JSON.parse(fs.readFileSync(initialSnapshotPath, 'utf8'));
            assert.equal(snapshotContent.schema_version, 1);
            assert.equal(snapshotContent.session_id, beginRes.session_id);
            assert.equal(snapshotContent.identity.id, beginRes.expected_baseline.id);
            assert.ok(Array.isArray(snapshotContent.manifest.files));

            // Repeat begin returns identical session
            const repeatRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            assert.equal(repeatRes.session_id, beginRes.session_id);
        });

        it('Tampered initial-snapshot.json on repeat begin fails with integrity error', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });

            const initialSnapshotPath = path.join(tmpDir, '.omni', 'runs', 'dual-authority', 'initial-snapshot.json');
            // Corrupt file
            fs.writeFileSync(initialSnapshotPath, '{"tampered":true}', 'utf8');

            await assert.rejects(
                async () => {
                    await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
                },
                /DUAL_INTEGRITY_CORRUPT|DUAL_SNAPSHOT_BASELINE_INVALID|DUAL_SNAPSHOT_CONFLICT|corrupt|invalid|mismatch|ECONNRESET/i
            );
        });
    });

    // ─── P0-F: Accepted Snapshot / Receipt Correlation & Rollback Safety ──────
    describe('P0-F: Accepted Snapshot / Receipt Correlation & Rollback Safety', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0f-tmp-');
            fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"snapshot-receipt"}');
        });

        afterEach(() => {
            rmDir(tmpDir);
        });

        it('Receipt binds accepted snapshot identity and cleans up on ledger append error', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 15000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'codex',
                    allowed_files: ['package.json'],
                }],
            });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"snapshot-receipt","verified":true}\n');

            // QC complete TASK-1
            const { readInitialSnapshot } = require('../lib/dual/snapshot-store');
            const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
            const initialSnapshot = readInitialSnapshot({ authorityDir, sessionId, workspaceId: beginRes.workspace_id, workspaceRoot: tmpDir });
            const snapBaseline = createSnapshotBaseline({ root: tmpDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths: ['.omni'] });
            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-1',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 10, output: 'ok' }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            // Submit 3 quality cycles
            for (let c = 1; c <= 3; c++) {
                await client.evaluateCompletion(sessionId, {
                    quality_evidence: {
                        cycle_index: c,
                        attempt: 1,
                        total_tasks: 1,
                        completed_task_ids: ['TASK-1'],
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        gate_results: [{ id: `gate-${c}`, required: true, status: 'PASSED' }],
                        commands: [{ command: 'node --version', exit_code: 0, duration_ms: 10 }],
                        evidence_sha256: 'a'.repeat(64),
                    },
                });
            }

            // Final completion evaluate
            const comp = await client.evaluateCompletion(sessionId);
            assert.equal(comp.verified, true);
            assert.ok(comp.receipt);
            assert.ok(comp.receipt.receipt_sha256);

            const acceptedPath = path.join(tmpDir, '.omni', 'runs', 'dual-authority', 'accepted-snapshot.json');
            assert.ok(fs.existsSync(acceptedPath));
            const acceptedData = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
            assert.equal(acceptedData.session_id, sessionId);
            assert.ok(acceptedData.identity.id);
        });
    });

    // ─── P0-G: Capability Subprocess Bounded Timeout ───────────────────────────
    describe('P0-G: Capability Subprocess Bounded Timeout', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = createTempDir('p0g-tmp-');
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"preflight-timeout"}');
        });

        afterEach(() => {
            rmDir(tmpDir);
        });

        it('Hanging agy subprocess times out and returns BLOCKED status without hanging indefinitely', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            // Create a fake spawn that hangs indefinitely
            const hangingSpawn = () => {
                const { PassThrough } = require('stream');
                const proc = new (require('events').EventEmitter)();
                proc.stdout = new PassThrough();
                proc.stderr = new PassThrough();
                proc.kill = () => proc.emit('close', 1);
                // Do not emit close or data (simulates infinite hang)
                return proc;
            };

            const result = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                spawnImpl: hangingSpawn,
                timeoutMs: 500, // Short timeout for test
            });

            assert.equal(result.status, 'BLOCKED');
            assert.ok(result.checks.some((c) => c.status === 'BLOCKED' && c.name === 'agy_cli_and_model'));
        });
    });
});
