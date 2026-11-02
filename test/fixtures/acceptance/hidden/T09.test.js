'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('T09: total sums raw prices and rounds once, without changing format.price', () => {
    const report = load('lib/report.js');
    assert.equal(report.total([{ price: 0.014 }, { price: 0.014 }]), 0.03);
    assert.equal(report.total([{ price: 0.1 }, { price: 0.2 }]), 0.3);
    assert.equal(report.total([{ price: 12.5 }, { price: -2.25 }]), 10.25);
    assert.equal(report.total([]), 0);
});
