'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DualPlanManifestSchema, SessionEventSchema } = require('../lib/dual/contracts');

const validTask = {
    task_id: 'TASK-1',
    title: 'Implement the scoped change',
    owner: 'codex',
    goal: 'Implement the scoped change safely',
    category: 'frontend',
    complexity: 'small',
    risk: 'low',
    allowed_files: ['src/feature.js'],
    context_files: [],
    deny_patterns: [],
    validation_commands: [],
};

function acceptancePolicy(taskId) {
    return {
        protocol_version: 1,
        checks: [{
            id: 'accept-1',
            requirement_id: 'requirement-1',
            phase: taskId ? 'pre_integration' : 'session',
            kind: 'command',
            required: true,
            command: { program: 'npm', args: ['test'], cwd: '.' },
            ...(taskId ? { task_id: taskId } : {}),
        }],
    };
}

function validManifest(policy = acceptancePolicy('TASK-1')) {
    return {
        schema_version: 1,
        plan_revision: 1,
        acceptance_policy: structuredClone(policy),
        tasks: [structuredClone(validTask)],
    };
}

test('requires acceptance policy in a new plan manifest', () => {
    const manifestWithoutPolicy = validManifest();
    delete manifestWithoutPolicy.acceptance_policy;

    const result = DualPlanManifestSchema.safeParse(manifestWithoutPolicy);
    assert.equal(result.success, false);
    assert.equal(result.error.issues.some((issue) => issue.path[0] === 'acceptance_policy'), true);
});

test('accepts an explicit valid policy and rejects malformed policy data', () => {
    assert.equal(DualPlanManifestSchema.safeParse(validManifest()).success, true);
    assert.equal(DualPlanManifestSchema.safeParse(validManifest({
        protocol_version: 1,
        checks: [],
        unexpected: true,
    })).success, false);
});

test('preserves policy task reference and task ID validation', () => {
    const unknownReference = DualPlanManifestSchema.safeParse(validManifest(acceptancePolicy('UNKNOWN-TASK')));
    assert.equal(unknownReference.success, false);
    assert.equal(unknownReference.error.issues.some((issue) => issue.path[0] === 'acceptance_policy'
        && issue.message.includes('targets unknown task UNKNOWN-TASK')), true);

    const duplicateIds = validManifest();
    duplicateIds.tasks.push({ ...structuredClone(validTask) });
    const duplicateResult = DualPlanManifestSchema.safeParse(duplicateIds);
    assert.equal(duplicateResult.success, false);
    assert.equal(duplicateResult.error.issues.some((issue) => issue.path[0] === 'tasks'
        && issue.path[2] === 'task_id' && issue.message.includes('duplicate task_id')), true);

    const malformedId = validManifest();
    malformedId.tasks[0].task_id = '!bad-id';
    malformedId.acceptance_policy = acceptancePolicy();
    const malformedIdResult = DualPlanManifestSchema.safeParse(malformedId);
    assert.equal(malformedIdResult.success, false);
    assert.equal(malformedIdResult.error.issues.some((issue) => issue.path[0] === 'tasks'
        && issue.path[2] === 'task_id'), true);
});

test('keeps historical plan.registered events readable without acceptance policy', () => {
    const historicalEvent = {
        schema_version: 2,
        event_id: '11111111-1111-4111-8111-111111111111',
        causation_id: '22222222-2222-4222-8222-222222222222',
        sequence: 3,
        workspace_id: 'ws-main',
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-24T12:00:00.000Z',
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'f'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/foo.js'] }],
    };

    assert.equal(SessionEventSchema.safeParse(historicalEvent).success, true);
});

test('keeps strict extra-key rejection for a new plan manifest', () => {
    assert.equal(DualPlanManifestSchema.safeParse({ ...validManifest(), unexpected: true }).success, false);
});
