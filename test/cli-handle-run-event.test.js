'use strict';

// SPEC-HEARTBEAT-SPINNER.md §5 — handleRunEvent (spinner-driven).
// A fake spinner records every call so we can assert which events are
// suppressed vs. surfaced via stopAndLog/setLabel/stop.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleRunEvent, createRunEventCtx } = require('../lib/commands/run');

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omni-hrun-'));

function fakeSpinner() {
    const calls = [];
    let active = true;
    return {
        calls,
        setLabel: (text) => calls.push(['setLabel', String(text)]),
        stopAndLog: (line) => { calls.push(['stopAndLog', strip(String(line))]); active = false; },
        resume: () => { calls.push(['resume']); active = true; },
        stop: () => { calls.push(['stop']); active = false; },
        isActive: () => active,
    };
}

// Capture console.log for spinner-less paths.
function captureConsole(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(strip(a.join(' ')));
    try { fn(); } finally { console.log = orig; }
    return lines.join('\n');
}

describe('handleRunEvent — suppressed events (spinner path)', () => {
    test('transition (non-milestone) → only setLabel, no stopAndLog/stop', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'transition', from: 'COOK', to: 'CHECK' }, sp, ctx);
        assert.deepEqual(sp.calls, [['setLabel', 'CHECK']]);
    });

    test('gate passed → no stopAndLog', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'gate', passed: true }, sp, ctx);
        assert.deepEqual(sp.calls, []);
    });

    test('provider → no stopAndLog', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'provider', exitCode: 0, durationMs: 100 }, sp, ctx);
        assert.deepEqual(sp.calls, []);
    });

    test('heartbeat → completely silent (no spinner ops)', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'heartbeat', sec: 10 }, sp, ctx);
        assert.deepEqual(sp.calls, []);
    });

    test('fanout/fix-attempt/usage/learn/intake → silent', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        for (const t of ['fanout', 'fix-attempt', 'usage', 'learn', 'intake', 'budget', 'debate']) {
            handleRunEvent({ type: t }, sp, ctx);
        }
        assert.deepEqual(sp.calls, []);
    });
});

describe('handleRunEvent — surfaced events', () => {
    test('step-start updates spinner label with state + task k/n + desc', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'step-start', state: 'COOK', taskIdx: 2, total: 5, desc: 'thêm hàm sub()', ide: 'antigravity' }, sp, ctx);
        const labels = sp.calls.filter((c) => c[0] === 'setLabel');
        assert.equal(labels.length, 1);
        assert.match(labels[0][1], /COOK · task 2\/5 "thêm hàm sub\(\)"/);
        assert.equal(ctx.lastTaskDesc, 'thêm hàm sub()');
    });

    test('COOK step-end ok + todo completed grows → stopAndLog "→ tiếp:" + resume', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
        // Initial: 1 completed, ctx baseline = 1.
        fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'),
            '- [x] a\n- [ ] b\n- [ ] c\n', 'utf-8');
        const ctx = createRunEventCtx(dir);
        assert.equal(ctx.prevCompleted, 1);

        const sp = fakeSpinner();
        // Agent starts task b.
        handleRunEvent({ type: 'step-start', state: 'COOK', taskIdx: 2, total: 3, desc: 'b' }, sp, ctx);
        // Simulate agent ticking off b.
        fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'),
            '- [x] a\n- [x] b\n- [ ] c\n', 'utf-8');
        handleRunEvent({ type: 'step-end', state: 'COOK', exitCode: 0 }, sp, ctx);

        const stops = sp.calls.filter((c) => c[0] === 'stopAndLog');
        assert.equal(stops.length, 1);
        assert.match(stops[0][1], /✓ b xong → tiếp: c/);
        assert.ok(sp.calls.some((c) => c[0] === 'resume'));
        assert.equal(ctx.prevCompleted, 2);
    });

    test('COOK step-end ok WITHOUT todo growth → silent (still mid-task)', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'),
            '- [ ] a\n- [ ] b\n', 'utf-8');
        const ctx = createRunEventCtx(dir);

        const sp = fakeSpinner();
        handleRunEvent({ type: 'step-start', state: 'COOK', taskIdx: 1, total: 2, desc: 'a' }, sp, ctx);
        handleRunEvent({ type: 'step-end', state: 'COOK', exitCode: 0 }, sp, ctx);

        const stops = sp.calls.filter((c) => c[0] === 'stopAndLog');
        assert.equal(stops.length, 0, 'no task-done line until completed count grows');
    });

    test('step-end exit≠0 → stopAndLog with exit + stderr; spinner resumes', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'step-end', state: 'CHECK', sec: 12, exitCode: 1, stderrTail: '● sub() should subtract\n' }, sp, ctx);
        const stops = sp.calls.filter((c) => c[0] === 'stopAndLog');
        assert.equal(stops.length, 1);
        assert.match(stops[0][1], /✗ CHECK exit=1/);
        assert.match(stops[0][1], /should subtract/);
        assert.ok(sp.calls.some((c) => c[0] === 'resume'));
    });

    test('step-end timedOut → stopAndLog with timeout banner; spinner resumes', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'step-end', state: 'COOK', sec: 600, timedOut: true, timeoutMs: 600000 }, sp, ctx);
        const stops = sp.calls.filter((c) => c[0] === 'stopAndLog');
        assert.equal(stops.length, 1);
        assert.match(stops[0][1], /⏱ COOK timeout/);
        assert.ok(sp.calls.some((c) => c[0] === 'resume'));
    });

    test('gate passed=false → stopAndLog "gate FAIL"; spinner resumes', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        const out = captureConsole(() => {
            handleRunEvent({ type: 'gate', passed: false, failures: ['P3', 'P5'] }, sp, ctx);
        });
        const stops = sp.calls.filter((c) => c[0] === 'stopAndLog');
        assert.equal(stops.length, 1);
        assert.match(stops[0][1], /gate FAIL P3,P5/);
        assert.equal(out, '');
    });

    test('blocked → spinner.stop + reason printed (no resume)', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        const out = captureConsole(() => {
            handleRunEvent({ type: 'blocked', reason: 'gate stuck' }, sp, ctx);
        });
        assert.ok(sp.calls.some((c) => c[0] === 'stop'));
        assert.ok(!sp.calls.some((c) => c[0] === 'resume'));
        assert.match(out, /⛔ BLOCKED — gate stuck/);
        assert.match(out, /omni run --resume/);
    });

    test('pause → spinner.stop + reason printed', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        const out = captureConsole(() => {
            handleRunEvent({ type: 'pause', reason: 'wallclock' }, sp, ctx);
        });
        assert.ok(sp.calls.some((c) => c[0] === 'stop'));
        assert.match(out, /⏸  PAUSE — wallclock/);
        assert.match(out, /omni run --resume/);
    });

    test('acceptance allMet=true → silent; allMet=false → stopAndLog with unmet ids', () => {
        const ctx = createRunEventCtx(tmp());
        const sp1 = fakeSpinner();
        handleRunEvent({ type: 'acceptance', allMet: true, met: 3, total: 3, failed: [] }, sp1, ctx);
        assert.equal(sp1.calls.length, 0);

        const sp2 = fakeSpinner();
        handleRunEvent({ type: 'acceptance', allMet: false, met: 2, total: 3, failed: ['R3'] }, sp2, ctx);
        const s = sp2.calls.find((c) => c[0] === 'stopAndLog');
        assert.ok(s);
        assert.match(s[1], /requirements: 2\/3 đạt/);
        assert.match(s[1], /chưa đạt: R3/);
    });

    test('transition to ACCEPTANCE/DOC/SHIP → milestone line via stopAndLog + setLabel', () => {
        for (const to of ['ACCEPTANCE', 'DOC', 'SHIP']) {
            const sp = fakeSpinner();
            const ctx = createRunEventCtx(tmp());
            handleRunEvent({ type: 'transition', from: 'COOK', to }, sp, ctx);
            const stops = sp.calls.filter((c) => c[0] === 'stopAndLog');
            assert.equal(stops.length, 1, `to=${to}`);
            assert.match(stops[0][1], new RegExp(`Chuyển sang ${to}`));
            assert.deepEqual(sp.calls[0], ['setLabel', to]);
        }
    });

    test('done → spinner.stop, no summary line (summary owned by handleRun)', () => {
        const sp = fakeSpinner();
        const ctx = createRunEventCtx(tmp());
        handleRunEvent({ type: 'done', state: 'DONE' }, sp, ctx);
        assert.deepEqual(sp.calls, [['stop']]);
    });
});

describe('handleRunEvent — non-spinner fallback (--stream / --no-progress / non-TTY)', () => {
    test('errors and task-done are still printed via console.log', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), '- [ ] a\n- [ ] b\n', 'utf-8');
        const ctx = createRunEventCtx(dir);

        const out = captureConsole(() => {
            // step-start sets desc context.
            handleRunEvent({ type: 'step-start', state: 'COOK', taskIdx: 1, total: 2, desc: 'a' }, null, ctx);
            // Agent completes a.
            fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), '- [x] a\n- [ ] b\n', 'utf-8');
            handleRunEvent({ type: 'step-end', state: 'COOK', exitCode: 0 }, null, ctx);
            handleRunEvent({ type: 'step-end', state: 'CHECK', sec: 3, exitCode: 1 }, null, ctx);
        });
        assert.match(out, /✓ a xong → tiếp: b/);
        assert.match(out, /✗ CHECK exit=1/);
    });

    test('transitions / heartbeat / provider stay silent', () => {
        const ctx = createRunEventCtx(tmp());
        const out = captureConsole(() => {
            handleRunEvent({ type: 'transition', from: 'COOK', to: 'CHECK' }, null, ctx);
            handleRunEvent({ type: 'heartbeat', sec: 30 }, null, ctx);
            handleRunEvent({ type: 'provider', exitCode: 0, durationMs: 200 }, null, ctx);
            handleRunEvent({ type: 'gate', passed: true }, null, ctx);
        });
        assert.equal(out, '');
    });
});
