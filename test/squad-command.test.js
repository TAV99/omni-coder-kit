'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSquadRuntimes } = require('../lib/commands/squad');

function registryOf(reports) {
    return {
        list: () => reports.map((r) => ({ id: r.id })),
        probeAll: async () => reports,
        probe: async (id) => {
            const r = reports.find((x) => x.id === id);
            if (!r) throw Object.assign(new Error(`Unknown runtime: ${id}`), { code: 'SQUAD_RUNTIME_UNKNOWN' });
            return r;
        },
    };
}
const report = (id, ready) => ({
    id, displayName: id, ready, problems: ready ? [] : [{ code: 'SQUAD_RUNTIME_UNAUTHENTICATED', message: 'Not logged in', fix: 'log in' }],
    detect: { found: true, path: `/bin/${id}` }, version: { ok: true, version: '1.0.0' },
    auth: { state: ready ? 'authenticated' : 'unauthenticated', method: null }, models: { ok: true, models: [{ id: 'm' }] },
});

test('--json prints RuntimeReport[] and exits 0 when one runtime is ready', async () => {
    const out = [];
    const { exitCode } = await runSquadRuntimes({ registry: registryOf([report('a', true), report('b', false)]), json: true, write: (s) => out.push(s) });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(out.join('')).map((r) => r.id), ['a', 'b']);
});

test('exits 1 when nothing is ready, and shows the fix', async () => {
    const out = [];
    const { exitCode } = await runSquadRuntimes({ registry: registryOf([report('b', false)]), write: (s) => out.push(s) });
    assert.equal(exitCode, 1);
    assert.match(out.join('\n'), /log in/);
});

test('exits 2 on an unknown runtime or a bad timeout', async () => {
    const quiet = () => {};
    assert.equal((await runSquadRuntimes({ registry: registryOf([]), runtime: 'nope', write: quiet })).exitCode, 2);
    assert.equal((await runSquadRuntimes({ registry: registryOf([]), timeoutMs: 'soon', write: quiet })).exitCode, 2);
});
