'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'templates', 'codex-gemini', 'ai-flow.ps1');

function detectPowerShell() {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell' : 'pwsh';
    try {
        const res = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
        });
        if (res.status === 0 && res.stdout && res.stdout.trim().length > 0) {
            return shell;
        }
    } catch {
        // Not available
    }
    return null;
}

describe('Codex-Gemini ai-flow.ps1 compatibility shim', () => {
    it('contains no validation, model, or subprocess logic in PowerShell script', () => {
        const content = fs.readFileSync(SCRIPT_PATH, 'utf8');
        assert.doesNotMatch(content, /ProcessStartInfo/i);
        assert.doesNotMatch(content, /Invoke-GeminiWorker/i);
        assert.doesNotMatch(content, /ConvertFrom-Json/i);
        assert.doesNotMatch(content, /ConvertTo-Json/i);
        assert.doesNotMatch(content, /--json-schema/i);
        assert.doesNotMatch(content, /--model/i);
        assert.match(content, /omni\s+dual\s+phase/i);
        assert.match(content, /\$LASTEXITCODE/);
    });

    it('delegates to omni dual phase and prints deprecation line', (t) => {
        const shell = detectPowerShell();
        if (!shell) {
            t.skip('PowerShell is not available on this host');
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shim-test-'));
        t.after(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        const isWindows = process.platform === 'win32';
        const logFile = path.join(tempDir, 'omni-called.json');

        if (isWindows) {
            const batchScript = `@echo off\r\nnode -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)));" "${logFile.replace(/\\/g, '\\\\')}" %*\r\nexit /b 0\r\n`;
            fs.writeFileSync(path.join(tempDir, 'omni.cmd'), batchScript, 'utf8');
        } else {
            const shScript = `#!/bin/sh\nnode -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)));" "${logFile}" "$@"\nexit 0\n`;
            const shPath = path.join(tempDir, 'omni');
            fs.writeFileSync(shPath, shScript, { encoding: 'utf8', mode: 0o755 });
        }

        const envPath = `${tempDir}${path.delimiter}${process.env.PATH || ''}`;
        const res = spawnSync(shell, [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', SCRIPT_PATH,
            'preflight',
            'TASK-SHIM-1',
        ], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: envPath,
            },
            shell: false,
            windowsHide: true,
        });

        assert.equal(res.status, 0);
        const combinedOutput = `${res.stdout}\n${res.stderr}`;
        assert.match(combinedOutput, /omni dual phase/i);

        assert.ok(fs.existsSync(logFile), 'Mock omni must be invoked');
        const args = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        assert.deepEqual(args, ['dual', 'phase', 'preflight', 'TASK-SHIM-1']);
    });

    it('propagates non-zero exit code from omni dual phase', (t) => {
        const shell = detectPowerShell();
        if (!shell) {
            t.skip('PowerShell is not available on this host');
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shim-fail-'));
        t.after(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        const isWindows = process.platform === 'win32';
        if (isWindows) {
            const batchScript = `@echo off\r\nexit /b 7\r\n`;
            fs.writeFileSync(path.join(tempDir, 'omni.cmd'), batchScript, 'utf8');
        } else {
            const shScript = `#!/bin/sh\nexit 7\n`;
            const shPath = path.join(tempDir, 'omni');
            fs.writeFileSync(shPath, shScript, { encoding: 'utf8', mode: 0o755 });
        }

        const envPath = `${tempDir}${path.delimiter}${process.env.PATH || ''}`;
        const res = spawnSync(shell, [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', SCRIPT_PATH,
            'scout',
            'TASK-SHIM-FAIL',
        ], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: envPath,
            },
            shell: false,
            windowsHide: true,
        });

        assert.equal(res.status, 7);
    });
});
