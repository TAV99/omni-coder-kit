const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveWorkflow, resolveAllWorkflows } = require('../lib/workflows/resolve');

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
