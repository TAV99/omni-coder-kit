'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startDaemonServer, createDaemonClient, createAuthorityStore } = require('../lib/dual');
const { createDaemonServerOptions } = require('../bin/omni-daemon');
const { createTrustedQualityRunner } = require('../lib/dual/quality-runner');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

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

function acceptancePolicy() {
    return {
        protocol_version: 1,
        checks: [],
        ui: { required: false, viewport_widths: [390], reduced_motion_required: true },
    };
}

test('daemon health and status remain responsive during slow quality validator execution', async (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-flow-resp-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(path.join(root, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>fixture</body></html>\n');
    const planBytes = Buffer.from('# Responsiveness plan\n');
    fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'plan.md'), planBytes);

    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);

    const daemon = await startDaemonServer({
        ...createDaemonServerOptions({ workspaceRoot: root, authorityStore: store }),
        preflightRunner: async () => passingCapability(),
        trustedQualityRunner: createTrustedQualityRunner(),
    });
    t.after(async () => { try { await daemon.close(); } catch {} });

    const client = createDaemonClient({ workspaceRoot: root, timeoutMs: 20_000 });
    const begun = await client.beginSession({ workspace_root: root, mode: 'auto' });

    // Task with a controlled 3-second validator
    await client.registerPlan(begun.session_id, {
        plan_path: '.omni/sdlc/plan.md',
        plan_sha256: sha(planBytes),
        plan_revision: 1,
        acceptance_policy: acceptancePolicy(),
        tasks: [{
            task_id: 'TASK-SLOW',
            title: 'Slow validator task',
            owner: 'codex',
            allowed_files: ['index.html'],
            validation_commands: [{
                program: 'node',
                args: ['-e', 'setTimeout(() => { process.exit(0); }, 3000)'],
                cwd: '.',
            }],
        }],
    });

    store.append({
        type: 'task.routed',
        task_id: 'TASK-SLOW',
        owner: 'codex',
        authority_state: 'ROUTED',
        allowed_files: ['index.html'],
        reason: 'Fixture task setup',
    });
    const lease = store.acquireLease('TASK-SLOW', 'codex');
    store.append({
        type: 'task.completed',
        task_id: 'TASK-SLOW',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.html'],
        diff_fingerprint: sha('task-completion'),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    store.releaseLease(lease.lease_id, 'TASK-SLOW', 'codex', { reason: 'Fixture task complete' });

    // Start quality execution (runs for 3 seconds)
    const qualityPromise = client.executeQualityCycle(begun.session_id, 1);

    // Give it 300ms to ensure the child process is active
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Health request during execution must be responsive (< 1000ms)
    const healthStart = Date.now();
    const healthRes = await client.health();
    const healthElapsed = Date.now() - healthStart;
    assert.equal(healthRes.status, 'healthy');
    assert.ok(healthElapsed < 1000, `health request took ${healthElapsed}ms, expected < 1000ms`);

    // Status request during execution must be responsive (< 1000ms)
    const statusStart = Date.now();
    const statusRes = await client.status(begun.session_id);
    const statusElapsed = Date.now() - statusStart;
    assert.ok(statusRes && statusRes.session_id === begun.session_id);
    assert.ok(statusElapsed < 1000, `status request took ${statusElapsed}ms, expected < 1000ms`);

    // Conflicting stop during active run is rejected
    await assert.rejects(
        () => client.stop(),
        (err) => err.code === 'DUAL_VALIDATOR_ACTIVE' || err.code === 'DUAL_VALIDATOR_BUSY'
    );

    // Await quality completion
    const qualityRes = await qualityPromise;
    assert.ok(qualityRes && qualityRes.quality_evidence);
});
