'use strict';

const { describe, it, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn, spawnSync } = require('child_process');

const {
    startDaemonServer: startDaemonServerImpl,
    createDaemonClient,
    createAuthorityStore,
    runCapabilityPreflight,
    evaluateHook,
    detectBaselineBackend,
    createSnapshotBaseline,
    createGitBaseline,
    createOrchestratorAdapter,
    writeInitialSnapshot,
    readInitialSnapshot,
    readAcceptedSnapshot,
    runProcess,
    executeSetupManifest,
} = require('../lib/dual');
const { createOmniDualMcpServer } = require('../lib/dual/mcp-server.mjs');
const { captureDiffFingerprint } = require('../lib/dual/scope-guard');
const { buildCodexConfig, buildCodexHooks, buildInitConfig } = require('../lib/init');

function createTempDir(prefix = 'omni-dual-orch-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

function createPassingCapability() {
    return {
        status: 'PASSED',
        to_state: 'CAPABILITY_SAFE',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: {
            agy_version: '1.1.19-test',
            agy_model: 'gemini-3.7-flash-high',
            agy_evidence: {
                version: '1.1.19-test',
                model: 'gemini-3.7-flash-high',
            },
        },
    };
}

function passingPreflightDetails(result) {
    if (!result || result.status !== 'PASSED') {
        return result;
    }
    const checks = Array.isArray(result.checks) ? [...result.checks] : [];
    if (!checks.some((check) => check.name === 'agy_cli_and_model')) {
        checks.push({ name: 'agy_cli_and_model', status: 'PASSED' });
    }
    return {
        ...result,
        checks,
        details: {
            ...(result.details || {}),
            agy_version: result.details?.agy_version || '1.1.19-test',
            agy_model: result.details?.agy_model || 'gemini-3.7-flash-high',
            agy_evidence: {
                version: result.details?.agy_evidence?.version || result.details?.agy_version || '1.1.19-test',
                model: result.details?.agy_evidence?.model || result.details?.agy_model || 'gemini-3.7-flash-high',
            },
        },
    };
}

async function startDaemonServer(options = {}) {
    const testPlanArtifactVerifier = async (_workspaceRoot, params) => ({
        plan_path: params.plan_path,
        plan_sha256: params.plan_sha256,
    });
    const effectiveOptions = {
        ...options,
        planArtifactVerifier: options.planArtifactVerifier || testPlanArtifactVerifier,
    };
    const injected = options.capabilityPreflight || options.preflightRunner;
    if (!injected) return startDaemonServerImpl(effectiveOptions);
    const wrapped = async (...args) => passingPreflightDetails(await injected(...args));
    return startDaemonServerImpl({
        ...effectiveOptions,
        ...(options.capabilityPreflight
            ? { capabilityPreflight: wrapped }
            : { preflightRunner: wrapped }),
    });
}

function initGitRepo(repoRoot) {
    let init = spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    if (init.status !== 0) {
        init = spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf8' });
    }
    assert.equal(init.status, 0, init.stderr || 'git init failed');
    assert.equal(spawnSync('git', ['config', 'user.email', 'dual-test@example.invalid'], { cwd: repoRoot }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Dual Test'], { cwd: repoRoot }).status, 0);
    fs.writeFileSync(path.join(repoRoot, 'index.html'), '<html><body>Initial</body></html>\n', 'utf8');
    assert.equal(spawnSync('git', ['add', 'index.html'], { cwd: repoRoot }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot }).status, 0);
}

function createFakeAgyScript(dir, {
    modelList = ['gemini-3.7-flash-high', 'gemini-2.0-flash'],
    counterFile = null,
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
        process.stdout.write(\`\${m}\\t$0.00\\t$0.00\\n\`);
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
    try {
        fileText = fs.readFileSync(readMatch[1], 'utf8');
    } catch {}
}
if (!fileText && inputArg) {
    try {
        const inputPath = inputArg.split('=')[1];
        fileText = fs.readFileSync(inputPath, 'utf8');
    } catch {}
}

let inputData = {};
try { inputData = JSON.parse(fileText); } catch {}

const promptTaskIdMatch = (promptVal || '').match(/TASK-[A-Za-z0-9_-]+/i)?.[0];
const taskId = inputData.task_id || (fileText.match(/Task:\\s*([^\\s\\r\\n]+)/)?.[1]) || promptTaskIdMatch || 'TASK-1';
let baselineData = {};
if (inputData.expected_baseline) {
    baselineData = { expected_baseline: inputData.expected_baseline };
} else if (inputData.expected_base_commit) {
    baselineData = { expected_base_commit: inputData.expected_base_commit };
} else if (fileText) {
    const snapMatch = fileText.match(/Baseline identity:\\s*([0-9a-fA-F]{64})/);
    if (snapMatch) {
        baselineData = { expected_baseline: { kind: 'snapshot', id: snapMatch[1] } };
    } else {
        const gitMatch = fileText.match(/Base commit:\\s*([0-9a-fA-F]{40})/);
        if (gitMatch) {
            baselineData = { expected_base_commit: gitMatch[1] };
        }
    }
}
if (!baselineData.expected_baseline && !baselineData.expected_base_commit) {
    try {
        const { execSync } = require('node:child_process');
        const head = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        baselineData = { expected_base_commit: head };
    } catch {
        baselineData = { expected_base_commit: '0'.repeat(40) };
    }
}

if (args.includes('scout') || promptArg.includes('scout')) {
    const scoutPayload = {
        schema_version: 1,
        task_id: taskId,
        ...baselineData,
        summary: 'Scout analysis complete',
        relevant_files: [{ path: 'index.html', description: 'Main entry file' }],
        exact_symbols: [{ name: 'body', file: 'index.html', verified: true, kind: 'element' }],
        validation_commands: ['node --version'],
        constraints: ['Lightweight'],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns the behavior.' },
            { question: 'How is it checked?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'The runtime validation is available.' },
        ],
        alternatives_considered: [
            { option: 'Edit index.html', tradeoff: 'Minimal scope.' },
            { option: 'Add a module', tradeoff: 'Unnecessary complexity.' },
        ],
        failure_modes: ['The static markup could regress.'],
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: scoutPayload }) + '\\n');
    process.exit(0);
}

if (args.includes('implement') || promptArg.includes('implement')) {
    try {
        fs.writeFileSync('index.html', '<html><body>Hello Edited</body></html>\\n', 'utf8');
    } catch {}
    const implementPayload = {
        schema_version: 1,
        task_id: taskId,
        ...baselineData,
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
        ...baselineData,
        recommendation: 'APPROVE',
        risk_level: 'LOW',
        findings: [{ file: 'index.html', line: 1, description: 'Clean change', severity: 'INFO' }],
        review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
        challenge_summary: 'The strongest concern was markup regression; the inspected diff is bounded.',
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

describe('Task 11: Dual AUTO Daemon Orchestrator Integration Suite', () => {

    // ─── Scenario 1 & 2: Init Configuration ──────────────────────────────────

    describe('Init configuration contracts', () => {
        it('Dual AUTO init emits daemon-aware hooks and an omni_dual MCP entry', () => {
            const config = buildCodexConfig('dual', true, { dualPair: 'codex-agy', mode: 'auto' });
            assert.ok(config, 'config should not be null');
            assert.ok(config.includes('hooks = true'), 'should have [features] hooks = true');
            assert.ok(!config.includes('codex_hooks'), 'must not contain deprecated codex_hooks');
            assert.ok(config.includes('[mcp_servers.omni_dual]'), 'should declare omni_dual MCP server');
            assert.ok(config.includes('mcp-server.mjs'), 'should reference mcp-server.mjs');

            const hooksStr = buildCodexHooks('dual', true, { dualPair: 'codex-agy', mode: 'auto' });
            assert.ok(hooksStr, 'hooks should not be null');
            const parsed = JSON.parse(hooksStr);
            assert.ok(parsed.hooks.SessionStart);
            assert.ok(parsed.hooks.UserPromptSubmit);
            assert.ok(parsed.hooks.PreToolUse);
            assert.ok(parsed.hooks.PostToolUse);
            assert.ok(parsed.hooks.Stop);
            assert.ok(!hooksStr.includes('__OMNI_HOOK_COMMAND_'), 'placeholders must be materialized');
        });

        it('Manual/single-agent init does not force the authority daemon', () => {
            const codexConfig = buildCodexConfig('codex', true);
            const codexHooks = buildCodexHooks('codex', true);
            assert.ok(codexConfig);
            assert.ok(!codexConfig.includes('[mcp_servers.omni_dual]'));
            assert.equal(codexHooks, null);

            const manualConfig = buildCodexConfig('dual', true, { dualPair: 'codex-agy', mode: 'manual' });
            const manualHooks = buildCodexHooks('dual', true, { dualPair: 'codex-agy', mode: 'manual' });
            assert.ok(manualConfig);
            assert.ok(!manualConfig.includes('[mcp_servers.omni_dual]'));
            assert.equal(manualHooks, null);
        });

        it('Generated workflows use only canonical omni skills and omni skills add commands', () => {
            const templatePath = path.join(__dirname, '..', 'templates', 'workflows', 'skill-manager.md');
            if (fs.existsSync(templatePath)) {
                const content = fs.readFileSync(templatePath, 'utf8');
                assert.ok(!content.includes('omni auto-equip'), 'must not contain omni auto-equip');
                assert.ok(!content.includes('omni equip '), 'must not contain omni equip');
                assert.ok(content.includes('omni skills'), 'must contain omni skills');
            }
        });
    });

    // ─── Scenario 3: Baseline Detection ──────────────────────────────────────

    describe('Baseline detection on session begin', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir(); });
        afterEach(() => { rmDir(tmpDir); });

        it('Greenfield begin selects snapshot without running any Git mutation', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"greenfield"}');
            const backend = detectBaselineBackend(tmpDir);
            assert.equal(backend, 'snapshot');

            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });

            assert.equal(beginRes.session_state, 'DISCOVERED');
            assert.equal(beginRes.baseline.kind, 'snapshot');
            assert.ok(beginRes.baseline.id);
            assert.equal(fs.existsSync(path.join(tmpDir, '.git')), false, 'must not create .git');
        });

        it('Existing Git begin selects Git HEAD', async (t) => {
            try {
                execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
                fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
                execSync('git add file.txt', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
            } catch (err) {
                t.skip('Git CLI not available in environment');
                return;
            }

            const backend = detectBaselineBackend(tmpDir);
            assert.equal(backend, 'git');

            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });

            assert.equal(beginRes.session_state, 'DISCOVERED');
            assert.equal(beginRes.baseline.kind, 'git');
            assert.equal(beginRes.baseline.id.length, 40);
        });
    });

    // ─── Scenario 4 & 5: Capability Preflight and Plan Registration ──────────

    describe('Capability preflight and model verification (P0-5)', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir(); });
        afterEach(() => { rmDir(tmpDir); });

        it('Preflight blocks if authorityStore is missing', async () => {
            const preflight = await runCapabilityPreflight(tmpDir, {
                authorityStore: null,
            });
            assert.equal(preflight.status, 'BLOCKED');
            assert.equal(preflight.to_state, 'BLOCKED');
            assert.ok(preflight.checks.some(c => c.name === 'authority_ledger_integrity' && c.status === 'BLOCKED'));
        });

        it('Preflight blocks if gemini-3.7-flash-high is missing from agy models', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const preflight = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-2.0-flash', 'gpt-4o'],
            });
            assert.equal(preflight.status, 'BLOCKED');
            assert.ok(preflight.checks.some(c => c.name === 'agy_cli_and_model' && c.status === 'BLOCKED'));
        });

        it('Preflight passes if gemini-3.7-flash-high is present in agy models', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const preflight = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            assert.equal(preflight.status, 'PASSED');
            assert.equal(preflight.to_state, 'CAPABILITY_SAFE');
        });

        it('plan.register blocks session when preflight fails', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'BLOCKED',
                    to_state: 'BLOCKED',
                    checks: [{ name: 'agy', status: 'BLOCKED', reason: 'CLI executable agy not found in PATH' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });
            const sessionId = beginRes.session_id;

            const planPayload = {
                plan_path: 'plans/test-plan.md',
                plan_sha256: crypto.createHash('sha256').update('plan').digest('hex'),
                plan_revision: 1,
                tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'codex', allowed_files: ['lib/a.js'] }],
            };

            await assert.rejects(
                async () => client.registerPlan(sessionId, planPayload),
                (err) => {
                    assert.equal(err.code, 'DUAL_CAPABILITY_BLOCKED');
                    assert.match(err.message, /CLI executable agy not found/);
                    return true;
                }
            );

            const status = await client.sessionStatus(sessionId);
            assert.equal(status.state, 'BLOCKED');
        });

        it('plan.register requires a matching setup SUCCESS receipt before preflight', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.mkdirSync(path.join(tmpDir, '.omni', 'sdlc'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.omni', 'sdlc', 'setup.json'), JSON.stringify({
                schema_version: 1,
                actions: [],
            }, null, 2) + '\n');

            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            let preflightCalls = 0;
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => {
                    preflightCalls++;
                    return createPassingCapability();
                },
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const planPayload = {
                plan_path: 'plans/test-plan.md',
                plan_sha256: crypto.createHash('sha256').update('plan').digest('hex'),
                plan_revision: 1,
                tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'codex', allowed_files: ['lib/a.js'] }],
            };

            await assert.rejects(
                () => client.registerPlan(beginRes.session_id, planPayload),
                (err) => err.code === 'DUAL_SETUP_REQUIRED' && /setup run/i.test(err.message)
            );
            assert.equal(preflightCalls, 0);

            executeSetupManifest({ workspaceRoot: tmpDir });
            const registered = await client.registerPlan(beginRes.session_id, planPayload);
            assert.equal(registered.registered, true);
            assert.equal(preflightCalls, 1);
        });

        it('plan.register rejects injected PASSED preflight without exact durable AGY evidence', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServerImpl({
                workspaceRoot: tmpDir,
                authorityStore,
                planArtifactVerifier: async (_workspaceRoot, params) => ({
                    plan_path: params.plan_path,
                    plan_sha256: params.plan_sha256,
                }),
                capabilityPreflight: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });

            await assert.rejects(
                () => client.registerPlan(beginRes.session_id, {
                    plan_path: 'plans/test-plan.md',
                    plan_sha256: crypto.createHash('sha256').update('plan').digest('hex'),
                    plan_revision: 1,
                    tasks: [{ task_id: 'TASK-1', title: 'Task 1', allowed_files: ['lib/a.js'] }],
                }),
                (err) => {
                    assert.equal(err.code, 'DUAL_CAPABILITY_BLOCKED');
                    assert.match(err.message, /durable AGY version\/model evidence/i);
                    return true;
                }
            );

            const capabilityEvent = authorityStore.readEvents().find((event) => event.type === 'capability.result');
            assert.equal(capabilityEvent.status, 'BLOCKED');
            assert.equal(capabilityEvent.to_state, 'BLOCKED');
        });

        it('plan.register verifies the actual repository plan bytes before registration', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"plan-integrity"}');
            const planDir = path.join(tmpDir, '.omni', 'sdlc');
            fs.mkdirSync(planDir, { recursive: true });
            const planContent = '# Verified plan\n';
            fs.writeFileSync(path.join(planDir, 'todo.md'), planContent, 'utf8');

            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServerImpl({
                workspaceRoot: tmpDir,
                authorityStore,
                capabilityPreflight: async () => createPassingCapability(),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const task = { task_id: 'TASK-1', title: 'Task 1', owner: 'codex', allowed_files: ['lib/a.js'] };

            await assert.rejects(
                () => client.registerPlan(beginRes.session_id, {
                    plan_path: '.omni/sdlc/todo.md',
                    plan_sha256: '0'.repeat(64),
                    plan_revision: 1,
                    tasks: [task],
                }),
                (err) => err.code === 'DUAL_PLAN_HASH_MISMATCH'
            );

            await assert.rejects(
                () => client.registerPlan(beginRes.session_id, {
                    plan_path: path.join(tmpDir, '.omni', 'sdlc', 'todo.md'),
                    plan_sha256: crypto.createHash('sha256').update(planContent).digest('hex'),
                    plan_revision: 1,
                    tasks: [task],
                }),
                (err) => err.code === 'DUAL_PLAN_INVALID'
            );

            const registered = await client.registerPlan(beginRes.session_id, {
                plan_path: '.omni/sdlc/todo.md',
                plan_sha256: crypto.createHash('sha256').update(planContent).digest('hex'),
                plan_revision: 1,
                tasks: [task],
            });
            assert.equal(registered.registered, true);
        });
    });

    // ─── Scenario 6: Authoritative Routing (P0-2) ────────────────────────────

    describe('Authoritative Task Routing (P0-2)', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir(); });
        afterEach(() => { rmDir(tmpDir); });

        it('Daemon enforces Codex ownership for high risk, high complexity, risky category, and 11+ files', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });
            const sessionId = beginRes.session_id;

            const planRes = await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [
                    { task_id: 'TASK-1', title: 'High risk task', owner: 'agy', risk: 'high', allowed_files: ['lib/a.js'] },
                    { task_id: 'TASK-2', title: 'High complexity task', owner: 'agy', complexity: 'high', allowed_files: ['lib/b.js'] },
                    { task_id: 'TASK-3', title: 'Migration task', owner: 'agy', category: 'migration', allowed_files: ['lib/c.js'] },
                    { task_id: 'TASK-4', title: 'Eligible 4 file AGY task', owner: 'agy', risk: 'low', complexity: 'low', category: 'feature', allowed_files: ['lib/1.js', 'lib/2.js', 'lib/3.js', 'lib/4.js'], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] },
                    { task_id: 'TASK-5', title: '11 files task', owner: 'agy', allowed_files: Array.from({ length: 11 }, (_, index) => `lib/${index + 10}.js`) },
                ],
            });

            assert.equal(planRes.registered, true);
            const tasks = planRes.tasks;
            assert.equal(tasks.find(t => t.task_id === 'TASK-1').owner, 'codex');
            assert.equal(tasks.find(t => t.task_id === 'TASK-2').owner, 'codex');
            assert.equal(tasks.find(t => t.task_id === 'TASK-3').owner, 'codex');
            assert.equal(tasks.find(t => t.task_id === 'TASK-4').owner, 'agy');
            assert.equal(tasks.find(t => t.task_id === 'TASK-5').owner, 'codex');
        });

        it('Daemon rejects multiple eligible AGY tasks against one immutable session baseline', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"single-agy-slice"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => createPassingCapability(),
            });
            t.after(() => daemon.close());
            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const begin = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const task = (id, file) => ({
                task_id: id, title: id, owner: 'agy', goal: `Implement ${id}`,
                risk: 'low', complexity: 'low', category: 'feature', allowed_files: [file],
                deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            });
            await assert.rejects(() => client.registerPlan(begin.session_id, {
                plan_path: 'plans/plan.md', plan_sha256: 'a'.repeat(64), plan_revision: 1,
                tasks: [task('AGY-1', 'lib/a.js'), task('AGY-2', 'lib/b.js')],
            }), (error) => error.code === 'DUAL_PLAN_INVALID');
        });
    });

    // ─── Scenario 7: Production Resume with Real Worker (P0-1, P0-8) ─────────

    describe('Production task execution and resume with fake-worker (P0-1, P0-8)', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir(); });
        afterEach(() => { rmDir(tmpDir); });

        it('Resume executes eligible task via orchestrator adapter, writes artifacts, and skips completed phases on second resume', async (t) => {
            try {
                execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
                fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>\n');
                execSync('git add index.html', { cwd: tmpDir, stdio: 'ignore' });
                execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            } catch (err) {
                t.skip('Git CLI not available');
                return;
            }

            const helperDir = createTempDir('omni-fake-agy-');
            t.after(() => rmDir(helperDir));
            const counterFile = path.join(helperDir, 'call-count.txt');
            const fakeAgyScript = createFakeAgyScript(helperDir, { counterFile });

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
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'b'.repeat(64),
                plan_revision: 1,
                tasks: [
                    {
                        task_id: 'TASK-1',
                        title: 'Update index.html',
                        category: 'feature',
                        complexity: 'low',
                        risk: 'low',
                        allowed_files: ['index.html'],
                        deny_patterns: [],
                        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                    },
                ],
            });

            // 1. First resume: should run worker through scout, implement, review
            await client.resumeSession(sessionId);

            // Wait for background worker execution to finish (artifacts written)
            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1');
            let attempts = 0;
            while (attempts < 50) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) {
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            // Verify phase artifacts exist
            assert.ok(fs.existsSync(path.join(taskRunDir, 'events.ndjson')), 'events.ndjson must exist');
            assert.ok(fs.existsSync(path.join(taskRunDir, 'spec.json')), 'spec.json must exist');
            assert.ok(fs.existsSync(path.join(taskRunDir, 'context.json')), 'context.json must exist');
            assert.ok(fs.existsSync(path.join(taskRunDir, 'review.json')), 'review.json must exist');

            const callCountAfterFirstResume = parseInt(fs.readFileSync(counterFile, 'utf8'), 10);
            assert.ok(callCountAfterFirstResume >= 3, 'Worker should have been invoked for scout, implement, and review');

            // AGY review does NOT self-approve; Codex runs QC to verify the task
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
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 10 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            const derived = authorityStore.derive();
            assert.equal(derived.tasks['TASK-1'].state, 'TASK_VERIFIED');
            assert.equal(derived.tasks['TASK-1'].verdict, 'SUCCESS');
            assert.equal(derived.tasks['TASK-1'].verified_by, 'codex');

            // 2. Second resume: already completed, should NOT re-invoke worker
            await client.resumeSession(sessionId);
            await new Promise(r => setTimeout(r, 200));
            const callCountAfterSecondResume = parseInt(fs.readFileSync(counterFile, 'utf8'), 10);
            assert.equal(callCountAfterSecondResume, callCountAfterFirstResume, 'Resume must be idempotent and reuse completed phases');
        });
    });

    // ─── Scenario 8: Completion Evaluation & Non-Atomic Snapshot (P0-3, P0-4) ─

    describe('Completion verification and atomic snapshot (P0-3, P0-4)', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir(); });
        afterEach(() => { rmDir(tmpDir); });

        it('Missing AGY phase artifacts blocks completion evaluation (P0-3)', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task',
                    allowed_files: ['lib/a.js'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            // Create run directory without required events.ndjson
            fs.mkdirSync(path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1'), { recursive: true });

            // Append synthetic task.completed without underlying artifacts
            const lease = authorityStore.acquireLease('TASK-1', 'agy');
            authorityStore.append({
                schema_version: 2,
                type: 'task.completed',
                task_id: 'TASK-1',
                owner: 'agy',
                authority_state: 'TASK_VERIFIED',
                modified_files: ['lib/a.js'],
                diff_fingerprint: 'f'.repeat(64),
                verdict: 'SUCCESS',
                verified_by: 'codex',
            });
            authorityStore.releaseLease(lease.lease_id, 'TASK-1', 'agy');

            // Completion evaluation should fail due to missing durable phase artifacts
            const comp = await client.evaluateCompletion(sessionId);
            assert.equal(comp.verified, false);
            assert.ok(comp.blockers.some(b => b.includes('DELEGATION_EVIDENCE_MISSING') || b.includes('DELEGATION_GATE_UNMET')));
        });

        it('Snapshot baseline begin records snapshot identity and completion checks unverified task blockers', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));

            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
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
                tasks: [{ task_id: 'TASK-1', title: 'Task', category: 'architecture', allowed_files: ['lib/a.js'] }],
            });

            // Read-only completion evaluation reports unverified task blockers
            const comp = await client.evaluateCompletion(sessionId);
            assert.equal(comp.verified, false);
            assert.ok(comp.blockers.some(b => b.includes('TASK_UNVERIFIED')));
        });
    });

    // ─── Scenario 9: MCP Begin Baseline Auto-Detection (P0-6) ────────────────

    describe('MCP omni_dual_begin baseline auto-detection (P0-6)', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir(); });
        afterEach(() => { rmDir(tmpDir); });

        it('MCP begin without expected_baseline automatically detects greenfield snapshot', async (t) => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"greenfield"}');
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 5000 });
            const result = await client.beginSession({
                workspace_root: tmpDir,
                mode: 'auto',
            });

            assert.equal(result.state, 'DISCOVERED');
            assert.equal(result.expected_baseline.kind, 'snapshot');
            assert.ok(result.expected_baseline.id);
        });
    });

    // ─── Scenario 10: SessionStart Bootstrapping ─────────────────────────────

    describe('SessionStart daemon bootstrapping', () => {
        let tmpDir;
        beforeEach(() => { tmpDir = createTempDir('omni path with spaces '); });
        afterEach(() => { rmDir(tmpDir); });

        it('SessionStart bootstraps daemon via injected spawn seam and handles paths with spaces', async () => {
            let spawnedArgs = null;

            const fakeSpawn = (prog, args, opts) => {
                spawnedArgs = { prog, args, opts };
                return {
                    unref: () => {},
                };
            };

            const out = await evaluateHook({
                session_id: 'codex-session-123',
                cwd: tmpDir,
                hook_event_name: 'SessionStart',
            }, {
                spawn: fakeSpawn,
                platform: 'linux',
                createClient: () => ({
                    health: async () => null,
                    waitForHealthy: async () => ({ status: 'healthy', session_id: 'omni-session-456' }),
                    status: async () => ({ state: 'EXECUTING', plan_revision: 2 }),
                }),
            });

            assert.ok(spawnedArgs, 'spawn must be called to bootstrap daemon');
            assert.equal(spawnedArgs.prog, process.execPath);
            assert.ok(spawnedArgs.args.some(a => a.includes('omni-daemon.js')));
            assert.ok(spawnedArgs.args.includes('--workspace'));
            assert.equal(spawnedArgs.opts.shell, false);
            assert.ok(out.hookSpecificOutput);
            assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
            assert.match(out.hookSpecificOutput.additionalContext, /omni-session-456/);
        });
    });

    // ─── Scenario 11: Hardening Slice 3A.1 (Strict Evidence & Atomic QC) ─────

    describe('Hardening Slice 3A.1: Strict Evidence, Atomic QC, and Idempotency', () => {
        let tmpDir;
        let baseCommit;
        let helperDir;
        let counterFile;
        let fakeAgyScript;

        beforeEach(() => {
            tmpDir = createTempDir();
            execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test-app"}\n');
            fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>\n');
            execSync('git add package.json index.html', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            baseCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

            helperDir = createTempDir('omni-fake-agy-strict-');
            counterFile = path.join(helperDir, 'call-count.txt');
            fakeAgyScript = createFakeAgyScript(helperDir, { counterFile });
        });

        afterEach(() => {
            rmDir(tmpDir);
            rmDir(helperDir);
        });

        it('AGY artifacts alone leave task unverified, and nonzero QC command cannot append success', async (t) => {
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
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            // 1. Run AGY worker
            await client.resumeSession(sessionId);

            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1');
            let attempts = 0;
            while (attempts < 50) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            // Phase artifacts exist
            assert.ok(fs.existsSync(path.join(taskRunDir, 'review.json')));

            // 2. AGY artifacts alone leave task unverified
            const readOnlyComp = await client.evaluateCompletion(sessionId);
            assert.equal(readOnlyComp.verified, false);
            assert.ok(readOnlyComp.blockers.some(b => b.includes('TASK_UNVERIFIED')));

            const diffInfo = captureDiffFingerprint({
                repoRoot: tmpDir,
                baseCommit,
                excludedPaths: ['.omni'],
            });

            // 3. Nonzero QC command is rejected and does not mutate task state
            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-1',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        command_outputs: [{ command: 'npm test', exit_code: 1, duration_ms: 50 }],
                        findings: [],
                        modified_files: diffInfo.files,
                    },
                }),
                (err) => {
                    assert.equal(err.code, 'DUAL_QC_COMMAND_FAILED');
                    return true;
                }
            );

            assert.equal(authorityStore.derive().tasks['TASK-1'].state, 'ROUTED');

            // 4. Mismatched diff fingerprint is rejected
            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-1',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: '1'.repeat(64),
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: diffInfo.files,
                    },
                }),
                (err) => {
                    assert.equal(err.code, 'DUAL_FINGERPRINT_MISMATCH');
                    return true;
                }
            );

            // 5. Valid QC succeeds and verifies task atomically with required gates
            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-1',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            const derived = authorityStore.derive();
            assert.equal(derived.tasks['TASK-1'].state, 'TASK_VERIFIED');
            assert.equal(derived.tasks['TASK-1'].verified_by, 'codex');
            assert.equal(derived.gates['delegation-TASK-1'].status, 'PASSED');
            assert.equal(derived.gates['scope-TASK-1'].status, 'PASSED');
            assert.equal(derived.gates['review-TASK-1'].status, 'PASSED');

            // 6. Repeated identical QC is idempotent and does not duplicate gate events
            const eventCountBeforeRepeat = authorityStore.readEvents().length;
            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-1',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });
            const eventCountAfterRepeat = authorityStore.readEvents().length;
            assert.equal(eventCountAfterRepeat, eventCountBeforeRepeat, 'Identical repeat QC must not duplicate events');

            // 7. Conflicting repeat QC is rejected
            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-1',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: '2'.repeat(64),
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: diffInfo.files,
                    },
                }),
                (err) => {
                    assert.equal(err.code, 'DUAL_FINGERPRINT_MISMATCH');
                    return true;
                }
            );
            // 8. Quality cycle with nonzero command cannot append success (records FAILED gate)
            const failQualityRes = await client.evaluateCompletion(sessionId, {
                quality_evidence: {
                    cycle_index: 1,
                    attempt: 1,
                    total_tasks: 1,
                    completed_task_ids: ['TASK-1'],
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    gate_results: [{ id: 'unit-tests', required: true, status: 'PASSED' }],
                    commands: [{ command: 'npm test', exit_code: 1, duration_ms: 50 }],
                    evidence_sha256: 'a'.repeat(64),
                },
            });
            assert.equal(failQualityRes.verified, false);
            const derivedAfterFailQuality = authorityStore.derive();
            assert.equal(derivedAfterFailQuality.gates['quality-cycle-1'].status, 'FAILED');
        });

        it('Delegation gate append failure prevents task completion', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            // Store proxy that throws when appending delegation gate
            let throwOnDelegation = true;
            const originalAppend = authorityStore.append.bind(authorityStore);
            authorityStore.append = (event) => {
                if (throwOnDelegation && event.type === 'gate.result' && event.gate_id?.startsWith('delegation-')) {
                    throw new Error('Disk full during delegation gate write');
                }
                return originalAppend(event);
            };

            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1');
            let attempts = 0;
            while (attempts < 50) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            const diffInfo = captureDiffFingerprint({
                repoRoot: tmpDir,
                baseCommit,
                excludedPaths: ['.omni'],
            });

            // QC evaluation fails due to gate append error
            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-1',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: diffInfo.files,
                    },
                }),
                (err) => {
                    assert.equal(err.code, 'DUAL_QC_FAILED');
                    return true;
                }
            );

            // Task must NOT be completed or verified
            const derived = authorityStore.derive();
            assert.notEqual(derived.tasks['TASK-1'].state, 'TASK_VERIFIED');
            assert.equal(derived.tasks['TASK-1'].state, 'ROUTED');
        });
    });

    // ─── Scenario 12: Hardening Slice 3A.2 (Fail-Closed Git Path) ────────────

    describe('Hardening Slice 3A.2: Fail-Closed Git Path & Exact Post-Run Correlation', () => {
        let tmpDir;
        let baseCommit;
        let helperDir;
        let counterFile;
        let fakeAgyScript;

        beforeEach(() => {
            tmpDir = createTempDir();
            execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test-app"}\n');
            fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>\n');
            execSync('git add package.json index.html', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            baseCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

            helperDir = createTempDir('omni-fake-agy-3a2-');
            counterFile = path.join(helperDir, 'call-count.txt');
            fakeAgyScript = createFakeAgyScript(helperDir, { counterFile });
        });

        afterEach(() => {
            rmDir(tmpDir);
            rmDir(helperDir);
        });

        it('Adapter rejects task with missing goal, empty allowed_files, or missing validation_commands without defaulting', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const derivedBase = {
                currentBaseline: { kind: 'git', id: baseCommit },
                capability: createPassingCapability(),
                tasks: {},
            };

            // 1. Missing goal
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-1', {
                    task_id: 'TASK-1',
                    owner: 'agy',
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }, derivedBase),
                /missing a non-empty goal/i
            );

            // 2. Empty allowed_files
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-1', {
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    allowed_files: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }, derivedBase),
                /missing non-empty allowed_files/i
            );

            // 3. Missing validation_commands
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-1', {
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    allowed_files: ['index.html'],
                    validation_commands: [],
                }, derivedBase),
                /missing non-empty validation_commands/i
            );

            // 4. Snapshot baseline without initial snapshot throws error before creating transaction
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-1', {
                    task_id: 'TASK-1',
                    title: 'Task 1',
                    owner: 'agy',
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }, { currentBaseline: { kind: 'snapshot', id: 's'.repeat(64) }, tasks: {} }),
                /initial-snapshot\.json not found|DUAL_SNAPSHOT_NOT_FOUND/
            );

            // Verify no spec.json was written with fallback defaults
            const specPath = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'spec.json');
            assert.equal(fs.existsSync(specPath), false, 'Must not write spec.json when inputs are invalid');
        });

        it('Snapshot quality submission with mismatched diff fingerprint is rejected and appends nothing', async (t) => {
            const snapDir = createTempDir('omni-snap-');
            t.after(() => rmDir(snapDir));
            fs.writeFileSync(path.join(snapDir, 'package.json'), '{"name":"snap"}');

            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 5000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            assert.equal(beginRes.expected_baseline.kind, 'snapshot');

            const eventCountBefore = authorityStore.readEvents().length;

            await assert.rejects(
                () => client.evaluateCompletion(beginRes.session_id, {
                    quality_evidence: {
                        cycle_index: 1,
                        attempt: 1,
                        total_tasks: 1,
                        completed_task_ids: ['TASK-1'],
                        plan_revision: 1,
                        diff_fingerprint: 'a'.repeat(64),
                        gate_results: [{ id: 'test-gate', required: true, status: 'PASSED' }],
                        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                        evidence_sha256: 'b'.repeat(64),
                    },
                }),
                (err) => {
                    assert.equal(err.code, 'DUAL_QUALITY_ERROR');
                    return true;
                }
            );

            const eventCountAfter = authorityStore.readEvents().length;
            assert.equal(eventCountAfter, eventCountBefore, 'Must not append any events on failed quality submission');
        });

        it('Tampered event sequence in events.ndjson blocks AWAITING_CODEX_QC', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const derivedBase = {
                currentBaseline: { kind: 'git', id: baseCommit },
                capability: createPassingCapability(),
                tasks: {},
            };

            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-TAMPER');
            fs.mkdirSync(taskRunDir, { recursive: true });

            // Write valid artifacts
            fs.writeFileSync(path.join(taskRunDir, 'context.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-TAMPER',
                expected_base_commit: baseCommit,
                summary: 'Context',
                relevant_files: [{ path: 'index.html', description: 'desc' }],
                exact_symbols: [{ name: 'test', file: 'index.html', verified: true, kind: 'function' }],
                validation_commands: ['node --version'],
                constraints: ['none'],
                risks: [],
                open_questions: [],
            }));

            fs.writeFileSync(path.join(taskRunDir, 'spec.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-TAMPER',
                expected_base_commit: baseCommit,
                goal: 'Tampered task',
                allowed_files: ['index.html'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                risk_flags: [],
                permission_authority: 'dual-init-dangerous-auto-v1',
            }));

            fs.writeFileSync(path.join(taskRunDir, 'route.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-TAMPER',
                expected_base_commit: baseCommit,
                owner: 'gemini',
                model: 'gemini-3.7-flash-high',
                effort: 'high',
                token_budget: 100000,
                allowed_files: ['index.html'],
                reason: 'Standard route',
            }));

            fs.writeFileSync(path.join(taskRunDir, 'evidence.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-TAMPER',
                expected_base_commit: baseCommit,
                status: 'SUCCESS',
                modified_files: ['index.html'],
                command_outputs: [{ command: 'node --version', exit_code: 0, output: 'ok' }],
                unverified_items: [],
            }));

            fs.writeFileSync(path.join(taskRunDir, 'review.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-TAMPER',
                expected_base_commit: baseCommit,
                recommendation: 'APPROVE',
                risk_level: 'LOW',
                findings: [],
            }));

            authorityStore.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000001',
                causation_id: '10000000-0000-4000-8000-000000000001',
                sequence: 1,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:00.000Z',
                type: 'session.created',
                state: 'DISCOVERED',
                workspace_root: '.',
                mode: 'auto',
            });
            authorityStore.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000002',
                causation_id: '10000000-0000-4000-8000-000000000001',
                sequence: 2,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:01.000Z',
                type: 'capability.result',
                from_state: 'DISCOVERED',
                to_state: 'CAPABILITY_SAFE',
                status: 'PASSED',
                checks: createPassingCapability().checks,
                details: createPassingCapability().details,
            });
            authorityStore.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000003',
                causation_id: '10000000-0000-4000-8000-000000000002',
                sequence: 3,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:02.000Z',
                type: 'plan.registered',
                from_state: 'INTERVIEWING',
                to_state: 'PLANNED',
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                total_tasks: 1,
                tasks: [{
                    task_id: 'TASK-TAMPER',
                    title: 'Tampered task',
                    owner: 'agy',
                    allowed_files: ['index.html'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });
            authorityStore.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000004',
                causation_id: '10000000-0000-4000-8000-000000000003',
                sequence: 4,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:03.000Z',
                type: 'task.routed',
                task_id: 'TASK-TAMPER',
                owner: 'agy',
                authority_state: 'ROUTED',
                model: 'gemini-3.7-flash-high',
                effort: 'high',
                token_budget: null,
                allowed_files: ['index.html'],
                reason: 'Eligible AGY task',
            });

            // Write an incomplete/tampered events log (missing implement and scope events)
            const tamperedEvents = [
                JSON.stringify({ timestamp: new Date().toISOString(), type: 'transaction.created', state: 'NEW' }),
                JSON.stringify({ timestamp: new Date().toISOString(), type: 'phase.completed', phase: 'scout', attempt: 1, from_state: 'PREFLIGHT_SAFE', to_state: 'SCOUT_VALID', artifact_hashes: {}, warnings: [] }),
                JSON.stringify({ timestamp: new Date().toISOString(), type: 'phase.completed', phase: 'review', attempt: 1, from_state: 'SCOPE_VALID', to_state: 'REVIEW_VALID', artifact_hashes: {}, warnings: [] }),
            ].join('\n') + '\n';
            fs.writeFileSync(path.join(taskRunDir, 'events.ndjson'), tamperedEvents);

            // Execute task: orchestrator recognizes tampered event sequence and rejects
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-TAMPER', {
                    task_id: 'TASK-TAMPER',
                    title: 'Tampered task',
                    owner: 'agy',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }, authorityStore.derive()),
                /event (log|sequence)|missing required successful phase transition/i
            );
        });
    });

    // ─── Scenario 13: Slice 3A.3 Hardening & Evidence Gaps ───────────────────
    describe('Scenario 13: Slice 3A.3 Hardening & Evidence Gaps', () => {
        let tmpDir;
        let baseCommit;
        let fakeAgyScript;

        beforeEach(() => {
            tmpDir = createTempDir();
            execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
            fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>\n');
            execSync('git add index.html', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            baseCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
            fakeAgyScript = createFakeAgyScript(tmpDir);
        });

        afterEach(() => {
            rmDir(tmpDir);
        });

        function setupAuthorityWithTask(store, taskId, taskDef) {
            store.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000001',
                causation_id: '10000000-0000-4000-8000-000000000001',
                sequence: 1,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:00.000Z',
                type: 'session.created',
                state: 'DISCOVERED',
                workspace_root: '.',
                mode: 'auto',
            });
            store.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000002',
                causation_id: '10000000-0000-4000-8000-000000000001',
                sequence: 2,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:01.000Z',
                type: 'capability.result',
                from_state: 'DISCOVERED',
                to_state: 'CAPABILITY_SAFE',
                status: 'PASSED',
                checks: createPassingCapability().checks,
                details: createPassingCapability().details,
            });
            store.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000003',
                causation_id: '10000000-0000-4000-8000-000000000002',
                sequence: 3,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:02.000Z',
                type: 'plan.registered',
                from_state: 'INTERVIEWING',
                to_state: 'PLANNED',
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                total_tasks: 1,
                tasks: [taskDef],
            });
            store.append({
                schema_version: 2,
                event_id: '10000000-0000-4000-8000-000000000004',
                causation_id: '10000000-0000-4000-8000-000000000003',
                sequence: 4,
                workspace_id: 'ws-test',
                session_id: 'sess-test',
                plan_revision: 1,
                expected_baseline: { kind: 'git', id: baseCommit },
                timestamp: '2026-08-25T00:00:03.000Z',
                type: 'task.routed',
                task_id: taskId,
                owner: 'agy',
                authority_state: 'ROUTED',
                model: 'gemini-3.7-flash-high',
                effort: 'high',
                token_budget: null,
                allowed_files: taskDef.allowed_files,
                reason: 'Eligible AGY task',
            });
        }

        it('Adapter rejects task missing explicit deny_patterns array', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const taskDef = {
                task_id: 'TASK-NO-DENY',
                title: 'Task without deny patterns',
                owner: 'agy',
                allowed_files: ['index.html'],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                // deny_patterns omitted
            };
            setupAuthorityWithTask(authorityStore, 'TASK-NO-DENY', taskDef);
            const derived = authorityStore.derive();

            await assert.rejects(
                () => adapter.executeAgyTask('TASK-NO-DENY', taskDef, derived),
                /deny_patterns/i
            );
        });

        it('Adapter rejects stale Git HEAD before invoking AGY (DUAL_BASE_COMMIT_STALE)', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const taskDef = {
                task_id: 'TASK-STALE',
                title: 'Stale task',
                owner: 'agy',
                allowed_files: ['index.html'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            };
            setupAuthorityWithTask(authorityStore, 'TASK-STALE', taskDef);
            const derived = authorityStore.derive();

            // Commit a change to advance HEAD
            fs.writeFileSync(path.join(tmpDir, 'newfile.txt'), 'advance');
            execSync('git add newfile.txt', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git commit -m "advance head"', { cwd: tmpDir, stdio: 'ignore' });

            await assert.rejects(
                () => adapter.executeAgyTask('TASK-STALE', taskDef, derived),
                /DUAL_BASE_COMMIT_STALE|stale/i
            );
        });

        it('Adapter rejects reused spec mismatch for allowed files, commands, deny patterns, or risk flags', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const taskDef = {
                task_id: 'TASK-SPEC-MISMATCH',
                title: 'Spec mismatch task',
                owner: 'agy',
                allowed_files: ['index.html'],
                deny_patterns: ['secret.txt'],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            };
            setupAuthorityWithTask(authorityStore, 'TASK-SPEC-MISMATCH', taskDef);
            const derived = authorityStore.derive();

            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-SPEC-MISMATCH');
            fs.mkdirSync(taskRunDir, { recursive: true });
            // Existing spec with mismatched allowed_files
            fs.writeFileSync(path.join(taskRunDir, 'spec.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-SPEC-MISMATCH',
                expected_base_commit: baseCommit,
                goal: 'Spec mismatch task',
                allowed_files: ['other.html'],
                deny_patterns: ['secret.txt'],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                risk_flags: [],
                permission_authority: 'dual-init-dangerous-auto-v1',
            }));

            await assert.rejects(
                () => adapter.executeAgyTask('TASK-SPEC-MISMATCH', taskDef, derived),
                /spec.*mismatch|correlation/i
            );
        });

        it('Adapter rejects lease release failure and never reports clean AWAITING_CODEX_QC', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));

            // Corrupt releaseLease on authority store
            authorityStore.releaseLease = () => {
                throw new Error('Simulated lease release I/O crash');
            };

            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const taskDef = {
                task_id: 'TASK-LEASE-FAIL',
                title: 'Task with lease failure',
                owner: 'agy',
                allowed_files: ['index.html'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            };
            setupAuthorityWithTask(authorityStore, 'TASK-LEASE-FAIL', taskDef);
            const derived = authorityStore.derive();

            await assert.rejects(
                () => adapter.executeAgyTask('TASK-LEASE-FAIL', taskDef, derived),
                /lease release/i
            );
        });
    });

    // ─── Scenario 14: Slice 3A.4 Plan Registration & QC Tamper Closure ───────
    describe('Scenario 14: Slice 3A.4 Registration & QC Tamper Closure', () => {
        let tmpDir;
        let baseCommit;
        let fakeAgyScript;
        let helperDir;

        beforeEach(() => {
            tmpDir = createTempDir();
            execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
            fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Hello</body></html>\n');
            execSync('git add index.html', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
            baseCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
            helperDir = createTempDir('omni-fake-agy-strict-');
            fakeAgyScript = createFakeAgyScript(helperDir);
        });

        afterEach(() => {
            rmDir(tmpDir);
            rmDir(helperDir);
        });

        it('medium and unknown risk route to Codex, not AGY', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            const regRes = await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [
                    {
                        task_id: 'TASK-MED',
                        title: 'Medium risk task',
                        risk: 'medium',
                        allowed_files: ['index.html'],
                    },
                    {
                        task_id: 'TASK-UNK',
                        title: 'Unknown risk task',
                        risk: 'unknown_risk',
                        allowed_files: ['index.html'],
                    },
                ],
            });

            const tasks = regRes.tasks || [];
            const medTask = tasks.find(t => t.task_id === 'TASK-MED');
            const unkTask = tasks.find(t => t.task_id === 'TASK-UNK');
            assert.equal(medTask.owner, 'codex');
            assert.equal(unkTask.owner, 'codex');
        });

        it('AGY plan missing deny patterns, validation commands, args, cwd, or allowed files is rejected with 400 before any plan/task event append', async (t) => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const daemon = await startDaemonServer({
                workspaceRoot: tmpDir,
                authorityStore,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            const initialEventsCount = authorityStore.readEvents().length;

            // Missing deny_patterns on AGY candidate
            await assert.rejects(
                () => client.registerPlan(sessionId, {
                    plan_path: 'plans/plan.md',
                    plan_sha256: 'a'.repeat(64),
                    plan_revision: 1,
                    tasks: [{
                        task_id: 'TASK-AGY-1',
                        title: 'AGY task',
                        risk: 'low',
                        allowed_files: ['index.html'],
                        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                        // deny_patterns missing
                    }],
                }),
                /deny_patterns/i
            );
            assert.equal(
                authorityStore.readEvents().filter(e => e.type === 'plan.registered' || e.type === 'task.routed').length,
                0,
                'Zero plan or task events appended on rejection'
            );

            const eventsCountAfterFirst = authorityStore.readEvents().length;

            // Missing validation_commands
            await assert.rejects(
                () => client.registerPlan(sessionId, {
                    plan_path: 'plans/plan.md',
                    plan_sha256: 'a'.repeat(64),
                    plan_revision: 1,
                    tasks: [{
                        task_id: 'TASK-AGY-2',
                        title: 'AGY task',
                        risk: 'low',
                        allowed_files: ['index.html'],
                        deny_patterns: [],
                        validation_commands: [],
                    }],
                }),
                /validation_commands/i
            );
            assert.equal(authorityStore.readEvents().length, eventsCountAfterFirst, 'Zero events appended on rejection');

            // Command missing args
            await assert.rejects(
                () => client.registerPlan(sessionId, {
                    plan_path: 'plans/plan.md',
                    plan_sha256: 'a'.repeat(64),
                    plan_revision: 1,
                    tasks: [{
                        task_id: 'TASK-AGY-3',
                        title: 'AGY task',
                        risk: 'low',
                        allowed_files: ['index.html'],
                        deny_patterns: [],
                        validation_commands: [{ program: 'node', cwd: '.' }],
                    }],
                }),
                /args/i
            );
            assert.equal(authorityStore.readEvents().length, eventsCountAfterFirst, 'Zero events appended on rejection');

            // Command missing cwd
            await assert.rejects(
                () => client.registerPlan(sessionId, {
                    plan_path: 'plans/plan.md',
                    plan_sha256: 'a'.repeat(64),
                    plan_revision: 1,
                    tasks: [{
                        task_id: 'TASK-AGY-4',
                        title: 'AGY task',
                        risk: 'low',
                        allowed_files: ['index.html'],
                        deny_patterns: [],
                        validation_commands: [{ program: 'node', args: ['--version'] }],
                    }],
                }),
                /cwd/i
            );
            assert.equal(authorityStore.readEvents().length, eventsCountAfterFirst, 'Zero events appended on rejection');
        });

        it('Adapter rejects non-agy task or non-low risk', async () => {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: tmpDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            // Owner codex rejected by adapter
            const codexTask = {
                task_id: 'TASK-CODEX',
                title: 'Codex task',
                owner: 'codex',
                allowed_files: ['index.html'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            };
            const derived = { currentBaseline: { kind: 'git', id: baseCommit } };
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-CODEX', codexTask, derived),
                /owner.*agy/i
            );

            // Risk medium rejected by adapter
            const medTask = {
                task_id: 'TASK-MED',
                title: 'Med task',
                owner: 'agy',
                risk: 'medium',
                allowed_files: ['index.html'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            };
            await assert.rejects(
                () => adapter.executeAgyTask('TASK-MED', medTask, derived),
                /non-low risk|residual/i
            );
        });

        it('Daemon QC rejects post-handoff tampering of goal, deny patterns, validation commands, risk flags, or artifact bytes', async (t) => {
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
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-QC-TAMPER',
                    title: 'Original Title',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: ['**/.env*'],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-QC-TAMPER');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            assert.ok(fs.existsSync(path.join(taskRunDir, 'review.json')), 'review.json must exist');

            const diffInfo = captureDiffFingerprint({
                repoRoot: tmpDir,
                baseCommit,
                excludedPaths: ['.omni'],
            });

            const qcEvidence = {
                task_id: 'TASK-QC-TAMPER',
                verdict: 'SUCCESS',
                plan_revision: 1,
                diff_fingerprint: diffInfo.patchSha256,
                command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                findings: [],
                modified_files: diffInfo.files,
            };

            // 1. Tamper spec.json goal post-handoff
            const specPath = path.join(taskRunDir, 'spec.json');
            const originalSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
            fs.writeFileSync(specPath, JSON.stringify({ ...originalSpec, goal: 'Tampered goal' }), 'utf8');

            await assert.rejects(
                () => client.evaluateCompletion(sessionId, { qc_evidence: qcEvidence }),
                /goal mismatch|correlation/i
            );

            // Restore spec.json and tamper review.json bytes post-handoff
            fs.writeFileSync(specPath, JSON.stringify(originalSpec), 'utf8');
            const reviewPath = path.join(taskRunDir, 'review.json');
            const originalReview = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
            fs.writeFileSync(reviewPath, JSON.stringify({
                ...originalReview,
                findings: [{ file: 'index.html', line: 1, description: 'Tampered finding text', severity: 'INFO' }],
            }), 'utf8');

            await assert.rejects(
                () => client.evaluateCompletion(sessionId, { qc_evidence: qcEvidence }),
                /hash mismatch|artifact hash/i
            );
        });

        it('Surfaces double failure when Codex QC append and lease release both fail', async (t) => {
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
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: tmpDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: tmpDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-DOUBLE-FAIL',
                    title: 'Double fail task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-DOUBLE-FAIL');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            assert.ok(fs.existsSync(path.join(taskRunDir, 'review.json')), 'review.json must exist');

            const diffInfo = captureDiffFingerprint({
                repoRoot: tmpDir,
                baseCommit,
                excludedPaths: ['.omni'],
            });

            // Simulate double failure: append fails AND releaseLease fails
            const originalAppend = authorityStore.append.bind(authorityStore);
            authorityStore.append = (ev) => {
                if (ev.type === 'gate.result' || ev.type === 'task.completed') {
                    throw new Error('Simulated append I/O failure');
                }
                return originalAppend(ev);
            };
            authorityStore.releaseLease = () => {
                throw new Error('Simulated lease release I/O failure');
            };

            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-DOUBLE-FAIL',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: diffInfo.files,
                    },
                }),
                /lease release also failed/i
            );
        });
    });

    // ─── Scenario 15: Greenfield Snapshot Full Lifecycle ──────────────────────

    describe('Scenario 15: Greenfield snapshot transaction and verification lifecycle', () => {
        let snapDir;
        let scriptDir;
        let fakeAgyScript;

        beforeEach(() => {
            snapDir = createTempDir('omni-snap-test-');
            scriptDir = createTempDir('omni-script-');
            // Write initial files without git
            fs.writeFileSync(path.join(snapDir, 'index.html'), '<html><body>Initial Snapshot Workspace</body></html>\n', 'utf8');
            fs.writeFileSync(path.join(snapDir, 'README.md'), '# Snapshot Greenfield Project\n', 'utf8');
            fakeAgyScript = createFakeAgyScript(scriptDir);
        });

        afterEach(() => {
            rmDir(snapDir);
            rmDir(scriptDir);
        });

        it('Full snapshot lifecycle: begin -> plan -> resume (scout/spec/route/implement/scope/review) -> QC -> quality -> verify', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            let heartbeatScheduledMs = null;
            let heartbeatCleared = false;
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
                setIntervalFn(callback, intervalMs) {
                    heartbeatScheduledMs = intervalMs;
                    callback();
                    return { unref() {} };
                },
                clearIntervalFn() {
                    heartbeatCleared = true;
                },
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });

            // 1. Begin session on snapshot workspace
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            assert.ok(beginRes.session_id, 'must have session_id');
            assert.equal(beginRes.expected_baseline.kind, 'snapshot', 'baseline must be snapshot');
            assert.ok(/^[0-9a-f]{64}$/.test(beginRes.expected_baseline.id), 'snapshot id must be 64 hex');
            const sessionId = beginRes.session_id;

            // Verify initial-snapshot.json was persisted
            const authorityDir = path.join(snapDir, '.omni', 'runs', 'dual-authority');
            const initialSnapshotPath = path.join(authorityDir, 'initial-snapshot.json');
            assert.ok(fs.existsSync(initialSnapshotPath), 'initial-snapshot.json must exist on disk');
            const initialSnapshot = readInitialSnapshot({
                authorityDir,
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
            });
            assert.equal(initialSnapshot.identity.id, beginRes.expected_baseline.id);
            assert.ok(initialSnapshot.manifest.files.some(f => f.path === 'index.html'));
            assert.ok(initialSnapshot.manifest.files.some(f => f.path === 'README.md'));

            // 2. Register plan
            const planRes = await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'b'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-SNAP-01',
                    title: 'Implement snapshot homepage feature',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });
            assert.equal(planRes.registered, true);

            // 3. Resume session -> fake AGY worker runs all phases
            await client.resumeSession(sessionId);

            // Wait for AGY to complete phases
            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-SNAP-01');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            assert.ok(fs.existsSync(path.join(taskRunDir, 'review.json')), 'review.json must exist');

            while (attempts < 120) {
                const leases = Object.values(authorityStore.derive().leases || {});
                if (leases.some((lease) => lease.status === 'released')) break;
                await new Promise(r => setTimeout(r, 50));
                attempts++;
            }
            const leaseEvents = authorityStore.readEvents().filter((event) => event.type.startsWith('lease.'));
            assert.equal(heartbeatScheduledMs, 10_000);
            assert.equal(heartbeatCleared, true);
            assert.ok(leaseEvents.some((event) => event.type === 'lease.renewed'));
            assert.equal(leaseEvents.at(-1).type, 'lease.released');
            assert.equal(leaseEvents.at(-1).reason, 'agy_reviewed_awaiting_codex_qc');

            // Verify phase artifacts all have snapshot correlation
            const parsedSpec = JSON.parse(fs.readFileSync(path.join(taskRunDir, 'spec.json'), 'utf8'));
            assert.equal(parsedSpec.expected_baseline.kind, 'snapshot');
            assert.equal(parsedSpec.expected_baseline.id, beginRes.expected_baseline.id);

            const parsedEvidence = JSON.parse(fs.readFileSync(path.join(taskRunDir, 'evidence.json'), 'utf8'));
            assert.equal(parsedEvidence.expected_baseline.kind, 'snapshot');
            assert.equal(parsedEvidence.expected_baseline.id, beginRes.expected_baseline.id);

            const parsedReview = JSON.parse(fs.readFileSync(path.join(taskRunDir, 'review.json'), 'utf8'));
            assert.equal(parsedReview.expected_baseline.kind, 'snapshot');
            assert.equal(parsedReview.expected_baseline.id, beginRes.expected_baseline.id);

            // 4. Measure snapshot diff fingerprint for Codex QC
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, {
                excludedPaths: ['.omni'],
            });
            assert.deepEqual(diffInfo.files, ['index.html']);
            assert.ok(/^[0-9a-f]{64}$/.test(diffInfo.patchSha256));

            // 5. Codex QC submission
            const qcRes = await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-SNAP-01',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 45 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });
            assert.equal(qcRes.verified, false); // Still needs quality cycles

            // 6. Record 3 Quality Cycles
            for (let i = 1; i <= 3; i++) {
                await client.evaluateCompletion(sessionId, {
                    quality_evidence: {
                        cycle_index: i,
                        attempt: 1,
                        total_tasks: 1,
                        completed_task_ids: ['TASK-SNAP-01'],
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        gate_results: [{ id: `gate-cycle-${i}`, required: true, status: 'PASSED' }],
                        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                        evidence_sha256: crypto.createHash('sha256').update(`evidence-${i}`).digest('hex'),
                    },
                });
            }

            // 7. Optional UI Evidence with valid schema
            await client.evaluateCompletion(sessionId, {
                ui_evidence: {
                    requirement: {
                        gate_id: 'ui-snap-01',
                        required: false,
                        viewport_widths: [390, 768, 1024, 1440],
                        reduced_motion_required: true,
                    },
                    evidence: {
                        runtime_status: 'UNAVAILABLE',
                        evidence_sha256: '0'.repeat(64),
                        reason: 'Non-UI headless snapshot task',
                    },
                },
            });

            // 8. Final Completion Evaluation -> VERIFIED
            const finalRes = await client.evaluateCompletion(sessionId);
            assert.equal(finalRes.verified, true);
            assert.equal(finalRes.session_state, 'VERIFIED');
            assert.ok(finalRes.receipt_sha256);
            assert.deepEqual(finalRes.blockers, []);

            // 9. Verify accepted-snapshot.json was written and matches receipt
            const acceptedSnapshot = readAcceptedSnapshot({
                authorityDir,
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
                planRevision: 1,
            });
            assert.equal(acceptedSnapshot.receipt_sha256, finalRes.receipt_sha256);
            assert.deepEqual(acceptedSnapshot.completed_tasks, ['TASK-SNAP-01']);
            const initialIndex = initialSnapshot.manifest.files.find(f => f.path === 'index.html');
            const acceptedIndex = acceptedSnapshot.manifest.files.find(f => f.path === 'index.html');
            assert.ok(acceptedIndex);
            assert.notEqual(acceptedIndex.sha256, initialIndex.sha256);
        });
    });

    // ─── Scenario 16: Greenfield Snapshot Adversarial & Boundary Tests ────────

    describe('Scenario 16: Greenfield snapshot adversarial and boundary conditions', () => {
        let snapDir;
        let scriptDir;
        let fakeAgyScript;

        beforeEach(() => {
            snapDir = createTempDir('omni-snap-adv-');
            scriptDir = createTempDir('omni-script-');
            fs.writeFileSync(path.join(snapDir, 'index.html'), '<html><body>Snapshot Adversarial</body></html>\n', 'utf8');
            fakeAgyScript = createFakeAgyScript(scriptDir);
        });

        afterEach(() => {
            rmDir(snapDir);
            rmDir(scriptDir);
        });

        it('Reject forged QC diff fingerprint in snapshot session', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'c'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-FORGE-FP',
                    title: 'Forge FP task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-FORGE-FP');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            // Attempt QC with forged diff fingerprint
            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-FORGE-FP',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: 'f'.repeat(64),
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: ['index.html'],
                    },
                }),
                (err) => err.code === 'DUAL_FINGERPRINT_MISMATCH' || /diff fingerprint|fingerprint mismatch/i.test(err.message)
            );
        });

        it('Reject forged modified_files list in snapshot session', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'd'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-FORGE-FILES',
                    title: 'Forge files task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-FORGE-FILES');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            const initialSnapshot = readInitialSnapshot({
                authorityDir: path.join(snapDir, '.omni', 'runs', 'dual-authority'),
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
            });
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, {
                excludedPaths: ['.omni'],
            });

            // Attempt QC with forged modified_files list
            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-FORGE-FILES',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: ['index.html', 'extra.js'],
                    },
                }),
                (err) => err.code === 'DUAL_MODIFIED_FILES_MISMATCH' || /modified_files/i.test(err.message)
            );
        });

        it('Corrupted initial-snapshot.json prevents QC evaluation and returns durable error', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'e'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-CORRUPT-SNAP',
                    title: 'Corrupt snapshot task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-CORRUPT-SNAP');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            // Tamper initial-snapshot.json
            const initialSnapPath = path.join(snapDir, '.omni', 'runs', 'dual-authority', 'initial-snapshot.json');
            fs.writeFileSync(initialSnapPath, 'corrupted JSON content', 'utf8');

            await assert.rejects(
                () => client.evaluateCompletion(sessionId, {
                    qc_evidence: {
                        task_id: 'TASK-CORRUPT-SNAP',
                        verdict: 'SUCCESS',
                        plan_revision: 1,
                        diff_fingerprint: 'a'.repeat(64),
                        command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                        findings: [],
                        modified_files: ['index.html'],
                    },
                }),
                (err) => err.code === 'DUAL_SNAPSHOT_CORRUPT' || /initial snapshot/i.test(err.message)
            );
        });

        it('Zero Git commands are executed in a greenfield snapshot session', async (t) => {
            const gitCalls = [];
            const probedGitRunner = (args, options) => {
                gitCalls.push({ args, options });
                throw new Error(`Git command called unexpectedly in snapshot session: git ${args.join(' ')}`);
            };

            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                gitRunner: probedGitRunner,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            assert.equal(beginRes.expected_baseline.kind, 'snapshot');

            await client.registerPlan(beginRes.session_id, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'f'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-ZERO-GIT',
                    title: 'Zero git task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(beginRes.session_id);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-ZERO-GIT');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            assert.ok(fs.existsSync(path.join(taskRunDir, 'review.json')));

            // Assert gitRunner was never called
            assert.equal(gitCalls.length, 0, 'No git commands should be invoked');
        });

        it('Pre-ledger crash recovery: retry begin without session ID reuses written initial snapshot session', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            let failAppend = true;
            const originalAppend = authorityStore.append.bind(authorityStore);
            authorityStore.append = (event) => {
                if (event.type === 'session.created' && failAppend) {
                    failAppend = false;
                    throw new Error('Simulated authority append crash after initial snapshot write');
                }
                return originalAppend(event);
            };

            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });

            // First attempt fails at append
            await assert.rejects(
                () => client.beginSession({ workspace_root: snapDir, mode: 'auto' }),
                /Simulated authority append crash/i
            );

            // Initial snapshot was persisted
            const initialSnapPath = path.join(snapDir, '.omni', 'runs', 'dual-authority', 'initial-snapshot.json');
            assert.ok(fs.existsSync(initialSnapPath), 'initial-snapshot.json must exist');
            const initialSnap = JSON.parse(fs.readFileSync(initialSnapPath, 'utf8'));

            // Second attempt without session_id recovers the exact persisted session_id
            const retryRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            assert.equal(retryRes.session_id, initialSnap.session_id);
            assert.equal(authorityStore.readEvents().length, 1);
        });

        it('Pre-ledger crash recovery: retry with conflicting session ID or after source change is rejected', async (t) => {
            const authorityDir = path.join(snapDir, '.omni', 'runs', 'dual-authority');
            const { createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const initial = snapBaseline.capture();

            writeInitialSnapshot({
                authorityDir,
                sessionId: 'sess-persisted',
                workspaceId: 'ws-1',
                workspaceRoot: snapDir,
                identity: initial.identity,
                manifest: initial.manifest,
            });

            const authorityStore = createAuthorityStore(authorityDir);
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });

            // Conflicting session ID requested
            await assert.rejects(
                () => client.beginSession({ workspace_root: snapDir, session_id: 'sess-different', mode: 'auto' }),
                /DUAL_SNAPSHOT_CONFLICT|conflict/i
            );

            // Mutate source workspace -> now identity differs
            fs.writeFileSync(path.join(snapDir, 'drift.txt'), 'drift\n', 'utf8');

            await assert.rejects(
                () => client.beginSession({ workspace_root: snapDir, mode: 'auto' }),
                /DUAL_SNAPSHOT_CONFLICT|DUAL_BASELINE_INVALID|conflict/i
            );
        });

        it('Repeated completion after VERIFIED detects workspace drift and blocks', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-DRIFT',
                    title: 'Drift test task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-DRIFT');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            const initialSnapshot = readInitialSnapshot({
                authorityDir: path.join(snapDir, '.omni', 'runs', 'dual-authority'),
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
            });
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest);

            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-DRIFT',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            for (let i = 1; i <= 3; i++) {
                await client.evaluateCompletion(sessionId, {
                    quality_evidence: {
                        cycle_index: i,
                        attempt: 1,
                        total_tasks: 1,
                        completed_task_ids: ['TASK-DRIFT'],
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        gate_results: [{ id: `gate-${i}`, required: true, status: 'PASSED' }],
                        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                        evidence_sha256: crypto.createHash('sha256').update(`evidence-${i}`).digest('hex'),
                    },
                });
            }

            // Final completion -> VERIFIED
            const verifyRes = await client.evaluateCompletion(sessionId);
            assert.equal(verifyRes.verified, true);
            assert.equal(verifyRes.session_state, 'VERIFIED');

            // Workspace drifts after verification!
            fs.writeFileSync(path.join(snapDir, 'post-verify-tamper.txt'), 'tamper\n', 'utf8');

            // Subsequent completion evaluate must detect drift
            const driftRes = await client.evaluateCompletion(sessionId);
            assert.equal(driftRes.verified, false);
            assert.ok(driftRes.blockers.some(b => /drift/i.test(b)));
        });

        it('Workspace paths with spaces and Unicode pass snapshot execution and verification', async (t) => {
            const unicodeDir = createTempDir('omni-snap-ünicøde tést ');
            t.after(() => rmDir(unicodeDir));

            fs.writeFileSync(path.join(unicodeDir, 'index.html'), '<html><body>Unicode Test</body></html>\n', 'utf8');
            const customFakeAgy = createFakeAgyScript(unicodeDir);

            const authorityStore = createAuthorityStore(path.join(unicodeDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: unicodeDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [customFakeAgy],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: unicodeDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: unicodeDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: unicodeDir, mode: 'auto' });
            assert.equal(beginRes.expected_baseline.kind, 'snapshot');
        });

        it('Repeated completion rejects accepted envelope with forged diff fingerprint', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-FORGE-DIFF',
                    title: 'Forge diff task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-FORGE-DIFF');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            const initialSnapshot = readInitialSnapshot({
                authorityDir: path.join(snapDir, '.omni', 'runs', 'dual-authority'),
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
            });
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest);

            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-FORGE-DIFF',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            for (let i = 1; i <= 3; i++) {
                await client.evaluateCompletion(sessionId, {
                    quality_evidence: {
                        cycle_index: i,
                        attempt: 1,
                        total_tasks: 1,
                        completed_task_ids: ['TASK-FORGE-DIFF'],
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        gate_results: [{ id: `gate-${i}`, required: true, status: 'PASSED' }],
                        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                        evidence_sha256: crypto.createHash('sha256').update(`evidence-${i}`).digest('hex'),
                    },
                });
            }

            // Verify cleanly
            const verifyRes = await client.evaluateCompletion(sessionId);
            assert.equal(verifyRes.verified, true);

            // Tamper accepted-snapshot.json diff_fingerprint and re-hash content_sha256
            const acceptedPath = path.join(snapDir, '.omni', 'runs', 'dual-authority', 'accepted-snapshot.json');
            const acceptedObj = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
            acceptedObj.diff_fingerprint = 'f'.repeat(64);
            const copy = { ...acceptedObj };
            delete copy.content_sha256;
            acceptedObj.content_sha256 = crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
            fs.writeFileSync(acceptedPath, JSON.stringify(acceptedObj, null, 2), 'utf8');

            const reVerify = await client.evaluateCompletion(sessionId);
            assert.equal(reVerify.verified, false);
            assert.ok(reVerify.blockers.some(b => /diff|receipt/i.test(b)));
        });

        it('Repeated completion rejects accepted envelope with tampered completed tasks or invalid manifest', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-TAMPER-TASKS',
                    title: 'Tamper tasks task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-TAMPER-TASKS');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            const initialSnapshot = readInitialSnapshot({
                authorityDir: path.join(snapDir, '.omni', 'runs', 'dual-authority'),
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
            });
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest);

            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-TAMPER-TASKS',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            for (let i = 1; i <= 3; i++) {
                await client.evaluateCompletion(sessionId, {
                    quality_evidence: {
                        cycle_index: i,
                        attempt: 1,
                        total_tasks: 1,
                        completed_task_ids: ['TASK-TAMPER-TASKS'],
                        plan_revision: 1,
                        diff_fingerprint: diffInfo.patchSha256,
                        gate_results: [{ id: `gate-${i}`, required: true, status: 'PASSED' }],
                        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                        evidence_sha256: crypto.createHash('sha256').update(`evidence-${i}`).digest('hex'),
                    },
                });
            }

            const verifyRes = await client.evaluateCompletion(sessionId);
            assert.equal(verifyRes.verified, true);

            // Tamper completed_tasks
            const acceptedPath = path.join(snapDir, '.omni', 'runs', 'dual-authority', 'accepted-snapshot.json');
            const acceptedObj = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
            acceptedObj.completed_tasks = ['TASK-TAMPER-TASKS', 'EXTRA-TASK'];
            const copy = { ...acceptedObj };
            delete copy.content_sha256;
            acceptedObj.content_sha256 = crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
            fs.writeFileSync(acceptedPath, JSON.stringify(acceptedObj, null, 2), 'utf8');

            const reVerify = await client.evaluateCompletion(sessionId);
            assert.equal(reVerify.verified, false);
            assert.ok(reVerify.blockers.some(b => /task|receipt|invalid/i.test(b)));
        });

        it('Crash recovery: append session.verified failure after accepted snapshot write retries cleanly and leaves exactly one session.verified event', async (t) => {
            const authorityStore = createAuthorityStore(path.join(snapDir, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: snapDir,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [fakeAgyScript],
            });

            let failVerifiedAppend = true;
            const originalAppend = authorityStore.append.bind(authorityStore);
            authorityStore.append = (ev) => {
                if (ev.type === 'session.verified' && failVerifiedAppend) {
                    failVerifiedAppend = false;
                    throw new Error('Simulated transient append failure for session.verified');
                }
                return originalAppend(ev);
            };

            const daemon = await startDaemonServer({
                workspaceRoot: snapDir,
                authorityStore,
                orchestrator: adapter,
                preflightRunner: async () => ({
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'preflight', status: 'PASSED' }],
                    details: {},
                }),
            });
            t.after(() => daemon.close());

            const client = createDaemonClient({ workspaceRoot: snapDir, timeoutMs: 10000 });
            const beginRes = await client.beginSession({ workspace_root: snapDir, mode: 'auto' });
            const sessionId = beginRes.session_id;

            await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                plan_revision: 1,
                tasks: [{
                    task_id: 'TASK-RETRY-VERIFY',
                    title: 'Retry verify task',
                    risk: 'low',
                    allowed_files: ['index.html'],
                    deny_patterns: [],
                    validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                }],
            });

            await client.resumeSession(sessionId);

            const taskRunDir = path.join(snapDir, '.omni', 'codex-gemini', 'runs', 'TASK-RETRY-VERIFY');
            let attempts = 0;
            while (attempts < 100) {
                if (fs.existsSync(path.join(taskRunDir, 'review.json'))) break;
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            const initialSnapshot = readInitialSnapshot({
                authorityDir: path.join(snapDir, '.omni', 'runs', 'dual-authority'),
                sessionId,
                workspaceId: beginRes.workspace_id,
                workspaceRoot: snapDir,
            });
            const snapBaseline = createSnapshotBaseline({ root: snapDir });
            const diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest);

            await client.evaluateCompletion(sessionId, {
                qc_evidence: {
                    task_id: 'TASK-RETRY-VERIFY',
                    verdict: 'SUCCESS',
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    command_outputs: [{ command: 'node --version', exit_code: 0, duration_ms: 50 }],
                    findings: [],
                    modified_files: diffInfo.files,
                },
            });

            await client.evaluateCompletion(sessionId, {
                quality_evidence: {
                    cycle_index: 1,
                    attempt: 1,
                    total_tasks: 1,
                    completed_task_ids: ['TASK-RETRY-VERIFY'],
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    gate_results: [{ id: 'gate-1', required: true, status: 'PASSED' }],
                    commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                    evidence_sha256: crypto.createHash('sha256').update('evidence-1').digest('hex'),
                },
            });
            await client.evaluateCompletion(sessionId, {
                quality_evidence: {
                    cycle_index: 2,
                    attempt: 1,
                    total_tasks: 1,
                    completed_task_ids: ['TASK-RETRY-VERIFY'],
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    gate_results: [{ id: 'gate-2', required: true, status: 'PASSED' }],
                    commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                    evidence_sha256: crypto.createHash('sha256').update('evidence-2').digest('hex'),
                },
            });

            // 3rd quality cycle triggers completion evaluation, which writes accepted snapshot and fails on append(session.verified)
            const firstTry = await client.evaluateCompletion(sessionId, {
                quality_evidence: {
                    cycle_index: 3,
                    attempt: 1,
                    total_tasks: 1,
                    completed_task_ids: ['TASK-RETRY-VERIFY'],
                    plan_revision: 1,
                    diff_fingerprint: diffInfo.patchSha256,
                    gate_results: [{ id: 'gate-3', required: true, status: 'PASSED' }],
                    commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                    evidence_sha256: crypto.createHash('sha256').update('evidence-3').digest('hex'),
                },
            });
            assert.equal(firstTry.verified, false);
            assert.ok(firstTry.blockers.some(b => /VERIFICATION_APPEND_FAILED/i.test(b)));

            // Accepted snapshot file exists on disk
            const acceptedPath = path.join(snapDir, '.omni', 'runs', 'dual-authority', 'accepted-snapshot.json');
            assert.ok(fs.existsSync(acceptedPath));

            // Second attempt succeeds by reusing existing accepted file and appending session.verified
            const secondTry = await client.evaluateCompletion(sessionId);
            assert.equal(secondTry.verified, true);
            assert.equal(secondTry.session_state, 'VERIFIED');

            // Verify exactly one session.verified event in store
            const allEvents = authorityStore.readEvents();
            const verifiedEvents = allEvents.filter(e => e.type === 'session.verified');
            assert.equal(verifiedEvents.length, 1);
        });
    });

    describe('Scenario 17: Slice 3C Capability Evidence Reuse & Hardened Execution', () => {
        let repoRoot, snapDir, daemon, client, sessionId, scratchDir;

        beforeEach(async () => {
            scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-3c-scratch-'));
        });

        afterEach(async () => {
            if (daemon) {
                try { await daemon.close(); } catch {}
                daemon = null;
            }
            if (repoRoot) {
                try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
                repoRoot = null;
            }
            if (snapDir) {
                try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
                snapDir = null;
            }
            if (scratchDir) {
                try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
                scratchDir = null;
            }
        });

        it('Daemon-managed tasks reuse authoritative capability evidence and spawn 0 task-level capability probes', async () => {
            const customAgyScript = createFakeAgyScript(scratchDir);
            const preflightInvocations = [];
            const taskInvocations = [];
            const spawnImpl = (command, args, options) => {
                preflightInvocations.push({ command, args: [...args] });
                return spawn(command, args, options);
            };
            const processRunner = (invocation, deps) => {
                taskInvocations.push({ command: invocation.command, args: [...invocation.args] });
                return runProcess(invocation, deps);
            };

            repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-reuse-'));
            initGitRepo(repoRoot);
            fs.mkdirSync(path.join(repoRoot, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(repoRoot, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));
            assert.equal(spawnSync('git', ['add', '.codex/config.toml', '.codex/hooks.json'], { cwd: repoRoot }).status, 0);
            assert.equal(spawnSync('git', ['commit', '-m', 'add dual config'], { cwd: repoRoot }).status, 0);

            const authorityStore = createAuthorityStore(path.join(repoRoot, '.omni', 'runs', 'dual-authority'));
            daemon = await startDaemonServer({
                workspaceRoot: repoRoot,
                authorityStore,
                agyCommand: process.execPath,
                agyPrefixArgs: [customAgyScript],
                spawnImpl,
                processRunner,
            });

            client = createDaemonClient({
                workspaceRoot: repoRoot,
                port: daemon.port,
                token: daemon.token,
                timeoutMs: 10_000,
            });

            const beginRes = await client.beginSession({ workspace_root: repoRoot, mode: 'auto' });
            sessionId = beginRes.session_id;

            // Plan registration performs single authoritative daemon preflight
            const regRes = await client.registerPlan(sessionId, {
                plan_path: 'plans/plan.md',
                plan_sha256: 'a'.repeat(64),
                total_tasks: 1,
                tasks: [
                    {
                        task_id: 'TASK-1',
                        title: 'Task 1',
                        goal: 'Implement task 1',
                        owner: 'agy',
                        risk: 'low',
                        complexity: 'low',
                        category: 'feature',
                        allowed_files: ['index.html'],
                        deny_patterns: [],
                        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                    },
                ],
            });
            assert.equal(regRes.registered, true);
            assert.equal(regRes.tasks[0].owner, 'agy', JSON.stringify(regRes.tasks));

            assert.deepEqual(
                preflightInvocations.map((entry) => entry.args.slice(-1)[0]),
                ['--version', 'models'],
                'Daemon registration must perform exactly one version and one model probe'
            );

            // Resume session to execute task
            const resumeRes = await client.resumeSession(sessionId);
            assert.equal(resumeRes.resumed, true);

            // Wait for worker to finish
            const taskRunDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-1');
            const reviewPath = path.join(taskRunDir, 'review.json');
            let completed = false;
            for (let i = 0; i < 60; i++) {
                if (fs.existsSync(reviewPath)) {
                    completed = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            const observedFiles = fs.existsSync(taskRunDir) ? fs.readdirSync(taskRunDir).sort() : [];
            assert.equal(
                completed,
                true,
                `Task should complete AGY phases; invocations=${JSON.stringify(taskInvocations)} files=${JSON.stringify(observedFiles)}`
            );

            assert.equal(preflightInvocations.length, 2, 'Task execution must not repeat daemon capability probes');
            assert.equal(taskInvocations.some((entry) => entry.args.includes('--version')), false);
            assert.equal(taskInvocations.some((entry) => entry.args.slice(-1)[0] === 'models'), false);
            assert.ok(taskInvocations.length >= 3, 'Scout, implement, and review model phases must still execute');

            const callsAfterFirstResume = taskInvocations.length;
            await client.resumeSession(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(taskInvocations.length, callsAfterFirstResume, 'Resume must reuse completed phases without probes or model calls');
            assert.equal(preflightInvocations.length, 2);
        });

        it('Orchestrator adapter blocks task execution if authoritative capability evidence is missing or invalid', async () => {
            repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-forged-'));
            initGitRepo(repoRoot);
            const authorityStore = createAuthorityStore(path.join(repoRoot, '.omni', 'runs', 'dual-authority'));
            const adapter = createOrchestratorAdapter({
                workspaceRoot: repoRoot,
                authorityStore,
            });

            // Derived state missing capability result or having forged capability
            const forgedDerived = {
                sessionId: 'sess-1',
                workspaceId: 'ws-1',
                currentBaseline: { kind: 'git', id: execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim() },
                capability: {
                    status: 'PASSED',
                    to_state: 'CAPABILITY_SAFE',
                    checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
                    details: { agy_version: '1.1.19', agy_model: 'gemini-3.7-flash-high' },
                },
                tasks: {
                    'TASK-1': {
                        task_id: 'TASK-1',
                        title: 'Task 1',
                        goal: 'Goal 1',
                        owner: 'agy',
                        risk: 'low',
                        allowed_files: ['index.html'],
                        deny_patterns: [],
                        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
                        state: 'ROUTED',
                    },
                },
            };

            await assert.rejects(
                () => adapter.executeAgyTask('TASK-1', forgedDerived.tasks['TASK-1'], forgedDerived),
                /DUAL_AUTHORITY_CAPABILITY_INVALID|capability/i
            );
        });

        it('Evidence with unverified_items and SUCCESS status is accepted for CODEX_QC', () => {
            const { EvidenceSchema } = require('../lib/dual/contracts');
            const validEvidenceWithUnverified = {
                schema_version: 1,
                task_id: 'TASK-1',
                expected_base_commit: '1234567890123456789012345678901234567890',
                status: 'SUCCESS',
                modified_files: ['index.html'],
                command_outputs: [{ command: 'npm test', exit_code: 0, output: '7 passed' }],
                unverified_items: ['[EXTERNAL_OPTIONAL] Live production endpoint unverified due to placeholder URL'],
                self_review: {
                    checks: ['scope inspected', 'edge cases checked', 'validation passed'],
                    remaining_risks: [],
                },
            };
            const result = EvidenceSchema.safeParse(validEvidenceWithUnverified);
            assert.equal(result.success, true);
            assert.equal(result.data.unverified_items.length, 1);
        });
    });
});

