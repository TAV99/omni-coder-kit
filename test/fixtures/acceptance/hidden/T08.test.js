'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('T08: finance export matches the sourced finance specification', () => {
    const csv = load('lib/csv.js');
    assert.equal(typeof csv.exportFinance, 'function', 'finance export must exist after context reply');
    assert.equal(csv.exportFinance([{ id: 'a', title: 'Dune, Messiah', price: 12.5 }, { id: 'b', title: 'A "quote"', price: 0 }]),
        'book_id,title,amount\na,"Dune, Messiah",12.50\nb,"A ""quote""",0.00\n');
    assert.equal(csv.exportFinance([]), 'book_id,title,amount\n');
});
