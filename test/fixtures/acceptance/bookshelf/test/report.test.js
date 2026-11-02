'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../lib/report');

const books = [
    { id: 'a', title: 'Dune', price: 12, publishedAt: '1965-08-01' },
    { id: 'b', title: 'Earthsea', price: 9, publishedAt: '1968-01-01' },
];

test('total and summary for whole prices', () => {
    assert.equal(report.total(books), 21);
    assert.equal(report.total([]), 0);
    assert.equal(report.summary(books), 'Books: 2\nTotal: 21.00\nLatest: 1968-01-01\n');
    assert.equal(report.summary([]), 'Books: 0\nTotal: 0.00\nLatest: unknown\n');
});

test('byYear for ordinary dates', () => {
    assert.deepEqual(report.byYear(books), { 1965: 1, 1968: 1 });
    assert.deepEqual(report.byYear([]), {});
});
