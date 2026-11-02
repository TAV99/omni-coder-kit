'use strict';

function parse(text) {
    if (!text) return [];
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((line) => line.split(','));
}

function stringify(rows) {
    if (rows.length === 0) return '';
    const field = (value) => {
        const text = String(value ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return rows.map((row) => row.map(field).join(',')).join('\n') + '\n';
}

module.exports = { parse, stringify };
