'use strict';

// Pha 4 — state + budget changes (SPEC-PHASE-4-ACCEPTANCE-LOOP §3a + budget).

const { test } = require('node:test');
const assert = require('node:assert');

const state = require('../lib/harness/state');
const { DEFAULT_BUDGET, createBudget } = require('../lib/harness/budget');

test('state: ACCEPTANCE is a recognised STATE', () => {
    assert.ok(state.STATES.includes('ACCEPTANCE'));
});

test('state: PIPELINE includes ACCEPTANCE between CHECK and DOC', () => {
    const i = state.PIPELINE.indexOf('ACCEPTANCE');
    assert.ok(i > 0);
    assert.strictEqual(state.PIPELINE[i - 1], 'CHECK');
    assert.strictEqual(state.PIPELINE[i + 1], 'DOC');
});

test('state: CHECK transitions to ACCEPTANCE (not DOC)', () => {
    assert.ok(state.canTransition('CHECK', 'ACCEPTANCE'));
    assert.ok(!state.canTransition('CHECK', 'DOC'));
});

test('state: ACCEPTANCE → COOK/FIX/DOC/BLOCKED', () => {
    for (const to of ['COOK', 'FIX', 'DOC', 'BLOCKED']) {
        assert.ok(state.canTransition('ACCEPTANCE', to), `ACCEPTANCE → ${to}`);
    }
    assert.ok(!state.canTransition('ACCEPTANCE', 'SHIP'), 'không nhảy thẳng tới SHIP');
});

test('state: ACCEPTANCE can escalate to BLOCKED and BLOCKED can recover to ACCEPTANCE', () => {
    assert.ok(state.canTransition('ACCEPTANCE', 'BLOCKED'));
    assert.ok(state.canTransition('BLOCKED', 'ACCEPTANCE'));
});

test('state: createState seeds acceptanceRounds=0', () => {
    const s = state.createState();
    assert.strictEqual(s.acceptanceRounds, 0);
});

test('state: transition ACCEPTANCE → COOK opens a fresh cycle (acceptance loop)', () => {
    const s0 = state.transition(state.createState({ from: 'CHECK' }), 'ACCEPTANCE');
    assert.strictEqual(s0.state, 'ACCEPTANCE');
    const back = state.transition(s0, 'COOK', { reason: 'fix unmet requirements' });
    assert.strictEqual(back.state, 'COOK');
});

test('budget: DEFAULT_BUDGET exposes maxAcceptanceRounds (default 3)', () => {
    assert.strictEqual(DEFAULT_BUDGET.maxAcceptanceRounds, 3);
});

test('budget: createBudget honours override', () => {
    const b = createBudget({ maxAcceptanceRounds: 5 });
    assert.strictEqual(b.maxAcceptanceRounds, 5);
});

test('budget: invalid maxAcceptanceRounds rejected', () => {
    assert.throws(() => createBudget({ maxAcceptanceRounds: 0 }), /maxAcceptanceRounds/);
    assert.throws(() => createBudget({ maxAcceptanceRounds: -1 }), /maxAcceptanceRounds/);
});
