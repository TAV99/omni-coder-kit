'use strict';

// ---------------------------------------------------------------------------
// Project command detection + gate execution (HARNESS-SPEC-PHASE-1 §2.3).
//
// detectCommands mirrors the Dev Server Preflight logic in
// templates/workflows/coder-execution.md so the harness and the assisted
// workflow agree on how a project is built/tested.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { runCommand } = require('./shell');

function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// Pure (reads files only). Returns { dev, build, test, lint }, each null if absent.
function detectCommands(projectDir) {
    const dir = projectDir || process.cwd();
    const out = { dev: null, build: null, test: null, lint: null };

    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        const pkg = readJSON(pkgPath);
        const scripts = (pkg && pkg.scripts) || {};
        out.dev = scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : scripts.serve ? 'npm run serve' : null;
        out.build = scripts.build ? 'npm run build' : null;
        out.test = scripts.test ? 'npm test' : null;
        out.lint = scripts.lint ? 'npm run lint' : null;
        return out;
    }

    const makefile = path.join(dir, 'Makefile');
    if (fs.existsSync(makefile)) {
        const mk = fs.readFileSync(makefile, 'utf-8');
        const hasTarget = (t) => new RegExp(`^${t}\\s*:`, 'm').test(mk);
        out.dev = hasTarget('dev') ? 'make dev' : hasTarget('serve') ? 'make serve' : null;
        out.build = hasTarget('build') ? 'make build' : null;
        out.test = hasTarget('test') ? 'make test' : null;
        out.lint = hasTarget('lint') ? 'make lint' : null;
        return out;
    }

    if (fs.existsSync(path.join(dir, 'manage.py'))) {
        out.dev = 'python manage.py runserver';
        out.test = 'python manage.py test';
        return out;
    }

    if (fs.existsSync(path.join(dir, 'docker-compose.yml')) || fs.existsSync(path.join(dir, 'docker-compose.yaml'))) {
        out.dev = 'docker compose up';
        return out;
    }

    return out;
}

function tail(str, n = 30) {
    const lines = String(str || '').trimEnd().split('\n');
    return lines.slice(-n).join('\n');
}

// Run a single gate command. `runner` is injectable for tests (default: real shell).
function runGateCommand(projectDir, kind, { runner = runCommand, timeoutMs } = {}) {
    const cmds = detectCommands(projectDir);
    const cmd = cmds[kind];
    if (!cmd) {
        return { ran: false, passed: true, output: `no ${kind} command detected`, durationMs: 0 };
    }
    const started = Date.now();
    let res = runner(cmd, { cwd: projectDir, timeoutMs });
    let durationMs = Date.now() - started;
    let passed = res.exitCode === 0 && !res.timedOut;

    // Auto-lint fix logic
    if (kind === 'lint' && !passed && !res.timedOut) {
        const fixCmds = [];
        if (cmd.includes('npm run lint')) {
            fixCmds.push('npm run lint -- --fix');
        }
        
        const hasPackage = (pkg) => {
            try {
                const pkgJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
                return (pkgJson.dependencies && pkgJson.dependencies[pkg]) || 
                       (pkgJson.devDependencies && pkgJson.devDependencies[pkg]);
            } catch { return false; }
        };

        if (hasPackage('eslint')) {
            fixCmds.push('npx eslint --fix .');
        }
        if (hasPackage('prettier')) {
            fixCmds.push('npx prettier --write .');
        }
        if (hasPackage('@biomejs/biome')) {
            fixCmds.push('npx biome check --write .');
        }

        // Try executing the fix commands
        let fixed = false;
        for (const fcmd of fixCmds) {
            try {
                const fixRes = runner(fcmd, { cwd: projectDir, timeoutMs: 30000 });
                if (fixRes.exitCode === 0) {
                    fixed = true;
                    break;
                }
            } catch { /* ignore */ }
        }

        if (fixed || fixCmds.length > 0) {
            // Re-run lint command
            const reRes = runner(cmd, { cwd: projectDir, timeoutMs });
            passed = reRes.exitCode === 0 && !reRes.timedOut;
            if (passed) {
                res = reRes;
            }
        }
    }

    const output = tail((res.stdout || '') + (res.stderr ? '\n' + res.stderr : ''));
    return { ran: true, passed, output, durationMs, cmd };
}

module.exports = { detectCommands, runGateCommand };
