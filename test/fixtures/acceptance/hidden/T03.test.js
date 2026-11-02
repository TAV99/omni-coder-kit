'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, rejectMutation } = require('./helpers.cjs');

test('T03: quoted commas, escaped quotes, CRLF and empty fields round-trip', (t) => {
    const csv = load('lib/csv.js');
    assert.deepEqual(csv.parse('id,title\r\na,"Dune, Messiah"\r\n'), [['id', 'title'], ['a', 'Dune, Messiah']]);
    const rows = [['', 'A, B', 'He said "read"', ''], ['a', 'plain', 'x', '']];
    assert.deepEqual(csv.parse(csv.stringify(rows)), rows);
    rejectMutation(t, 'old comma-splitting CSV parser', 'lib/csv.js', 'test/csv.test.js',
        "module.exports.parse = text => text ? text.replace(/\\r\\n/g, '\\n').replace(/\\n$/, '').split('\\n').map(line => line.split(',')) : [];");
});
