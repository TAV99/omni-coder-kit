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
    assert.throws(() => aggregateReviews([review([check('actions.edit')]), review([check('actions.edit', false)])]), { code: 'REVIEW_COVERAGE_CONTRADICTORY' });
    const finding = { dimension_id: 'actions.edit', constraint: 'Preserve data', satisfied: true, evidence_ref: 'src/index.js:1' };
    assert.throws(() => aggregateReviews([review([], [finding]), review([], [{ ...finding, satisfied: false }])]), { code: 'REVIEW_COVERAGE_CONTRADICTORY' });
});
test('mixed review schema versions cannot erase v2 coverage fields', () => {
    assert.throws(() => aggregateReviews([review(), { ...review(), schema_version: 1 }]), { code: 'REVIEW_COVERAGE_CONTRADICTORY' });
});

test('empty diff retains one bounded review chunk when schema whitespace exceeds the ceiling', () => {
    const { planReviewChunks } = require('../lib/dual/review-chunking');
    const { CEILINGS } = require('../lib/dual/discussion/contracts');
    const schema = JSON.stringify({ type: 'object', properties: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`field${i}`, { type: 'string' }])) }, null, 10);
    assert.ok(Buffer.byteLength(schema) > CEILINGS.maxBodyBytes, 'the pretty schema alone exceeds the ceiling');
    const plan = planReviewChunks('Review', schema, '');
    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.chunks[0].text, '');
    assert.ok(plan.chunks[0].body_bytes <= require('../lib/dual/discussion/contracts').CEILINGS.maxBodyBytes);
});

test('contradictory chunk reviews are a worker result failure; a broken chunk plan stays unclassified', () => {
    const { classifyFailure } = require('../lib/dual/correction-policy');
    const task = (code) => ({ task_id: 'TASK-1', lastOutcome: { attempt: 2, status: 'FAILED', code } });
    assert.deepEqual(classifyFailure(task('REVIEW_COVERAGE_CONTRADICTORY')), { category: 'worker', phase: 'worker_result' });
    assert.deepEqual(classifyFailure(task('REVIEW_COVERAGE_INVALID')), { category: 'unknown', phase: 'unclassified' });
});

test('a failed run records its validation errors in the outcome summary, never a path (omni-p8-test)', () => {
    const { failureCause } = require('../lib/dual/isolated-authority');
    const coverage = Object.assign(new Error('SPEC_COVERAGE_REQUIRED: coverage review failed'), { code: 'SPEC_COVERAGE_REQUIRED',
        details: { worker_artifact: 'coverage_review', errors: ['data.entities: missing independent coverage check', 'ui.copy: missing independent coverage check'] } });
    assert.equal(failureCause(coverage), ': data.entities: missing independent coverage check; ui.copy: missing independent coverage check');
    assert.equal(failureCause(Object.assign(new Error('Contradictory coverage_checks: errors.messages'), { code: 'REVIEW_COVERAGE_CONTRADICTORY' })),
        ': Contradictory coverage_checks: errors.messages');
    assert.equal(failureCause(new Error('ENOENT: /Users/someone/project/file missing')), ': ENOENT: [path] missing');
    assert.equal(failureCause(new Error('401 bearer abc.def rejected')), ': 401 [REDACTED_TOKEN] rejected');
    assert.equal(failureCause(undefined), '');
});

test('an outright seed failure is a harness launch failure; a kill mid-seed keeps its recovery path (omni-p8-test b9269199)', () => {
    const { isSeedFailure } = require('../lib/dual/isolated-authority');
    const { classifyFailure } = require('../lib/dual/correction-policy');
    assert.equal(isSeedFailure(new Error('Codex seed failed (exit=1, timedOut=false, overflowed=false): 429 Too Many Requests')), true);
    assert.equal(isSeedFailure(new Error('AGY seed failed with status \'error\': quota')), true);
    assert.equal(isSeedFailure(new Error('Codex seed failed (exit=null, timedOut=false, overflowed=false): killed')), false, 'kill');
    assert.equal(isSeedFailure(new Error('AGY seed process failed (exitCode=1, timedOut=true, overflowed=false, transportError=x): slow')), false, 'timeout');
    assert.equal(isSeedFailure(Object.assign(new Error('Codex seed failed (exit=1)'), { code: 'OWNER_BUSY' })), false, 'a coded error keeps its code');
    assert.deepEqual(classifyFailure({ task_id: 'TASK-1', lastOutcome: { attempt: 1, status: 'FAILED', code: 'DUAL_DISCUSSION_SEED_FAILED' } }),
        { category: 'harness', phase: 'worker_launch' });
});

test('a file cut across chunks says which part it is, and every chunk follows the coverage contract (omni-p8-test)', () => {
    const { planReviewChunks } = require('../lib/dual/review-chunking');
    const { CEILINGS } = require('../lib/dual/discussion/contracts');
    const line = `<path d="${'M0 0 L1 1 '.repeat(20)}"/>\n`;
    const diff = `New file: index.html\n${line.repeat(Math.ceil((CEILINGS.maxBodyBytes * 2.5) / line.length))}`;
    const plan = planReviewChunks('# Task: T1\n', '{"type":"object"}', diff);
    assert.ok(plan.chunks.length >= 3);
    plan.chunks.forEach((chunk, index) => {
        assert.match(chunk.body, new RegExp(`Part ${index + 1} of ${plan.chunks.length} of this file`));
        assert.match(chunk.body, /follow the Review coverage contract/);
        assert.doesNotMatch(chunk.body, /Never claim checks for unseen code/);
        assert.ok(chunk.body_bytes <= CEILINGS.maxBodyBytes);
    });
    const small = planReviewChunks('# Task: T1\n', '{"type":"object"}', 'New file: a.css\nbody{}\n');
    assert.equal(small.chunks.length, 1);
    assert.doesNotMatch(small.chunks[0].body, /Part 1 of/);
});

test('each chunk knows its position across files, and an unseen file is a risk, not a finding (omni-p8-test c3b7f3cb)', () => {
    const { planReviewChunks } = require('../lib/dual/review-chunking');
    const { CEILINGS } = require('../lib/dual/discussion/contracts');
    const line = (n) => `.rule-${n} { color: #123456; padding: 1rem; }\n`;
    const file = (name, count) => `New file: ${name}\n${Array.from({ length: count }, (_, i) => line(i)).join('')}`;
    const lines = Math.ceil((CEILINGS.maxBodyBytes * 0.8) / line(100).length);
    const plan = planReviewChunks('# Task: T1\n', '{"type":"object"}', file('index.html', lines) + file('src/style.css', lines));
    assert.ok(plan.chunks.length >= 2);
    const count = plan.chunks.length;
    plan.chunks.forEach((chunk, index) => {
        assert.match(chunk.body, new RegExp(`Review chunk ${index + 1} of ${count} of a larger diff`));
        assert.equal(/\(the last chunk\)/.test(chunk.body), index === count - 1);
        assert.match(chunk.body, /never return NEEDS_FIX or REJECT for it; note it in remaining risks/);
        assert.doesNotMatch(chunk.body, /Only approve this chunk if supported/);
        assert.ok(chunk.body_bytes <= CEILINGS.maxBodyBytes);
    });
    assert.ok(plan.chunks.some((chunk) => /File context[^\n]*src\/style\.css/.test(chunk.body)));
    const small = planReviewChunks('# Task: T1\n', '{"type":"object"}', 'New file: a.css\nbody{}\n');
    assert.doesNotMatch(small.chunks[0].body, /Review chunk 1 of/);
});
