'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
    createActivityBarrier,
    createBindingCoordinator,
} = require('../../lib/dual/binding-coordinator');

test('T12 activity-barrier: coordinates exclusive apply and operations', async () => {
    const barrier = createActivityBarrier();

    assert.equal(barrier.isBusy(), false);
    assert.equal(barrier.hasActiveOperations(), false);

    // 1. Enter an agent operation
    const exitOp1 = barrier.enterOperation();
    assert.equal(barrier.hasActiveOperations(), true);

    // 2. While operation is active, exclusive apply is rejected
    await assert.rejects(
        async () => {
            await barrier.runExclusive(async () => 'applied');
        },
        /Cannot apply binding while 1 agent operation\(s\) are active/
    );

    // 3. Exit operation
    exitOp1();
    assert.equal(barrier.hasActiveOperations(), false);

    // 4. In exclusive mode, new operations are blocked with maintenance barrier
    let opBlocked = false;
    await barrier.runExclusive(async () => {
        try {
            barrier.enterOperation();
        } catch (err) {
            if (err.code === 'MAINTENANCE_BARRIER') {
                opBlocked = true;
            }
        }
    });

    assert.equal(opBlocked, true);
    assert.equal(barrier.isBusy(), false);
});

test('T12 binding-coordinator: enforces orchestrator stopped proof and idempotency', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coord-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    let currentConfig = { revision: 'rev-01', raw: { preset: 'squad' } };
    const drafts = new Map([
        ['draft-1', {
            candidate: {
                preset: 'squad',
                roles: {
                    orchestrator: { runtime: 'codex', model: 'gpt-4o' },
                    worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-1.5-pro' }],
                    reviewer: null,
                },
            },
        }],
    ]);

    let applyCallCount = 0;
    const coordinator = createBindingCoordinator({
        readConfig: async () => currentConfig,
        applyConfig: async (cand) => {
            applyCallCount++;
            currentConfig = { revision: 'rev-02', raw: cand };
            return { applied: true };
        },
        readDraft: async (id) => drafts.get(id) || null,
        journalDir: path.join(tmpDir, 'journals'),
    });

    // 1. Reject if orchestrator is not stopped
    await assert.rejects(
        async () => {
            await coordinator.apply({
                requestId: 'req-1',
                draftId: 'draft-1',
                uiRuntimeProof: { orchestratorStopped: false },
            });
        },
        /Orchestrator must be stopped/
    );

    assert.equal(applyCallCount, 0);

    // 2. Reject on revision conflict
    await assert.rejects(
        async () => {
            await coordinator.apply({
                requestId: 'req-1',
                draftId: 'draft-1',
                expectedRevision: 'wrong-revision',
                uiRuntimeProof: { orchestratorStopped: true },
            });
        },
        /Configuration revision conflict/
    );

    // 3. Successful apply
    const candidateDigest = crypto.createHash('sha256')
        .update(JSON.stringify(drafts.get('draft-1').candidate))
        .digest('hex');

    const result1 = await coordinator.apply({
        requestId: 'req-1',
        draftId: 'draft-1',
        expectedRevision: 'rev-01',
        preflightDigest: candidateDigest,
        uiRuntimeProof: { orchestratorStopped: true },
    });

    assert.equal(result1.ok, true);
    assert.equal(result1.requestId, 'req-1');
    assert.equal(applyCallCount, 1);

    // 4. Idempotent retry returns identical result without re-executing applyConfig
    const result2 = await coordinator.apply({
        requestId: 'req-1',
        draftId: 'draft-1',
        uiRuntimeProof: { orchestratorStopped: true },
    });

    assert.equal(result2.ok, true);
    assert.equal(result2.revision, result1.revision);
    assert.equal(applyCallCount, 1); // Not increased!
});

test('T12 binding-coordinator: journal rollback on injected failure and recovery', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coord-rollback-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const journalDir = path.join(tmpDir, 'journals');
    let currentConfig = { revision: 'rev-orig', raw: { preset: 'squad', mode: 'original' } };
    const drafts = new Map([
        ['draft-fail', { candidate: { preset: 'squad', mode: 'broken' } }],
    ]);

    const coordinator = createBindingCoordinator({
        readConfig: async () => currentConfig,
        applyConfig: async (cand) => {
            if (cand.mode === 'broken') {
                throw new Error('Injected filesystem disk full error during apply');
            }
            currentConfig = { revision: 'rev-rolled-back', raw: cand };
            return { applied: true };
        },
        readDraft: async (id) => drafts.get(id) || null,
        journalDir,
    });

    // 1. Injected failure triggers rollback
    await assert.rejects(
        async () => {
            await coordinator.apply({
                requestId: 'req-fail-1',
                draftId: 'draft-fail',
                uiRuntimeProof: { orchestratorStopped: true },
            });
        },
        /Injected filesystem disk full error/
    );

    // Check journal file was updated to ROLLED_BACK
    const journalFile = path.join(journalDir, 'apply-req-fail-1.json');
    assert.ok(fs.existsSync(journalFile));
    const journalData = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    assert.equal(journalData.phase, 'ROLLED_BACK');

    // 2. Recovery handles existing journals
    const recoveryResult = await coordinator.recover();
    assert.equal(recoveryResult.recovered, true);
});

// A daemon started without a config writer must refuse binding.apply, never report it applied.
test('daemon: binding.apply without a config writer is refused', async (t) => {
    const { createAuthorityStore } = require('../../lib/dual/authority-store');
    const { startDaemonServer } = require('../../lib/dual/daemon-server');
    const { createDaemonClient } = require('../../lib/dual/daemon-client');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-binding-unwired-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws-bind', session_id: 'session-bind', plan_revision: 1, expected_baseline: { kind: 'git', id: 'c'.repeat(40) }, mode: 'auto' });
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store, readDraft: async () => ({ candidate: { roles: {} } }) });
    t.after(() => daemon.close());
    const client = createDaemonClient({ workspaceRoot: root, timeoutMs: 10_000 });
    const result = await client.applyBinding({ requestId: crypto.randomUUID(), draftId: "d1", uiRuntimeProof: { orchestratorStopped: true } }).then((value) => ({ value }), (error) => ({ error }));
    assert.equal(result.value?.ok, undefined, `must not succeed: ${JSON.stringify(result.value)}`);
    assert.equal(result.error?.code, "BINDING_APPLY_UNCONFIGURED");
});
