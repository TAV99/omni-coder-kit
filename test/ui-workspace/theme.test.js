'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('T09: semantic theme tokens and manager', async (t) => {
    const {
        VALID_THEMES,
        resolveTheme,
        paletteForXterm,
        createThemeManager,
    } = await import('../../lib/ui/static/workspace/theme.mjs');

    await t.test('VALID_THEMES contains all spec themes and extended palettes', () => {
        assert.deepEqual(VALID_THEMES, ['system', 'graphite', 'paper', 'midnight', 'nordic', 'obsidian', 'emerald', 'tokyo']);
    });

    await t.test('resolveTheme: resolves system based on dark preference', () => {
        assert.equal(resolveTheme('system', true), 'midnight');
        assert.equal(resolveTheme('system', false), 'graphite');
        assert.equal(resolveTheme('midnight', false), 'midnight');
        assert.equal(resolveTheme('paper', true), 'paper');
        assert.equal(resolveTheme('graphite', true), 'graphite');
        assert.equal(resolveTheme('nordic', false), 'nordic');
        assert.equal(resolveTheme('obsidian', true), 'obsidian');
        assert.equal(resolveTheme('emerald', true), 'emerald');
        assert.equal(resolveTheme('tokyo', true), 'tokyo');
        assert.equal(resolveTheme('unknown', false), 'graphite');
    });

    await t.test('paletteForXterm: provides distinct palettes matching themes', () => {
        const midnight = paletteForXterm('midnight');
        const graphite = paletteForXterm('graphite');
        const paper = paletteForXterm('paper');
        const nordic = paletteForXterm('nordic');
        const obsidian = paletteForXterm('obsidian');
        const emerald = paletteForXterm('emerald');
        const tokyo = paletteForXterm('tokyo');

        assert.ok(midnight.background.startsWith('#'));
        assert.ok(graphite.background.startsWith('#'));
        assert.ok(nordic.background.startsWith('#'));
        assert.ok(obsidian.background.startsWith('#'));
        assert.ok(emerald.background.startsWith('#'));
        assert.ok(tokyo.background.startsWith('#'));

        assert.notEqual(midnight.background, graphite.background);
        assert.notEqual(graphite.background, paper.background);
        assert.notEqual(nordic.background, obsidian.background);
        assert.notEqual(emerald.background, tokyo.background);
    });

    await t.test('createThemeManager: applies theme and notifies listeners', () => {
        const rootElement = { dataset: {} };
        let notified = null;

        const manager = createThemeManager({
            rootElement,
            onThemeChange: (evt) => { notified = evt; },
        });

        assert.equal(manager.getTheme(), 'system');

        manager.setTheme('midnight');
        assert.equal(manager.getTheme(), 'midnight');
        assert.equal(rootElement.dataset.theme, 'midnight');
        assert.ok(notified);
        assert.equal(notified.theme, 'midnight');
        assert.equal(notified.resolved, 'midnight');

        assert.throws(() => {
            manager.setTheme('solarized');
        }, /Invalid theme/);
    });
});
