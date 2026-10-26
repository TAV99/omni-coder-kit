'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateReviews } = require('../lib/dual/review-chunking');
function review(checks = [], constraints = [], findings = []) {
    return { schema_version: 2, task_id: 'TASK-A', recommendation: 'APPROVE', risk_level: 'LOW', findings: [], review_checks: ['checked'], challenge_summary: 'Inspected chunk', coverage_checks: checks, constraint_findings: constraints, coverage_findings: findings };
}
function check(id, satisfied = true) { return { dimension_id: id, satisfied, description: 'Observed code', evidence_refs: ['src/index.js:1'] }; }
test('v2 chunk aggregation retains checks from every chunk and deduplicates repeated evidence', () => {
    const finding = { dimension_id: 'actions.edit', severity: 'INFO', description: 'Delegated choice is valid', evidence_refs: ['src/index.js:1'] };
    const output = aggregateReviews([review([check('actions.edit')], [], [finding]), review([check('actions.delete'), check('actions.edit')], [], [finding])]);
    assert.equal(output.schema_version, 2);
    assert.deepEqual(output.coverage_checks.map((row) => row.dimension_id), ['actions.edit', 'actions.delete']);
    assert.equal(output.coverage_findings.length, 1);
    assert.equal(output.coverage_checks[0].evidence_refs.length, 1);
});
test('v2 contradictory dimension and prose constraint findings fail instead of being outvoted', () => {
    assert.throws(() => aggregateReviews([review([check('actions.edit')]), review([check('actions.edit', false)])]), { code: 'REVIEW_COVERAGE_INVALID' });
    const finding = { dimension_id: 'actions.edit', constraint: 'Preserve data', satisfied: true, evidence_ref: 'src/index.js:1' };
    assert.throws(() => aggregateReviews([review([], [finding]), review([], [{ ...finding, satisfied: false }])]), { code: 'REVIEW_COVERAGE_INVALID' });
});
test('mixed review schema versions cannot erase v2 coverage fields', () => {
    assert.throws(() => aggregateReviews([review(), { ...review(), schema_version: 1 }]), { code: 'REVIEW_COVERAGE_INVALID' });
});

test('empty diff retains one bounded review chunk when schema whitespace exceeds the ceiling', () => {
    const { planReviewChunks } = require('../lib/dual/review-chunking');
    const schema = JSON.stringify({ type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${i}`, { type: 'string' }])) }, null, 10);
    const plan = planReviewChunks('Review', schema, '');
    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.chunks[0].text, '');
    assert.ok(plan.chunks[0].body_bytes <= 16384);
});
