'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('T01: author matching ignores case, still matches the whole author, and preserves books', () => {
    const { Catalog } = load('lib/catalog.js');
    const books = [{ id: 'a', title: 'Dune', author: 'Frank Herbert' }, { id: 'b', title: 'Children', author: 'FRANK HERBERT' }, { id: 'c', author: 'Frank' }];
    const catalog = new Catalog(books);
    assert.deepEqual(catalog.findByAuthor('frank herbert').map((book) => book.id), ['a', 'b']);
    assert.deepEqual(catalog.findByAuthor('unmatched'), []);
    assert.deepEqual(catalog.findByAuthor('frank').map((book) => book.id), ['c']);
    assert.deepEqual(catalog.list(), books);
});
