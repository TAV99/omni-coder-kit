const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveWorkflow, resolveAllWorkflows } = require('../lib/workflows/resolve');
const { resolvePartials, readWorkflow, buildWorkflows } = require('../lib/workflows/build');

// --- helpers ---
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-workflows-test-'));
}

function writeCustomWorkflow(projectDir, name, content = '# custom') {
    const dir = path.join(projectDir, '.omni', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
}

// --- resolveWorkflow ---

test('resolveWorkflow: returns custom path when .omni/workflows/{name} exists', () => {
    const projectDir = makeTempDir();
    try {
        writeCustomWorkflow(projectDir, 'task-planning.md');
        const result = resolveWorkflow('task-planning.md', projectDir);
        assert.equal(result, path.join(projectDir, '.omni', 'workflows', 'task-planning.md'));
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

test('resolveWorkflow: falls back to package templates when no custom exists', () => {
    const projectDir = makeTempDir();
    try {
        const result = resolveWorkflow('task-planning.md', projectDir);
        assert.ok(result, 'should return a path');
        assert.ok(result.includes('templates'), 'should come from templates');
        assert.ok(fs.existsSync(result), 'file should exist');
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

test('resolveWorkflow: returns null for non-existent workflow name', () => {
    const projectDir = makeTempDir();
    try {
        const result = resolveWorkflow('totally-nonexistent-workflow.md', projectDir);
        assert.equal(result, null);
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

// --- resolveAllWorkflows ---

test('resolveAllWorkflows: returns all package workflows (at least task-planning.md)', () => {
    const projectDir = makeTempDir();
    try {
        const result = resolveAllWorkflows(projectDir);
        assert.ok(typeof result === 'object' && result !== null, 'should return an object');
        assert.ok('task-planning.md' in result, 'should include task-planning.md');
        assert.ok(Object.keys(result).length >= 1, 'should have at least 1 workflow');
        // all values should be existing file paths
        for (const [, p] of Object.entries(result)) {
            assert.ok(fs.existsSync(p), `file should exist: ${p}`);
        }
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

// --- resolvePartials ---

test('resolvePartials: expands {{partial:tdd-verification}} to full TDD block', () => {
    const input = 'Before\n\n{{partial:tdd-verification}}\n\nAfter';
    const result = resolvePartials(input);
    assert.ok(!result.includes('{{partial:'), 'marker should be resolved');
    assert.ok(result.includes('TDD Discipline'), 'should contain TDD content');
    assert.ok(result.includes('Verification Discipline'), 'should contain Verification content');
    assert.ok(result.includes('Before'));
    assert.ok(result.includes('After'));
});

test('resolvePartials: expands {{partial:verification-qa}} to QA table', () => {
    const input = '{{partial:verification-qa}}';
    const result = resolvePartials(input);
    assert.ok(result.includes('Reject rationalizations'));
    assert.ok(result.includes('| Claim'));
});

test('resolvePartials: leaves unknown partials unchanged', () => {
    const input = '{{partial:nonexistent-thing}}';
    const result = resolvePartials(input);
    assert.equal(result, input);
});

test('resolvePartials: no-op on content without markers', () => {
    const input = 'Just plain text with no markers';
    const result = resolvePartials(input);
    assert.equal(result, input);
});

test('resolvePartials: resolves multiple partials in one file', () => {
    const input = '{{partial:tdd-verification}}\n\n---\n\n{{partial:verification-qa}}';
    const result = resolvePartials(input);
    assert.ok(result.includes('TDD Discipline'));
    assert.ok(result.includes('Reject rationalizations'));
    assert.ok(!result.includes('{{partial:'));
});

// --- readWorkflow ---

test('readWorkflow: reads plain path as string', () => {
    const tmpDir = makeTempDir();
    try {
        const filePath = path.join(tmpDir, 'test.md');
        fs.writeFileSync(filePath, 'hello world');
        assert.equal(readWorkflow(filePath), 'hello world');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('readWorkflow: merges base + augment array, strips marker', () => {
    const tmpDir = makeTempDir();
    try {
        const basePath = path.join(tmpDir, 'base.md');
        const augPath = path.join(tmpDir, 'aug.md');
        fs.writeFileSync(basePath, 'Base content');
        fs.writeFileSync(augPath, '<!-- augment -->\nExtra content');
        const result = readWorkflow([basePath, augPath]);
        assert.ok(result.includes('Base content'));
        assert.ok(result.includes('Extra content'));
        assert.ok(!result.includes('<!-- augment -->'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- buildWorkflows augment ---

test('buildWorkflows: gemini qa-testing is augmented (array), not replaced', () => {
    const result = buildWorkflows('gemini', 'gemini');
    assert.ok(Array.isArray(result['qa-testing.md']), 'qa-testing should be an augment array');
    assert.equal(result['qa-testing.md'].length, 2, 'should have [base, augment]');
    const merged = readWorkflow(result['qa-testing.md']);
    assert.ok(merged.includes('QA TESTING WORKFLOW'), 'should contain base title');
    assert.ok(merged.includes('tracker_create_task'), 'should contain Gemini tracker');
});

test('buildWorkflows: gemini coder-execution is replaced (string), not augmented', () => {
    const result = buildWorkflows('gemini', 'gemini');
    assert.ok(typeof result['coder-execution.md'] === 'string', 'coder-execution should be a replace overlay');
});

test('buildWorkflows: non-gemini IDEs return plain paths (no augment)', () => {
    for (const [ide, target] of [['claudecode', null], ['codex', 'codex'], ['cursor', 'cursor']]) {
        const result = buildWorkflows(ide, target, { subagents: true });
        for (const [, src] of Object.entries(result)) {
            assert.ok(typeof src === 'string', `${ide}: all workflow sources should be strings`);
        }
    }
});

test('resolveAllWorkflows: overlays custom workflows over package workflows', () => {
    const projectDir = makeTempDir();
    try {
        writeCustomWorkflow(projectDir, 'task-planning.md', '# my custom task-planning');
        const result = resolveAllWorkflows(projectDir);
        assert.ok('task-planning.md' in result, 'task-planning.md should be present');
        const customPath = path.join(projectDir, '.omni', 'workflows', 'task-planning.md');
        assert.equal(result['task-planning.md'], customPath, 'custom path should override package path');
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});
