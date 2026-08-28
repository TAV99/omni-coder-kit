'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    spawnBoundedProcess,
    parseAgyModelsOutput,
    parseAgyVersionOutput,
    validateCapabilityResult,
    runCapabilityPreflight,
} = require('../lib/dual/capability-preflight');
const { createAuthorityStore } = require('../lib/dual/authority-store');

function createMockChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killed = false;
    child.kill = (signal) => {
        killed = true;
        child.killed = true;
        child.killSignal = signal;
        return true;
    };
    child.isKilled = () => killed;
    return child;
}

test('P0-G1 / P0-G2: Capability Preflight Bounded Primitive & Exact Models', async (t) => {
    await t.test('1. timeout settles and kills child with fail-closed result', async () => {
        const mockChild = createMockChild();
        const spawnImpl = (cmd, args, opts) => mockChild;

        const resPromise = spawnBoundedProcess('agy', ['--version'], {
            spawnImpl,
            timeoutMs: 50,
        });

        const res = await resPromise;
        assert.equal(res.ok, false);
        assert.equal(res.timedOut, true);
        assert.ok(/TIMEOUT/i.test(res.error));
        assert.equal(mockChild.isKilled(), true);
    });

    await t.test('2. stdout overflow and stderr overflow kill child and fail closed', async () => {
        // Stdout overflow
        const child1 = createMockChild();
        const spawn1 = () => child1;
        const resPromise1 = spawnBoundedProcess('agy', ['models'], {
            spawnImpl: spawn1,
            maxOutputBytes: 100,
            timeoutMs: 1000,
        });

        child1.stdout.write('A'.repeat(101));
        const res1 = await resPromise1;
        assert.equal(res1.ok, false);
        assert.equal(res1.overflow, true);
        assert.ok(/STDOUT_OVERFLOW|OVERFLOW/i.test(res1.error));
        assert.equal(child1.isKilled(), true);

        // Stderr overflow
        const child2 = createMockChild();
        const spawn2 = () => child2;
        const resPromise2 = spawnBoundedProcess('agy', ['models'], {
            spawnImpl: spawn2,
            maxOutputBytes: 100,
            timeoutMs: 1000,
        });

        child2.stderr.write('E'.repeat(101));
        const res2 = await resPromise2;
        assert.equal(res2.ok, false);
        assert.equal(res2.overflow, true);
        assert.ok(/STDERR_OVERFLOW|OVERFLOW/i.test(res2.error));
        assert.equal(child2.isKilled(), true);
    });

    await t.test('3. synchronous spawn throw settles fail-closed without unhandled rejection', async () => {
        const spawnImpl = () => {
            throw new Error('spawn ENOENT');
        };

        const res = await spawnBoundedProcess('agy', ['--version'], {
            spawnImpl,
            timeoutMs: 1000,
        });

        assert.equal(res.ok, false);
        assert.ok(/spawn ENOENT/i.test(res.error));
    });

    await t.test('4. error then late close, and timeout then late close, settle exactly once', async () => {
        // Error then late close
        const child1 = createMockChild();
        const spawn1 = () => child1;
        const resPromise1 = spawnBoundedProcess('agy', ['--version'], {
            spawnImpl: spawn1,
            timeoutMs: 1000,
        });

        child1.emit('error', new Error('Child crashed'));
        child1.emit('close', 0); // late close must not turn this into ok: true
        const res1 = await resPromise1;
        assert.equal(res1.ok, false);
        assert.ok(/Child crashed/i.test(res1.error));

        // Timeout then late close
        const child2 = createMockChild();
        const spawn2 = () => child2;
        const resPromise2 = spawnBoundedProcess('agy', ['--version'], {
            spawnImpl: spawn2,
            timeoutMs: 50,
        });

        await new Promise((r) => setTimeout(r, 70));
        child2.emit('close', 0); // late close must not override timeout
        const res2 = await resPromise2;
        assert.equal(res2.ok, false);
        assert.equal(res2.timedOut, true);
    });

    await t.test('5. shell:false, windowsHide:true, stdio:ignore,pipe,pipe, exact argv on spawn', async () => {
        let capturedArgs = null;
        let capturedOpts = null;
        const child = createMockChild();
        const spawnImpl = (cmd, args, opts) => {
            capturedArgs = { cmd, args };
            capturedOpts = opts;
            return child;
        };

        const p = spawnBoundedProcess('agy', ['models', '--json'], {
            spawnImpl,
            timeoutMs: 1000,
            cwd: '/test/cwd',
        });

        child.stdout.write('[]');
        child.emit('close', 0);
        const res = await p;

        assert.equal(res.ok, true);
        assert.equal(capturedArgs.cmd, 'agy');
        assert.deepEqual(capturedArgs.args, ['models', '--json']);
        assert.equal(capturedOpts.shell, false);
        assert.equal(capturedOpts.windowsHide, true);
        assert.deepEqual(capturedOpts.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(capturedOpts.cwd, '/test/cwd');
    });

    await t.test('6. child.kill() throwing does not unhandle error and still settles fail-closed', async () => {
        const child = createMockChild();
        child.kill = () => {
            throw new Error('EPERM kill failed');
        };
        const spawnImpl = () => child;

        const resPromise = spawnBoundedProcess('agy', ['--version'], {
            spawnImpl,
            timeoutMs: 50,
        });

        const res = await resPromise;
        assert.equal(res.ok, false);
        assert.equal(res.timedOut, true);
    });

    await t.test('7. exact JSON and text model parsing plus substring/preview/prose rejection', () => {
        // Valid JSON array of strings
        assert.equal(parseAgyModelsOutput(JSON.stringify(['gemini-3.7-flash-high', 'gemini-2.0-flash'])), true);
        // Valid JSON array of objects
        assert.equal(parseAgyModelsOutput(JSON.stringify([{ id: 'gemini-3.7-flash-high' }])), true);
        assert.equal(parseAgyModelsOutput(JSON.stringify([{ name: 'gemini-3.7-flash-high' }])), true);
        assert.equal(parseAgyModelsOutput(JSON.stringify([{ model: 'gemini-3.7-flash-high' }])), true);
        // Valid JSON container
        assert.equal(parseAgyModelsOutput(JSON.stringify({ models: [{ id: 'gemini-3.7-flash-high' }] })), true);

        // Valid tab/whitespace table
        const validTable = 'Model\tInput price\tOutput price\ngemini-3.7-flash-high\t$0.00\t$0.00\ngemini-2.0-flash\t$0.00\t$0.00\n';
        assert.equal(parseAgyModelsOutput(validTable), true);

        // Strict rejection of preview, prefix, suffix, and prose
        assert.equal(parseAgyModelsOutput(JSON.stringify(['gemini-3.7-flash-high-preview'])), false);
        assert.equal(parseAgyModelsOutput(JSON.stringify([{ id: 'gemini-3.7-flash-high-preview' }])), false);
        assert.equal(parseAgyModelsOutput('Model\npreview-gemini-3.7-flash-high\n'), false);
        assert.equal(parseAgyModelsOutput('Model\ngemini-3.7-flash-high-preview\t$0.00\n'), false);
        assert.equal(parseAgyModelsOutput('The model gemini-3.7-flash-high is available for use.'), false);
        assert.equal(parseAgyModelsOutput(''), false);
        assert.equal(parseAgyModelsOutput(null), false);
        assert.equal(parseAgyModelsOutput('{ invalid json }'), false);
    });

    await t.test('8. parseAgyVersionOutput extracts non-empty version and rejects empty/garbage', () => {
        assert.equal(parseAgyVersionOutput('agy version 1.1.19\n'), '1.1.19');
        assert.equal(parseAgyVersionOutput('1.2.3'), '1.2.3');
        assert.equal(parseAgyVersionOutput('agy 2.0.0-beta.1\n'), '2.0.0-beta.1');
        assert.equal(parseAgyVersionOutput(''), null);
        assert.equal(parseAgyVersionOutput('   \n'), null);
        assert.equal(parseAgyVersionOutput('garbage 1.2.3'), null);
        assert.equal(parseAgyVersionOutput('agy version 1.2.3 trailing prose'), null);
        assert.equal(parseAgyVersionOutput(null), null);
    });

    await t.test('8b. capability result validator requires exact durable AGY evidence', () => {
        assert.deepEqual(
            validateCapabilityResult({
                status: 'PASSED',
                to_state: 'CAPABILITY_SAFE',
                checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
                details: {
                    agy_version: '1.1.19',
                    agy_model: 'gemini-3.7-flash-high',
                },
            }),
            {
                valid: true,
                version: '1.1.19',
                model: 'gemini-3.7-flash-high',
            }
        );

        const missingEvidence = validateCapabilityResult({
            status: 'PASSED',
            to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        });
        assert.equal(missingEvidence.valid, false);
        assert.match(missingEvidence.reason, /durable AGY version\/model evidence/i);

        const previewModel = validateCapabilityResult({
            status: 'PASSED',
            to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: {
                agy_version: '1.1.19',
                agy_model: 'gemini-3.7-flash-high-preview',
            },
        });
        assert.equal(previewModel.valid, false);
    });

    await t.test('9. injected version/models and live run produce exact durable details in runCapabilityPreflight', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-test-'));
        try {
            const authorityStore = createAuthorityStore(path.join(tmpDir, '.omni', 'runs', 'dual-authority'));
            fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
            fs.writeFileSync(path.join(tmpDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));

            // Test injected success
            const resInjected = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high'],
            });
            assert.equal(resInjected.status, 'PASSED');
            assert.equal(resInjected.to_state, 'CAPABILITY_SAFE');
            assert.equal(resInjected.details.agy_version, '1.1.19');
            assert.equal(resInjected.details.agy_model, 'gemini-3.7-flash-high');

            // Test injected rejection of preview model
            const resInjectedBad = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                agyVersion: '1.1.19',
                agyModels: ['gemini-3.7-flash-high-preview'],
            });
            assert.equal(resInjectedBad.status, 'BLOCKED');
            assert.equal(resInjectedBad.to_state, 'BLOCKED');

            const malformedVersion = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                agyVersion: 'definitely-not-a-version',
                agyModels: ['gemini-3.7-flash-high'],
            });
            assert.equal(malformedVersion.status, 'BLOCKED');

            const missingDurableEvidence = await runCapabilityPreflight(tmpDir, {
                authorityStore,
                checkAgy: async () => ({ name: 'agy_cli_and_model', status: 'PASSED' }),
            });
            assert.equal(missingDurableEvidence.status, 'BLOCKED');
            assert.equal(missingDurableEvidence.details.agy_version, undefined);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    await t.test('10. invalid timeout/output bounds fail closed before spawn', async () => {
        let spawnCalls = 0;
        const spawnImpl = () => {
            spawnCalls += 1;
            return createMockChild();
        };
        for (const options of [
            { timeoutMs: 0, maxOutputBytes: 100 },
            { timeoutMs: Number.POSITIVE_INFINITY, maxOutputBytes: 100 },
            { timeoutMs: 100, maxOutputBytes: 0 },
            { timeoutMs: 100, maxOutputBytes: 1.5 },
        ]) {
            const result = await spawnBoundedProcess('agy', ['--version'], { spawnImpl, ...options });
            assert.equal(result.ok, false);
            assert.match(result.error, /invalid.*(timeout|maxOutputBytes)|bounded process options/i);
        }
        assert.equal(spawnCalls, 0);
    });
});
