'use strict';

// Parity between the squad adapters and the legacy dual probes they will
// replace in P3 (SPEC-SQUAD-P1 §10): on real CLI output both must agree, so
// the later switch cannot silently change what dual accepts.

const test = require('node:test');
const assert = require('node:assert/strict');
const agy = require('../lib/squad/runtimes/agy');
const { probeContext } = require('../lib/squad/runtimes/contract');
const { parseAgyModelsOutput, parseAgyVersionOutput } = require('../lib/dual/capability-preflight');
const { codexPathCandidates, agyPathCandidates } = require('../lib/dual/binary-paths');
const codex = require('../lib/squad/runtimes/codex');
const { fakeSpawn } = require('./helpers/squad-fakes');

// Byte-for-byte output of agy 1.4.12 (2026-11-01); the progress line goes to stderr.
const AGY_VERSION_STDOUT = '1.4.12\n';
const AGY_MODELS_STDOUT = [
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n') + '\n';
const AGY_MODELS_STDERR = 'Fetching available models...\n';

const ctx = (script) => probeContext({ platform: 'linux', homedir: '/home/me', env: {},
    resolved: { found: true, command: '/bin/agy', prefixArgs: [], path: '/bin/agy', source: 'candidate' },
    spawnImpl: fakeSpawn(script) });

test('agy version: adapter and preflight parser read the same version', async () => {
    const v = await agy.version(ctx(() => ({ stdout: AGY_VERSION_STDOUT })));
    assert.equal(v.version, parseAgyVersionOutput(AGY_VERSION_STDOUT));
});

test('agy models: every model the adapter lists is accepted by the preflight parser', async () => {
    const r = await agy.listModels(ctx(() => ({ stdout: AGY_MODELS_STDOUT, stderr: AGY_MODELS_STDERR })));
    assert.equal(r.models.length, 6);
    for (const { id } of r.models) assert.equal(parseAgyModelsOutput(AGY_MODELS_STDOUT, id), true, id);
    assert.equal(parseAgyModelsOutput(AGY_MODELS_STDOUT, 'gemini-9-ultra'), false);
});

test('legacy dual candidates are a prefix-compatible subset of the adapter candidates', () => {
    const homedir = '/home/me';
    const adapterCodex = codex.binary.extraCandidates(probeContext({ platform: 'linux', homedir, env: {} }));
    const adapterAgy = agy.binary.extraCandidates(probeContext({ platform: 'linux', homedir, env: {} }));
    // legacy = per-user dirs (shared) + its own historical fallback
    assert.deepEqual(codexPathCandidates({ homedir, env: {} }).slice(0, 2), adapterCodex.slice(0, 2));
    assert.deepEqual(agyPathCandidates({ homedir, env: {} }).slice(0, 2), adapterAgy);
});
