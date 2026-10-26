'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectWorkspaceCoverage, validateDecisionLog } = require('./spec-coverage');

// All writable entry points use this evaluator, including retries and cached
// phase results. A missing legacy plan is supported; a declared v2 never falls
// back to legacy when its artifact or receipt cannot be read.
function inspectRuntimeCoverage(root, options = {}) {
    const derived = options.derived;
    let plan = options.plan;
    if (derived?.plan && derived.plan.schema_version !== 2 && plan?.schema_version !== 2) {
        return { state: 'LEGACY_UNCHECKED', allowed: true, reconnaissance_complete: true,
            warning: 'LEGACY_UNCHECKED: registered v1 plan', pending_ids: [] };
    }
    const planPath = options.plan_path || derived?.plan?.plan_path || derived?.plan?.planPath;
    if (!plan && planPath) {
        try {
            const bytes = fs.readFileSync(path.resolve(root, planPath));
            const expected = derived?.plan?.plan_sha256 || derived?.plan?.planSha256;
            if (expected && crypto.createHash('sha256').update(bytes).digest('hex') !== expected) return { state: 'STALE', allowed: false, errors: ['Registered plan hash changed'], pending_ids: [], reconnaissance_complete: false };
            plan = JSON.parse(bytes.toString('utf8'));
        }
        catch (error) {
            if (derived?.plan?.schema_version !== 2 && /\.md$/i.test(planPath)) return { state: 'LEGACY_UNCHECKED', allowed: true, reconnaissance_complete: true, warning: 'LEGACY_UNCHECKED: prose v1 plan', pending_ids: [] };
            return { state: 'INVALID', status: 'INVALID', pending_ids: [], errors: [error.message] };
        }
    }
    const context = {
        ...options,
        ...(plan ? { plan } : {}),
        session_id: options.session_id || derived?.sessionId,
        workspace: options.workspace || derived?.workspaceId,
        baseline: options.baseline || derived?.currentBaseline,
    };
    const gate = inspectWorkspaceCoverage(root, context);
    if (gate.plan?.schema_version === 2) {
        let complete = false;
        try {
            const recordBytes = fs.readFileSync(path.join(root, '.omni/sdlc/spec-coverage.reconnaissance.json'));
            const record = JSON.parse(recordBytes.toString('utf8'));
            gate.reconnaissance_digest = crypto.createHash('sha256').update(recordBytes).digest('hex');
            complete = record.plan_sha256 === crypto.createHash('sha256').update(JSON.stringify(gate.plan)).digest('hex')
                && JSON.stringify(record.baseline) === JSON.stringify(context.baseline || record.baseline)
                && record.task_ids.length === gate.plan.tasks.length
                && new Set(record.task_ids).size === gate.plan.tasks.length
                && record.task_ids.every((id) => gate.plan.tasks.some((task) => task.task_id === id))
                && record.contexts.length === gate.plan.tasks.length
                && new Set(record.contexts.map((entry) => entry.path)).size === gate.plan.tasks.length
                && record.contexts.every(({ path: file }) => {
                    const payload = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
                    return record.task_ids.includes(payload.task_id);
                })
                && new Set(record.contexts.map(({ path: file }) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).task_id)).size === gate.plan.tasks.length
                && record.contexts.every(({ path: file, sha256 }) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') === sha256);
            if (complete) {
                if (gate.receipt && gate.receipt.reconnaissance_digest !== gate.reconnaissance_digest) return { ...gate, state: 'STALE', allowed: false, reconnaissance_complete: true, errors: ['Reconnaissance binding changed'] };
                const approvedIds = new Set((gate.effective_artifact || gate.artifact)?.dimensions?.map((row) => row.id));
                const findings = record.contexts.flatMap(({ path: file }) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).coverage_findings || []);
                const newFindings = findings.filter((finding) => !approvedIds.has(finding.dimension_id));
                if (newFindings.length) return { ...gate, state: 'STALE', allowed: false, reconnaissance_complete: true, pending_ids: newFindings.map((finding) => finding.dimension_id), coverage_findings: newFindings };
            }
        } catch {}
        if (!complete && !['INVALID', 'STALE'].includes(gate.state)) return { ...gate, state: 'DRAFT', allowed: false, reconnaissance_complete: false };
    }
    return { ...gate, state: gate.state || gate.status, reconnaissance_complete: true };
}

function assertRuntimeCoverage(root, options = {}) {
    const gate = inspectRuntimeCoverage(root, options);
    if (gate.state !== 'PASSED' && gate.state !== 'LEGACY_UNCHECKED') {
        const error = new Error(`SPEC_COVERAGE_REQUIRED: coverage gate is ${gate.state}`);
        error.code = 'SPEC_COVERAGE_REQUIRED';
        try {
            fs.mkdirSync(path.join(root, '.omni/sdlc'), { recursive: true });
            fs.writeFileSync(path.join(root, '.omni/sdlc/spec-coverage.report.json'), JSON.stringify(gate, null, 2) + '\n');
        } catch {}
        error.details = { ...gate, artifact_path: gate.artifact_path || '.omni/sdlc/spec-coverage.json',
            report_path: gate.report_path || '.omni/sdlc/spec-coverage.report.json' };
        throw error;
    }
    return gate;
}

function assertRuntimeDecisionLog(root, runDir, taskId, options = {}) {
    const gate = assertRuntimeCoverage(root, options);
    if (gate.state === 'LEGACY_UNCHECKED') return gate;
    const artifact = gate.effective_artifact || gate.artifact || JSON.parse(fs.readFileSync(path.resolve(root,
        options.plan?.coverage?.path || '.omni/sdlc/spec-coverage.json'), 'utf8'));
    const logPath = path.join(runDir, 'decision-log.json');
    const entries = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
    const planTask = (options.plan || gate.plan)?.tasks?.find((task) => task.task_id === taskId);
    // Prose constraints need the independent review; schema constraints can be
    // checked before review starts. Final QC must check the original artifact.
    const schemaOnly = { ...artifact, dimensions: artifact.dimensions.map((row) => row.state === 'delegated'
        ? { ...row, constraints: row.constraints.filter((constraint) => typeof constraint === 'object') } : row) };
    const result = validateDecisionLog(schemaOnly, entries, { decision_ids: planTask?.decision_ids });
    if (!result.valid) {
        const error = new Error('SPEC_COVERAGE_REQUIRED: delegated decisions failed validation');
        error.code = 'SPEC_COVERAGE_REQUIRED';
        error.details = { state: 'STALE', pending_ids: [], errors: result.errors, decision_log_path: logPath };
        throw error;
    }
    return gate;
}

function assertRuntimeReview(root, runDir, taskId, review, options = {}) {
    const gate = assertRuntimeCoverage(root, options);
    if (gate.state === 'LEGACY_UNCHECKED') return gate;
    const artifact = gate.effective_artifact || gate.artifact;
    const ids = (options.plan || gate.plan)?.tasks?.find((task) => task.task_id === taskId)?.decision_ids || [];
    const checks = review?.coverage_checks || [];
    const errors = [];
    if (review?.schema_version !== 2) errors.push('Coverage-enabled review requires schema_version 2');
    for (const id of ids) {
        const row = artifact.dimensions.find((dimension) => dimension.id === id);
        if (['pinned', 'not_applicable'].includes(row?.state) && !checks.some((check) => check.dimension_id === id && check.satisfied === true && check.evidence_refs?.length)) errors.push(`${id}: missing independent coverage check`);
    }
    if (new Set(checks.map((check) => check.dimension_id)).size !== checks.length) errors.push('Duplicate coverage checks');
    const constraintFindings = review?.constraint_findings || [];
    if (new Set(constraintFindings.map((finding) => `${finding.dimension_id}:${finding.constraint}`)).size !== constraintFindings.length || constraintFindings.some((finding) => finding.satisfied !== true)) errors.push('Contradictory or failed constraint findings');
    if (checks.some((check) => !ids.includes(check.dimension_id) || check.satisfied !== true)) errors.push('Invalid or unsatisfied coverage check');
    if ((review?.coverage_findings || []).some((finding) => finding.severity === 'ERROR')) errors.push('Review found a coverage violation');
    const file = path.join(runDir, 'decision-log.json');
    const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    errors.push(...validateDecisionLog(artifact, entries, { decision_ids: ids, constraint_findings: review?.constraint_findings || [] }).errors);
    if (errors.length) {
        const error = new Error('SPEC_COVERAGE_REQUIRED: coverage review failed');
        error.code = 'SPEC_COVERAGE_REQUIRED';
        error.details = { state: 'STALE', errors };
        throw error;
    }
    return gate;
}

function assertRuntimeCoverageReview(root, runDir, taskId, options = {}) {
    const gate = assertRuntimeCoverage(root, options);
    if (gate.state === 'LEGACY_UNCHECKED') return gate;
    const review = JSON.parse(fs.readFileSync(path.join(runDir, 'review.json'), 'utf8'));
    const binding = JSON.parse(fs.readFileSync(path.join(runDir, 'coverage-input.json'), 'utf8'));
    if (binding.candidate_digest !== gate.candidate_digest || JSON.stringify(binding.receipt) !== JSON.stringify(gate.receipt)) {
        const error = new Error('SPEC_COVERAGE_REQUIRED: implementation coverage binding is stale');
        error.code = 'SPEC_COVERAGE_REQUIRED';
        throw error;
    }
    return assertRuntimeReview(root, runDir, taskId, review, options);
}

module.exports = { inspectRuntimeCoverage, assertRuntimeCoverage, assertRuntimeDecisionLog, assertRuntimeReview, assertRuntimeCoverageReview };
