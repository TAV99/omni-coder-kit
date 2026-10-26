'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DualPlanManifestSchema, EvidenceSchema, ReviewSchema, DecisionLogSchema } = require('../lib/dual/contracts');

function plan(version = 2) {
    return {
        schema_version: version, plan_revision: 1,
        ...(version === 2 ? { coverage: { path: '.omni/sdlc/spec-coverage.json', sha256: 'a'.repeat(64), catalog_version: 1 } } : {}),
        acceptance_policy: { protocol_version: 1, checks: [{ id: 'check', requirement_id: 'req', phase: 'session',
            kind: 'command', required: true, command: { program: 'node', args: ['--version'], cwd: '.' } }] },
        tasks: [{ task_id: 'TASK-1', title: 'Feature', owner: 'codex', goal: 'Implement feature',
            category: 'feature', complexity: 'small', risk: 'low', allowed_files: ['src/a.js'],
            context_files: [], deny_patterns: [], validation_commands: [],
            ...(version === 2 ? { decision_ids: ['actions.create'] } : {}) }],
    };
}

test('strict v1 and v2 plans retain explicit version authority', () => {
    assert.equal(DualPlanManifestSchema.parse(plan(1)).schema_version, 1);
    assert.equal(DualPlanManifestSchema.parse(plan(2)).schema_version, 2);
    const missing = plan(); delete missing.coverage;
    assert.equal(DualPlanManifestSchema.safeParse(missing).success, false);
    const unknown = plan(); unknown.coverage.catalog_version = 100;
    assert.equal(DualPlanManifestSchema.safeParse(unknown).success, false);
    const traversal = plan(); traversal.coverage.path = '../outside.json';
    assert.equal(DualPlanManifestSchema.safeParse(traversal).success, false);
    const missingIds = plan(); delete missingIds.tasks[0].decision_ids;
    assert.equal(DualPlanManifestSchema.safeParse(missingIds).success, false);
    const duplicate = plan(); duplicate.tasks[0].decision_ids.push('actions.create');
    assert.equal(DualPlanManifestSchema.safeParse(duplicate).success, false);
    const legacyExtra = plan(1); legacyExtra.coverage = plan().coverage;
    assert.equal(DualPlanManifestSchema.safeParse(legacyExtra).success, false);
});

test('v2 worker evidence requires explicit decision log while v1 remains strict', () => {
    const evidence = { schema_version: 1, task_id: 'TASK-1', expected_base_commit: 'a'.repeat(40), status: 'SUCCESS',
        modified_files: [], command_outputs: [], unverified_items: [],
        self_review: { checks: ['scope', 'tests', 'regression'], remaining_risks: [] } };
    assert.equal(EvidenceSchema.safeParse(evidence).success, true);
    assert.equal(EvidenceSchema.safeParse({ ...evidence, decision_log: [] }).success, false);
    assert.equal(EvidenceSchema.safeParse({ ...evidence, schema_version: 2 }).success, false);
    assert.equal(EvidenceSchema.safeParse({ ...evidence, schema_version: 2, decision_log: [] }).success, true);
    const entry = { dimension_id: 'ui.copy', chosen_value: { language: 'vi' }, rationale: 'Approved delegation', evidence_refs: ['src/a.js'] };
    assert.equal(DecisionLogSchema.safeParse([entry]).success, true);
    assert.equal(DecisionLogSchema.safeParse([entry, entry]).success, false);
    assert.equal(DecisionLogSchema.safeParse([{ ...entry, evidence_refs: [] }]).success, false);
});


test('coverage review requires pinned checks and independently evidenced textual constraints', () => {
    const review = { schema_version: 2, task_id: 'TASK-1', expected_base_commit: 'a'.repeat(40),
        recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
        review_checks: ['scope', 'tests', 'requirements'], challenge_summary: 'Checked all evidence.',
        coverage_findings: [], coverage_checks: [{ dimension_id: 'actions.delete', satisfied: true,
            description: 'No delete action exists', evidence_refs: ['src/actions.js'] }],
        constraint_findings: [{ dimension_id: 'ui.copy', constraint: 'Vietnamese labels', satisfied: true,
            evidence_ref: 'src/labels.js' }] };
    assert.equal(ReviewSchema.safeParse(review).success, true);
    const missing = structuredClone(review); delete missing.constraint_findings;
    assert.equal(ReviewSchema.safeParse(missing).success, false);
    const noChecks = structuredClone(review); delete noChecks.coverage_checks;
    assert.equal(ReviewSchema.safeParse(noChecks).success, false);
    const emptyEvidence = structuredClone(review); emptyEvidence.coverage_checks[0].evidence_refs = [];
    assert.equal(ReviewSchema.safeParse(emptyEvidence).success, false);
    const noConstraintEvidence = structuredClone(review); noConstraintEvidence.constraint_findings[0].evidence_ref = '';
    assert.equal(ReviewSchema.safeParse(noConstraintEvidence).success, false);
});

test('worker schemas select the active version and baseline without sending unrelated branches', () => {
    const { ContextSchema, ReviewSchema, toDraft7Schema } = require('../lib/dual/contracts');
    for (const schema of [ContextSchema, ReviewSchema]) {
        for (const schemaVersion of [1, 2]) {
            for (const baselineKind of ['git', 'snapshot']) {
                const output = toDraft7Schema(schema, 'worker', { schemaVersion, baselineKind });
                assert.equal(output.properties?.schema_version.const, schemaVersion);
                assert.equal(Boolean(output.properties.expected_baseline), baselineKind === 'snapshot');
                assert.equal(output.anyOf, undefined);
                assert.ok(Buffer.byteLength(JSON.stringify(output, null, 2)) < 6000);
            }
        }
    }
});
