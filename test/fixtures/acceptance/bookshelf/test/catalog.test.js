'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Catalog } = require('../lib/catalog');

test('add, find and remove books without mutating the input array', () => {
    const seed = [{ id: 'a', title: 'Dune', author: 'Frank Herbert', price: 12 }];
    const catalog = new Catalog(seed);
    catalog.addBook({ id: 'b', title: 'Earthsea', author: 'Ursula Le Guin', price: 9 });
    assert.equal(seed.length, 1);
    assert.equal(catalog.findById('b').title, 'Earthsea');
    assert.deepEqual(catalog.findByAuthor('Frank Herbert').map((book) => book.id), ['a']);
    assert.equal(catalog.removeBook('a'), true);
    assert.equal(catalog.removeBook('missing'), false);
    assert.equal(catalog.list().length, 1);
});

test('list returns a separate array', () => {
    const catalog = new Catalog([{ id: 'a', title: 'Dune' }]);
    catalog.list().pop();
    assert.equal(catalog.list().length, 1);
});
