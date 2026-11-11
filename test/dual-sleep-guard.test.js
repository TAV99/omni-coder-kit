'use strict';

// O4 (docs/SQUAD-ORCA-ADOPTION.md): keep the Mac awake while a worker lease
// is held, so idle sleep cannot strand a task in NEEDS_PROCESS_EVIDENCE.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSleepGuard } = require('../lib/dual/sleep-guard');

function fakeSpawn() {
    const calls = [];
    const spawn = (command, args, options) => {
        const child = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; return true; };
        child.unref = () => { child.unrefd = true; };
        calls.push({ command, args, options, child });
        return child;
    };
    return { spawn, calls };
}

test('one caffeinate for overlapping leases, bound to this process, ended by the last release', () => {
    const { spawn, calls } = fakeSpawn();
    const guard = createSleepGuard({ platform: 'darwin', env: {}, spawn, pid: 4242 });
    const a = guard.acquire();
    const b = guard.acquire();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/caffeinate');
    assert.deepEqual(calls[0].args, ['-i', '-s', '-w', '4242']);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].child.unrefd, true, 'never keeps the daemon alive');
    a();
    a(); // idempotent: a double release must not end b's hold
    assert.equal(calls[0].child.killed, false);
    b();
    assert.equal(calls[0].child.killed, true);
    assert.equal(guard.active(), 0);
    guard.acquire();
    assert.equal(calls.length, 2, 'a later lease starts a fresh assertion');
});

test('a caffeinate that exits early is replaced on the next acquire', () => {
    const { spawn, calls } = fakeSpawn();
    const guard = createSleepGuard({ platform: 'darwin', env: {}, spawn, pid: 1 });
    guard.acquire();
    calls[0].child.emit('exit', 1);
    guard.acquire();
    assert.equal(calls.length, 2);
});

test('no-op off macOS, with OMNI_SLEEP_GUARD=off, or when caffeinate cannot start', () => {
    const { spawn, calls } = fakeSpawn();
    createSleepGuard({ platform: 'linux', env: {}, spawn, pid: 1 }).acquire()();
    createSleepGuard({ platform: 'darwin', env: { OMNI_SLEEP_GUARD: 'off' }, spawn, pid: 1 }).acquire()();
    assert.equal(calls.length, 0);
    const throwing = createSleepGuard({ platform: 'darwin', env: {}, pid: 1, spawn: () => { throw new Error('ENOENT'); } });
    const release = throwing.acquire();
    assert.doesNotThrow(release);
    const failing = fakeSpawn();
    const guard = createSleepGuard({ platform: 'darwin', env: {}, pid: 1, spawn: failing.spawn });
    guard.acquire();
    assert.doesNotThrow(() => failing.calls[0].child.emit('error', new Error('ENOENT')));
});
