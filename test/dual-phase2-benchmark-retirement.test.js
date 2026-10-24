'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('./dual-phase2-benchmark'), 'utf8');

// Exercise the real entry/catch. All setup, child processes and production imports
// are blocked, so a regression cannot accidentally launch a live/cold provider.
async function entry(args, live, workerConfig) {
    const calls = [];
    const errors = [];
    const messages = [];
    let onMessage;
    const blocked = name => () => { calls.push(name); throw new Error('Forbidden I/O: ' + name); };
    const processStub = {
        argv: ['node', 'dual-phase2-benchmark.js', ...args],
        env: { OMNI_DUAL_LIVE: live ? '1' : '0' },
        once: (event, callback) => { assert.equal(event, 'message'); onMessage = callback; },
        send: message => messages.push(message), disconnect: () => {},
    };
    const builtins = {
        'node:fs': new Proxy({}, { get: (_, key) => blocked('fs.' + String(key)) }),
        'node:os': require('node:os'), 'node:path': require('node:path'),
        'node:child_process': { fork: blocked('fork'), execFileSync: blocked('execFileSync') },
        'node:crypto': require('node:crypto'), 'node:perf_hooks': require('node:perf_hooks'),
    };
    vm.runInNewContext(source, {
        process: processStub,
        console: { log: () => {}, error: message => errors.push(message) },
        require: name => Object.hasOwn(builtins, name) ? builtins[name] : blocked('require ' + name)(),
    });
    await new Promise(resolve => setImmediate(resolve));
    if (workerConfig) await onMessage(workerConfig);
    return { calls, errors, messages, exitCode: processStub.exitCode };
}

for (const [name, args, live] of [
    ['explicit OLD offline', ['--modes=OLD'], false],
    ['explicit OLD live', ['--modes=OLD'], true],
    ['explicit OLD/NEW pair', ['--modes=OLD,NEW'], true],
    ['explicit NEW/OLD pair', ['--modes=NEW,OLD'], true],
    ['slash-separated pair', ['--modes=OLD/NEW'], true],
    ['repeated mode flags', ['--modes=NEW', '--modes=OLD'], true],
    ['default paired live run', ['/unused/results.json'], true],
]) {
    test('benchmark retires ' + name + ' before any provider I/O', async () => {
        const result = await entry(args, live);
        assert.deepEqual(result.calls, [], 'no fixture/output, child process, or production import');
        assert.equal(result.exitCode, 1);
        assert.match(result.errors.join('\n'), /BENCHMARK_OLD_RETIRED/);
        assert.match(result.errors.join('\n'), /OLD.*retired.*Phase 3/);
        assert.match(result.errors.join('\n'), /checkout.*historical revision.*separate.*version/);
        assert.match(result.errors.join('\n'), /no hidden cold option/);
    });
}

test('direct OLD worker message rejects before production imports', async () => {
    const result = await entry(['--benchmark-worker'], true, { mode: 'OLD', task: 'T1' });
    assert.deepEqual(result.calls, []);
    assert.equal(result.exitCode, 1);
    assert.equal(result.messages[0].result.errorCode, 'BENCHMARK_OLD_RETIRED');
});

test('explicit NEW preserves the live gate offline', async () => {
    const result = await entry(['--modes=NEW'], false);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, undefined);
});

test('explicit NEW live reaches output reservation without OLD retirement', async () => {
    const result = await entry(['--modes=NEW', '/unused/results.json'], true);
    assert.deepEqual(result.calls, ['fs.openSync']);
    assert.doesNotMatch(result.errors.join('\n'), /BENCHMARK_OLD_RETIRED/);
});
