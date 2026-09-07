'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DualPlanManifestSchema } = require('../lib/dual/contracts');
const { taskReadiness } = require('../lib/dual/task-scheduler');

function task(id, file, dependencies = []) {
    return { task_id: id, title: id, goal: id, owner: 'agy', execution_mode: 'isolated',
        risk: 'low', complexity: 'low', category: 'feature', allowed_files: [file],
        context_files: [], deny_patterns: [], depends_on: dependencies,
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] };
}
const plan = (tasks) => ({ schema_version: 1, plan_revision: 1, tasks });
const state = (tasks) => ({ tasks: Object.fromEntries(tasks.map((item) => [item.task_id, { ...item, state: 'ROUTED' }])) });

test('multiple isolated workers are allowed only with a valid dependency graph', () => {
    assert.equal(DualPlanManifestSchema.safeParse(plan([task('A', 'a.js'), task('B', 'b.js', ['A'])])).success, true);
    for (const tasks of [
        [task('A', 'a.js', ['missing'])], [task('A', 'a.js', ['A'])],
        [task('A', 'a.js', ['B']), task('B', 'b.js', ['A'])],
        [task('A', 'a.js'), { ...task('B', 'b.js'), execution_mode: 'shared' }],
    ]) assert.equal(DualPlanManifestSchema.safeParse(plan(tasks)).success, false);
});

test('dependency waits for verified integration, not just worker handoff', () => {
    const derived = state([task('A', 'a.js'), task('B', 'b.js', ['A'])]);
    derived.tasks.A.isolatedHandoff = { handoff_sha256: 'a'.repeat(64) };
    assert.deepEqual(taskReadiness(derived, 'B'), { status: 'WAITING_FOR_DEPENDENCY', waitingFor: ['A'] });
    derived.tasks.A.state = 'TASK_VERIFIED';
    assert.equal(taskReadiness(derived, 'B').status, 'READY');
});

test('overlapping write/read scopes serialize deterministically without blocking disjoint tasks', () => {
    const derived = state([task('A', 'src/a.js'), task('B', 'src/a.js'), task('C', 'src/c.js')]);
    assert.equal(taskReadiness(derived, 'A').status, 'READY');
    assert.deepEqual(taskReadiness(derived, 'B'), { status: 'WAITING_FOR_SCOPE', waitingFor: ['A'] });
    assert.equal(taskReadiness(derived, 'C').status, 'READY');
    derived.tasks.B.allowed_files = ['src/b.js'];
    derived.tasks.B.context_files = ['src/a.js'];
    assert.equal(taskReadiness(derived, 'B').status, 'WAITING_FOR_SCOPE');
});

test('dependency order wins over input order for conflicting tasks', () => {
    const derived = state([task('B', 'shared.js', ['A']), task('A', 'shared.js')]);
    assert.equal(taskReadiness(derived, 'A').status, 'READY');
    assert.equal(taskReadiness(derived, 'B').status, 'WAITING_FOR_DEPENDENCY');
});

test('portable scope identity detects case and parent/child conflicts', () => {
    assert.equal(taskReadiness(state([task('A', 'Src/A.js'), task('B', 'src/a.js')]), 'B').status, 'WAITING_FOR_SCOPE');
    assert.equal(taskReadiness(state([task('A', 'src'), task('B', 'src/a.js')]), 'B').status, 'WAITING_FOR_SCOPE');
});

test('unsupported mode and routing combinations are rejected before execution', () => {
    for (const invalid of [
        { ...task('B', 'b.js', ['A']), execution_mode: 'shared' },
        { ...task('B', 'b.js'), owner: 'codex' },
        { ...task('B', 'b.js'), risk: 'high' },
        { ...task('B', 'b.js'), category: 'security' },
    ]) assert.equal(DualPlanManifestSchema.safeParse(plan([task('A', 'a.js'), invalid])).success, false);
    assert.equal(DualPlanManifestSchema.safeParse(plan([
        { ...task('A', 'a.js'), execution_mode: 'shared', owner: 'codex' },
        { ...task('B', 'b.js', ['A']), execution_mode: 'shared' },
    ])).success, false, 'single shared AGY does not silently ignore dependencies');
    assert.equal(DualPlanManifestSchema.safeParse(plan([{ ...task('A', 'a.js'), execution_mode: 'shared', dependency_mode: 'npm-ci' }])).success,
        false, 'private dependency setup cannot be ignored by shared executor');
    assert.equal(DualPlanManifestSchema.safeParse(plan([{ ...task('A', 'package-lock.json'), dependency_mode: 'npm-ci' }])).success,
        false, 'dependency inputs stay immutable for the installed worker');
});
