'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tasks = require('../lib/harness/tasks');
const shell = require('../lib/harness/tools/shell');
const buildTest = require('../lib/harness/tools/build-test');
const { runPipeline } = require('../lib/harness/gates/pipeline');
const { runHarness } = require('../lib/harness/loop');
const { loadState } = require('../lib/harness/state');
const { readEvents } = require('../lib/harness/events');

function tmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-p1-'));
}
function writeTodo(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), body, 'utf-8');
}

// --- tasks.js --------------------------------------------------------------

test('tasks.parseTodo counts done / todo / blocked', () => {
    const dir = tmpProject();
    writeTodo(dir, [
        '# Todo',
        '- [x] task 1 done',
        '- [x] task 2 done',
        '- [ ] task 3 pending',
        '- [ ] [BLOCKED] task 4 stuck',
        'not a task line',
    ].join('\n'));
    const t = tasks.parseTodo(dir);
    assert.strictEqual(t.total, 4);
    assert.strictEqual(t.completed, 2);
    assert.strictEqual(t.blocked, 1);
    assert.strictEqual(t.remaining, 2);
});

test('tasks.parseTodo on missing file → zeros', () => {
    assert.deepStrictEqual(tasks.parseTodo(tmpProject()), { total: 0, completed: 0, blocked: 0, remaining: 0 });
});

test('tasks.computeCheckpoint = max(1, ceil(total/3))', () => {
    assert.strictEqual(tasks.computeCheckpoint(12), 4);
    assert.strictEqual(tasks.computeCheckpoint(1), 1);
    assert.strictEqual(tasks.computeCheckpoint(0), 1);
    assert.strictEqual(tasks.computeCheckpoint(10), 4);
});

// --- tools/shell.js --------------------------------------------------------

test('shell.isDenied blocks destructive commands, allows safe ones', () => {
    assert.ok(shell.isDenied('rm -rf /'));
    assert.ok(shell.isDenied('git push --force origin main'));
    assert.ok(shell.isDenied('git reset --hard HEAD~3'));
    assert.ok(shell.isDenied(':(){ :|:& };:'));
    assert.ok(!shell.isDenied('npm test'));
    assert.ok(!shell.isDenied('npm run build'));
    assert.ok(!shell.isDenied('claude -p "do the thing" --permission-mode acceptEdits'));
});

test('shell.runCommand throws on denied command (never executes)', () => {
    assert.throws(() => shell.runCommand('rm -rf /'), /deny-list/);
});

test('shell.runCommand runs a real harmless command', () => {
    const r = shell.runCommand('echo hello-harness');
    assert.strictEqual(r.exitCode, 0);
    assert.match(r.stdout, /hello-harness/);
    assert.strictEqual(r.timedOut, false);
});

// --- tools/build-test.js ---------------------------------------------------

test('build-test.detectCommands reads package.json scripts', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest', lint: 'eslint .' },
    }), 'utf-8');
    assert.deepStrictEqual(buildTest.detectCommands(dir), {
        dev: 'npm run dev', build: 'npm run build', test: 'npm test', lint: 'npm run lint',
    });
});

test('build-test.detectCommands on empty project → all null', () => {
    assert.deepStrictEqual(buildTest.detectCommands(tmpProject()), { dev: null, build: null, test: null, lint: null });
});

test('build-test.runGateCommand skips when no command', () => {
    const r = buildTest.runGateCommand(tmpProject(), 'test');
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.passed, true);
});

test('build-test.runGateCommand passes through injected runner', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf-8');
    const fakeRunner = () => ({ exitCode: 1, stdout: 'boom', stderr: '', timedOut: false });
    const r = buildTest.runGateCommand(dir, 'test', { runner: fakeRunner });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /boom/);
});

// --- gates/pipeline.js -----------------------------------------------------

// Isolate the P1–P3 build-test gates by injecting no-op P0/P4/P5 handlers.
const skipHandlers = {
    runSecurity: () => ({ ran: false, passed: true, output: '' }),
    runBundle: () => ({ ran: false, passed: true, output: '' }),
    runContent: () => ({ ran: false, passed: true, output: '', severity: null }),
};

test('gates.runPipeline: P3 fail → passed:false, failures:[P3]', () => {
    const fakeGate = (_dir, kind) => kind === 'test'
        ? { ran: true, passed: false, output: '1 failing', durationMs: 5 }
        : { ran: true, passed: true, output: 'ok', durationMs: 5 };
    const res = runPipeline('/x', { runGate: fakeGate, ...skipHandlers });
    assert.strictEqual(res.passed, false);
    assert.deepStrictEqual(res.failures, ['P3']);
    assert.strictEqual(res.results.find((r) => r.id === 'P0').status, 'skipped');
});

test('gates.runPipeline: all gates skipped (no commands) → passed:true', () => {
    const fakeGate = () => ({ ran: false, passed: true, output: 'no command', durationMs: 0 });
    const res = runPipeline('/x', { runGate: fakeGate, ...skipHandlers });
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.failures.length, 0);
    assert.ok(res.results.every((r) => r.status === 'skipped'));
});

// --- 2a: full P0/P4/P5 gates ----------------------------------------------

test('gates.runPipeline: P0 security fail (handler) → blocks', () => {
    const fakeGate = () => ({ ran: false, passed: true, output: '' });
    const res = runPipeline('/x', {
        runGate: fakeGate,
        runSecurity: () => ({ ran: true, passed: false, output: 'secret committed' }),
        runBundle: skipHandlers.runBundle,
        runContent: skipHandlers.runContent,
    });
    assert.strictEqual(res.passed, false);
    assert.ok(res.failures.includes('P0'));
});

test('gates.runPipeline: P4 bundle over threshold → advisory, NOT a failure', () => {
    const fakeGate = () => ({ ran: false, passed: true, output: '' });
    const res = runPipeline('/x', {
        runGate: fakeGate,
        runSecurity: skipHandlers.runSecurity,
        runBundle: () => ({ ran: true, passed: false, output: 'bundle 9 MB' }),
        runContent: skipHandlers.runContent,
    });
    assert.strictEqual(res.passed, true, 'advisory P4 must not block');
    assert.ok(!res.failures.includes('P4'));
    assert.strictEqual(res.results.find((r) => r.id === 'P4').status, 'advisory');
});

test('gates.runPipeline: P5 content HIGH → blocks; LOW → advisory', () => {
    const fakeGate = () => ({ ran: false, passed: true, output: '' });
    const high = runPipeline('/x', {
        runGate: fakeGate, runSecurity: skipHandlers.runSecurity, runBundle: skipHandlers.runBundle,
        runContent: () => ({ ran: true, passed: false, output: 'forbidden', severity: 'HIGH' }),
    });
    assert.strictEqual(high.passed, false);
    assert.ok(high.failures.includes('P5'));

    const low = runPipeline('/x', {
        runGate: fakeGate, runSecurity: skipHandlers.runSecurity, runBundle: skipHandlers.runBundle,
        runContent: () => ({ ran: true, passed: true, output: 'placeholder', severity: 'LOW' }),
    });
    assert.strictEqual(low.passed, true);
    assert.ok(!low.failures.includes('P5'));
});

test('gates.runPipeline: --only filters by id', () => {
    const fakeGate = () => ({ ran: true, passed: true, output: 'ok', durationMs: 1 });
    const res = runPipeline('/x', { only: 'P3', runGate: fakeGate });
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].id, 'P3');
});

// --- live loop (dry-run provider, no real agent/shell) ---------------------

const passGate = () => ({ passed: true, results: [], failures: [] });
const failGate = () => ({ passed: false, results: [], failures: ['P3'] });

test('loop live: all tasks done → reaches DOC and PAUSES before SHIP', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] a\n- [x] b\n');
    const final = await runHarness(dir, { from: 'COOK', provider: 'dry-run', runPipeline: passGate });
    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused');
    // persisted + paused event recorded
    assert.strictEqual(loadState(dir).state, 'DOC');
    assert.ok(readEvents(dir).some((e) => e.type === 'pause' && /SHIP/i.test(e.reason)));
});

test('loop live: --yes-ship carries through SHIP to DONE (no auto-deploy)', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] a\n');
    const final = await runHarness(dir, { from: 'COOK', provider: 'dry-run', yesShip: true, runPipeline: passGate });
    assert.strictEqual(final.state, 'DONE');
    assert.strictEqual(final.status, 'done');
    const states = readEvents(dir).filter((e) => e.type === 'transition').map((e) => e.to);
    assert.ok(states.includes('SHIP') && states.includes('DONE'));
});

test('loop live: gate fail → FIX, exhaust attempts → BLOCKED (task marked)', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [ ] flaky task\n');
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: failGate, budget: { maxFixAttempts: 1 },
    });
    assert.strictEqual(final.state, 'BLOCKED');
    assert.strictEqual(final.status, 'blocked');
    assert.ok(readEvents(dir).some((e) => e.type === 'blocked'));
    // the actionable task got tagged [BLOCKED] in todo.md
    assert.strictEqual(tasks.parseTodo(dir).blocked, 1);
});

test('loop live: budget cuts an otherwise-infinite COOK (no-op provider) → paused', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [ ] never finishes with dry-run provider\n');
    const final = await runHarness(dir, { from: 'COOK', provider: 'dry-run', runPipeline: passGate, budget: { maxIterations: 5 } });
    assert.strictEqual(final.status, 'paused');
    assert.ok(readEvents(dir).some((e) => e.type === 'pause' && /iterations/.test(e.reason)));
});

test('loop live: old startedAt in state does not trigger wallclock insta-pause', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] task done\n');
    
    // Create state with an old startedAt (e.g. 2 hours ago)
    const { createState, saveState } = require('../lib/harness/state');
    const state = createState({ provider: 'dry-run', from: 'COOK' });
    state.startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveState(dir, state);

    // Run harness. It should complete without immediately pausing because elapsedMs is measured relative to runStartedAt.
    const final = await runHarness(dir, {
        provider: 'dry-run',
        runPipeline: passGate
    });

    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused'); // Pauses before SHIP as expected, not because of wallclock budget.
    const events = readEvents(dir);
    const wallclockPause = events.some((e) => e.type === 'pause' && /thời gian|wallclock/i.test(e.reason));
    assert.ok(!wallclockPause, 'should not pause due to wallclock budget');
});

test('loop live: budget overrides maxWallclockMs are respected', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [ ] incomplete task\n');

    // Limit budget to 1ms maxWallclockMs
    const final = await runHarness(dir, {
        from: 'COOK',
        provider: 'dry-run',
        runPipeline: passGate,
        budget: { maxWallclockMs: 1 }
    });

    assert.strictEqual(final.status, 'paused');
    const events = readEvents(dir);
    const wallclockPause = events.some((e) => e.type === 'pause' && /thời gian|wallclock/i.test(e.reason));
    assert.ok(wallclockPause, 'should pause due to wallclock budget');
});

test('loop live: resume multiple times resets wallclock window each time', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] a\n'); // task already done

    // First run: from COOK, goes to DOC and pauses awaiting approval
    const final = await runHarness(dir, {
        from: 'COOK',
        provider: 'dry-run',
        runPipeline: passGate,
        budget: { maxWallclockMs: 10000 }
    });
    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused');

    // Simulate 2 hours elapsed since the first run started
    const { saveState } = require('../lib/harness/state');
    final.startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveState(dir, final);

    // Second run (resume): should also not pause immediately on start
    const final2 = await runHarness(dir, {
        provider: 'dry-run',
        runPipeline: passGate,
        budget: { maxWallclockMs: 10000 }
    });
    assert.strictEqual(final2.state, 'DOC');
    assert.strictEqual(final2.status, 'paused');
    
    const events = readEvents(dir);
    const wallclockPause = events.some((e) => e.type === 'pause' && /thời gian|wallclock/i.test(e.reason));
    assert.ok(!wallclockPause, 'should not pause due to wallclock budget on resume');
});

test('cli run.js maps --max-time and --step-timeout in handleRun and handleAccept', async (t) => {
    const loopModule = require('../lib/harness/loop');
    
    const mute = () => {
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};
        return {
            restore() { console.log = origLog; console.error = origErr; }
        };
    };

    let passedOpts = [];
    t.mock.method(loopModule, 'runHarness', async (projectDir, opts) => {
        passedOpts.push(opts);
        return { status: 'done', state: 'DONE' };
    });

    // Delete run command cache to ensure it loads the mocked loopModule exports
    delete require.cache[require.resolve('../lib/commands/run')];
    const runCmd = require('../lib/commands/run');

    const m = mute();
    try {
        await runCmd.handleRun({ maxTime: '5', stepTimeout: '2', provider: 'dry-run', dryRun: false });
        await runCmd.handleAccept({ maxTime: '10', stepTimeout: '4', accept: 'host-cli:claudecode' });
        // Test when maxTime is omitted but stepTimeout is provided -> defaults to stepTimeout * 3
        await runCmd.handleRun({ stepTimeout: '10', provider: 'dry-run', dryRun: false });
        await runCmd.handleAccept({ stepTimeout: '5', accept: 'host-cli:claudecode' });
    } finally {
        m.restore();
    }

    assert.strictEqual(passedOpts.length, 4);
    assert.deepStrictEqual(passedOpts[0].budget, { maxWallclockMs: 300000 });
    assert.strictEqual(passedOpts[0].stepTimeoutMs, 120000);
    assert.deepStrictEqual(passedOpts[1].budget, { maxWallclockMs: 600000 });
    assert.strictEqual(passedOpts[1].stepTimeoutMs, 240000);

    // 10m * 3 = 30m -> 1,800,000 ms
    assert.deepStrictEqual(passedOpts[2].budget, { maxWallclockMs: 1800000 });
    assert.strictEqual(passedOpts[2].stepTimeoutMs, 600000);
    // 5m * 3 = 15m -> 900,000 ms
    assert.deepStrictEqual(passedOpts[3].budget, { maxWallclockMs: 900000 });
    assert.strictEqual(passedOpts[3].stepTimeoutMs, 300000);
});

test('loop live: consecutive timeouts trigger BLOCKED early', async (t) => {
    const providers = require('../lib/harness/providers');
    const originalGetProvider = providers.getProvider;
    
    t.mock.method(providers, 'getProvider', (name, opts) => {
        if (name === 'timeout-provider') {
            return {
                name: 'timeout-provider',
                async runStep(step, ctx) {
                    return {
                        ok: false,
                        exitCode: 124,
                        summary: `timeout-provider timed out`,
                        durationMs: 50,
                        timedOut: true,
                        timeoutMs: opts.timeoutMs || 600000,
                    };
                }
            };
        }
        return originalGetProvider(name, opts);
    });

    // Reload loop module to bind the mocked getProvider
    delete require.cache[require.resolve('../lib/harness/loop')];
    const { runHarness } = require('../lib/harness/loop');

    const dir = tmpProject();
    writeTodo(dir, '- [ ] timeout task\n');

    const final = await runHarness(dir, {
        from: 'COOK',
        provider: 'timeout-provider',
        runPipeline: passGate,
        budget: { maxConsecutiveTimeouts: 2 }
    });

    assert.strictEqual(final.state, 'BLOCKED');
    assert.strictEqual(final.status, 'blocked');
    assert.strictEqual(final.consecutiveTimeouts, 2);

    const events = readEvents(dir);
    const blockedEvent = events.find((e) => e.type === 'blocked');
    assert.ok(blockedEvent);
    assert.match(blockedEvent.reason, /timeout 2 lần liên tiếp/i);
});

test('loop live: successful step resets consecutiveTimeouts', async (t) => {
    const providers = require('../lib/harness/providers');
    const originalGetProvider = providers.getProvider;
    
    let callCount = 0;
    t.mock.method(providers, 'getProvider', (name, opts) => {
        if (name === 'mixed-provider') {
            return {
                name: 'mixed-provider',
                async runStep(step, ctx) {
                    callCount++;
                    if (callCount === 1) {
                        return { ok: false, exitCode: 124, summary: `timed out`, durationMs: 10, timedOut: true, timeoutMs: 600000 };
                    }
                    return { ok: true, exitCode: 0, summary: `success`, durationMs: 10 };
                }
            };
        }
        return originalGetProvider(name, opts);
    });

    delete require.cache[require.resolve('../lib/harness/loop')];
    const { runHarness } = require('../lib/harness/loop');

    const dir = tmpProject();
    writeTodo(dir, '- [ ] task 1\n- [ ] task 2\n');

    const final = await runHarness(dir, {
        from: 'COOK',
        provider: 'mixed-provider',
        runPipeline: passGate,
        budget: { maxConsecutiveTimeouts: 2, maxIterations: 3 }
    });

    assert.strictEqual(final.state, 'COOK');
    assert.strictEqual(final.status, 'paused');
    assert.strictEqual(final.consecutiveTimeouts, 0);
});

test('loop: freshStart: true overrides saved BLOCKED state', async () => {
    const { saveState } = require('../lib/harness/state');
    const { runHarness } = require('../lib/harness/loop');

    const dir = tmpProject();
    
    // Save a state as BLOCKED
    const blockedState = {
        state: 'BLOCKED',
        status: 'blocked',
        provider: 'dry-run',
        fixAttempts: 3,
        consecutiveTimeouts: 2,
        cycle: 2,
    };
    saveState(dir, blockedState);

    // runHarness with freshStart: true and from: CHECK
    const final = await runHarness(dir, {
        from: 'CHECK',
        freshStart: true,
        provider: 'dry-run',
        runPipeline: passGate,
    });

    // It should have overwritten state to CHECK, then run (plan to ACCEPTANCE -> DOC -> paused)
    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused');
    assert.strictEqual(final.fixAttempts, 0);
    assert.strictEqual(final.consecutiveTimeouts, 0);
    assert.strictEqual(final.cycle, 1);
});

test('loop: freshStart: false (default) loads saved state and recovers from BLOCKED', async () => {
    const { saveState } = require('../lib/harness/state');
    const { runHarness } = require('../lib/harness/loop');

    const dir = tmpProject();
    
    // Save a state as BLOCKED
    const blockedState = {
        state: 'BLOCKED',
        status: 'blocked',
        provider: 'dry-run',
        fixAttempts: 3,
        consecutiveTimeouts: 2,
        cycle: 2,
    };
    saveState(dir, blockedState);

    // runHarness with freshStart: false, should load BLOCKED state and recover
    // to CHECK (new behavior: BLOCKED → CHECK with counter reset).
    const final = await runHarness(dir, {
        from: 'CHECK',
        freshStart: false,
        provider: 'dry-run',
        runPipeline: passGate,
    });

    // After recovery: BLOCKED → CHECK (pass) → ACCEPTANCE (no reqs) → DOC → paused
    assert.notStrictEqual(final.state, 'BLOCKED', 'should have recovered from BLOCKED');
    assert.strictEqual(final.fixAttempts, 0, 'fixAttempts should be reset on recovery');
    assert.strictEqual(final.consecutiveTimeouts, 0, 'timeouts should be reset on recovery');
});

test('cli run.js sets freshStart properly based on from and resume options', async (t) => {
    const loopModule = require('../lib/harness/loop');
    
    const mute = () => {
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};
        return {
            restore() { console.log = origLog; console.error = origErr; }
        };
    };

    let passedOpts = [];
    t.mock.method(loopModule, 'runHarness', async (projectDir, opts) => {
        passedOpts.push(opts);
        return { status: 'done', state: 'DONE' };
    });

    delete require.cache[require.resolve('../lib/commands/run')];
    const runCmd = require('../lib/commands/run');

    const m = mute();
    try {
        // 1. from without resume -> freshStart: true
        await runCmd.handleRun({ from: 'CHECK', provider: 'dry-run', dryRun: false });
        // 2. resume only -> freshStart: false
        await runCmd.handleRun({ resume: true, provider: 'dry-run', dryRun: false });
        // 3. both from and resume -> freshStart: false
        await runCmd.handleRun({ from: 'CHECK', resume: true, provider: 'dry-run', dryRun: false });
    } finally {
        m.restore();
    }

    assert.strictEqual(passedOpts.length, 3);
    assert.strictEqual(passedOpts[0].freshStart, true);
    assert.strictEqual(passedOpts[1].freshStart, false);
    assert.strictEqual(passedOpts[2].freshStart, false);
});
