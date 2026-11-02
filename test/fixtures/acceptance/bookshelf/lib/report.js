'use strict';

const format = require('./format');

function total(books) {
    return books.reduce((sum, book) => sum + Number(format.price(book.price)), 0);
}

function byYear(books) {
    const counts = {};
    for (const book of books) {
        const year = String(book.publishedAt).slice(0, 4);
        counts[year] = (counts[year] || 0) + 1;
    }
    return counts;
}

function summary(books) {
    const latest = books.map((book) => book.publishedAt).filter(Boolean).sort().at(-1);
    const date = latest ? new Date(latest) : null;
    const label = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown';
    return `Books: ${books.length}\nTotal: ${format.price(total(books))}\nLatest: ${label}\n`;
}

module.exports = { total, byYear, summary };
