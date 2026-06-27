'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memory = require('../lib/harness/memory');
const { summarizeEvents } = require('../lib/harness/events');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mem-')); }
function kb(dir) { return path.join(dir, '.omni', 'knowledge', 'knowledge-base.md'); }

// --- memory.js -------------------------------------------------------------

test('memory.appendLesson creates KB + readLessonsFor filters by file', () => {
    const dir = tmp();
    memory.appendLesson(dir, { date: '2026-06-26', title: 'Auth race', scope: 'src/auth.js', pattern: 'race', fix: 'lock' });
    memory.appendLesson(dir, { date: '2026-06-26', title: 'CSS bug', scope: 'src/styles.css', pattern: 'x', fix: 'y' });
    assert.ok(fs.existsSync(kb(dir)));

    const forAuth = memory.readLessonsFor(dir, ['src/auth.js']);
    assert.match(forAuth, /Auth race/);
    assert.ok(!/CSS bug/.test(forAuth), 'should not include unrelated lesson');

    // basename match works too
    assert.match(memory.readLessonsFor(dir, ['/abs/path/styles.css']), /CSS bug/);

    // no files → all lessons
    const all = memory.readLessonsFor(dir, []);
    assert.match(all, /Auth race/);
    assert.match(all, /CSS bug/);
});

test('memory.readLessonsFor: no KB → empty string', () => {
    assert.strictEqual(memory.readLessonsFor(tmp(), ['x.js']), '');
});

test('memory.appendLesson enforces 20-entry cap', () => {
    const dir = tmp();
    for (let i = 0; i < 25; i++) {
        memory.appendLesson(dir, { date: '2026-06-26', title: `L${i}`, scope: 'a.js', pattern: 'p', fix: 'f' });
    }
    const entries = memory.parseEntries(fs.readFileSync(kb(dir), 'utf-8'));
    assert.strictEqual(entries.length, memory.MAX_ENTRIES);
    // oldest dropped, newest kept
    assert.match(entries[entries.length - 1].raw, /L24/);
    assert.ok(!entries.some((e) => /L0\b/.test(e.raw)), 'oldest entry removed');
});

// --- observability: summarizeEvents ---------------------------------------

test('summarizeEvents aggregates by state + totals', () => {
    const events = [
        { type: 'transition', to: 'COOK' },
        { type: 'provider', action: 'cook', durationMs: 100 },
        { type: 'usage', step: 'cook', inputTokens: 1000, outputTokens: 500, costUsd: 0.01 },
        { type: 'transition', to: 'CHECK' },
        { type: 'gate', passed: true },
        { type: 'fanout', phase: 'check', durationMs: 50 },
        { type: 'usage', step: 'security', inputTokens: 200, outputTokens: 100, costUsd: 0.02 },
        { type: 'transition', to: 'DOC' },
        { type: 'provider', action: 'doc', durationMs: 30 },
    ];
    const { byState, totals } = summarizeEvents(events);
    assert.strictEqual(byState.COOK.durationMs, 100);
    assert.strictEqual(byState.COOK.inputTokens, 1000);
    assert.ok(Math.abs(byState.COOK.costUsd - 0.01) < 1e-9);
    assert.strictEqual(byState.CHECK.durationMs, 50);    // fan-out time attributed to CHECK
    assert.ok(Math.abs(byState.CHECK.costUsd - 0.02) < 1e-9);
    assert.strictEqual(byState.DOC.providerCalls, 1);
    assert.strictEqual(totals.transitions, 3);
    assert.strictEqual(totals.inputTokens, 1200);
    assert.strictEqual(totals.providerCalls, 2);
    assert.ok(Math.abs(totals.costUsd - 0.03) < 1e-9);
});

test('summarizeEvents on empty log → zeros', () => {
    const { byState, totals } = summarizeEvents([]);
    assert.deepStrictEqual(byState, {});
    assert.strictEqual(totals.transitions, 0);
    assert.strictEqual(totals.costUsd, 0);
});
