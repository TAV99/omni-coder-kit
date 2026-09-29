'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
    startDaemonServer,
    createDaemonClient,
    createAuthorityStore,
} = require('../lib/dual');
const { captureDiffFingerprint } = require('../lib/dual/scope-guard');
const { createTrustedQualityRunner } = require('../lib/dual/quality-runner');
const { createDaemonServerOptions } = require('../bin/omni-daemon');

function createPassingTrustedQualityRunner() {
    return createTrustedQualityRunner({
        executeQualityPlanImpl: (plan) => plan.commands.map((command) => ({
            ...command,
            command: `${command.program} ${command.args.join(' ')}`.trim(),
            exit_code: 0,
            duration_ms: 1,
            ok: true,
            failure: null,
            signal: null,
            started_at: '2026-09-11T00:00:00.000Z',
            ended_at: '2026-09-11T00:00:00.001Z',
            stdout: '',
            stderr: '',
        })),
    });
}

function createTempDir(prefix = 'omni-dual-git-drift-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    return head.stdout.trim();
}

test('git baseline allows idempotent evaluateCompletion when uncommitted files match verified receipt diff', async (t) => {
    const wsRoot = createTempDir();
    t.after(() => {
        try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch {}
    });

    const baseCommit = initGitRepo(wsRoot);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'runs', 'dual-authority'));

    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: wsRoot, authorityStore }),
        trustedQualityRunner: createPassingTrustedQualityRunner(),
        planArtifactVerifier: async () => ({ plan_path: '.omni/sdlc/dual-plan.json', plan_sha256: 'a'.repeat(64) }),
        capabilityPreflight: async () => ({
            status: 'PASSED',
            to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: { agy_version: '1.0.0', agy_model: 'gemini-3.7-flash-high' },
        }),
    });
    t.after(async () => {
        await daemon.close();
    });

    const client = createDaemonClient({ workspaceRoot: wsRoot, timeoutMs: 5000 });

    // 1. Begin session
    const beginRes = await client.beginSession({
        workspace_root: wsRoot,
        expected_baseline: { kind: 'git', id: baseCommit },
    });
    const sessionId = beginRes.session_id;

    // 2. Register plan
    const regRes = await client.registerPlan(sessionId, {
        plan_path: '.omni/sdlc/dual-plan.json',
        plan_sha256: 'a'.repeat(64),
        plan_revision: 1,
        total_tasks: 1,
        acceptance_policy: {
            protocol_version: 1,
            checks: [],
            ui: { required: false, viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true },
        },
        tasks: [{
            task_id: 'TASK-1',
            title: 'Create App',
            owner: 'codex',
            allowed_files: ['src/app.js'],
            validation_commands: [{ program: 'node', args: ['--check', 'src/app.js'], cwd: '.' }],
        }],
    });
    assert.equal(regRes.plan_revision, 1);

    // 3. Simulate implementation without committing to git (user rule compliance)
    fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'src', 'app.js'), 'console.log("hello world");\n', 'utf8');

    // 4. Measure fresh diff fingerprint
    const diffInfo = captureDiffFingerprint({
        repoRoot: wsRoot,
        baseCommit,
        excludedPaths: ['.omni'],
    });
    const patchSha = diffInfo.patchSha256;

    // 5. Complete task under codex authority via qc_evidence
    await client.evaluateCompletion(sessionId, {
        qc_evidence: {
            task_id: 'TASK-1',
            plan_revision: 1,
            verdict: 'SUCCESS',
            diff_fingerprint: patchSha,
            modified_files: ['src/app.js'],
            command_outputs: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
            findings: [],
        },
    });

    // 6. Record 3 Quality Cycles
    for (let cycle = 1; cycle <= 3; cycle++) {
        const execution = await client.executeQualityCycle(sessionId, cycle);
        const evalRes = await client.evaluateCompletion(sessionId, {
            quality_evidence: execution.quality_evidence,
        });
        if (cycle < 3) {
            assert.equal(evalRes.verified, false);
        } else {
            assert.equal(evalRes.verified, true);
            assert.equal(evalRes.session_state, 'VERIFIED');
            assert.ok(evalRes.receipt);
            assert.ok(evalRes.receipt.receipt_sha256);
        }
    }

    // 7. Idempotent call: evaluateCompletion again WITHOUT committing files
    const idempotentRes = await client.evaluateCompletion(sessionId);
    assert.equal(idempotentRes.verified, true, 'Idempotent completion must succeed without requiring git commit');
    assert.equal(idempotentRes.session_state, 'VERIFIED');
    assert.deepEqual(idempotentRes.blockers, []);

    // 8. Real drift: modify workspace after verification
    fs.writeFileSync(path.join(wsRoot, 'src', 'drift.js'), 'malicious modification\n', 'utf8');
    const driftRes = await client.evaluateCompletion(sessionId);
    assert.equal(driftRes.verified, false, 'Modified workspace after verification must trigger drift');
    assert.equal(driftRes.session_state, 'VERIFIED');
    assert.ok(driftRes.blockers.some(b => b.includes('WORKSPACE_DRIFT_AFTER_VERIFIED')));
});
