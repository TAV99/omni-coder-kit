'use strict';

function price(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('Price must be a finite number');
    }
    return value.toFixed(2);
}

module.exports = { price };
