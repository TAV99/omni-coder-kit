'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { runPipeline } = require('../lib/harness/gates/pipeline');

test('runPipeline: bypassed gates are marked as skipped with custom output', () => {
    const fakeGate = () => ({ ran: true, passed: true, output: 'ok', durationMs: 1 });
    
    // Only run P1 and P2
    const res = runPipeline('/x', { 
        only: ['P1', 'P2'], 
        runGate: fakeGate,
        runSecurity: () => ({ ran: true, passed: true, output: 'sec-ok' }),
        runBundle: () => ({ ran: true, passed: true, output: 'bundle-ok' }),
        runContent: () => ({ ran: true, passed: true, output: 'content-ok' }),
    });
    
    // We expect only 2 gates (P1 and P2) since it filters out the rest
    assert.strictEqual(res.results.length, 2);
    
    // P1 (allowed) -> pass
    const p1 = res.results.find(r => r.id === 'P1');
    assert.strictEqual(p1.status, 'pass');
    assert.strictEqual(p1.output, 'ok');

    // P2 (allowed) -> pass
    const p2 = res.results.find(r => r.id === 'P2');
    assert.strictEqual(p2.status, 'pass');
    assert.strictEqual(p2.output, 'ok');

    // P0 and P3 should not be in results
    const p0 = res.results.find(r => r.id === 'P0');
    assert.strictEqual(p0, undefined);

    const p3 = res.results.find(r => r.id === 'P3');
    assert.strictEqual(p3, undefined);
});
