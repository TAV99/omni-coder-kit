'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    AcceptancePolicySchema,
    ReviewEvidenceSchema,
    ReviewExecutionSchema,
    ReviewSubmissionSchema,
    ReviewAttestationSchema,
    createReviewAttestation,
    hashAcceptancePolicy,
    hashReviewEvidence,
    validateAcceptancePolicy,
    evaluatePreIntegrationReview,
    evaluatePostIntegrationReview,
    evaluateAttestedReview,
    evaluateSessionAcceptance,
} = require('../lib/dual/acceptance-policy');

const SHA = 'a'.repeat(64);

function withEvidenceDigest(evidence) {
    return { ...evidence, evidence_sha256: hashReviewEvidence(evidence) };
}

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
    const evidence = withEvidenceDigest({
        policy_sha256: policySha,
        task_id: 'T1',
        result_sha256: SHA,
        check_results: [
            { check_id: 'review-T1', status: 'PASS', findings: [] },
            { check_id: 'test-T1', status: 'PASS', findings: [] },
        ],
    });
    assert.equal(ReviewEvidenceSchema.safeParse(evidence).success, true);
    assert.equal(evaluatePreIntegrationReview(current, evidence, { taskId: 'T1', resultSha256: SHA }).status, 'PASSED');
    assert.throws(() => evaluatePreIntegrationReview(current, { ...evidence, result_sha256: 'b'.repeat(64) }, { taskId: 'T1', resultSha256: SHA }), /result/i);
});

test('missing mandatory review needs review and explicit failure needs fix', () => {
    const current = policy();
    const base = { policy_sha256: hashAcceptancePolicy(current), task_id: 'T1', result_sha256: SHA };
    assert.equal(evaluatePreIntegrationReview(current, withEvidenceDigest({ ...base, check_results: [] }), { taskId: 'T1', resultSha256: SHA }).status, 'NEEDS_REVIEW');
    assert.equal(evaluatePreIntegrationReview(current, withEvidenceDigest({ ...base, check_results: [{ check_id: 'review-T1', status: 'FAIL', findings: ['P5'] }] }), { taskId: 'T1', resultSha256: SHA }).status, 'NEEDS_FIX');
});

test('session acceptance requires every registered mandatory session check and leaves UI fallback to the daemon boundary', () => {
    const current = policy();
    assert.equal(evaluateSessionAcceptance(current, []).status, 'BLOCKED');
    assert.equal(evaluateSessionAcceptance(current, [{ check_id: 'session-test', status: 'PASS', findings: [] }]).status, 'PASSED');
    assert.equal(evaluateSessionAcceptance({ protocol_version: 1, checks: [] }, []).status, 'PASSED');
    assert.equal(current.ui, undefined, 'legacy policy stays readable without mutation');
});

test('review evidence digest is canonical, detects tampering, and rejects duplicate check IDs', () => {
    const current = policy();
    const base = {
        policy_sha256: hashAcceptancePolicy(current),
        task_id: 'T1',
        result_sha256: SHA,
        check_results: [
            { check_id: 'review-T1', status: 'PASS', findings: [] },
            { check_id: 'test-T1', status: 'PASS', findings: [] },
        ],
    };
    const signed = withEvidenceDigest(base);
    const reorderedKeys = {
        evidence_sha256: signed.evidence_sha256,
        result_sha256: signed.result_sha256,
        check_results: signed.check_results,
        task_id: signed.task_id,
        policy_sha256: signed.policy_sha256,
    };
    assert.equal(hashReviewEvidence(reorderedKeys), signed.evidence_sha256);
    assert.throws(
        () => evaluatePreIntegrationReview(current, { ...signed, check_results: [{ ...signed.check_results[0], findings: ['tampered'] }, signed.check_results[1]] }, { taskId: 'T1', resultSha256: SHA }),
        (error) => error.code === 'DUAL_ACCEPTANCE_EVIDENCE_TAMPERED'
    );
    const duplicate = withEvidenceDigest({
        ...base,
        check_results: [...base.check_results, { check_id: 'review-T1', status: 'FAIL', findings: ['duplicate'] }],
    });
    assert.throws(
        () => evaluatePreIntegrationReview(current, duplicate, { taskId: 'T1', resultSha256: SHA }),
        (error) => error.code === 'DUAL_ACCEPTANCE_EVIDENCE_INVALID'
    );
});

test('post-integration review is policy-bound and exposes only the registered correction grant', () => {
    const current = policy({
        checks: [...policy().checks, {
            id: 'session-review', requirement_id: 'REQ-SESSION-REVIEW', phase: 'session', kind: 'review', required: true,
        }],
        correction_grants: [{
            failure_check_id: 'session-review',
            task_id: 'T1',
            allowed_files: ['index.html'],
            validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        }],
    });
    assert.equal(validateAcceptancePolicy(current, { taskIds: ['T1'] }).ok, true);
    const evidence = withEvidenceDigest({
        policy_sha256: hashAcceptancePolicy(current),
        task_id: 'T1',
        result_sha256: SHA,
        check_results: [{ check_id: 'session-review', status: 'FAIL', findings: ['contrast'] }],
    });
    const result = evaluatePostIntegrationReview(current, evidence, { taskId: 'T1', resultSha256: SHA });
    assert.equal(result.status, 'NEEDS_FIX');
    assert.deepEqual(result.failed.map((item) => item.check_id), ['session-review']);
    assert.deepEqual(result.correction_grant, current.correction_grants[0]);
    assert.throws(() => evaluatePostIntegrationReview(current, evidence, { taskId: 'T1', resultSha256: 'b'.repeat(64) }), /result/i);
});

test('post-integration review accepts standalone session checks without correction grants', () => {
    const current = policy();
    const evidence = withEvidenceDigest({
        policy_sha256: hashAcceptancePolicy(current),
        task_id: 'T1',
        result_sha256: SHA,
        check_results: [{ check_id: 'session-test', status: 'PASS', findings: [] }],
    });
    const result = evaluatePostIntegrationReview(current, evidence, { taskId: 'T1', resultSha256: SHA });
    assert.equal(result.status, 'PASSED');
    assert.equal(result.correction_grant, null);
});

test('review submissions are untrusted findings and daemon attestations bind exact execution context', () => {
    const execution = {
        schema_version: 1,
        review_execution_id: '00000000-0000-4000-8000-000000000001',
        session_id: 'session-1',
        task_id: 'T1',
        plan_revision: 1,
        policy_sha256: hashAcceptancePolicy(policy()),
        result_sha256: SHA,
        diff_fingerprint: 'b'.repeat(64),
        review_phase: 'pre_integration',
        reviewer_role: 'codex',
        provenance_mode: 'fresh',
    };
    const submission = {
        review_execution_id: execution.review_execution_id,
        check_results: [{ check_id: 'review-T1', status: 'PASS', findings: [] }],
    };

    assert.equal(ReviewExecutionSchema.safeParse(execution).success, true);
    assert.equal(ReviewSubmissionSchema.safeParse(submission).success, true);
    assert.equal(ReviewSubmissionSchema.safeParse({ ...submission, evidence_sha256: SHA }).success, false);
    assert.equal(ReviewSubmissionSchema.safeParse({ ...submission, reviewer_role: 'codex' }).success, false);

    const attestation = createReviewAttestation(execution, submission);
    assert.equal(ReviewAttestationSchema.safeParse(attestation).success, true);
    assert.equal(attestation.review_execution_id, execution.review_execution_id);
    assert.match(attestation.attestation_sha256, /^[0-9a-f]{64}$/u);
});

test('post-integration attestations evaluate registered session review checks', () => {
    const current = policy({
        checks: policy().checks.map((check) => check.id === 'session-test'
            ? { id: check.id, requirement_id: check.requirement_id, phase: 'session', kind: 'review', required: true }
            : check),
    });
    const evidence = withEvidenceDigest({
        policy_sha256: hashAcceptancePolicy(current),
        task_id: 'T1',
        result_sha256: SHA,
        check_results: [{ check_id: 'session-test', status: 'PASS', findings: [] }],
    });

    assert.equal(evaluateAttestedReview(current, evidence, {
        reviewPhase: 'post_integration', taskId: 'T1', resultSha256: SHA,
    }).status, 'PASSED');
    assert.equal(evaluateAttestedReview(current, withEvidenceDigest({
        ...evidence,
        check_results: [{ check_id: 'session-test', status: 'FAIL', findings: ['Regression'] }],
    }), {
        reviewPhase: 'post_integration', taskId: 'T1', resultSha256: SHA,
    }).status, 'NEEDS_FIX');
});

test('post-integration blocked or unavailable checks never expose a correction grant', () => {
    const current = policy({
        checks: policy().checks.map((check) => check.id === 'session-test'
            ? { ...check, kind: 'review', command: undefined }
            : check),
        correction_grants: [{
            failure_check_id: 'session-test', task_id: 'T1', allowed_files: ['index.html'],
            validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        }],
    });
    for (const status of ['BLOCKED', 'UNAVAILABLE']) {
        const evidence = withEvidenceDigest({
            policy_sha256: hashAcceptancePolicy(current), task_id: 'T1', result_sha256: SHA,
            check_results: [{ check_id: 'session-test', status, findings: ['runtime unavailable'] }],
        });
        const result = evaluatePostIntegrationReview(current, evidence, { taskId: 'T1', resultSha256: SHA });
        assert.equal(result.status, 'NEEDS_FIX');
        assert.equal(result.correction_grant, undefined);
    }
});
