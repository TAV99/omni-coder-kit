#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Catalog } = require('../lib/catalog');
const format = require('../lib/format');

function options(argv) {
    const flags = {};
    const positional = [];
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith('--')) positional.push(arg);
        else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[arg.slice(2)] = argv[++index];
        else flags[arg.slice(2)] = true;
    }
    return { flags, positional };
}

function render(book) {
    const date = book.publishedAt ? new Date(book.publishedAt) : null;
    const label = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown';
    return `${book.id} | ${book.title} | ${book.author ?? ''} | ${format.price(book.price)} | ${label}\n`;
}

function run(argv) {
    const { flags, positional } = options(argv);
    const file = flags.file || 'books.json';
    const catalog = new Catalog(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
    const command = positional[0] || 'list';
    if (command === 'list') return catalog.list().map(render).join('');
    if (command === 'add') {
        const book = catalog.addBook({ id: flags.id, title: flags.title, author: flags.author || '',
            price: Number(flags.price || 0), publishedAt: flags['published-at'] || null });
        fs.writeFileSync(file, JSON.stringify(catalog.list(), null, 2) + '\n');
        return `Added ${book.id}\n`;
    }
    if (command === 'search') throw new Error('Search is not implemented');
    throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
    try { process.stdout.write(run(process.argv.slice(2))); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { run };
