'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const {
    executeDualBootstrap,
    assertLegacyBootstrapAdoptable,
    archiveLegacyBootstrapSession,
    collectLegacyBootstrapChanges,
    handleDualQc,
} = require('../lib/commands/dual');

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bootstrap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function validPlan() {
    return {
        schema_version: 1,
        plan_revision: 1,
        tasks: [{
            task_id: 'TASK-1', title: 'Implement feature', owner: 'codex',
            goal: 'Implement a bounded feature', category: 'frontend', complexity: 'small', risk: 'low',
            allowed_files: ['src/a.js'], context_files: ['.omni/sdlc/design-spec.md'],
            deny_patterns: [], validation_commands: [],
        }],
    };
}

function writePlan(root, plan = validPlan()) {
    const target = path.join(root, '.omni', 'sdlc', 'dual-plan.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return target;
}

test('bootstrap validates the typed full graph before setup or daemon side effects', async (t) => {
    const root = workspace(t);
    let setupCalls = 0;
    let sessionCalls = 0;
    await assert.rejects(
        () => executeDualBootstrap({ workspaceRoot: root }, {
            executeSetupManifest: () => { setupCalls++; },
            ensureDaemonSession: async () => { sessionCalls++; },
        }),
        (error) => error.code === 'DUAL_BOOTSTRAP_PLAN_MISSING',
    );
    assert.equal(setupCalls, 0);
    assert.equal(sessionCalls, 0);
});

test('bootstrap rejects multiple AGY slices before side effects because sessions use one immutable baseline', async (t) => {
    const root = workspace(t);
    const task = {
        task_id: 'AGY-1', title: 'Agy slice', owner: 'agy', goal: 'Implement slice',
        category: 'frontend', complexity: 'medium', risk: 'low',
        allowed_files: ['src/a.js'], context_files: [], deny_patterns: [],
        validation_commands: [{ program: 'npm', args: ['test'], cwd: '.' }],
    };
    writePlan(root, {
        schema_version: 1,
        plan_revision: 1,
        tasks: [task, { ...task, task_id: 'AGY-2', allowed_files: ['src/b.js'] }],
    });
    let sessionCalls = 0;
    await assert.rejects(() => executeDualBootstrap({ workspaceRoot: root }, {
        ensureDaemonSession: async () => { sessionCalls++; },
    }), (error) => error.code === 'DUAL_BOOTSTRAP_PLAN_INVALID');
    assert.equal(sessionCalls, 0);
});

test('bootstrap rejects setup and final-QC pseudo tasks because they belong to controller/gates', async (t) => {
    const root = workspace(t);
    const task = validPlan().tasks[0];
    writePlan(root, {
        schema_version: 1,
        plan_revision: 1,
        tasks: [{ ...task, category: 'qa', title: 'Final QC' }],
    });
    await assert.rejects(
        () => executeDualBootstrap({ workspaceRoot: root }),
        (error) => error.code === 'DUAL_BOOTSTRAP_PLAN_INVALID',
    );
});

test('bootstrap runs setup before session creation, registers the exact plan hash once, and resumes', async (t) => {
    const root = workspace(t);
    const planPath = writePlan(root);
    fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'setup.json'), '{"schema_version":1,"actions":[]}\n');
    const order = [];
    let registerPayload;
    const client = {
        status: async () => ({ state: 'DISCOVERED', plan: null, tasks: {}, leases: {}, gates: {} }),
        registerPlan: async (_sessionId, payload) => {
            order.push('register');
            registerPayload = payload;
            return { registered: true, state: 'EXECUTING' };
        },
        resumeSession: async () => { order.push('resume'); return { resumed: true, state: 'EXECUTING' }; },
    };
    const result = await executeDualBootstrap({ workspaceRoot: root }, {
        executeSetupManifest: () => { order.push('setup'); return { status: 'SUCCESS' }; },
        ensureDaemonSession: async () => {
            order.push('session');
            return { client, health: { session_id: 'session-1' } };
        },
    });
    assert.deepEqual(order, ['setup', 'session', 'register', 'resume']);
    assert.equal(registerPayload.plan_path, '.omni/sdlc/dual-plan.json');
    assert.equal(registerPayload.plan_sha256, crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex'));
    assert.deepEqual(registerPayload.tasks, validPlan().tasks);
    assert.equal(result.session_id, 'session-1');
});

test('bootstrap retry reuses an identical registered full graph without re-registering', async (t) => {
    const root = workspace(t);
    const planPath = writePlan(root);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex');
    let registerCalls = 0;
    let resumeCalls = 0;
    const client = {
        status: async () => ({
            state: 'EXECUTING',
            plan: { plan_path: '.omni/sdlc/dual-plan.json', plan_sha256: sha, total_tasks: 1 },
            tasks: { 'TASK-1': { task_id: 'TASK-1', state: 'ROUTED', owner: 'codex' } },
            leases: {}, gates: {},
        }),
        registerPlan: async () => { registerCalls++; },
        resumeSession: async () => { resumeCalls++; return { resumed: true, state: 'EXECUTING' }; },
    };
    const result = await executeDualBootstrap({ workspaceRoot: root }, {
        ensureDaemonSession: async () => ({ client, health: { session_id: 'session-1' } }),
    });
    assert.equal(registerCalls, 0);
    assert.equal(resumeCalls, 1);
    assert.equal(result.reused, true);
});

test('bootstrap fails before authority when typed setup mutates the full graph', async (t) => {
    const root = workspace(t);
    writePlan(root);
    fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'setup.json'), '{"schema_version":1,"actions":[]}\n');
    let sessionCalls = 0;
    await assert.rejects(() => executeDualBootstrap({ workspaceRoot: root }, {
        executeSetupManifest: () => {
            const changed = validPlan();
            changed.tasks[0].title = 'Mutated during setup';
            writePlan(root, changed);
            return { status: 'SUCCESS' };
        },
        ensureDaemonSession: async () => { sessionCalls++; },
    }), (error) => error.code === 'DUAL_BOOTSTRAP_PLAN_CHANGED');
    assert.equal(sessionCalls, 0);
});

test('legacy adoption permits only planning tasks and bounded setup/planning drift', () => {
    const status = {
        state: 'EXECUTING', receipt: null, blocked: null, gates: {}, leases: {},
        tasks: {
            bootstrap: {
                task_id: 'bootstrap', owner: 'codex', state: 'ROUTED',
                allowed_files: ['.omni/sdlc/setup.json', '.omni/sdlc/todo.md', 'docs/superpowers/plans/a.md'],
            },
        },
    };
    assert.doesNotThrow(() => assertLegacyBootstrapAdoptable(status, {
        setupReady: true,
        setupRequired: true,
        changedFiles: ['.omni/sdlc/setup.json', '.omni/sdlc/todo.md', 'package.json', 'package-lock.json'],
    }));
    assert.doesNotThrow(() => assertLegacyBootstrapAdoptable({ ...status, state: 'PLANNED' }, {
        setupReady: true,
        setupRequired: false,
        changedFiles: ['.agents/skills/design/SKILL.md', '.codex/skills/om-think/SKILL.md'],
    }));
    assert.throws(() => assertLegacyBootstrapAdoptable(status, {
        setupReady: true,
        setupRequired: true,
        changedFiles: ['src/App.tsx'],
    }), (error) => error.code === 'DUAL_BOOTSTRAP_ADOPTION_UNSAFE');
    assert.throws(() => assertLegacyBootstrapAdoptable({
        ...status,
        leases: { lease: { status: 'active' } },
    }, { setupReady: true, setupRequired: false, changedFiles: [] }), (error) => error.code === 'DUAL_BOOTSTRAP_ADOPTION_UNSAFE');
    assert.throws(() => assertLegacyBootstrapAdoptable(status, {
        setupReady: false,
        setupRequired: true,
        changedFiles: [],
    }), (error) => error.code === 'DUAL_BOOTSTRAP_ADOPTION_UNSAFE');
    assert.throws(() => assertLegacyBootstrapAdoptable(status, {
        setupReady: true,
        setupRequired: false,
        changedFiles: ['package.json'],
    }), (error) => error.code === 'DUAL_BOOTSTRAP_ADOPTION_UNSAFE');
});

test('legacy Git change collection returns normalized path strings', (t) => {
    const root = workspace(t);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Bootstrap Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'bootstrap@example.invalid'], { cwd: root });
    fs.writeFileSync(path.join(root, 'index.js'), 'initial\n', 'utf8');
    execFileSync('git', ['add', 'index.js'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    fs.mkdirSync(path.join(root, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'todo.md'), '# Plan\n', 'utf8');
    const changes = collectLegacyBootstrapChanges(root, {
        current_baseline: { kind: 'git', id: head },
    });
    assert.deepEqual(changes, ['.omni/sdlc/todo.md']);
    assert.equal(changes.every((entry) => typeof entry === 'string'), true);
});

test('legacy adoption restores the old ledger if fresh authority creation fails after archival', async (t) => {
    const root = workspace(t);
    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    fs.mkdirSync(authorityDir, { recursive: true });
    fs.writeFileSync(path.join(authorityDir, 'events.ndjson'), 'old-ledger\n', 'utf8');
    const status = {
        session_id: 'legacy-session', state: 'EXECUTING', receipt: null, blocked: null,
        gates: {}, leases: {}, tasks: {
            bootstrap: {
                owner: 'codex', state: 'ROUTED',
                allowed_files: ['.omni/sdlc/setup.json', '.omni/sdlc/todo.md'],
            },
        },
    };
    const client = {
        stop: async () => {},
        health: async () => { const error = new Error('stopped'); error.code = 'DUAL_DISCOVERY_MISSING'; throw error; },
    };
    await assert.rejects(() => archiveLegacyBootstrapSession(root, client, status, {
        evaluateSetupReadiness: () => ({ ready: true, required: true }),
        collectLegacyBootstrapChanges: () => ['package.json'],
        ensureDaemonSession: async () => {
            fs.mkdirSync(authorityDir, { recursive: true });
            fs.writeFileSync(path.join(authorityDir, 'events.ndjson'), 'partial-new-ledger\n', 'utf8');
            throw new Error('fresh start failed');
        },
    }), (error) => error.code === 'DUAL_RECOVERY_FAILED');
    assert.equal(fs.readFileSync(path.join(authorityDir, 'events.ndjson'), 'utf8'), 'old-ledger\n');
    const historyNames = fs.readdirSync(path.join(root, '.omni', 'runs', 'dual-history'));
    assert.ok(historyNames.some((name) => name.startsWith('recovery-failed-')));
});

test('handleDualQc handles non-running daemon fail-closed in JSON mode', async (t) => {
    const root = workspace(t);
    let capturedLog = '';
    const origLog = console.log;
    const origExitCode = process.exitCode;
    console.log = (msg) => { capturedLog += msg; };
    try {
        await handleDualQc(undefined, { cwd: root, json: true });
    } finally {
        console.log = origLog;
        process.exitCode = origExitCode;
    }
    const parsed = JSON.parse(capturedLog);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_DAEMON_NOT_RUNNING');
});
