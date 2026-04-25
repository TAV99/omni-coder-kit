const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Evidence-Based Testing (qa-testing.md) ─────────────────────────────────

describe('Evidence-Based Testing — qa-testing.md', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'qa-testing.md'), 'utf-8'
    );

    it('requires shell command for each P0-P3 check', () => {
        assert.ok(content.includes('MUST run a shell command for each P0-P3'));
    });

    it('rejects "code looks correct" as verification', () => {
        assert.ok(content.includes('"Code looks correct" is NOT verification'));
    });

    it('mandates quiet flags to minimize output', () => {
        assert.ok(content.includes('--silent'));
        assert.ok(content.includes('-q'));
        assert.ok(content.includes('--quiet'));
    });

    it('report template includes CLI command per pipeline check', () => {
        assert.ok(content.includes('ran: `npm audit'));
        assert.ok(content.includes('ran: `npm run lint'));
        assert.ok(content.includes('ran: `npm run build'));
        assert.ok(content.includes('ran: `npm test'));
    });

    it('PASS lines are 1 line only — no command output', () => {
        assert.ok(content.includes('PASS lines: 1 line only. Do NOT paste command output'));
    });

    it('FAIL lines require 1-line error summary', () => {
        assert.ok(content.includes('FAIL lines: add 1-line error summary'));
    });

    it('Feature verification Method must be concrete action', () => {
        assert.ok(content.includes('must be a concrete action'));
        assert.ok(content.includes('not "read code"'));
    });

    it('has "No command = No PASS" rule', () => {
        assert.ok(content.includes('No command = No PASS'));
    });

    it('has "Quiet execution" rule', () => {
        assert.ok(content.includes('Quiet execution'));
    });
});

// ─── Circuit Breaker [BLOCKED] tag ──────────────────────────────────────────

describe('Circuit Breaker [BLOCKED] — qa-testing.md', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'qa-testing.md'), 'utf-8'
    );

    it('marks failing task as [BLOCKED] in todo.md', () => {
        assert.ok(content.includes('[BLOCKED]'));
        assert.ok(content.includes('Mark the failing task as'));
    });

    it('escalation message includes what was tried', () => {
        assert.ok(content.includes('Tried: 1)'));
    });

    it('has [BLOCKED] protocol in rules', () => {
        assert.ok(content.includes('[BLOCKED] protocol'));
        assert.ok(content.includes('Do NOT continue fixing it'));
    });
});

describe('Circuit Breaker [BLOCKED] — coder-execution.md (base)', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
        assert.ok(content.includes('mark failing task'));
    });

    it('skips [BLOCKED] tasks', () => {
        assert.ok(content.includes('marked `[BLOCKED]`, SKIP'));
    });
});

describe('Circuit Breaker [BLOCKED] — claude-code overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
    });

    it('skips [BLOCKED] tasks', () => {
        assert.ok(content.includes('`[BLOCKED]`, move it'));
    });
});

describe('Circuit Breaker [BLOCKED] — codex overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
    });

    it('has skip rule for [BLOCKED] tasks', () => {
        assert.ok(content.includes('Skip tasks marked `[BLOCKED]`'));
    });
});

describe('Circuit Breaker [BLOCKED] — gemini overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'gemini', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
    });

    it('updates tracker with BLOCKED status', () => {
        assert.ok(content.includes('tracker_update_task'));
        assert.ok(content.includes('BLOCKED'));
    });
});
