'use strict';

// Conformance suite (SPEC-SQUAD-P1 §11.1): every registered runtime must pass.
// Live probes run only with OMNI_SQUAD_LIVE=1 and the CLI installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { defaultRegistry, CAPABILITY_KEYS, defineRuntime } = require('../lib/squad/runtimes');
const { fakeSpawn } = require('./helpers/squad-fakes');

const HOSTILE = 'fix "it"; rm -rf / $(whoami) `id` \n next line';
const goodTurn = { prompt: HOSTILE, cwd: path.resolve('/work'), model: 'some-model', permission: 'read-only', timeoutMs: 120_000 };
const resolved = { found: true, command: '/opt/node', prefixArgs: ['/opt/cli.js'], path: '/opt/cli.js', source: 'shim' };

for (const runtime of defaultRegistry.list()) {
    test(`${runtime.id}: descriptor passes the schema with all capability keys`, () => {
        assert.doesNotThrow(() => defineRuntime({ ...runtime }));
        assert.deepEqual(Object.keys(runtime.capabilities).sort(), [...CAPABILITY_KEYS].sort());
    });

    test(`${runtime.id}: declared capabilities have their methods`, () => {
        if (runtime.capabilities.resume) assert.equal(typeof runtime.buildResume, 'function');
        if (runtime.capabilities.interactive) assert.equal(typeof runtime.interactiveCommand, 'function');
        if (runtime.capabilities.transcript) assert.equal(typeof runtime.readTranscript, 'function');
        if (runtime.capabilities.headless) assert.equal(typeof runtime.parseResult, 'function');
    });

    test(`${runtime.id}: parseResult never throws on hostile output`, () => {
        for (const raw of [{ exitCode: 0, stdout: '' }, { exitCode: 0, stdout: 'not json' }, { exitCode: 0, stdout: '[1,2]' },
            { exitCode: 0, stdout: '{"type":42}' }, { exitCode: 1, stdout: '{}' }, { timedOut: true, exitCode: null, stdout: '' }]) {
            const result = runtime.parseResult(raw, {});
            assert.ok(['succeeded', 'failed', 'unknown'].includes(result.completion));
            assert.ok(Array.isArray(result.deniedActions));
            if (result.completion !== 'succeeded') assert.match(result.errorCode, /^SQUAD_RUNTIME_/);
        }
    });

    test(`${runtime.id}: a refused prespawnGuard stops the probe before any spawn`, async () => {
        const spawnImpl = fakeSpawn(() => ({ stdout: '1.0.0' }));
        const refusal = new Error('lease revoked');
        await assert.rejects(runtime.version({ platform: 'linux', homedir: '/nowhere', env: {}, resolved, timeoutMs: 1000, spawnImpl,
            prespawnGuard: () => { throw refusal; } }), (error) => error === refusal);
        assert.equal(spawnImpl.calls.length, 0);
    });

    test(`${runtime.id}: prompt is one argv element, verbatim, and redacted in logs`, () => {
        const inv = runtime.buildHeadless(goodTurn, { resolved });
        assert.ok(inv.args.every((a) => typeof a === 'string'));
        assert.equal(inv.args.filter((a) => a === HOSTILE).length, 1);
        assert.ok(path.isAbsolute(inv.cwd));
        assert.ok(!inv.redactedArgs.includes(HOSTILE));
        assert.equal(inv.redactedArgs.length, inv.args.length);
    });

    test(`${runtime.id}: detected prefixArgs lead the argv`, () => {
        const inv = runtime.buildHeadless(goodTurn, { resolved });
        assert.equal(inv.command, '/opt/node');
        assert.equal(inv.args[0], '/opt/cli.js');
    });

    test(`${runtime.id}: malformed turns are rejected`, () => {
        const bad = [
            { ...goodTurn, cwd: 'relative/dir' },
            { ...goodTurn, timeoutMs: 0 },
            { ...goodTurn, model: '  ' },
            { ...goodTurn, effort: 'warp-speed' },
            { ...goodTurn, prompt: 'x'.repeat(256 * 1024 + 1) },
            { ...goodTurn, surprise: true },
        ];
        for (const turn of bad) assert.throws(() => runtime.buildHeadless(turn), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    });

    test(`${runtime.id}: read-only is never dangerous; full-auto needs an isolated root`, () => {
        assert.ok(!runtime.permissionFlags('read-only').join(' ').includes('dangerously'));
        assert.throws(() => runtime.permissionFlags('full-auto'), { code: 'SQUAD_RUNTIME_UNSAFE_PERMISSION' });
        assert.ok(runtime.permissionFlags('full-auto', { isolatedRoot: true }).length > 0);
    });

    test(`${runtime.id}: probes never throw and report timeouts`, async () => {
        const ctx = { platform: 'linux', homedir: '/nowhere', env: {}, resolved, timeoutMs: 30, spawnImpl: fakeSpawn(() => ({ hang: true })) };
        const v = await runtime.version(ctx);
        assert.equal(v.code, 'SQUAD_RUNTIME_PROBE_TIMEOUT');
        assert.equal(v.raw.timedOut, true, 'the spawn result rides along for legacy retry classification');
        const a = await runtime.authStatus({ ...ctx, cache: new Map() });
        assert.ok(['unknown', 'unauthenticated'].includes(a.state));
        const m = await runtime.listModels({ ...ctx, cache: new Map(), fsImpl: { statSync() { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } } });
        assert.equal(typeof m.ok, 'boolean');
    });
}

test('lib/squad does not require lib/dual or lib/harness', () => {
    const root = path.join(__dirname, '..', 'lib', 'squad');
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    });
    walk(root);
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(text, /require\(['"][^'"]*(?:\/dual\/|\/harness\/|\/dual['"]|\/harness['"])/, path.relative(root, file));
    }
});

test('live probe of installed CLIs', { skip: process.env.OMNI_SQUAD_LIVE !== '1' }, async () => {
    const reports = await defaultRegistry.probeAll({ timeoutMs: 40_000 });
    for (const r of reports.filter((x) => x.detect.found)) {
        assert.equal(typeof r.ready, 'boolean', r.id);
        assert.ok(r.version, r.id);
        assert.ok(['authenticated', 'unauthenticated', 'unknown'].includes(r.auth.state), r.id);
    }
});
