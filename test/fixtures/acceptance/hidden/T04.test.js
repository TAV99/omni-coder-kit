'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cli } = require('./helpers.cjs');

test('T04: search title or author by case-insensitive substring, including CLI', (t) => {
    const { Catalog } = load('lib/catalog.js');
    assert.equal(typeof Catalog.prototype.search, 'function', 'Catalog.search must be implemented');
    const books = [{ id: 'a', title: 'Dune', author: 'Frank Herbert', price: 12, publishedAt: '1965-08-01' }, { id: 'b', title: 'Earthsea', author: 'Ursula Le Guin', price: 9 }];
    const catalog = new Catalog(books);
    assert.deepEqual(catalog.search('HERB').map((book) => book.id), ['a']);
    assert.deepEqual(catalog.search('earth').map((book) => book.id), ['b']);
    assert.deepEqual(catalog.search('unknown'), []);
    assert.deepEqual(catalog.search(''), books);
    assert.equal(cli(t, books, ['search', 'DUne']), 'a | Dune | Frank Herbert | 12.00 | 1965-08-01\n');
    assert.equal(cli(t, books, ['search', 'missing']), '');
});
