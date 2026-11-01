'use strict';

// Squad worker roots (SPEC-SQUAD-P2 §7, appendix §6.5): project role skills are
// not copied, the worker root is its own git root, the worker bundle is mounted
// identically every time, and none of it leaks into the task result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { prepareTaskWorkspace, collectTaskResult, readTaskBinding } = require('../lib/dual/task-workspace');
const { writeBinding } = require('../lib/squad/bindings');
const { MOUNT_MARKER, hashDir } = require('../lib/squad/skill-store');
const { tempDir, writeSkill } = require('./helpers/squad-project');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');

function project(t, { squad = true } = {}) {
    const root = tempDir(t, 'dual-squad-worker-');
    const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    write('src/a.js', 'one\n');
    write('docs/spec.md', 'spec\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeSkill(path.join(root, '.agents', 'skills'), 'om-think');              // orchestrator skill in the project root
    if (squad) {
        fs.mkdirSync(path.join(root, '.omni', 'squad', 'roles'), { recursive: true });
        for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
            fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(root, '.omni', 'squad', 'roles', name));
        }
        fs.copyFileSync(path.join(TEMPLATES, 'skills.yaml'), path.join(root, '.omni', 'squad', 'skills.yaml'));
        writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-01T00:00:00Z', roles: {
            orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' },
            worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } });
        for (const name of ['om-think', 'om-cook', 'karpathy-guidelines']) writeSkill(path.join(root, '.omni', 'skills'), name);
    }
    return { root, options: { workspaceRoot: root, sessionId: 'session-1', taskId: 'TASK-1', attempt: 1, planRevision: 1,
        allowedFiles: ['src/a.js'], contextFiles: ['docs/spec.md'], denyPatterns: [] } };
}

test('worker root gets only the worker bundle, never the orchestrator skills', (t) => {
    const { options } = project(t);
    const ref = prepareTaskWorkspace(options);
    const skills = path.join(ref.workerRoot, '.agents', 'skills');
    assert.deepEqual(fs.readdirSync(skills).sort(), ['karpathy-guidelines', 'om-cook']);
    const marker = JSON.parse(fs.readFileSync(path.join(skills, 'om-cook', MOUNT_MARKER), 'utf8'));
    assert.equal(marker.role, 'worker-1');
    assert.equal(marker.mounted_at, undefined, 'worker markers carry no timestamp');
    const { binding } = readTaskBinding(options.workspaceRoot, ref);
    assert.deepEqual(binding.workerOwnedPaths, ['.agents/skills', '.claude/skills', '.git']);
    assert.ok(!binding.sourceFiles.some((f) => f.path.startsWith('.agents/skills/')));
});

test('worker root is its own git root, so tools stop walking up at it', (t) => {
    const { options } = project(t);
    const ref = prepareTaskWorkspace(options);
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ref.workerRoot, encoding: 'utf8' }).trim();
    assert.equal(fs.realpathSync(top), ref.workerRoot);
});

test('skill mounts and the worker .git never reach the task result', (t) => {
    const { options } = project(t);
    const ref = prepareTaskWorkspace(options);
    fs.writeFileSync(path.join(ref.workerRoot, 'src/a.js'), 'two\n');
    execFileSync('git', ['add', '-A'], { cwd: ref.workerRoot });
    fs.appendFileSync(path.join(ref.workerRoot, '.agents', 'skills', 'om-cook', 'SKILL.md'), 'worker scribbles\n');
    const result = collectTaskResult({ workspaceRoot: options.workspaceRoot, reference: ref });
    assert.deepEqual(result.changes.map((c) => c.path), ['src/a.js']);
    assert.ok(fs.existsSync(path.join(ref.workerRoot, '.git', 'refs')), 'scrub leaves git\'s own empty dirs alone');
});

test('the mount is byte-identical across attempts (resume-safe baseline)', (t) => {
    const { options } = project(t);
    const one = prepareTaskWorkspace(options);
    const two = prepareTaskWorkspace({ ...options, attempt: 2 });
    for (const name of ['om-cook', 'karpathy-guidelines']) {
        const a = path.join(one.workerRoot, '.agents', 'skills', name);
        const b = path.join(two.workerRoot, '.agents', 'skills', name);
        assert.equal(hashDir(a), hashDir(b));
        assert.equal(fs.readFileSync(path.join(a, MOUNT_MARKER), 'utf8'), fs.readFileSync(path.join(b, MOUNT_MARKER), 'utf8'));
    }
});

test('a task cannot own a role skill dir or the worker git root', (t) => {
    const { options } = project(t);
    for (const file of ['.agents/skills/om-cook/SKILL.md', '.agents/skills']) {
        assert.throws(() => prepareTaskWorkspace({ ...options, allowedFiles: [file] }),
            (error) => error.code === 'DUAL_TASK_SCOPE_INVALID' && /role skill directory/.test(error.message));
    }
});

test('without squad config the worker root behaves exactly as before', (t) => {
    const { options } = project(t, { squad: false });
    const ref = prepareTaskWorkspace(options);
    assert.ok(fs.existsSync(path.join(ref.workerRoot, '.agents', 'skills', 'om-think', 'SKILL.md')), 'project skills still copied');
    assert.equal(fs.existsSync(path.join(ref.workerRoot, '.git')), false);
    assert.equal(readTaskBinding(options.workspaceRoot, ref).binding.workerOwnedPaths, undefined);
});

// Found in the P3 live run: the orchestrator's snapshot scrub pruned the empty
// objects/ and refs/ dirs of the worker's fresh `git init`, so review-time
// preflight saw a broken repository and blocked the worker.
test('snapshot scope scrub leaves the worker-owned git repository intact', (t) => {
    const { createBaselineOperations } = require('../lib/dual/orchestrator');
    const { createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
    const { execFileSync } = require('node:child_process');
    const root = tempDir(t, 'dual-squad-scrub-');
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    const initialSnapshot = createSnapshotBaseline({ root }).capture();
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'empty-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 2;\n');
    const ops = createBaselineOperations({ cwd: root, backend: 'snapshot', initialSnapshot, workerOwnedPaths: ['.agents/skills', '.git'] });
    ops.captureDiffFingerprint({ repoRoot: root, baseline: ops.baseline, excludedPaths: ['.git', '.agents/skills'], allowedFiles: ['index.js'], denyPatterns: [] });
    for (const dir of ['.git/objects', '.git/refs/heads', '.agents/skills/empty-skill']) assert.ok(fs.existsSync(path.join(root, dir)), dir);
    assert.equal(execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim(), '.git');
});
