'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'templates', 'codex-gemini', 'ai-flow.ps1');
const FAKE_AGY = path.join(REPO_ROOT, 'test', 'fixtures', 'codex-gemini', 'fake-agy.ps1');
const RUNS_DIR = path.join(REPO_ROOT, '.omni', 'codex-gemini', 'runs');

function runFlow(action, taskId, env = {}) {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell' : 'pwsh';
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, action];
    if (taskId !== undefined) {
        args.push(taskId);
    }
    const result = spawnSync(shell, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
        },
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

function markPreflightSafe(preflightPath) {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf-8'));
    preflight.status = 'safe';
    fs.writeFileSync(preflightPath, JSON.stringify(preflight), 'utf-8');
}

describe('Codex-Gemini MVP ai-flow.ps1 wrapper', () => {
    const testTaskId = 'TEST-TASK-001';
    const taskRunDir = path.join(RUNS_DIR, testTaskId);
    const requestPath = path.join(taskRunDir, 'request.md');
    const preflightPath = path.join(taskRunDir, 'preflight.json');
    const contextPath = path.join(taskRunDir, 'context.json');
    const rawStdoutPath = path.join(taskRunDir, 'raw', 'scout.stdout.json');
    const specPath = path.join(taskRunDir, 'spec.json');
    const routePath = path.join(taskRunDir, 'route.json');

    afterEach(() => {
        if (fs.existsSync(taskRunDir)) {
            fs.rmSync(taskRunDir, { recursive: true, force: true });
        }
    });

    it('rejects unsupported actions', () => {
        const res = runFlow('invalidAction', testTaskId);
        assert.notEqual(res.status, 0);
    });

    it('new rejects unsafe IDs and preserves an existing request', () => {
        const unsafe = runFlow('new', '../escape');
        assert.notEqual(unsafe.status, 0);

        const first = runFlow('new', testTaskId);
        assert.equal(first.status, 0);
        assert.ok(fs.existsSync(requestPath));

        fs.writeFileSync(requestPath, '# Custom Request\nKeep me untouched', 'utf-8');
        const second = runFlow('new', testTaskId);
        assert.notEqual(second.status, 0);
        assert.match(fs.readFileSync(requestPath, 'utf8'), /Keep me untouched/);
    });

    it('preflight writes valid normalized JSON and never calls agy -p', () => {
        runFlow('new', testTaskId);
        const res = runFlow('preflight', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        assert.equal(res.status, 0);
        assert.ok(fs.existsSync(preflightPath));

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf-8'));
        assert.equal(preflight.task_id, testTaskId);
        assert.ok(['safe', 'warning'].includes(preflight.status));
        assert.equal(preflight.agy.available, true);
        assert.ok(Array.isArray(preflight.forbidden_actions));
        assert.ok(preflight.forbidden_actions.includes('commit'));
        assert.ok(preflight.forbidden_actions.includes('push'));
    });

    it('preflight marks status blocked when agy is unavailable', () => {
        runFlow('new', testTaskId);
        const nonExistentAgy = path.join(REPO_ROOT, 'non_existent_binary_12345');
        const res = runFlow('preflight', testTaskId, { OMNI_AGY_BIN: nonExistentAgy });
        assert.equal(res.status, 0);
        assert.ok(fs.existsSync(preflightPath));

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf-8'));
        assert.equal(preflight.status, 'blocked');
        assert.equal(preflight.agy.available, false);
    });

    it('scout refuses to run if request.md is missing or preflight is blocked', () => {
        const noReq = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        assert.notEqual(noReq.status, 0);

        runFlow('new', testTaskId);
        const noPreflight = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        assert.notEqual(noPreflight.status, 0);

        const nonExistentAgy = path.join(REPO_ROOT, 'non_existent_binary_12345');
        runFlow('preflight', testTaskId, { OMNI_AGY_BIN: nonExistentAgy });
        const blockedScout = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        assert.notEqual(blockedScout.status, 0);
    });

    it('scout refuses a warning preflight rather than spending model budget', () => {
        runFlow('new', testTaskId);
        runFlow('preflight', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf-8'));
        preflight.status = 'warning';
        fs.writeFileSync(preflightPath, JSON.stringify(preflight), 'utf-8');

        const res = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        assert.notEqual(res.status, 0);
        assert.equal(fs.existsSync(rawStdoutPath), false);
    });

    it('routes only bounded low-risk specs to Gemini Flash High', () => {
        runFlow('new', testTaskId);
        fs.writeFileSync(specPath, JSON.stringify({
            in_scope: ['lib/a.js', 'test/a.test.js'],
            validation_commands: ['node --test test/a.test.js'],
            risk_flags: [],
        }), 'utf8');

        const res = runFlow('route', testTaskId);
        assert.equal(res.status, 0);
        const route = JSON.parse(fs.readFileSync(routePath, 'utf8'));
        assert.equal(route.owner, 'gemini');
        assert.equal(route.model, 'gemini-3.7-flash-high');

        fs.writeFileSync(specPath, JSON.stringify({
            in_scope: ['a', 'b', 'c', 'd'],
            validation_commands: ['node --test'],
            risk_flags: [],
        }), 'utf8');
        const oversized = runFlow('route', testTaskId);
        assert.equal(oversized.status, 0);
        assert.equal(JSON.parse(fs.readFileSync(routePath, 'utf8')).owner, 'codex');
    });

    it('scout writes context only from a successful structured agy result', () => {
        runFlow('new', testTaskId);
        runFlow('preflight', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        markPreflightSafe(preflightPath);
        const res = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY, FAKE_AGY_BEHAVIOR: 'success' });
        assert.equal(res.status, 0);
        assert.ok(fs.existsSync(contextPath));
        assert.ok(fs.existsSync(rawStdoutPath));

        const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
        assert.ok(context.summary);
        assert.ok(Array.isArray(context.relevant_files));
        assert.ok(Array.isArray(context.exact_symbols));
        assert.equal(context.exact_symbols[0].verified, true);
    });

    it('scout fails closed on malformed output', () => {
        runFlow('new', testTaskId);
        runFlow('preflight', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        markPreflightSafe(preflightPath);
        const res = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY, FAKE_AGY_BEHAVIOR: 'malformed' });
        assert.notEqual(res.status, 0);
        assert.equal(fs.existsSync(contextPath), false);
        assert.ok(fs.existsSync(rawStdoutPath));
    });

    it('scout fails closed on invalid schema output', () => {
        runFlow('new', testTaskId);
        runFlow('preflight', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        markPreflightSafe(preflightPath);
        const res = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY, FAKE_AGY_BEHAVIOR: 'invalid_schema' });
        assert.notEqual(res.status, 0);
        assert.equal(fs.existsSync(contextPath), false);
    });

    it('scout fails closed on non-zero agy exit', () => {
        runFlow('new', testTaskId);
        runFlow('preflight', testTaskId, { OMNI_AGY_BIN: FAKE_AGY });
        markPreflightSafe(preflightPath);
        const res = runFlow('scout', testTaskId, { OMNI_AGY_BIN: FAKE_AGY, FAKE_AGY_BEHAVIOR: 'fail_exit' });
        assert.notEqual(res.status, 0);
        assert.equal(fs.existsSync(contextPath), false);
    });
});
