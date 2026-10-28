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
test('nudge once, heartbeat does not mask silence, stall after grace', () => {
    const { clock, watchdog } = fixture();
    clock(50); assert.equal(watchdog.check().action, 'nudge');
    clock(60); const beat = watchdog.check();
    assert.equal(beat.heartbeat, true); assert.equal(beat.lastProgressAt, 0);
    assert.equal(beat.action, 'ok');
    clock(70); assert.equal(watchdog.check().action, 'stall');
    clock(80); assert.equal(watchdog.check().action, 'stall');
});
test('real progress after nudge gets time to finish without a second nudge', () => {
    const { clock, watchdog } = fixture();
    clock(50); assert.equal(watchdog.check().action, 'nudge');
    clock(65); watchdog.progress();
    clock(70); assert.equal(watchdog.check().action, 'ok');
    clock(115); assert.equal(watchdog.check().action, 'stall');
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
