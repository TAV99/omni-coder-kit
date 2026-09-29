'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildInitConfig } = require('../lib/init');
const { readWorkflow, resolvePartials } = require('../lib/workflows/build');

function content(file) { return file.content ?? resolvePartials(readWorkflow(file.sourcePath)); }

test('every native workflow entrypoint in Codex-AGY loads the same controller contract first', () => {
    const config = buildInitConfig('dual', { mode: 'auto', dualPair: 'codex-agy', projectDir: process.cwd() });
    for (const name of ['om-think', 'om-plan', 'om-cook', 'om-check', 'om-fix', 'om-pass']) {
        const file = config.files.find((entry) => entry.path === path.join('.codex', 'skills', name, 'SKILL.md'));
        assert.ok(content(file).includes('.omni/workflows/dual-controller.md'), name);
    }
    const workflow = config.files.find((entry) => entry.path === path.join('.omni', 'workflows', 'dual-controller.md'));
    const source = content(workflow);
    for (const word of ['context_reply', 'isolated_qc', 'omni_dual_quality', 'expected_attempt', 'depends_on', 'NEEDS_CONTEXT', 'NEEDS_FIX', 'NEEDS_REVIEW']) {
        assert.ok(source.includes(word), word);
    }
});

test('controller documents daemon-owned quality generations, timeout recovery, and required review handling', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../templates/workflows/dual-controller.md'), 'utf8');
    for (const phrase of [
        'current source fingerprint generation',
        'restart the required checkpoint sequence from cycle 1',
        'successful same-generation replay is read-only',
        'inspect `omni_dual_status` for that same session',
        'missing_truncated',
        'All required tasks, quality gates, and reviews must be complete',
    ]) {
        assert.ok(source.includes(phrase), phrase);
    }
    assert.match(source, /Do not build or submit `quality_evidence` through `omni_dual_completion`/);
    assert.match(source, /Never fabricate PASS findings or waive a check/);
    assert.match(source, /Use `omni_dual_quality` once for each required `cycle_index`/);
    assert.ok(source.includes('Use `omni_dual_completion` only for the remaining isolated-task QC (`isolated_qc`), root QC (`qc_evidence`), required UI (`ui_evidence`) inputs, and completion-readiness evaluation as applicable'));
    assert.doesNotMatch(source, /Root Diff Fingerprint Calculation/);
    assert.doesNotMatch(source, /In `quality_evidence`, `diff_fingerprint` must reflect/);
    assert.doesNotMatch(source, /Fast-Track Quality Inheritance/);
    assert.doesNotMatch(source, /Quality Cycle 1 may inherit the verified command outputs from the isolated QC pass/);
});

test('generated Codex-AGY and Claude-Codex configs describe their actual pairing', () => {
    const agy = buildInitConfig('dual', { mode: 'auto', dualPair: 'codex-agy' });
    const legacy = buildInitConfig('dual', { mode: 'auto', dualPair: 'claude-codex' });
    assert.ok(agy.files.filter((entry) => ['CLAUDE.md', 'AGENTS.md'].includes(entry.path))
        .every((entry) => content(entry).includes('Codex + Antigravity')));
    assert.ok(legacy.files.some((entry) => entry.path === 'CLAUDE.md' && content(entry).includes('Claude Code Integration')));
});

test('standalone Codex cook never mandates commit stash or undeclared installation', () => {
    const config = buildInitConfig('codex', { mode: 'auto' });
    const cook = content(config.files.find((entry) => entry.path === path.join('.omni', 'workflows', 'coder-execution.md')));
    assert.doesNotMatch(cook, /commit or stash first|Install dependencies if missing/);
    assert.match(cook, /do not commit, stash, or reset automatically/);
});
