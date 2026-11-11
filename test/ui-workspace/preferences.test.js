'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('T02: preferences store and restore', async (t) => {
    const { createPreferencesStore } = require('../../lib/ui/preferences');

    function tempDir() {
        return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-pref-test-')));
    }

    await t.test('read: returns defaults on empty project', () => {
        const root = tempDir();
        try {
            const store = createPreferencesStore({ root });
            const pref = store.read();
            assert.equal(pref.schemaVersion, 1);
            assert.ok(typeof pref.revision === 'string' && pref.revision.length > 0);
            assert.equal(pref.theme, 'system');
            assert.equal(typeof pref.sidebarCollapsed, 'boolean');
            assert.equal(typeof pref.contextCollapsed, 'boolean');
            assert.ok(pref.contexts && typeof pref.contexts === 'object');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('write: atomic write and CAS revision check', () => {
        const root = tempDir();
        try {
            const store = createPreferencesStore({ root });
            const initial = store.read();

            const next = structuredClone(initial);
            next.theme = 'midnight';
            next.sidebarCollapsed = true;

            const written = store.write(next, initial.revision);
            assert.equal(written.theme, 'midnight');
            assert.equal(written.sidebarCollapsed, true);
            assert.notEqual(written.revision, initial.revision);

            // Re-read from disk matches written
            const reloaded = store.read();
            assert.equal(reloaded.theme, 'midnight');
            assert.equal(reloaded.revision, written.revision);

            // Stale revision rejects with PREFERENCES_CONFLICT
            assert.throws(() => {
                store.write(next, initial.revision);
            }, (err) => err.code === 'PREFERENCES_CONFLICT');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('write: rejects oversized state (> 128 KiB)', () => {
        const root = tempDir();
        try {
            const store = createPreferencesStore({ root });
            const current = store.read();

            const oversized = structuredClone(current);
            // Add > 128 KiB payload
            oversized.contexts['heavy'] = {
                priority: 'timeline',
                layout: { type: 'group', id: 'g-1', tabs: [], activeViewId: null },
                views: [],
                junk: 'x'.repeat(135 * 1024)
            };

            assert.throws(() => {
                store.write(oversized, current.revision);
            }, (err) => err.code === 'PREFERENCES_OVERSIZED');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('write: validates theme options', () => {
        const root = tempDir();
        try {
            const store = createPreferencesStore({ root });
            const current = store.read();

            const invalidTheme = structuredClone(current);
            invalidTheme.theme = 'neon-pink';

            assert.throws(() => {
                store.write(invalidTheme, current.revision);
            }, /Invalid theme/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('read: corrupt JSON creates backup and falls back to safe defaults', () => {
        const root = tempDir();
        try {
            const uiDir = path.join(root, '.omni', 'ui');
            fs.mkdirSync(uiDir, { recursive: true });
            const prefFile = path.join(uiDir, 'workspace.json');
            fs.writeFileSync(prefFile, '{ this is not valid json! truncated');

            const store = createPreferencesStore({ root });
            const result = store.read();

            // Falls back to safe default
            assert.equal(result.schemaVersion, 1);
            assert.equal(result.theme, 'system');
            assert.ok(result.corruptNotice);

            // Backup file was created
            const files = fs.readdirSync(uiDir);
            const backup = files.find(f => f.startsWith('workspace.corrupt.') && f.endsWith('.json'));
            assert.ok(backup, 'Backup file should have been preserved');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('read: future schema version preserves backup and returns defaults', () => {
        const root = tempDir();
        try {
            const uiDir = path.join(root, '.omni', 'ui');
            fs.mkdirSync(uiDir, { recursive: true });
            const prefFile = path.join(uiDir, 'workspace.json');
            fs.writeFileSync(prefFile, JSON.stringify({ schemaVersion: 99, theme: 'graphite' }));

            const store = createPreferencesStore({ root });
            const result = store.read();

            assert.equal(result.schemaVersion, 1);
            assert.ok(result.corruptNotice);

            const files = fs.readdirSync(uiDir);
            const backup = files.find(f => f.startsWith('workspace.corrupt.') && f.endsWith('.json'));
            assert.ok(backup, 'Future version backup should be preserved');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
