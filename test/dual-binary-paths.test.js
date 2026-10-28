'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codexPathCandidates, resolveCodexPath, agyPathCandidates, resolveAgyPath,
    restoreCommands } = require('../lib/dual/binary-paths');

const homedir = '/fixture/home';
function options(existing = [], env = {}) {
    const paths = new Set(existing);
    return { homedir, env, fsImpl: { existsSync: (candidate) => paths.has(candidate) } };
}

for (const [binary, candidates, resolve, key, fallback] of [
    ['codex', codexPathCandidates, resolveCodexPath, 'OMNI_CODEX_PATH', '/usr/bin/codex'],
    ['agy', agyPathCandidates, resolveAgyPath, 'OMNI_AGY_PATH', 'agy'],
]) {
    const local = `${homedir}/.local/bin/${binary}`;
    const homeBin = `${homedir}/bin/${binary}`;
    const override = `/custom/${binary}`;

    test(`${binary}: candidates preserve priority and env override wins`, () => {
        const opts = options([override, local, homeBin, fallback], { [key]: override });
        assert.deepEqual(candidates(opts), [override, local, homeBin, fallback]);
        assert.equal(resolve(opts), override);
    });

    test(`${binary}: local wins over home bin and fallback`, () => {
        assert.equal(resolve(options([local, homeBin, fallback])), local);
    });

    test(`${binary}: home bin wins over fallback when local is missing`, () => {
        assert.equal(resolve(options([homeBin, fallback])), homeBin);
    });

    test(`${binary}: missing env override falls through to local`, () => {
        assert.equal(resolve(options([local], { [key]: override })), local);
    });

    test(`${binary}: empty env values are omitted`, () => {
        for (const value of ['', '   ']) {
            const opts = options([local], { [key]: value });
            assert.deepEqual(candidates(opts), [local, homeBin, fallback]);
            assert.equal(resolve(opts), local);
        }
    });
}

test('codex: falls back to /usr when home candidates are missing', () => {
    assert.equal(resolveCodexPath(options(['/usr/bin/codex'])), '/usr/bin/codex');
});

test('codex: returns null when all candidates are missing', () => {
    assert.equal(resolveCodexPath(options()), null);
});

test('agy: falls back to PATH when no absolute candidate exists', () => {
    assert.equal(resolveAgyPath(options()), 'agy');
    assert.equal(resolveAgyPath(options(['relative/agy', 'agy'], { OMNI_AGY_PATH: 'relative/agy' })), 'agy');
});

test('restoreCommands: returns pinned install and worktree symlink argv arrays', () => {
    assert.deepEqual(restoreCommands({ worktree: '/fixture/work tree', homedir }), [
        ['npm', 'i', '-g', '--prefix', '/fixture/home/.local', '@openai/codex@0.164.0'],
        ['ln', '-sf', '/fixture/work tree/bin/omni.js', '/fixture/home/.local/bin/omni'],
    ]);
});
