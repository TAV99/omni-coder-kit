'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('../lib/harness/state');
const events = require('../lib/harness/events');
const budget = require('../lib/harness/budget');
const loop = require('../lib/harness/loop');

function tmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-harness-'));
}

// --- state machine ---------------------------------------------------------

test('state: PIPELINE is a happy path INIT…DONE including SHIP', () => {
    assert.strictEqual(state.PIPELINE[0], 'INIT');
    assert.strictEqual(state.PIPELINE[state.PIPELINE.length - 1], 'DONE');
    assert.ok(state.PIPELINE.includes('SHIP'), 'SHIP phase phải có trong pipeline');
    // DOC ngay trước SHIP, SHIP ngay trước DONE (khớp superpower-sdlc)
    assert.deepStrictEqual(state.PIPELINE.slice(-3), ['DOC', 'SHIP', 'DONE']);
});

test('state: canTransition enforces the graph', () => {
    assert.ok(state.canTransition('INIT', 'BRAINSTORM'));
    assert.ok(state.canTransition('CHECK', 'FIX'));
    assert.ok(state.canTransition('CHECK', 'ACCEPTANCE'));
    assert.ok(!state.canTransition('CHECK', 'DOC'), 'CHECK → DOC phải đi qua ACCEPTANCE (Phase-4)');
    assert.ok(state.canTransition('ACCEPTANCE', 'DOC'));
    assert.ok(state.canTransition('ACCEPTANCE', 'COOK'));
    assert.ok(state.canTransition('ACCEPTANCE', 'FIX'));
    assert.ok(state.canTransition('DOC', 'SHIP'));
    assert.ok(!state.canTransition('INIT', 'DONE'), 'không được nhảy cóc');
    assert.ok(!state.canTransition('DONE', 'COOK'), 'DONE là terminal');
    assert.ok(!state.canTransition('FOO', 'BAR'), 'state lạ → false');
});

test('state: every active state can escalate to BLOCKED', () => {
    for (const s of state.STATES) {
        if (s === 'DONE' || s === 'BLOCKED') continue;
        assert.ok(state.canTransition(s, 'BLOCKED'), `${s} phải escalate được tới BLOCKED`);
    }
});

test('state: transition advances + bumps cycle/fixAttempts', () => {
    const s0 = state.createState({ from: 'CHECK' });
    const toFix = state.transition(s0, 'FIX', { reason: 'P3 fail' });
    assert.strictEqual(toFix.state, 'FIX');
    assert.strictEqual(toFix.fixAttempts, 1);
    assert.strictEqual(toFix.iterations, 1);
    assert.strictEqual(toFix.lastReason, 'P3 fail');

    const checkAgain = state.transition(toFix, 'CHECK');
    const nextCycle = state.transition(checkAgain, 'COOK');
    assert.strictEqual(nextCycle.cycle, 2, 'CHECK→COOK mở cycle mới');
    assert.strictEqual(nextCycle.fixAttempts, 0, 'fixAttempts reset mỗi cycle');
});

test('state: transition throws on illegal move (does not mutate input)', () => {
    const s0 = state.createState();
    assert.throws(() => state.transition(s0, 'DONE'), /không hợp lệ/);
    assert.strictEqual(s0.state, 'INIT', 'input không bị mutate');
});

test('state: planPipeline slices from a given state', () => {
    assert.deepStrictEqual(state.planPipeline('DOC'), ['DOC', 'SHIP', 'DONE']);
    assert.strictEqual(state.planPipeline('INIT')[0], 'INIT');
    // state không thuộc pipeline tuyến tính (vd FIX) → trả full pipeline
    assert.deepStrictEqual(state.planPipeline('FIX'), [...state.PIPELINE]);
});

test('state: save/load roundtrip + resume', () => {
    const dir = tmpProject();
    const s = state.transition(state.createState({ from: 'PLAN' }), 'COOK');
    const file = state.saveState(dir, s);
    assert.ok(fs.existsSync(file));
    const loaded = state.loadState(dir);
    assert.strictEqual(loaded.state, 'COOK');
    assert.strictEqual(loaded.iterations, 1);
});

test('state: loadState returns null when missing or corrupt', () => {
    const dir = tmpProject();
    assert.strictEqual(state.loadState(dir), null, 'missing → null');
    fs.mkdirSync(path.join(dir, '.omni', 'run'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'run', 'state.json'), '{ not json', 'utf-8');
    assert.strictEqual(state.loadState(dir), null, 'corrupt → null');
});

// --- events ----------------------------------------------------------------

test('events: append + read roundtrip, reconstruct last state', () => {
    const dir = tmpProject();
    events.logTransition(dir, 'INIT', 'BRAINSTORM');
    events.logTransition(dir, 'BRAINSTORM', 'EQUIP', { reason: 'ok' });
    const all = events.readEvents(dir);
    assert.strictEqual(all.length, 2);
    assert.ok(all[0].ts, 'mỗi event có timestamp');
    assert.strictEqual(all[1].to, 'EQUIP');
    assert.strictEqual(events.lastStateFromEvents(dir), 'EQUIP');
});

test('events: lastStateFromEvents returns null on empty log', () => {
    assert.strictEqual(events.lastStateFromEvents(tmpProject()), null);
});

// --- budget ----------------------------------------------------------------

test('budget: createBudget validates positive numbers', () => {
    assert.doesNotThrow(() => budget.createBudget());
    assert.strictEqual(budget.createBudget({ maxIterations: 5 }).maxIterations, 5);
    assert.throws(() => budget.createBudget({ maxFixAttempts: 0 }), /số dương/);
    assert.throws(() => budget.createBudget({ maxIterations: -1 }), /số dương/);
});

test('budget: checkBudget stops on iterations / fix / wallclock', () => {
    const b = budget.createBudget({ maxIterations: 3, maxFixAttempts: 2, maxWallclockMs: 1000 });

    assert.strictEqual(budget.checkBudget({ iterations: 1, fixAttempts: 0 }, b, { elapsedMs: 0 }).stop, false);

    assert.match(budget.checkBudget({ iterations: 3, fixAttempts: 0 }, b, { elapsedMs: 0 }).reason, /iterations/);
    assert.match(budget.checkBudget({ iterations: 0, fixAttempts: 2, cycle: 1 }, b, { elapsedMs: 0 }).reason, /fix/);
    assert.match(budget.checkBudget({ iterations: 0, fixAttempts: 0 }, b, { elapsedMs: 2000 }).reason, /thời gian/);

    // Bỏ fallback startedAt -> gọi không truyền elapsedMs + startedAt cũ -> KHÔNG stop.
    const oldStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(budget.checkBudget({ iterations: 0, fixAttempts: 0, startedAt: oldStartedAt }, b).stop, false);
});

// --- loop / planner --------------------------------------------------------

test('loop: planRun returns full annotated sequence ending DONE', () => {
    const plan = loop.planRun({ from: 'INIT' });
    assert.strictEqual(plan.sequence[0].state, 'INIT');
    assert.strictEqual(plan.sequence[plan.sequence.length - 1].state, 'DONE');
    for (const step of plan.sequence) {
        assert.ok(step.artifact, `${step.state} phải có artifact hand-off`);
        assert.ok(typeof step.note === 'string');
    }
    assert.ok(plan.sequence.some((s) => s.state === 'SHIP'));
    assert.ok(plan.loopNote.includes('CHECK'));
});

test('loop: runHarness dry-run plans without executing', async () => {
    const r = await loop.runHarness(tmpProject(), { dryRun: true });
    assert.strictEqual(r.executed, false);
    assert.strictEqual(r.mode, 'dry-run');
    assert.ok(r.plan.sequence.length > 0);
});

// Live-loop behavior (cook→check→fix, pause before SHIP, BLOCKED) is covered in
// test/harness-phase1.test.js using the dry-run provider + injected gates.
