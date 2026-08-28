'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    resolveSetupInvocation,
    runSetupActions,
    detectPackageManager,
    defaultResolveExecutable,
    DualSetupError,
    SetupRunnerError,
} = require('../lib/dual/setup-runner');
const { SetupActionSchema, DualContractError } = require('../lib/dual/contracts');

const tempDirs = [];

function makeTemp(prefix = 'omni-setup-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors on busy Windows handles
        }
    }
});

describe('resolveSetupInvocation - Schema, Program & Shell Injection Rejection', () => {
    it('rejects actions with extra fields or missing required fields', () => {
        const root = makeTemp();
        const deps = { workspaceRoot: root };

        // Missing kind
        assert.throws(
            () => resolveSetupInvocation({ program: 'npm', args: ['install'], cwd: '.' }, deps),
            (err) => err instanceof DualContractError || err.name === 'DualContractError'
        );

        // Extra unexpected field
        assert.throws(
            () => resolveSetupInvocation({
                program: 'npm', args: ['install'], cwd: '.', kind: 'package-manager', extraField: 'forbidden',
            }, deps),
            (err) => err instanceof DualContractError || err.name === 'DualContractError'
        );

        // String command instead of program+args
        assert.throws(
            () => resolveSetupInvocation({ command: 'npm install', kind: 'native' }, deps),
            (err) => err instanceof DualContractError || err.name === 'DualContractError'
        );
    });

    it('rejects program containing whitespace-only, newlines, NUL bytes, or command strings', () => {
        const root = makeTemp();
        const deps = { workspaceRoot: root };

        const invalidPrograms = [
            '   ',
            '\t\n',
            'npm install && npm test',
            'npm || true',
            'npm; ls',
            'echo hello | grep h',
            'cat < input.txt',
            'echo hi > out.txt',
            '$(which npm)',
            '`which npm`',
            'npm $(rm -rf /)',
            'npm\ninstall',
            'npm\r\ninstall',
            'npm\0evil',
            'npm &',
            'npm |',
            'npm ^ test',
            'npm {install}',
        ];

        for (const prog of invalidPrograms) {
            assert.throws(
                () => resolveSetupInvocation({
                    program: prog,
                    args: ['install'],
                    cwd: '.',
                    kind: 'package-manager',
                }, deps),
                { code: 'DUAL_SETUP_PROGRAM_INVALID' },
                `Expected program to be rejected: ${JSON.stringify(prog)}`
            );
        }
    });

    it('preserves argv array containing spaces, Unicode, and punctuation as data', () => {
        const root = makeTemp();
        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        };

        const args = [
            'arg with spaces',
            'param=ünîcødé 🚀',
            '--filter=test/foo bar.js',
            'literal;&&||<>',
            '--message="hello world"',
        ];

        const invocation = resolveSetupInvocation({
            program: 'tool',
            args,
            cwd: '.',
            kind: 'native',
        }, deps);

        assert.deepEqual(invocation.args, args);
        assert.equal(invocation.command, '/usr/bin/tool');
        assert.equal(invocation.shell, false);
        assert.equal(invocation.windowsHide, true);
    });
});

describe('resolveSetupInvocation - Cwd Resolution & Repo-Relative Path Safety', () => {
    it('resolves cwd to canonical workspaceRoot for default and contained subdirectories', () => {
        const root = makeTemp();
        const subDir = path.join(root, 'packages', 'app');
        fs.mkdirSync(subDir, { recursive: true });
        const canonicalSubDir = fs.realpathSync.native ? fs.realpathSync.native(subDir) : fs.realpathSync(subDir);

        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        };

        const invDefault = resolveSetupInvocation({
            program: 'tool',
            args: [],
            cwd: '.',
            kind: 'native',
        }, deps);
        assert.equal(invDefault.cwd, root);

        const invSub = resolveSetupInvocation({
            program: 'tool',
            args: [],
            cwd: 'packages/app',
            kind: 'native',
        }, deps);
        assert.equal(invSub.cwd, canonicalSubDir);
    });

    it('supports cwd with spaces and Unicode inside workspaceRoot', () => {
        const root = makeTemp();
        const unicodeSubDir = path.join(root, 'sub dir with spaces', 'ünïcôdë');
        fs.mkdirSync(unicodeSubDir, { recursive: true });
        const canonicalUnicode = fs.realpathSync.native ? fs.realpathSync.native(unicodeSubDir) : fs.realpathSync(unicodeSubDir);

        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        };

        const inv = resolveSetupInvocation({
            program: 'tool',
            args: [],
            cwd: 'sub dir with spaces/ünïcôdë',
            kind: 'native',
        }, deps);
        assert.equal(inv.cwd, canonicalUnicode);
    });

    it('rejects path traversal, absolute paths, drive-qualified paths, UNC paths, and non-existent cwd', () => {
        const root = makeTemp();
        const deps = {
            workspaceRoot: root,
            platform: 'win32',
            resolveExecutable: (prog) => ({ kind: 'native', path: `C:\\bin\\${prog}.exe` }),
        };

        const invalidCwds = [
            '../outside',
            'packages/../../outside',
            '/etc',
            '/usr/bin',
            'C:\\Windows',
            'C:/Windows',
            'D:\\repos',
            'C:foo',
            '\\\\server\\share\\folder',
            '//server/share/folder',
            'non-existent-subfolder',
        ];

        for (const cwdCandidate of invalidCwds) {
            assert.throws(
                () => resolveSetupInvocation({
                    program: 'tool',
                    args: [],
                    cwd: cwdCandidate,
                    kind: 'native',
                }, deps),
                { code: 'DUAL_PATH_ESCAPE' },
                `Expected cwd to be rejected: ${JSON.stringify(cwdCandidate)}`
            );
        }
    });

    it('rejects symlink / junction escape pointing outside workspaceRoot', (t) => {
        const root = makeTemp('omni-setup-root-');
        const outside = makeTemp('omni-setup-outside-');

        const symlinkPath = path.join(root, 'symlink-outside');
        try {
            fs.symlinkSync(outside, symlinkPath, 'junction');
        } catch {
            // If symlink creation fails due to Windows privileges, skip symlink test
            t.skip('Symlink creation not permitted on this host');
            return;
        }

        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        };

        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: 'symlink-outside',
                kind: 'native',
            }, deps),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });
});

describe('resolveSetupInvocation - Kind: native', () => {
    it('accepts trusted .exe and .com on Windows and rejects .cmd / .bat / .ps1 wrappers', () => {
        const root = makeTemp();

        // .exe on Windows
        const invExe = resolveSetupInvocation({
            program: 'git',
            args: ['status'],
            cwd: '.',
            kind: 'native',
        }, {
            workspaceRoot: root,
            platform: 'win32',
            resolveExecutable: () => ({ kind: 'native', path: 'C:\\Program Files\\Git\\bin\\git.exe' }),
        });
        assert.equal(invExe.command, 'C:\\Program Files\\Git\\bin\\git.exe');
        assert.deepEqual(invExe.args, ['status']);
        assert.equal(invExe.shell, false);
        assert.equal(invExe.windowsHide, true);

        // .com on Windows
        const invCom = resolveSetupInvocation({
            program: 'chcp',
            args: ['65001'],
            cwd: '.',
            kind: 'native',
        }, {
            workspaceRoot: root,
            platform: 'win32',
            resolveExecutable: () => ({ kind: 'native', path: 'C:\\Windows\\System32\\chcp.com' }),
        });
        assert.equal(invCom.command, 'C:\\Windows\\System32\\chcp.com');

        // .cmd wrapper on Windows -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: () => ({ kind: 'native', path: 'C:\\bin\\tool.cmd' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // .bat wrapper on Windows -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: () => ({ kind: 'native', path: 'C:\\bin\\tool.bat' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // .ps1 script on Windows -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: () => ({ kind: 'native', path: 'C:\\bin\\tool.ps1' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );
    });

    it('accepts native absolute binary on POSIX', () => {
        const root = makeTemp();
        const inv = resolveSetupInvocation({
            program: 'cargo',
            args: ['build', '--release'],
            cwd: '.',
            kind: 'native',
        }, {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/local/bin/${prog}` }),
        });

        assert.equal(inv.command, '/usr/local/bin/cargo');
        assert.deepEqual(inv.args, ['build', '--release']);
        assert.equal(inv.shell, false);
        assert.equal(inv.windowsHide, true);
    });

    it('throws DUAL_SETUP_RESOLVE_FAILED when resolver returns null or relative path', () => {
        const root = makeTemp();
        assert.throws(
            () => resolveSetupInvocation({
                program: 'missing-tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, {
                workspaceRoot: root,
                resolveExecutable: () => null,
            }),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        assert.throws(
            () => resolveSetupInvocation({
                program: 'relative-tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, {
                workspaceRoot: root,
                resolveExecutable: () => ({ kind: 'native', path: 'bin/tool' }),
            }),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );
    });
});

describe('resolveSetupInvocation - Kind: node-cli', () => {
    it('resolves trusted JS/CJS/MJS entrypoint and invokes processExecPath directly', () => {
        const root = makeTemp();
        const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
        const entrypoint = 'C:\\app\\node_modules\\eslint\\bin\\eslint.js';

        const inv = resolveSetupInvocation({
            program: 'eslint',
            args: ['src/', '--fix'],
            cwd: '.',
            kind: 'node-cli',
        }, {
            workspaceRoot: root,
            platform: 'win32',
            processExecPath: nodeExe,
            resolveExecutable: () => ({ kind: 'node-cli', path: entrypoint }),
        });

        assert.equal(inv.command, nodeExe);
        assert.deepEqual(inv.args, [entrypoint, 'src/', '--fix']);
        assert.equal(inv.shell, false);
        assert.equal(inv.windowsHide, true);
    });

    it('rejects wrappers and non-JS files for kind node-cli', () => {
        const root = makeTemp();
        assert.throws(
            () => resolveSetupInvocation({
                program: 'eslint',
                args: [],
                cwd: '.',
                kind: 'node-cli',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: () => ({ kind: 'node-cli', path: 'C:\\app\\node_modules\\.bin\\eslint.cmd' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );
    });
});

describe('detectPackageManager & Kind: package-manager', () => {
    it('detects each package manager by its lockfile', () => {
        const root = makeTemp();

        // npm package-lock.json
        const npmDir = path.join(root, 'npm-proj');
        fs.mkdirSync(npmDir);
        fs.writeFileSync(path.join(npmDir, 'package-lock.json'), '{}');
        assert.equal(detectPackageManager(npmDir), 'npm');

        // npm npm-shrinkwrap.json
        const shrinkwrapDir = path.join(root, 'shrinkwrap-proj');
        fs.mkdirSync(shrinkwrapDir);
        fs.writeFileSync(path.join(shrinkwrapDir, 'npm-shrinkwrap.json'), '{}');
        assert.equal(detectPackageManager(shrinkwrapDir), 'npm');

        // pnpm pnpm-lock.yaml
        const pnpmDir = path.join(root, 'pnpm-proj');
        fs.mkdirSync(pnpmDir);
        fs.writeFileSync(path.join(pnpmDir, 'pnpm-lock.yaml'), '');
        assert.equal(detectPackageManager(pnpmDir), 'pnpm');

        // yarn yarn.lock
        const yarnDir = path.join(root, 'yarn-proj');
        fs.mkdirSync(yarnDir);
        fs.writeFileSync(path.join(yarnDir, 'yarn.lock'), '');
        assert.equal(detectPackageManager(yarnDir), 'yarn');

        // bun bun.lock
        const bunDir = path.join(root, 'bun-proj');
        fs.mkdirSync(bunDir);
        fs.writeFileSync(path.join(bunDir, 'bun.lock'), '');
        assert.equal(detectPackageManager(bunDir), 'bun');

        // bun bun.lockb
        const bunbDir = path.join(root, 'bunb-proj');
        fs.mkdirSync(bunbDir);
        fs.writeFileSync(path.join(bunbDir, 'bun.lockb'), '');
        assert.equal(detectPackageManager(bunbDir), 'bun');
    });

    it('allows dual lockfiles for the same package manager without conflict', () => {
        const root = makeTemp();

        // npm dual lockfiles
        const npmDir = path.join(root, 'npm-both');
        fs.mkdirSync(npmDir);
        fs.writeFileSync(path.join(npmDir, 'package-lock.json'), '{}');
        fs.writeFileSync(path.join(npmDir, 'npm-shrinkwrap.json'), '{}');
        assert.equal(detectPackageManager(npmDir), 'npm');

        // bun dual lockfiles
        const bunDir = path.join(root, 'bun-both');
        fs.mkdirSync(bunDir);
        fs.writeFileSync(path.join(bunDir, 'bun.lock'), '');
        fs.writeFileSync(path.join(bunDir, 'bun.lockb'), '');
        assert.equal(detectPackageManager(bunDir), 'bun');
    });

    it('throws DUAL_SETUP_LOCKFILE_CONFLICT when multiple distinct manager lockfiles exist', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
        fs.writeFileSync(path.join(root, 'yarn.lock'), '');

        assert.throws(
            () => detectPackageManager(root),
            { code: 'DUAL_SETUP_LOCKFILE_CONFLICT' }
        );

        assert.throws(
            () => resolveSetupInvocation({
                program: 'auto',
                args: ['install'],
                cwd: '.',
                kind: 'package-manager',
            }, { workspaceRoot: root }),
            { code: 'DUAL_SETUP_LOCKFILE_CONFLICT' }
        );
    });

    it('throws DUAL_SETUP_NO_LOCKFILE when program is auto and no lockfile is found', () => {
        const root = makeTemp();
        assert.equal(detectPackageManager(root), null);

        assert.throws(
            () => resolveSetupInvocation({
                program: 'auto',
                args: ['install'],
                cwd: '.',
                kind: 'package-manager',
            }, { workspaceRoot: root }),
            { code: 'DUAL_SETUP_NO_LOCKFILE' }
        );
    });

    it('allows explicit manager override even if another lockfile is present', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'yarn.lock'), '');

        const inv = resolveSetupInvocation({
            program: 'pnpm',
            args: ['install'],
            cwd: '.',
            kind: 'package-manager',
        }, {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/local/bin/${prog}` }),
        });

        assert.equal(inv.command, '/usr/local/bin/pnpm');
        assert.deepEqual(inv.args, ['install']);
    });

    it('rejects Windows package manager .cmd wrapper and accepts trusted Node CLI entrypoint', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

        // Rejects npm.cmd wrapper on Windows
        assert.throws(
            () => resolveSetupInvocation({
                program: 'auto',
                args: ['ci'],
                cwd: '.',
                kind: 'package-manager',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: (prog) => ({ kind: 'native', path: `C:\\Program Files\\nodejs\\${prog}.cmd` }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // Accepts npm-cli.js Node entrypoint on Windows
        const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
        const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
        const inv = resolveSetupInvocation({
            program: 'npm',
            args: ['ci'],
            cwd: '.',
            kind: 'package-manager',
        }, {
            workspaceRoot: root,
            platform: 'win32',
            processExecPath: nodeExe,
            resolveExecutable: (prog) => (prog === 'npm' ? { kind: 'node-cli', path: npmCli } : null),
        });

        assert.equal(inv.command, nodeExe);
        assert.deepEqual(inv.args, [npmCli, 'ci']);
        assert.equal(inv.shell, false);
    });

    it('accepts native package manager binary on POSIX', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');

        const inv = resolveSetupInvocation({
            program: 'auto',
            args: ['install', '--frozen-lockfile'],
            cwd: '.',
            kind: 'package-manager',
        }, {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        });

        assert.equal(inv.command, '/usr/bin/pnpm');
        assert.deepEqual(inv.args, ['install', '--frozen-lockfile']);
    });
});

describe('runSetupActions - Sequential Execution, Errors, Dry Run & Bounded Output', () => {
    it('executes actions sequentially with shell: false and returns typed results', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

        const calls = [];
        const fakeSpawnSync = (cmd, args, options) => {
            calls.push({ cmd, args, options });
            return {
                status: 0,
                signal: null,
                stdout: `Output from ${cmd}`,
                stderr: '',
                error: null,
            };
        };

        const customEnv = { PATH: '/usr/bin', CUSTOM_VAR: '123' };
        const actions = [
            { program: 'npm', args: ['ci'], cwd: '.', kind: 'package-manager' },
            { program: 'tool', args: ['build', 'arg with spaces'], cwd: '.', kind: 'native' },
        ];

        const response = runSetupActions(actions, {
            workspaceRoot: root,
            platform: 'linux',
            env: customEnv,
            spawnSync: fakeSpawnSync,
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        });

        assert.equal(response.ok, true);
        assert.equal(response.dryRun, false);
        assert.equal(response.results.length, 2);

        assert.equal(calls.length, 2);
        assert.equal(calls[0].cmd, '/usr/bin/npm');
        assert.deepEqual(calls[0].args, ['ci']);
        assert.equal(calls[0].options.shell, false);
        assert.equal(calls[0].options.windowsHide, true);
        assert.equal(calls[0].options.env, customEnv);

        assert.equal(calls[1].cmd, '/usr/bin/tool');
        assert.deepEqual(calls[1].args, ['build', 'arg with spaces']);
        assert.equal(calls[1].options.shell, false);

        assert.equal(response.results[0].status, 0);
        assert.equal(response.results[0].stdout, 'Output from /usr/bin/npm');
        assert.equal(typeof response.results[0].duration_ms, 'number');
    });

    it('stops at the first non-zero exit code and throws an error carrying completed results', () => {
        const root = makeTemp();
        const calls = [];
        const fakeSpawnSync = (cmd, args) => {
            calls.push(cmd);
            if (cmd === '/usr/bin/fail') {
                return {
                    status: 2,
                    signal: null,
                    stdout: 'partial stdout',
                    stderr: 'failure description in stderr',
                    error: null,
                };
            }
            return {
                status: 0,
                signal: null,
                stdout: 'success',
                stderr: '',
                error: null,
            };
        };

        const actions = [
            { program: 'step1', args: [], cwd: '.', kind: 'native' },
            { program: 'fail', args: [], cwd: '.', kind: 'native' },
            { program: 'step3', args: [], cwd: '.', kind: 'native' },
        ];

        let caughtError;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                spawnSync: fakeSpawnSync,
                resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
            });
        } catch (err) {
            caughtError = err;
        }

        assert.ok(caughtError, 'Expected runSetupActions to throw');
        assert.equal(caughtError.code, 'DUAL_SETUP_ACTION_FAILED');
        assert.equal(calls.length, 2, 'Third action should never be called');
        assert.equal(caughtError.results.length, 2);
        assert.equal(caughtError.results[0].status, 0);
        assert.equal(caughtError.results[1].status, 2);
        assert.equal(caughtError.results[1].stderr, 'failure description in stderr');
    });

    it('stops on spawn error (e.g. ENOENT) and throws an error carrying completed results', () => {
        const root = makeTemp();
        const fakeSpawnSync = (cmd) => {
            if (cmd === '/usr/bin/missing') {
                const err = new Error('spawn ENOENT');
                err.code = 'ENOENT';
                return {
                    status: null,
                    signal: null,
                    stdout: '',
                    stderr: '',
                    error: err,
                };
            }
            return { status: 0, stdout: 'ok', stderr: '', error: null };
        };

        const actions = [
            { program: 'step1', args: [], cwd: '.', kind: 'native' },
            { program: 'missing', args: [], cwd: '.', kind: 'native' },
        ];

        let caughtError;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                spawnSync: fakeSpawnSync,
                resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
            });
        } catch (err) {
            caughtError = err;
        }

        assert.ok(caughtError);
        assert.equal(caughtError.code, 'DUAL_SETUP_ACTION_FAILED');
        assert.equal(caughtError.results.length, 2);
        assert.ok(caughtError.results[1].error.includes('ENOENT'));
    });

    it('supports dryRun: true without calling spawnSync', () => {
        const root = makeTemp();
        let spawnCalled = false;
        const fakeSpawnSync = () => {
            spawnCalled = true;
            return { status: 0 };
        };

        const actions = [
            { program: 'tool1', args: ['a'], cwd: '.', kind: 'native' },
            { program: 'tool2', args: ['b'], cwd: '.', kind: 'native' },
        ];

        const response = runSetupActions(actions, {
            workspaceRoot: root,
            platform: 'linux',
            dryRun: true,
            spawnSync: fakeSpawnSync,
            resolveExecutable: (prog) => ({ kind: 'native', path: `/usr/bin/${prog}` }),
        });

        assert.equal(spawnCalled, false);
        assert.equal(response.dryRun, true);
        assert.equal(response.results.length, 2);
        assert.equal(response.results[0].command, '/usr/bin/tool1');
        assert.deepEqual(response.results[0].args, ['a']);
        assert.equal(response.results[1].command, '/usr/bin/tool2');
        assert.deepEqual(response.results[1].args, ['b']);
    });

    it('bounds captured stdout and stderr to prevent unbounded memory growth', () => {
        const root = makeTemp();
        const hugeStdout = 'x'.repeat(100000);
        const hugeStderr = 'y'.repeat(100000);

        const fakeSpawnSync = () => ({
            status: 0,
            signal: null,
            stdout: hugeStdout,
            stderr: hugeStderr,
            error: null,
        });

        const actions = [
            { program: 'verbose-tool', args: [], cwd: '.', kind: 'native' },
        ];

        const response = runSetupActions(actions, {
            workspaceRoot: root,
            platform: 'linux',
            spawnSync: fakeSpawnSync,
            maxOutputLength: 1000,
            resolveExecutable: () => ({ kind: 'native', path: '/usr/bin/verbose-tool' }),
        });

        assert.equal(response.results.length, 1);
        const res = response.results[0];
        assert.ok(res.stdout.length <= 1000);
        assert.ok(res.stdout.endsWith('... [truncated]'));
        assert.ok(res.stderr.length <= 1000);
        assert.ok(res.stderr.endsWith('... [truncated]'));
    });

    it('rejects non-array actions in runSetupActions', () => {
        assert.throws(
            () => runSetupActions(null),
            { code: 'DUAL_SETUP_ACTIONS_INVALID' }
        );
        assert.throws(
            () => runSetupActions({ program: 'npm', args: [], kind: 'native' }),
            { code: 'DUAL_SETUP_ACTIONS_INVALID' }
        );
    });

    it('handles empty actions array gracefully', () => {
        const root = makeTemp();
        const res = runSetupActions([], { workspaceRoot: root });
        assert.equal(res.ok, true);
        assert.deepEqual(res.results, []);
    });

    it('throws when resolution fails mid-execution and attaches prior results', () => {
        const root = makeTemp();
        const calls = [];
        const fakeSpawnSync = (cmd) => {
            calls.push(cmd);
            return { status: 0, stdout: 'ok', stderr: '', error: null };
        };

        const actions = [
            { program: 'step1', args: [], cwd: '.', kind: 'native' },
            { program: 'missing', args: [], cwd: '.', kind: 'native' },
        ];

        let caughtError;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                spawnSync: fakeSpawnSync,
                resolveExecutable: (prog) => (prog === 'step1' ? { kind: 'native', path: '/usr/bin/step1' } : null),
            });
        } catch (err) {
            caughtError = err;
        }

        assert.ok(caughtError);
        assert.ok(caughtError instanceof SetupRunnerError, 'Expected instance of SetupRunnerError');
        assert.equal(caughtError.name, 'SetupRunnerError');
        assert.equal(caughtError.code, 'DUAL_SETUP_RESOLVE_FAILED');
        assert.equal(caughtError.failedIndex, 1);
        assert.ok(caughtError.cause);
        assert.equal(calls.length, 1);
        assert.equal(caughtError.results.length, 1);
        assert.equal(caughtError.results[0].program, 'step1');
    });

    it('wraps resolution error in dry-run mode as SetupRunnerError with failedIndex', () => {
        const root = makeTemp();
        const actions = [
            { program: 'step1', args: [], cwd: '.', kind: 'native' },
            { program: 'missing', args: [], cwd: '.', kind: 'native' },
        ];

        let caughtError;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                dryRun: true,
                resolveExecutable: (prog) => (prog === 'step1' ? { kind: 'native', path: '/usr/bin/step1' } : null),
            });
        } catch (err) {
            caughtError = err;
        }

        assert.ok(caughtError);
        assert.ok(caughtError instanceof SetupRunnerError);
        assert.equal(caughtError.name, 'SetupRunnerError');
        assert.equal(caughtError.code, 'DUAL_SETUP_RESOLVE_FAILED');
        assert.equal(caughtError.failedIndex, 1);
        assert.equal(caughtError.results.length, 1);
    });
});

describe('Resolver Contract & Kind Confusion', () => {


    it('rejects string, array, extra keys, missing keys, and unknown kind from resolver', () => {
        const root = makeTemp();
        const deps = (resolveExecutable) => ({
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable,
        });

        // Resolver returning a string
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => '/usr/bin/tool')),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Resolver returning an array
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => ['/usr/bin/tool'])),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Resolver returning extra keys
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => ({ kind: 'native', path: '/usr/bin/tool', extra: 'bad' }))),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Resolver returning missing kind
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => ({ path: '/usr/bin/tool' }))),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Resolver returning missing path
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => ({ kind: 'native' }))),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Resolver returning unknown kind
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => ({ kind: 'python', path: '/usr/bin/tool' }))),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );
    });

    it('treats custom resolveExecutable failure as authoritative without falling back to default resolver', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

        // Custom resolver returns null for npm -> must fail authoritatively, not fall back to default npm resolver
        assert.throws(
            () => resolveSetupInvocation({
                program: 'npm',
                args: ['install'],
                cwd: '.',
                kind: 'package-manager',
            }, {
                workspaceRoot: root,
                platform: 'linux',
                resolveExecutable: () => null,
            }),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );
    });

    it('rejects path syntax and traversal in program identifiers', () => {
        const root = makeTemp();
        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (p) => ({ kind: 'native', path: `/usr/bin/${p}` }),
        };

        const invalidPrograms = [
            '../tool',
            'bin/tool',
            'bin\\tool',
            'C:\\tool.exe',
            'C:/tool.exe',
            '/usr/bin/tool',
            '.',
            '..',
            './tool',
            '.\\tool',
            'C:tool',
            'subdir/npm',
        ];

        for (const prog of invalidPrograms) {
            assert.throws(
                () => resolveSetupInvocation({
                    program: prog,
                    args: [],
                    cwd: '.',
                    kind: 'native',
                }, deps),
                { code: 'DUAL_SETUP_PROGRAM_INVALID' },
                `Expected program to be rejected as path: ${JSON.stringify(prog)}`
            );
        }
    });

    it('accepts valid program identifiers', () => {
        const root = makeTemp();
        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (p) => ({ kind: 'native', path: `/usr/bin/${p}` }),
        };

        const validPrograms = [
            'node',
            'node.exe',
            'my-tool',
            'tool_1',
            'python3.11',
            'git.exe',
        ];

        for (const prog of validPrograms) {
            const inv = resolveSetupInvocation({
                program: prog,
                args: [],
                cwd: '.',
                kind: 'native',
            }, deps);
            assert.equal(inv.command, `/usr/bin/${prog}`);
        }
    });

    it('fails closed on kind confusion between native and node-cli', () => {
        const root = makeTemp();

        // node-cli action with extensionless file returned by resolver -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'script',
                args: [],
                cwd: '.',
                kind: 'node-cli',
            }, {
                workspaceRoot: root,
                platform: 'linux',
                resolveExecutable: () => ({ kind: 'node-cli', path: '/usr/local/bin/script' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // node-cli action with non-js extension (.sh) -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'script',
                args: [],
                cwd: '.',
                kind: 'node-cli',
            }, {
                workspaceRoot: root,
                platform: 'linux',
                resolveExecutable: () => ({ kind: 'node-cli', path: '/usr/local/bin/script.sh' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // native action with kind: node-cli returned by resolver -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, {
                workspaceRoot: root,
                platform: 'linux',
                resolveExecutable: () => ({ kind: 'node-cli', path: '/usr/local/bin/tool' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // package-manager action with node-cli kind returning .exe -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'npm',
                args: [],
                cwd: '.',
                kind: 'package-manager',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: () => ({ kind: 'node-cli', path: 'C:\\bin\\npm.exe' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );

        // package-manager action with native kind returning .js on Windows -> rejected
        assert.throws(
            () => resolveSetupInvocation({
                program: 'npm',
                args: [],
                cwd: '.',
                kind: 'package-manager',
            }, {
                workspaceRoot: root,
                platform: 'win32',
                resolveExecutable: () => ({ kind: 'native', path: 'C:\\bin\\npm.js' }),
            }),
            { code: 'DUAL_SETUP_EXECUTABLE_UNTRUSTED' }
        );
    });
});

describe('defaultResolveExecutable and Custom fsImpl', () => {
    it('rejects action when program is an absolute path', () => {
        const root = makeTemp();
        const fakeFile = path.join(root, 'my-cli.js');
        fs.writeFileSync(fakeFile, '');

        const deps = {
            workspaceRoot: root,
            platform: process.platform,
        };

        assert.throws(
            () => resolveSetupInvocation({
                program: fakeFile,
                args: ['run'],
                cwd: '.',
                kind: 'node-cli',
            }, deps),
            { code: 'DUAL_SETUP_PROGRAM_INVALID' }
        );
    });

    it('rejects workspaceRoot when workspaceRoot is a file instead of a directory', () => {
        const root = makeTemp();
        const filePath = path.join(root, 'root-file.txt');
        fs.writeFileSync(filePath, 'content');

        const deps = {
            workspaceRoot: filePath,
            platform: 'linux',
            resolveExecutable: () => ({ kind: 'native', path: '/usr/bin/tool' }),
        };

        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, deps),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });

    it('rejects cwd when cwd is a file instead of a directory', () => {
        const root = makeTemp();
        const filePath = path.join(root, 'some-file.txt');
        fs.writeFileSync(filePath, 'content');

        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: () => ({ kind: 'native', path: '/usr/bin/tool' }),
        };

        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: 'some-file.txt',
                kind: 'native',
            }, deps),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });

    it('rejects non-existent workspaceRoot', () => {
        const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
        assert.throws(
            () => resolveSetupInvocation({
                program: 'tool',
                args: [],
                cwd: '.',
                kind: 'native',
            }, { workspaceRoot: nonExistent }),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });

    it('POSIX defaultResolveExecutable rejects non-executable files on PATH', () => {
        const binDir = makeTemp('posix-bin-');
        const nonExecFile = path.join(binDir, 'my-tool');
        fs.writeFileSync(nonExecFile, '#!/bin/sh\necho hi\n');

        const fakeFsImpl = {
            ...fs,
            accessSync: (filePath, mode) => {
                if (filePath === nonExecFile) {
                    const err = new Error('EACCES: permission denied');
                    err.code = 'EACCES';
                    throw err;
                }
                return fs.accessSync(filePath, mode);
            },
        };

        const res = defaultResolveExecutable('my-tool', {
            platform: 'linux',
            env: { PATH: binDir },
            fsImpl: fakeFsImpl,
        });

        assert.equal(res, null, 'Non-executable file must be rejected by default POSIX resolver');
    });
});

describe('Review 2 Hardening Regressions', () => {
    it('1. validateResolverResult accepts only plain records with own kind/path and rejects class instances/exotic prototypes without invoking getters', () => {
        const root = makeTemp();
        const deps = (resolveExecutable) => ({
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable,
        });

        // Class instance rejected
        class CustomResult {
            constructor() {
                this.kind = 'native';
                this.path = '/usr/bin/tool';
            }
        }
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => new CustomResult())),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Date instance rejected
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => new Date())),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Map instance rejected
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => new Map([['kind', 'native'], ['path', '/usr/bin/tool']]))),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Inherited-only properties (prototype inheritance without own properties) rejected
        const protoObj = { kind: 'native', path: '/usr/bin/tool' };
        const inheritedObj = Object.create(protoObj);
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => inheritedObj)),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );

        // Inherited getter must not be invoked
        let getterInvoked = false;
        class GetterClass {
            get kind() {
                getterInvoked = true;
                return 'native';
            }
            get path() {
                getterInvoked = true;
                return '/usr/bin/tool';
            }
        }
        assert.throws(
            () => resolveSetupInvocation({ program: 'tool', args: [], cwd: '.', kind: 'native' }, deps(() => new GetterClass())),
            { code: 'DUAL_SETUP_RESOLVE_FAILED' }
        );
        assert.equal(getterInvoked, false, 'Inherited getters must not be invoked during resolver validation');

        // Plain object with null prototype and exact own keys accepted
        const nullProto = Object.create(null);
        nullProto.kind = 'native';
        nullProto.path = '/usr/bin/tool';
        const invNullProto = resolveSetupInvocation(
            { program: 'tool', args: [], cwd: '.', kind: 'native' },
            deps(() => nullProto)
        );
        assert.equal(invNullProto.command, '/usr/bin/tool');

        // Ordinary plain record accepted
        const invPlain = resolveSetupInvocation(
            { program: 'tool', args: [], cwd: '.', kind: 'native' },
            deps(() => ({ kind: 'native', path: '/usr/bin/tool' }))
        );
        assert.equal(invPlain.command, '/usr/bin/tool');
    });

    it('2. runSetupActions validates entire manifest schema in preflight before any side effect (resolve or spawn)', () => {
        const root = makeTemp();
        let resolverCalls = 0;
        let spawnCalls = 0;

        const fakeResolver = (prog) => {
            resolverCalls++;
            return { kind: 'native', path: `/usr/bin/${prog}` };
        };

        const fakeSpawnSync = () => {
            spawnCalls++;
            return { status: 0, stdout: 'ok', stderr: '', error: null };
        };

        const actions = [
            { program: 'tool0', args: ['arg0'], cwd: '.', kind: 'native' },
            { program: 'tool1', args: 'invalid-string-args', cwd: '.', kind: 'native' }, // Schema-invalid
        ];

        // Real run preflight rejection
        let caughtReal;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                resolveExecutable: fakeResolver,
                spawnSync: fakeSpawnSync,
            });
        } catch (err) {
            caughtReal = err;
        }

        assert.ok(caughtReal, 'Expected runSetupActions to throw on schema-invalid action in manifest');
        assert.ok(caughtReal instanceof SetupRunnerError, 'Expected SetupRunnerError');
        assert.equal(caughtReal.name, 'SetupRunnerError');
        assert.equal(caughtReal.code, 'DUAL_CONTRACT_INVALID');
        assert.equal(caughtReal.failedIndex, 1);
        assert.deepEqual(caughtReal.results, []);
        assert.ok(caughtReal.cause);
        assert.equal(resolverCalls, 0, 'No resolver should be called when manifest fails preflight schema validation');
        assert.equal(spawnCalls, 0, 'No spawn should occur when manifest fails preflight schema validation');

        // DryRun preflight rejection
        let caughtDry;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                dryRun: true,
                resolveExecutable: fakeResolver,
                spawnSync: fakeSpawnSync,
            });
        } catch (err) {
            caughtDry = err;
        }

        assert.ok(caughtDry, 'Expected dry-run to throw on schema-invalid action');
        assert.ok(caughtDry instanceof SetupRunnerError);
        assert.equal(caughtDry.code, 'DUAL_CONTRACT_INVALID');
        assert.equal(caughtDry.failedIndex, 1);
        assert.deepEqual(caughtDry.results, []);
        assert.ok(caughtDry.cause);
        assert.equal(resolverCalls, 0, 'Dry-run preflight must not invoke resolver');
    });

    it('3. run-level resolution wrapper prevents hostile error details from overriding canonical authority fields', () => {
        const root = makeTemp();
        const calls = [];
        const fakeSpawnSync = (cmd) => {
            calls.push(cmd);
            return { status: 0, stdout: 'ok', stderr: '', error: null };
        };

        const hostileError = new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            'Spoofed resolve failure',
            {
                results: [{ spoofed: true }],
                failedIndex: 999,
                failedAction: { spoofed: true },
                cause: new Error('fake cause'),
                safeDiagnostic: 'diagnostic-info',
            }
        );

        const actions = [
            { program: 'step0', args: [], cwd: '.', kind: 'native' },
            { program: 'step1', args: [], cwd: '.', kind: 'native' },
        ];

        let caught;
        try {
            runSetupActions(actions, {
                workspaceRoot: root,
                platform: 'linux',
                spawnSync: fakeSpawnSync,
                resolveExecutable: (prog) => {
                    if (prog === 'step0') {
                        return { kind: 'native', path: '/usr/bin/step0' };
                    }
                    throw hostileError;
                },
            });
        } catch (err) {
            caught = err;
        }

        assert.ok(caught, 'Expected runSetupActions to throw');
        assert.ok(caught instanceof SetupRunnerError);
        assert.equal(caught.failedIndex, 1, 'Canonical failedIndex must be 1, not spoofed 999');
        assert.equal(caught.results.length, 1, 'Canonical results must contain step0 result');
        assert.equal(caught.results[0].program, 'step0');
        assert.deepEqual(caught.failedAction, actions[1], 'Canonical failedAction must be actions[1]');
        assert.equal(caught.cause, hostileError, 'Canonical cause must be the caught error instance');
        assert.equal(caught.details.safeDiagnostic, 'diagnostic-info', 'Safe diagnostic metadata must be preserved');
        assert.equal(caught.details.failedIndex, 1, 'details.failedIndex must be canonical 1');
        assert.equal(caught.details.results.length, 1, 'details.results must be canonical results');
    });

    it('4. defaultResolveExecutable direct use on POSIX verifies executable permission for absolute native paths and returns null on EACCES', () => {
        const fakeFsImpl = {
            ...fs,
            existsSync: (filePath) => ['/opt/bin/tool', '/opt/bin/cli.js'].includes(filePath),
            statSync: (filePath) => {
                if (['/opt/bin/tool', '/opt/bin/cli.js'].includes(filePath)) {
                    return { isFile: () => true };
                }
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            },
            accessSync: (filePath, mode) => {
                if (filePath === '/opt/bin/tool') {
                    const err = new Error('EACCES: permission denied');
                    err.code = 'EACCES';
                    throw err;
                }
                return;
            },
        };

        // Absolute non-executable native binary -> null
        const resNative = defaultResolveExecutable('/opt/bin/tool', {
            platform: 'linux',
            fsImpl: fakeFsImpl,
        });
        assert.equal(resNative, null, 'Direct POSIX absolute native path without X_OK must return null');

        // Absolute JS entrypoint -> node-cli (does not require X_OK)
        const resJs = defaultResolveExecutable('/opt/bin/cli.js', {
            platform: 'linux',
            fsImpl: fakeFsImpl,
        });
        assert.deepEqual(resJs, { kind: 'node-cli', path: '/opt/bin/cli.js' });
    });

    it('5. program identifier enforces strict allowlist: accepts node/node.exe/my-tool/tool_1/python3.11 and rejects quote/percent/comma/braced/path-like strings while keeping args unrestricted', () => {
        const root = makeTemp();
        const deps = {
            workspaceRoot: root,
            platform: 'linux',
            resolveExecutable: (p) => ({ kind: 'native', path: `/usr/bin/${p}` }),
        };

        const validPrograms = [
            'node',
            'node.exe',
            'my-tool',
            'tool_1',
            'python3.11',
            'git.exe',
            'x86_64-w64-mingw32-gcc',
        ];

        for (const prog of validPrograms) {
            const inv = resolveSetupInvocation({
                program: prog,
                args: ['--quote="val"', 'percent%20', 'comma,separated', '{braced}', 'path/in/arg'],
                cwd: '.',
                kind: 'native',
            }, deps);
            assert.equal(inv.command, `/usr/bin/${prog}`);
            assert.deepEqual(inv.args, ['--quote="val"', 'percent%20', 'comma,separated', '{braced}', 'path/in/arg']);
        }

        for (const prog of ['npm', 'pnpm', 'yarn', 'bun']) {
            const inv = resolveSetupInvocation({
                program: prog,
                args: ['--quote="val"', 'percent%20', 'comma,separated', '{braced}', 'path/in/arg'],
                cwd: '.',
                kind: 'package-manager',
            }, deps);
            assert.equal(inv.command, `/usr/bin/${prog}`);
            assert.deepEqual(inv.args, ['--quote="val"', 'percent%20', 'comma,separated', '{braced}', 'path/in/arg']);
        }

        const invalidPrograms = [
            // Quotes
            "tool'name",
            'tool"name',
            "'node'",
            '"node"',
            // Percent
            'tool%1',
            '%TEMP%',
            'tool%',
            // Comma
            'tool,1',
            'a,b',
            // Braced / brackets / parentheses
            'tool{1}',
            'tool(1)',
            'tool[1]',
            'tool<1>',
            // Path-like / traversal
            'bin/tool',
            'bin\\tool',
            'C:\\tool',
            '/usr/bin/tool',
            '.',
            '..',
            '...',
            './tool',
            '../tool',
            '.tool',
            '-tool',
            '_tool',
            // Shell / special
            'tool;cmd',
            'tool&cmd',
            'tool|cmd',
            'tool$var',
            'tool^cmd',
            'tool!cmd',
            'tool*1',
            'tool?1',
            'tool~1',
            // Whitespace / control
            'tool name',
            ' tool',
            'tool\n',
            'tool\0',
        ];

        for (const prog of invalidPrograms) {
            assert.throws(
                () => resolveSetupInvocation({
                    program: prog,
                    args: [],
                    cwd: '.',
                    kind: 'native',
                }, deps),
                { code: 'DUAL_SETUP_PROGRAM_INVALID' },
                `Expected program to be rejected: ${JSON.stringify(prog)}`
            );
        }
    });
});


