'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    DEFAULT_WORKER_MODEL,
    DEFAULT_WORKER_EFFORT,
    resolveConfiguredWorkerModel,
    resolveConfiguredWorkerEffort,
} = require('../lib/dual/agy-model');
const {
    parseAgyModelsOutput,
    validateCapabilityResult,
    runCapabilityPreflight,
} = require('../lib/dual/capability-preflight');
const { buildAgyInvocation } = require('../lib/dual/agy-runner');
const { RouteSchema, EventSchema, parseContract } = require('../lib/dual/contracts');
const { createDualOrchestrator } = require('../lib/dual/orchestrator');

test('Dual Custom Worker Model & Effort Support', async (t) => {
    await t.test('1. resolveConfiguredWorkerModel respects precedence: option > env > manifest > default', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-model-res-'));
        fs.mkdirSync(path.join(tmpDir, '.omni'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, '.omni', 'manifest.json'),
            JSON.stringify({ workerModel: 'gemini-2.5-pro', workerEffort: 'medium' }),
            'utf8'
        );

        // 1a. Default fallback when no manifest and no option
        assert.equal(resolveConfiguredWorkerModel(null), DEFAULT_WORKER_MODEL);
        assert.equal(resolveConfiguredWorkerEffort(null), DEFAULT_WORKER_EFFORT);

        // 1b. Manifest resolution
        assert.equal(resolveConfiguredWorkerModel(tmpDir), 'gemini-2.5-pro');
        assert.equal(resolveConfiguredWorkerEffort(tmpDir), 'medium');

        // 1c. Environment variable overrides manifest
        const oldEnvModel = process.env.OMNI_DUAL_WORKER_MODEL;
        const oldEnvEffort = process.env.OMNI_DUAL_WORKER_EFFORT;
        try {
            process.env.OMNI_DUAL_WORKER_MODEL = 'gemini-exp-1206';
            process.env.OMNI_DUAL_WORKER_EFFORT = 'low';
            assert.equal(resolveConfiguredWorkerModel(tmpDir), 'gemini-exp-1206');
            assert.equal(resolveConfiguredWorkerEffort(tmpDir), 'low');

            // 1d. Options override env
            assert.equal(resolveConfiguredWorkerModel(tmpDir, { workerModel: 'gemini-3.8-flash-high' }), 'gemini-3.8-flash-high');
            assert.equal(resolveConfiguredWorkerEffort(tmpDir, { workerEffort: 'high' }), 'high');
        } finally {
            if (oldEnvModel !== undefined) process.env.OMNI_DUAL_WORKER_MODEL = oldEnvModel;
            else delete process.env.OMNI_DUAL_WORKER_MODEL;

            if (oldEnvEffort !== undefined) process.env.OMNI_DUAL_WORKER_EFFORT = oldEnvEffort;
            else delete process.env.OMNI_DUAL_WORKER_EFFORT;

            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('2. parseAgyModelsOutput matches custom models in array, object, JSON, and text', () => {
        const customModel = 'gemini-2.5-pro';

        // Array of strings
        assert.equal(parseAgyModelsOutput(['gemini-3.7-flash-high', 'gemini-2.5-pro'], customModel), true);
        assert.equal(parseAgyModelsOutput(['gemini-3.7-flash-high'], customModel), false);

        // Array of objects
        assert.equal(parseAgyModelsOutput([{ id: 'gemini-2.5-pro' }], customModel), true);

        // JSON wrapper
        assert.equal(parseAgyModelsOutput(JSON.stringify({ models: [{ id: 'gemini-2.5-pro' }] }), customModel), true);

        // Tabular text format
        const tabular = 'gemini-2.5-pro      Gemini 2.5 Pro\ngemini-3.7-flash-high Gemini 3.7 Flash High';
        assert.equal(parseAgyModelsOutput(tabular, customModel), true);
        assert.equal(parseAgyModelsOutput(tabular, 'gemini-unknown'), false);
    });

    await t.test('3. validateCapabilityResult validates custom model evidence', () => {
        const customCap = {
            status: 'PASSED',
            to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: {
                agy_version: 'agy 1.2.3',
                agy_model: 'gemini-2.5-pro',
                agy_evidence: {
                    version: '1.2.3',
                    model: 'gemini-2.5-pro',
                },
            },
        };

        const validated = validateCapabilityResult(customCap, 'gemini-2.5-pro');
        assert.equal(validated.valid, true);
        assert.equal(validated.model, 'gemini-2.5-pro');
        assert.equal(validated.version, '1.2.3');

        // Without expectedModel, defaults to gemini-3.7-flash-high, so customCap fails
        const defaultMismatch = validateCapabilityResult(customCap);
        assert.equal(defaultMismatch.valid, false);

        // Explicit mismatch with another expected model fails
        const mismatch = validateCapabilityResult(customCap, 'gemini-3.7-flash-high');
        assert.equal(mismatch.valid, false);
    });

    await t.test('4. RouteSchema and EventSchema accept custom worker models', () => {
        const routeData = {
            schema_version: 1,
            task_id: 'task-custom-1',
            expected_base_commit: '0123456789abcdef0123456789abcdef01234567',
            owner: 'gemini',
            model: 'gemini-2.5-pro',
            effort: 'high',
            token_budget: null,
            allowed_files: ['lib/foo.js'],
            reason: 'Routed to custom worker model',
        };
        const parsedRoute = RouteSchema.parse(routeData);
        assert.equal(parsedRoute.model, 'gemini-2.5-pro');

        const eventData = {
            schema_version: 1,
            task_id: 'task-custom-1',
            expected_base_commit: '0123456789abcdef0123456789abcdef01234567',
            event_id: '00000000-0000-4000-8000-000000000001',
            sequence: 1,
            timestamp: '2026-08-24T00:00:01.000Z',
            type: 'phase.completed',
            phase: 'preflight',
            attempt: 1,
            from_state: 'NEW',
            to_state: 'PREFLIGHT_SAFE',
            artifact_hashes: {},
            warnings: [],
            capability_evidence: {
                agy_version: '1.2.3',
                agy_model: 'gemini-2.5-pro',
            },
        };
        const parsedEvent = EventSchema.parse(eventData);
        assert.equal(parsedEvent.capability_evidence.agy_model, 'gemini-2.5-pro');
    });

    await t.test('5. buildAgyInvocation emits specified model and effort flags', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-runner-'));
        const inputPath = path.join(tmpDir, 'context.json');
        const schemaPath = path.join(tmpDir, 'spec-schema.json');
        fs.writeFileSync(inputPath, '{}');
        fs.writeFileSync(schemaPath, '{}');

        try {
            const invocation = buildAgyInvocation({
                repoRoot: tmpDir,
                phase: 'scout',
                inputPath,
                schemaPath,
                timeoutMs: 60_000,
                model: 'gemini-2.5-pro',
                effort: 'low',
            });

            const modelIdx = invocation.args.indexOf('--model');
            assert.notEqual(modelIdx, -1);
            assert.equal(invocation.args[modelIdx + 1], 'gemini-2.5-pro');

            const effortIdx = invocation.args.indexOf('--effort');
            assert.notEqual(effortIdx, -1);
            assert.equal(invocation.args[effortIdx + 1], 'low');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('6. runCapabilityPreflight passes with custom model when present and blocks when absent', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-custom-'));
        const { createAuthorityStore } = require('../lib/dual/authority-store');
        const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
        const authorityStore = createAuthorityStore(authorityDir);

        fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
        fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));

        try {
            // 6a. Custom model present
            const passRes = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                workerModel: 'gemini-2.5-pro',
                agyVersion: 'agy 1.2.3',
                agyModels: JSON.stringify(['gemini-2.5-pro', 'gemini-3.7-flash-high']),
                checkBaseline: async () => ({ name: 'baseline_backend', status: 'PASSED' }),
            });
            assert.equal(passRes.status, 'PASSED');
            assert.equal(passRes.to_state, 'CAPABILITY_SAFE');
            assert.equal(passRes.details.agy_model, 'gemini-2.5-pro');

            // 6b. Custom model absent
            const failRes = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                workerModel: 'gemini-nonexistent-model',
                agyVersion: 'agy 1.2.3',
                agyModels: JSON.stringify(['gemini-3.7-flash-high']),
                checkBaseline: async () => ({ name: 'baseline_backend', status: 'PASSED' }),
            });
            assert.equal(failRes.status, 'BLOCKED');
            const modelCheck = failRes.checks.find((c) => c.name === 'agy_cli_and_model');
            assert.equal(modelCheck.status, 'BLOCKED');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('7. createDualOrchestrator routes with custom model and enforces authoritative evidence', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-orch-custom-'));
        const { createAuthorityStore } = require('../lib/dual/authority-store');
        const { createGitBaseline } = require('../lib/dual/baseline');
        const { execSync } = require('node:child_process');

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'ignore' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test');
            execSync('git add README.md && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

            const baseCommit = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

            const orch = createDualOrchestrator({
                cwd: tmpDir,
                workerModel: 'gemini-2.5-pro',
                workerEffort: 'medium',
                authoritativeCapabilityEvidence: {
                    version: '1.2.3',
                    model: 'gemini-2.5-pro',
                },
            });

            // Initialize task
            orch.newTask('TASK-CUSTOM-1');
            const pfRes = await orch.runPhase('preflight', 'TASK-CUSTOM-1');
            assert.equal(pfRes.state, 'PREFLIGHT_SAFE');

            // Advance through state machine to SPEC_VALID
            const { createStateStore } = require('../lib/dual/state-store');
            const taskRunDir = path.join(tmpDir, '.omni', 'codex-gemini', 'runs', 'TASK-CUSTOM-1');
            const store = createStateStore(taskRunDir, { taskId: 'TASK-CUSTOM-1' });
            store.append({ type: 'phase.started', phase: 'scout', attempt: 1 });
            store.append({ type: 'phase.completed', phase: 'scout', attempt: 1, from_state: 'PREFLIGHT_SAFE', to_state: 'SCOUT_VALID', artifact_hashes: {} });
            store.append({ type: 'phase.started', phase: 'spec', attempt: 1 });
            store.append({ type: 'phase.completed', phase: 'spec', attempt: 1, from_state: 'SCOUT_VALID', to_state: 'SPEC_VALID', artifact_hashes: {} });

            // Write valid spec
            fs.writeFileSync(path.join(taskRunDir, 'spec.json'), JSON.stringify({
                schema_version: 1,
                task_id: 'TASK-CUSTOM-1',
                expected_base_commit: baseCommit,
                goal: 'Custom test goal',
                allowed_files: ['README.md'],
                deny_patterns: [],
                validation_commands: [{ program: 'git', args: ['status'], cwd: '.' }],
                risk_flags: [],
            }));

            // Route phase
            const routeRes = await orch.runPhase('route', 'TASK-CUSTOM-1');
            assert.equal(routeRes.owner, 'gemini');
            assert.equal(routeRes.state, 'ROUTED');

            const savedRoute = JSON.parse(fs.readFileSync(path.join(taskRunDir, 'route.json'), 'utf8'));
            assert.equal(savedRoute.model, 'gemini-2.5-pro');
            assert.equal(savedRoute.effort, 'medium');

            // Mismatched authoritative evidence throws
            const badOrch = createDualOrchestrator({
                cwd: tmpDir,
                workerModel: 'gemini-2.5-pro',
                authoritativeCapabilityEvidence: {
                    version: '1.2.3',
                    model: 'gemini-wrong-model',
                },
            });
            badOrch.newTask('TASK-CUSTOM-2');
            await assert.rejects(
                () => badOrch.runPhase('preflight', 'TASK-CUSTOM-2'),
                (err) => err.code === 'DUAL_PREFLIGHT_AUTHORITY_INVALID'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
