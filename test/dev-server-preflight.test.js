const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

describe('Dev Server Preflight — base workflow', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('contains Dev Server Preflight step', () => {
        assert.ok(content.includes('Dev Server Preflight'));
    });

    it('lists package.json detection', () => {
        assert.ok(content.includes('package.json'));
        assert.ok(content.includes('`dev`, `start`, or `serve`') || content.includes('`dev`, `start`, `serve`'));
    });

    it('lists docker-compose detection', () => {
        assert.ok(content.includes('docker-compose.yml'));
    });

    it('lists Makefile detection', () => {
        assert.ok(content.includes('Makefile'));
    });

    it('lists Django detection', () => {
        assert.ok(content.includes('manage.py'));
    });

    it('mentions background process', () => {
        assert.ok(content.includes('background process'));
    });

    it('is a MANDATORY CHECKPOINT', () => {
        assert.ok(content.includes('MANDATORY CHECKPOINT'));
        assert.ok(content.includes('MUST complete this step'));
    });

    it('requires status report before proceeding', () => {
        assert.ok(content.includes('Report to user (REQUIRED'));
        assert.ok(content.includes('🟢 Dev server:'));
        assert.ok(content.includes('🟡 Dev server: skipped'));
        assert.ok(content.includes('🔴 Dev server:'));
    });

    it('gates Step 3 on report completion', () => {
        assert.ok(content.includes('Only after printing one of the above lines may you proceed'));
    });

    it('Dev Server Preflight appears BEFORE Execute', () => {
        const preflightIndex = content.indexOf('Dev Server Preflight');
        const executeIndex = content.indexOf('Execute ONE Task');
        assert.ok(preflightIndex < executeIndex, 'Preflight must come before Execute');
    });
});

describe('Dev Server Preflight — Claude Code overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('is a MANDATORY CHECKPOINT', () => {
        assert.ok(content.includes('MANDATORY CHECKPOINT'));
    });

    it('specifies Bash(run_in_background)', () => {
        assert.ok(content.includes('Bash(run_in_background)'));
    });

    it('requires status report with gate', () => {
        assert.ok(content.includes('Report to user (REQUIRED'));
        assert.ok(content.includes('Only after printing one of the above'));
    });

    it('Dev Server Preflight appears BEFORE Dependency Graph', () => {
        const preflightIndex = content.indexOf('Dev Server Preflight');
        const depGraphIndex = content.indexOf('Dependency Graph');
        assert.ok(preflightIndex < depGraphIndex, 'Preflight must come before Dependency Graph');
    });
});

describe('Dev Server Preflight — Codex overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('is a MANDATORY CHECKPOINT', () => {
        assert.ok(content.includes('MANDATORY CHECKPOINT'));
    });

    it('mentions sandbox restriction in report options', () => {
        assert.ok(content.includes('sandbox restriction'));
    });

    it('requires status report with gate', () => {
        assert.ok(content.includes('Report to user (REQUIRED'));
        assert.ok(content.includes('Only after printing one of the above'));
    });

    it('Dev Server Preflight appears BEFORE Codex Safety Preflight', () => {
        const preflightIndex = content.indexOf('Dev Server Preflight');
        const safetyIndex = content.indexOf('Codex Safety Preflight');
        assert.ok(preflightIndex < safetyIndex, 'Dev Server Preflight must come before Codex Safety Preflight');
    });
});

describe('Dev Server Preflight — Gemini overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'gemini', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('is a MANDATORY CHECKPOINT', () => {
        assert.ok(content.includes('MANDATORY CHECKPOINT'));
    });

    it('specifies shell background execution', () => {
        assert.ok(content.includes('shell background execution'));
    });

    it('requires status report with gate', () => {
        assert.ok(content.includes('Report to user (REQUIRED'));
        assert.ok(content.includes('Only after printing one of the above'));
    });

    it('Dev Server Preflight appears BEFORE Implementation', () => {
        const preflightIndex = content.indexOf('Dev Server Preflight');
        const implIndex = content.indexOf('Implementation');
        assert.ok(preflightIndex < implIndex, 'Preflight must come before Implementation');
    });
});
