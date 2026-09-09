'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    AcceptancePolicySchema,
    ReviewEvidenceSchema,
    hashAcceptancePolicy,
    validateAcceptancePolicy,
    evaluatePreIntegrationReview,
    evaluateSessionAcceptance,
} = require('../lib/dual/acceptance-policy');

const SHA = 'a'.repeat(64);

function policy(overrides = {}) {
    return {
        protocol_version: 1,
        checks: [
            { id: 'review-T1', requirement_id: 'REQ-1', task_id: 'T1', phase: 'pre_integration', kind: 'review', required: true },
            { id: 'test-T1', requirement_id: 'REQ-1', task_id: 'T1', phase: 'pre_integration', kind: 'command', required: true,
                command: { program: 'node', args: ['--version'], cwd: '.' } },
            { id: 'session-test', requirement_id: 'REQ-SESSION', phase: 'session', kind: 'command', required: true,
                command: { program: 'npm', args: ['test'], cwd: '.' } },
        ],
        ...overrides,
    };
}

test('acceptance policy requires typed checks and maps every requirement to a check', () => {
    const parsed = AcceptancePolicySchema.parse(policy());
    assert.equal(parsed.protocol_version, 1);
    assert.equal(validateAcceptancePolicy(parsed, { taskIds: ['T1'] }).ok, true);
    assert.throws(() => validateAcceptancePolicy({ ...parsed, checks: parsed.checks.map((check) => ({ ...check, required: false })) }, { taskIds: ['T1'] }), /requirement/i);
});

test('acceptance policy rejects worker-controlled task policy and invalid command shape', () => {
    assert.throws(() => validateAcceptancePolicy({ ...policy(), checks: [{ ...policy().checks[0], task_id: 'T2' }] }, { taskIds: ['T1'] }), /task/i);
    assert.equal(AcceptancePolicySchema.safeParse({ ...policy(), checks: [{ ...policy().checks[0], required: 'yes' }] }).success, false);
});

test('policy hash is deterministic and review evidence binds policy and task result', () => {
    const current = policy();
    const policySha = hashAcceptancePolicy(current);
    const evidence = {
        policy_sha256: policySha,
        task_id: 'T1',
        result_sha256: SHA,
        check_results: [
            { check_id: 'review-T1', status: 'PASS', findings: [] },
            { check_id: 'test-T1', status: 'PASS', findings: [] },
        ],
        evidence_sha256: SHA,
    };
    assert.equal(ReviewEvidenceSchema.safeParse(evidence).success, true);
    assert.equal(evaluatePreIntegrationReview(current, evidence, { taskId: 'T1', resultSha256: SHA }).status, 'PASSED');
    assert.throws(() => evaluatePreIntegrationReview(current, { ...evidence, result_sha256: 'b'.repeat(64) }, { taskId: 'T1', resultSha256: SHA }), /result/i);
});

test('missing mandatory review needs review and explicit failure needs fix', () => {
    const current = policy();
    const base = { policy_sha256: hashAcceptancePolicy(current), task_id: 'T1', result_sha256: SHA, evidence_sha256: SHA };
    assert.equal(evaluatePreIntegrationReview(current, { ...base, check_results: [] }, { taskId: 'T1', resultSha256: SHA }).status, 'NEEDS_REVIEW');
    assert.equal(evaluatePreIntegrationReview(current, { ...base, check_results: [{ check_id: 'review-T1', status: 'FAIL', findings: ['P5'] }] }, { taskId: 'T1', resultSha256: SHA }).status, 'NEEDS_FIX');
});

test('session acceptance requires every registered mandatory session check and ignores absent UI policy', () => {
    const current = policy();
    assert.equal(evaluateSessionAcceptance(current, []).status, 'BLOCKED');
    assert.equal(evaluateSessionAcceptance(current, [{ check_id: 'session-test', status: 'PASS', findings: [] }]).status, 'PASSED');
    assert.equal(evaluateSessionAcceptance({ protocol_version: 1, checks: [] }, []).status, 'PASSED');
});
