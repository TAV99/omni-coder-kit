'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../lib/csv');

test('parse a simple CSV table and an empty document', () => {
    assert.deepEqual(csv.parse('id,title\na,Dune\n'), [['id', 'title'], ['a', 'Dune']]);
    assert.deepEqual(csv.parse(''), []);
});

test('stringify plain rows', () => {
    assert.equal(csv.stringify([['id', 'title'], ['a', 'Dune']]), 'id,title\na,Dune\n');
    assert.equal(csv.stringify([]), '');
});
