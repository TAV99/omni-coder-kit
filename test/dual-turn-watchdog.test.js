'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnWatchdog, TURN_NUDGE_GRACE_MS, TURN_SOFT_BUDGET_MS, TURN_HARD_BUDGET_MS,
    TURN_HEARTBEAT_MS, TURN_NO_PROGRESS_MS } = require('../lib/dual/turn-watchdog');
function fixture(overrides = {}) {
    let time = 0;
    return { clock: (at) => { time = at; }, watchdog: createTurnWatchdog({ now: () => time,
        softMs: 100, hardMs: 200, heartbeatMs: 10, noProgressMs: 50, graceMs: 20, ...overrides }) };
}
test('production safety thresholds are pinned', () => {
    assert.deepEqual([TURN_SOFT_BUDGET_MS, TURN_HARD_BUDGET_MS, TURN_HEARTBEAT_MS,
        TURN_NO_PROGRESS_MS, TURN_NUDGE_GRACE_MS], [600000, 1200000, 60000, 300000, 120000]);
});
test('zero-evidence fails fast at no-progress threshold without nudge or grace', () => {
    const { clock, watchdog } = fixture();
    clock(49); assert.equal(watchdog.check().action, 'ok');
    clock(50); const state = watchdog.check();
    assert.equal(state.action, 'fail-fast');
    assert.equal(state.reason, 'no_evidence');
    assert.equal(state.nudgedAt, null);
    clock(60); const beat = watchdog.check();
    assert.equal(beat.heartbeat, true);
    assert.equal(beat.action, 'fail-fast');
    assert.equal(beat.reason, 'no_evidence');
    clock(70); assert.equal(watchdog.check().action, 'fail-fast');
});
test('some-evidence nudges once, heartbeat does not mask silence, stall after grace', () => {
    const { clock, watchdog } = fixture();
    clock(10); watchdog.progress();
    clock(60); assert.equal(watchdog.check().action, 'nudge');
    clock(70); const beat = watchdog.check();
    assert.equal(beat.heartbeat, true); assert.equal(beat.lastProgressAt, 10);
    assert.equal(beat.action, 'ok');
    clock(80); assert.equal(watchdog.check().action, 'stall');
    clock(90); assert.equal(watchdog.check().action, 'stall');
});
test('spawn activity does not count as evidence and still fails fast at silence', () => {
    const { clock, watchdog } = fixture();
    clock(10); watchdog.activity();
    clock(59); assert.equal(watchdog.check().action, 'ok');
    clock(60); const state = watchdog.check();
    assert.equal(state.action, 'fail-fast');
    assert.equal(state.reason, 'no_evidence');
    assert.equal(state.nudgedAt, null);
});
test('real progress after nudge gets time to finish without a second nudge', () => {
    const { clock, watchdog } = fixture();
    clock(10); watchdog.progress();
    clock(60); assert.equal(watchdog.check().action, 'nudge');
    clock(75); watchdog.progress();
    clock(80); assert.equal(watchdog.check().action, 'ok');
    clock(125); assert.equal(watchdog.check().action, 'stall');
});
test('soft warning once and hard budget stops even with continuing progress', () => {
    const { clock, watchdog } = fixture();
    clock(100); watchdog.progress(); assert.equal(watchdog.check().soft, true);
    clock(101); assert.equal(watchdog.check().soft, false);
    clock(200); watchdog.progress();
    const state = watchdog.check();
    assert.equal(state.action, 'stall'); assert.equal(state.reason, 'hard_budget');
});
test('reject invalid thresholds', () => {
    assert.throws(() => fixture({ graceMs: 0 }), /positive/);
    assert.throws(() => fixture({ softMs: 201 }), /exceeds/);
});
