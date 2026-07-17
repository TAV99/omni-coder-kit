'use strict';

// Loop hardening: no-progress escalation + empty-task guard
// (docs/SPEC-FIX-GATE-SCOPE-AND-FIXLOOP.md FIX 3 & FIX 4 / §5).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runHarness } = require('../lib/harness/loop');
const { readEvents } = require('../lib/harness/events');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-fixloop-')); }
function writeTodo(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), body, 'utf-8');
}

describe('FIX 3 — no-progress escalates to BLOCKED (not wallclock)', () => {
    test('same gate failure surviving fixes → BLOCKED within maxFixAttempts rounds', async () => {
        const dir = tmp();
        writeTodo(dir, '- [ ] flaky task\n');
        // P0 always fails, fix (dry-run) changes nothing → no progress, ever.
        const stuckGate = () => ({
            passed: false, failures: ['P0'],
            results: [{ id: 'P0', name: 'security', status: 'fail', output: 'src/app.js: dangerous pattern innerHTML (XSS risk)' }],
        });
        const final = await runHarness(dir, {
            from: 'CHECK', provider: 'dry-run', runPipeline: stuckGate,
            budget: { maxFixAttempts: 3, maxIterations: 60, maxWallclockMs: 30 * 60 * 1000 },
        });

        assert.equal(final.state, 'BLOCKED');
        assert.equal(final.status, 'blocked');

        const evs = readEvents(dir);
        // Escalated via no-progress, NOT iteration/wallclock budget.
        assert.ok(!evs.some((e) => e.type === 'pause'), 'should not pause on budget');
        assert.ok(evs.some((e) => e.type === 'fix-attempt'), 'emits fix-attempt');

        // At most maxFixAttempts fix steps were spent before giving up.
        const fixSteps = evs.filter((e) => e.type === 'step-start' && e.step === 'fix').length;
        assert.ok(fixSteps <= 3, `fix steps ${fixSteps} should be <= 3`);

        // BLOCKED reason names the gate AND the offending file.
        const blocked = evs.find((e) => e.type === 'blocked');
        assert.match(blocked.reason, /P0/);
        assert.match(blocked.reason, /src\/app\.js/);
    });

    test('a changing failure set resets no-progress (keeps trying)', async () => {
        const dir = tmp();
        writeTodo(dir, '- [ ] task\n');
        // Alternate failing gate each call → never "no progress"; the existing
        // fixAttempts cap (not no-progress) is what eventually stops it.
        let n = 0;
        const alternating = () => {
            n++;
            return { passed: false, failures: [n % 2 ? 'P0' : 'P1'], results: [] };
        };
        const final = await runHarness(dir, {
            from: 'CHECK', provider: 'dry-run', runPipeline: alternating,
            budget: { maxFixAttempts: 2 },
        });
        // Still terminates (fixAttempts backstop), just not via no-progress.
        assert.equal(final.status, 'blocked');
        const noProg = readEvents(dir).filter((e) => e.type === 'fix-attempt').map((e) => e.noProgress);
        assert.ok(noProg.every((v) => v === 0), `noProgress stayed 0: ${noProg}`);
    });
});

describe('FIX 4 — empty-task guard stops early', () => {
    test('COOK with empty todo.md → BLOCKED immediately, no CHECK/FIX churn', async () => {
        const dir = tmp();
        writeTodo(dir, '\n'); // todo.md exists but has 0 tasks
        let gateCalls = 0;
        const countingGate = () => { gateCalls++; return { passed: true, results: [], failures: [] }; };
        const final = await runHarness(dir, {
            from: 'COOK', provider: 'dry-run', runPipeline: countingGate,
        });
        assert.equal(final.state, 'BLOCKED');
        assert.equal(final.status, 'blocked');
        assert.equal(gateCalls, 0, 'must not run the gate when there are no tasks');

        const evs = readEvents(dir);
        const blocked = evs.find((e) => e.type === 'blocked');
        assert.match(blocked.reason, /Chưa có task/);
        // Never entered the cook/check/fix churn.
        assert.ok(!evs.some((e) => e.type === 'step-start' && e.step === 'cook'));
    });

    test('missing todo.md entirely → BLOCKED with guidance', async () => {
        const dir = tmp(); // no .omni/sdlc/todo.md at all
        const final = await runHarness(dir, { from: 'COOK', provider: 'dry-run', runPipeline: () => ({ passed: true, results: [], failures: [] }) });
        assert.equal(final.status, 'blocked');
        assert.match(readEvents(dir).find((e) => e.type === 'blocked').reason, /om-plan|--spec/);
    });
});
