'use strict';

function parseRules(rp) {
    const split = (str) => str ? str.split(';').map(r => r.trim()).filter(Boolean) : [];
    return {
        language: rp.language || null,
        codingStyle: split(rp.codingStyle),
        forbidden: split(rp.forbidden),
        custom: split(rp.custom),
    };
}

module.exports = { parseRules };
