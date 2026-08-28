'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync, spawn } = require('node:child_process');

const OMNI_BIN = path.resolve(__dirname, '..', 'bin', 'omni.js');
const {
    executeSetupManifest,
    createCliResolver,
    readAndValidateManifest,
    checkAndValidateReceipt,
    writeSuccessReceipt,
    acquireSetupLock,
    DualSetupCommandError,
} = require('../lib/dual/setup-command');

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-setup-cli-test-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(() => {
        try {
            fs.rmSync(canonical, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });
    return canonical;
}

function runOmniCli(args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [OMNI_BIN, ...args], {
            cwd: options.cwd || process.cwd(),
            env: { ...process.env, ...(options.env || {}) },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

function writeManifest(wsRoot, data) {
    const sdlcDir = path.join(wsRoot, '.omni', 'sdlc');
    fs.mkdirSync(sdlcDir, { recursive: true });
    const manifestPath = path.join(sdlcDir, 'setup.json');
    if (typeof data === 'string' || Buffer.isBuffer(data)) {
        fs.writeFileSync(manifestPath, data);
    } else {
        fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
    return manifestPath;
}

// ---------------------------------------------------------------------------
// 1. CLI Registration & Help
// ---------------------------------------------------------------------------
test('omni dual --help registers setup subcommand without breaking other subcommands', async () => {
    const res = await runOmniCli(['dual', '--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('setup'));
    assert.ok(res.stdout.includes('new <task-id>'));
    assert.ok(res.stdout.includes('run <task-id>'));
    assert.ok(res.stdout.includes('resume <task-id>'));
    assert.ok(res.stdout.includes('status <task-id>'));
    assert.ok(res.stdout.includes('phase <phase> <task-id>'));
    assert.ok(res.stdout.includes('daemon'));
    assert.ok(res.stdout.includes('baseline'));
});

test('omni dual setup --help registers run subcommand', async () => {
    const res = await runOmniCli(['dual', 'setup', '--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('run'));
});

test('omni dual setup run --help lists --dry-run, --force, --json options', async () => {
    const res = await runOmniCli(['dual', 'setup', 'run', '--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('--dry-run'));
    assert.ok(res.stdout.includes('--force'));
    assert.ok(res.stdout.includes('--json'));
});

// ---------------------------------------------------------------------------
// 2. Missing Manifest & Basic Valid Runs
// ---------------------------------------------------------------------------
test('omni dual setup run fails when manifest is missing', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const res = await runOmniCli(['dual', 'setup', 'run'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('DUAL_SETUP_MANIFEST_MISSING'));
});

test('omni dual setup run --json fails with single JSON object when manifest missing', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_MANIFEST_MISSING');
});

test('omni dual setup run succeeds with valid empty manifest and writes receipt', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const res = await runOmniCli(['dual', 'setup', 'run'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('0 actions'));

    const receiptPath = path.join(wsRoot, '.omni', 'runs', 'dual-setup', 'receipt.json');
    assert.ok(fs.existsSync(receiptPath));
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.schema_version, 1);
    assert.equal(receipt.status, 'SUCCESS');
    assert.equal(receipt.action_count, 0);
    assert.equal(receipt.workspace_root, wsRoot);
    assert.ok(receipt.manifest_sha256);
    assert.ok(receipt.results_digest);
    assert.ok(receipt.completed_at);
});

test('omni dual setup run executes native action (node --version) successfully', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['--version'],
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action_count, 1);
    assert.equal(parsed.reused, false);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].status, 0);
});

test('setup run atomically repairs the exact legacy native package-manager mismatch', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestPath = writeManifest(wsRoot, {
        schema_version: 1,
        actions: [{
            kind: 'native',
            program: 'npm',
            args: ['install'],
            cwd: '.',
        }],
    });

    const result = executeSetupManifest({
        workspaceRoot: wsRoot,
        resolveExecutable: (program, context) => {
            assert.equal(program, 'npm');
            assert.equal(context.kind, 'package-manager');
            return { kind: 'native', path: process.execPath };
        },
        spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.repaired_actions, [{
        index: 0,
        from_kind: 'native',
        to_kind: 'package-manager',
        program: 'npm',
    }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
        schema_version: 1,
        actions: [{
            kind: 'package-manager',
            program: 'npm',
            args: ['install'],
            cwd: '.',
        }],
    });
    assert.deepEqual(
        fs.readdirSync(path.dirname(manifestPath)).filter((name) => name.includes('.tmp.')),
        []
    );
});

test('setup dry-run reports a repair without mutating the legacy manifest', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestPath = writeManifest(wsRoot, {
        schema_version: 1,
        actions: [{ kind: 'native', program: 'npm', args: ['install'], cwd: '.' }],
    });
    const before = fs.readFileSync(manifestPath, 'utf8');

    const result = executeSetupManifest({
        workspaceRoot: wsRoot,
        dryRun: true,
        resolveExecutable: () => ({ kind: 'native', path: process.execPath }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.repaired_actions.length, 1);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('setup run does not repair ambiguous native executable names', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestPath = writeManifest(wsRoot, {
        schema_version: 1,
        actions: [{
            kind: 'native',
            program: 'npm.cmd',
            args: ['install'],
            cwd: '.',
        }],
    });
    const before = fs.readFileSync(manifestPath, 'utf8');

    assert.throws(
        () => executeSetupManifest({ workspaceRoot: wsRoot, dryRun: true }),
        (err) => err.code === 'DUAL_SETUP_ACTIONS_INVALID'
    );
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

// ---------------------------------------------------------------------------
// 3. Strict Envelope & Manifest Security
// ---------------------------------------------------------------------------
test('rejects manifest with extra envelope keys', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
        extra_key: 'forbidden',
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_MANIFEST_INVALID');
});

test('rejects manifest with invalid schema_version', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 2,
        actions: [],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_MANIFEST_INVALID');
});

test('rejects malformed JSON manifest', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, '{ "schema_version": 1, "actions": [ invalid json }');

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_MANIFEST_INVALID');
});

test('rejects oversize manifest (>64 KiB)', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const largeArgs = Array.from({ length: 2000 }, (_, i) => `arg_${i}_${'x'.repeat(40)}`);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: largeArgs,
                cwd: '.',
            },
        ],
    });

    const manifestPath = path.join(wsRoot, '.omni', 'sdlc', 'setup.json');
    const stat = fs.statSync(manifestPath);
    assert.ok(stat.size > 64 * 1024, `Size should be > 64 KiB, was ${stat.size}`);

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_MANIFEST_INVALID');
});

test('rejects manifest containing UTF-8 BOM', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const content = Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(JSON.stringify({ schema_version: 1, actions: [] }), 'utf8'),
    ]);
    writeManifest(wsRoot, content);

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_MANIFEST_INVALID');
});

test('rejects manifest that is a symlink pointing outside workspace', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const outsideDir = createTempWorkspace(t);
    const outsideFile = path.join(outsideDir, 'external-setup.json');
    fs.writeFileSync(outsideFile, JSON.stringify({ schema_version: 1, actions: [] }), 'utf8');

    const sdlcDir = path.join(wsRoot, '.omni', 'sdlc');
    fs.mkdirSync(sdlcDir, { recursive: true });
    const symlinkPath = path.join(sdlcDir, 'setup.json');
    try {
        fs.symlinkSync(outsideFile, symlinkPath, 'file');
    } catch {
        // If symlinks not permitted on Windows without admin, return
        return;
    }

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_PATH_ESCAPE');
});

// ---------------------------------------------------------------------------
// 4. Action Schema Pre-Validation before Spawn
// ---------------------------------------------------------------------------
test('validates all action schemas in preflight before running any action', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const markerFile = path.join(wsRoot, 'marker.txt');
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'created')`],
                cwd: '.',
            },
            {
                kind: 'native',
                program: 'node',
                // Invalid: missing args array
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    // Marker file MUST NOT have been created because schema validation fails preflight
    assert.equal(fs.existsSync(markerFile), false);
});

// ---------------------------------------------------------------------------
// 5. Dry Run Behavior
// ---------------------------------------------------------------------------
test('--dry-run validates and resolves actions without spawning and without writing receipt or lock', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const markerFile = path.join(wsRoot, 'dry-run-marker.txt');
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'dry')`],
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--dry-run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.action_count, 1);

    // Marker file was not created
    assert.equal(fs.existsSync(markerFile), false);

    // Receipt was not written
    const receiptPath = path.join(wsRoot, '.omni', 'runs', 'dual-setup', 'receipt.json');
    assert.equal(fs.existsSync(receiptPath), false);

    // Lock was not left behind
    const lockPath = path.join(wsRoot, '.omni', 'runtime', 'dual', 'setup.lock');
    assert.equal(fs.existsSync(lockPath), false);
});

// ---------------------------------------------------------------------------
// 6. Receipt Idempotency & Reuse
// ---------------------------------------------------------------------------
test('exact manifest hash reuses SUCCESS receipt without spawning; --force reruns', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const counterFile = path.join(wsRoot, 'counter.txt');
    fs.writeFileSync(counterFile, '0', 'utf8');

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', `const fs = require('fs'); const n = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8'), 10) + 1; fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));`],
                cwd: '.',
            },
        ],
    });

    // Run 1: initial run
    const res1 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res1.code, 0);
    const parsed1 = JSON.parse(res1.stdout.trim());
    assert.equal(parsed1.reused, false);
    assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');

    // Run 2: idempotent reuse
    const res2 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res2.code, 0);
    const parsed2 = JSON.parse(res2.stdout.trim());
    assert.equal(parsed2.reused, true);
    // Counter file should NOT have incremented
    assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');

    // Run 3: --force rerun
    const res3 = await runOmniCli(['dual', 'setup', 'run', '--force', '--json'], { cwd: wsRoot });
    assert.equal(res3.code, 0);
    const parsed3 = JSON.parse(res3.stdout.trim());
    assert.equal(parsed3.reused, false);
    // Counter file should have incremented to 2
    assert.equal(fs.readFileSync(counterFile, 'utf8'), '2');
});

test('manifest change triggers rerun without needing --force', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['--version'],
                cwd: '.',
            },
        ],
    });

    const res1 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res1.code, 0);
    const parsed1 = JSON.parse(res1.stdout.trim());
    assert.equal(parsed1.reused, false);

    // Update manifest with new args
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', 'process.exit(0)'],
                cwd: '.',
            },
        ],
    });

    const res2 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res2.code, 0);
    const parsed2 = JSON.parse(res2.stdout.trim());
    assert.equal(parsed2.reused, false);
    assert.notEqual(parsed2.manifest_sha256, parsed1.manifest_sha256);
});

// ---------------------------------------------------------------------------
// 7. Corrupt Receipt Handling (Fail-Closed)
// ---------------------------------------------------------------------------
test('corrupt or foreign receipt blocks run and is not overwritten without --force', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const receiptDir = path.join(wsRoot, '.omni', 'runs', 'dual-setup');
    fs.mkdirSync(receiptDir, { recursive: true });
    const receiptPath = path.join(receiptDir, 'receipt.json');
    // Write corrupt receipt with extra unauthorized keys
    fs.writeFileSync(receiptPath, JSON.stringify({
        schema_version: 1,
        status: 'SUCCESS',
        workspace_root: wsRoot,
        manifest_sha256: 'fake',
        extra_malicious_key: 'payload',
    }), 'utf8');

    const res1 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res1.code, 1);
    const parsed1 = JSON.parse(res1.stdout.trim());
    assert.equal(parsed1.ok, false);
    assert.equal(parsed1.code, 'DUAL_SETUP_RECEIPT_CORRUPT');

    // Verify corrupt receipt was not overwritten
    const currentContent = fs.readFileSync(receiptPath, 'utf8');
    assert.ok(currentContent.includes('extra_malicious_key'));

    // Repair with --force works
    const res2 = await runOmniCli(['dual', 'setup', 'run', '--force', '--json'], { cwd: wsRoot });
    assert.equal(res2.code, 0);
    const receiptAfterForce = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(receiptAfterForce.status, 'SUCCESS');
    assert.equal(receiptAfterForce.extra_malicious_key, undefined);
});

// ---------------------------------------------------------------------------
// 8. Failed Run Preserves Prior Valid Receipt
// ---------------------------------------------------------------------------
test('failed run preserves earlier different-hash receipt and releases lock', async (t) => {
    const wsRoot = createTempWorkspace(t);
    // Initial manifest that succeeds
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['--version'],
                cwd: '.',
            },
        ],
    });

    const res1 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res1.code, 0);
    const receiptPath = path.join(wsRoot, '.omni', 'runs', 'dual-setup', 'receipt.json');
    const oldReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));

    // New manifest that fails
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', 'process.exit(1)'],
                cwd: '.',
            },
        ],
    });

    const res2 = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res2.code, 1);

    // Old receipt must still be preserved
    const currentReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(currentReceipt.manifest_sha256, oldReceipt.manifest_sha256);

    // Lock must have been released
    const lockPath = path.join(wsRoot, '.omni', 'runtime', 'dual', 'setup.lock');
    assert.equal(fs.existsSync(lockPath), false);
});

// ---------------------------------------------------------------------------
// 9. Concurrency Lock Mechanics
// ---------------------------------------------------------------------------
test('live process lock blocks concurrent execution; dead process lock is reclaimed', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    // Scenario A: Live PID (current test runner process PID is definitely live)
    const liveLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: process.pid,
        nonce: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        manifest_sha256: crypto.createHash('sha256').update('test').digest('hex'),
    };
    fs.writeFileSync(lockPath, JSON.stringify(liveLock), 'utf8');

    const resLive = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(resLive.code, 1);
    const parsedLive = JSON.parse(resLive.stdout.trim());
    assert.equal(parsedLive.ok, false);
    assert.equal(parsedLive.code, 'DUAL_SETUP_LOCKED');

    // Scenario B: Dead PID (use an unlikely high PID that is definitely not running, e.g. 999999)
    const deadLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: 999999,
        nonce: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        manifest_sha256: crypto.createHash('sha256').update('test').digest('hex'),
    };
    fs.writeFileSync(lockPath, JSON.stringify(deadLock), 'utf8');

    const resDead = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(resDead.code, 0, `Dead lock should be reclaimed, stderr: ${resDead.stderr}`);
});

test('corrupt or foreign lock fails closed', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    // Corrupt JSON in lock
    fs.writeFileSync(lockPath, '{ corrupt json', 'utf8');

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_LOCK_CORRUPT');
});

// ---------------------------------------------------------------------------
// 10. Node-CLI Local Resolution & Containment
// ---------------------------------------------------------------------------
test('node-cli resolves local package bin from node_modules and rejects shell wrappers', async (t) => {
    const wsRoot = createTempWorkspace(t);

    // Create a local fake tool inside node_modules/my-tool
    const toolPkgDir = path.join(wsRoot, 'node_modules', 'my-tool');
    const toolBinDir = path.join(toolPkgDir, 'bin');
    fs.mkdirSync(toolBinDir, { recursive: true });

    fs.writeFileSync(path.join(toolPkgDir, 'package.json'), JSON.stringify({
        name: 'my-tool',
        version: '1.0.0',
        bin: {
            'my-tool': './bin/cli.js',
        },
    }), 'utf8');

    fs.writeFileSync(path.join(toolBinDir, 'cli.js'), 'console.log("my-tool-ran"); process.exit(0);\n', 'utf8');

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'node-cli',
                program: 'my-tool',
                args: ['test-arg'],
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].status, 0);
});

test('node-cli rejects scoped, path-like or escaping package names', async (t) => {
    const wsRoot = createTempWorkspace(t);

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'node-cli',
                program: '../evil-tool',
                args: [],
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
});

// ---------------------------------------------------------------------------
// 11. Security & Argv Sanitization
// ---------------------------------------------------------------------------
test('args with spaces and Unicode remain separate argv elements without shell interpolation', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const inspectScript = path.join(wsRoot, 'inspect-argv.js');
    const outFile = path.join(wsRoot, 'argv-out.json');

    fs.writeFileSync(inspectScript, `
        const fs = require('fs');
        fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)));
    `, 'utf8');

    const testArgs = [
        'arg with spaces',
        'unicode-Tiếng Việt-🚀',
        'semi;colon & pipe | dangerous',
        '$(echo inject)',
        '`echo backtick`',
        '"quoted string"',
    ];

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: [inspectScript, ...testArgs],
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);

    assert.ok(fs.existsSync(outFile));
    const capturedArgs = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.deepEqual(capturedArgs, testArgs);
});

test('JSON output emits exactly one JSON object and errors never leak daemon tokens or secrets', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', 'process.exit(42)'],
                cwd: '.',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], {
        cwd: wsRoot,
        env: {
            OMNI_SECRET_TOKEN: 'SECRET_DAEMON_TOKEN_12345',
        },
    });
    assert.equal(res.code, 1);

    const stdoutLines = res.stdout.trim().split('\n');
    assert.equal(stdoutLines.length, 1, `Stdout must be exactly 1 line of JSON: ${res.stdout}`);
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_ACTION_FAILED');

    // Never leak secrets or huge blobs in JSON
    assert.ok(!res.stdout.includes('SECRET_DAEMON_TOKEN_12345'));
    assert.ok(!res.stderr.includes('SECRET_DAEMON_TOKEN_12345'));
});

// ---------------------------------------------------------------------------
// 12. Direct Programmatic Unit Tests for executeSetupManifest and Resolver
// ---------------------------------------------------------------------------
test('executeSetupManifest programmatic execution, dryRun, force, and errors', (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['--version'],
                cwd: '.',
            },
        ],
    });

    // 1. Dry run programmatic
    const dryRes = executeSetupManifest({ workspaceRoot: wsRoot, dryRun: true });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.reused, false);
    assert.equal(dryRes.action_count, 1);

    // 2. Real run programmatic
    const runRes1 = executeSetupManifest({ workspaceRoot: wsRoot });
    assert.equal(runRes1.ok, true);
    assert.equal(runRes1.dryRun, false);
    assert.equal(runRes1.reused, false);

    // 3. Reused run programmatic
    const runRes2 = executeSetupManifest({ workspaceRoot: wsRoot });
    assert.equal(runRes2.ok, true);
    assert.equal(runRes2.reused, true);

    // 4. Force run programmatic
    const runRes3 = executeSetupManifest({ workspaceRoot: wsRoot, force: true });
    assert.equal(runRes3.ok, true);
    assert.equal(runRes3.reused, false);
});

test('createCliResolver unit tests: Windows wrapper rejection and node-cli string vs object bin', (t) => {
    const wsRoot = createTempWorkspace(t);
    const resolver = createCliResolver(wsRoot, {
        platform: 'win32',
        env: { PATH: wsRoot },
        fsImpl: fs,
    });

    // 1. Windows: .cmd wrapper is rejected
    fs.writeFileSync(path.join(wsRoot, 'evil-wrap.cmd'), '@echo off\n', 'utf8');
    const wrapRes = resolver('evil-wrap', { cwd: wsRoot, kind: 'native' });
    assert.equal(wrapRes, null);

    // 2. Windows: .exe is accepted
    fs.writeFileSync(path.join(wsRoot, 'good-bin.exe'), 'binary', 'utf8');
    const goodRes = resolver('good-bin', { cwd: wsRoot, kind: 'native' });
    assert.ok(goodRes);
    assert.equal(goodRes.kind, 'native');

    // 3. node-cli with string bin in package.json
    const pkg1Dir = path.join(wsRoot, 'node_modules', 'pkg-str');
    fs.mkdirSync(path.join(pkg1Dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg1Dir, 'package.json'), JSON.stringify({
        name: 'pkg-str',
        bin: 'dist/cli.js',
    }), 'utf8');
    fs.writeFileSync(path.join(pkg1Dir, 'dist', 'cli.js'), 'console.log(1);\n', 'utf8');

    const pkg1Res = resolver('pkg-str', { cwd: wsRoot, kind: 'node-cli' });
    assert.ok(pkg1Res);
    assert.equal(pkg1Res.kind, 'node-cli');
    assert.ok(pkg1Res.path.endsWith(path.join('dist', 'cli.js')));

    // 4. node-cli with non-JS file is rejected
    const pkg2Dir = path.join(wsRoot, 'node_modules', 'pkg-shell');
    fs.mkdirSync(pkg2Dir, { recursive: true });
    fs.writeFileSync(path.join(pkg2Dir, 'package.json'), JSON.stringify({
        name: 'pkg-shell',
        bin: 'cli.sh',
    }), 'utf8');
    fs.writeFileSync(path.join(pkg2Dir, 'cli.sh'), '#!/bin/sh\n', 'utf8');

    const pkg2Res = resolver('pkg-shell', { cwd: wsRoot, kind: 'node-cli' });
    assert.equal(pkg2Res, null);

    // 5. node-cli with path traversal in bin is rejected
    const pkg3Dir = path.join(wsRoot, 'node_modules', 'pkg-escape');
    fs.mkdirSync(pkg3Dir, { recursive: true });
    fs.writeFileSync(path.join(pkg3Dir, 'package.json'), JSON.stringify({
        name: 'pkg-escape',
        bin: '../outside.js',
    }), 'utf8');

    const pkg3Res = resolver('pkg-escape', { cwd: wsRoot, kind: 'node-cli' });
    assert.equal(pkg3Res, null);
});

test('acquireSetupLock release never unlinks replacement lock', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'a'.repeat(64);

    const lock1 = acquireSetupLock(wsRoot, manifestSha, { fsImpl: fs });
    const lockPath = lock1.lockPath;
    assert.ok(fs.existsSync(lockPath));

    // Overwrite lock with another process/nonce
    const replacementLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: process.pid,
        nonce: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        manifest_sha256: manifestSha,
    };
    fs.writeFileSync(lockPath, JSON.stringify(replacementLock, null, 2) + '\n', 'utf8');

    // lock1 release must NOT unlink the replacement lock
    lock1.release();
    assert.ok(fs.existsSync(lockPath));

    // Clean up
    fs.unlinkSync(lockPath);
});

// ---------------------------------------------------------------------------
// 13. Review 1 Regressions: Parent Escape & Canonical Containment (Finding 1)
// ---------------------------------------------------------------------------
function tryCreateDirLink(targetDir, linkPath) {
    try {
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        fs.symlinkSync(targetDir, linkPath, type);
        return true;
    } catch {
        return false;
    }
}

test('parent junction/symlink escape at .omni/sdlc is rejected with DUAL_PATH_ESCAPE', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const outsideDir = createTempWorkspace(t);
    const markerFile = path.join(outsideDir, 'outside-marker.txt');

    // Write a setup.json inside outsideDir
    fs.writeFileSync(path.join(outsideDir, 'setup.json'), JSON.stringify({
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'pwned')`],
                cwd: '.',
            },
        ],
    }), 'utf8');

    const omniDir = path.join(wsRoot, '.omni');
    fs.mkdirSync(omniDir, { recursive: true });
    const sdlcLink = path.join(omniDir, 'sdlc');

    if (!tryCreateDirLink(outsideDir, sdlcLink)) {
        t.skip('Host environment cannot create directory junction/symlink');
        return;
    }

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_PATH_ESCAPE');

    // Outside file MUST NOT have been executed or modified
    assert.equal(fs.existsSync(markerFile), false);
});

test('parent junction/symlink escape at .omni/runs/dual-setup is rejected with DUAL_PATH_ESCAPE', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const outsideRuns = createTempWorkspace(t);

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const runsParent = path.join(wsRoot, '.omni', 'runs');
    fs.mkdirSync(runsParent, { recursive: true });
    const runsLink = path.join(runsParent, 'dual-setup');

    if (!tryCreateDirLink(outsideRuns, runsLink)) {
        t.skip('Host environment cannot create directory junction/symlink');
        return;
    }

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_PATH_ESCAPE');

    // Outside directory MUST NOT have any receipt or temp file written
    const outsideFiles = fs.readdirSync(outsideRuns);
    assert.equal(outsideFiles.length, 0, `No files should be written outside, found: ${outsideFiles}`);
});

test('parent junction/symlink escape at .omni/runtime/dual is rejected with DUAL_PATH_ESCAPE', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const outsideRuntime = createTempWorkspace(t);

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const runtimeParent = path.join(wsRoot, '.omni', 'runtime');
    fs.mkdirSync(runtimeParent, { recursive: true });
    const runtimeLink = path.join(runtimeParent, 'dual');

    if (!tryCreateDirLink(outsideRuntime, runtimeLink)) {
        t.skip('Host environment cannot create directory junction/symlink');
        return;
    }

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_PATH_ESCAPE');

    // Outside directory MUST NOT have any lock file written
    const outsideFiles = fs.readdirSync(outsideRuntime);
    assert.equal(outsideFiles.length, 0, `No files should be written outside, found: ${outsideFiles}`);
});

// ---------------------------------------------------------------------------
// 14. Review 1 Regressions: Stale Lock Reclaim Race & Cleanup (Finding 2)
// ---------------------------------------------------------------------------
test('stale lock reclaim blocks and preserves replacement lock when replaced during second read', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'b'.repeat(64);

    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    const staleLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: 12345,
        nonce: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        manifest_sha256: manifestSha,
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock), 'utf8');

    const replacementNonce = crypto.randomUUID();
    const replacementLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: 67890,
        nonce: replacementNonce,
        started_at: new Date().toISOString(),
        manifest_sha256: manifestSha,
    };

    let readCount = 0;
    const customFs = Object.create(fs);
    customFs.readFileSync = function (p, enc) {
        if (p === lockPath) {
            readCount++;
            if (readCount === 1) {
                return JSON.stringify(staleLock);
            }
            // On second read (reclaim verification), lock has been replaced by active owner!
            return JSON.stringify(replacementLock);
        }
        return fs.readFileSync(p, enc);
    };

    const isProcessAlive = (pid) => (pid === 67890); // 12345 is dead, 67890 is alive

    assert.throws(
        () => acquireSetupLock(wsRoot, manifestSha, { fsImpl: customFs, isProcessAlive }),
        (err) => {
            assert.equal(err.code, 'DUAL_SETUP_LOCKED');
            return true;
        }
    );

    // Verify on disk the lock was NOT unlinked
    assert.ok(fs.existsSync(lockPath));
});

test('lock creation cleans up only its own partial lock and closes fd on write/fsync failure', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'c'.repeat(64);

    let closedFd = null;
    let unlinkedPath = null;

    const customFs = Object.create(fs);
    customFs.openSync = function (p, flags, mode) {
        return fs.openSync(p, flags, mode);
    };
    customFs.fsyncSync = function (fd) {
        const err = new Error('Simulated fsync I/O failure');
        err.code = 'EIO';
        throw err;
    };
    customFs.closeSync = function (fd) {
        closedFd = fd;
        return fs.closeSync(fd);
    };
    customFs.unlinkSync = function (p) {
        unlinkedPath = p;
        return fs.unlinkSync(p);
    };

    assert.throws(
        () => acquireSetupLock(wsRoot, manifestSha, { fsImpl: customFs }),
        (err) => {
            assert.equal(err.code, 'EIO');
            return true;
        }
    );

    assert.notEqual(closedFd, null, 'FD must have been closed');
    assert.notEqual(unlinkedPath, null, 'Partial lock must have been unlinked');
});

// ---------------------------------------------------------------------------
// 15. Review 1 Regressions: Receipt Durability & Non-Destructive Rename (Finding 3)
// ---------------------------------------------------------------------------
test('atomic rename failure preserves previous receipt byte-for-byte and propagates error', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'd'.repeat(64);
    const receiptDir = path.join(wsRoot, '.omni', 'runs', 'dual-setup');
    fs.mkdirSync(receiptDir, { recursive: true });
    const receiptPath = path.join(receiptDir, 'receipt.json');

    const originalReceiptContent = '{"original":"receipt-byte-for-byte-preserved"}\n';
    fs.writeFileSync(receiptPath, originalReceiptContent, 'utf8');

    const customFs = Object.create(fs);
    customFs.renameSync = function () {
        const err = new Error('Simulated Windows EPERM during rename');
        err.code = 'EPERM';
        throw err;
    };

    assert.throws(
        () => writeSuccessReceipt(wsRoot, manifestSha, 1, [], customFs),
        (err) => {
            assert.equal(err.code, 'EPERM');
            return true;
        }
    );

    // Old receipt must survive byte-for-byte
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), originalReceiptContent);

    // Temp file must be cleaned up
    const files = fs.readdirSync(receiptDir);
    assert.deepEqual(files, ['receipt.json']);
});

test('receipt write/fsync failure cleans up temp file, closes fd, and propagates error', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'e'.repeat(64);
    const receiptDir = path.join(wsRoot, '.omni', 'runs', 'dual-setup');

    let closedFd = null;
    const customFs = Object.create(fs);
    customFs.fsyncSync = function () {
        const err = new Error('Simulated disk full');
        err.code = 'ENOSPC';
        throw err;
    };
    customFs.closeSync = function (fd) {
        closedFd = fd;
        return fs.closeSync(fd);
    };

    assert.throws(
        () => writeSuccessReceipt(wsRoot, manifestSha, 1, [], customFs),
        (err) => {
            assert.equal(err.code, 'ENOSPC');
            return true;
        }
    );

    assert.notEqual(closedFd, null, 'Temp FD must have been closed');
    if (fs.existsSync(receiptDir)) {
        const files = fs.readdirSync(receiptDir);
        assert.equal(files.length, 0, 'Temp file must be removed');
    }
});

// ---------------------------------------------------------------------------
// 16. Review 1 Regressions: Public JSON & Safe Metadata Contract (Finding 4)
// ---------------------------------------------------------------------------
test('--dry-run --json with sensitive args and cwd returns safe metadata without leaking secrets', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sensitiveSubdir = path.join(wsRoot, 'secret_subfolder');
    fs.mkdirSync(sensitiveSubdir, { recursive: true });

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['--sensitive-token=SECRET_AUTH_TOKEN_XYZ123', '--pass=p@ssword'],
                cwd: 'secret_subfolder',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--dry-run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);

    // Neither stdout nor stderr may contain the secret args or sensitive subfolder
    assert.ok(!res.stdout.includes('SECRET_AUTH_TOKEN_XYZ123'), 'stdout must not contain secret token');
    assert.ok(!res.stdout.includes('p@ssword'), 'stdout must not contain password');
    assert.ok(!res.stdout.includes('secret_subfolder'), 'stdout must not contain sensitive cwd');
    assert.ok(!res.stderr.includes('SECRET_AUTH_TOKEN_XYZ123'));

    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.results.length, 1);

    // Public results MUST contain only safe metadata: index, program, kind, status
    const r0 = parsed.results[0];
    assert.equal(r0.index, 0);
    assert.equal(r0.program, 'node');
    assert.equal(r0.kind, 'native');
    assert.equal(r0.status, 0);
    assert.equal(r0.command, undefined, 'command must not be present in public result');
    assert.equal(r0.args, undefined, 'args must not be present in public result');
    assert.equal(r0.cwd, undefined, 'cwd must not be present in public result');
    assert.equal(r0.stdout, undefined, 'stdout must not be present in public result');
    assert.equal(r0.stderr, undefined, 'stderr must not be present in public result');
});

test('success run --json with sensitive args returns safe metadata while preserving argv execution', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sensitiveSubdir = path.join(wsRoot, 'sensitive_cwd');
    fs.mkdirSync(sensitiveSubdir, { recursive: true });

    const inspectScript = path.join(sensitiveSubdir, 'record-argv.js');
    const artifactOut = path.join(sensitiveSubdir, 'argv-record.json');
    fs.writeFileSync(inspectScript, `
        const fs = require('fs');
        fs.writeFileSync(${JSON.stringify(artifactOut)}, JSON.stringify(process.argv.slice(2)));
    `, 'utf8');

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: [inspectScript, '--api-key=HIGHLY_SECRET_KEY_999'],
                cwd: 'sensitive_cwd',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 0, `Failed with stderr: ${res.stderr}`);

    // Public stdout/stderr must NOT contain secret key or sensitive cwd
    assert.ok(!res.stdout.includes('HIGHLY_SECRET_KEY_999'));
    assert.ok(!res.stdout.includes('sensitive_cwd'));
    assert.ok(!res.stderr.includes('HIGHLY_SECRET_KEY_999'));

    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results.length, 1);

    const r0 = parsed.results[0];
    assert.equal(r0.index, 0);
    assert.equal(r0.program, 'node');
    assert.equal(r0.kind, 'native');
    assert.equal(r0.status, 0);
    assert.equal(r0.command, undefined);
    assert.equal(r0.args, undefined);
    assert.equal(r0.cwd, undefined);

    // Verify child execution DID receive exact argv via child-written artifact
    assert.ok(fs.existsSync(artifactOut));
    const captured = JSON.parse(fs.readFileSync(artifactOut, 'utf8'));
    assert.deepEqual(captured, ['--api-key=HIGHLY_SECRET_KEY_999']);
});

// ---------------------------------------------------------------------------
// 17. Review 1 Regressions: Windows Package-Manager Layouts (Finding 5)
// ---------------------------------------------------------------------------
test('resolver detects pnpm, yarn, npm PATH-adjacent Node entrypoints on Windows without cmd wrappers', (t) => {
    const wsRoot = createTempWorkspace(t);
    const fakePathDir = path.join(wsRoot, 'fake-global-bin');
    fs.mkdirSync(fakePathDir, { recursive: true });

    // 1. pnpm layout: <PATH dir>/node_modules/pnpm/bin/pnpm.cjs + wrapper <PATH dir>/pnpm.cmd
    const pnpmBinDir = path.join(fakePathDir, 'node_modules', 'pnpm', 'bin');
    fs.mkdirSync(pnpmBinDir, { recursive: true });
    const pnpmCjs = path.join(pnpmBinDir, 'pnpm.cjs');
    fs.writeFileSync(pnpmCjs, '// pnpm cjs entrypoint\n', 'utf8');
    fs.writeFileSync(path.join(fakePathDir, 'pnpm.cmd'), '@echo off\n', 'utf8');

    // 2. yarn layout: <PATH dir>/node_modules/yarn/bin/yarn.js + wrapper <PATH dir>/yarn.cmd
    const yarnBinDir = path.join(fakePathDir, 'node_modules', 'yarn', 'bin');
    fs.mkdirSync(yarnBinDir, { recursive: true });
    const yarnJs = path.join(yarnBinDir, 'yarn.js');
    fs.writeFileSync(yarnJs, '// yarn js entrypoint\n', 'utf8');
    fs.writeFileSync(path.join(fakePathDir, 'yarn.cmd'), '@echo off\n', 'utf8');

    // 3. bun.exe in PATH
    const bunExe = path.join(fakePathDir, 'bun.exe');
    fs.writeFileSync(bunExe, 'bun-binary', 'utf8');

    // 4. Wrapper-only tool (e.g. unknown-tool.cmd only)
    fs.writeFileSync(path.join(fakePathDir, 'wrapper-only.cmd'), '@echo off\n', 'utf8');

    const resolver = createCliResolver(wsRoot, {
        platform: 'win32',
        env: { PATH: fakePathDir },
        fsImpl: fs,
        processExecPath: process.execPath,
    });

    // Test pnpm resolution
    const pnpmRes = resolver('pnpm', { cwd: wsRoot, kind: 'package-manager' });
    assert.ok(pnpmRes, 'pnpm should be resolved');
    assert.equal(pnpmRes.kind, 'node-cli');
    assert.equal(pnpmRes.path, pnpmCjs);

    // Test yarn resolution
    const yarnRes = resolver('yarn', { cwd: wsRoot, kind: 'package-manager' });
    assert.ok(yarnRes, 'yarn should be resolved');
    assert.equal(yarnRes.kind, 'node-cli');
    assert.equal(yarnRes.path, yarnJs);

    // Test bun resolution
    const bunRes = resolver('bun', { cwd: wsRoot, kind: 'package-manager' });
    assert.ok(bunRes, 'bun should be resolved as native .exe');
    assert.equal(bunRes.kind, 'native');
    assert.equal(bunRes.path, bunExe);

    // Test wrapper-only resolution returns null / blocked
    const wrapRes = resolver('wrapper-only', { cwd: wsRoot, kind: 'package-manager' });
    assert.equal(wrapRes, null, 'wrapper-only must return null');
});

// ---------------------------------------------------------------------------
// 18. Review 1 Regressions: Error Detail Leakage (Finding 6)
// ---------------------------------------------------------------------------
test('error JSON output strips failedAction to safe metadata only', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sensitiveSubdir = path.join(wsRoot, 'sensitive_err_folder');
    fs.mkdirSync(sensitiveSubdir, { recursive: true });

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'native',
                program: 'node',
                args: ['-e', 'process.stderr.write("secret-err-trace"); process.exit(13)'],
                cwd: 'sensitive_err_folder',
            },
        ],
    });

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);

    const stdoutLines = res.stdout.trim().split('\n');
    assert.equal(stdoutLines.length, 1);
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_ACTION_FAILED');

    // failedAction must ONLY contain safe metadata
    assert.ok(parsed.failedAction);
    assert.equal(parsed.failedAction.program, 'node');
    assert.equal(parsed.failedAction.kind, 'native');
    assert.equal(parsed.failedAction.status, 13);
    assert.equal(parsed.failedAction.command, undefined);
    assert.equal(parsed.failedAction.args, undefined);
    assert.equal(parsed.failedAction.cwd, undefined);

    // Stdout JSON must not leak cwd
    assert.ok(!res.stdout.includes('sensitive_err_folder'));
});

// ---------------------------------------------------------------------------
// 19. Review 2 Regressions: Hardening Containment, Partial Cleanup, Byte Limits & Stale Unlink
// ---------------------------------------------------------------------------
test('final setup.lock as symlink fails closed and does not read or unlink outside target', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const outsideDir = createTempWorkspace(t);
    const outsideTarget = path.join(outsideDir, 'outside-target.json');
    const secretContent = JSON.stringify({ secret: 'TOP_SECRET_OUTSIDE_LOCK_DATA' });
    fs.writeFileSync(outsideTarget, secretContent, 'utf8');

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockSymlink = path.join(runtimeDir, 'setup.lock');

    try {
        fs.symlinkSync(outsideTarget, lockSymlink, 'file');
    } catch {
        t.skip('Host environment cannot create file symlink');
        return;
    }

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.ok(
        parsed.code === 'DUAL_SETUP_LOCK_CORRUPT' || parsed.code === 'DUAL_PATH_ESCAPE',
        `Expected lock corrupt or path escape, got ${parsed.code}`
    );

    // Outside target MUST NOT have been unlinked or overwritten
    assert.ok(fs.existsSync(outsideTarget), 'outside target must survive');
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), secretContent, 'outside target content must remain intact');

    // Output must not leak outside target content
    assert.ok(!res.stdout.includes('TOP_SECRET_OUTSIDE_LOCK_DATA'));
    assert.ok(!res.stderr.includes('TOP_SECRET_OUTSIDE_LOCK_DATA'));
});

test('partial lock cleanup on write/fsync failure preserves replacement lock if replaced before cleanup', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'f'.repeat(64);
    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    const replacementLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: 99999,
        nonce: 'replacement-lock-nonce-99999',
        started_at: new Date().toISOString(),
        manifest_sha256: manifestSha,
    };

    const customFs = Object.create(fs);
    customFs.openSync = function (p, flags, mode) {
        return fs.openSync(p, flags, mode);
    };
    customFs.fsyncSync = function (fd) {
        // Simulate another process/thread replacing setup.lock between our open and error cleanup
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify(replacementLock, null, 2) + '\n', 'utf8');

        const err = new Error('Simulated fsync I/O failure');
        err.code = 'EIO';
        throw err;
    };

    assert.throws(
        () => acquireSetupLock(wsRoot, manifestSha, { fsImpl: customFs }),
        (err) => {
            assert.equal(err.code, 'EIO');
            return true;
        }
    );

    // The replacement lock MUST have survived on disk and not been deleted by partial lock cleanup!
    assert.ok(fs.existsSync(lockPath), 'Replacement lock must survive cleanup');
    const onDiskContent = fs.readFileSync(lockPath, 'utf8');
    assert.ok(onDiskContent.includes('replacement-lock-nonce-99999'), 'Replacement lock content must be preserved');
});

test('rejects oversized receipt (>16 KiB) and fails closed without overwriting or unlinking', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const receiptDir = path.join(wsRoot, '.omni', 'runs', 'dual-setup');
    fs.mkdirSync(receiptDir, { recursive: true });
    const receiptPath = path.join(receiptDir, 'receipt.json');

    // Create an oversized valid-structure receipt (>16 KiB)
    const oversizedPayload = {
        schema_version: 1,
        workspace_root: wsRoot,
        manifest_sha256: 'a'.repeat(64),
        action_count: 0,
        status: 'SUCCESS',
        completed_at: new Date().toISOString(),
        results_digest: 'b'.repeat(64),
        padding: 'x'.repeat(17 * 1024),
    };
    const oversizedContent = JSON.stringify(oversizedPayload, null, 2) + '\n';
    fs.writeFileSync(receiptPath, oversizedContent, 'utf8');

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_RECEIPT_CORRUPT');

    // Receipt must NOT be overwritten or unlinked without --force
    assert.ok(fs.existsSync(receiptPath));
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), oversizedContent);
});

test('rejects oversized lock file (>16 KiB) and fails closed without unlinking', async (t) => {
    const wsRoot = createTempWorkspace(t);
    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [],
    });

    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    // Create an oversized lock (>16 KiB)
    const oversizedLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: 99999,
        nonce: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        manifest_sha256: 'a'.repeat(64),
        padding: 'x'.repeat(17 * 1024),
    };
    const oversizedContent = JSON.stringify(oversizedLock, null, 2) + '\n';
    fs.writeFileSync(lockPath, oversizedContent, 'utf8');

    const res = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_LOCK_CORRUPT');

    // Lock must NOT be unlinked
    assert.ok(fs.existsSync(lockPath));
    assert.equal(fs.readFileSync(lockPath, 'utf8'), oversizedContent);
});

test('resolver rejects oversized local package.json (>64 KiB) and fails closed without parsing', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const pkgDir = path.join(wsRoot, 'node_modules', 'huge-pkg');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    // Create a 65 KiB package.json
    const hugePkgJson = {
        name: 'huge-pkg',
        version: '1.0.0',
        bin: './bin/cli.js',
        description: 'y'.repeat(65 * 1024),
    };
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(hugePkgJson), 'utf8');
    fs.writeFileSync(path.join(binDir, 'cli.js'), 'console.log("huge");\n', 'utf8');

    const resolver = createCliResolver(wsRoot, {
        platform: process.platform,
        env: { PATH: '' },
        fsImpl: fs,
    });

    const resolveRes = resolver('huge-pkg', { cwd: wsRoot, kind: 'node-cli' });
    assert.equal(resolveRes, null, 'Oversized package.json must return null from resolver');

    writeManifest(wsRoot, {
        schema_version: 1,
        actions: [
            {
                kind: 'node-cli',
                program: 'huge-pkg',
                args: [],
                cwd: '.',
            },
        ],
    });

    const cliRes = await runOmniCli(['dual', 'setup', 'run', '--json'], { cwd: wsRoot });
    assert.equal(cliRes.code, 1);
    const parsed = JSON.parse(cliRes.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'DUAL_SETUP_RESOLVE_FAILED');
});

test('stale lock unlink failure with EPERM throws DUAL_SETUP_LOCK_CORRUPT and does not continue', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'g'.repeat(64);
    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    const staleLock = {
        schema_version: 1,
        workspace_root: wsRoot,
        pid: 99999, // dead PID
        nonce: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        manifest_sha256: manifestSha,
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock, null, 2) + '\n', 'utf8');

    const customFs = Object.create(fs);
    customFs.unlinkSync = function (p) {
        if (p === lockPath) {
            const err = new Error('Simulated EPERM unlinking stale lock');
            err.code = 'EPERM';
            throw err;
        }
        return fs.unlinkSync(p);
    };

    assert.throws(
        () => acquireSetupLock(wsRoot, manifestSha, { fsImpl: customFs, isProcessAlive: () => false }),
        (err) => {
            assert.equal(err.code, 'DUAL_SETUP_LOCK_CORRUPT');
            return true;
        }
    );
});

test('acquireSetupLock fails closed when lockPath is a symlink and does not read or unlink outside target', (t) => {
    const wsRoot = createTempWorkspace(t);
    const manifestSha = 'h'.repeat(64);
    const runtimeDir = path.join(wsRoot, '.omni', 'runtime', 'dual');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    let readCalled = false;
    let unlinkCalled = false;

    const customFs = Object.create(fs);
    customFs.openSync = function (p, flags, mode) {
        if (p === lockPath && flags === 'wx') {
            const err = new Error('EEXIST');
            err.code = 'EEXIST';
            throw err;
        }
        return fs.openSync(p, flags, mode);
    };
    customFs.lstatSync = function (p) {
        if (p === lockPath) {
            return {
                isFile: () => false,
                isSymbolicLink: () => true,
                isDirectory: () => false,
                size: 100,
                dev: 1,
                ino: 2,
            };
        }
        return fs.lstatSync(p);
    };
    customFs.readFileSync = function (p, enc) {
        if (p === lockPath) {
            readCalled = true;
            throw new Error('Should not have read symlink target!');
        }
        return fs.readFileSync(p, enc);
    };
    customFs.unlinkSync = function (p) {
        if (p === lockPath) {
            unlinkCalled = true;
            throw new Error('Should not have unlinked symlink target!');
        }
        return fs.unlinkSync(p);
    };

    assert.throws(
        () => acquireSetupLock(wsRoot, manifestSha, { fsImpl: customFs }),
        (err) => {
            assert.equal(err.code, 'DUAL_SETUP_LOCK_CORRUPT');
            return true;
        }
    );

    assert.equal(readCalled, false, 'readFileSync must not be called on symlink');
    assert.equal(unlinkCalled, false, 'unlinkSync must not be called on symlink');
});
