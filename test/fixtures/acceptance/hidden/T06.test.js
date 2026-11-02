'use strict';
const test = require('node:test');
const { rejectMutation } = require('./helpers.cjs');

test('T06: visible price tests reject edge-case mutations, without production edits', (t) => {
    const mutations = {
        zero: "value => value === 0 ? '0' : original(value)",
        negative: "value => original(typeof value === 'number' && Number.isFinite(value) && value < 0 ? -value : value)",
        rounding: "value => typeof value === 'number' && Number.isFinite(value) ? (Math.trunc(value * 100) / 100).toFixed(2) : original(value)",
        padding: "value => typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value) ? String(Number(original(value))) : original(value)",
        nan: "value => Number.isNaN(value) ? '0.00' : original(value)",
        infinity: "value => value === Infinity ? '0.00' : original(value)",
        negativeInfinity: "value => value === -Infinity ? '0.00' : original(value)",
        string: "value => typeof value === 'string' ? '0.00' : original(value)",
        null: "value => value === null ? '0.00' : original(value)",
        undefined: "value => value === undefined ? '0.00' : original(value)",
    };
    for (const [name, mutation] of Object.entries(mutations)) {
        rejectMutation(t, name, 'lib/format.js', 'test/format.test.js',
            `const original = module.exports.price;\nmodule.exports.price = ${mutation};`);
    }
});
