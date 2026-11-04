'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalSession, MAX_INPUT, RING_BYTES } = require('../../lib/ui/terminal-session');
const { createTerminalRegistry, MAX_INTERACTIVE_TERMINALS } = require('../../lib/ui/terminal-registry');

function fakePtyFactory() {
    let currentChild = null;
    const spawnPty = (command, args, options) => {
        let onDataCb = () => {};
        let onExitCb = () => {};
        const child = {
            pid: 12345,
            written: [],
            resized: [],
            killed: false,
            write(d) { this.written.push(d); },
            resize(c, r) { this.resized.push({ c, r }); },
            kill(sig) { this.killed = true; onExitCb({ exitCode: 0, signal: sig }); },
            onData(fn) { onDataCb = fn; },
            onExit(fn) { onExitCb = fn; },
            emitData(data) { onDataCb(data); },
            emitExit(code, sig) { onExitCb({ exitCode: code, signal: sig }); },
        };
        currentChild = child;
        return child;
    };
    return {
        spawnPty,
        getChild: () => currentChild,
    };
}

test('T03: terminal session and registry', async (t) => {
    await t.test('session lifecycle: start, attach, claim, input, resize, stop', () => {
        const { spawnPty, getChild } = fakePtyFactory();
        const session = createTerminalSession({ id: 'term-1', spawnPty });

        assert.equal(session.summary().status, 'idle');
        session.start({ command: '/bin/zsh' });
        assert.equal(session.summary().status, 'running');

        const child = getChild();
        assert.ok(child);

        let received = [];
        const { clientId, replay, detach } = session.attach((evt, payload) => {
            if (evt === 'data') received.push(payload.data);
        });

        assert.equal(typeof clientId, 'string');
        assert.equal(session.summary().writerClientId, clientId);

        // Input
        session.input(clientId, 'ls -la\n');
        assert.deepEqual(child.written, ['ls -la\n']);

        // Resize
        session.resize(clientId, 120, 40);
        assert.deepEqual(child.resized, [{ c: 120, r: 40 }]);

        // Emit output from process
        child.emitData('hello world');
        assert.ok(received.includes('hello world'));

        // Stop
        session.stop();
        assert.equal(session.summary().status, 'exited');
        assert.equal(child.killed, true);
    });

    await t.test('session single-writer policy', () => {
        const { spawnPty } = fakePtyFactory();
        const session = createTerminalSession({ id: 'term-1', spawnPty });
        session.start({ command: '/bin/zsh' });

        const client1 = session.attach(() => {});
        const client2 = session.attach(() => {});

        assert.equal(session.summary().writerClientId, client1.clientId);

        // Client 1 is writer -> succeeds
        session.input(client1.clientId, 'cmd1\n');

        // Client 2 is NOT writer -> throws UI_PTY_NOT_WRITER
        assert.throws(() => {
            session.input(client2.clientId, 'cmd2\n');
        }, (err) => err.code === 'UI_PTY_NOT_WRITER');

        // Client 2 claims writer
        session.claim(client2.clientId);
        assert.equal(session.summary().writerClientId, client2.clientId);

        // Client 2 can now type
        session.input(client2.clientId, 'cmd2\n');

        // Client 1 is no longer writer
        assert.throws(() => {
            session.input(client1.clientId, 'cmd3\n');
        }, (err) => err.code === 'UI_PTY_NOT_WRITER');
    });

    await t.test('session generation tracking and replay reset', () => {
        const { spawnPty, getChild } = fakePtyFactory();
        const session = createTerminalSession({ id: 'term-1', spawnPty });
        session.start({ command: '/bin/zsh' });

        const gen1 = session.summary().generation;
        getChild().emitData('gen1-output');

        // Stop and re-start
        session.stop();
        session.start({ command: '/bin/zsh' });
        const gen2 = session.summary().generation;
        assert.ok(gen2 > gen1, 'Generation must increment on new start');

        // Reconnect with old generation triggers reset: true
        const client = session.attach(() => {}, { seq: 1, generation: gen1 });
        assert.equal(client.replay.reset, true);
        assert.equal(client.replay.generation, gen2);
    });

    await t.test('session enforces 64 KiB input limit', () => {
        const { spawnPty } = fakePtyFactory();
        const session = createTerminalSession({ id: 'term-1', spawnPty });
        session.start({ command: '/bin/zsh' });

        const client = session.attach(() => {});
        const oversized = 'a'.repeat(MAX_INPUT + 1);

        assert.throws(() => {
            session.input(client.clientId, oversized);
        }, (err) => err.code === 'UI_PTY_INPUT');
    });

    await t.test('registry enforces max 8 interactive terminals', () => {
        const { spawnPty } = fakePtyFactory();
        const registry = createTerminalRegistry({ projectRoot: '/test', spawnPty });

        const created = [];
        for (let i = 0; i < MAX_INTERACTIVE_TERMINALS; i++) {
            created.push(registry.create({ autoStart: true }));
        }

        assert.equal(registry.activeCount(), MAX_INTERACTIVE_TERMINALS);

        // 9th creation throws TERMINAL_LIMIT_EXCEEDED
        assert.throws(() => {
            registry.create({ autoStart: true });
        }, (err) => err.code === 'TERMINAL_LIMIT_EXCEEDED');

        // Stopping one terminal allows creating a new one
        registry.stop(created[0].id);
        const replacement = registry.create({ autoStart: true });
        assert.ok(replacement);

        // Close all
        registry.closeAll();
        assert.equal(registry.activeCount(), 0);
    });
});
