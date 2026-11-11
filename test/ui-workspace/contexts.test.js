'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createContextManager } = require('../../lib/ui/contexts');
const { createTerminalRegistry } = require('../../lib/ui/terminal-registry');
const { createPreferencesStore } = require('../../lib/ui/preferences');

function fakePty() {
    return (command, args, options) => {
        let onDataCb = () => {};
        let onExitCb = () => {};
        return {
            pid: 1000,
            write() {},
            resize() {},
            kill() { onExitCb({ exitCode: 0 }); },
            onData(fn) { onDataCb = fn; },
            onExit(fn) { onExitCb = fn; },
        };
    };
}

test('T05: context manager and shells integration', async (t) => {
    function tempDir() {
        return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ctx-test-')));
    }

    await t.test('context manager initializes distinct Squad and Single contexts', () => {
        const root = tempDir();
        try {
            const registry = createTerminalRegistry({ projectRoot: root, spawnPty: fakePty() });
            const prefStore = createPreferencesStore({ root });
            const manager = createContextManager({ projectRoot: root, registry, preferencesStore: prefStore });

            const contexts = manager.list();
            assert.equal(contexts.length, 2);

            const squad = contexts.find(c => c.mode === 'squad');
            const single = contexts.find(c => c.mode === 'single');
            assert.ok(squad);
            assert.ok(single);
            assert.notEqual(squad.id, single.id);

            assert.equal(manager.getSelectedContextId(), squad.id);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('context switching preserves processes and does not kill primary terminals', () => {
        const root = tempDir();
        try {
            const registry = createTerminalRegistry({ projectRoot: root, spawnPty: fakePty() });
            const prefStore = createPreferencesStore({ root });
            const manager = createContextManager({ projectRoot: root, registry, preferencesStore: prefStore });

            const squadTerm = manager.getPrimaryTerminal('squad');
            const singleTerm = manager.getPrimaryTerminal('single');
            assert.notEqual(squadTerm.id, singleTerm.id);

            // Switch to single
            manager.select('single');
            assert.equal(manager.getSelectedContextId(), 'single');

            // Squad terminal still exists and is not stopped
            const squadSession = registry.get(squadTerm.id);
            assert.equal(squadSession.summary().status, 'running');

            // Switch back to squad
            manager.select('squad');
            assert.equal(manager.getSelectedContextId(), 'squad');
            assert.equal(squadSession.summary().status, 'running');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('shells are owned by context and detach does not stop shell process', () => {
        const root = tempDir();
        try {
            const registry = createTerminalRegistry({ projectRoot: root, spawnPty: fakePty() });
            const prefStore = createPreferencesStore({ root });
            const manager = createContextManager({ projectRoot: root, registry, preferencesStore: prefStore });

            const shell = registry.create({
                contextId: 'squad',
                kind: 'user-shell',
                autoStart: true,
            });

            // Shell appears in squad list
            const squadShells = registry.list('squad').filter(t => t.kind === 'user-shell');
            assert.equal(squadShells.length, 1);
            assert.equal(squadShells[0].id, shell.id);

            // Attach client
            const session = registry.get(shell.id);
            const client = session.attach(() => {});
            assert.equal(session.summary().clients, 1);

            // Detach client -> shell is still running!
            client.detach();
            assert.equal(session.summary().clients, 0);
            assert.equal(session.summary().status, 'running');

            // Explicit stop terminates shell
            registry.stop(shell.id);
            assert.equal(session.summary().status, 'exited');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('getWorkspaceSummary returns contexts, selected context, capabilities and revisions', () => {
        const root = tempDir();
        try {
            const registry = createTerminalRegistry({ projectRoot: root, spawnPty: fakePty() });
            const prefStore = createPreferencesStore({ root });
            const manager = createContextManager({ projectRoot: root, registry, preferencesStore: prefStore });

            const summary = manager.getWorkspaceSummary();
            assert.equal(summary.selectedContextId, 'squad');
            assert.equal(summary.contexts.length, 2);
            assert.equal(summary.capabilities.userShells, true);
            assert.ok(summary.revisions.preferences);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
