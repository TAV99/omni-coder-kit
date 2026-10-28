'use strict';

const BEGIN = '---QC-BEHAVIOR-RESULTS-BEGIN---';
const END = '---QC-BEHAVIOR-RESULTS-END---';

// A command must emit exactly one complete, nonempty, unambiguous result block.
function parseBehaviorResults(stdout) {
    const failures = [];
    let tests = [];
    try {
        if (typeof stdout !== 'string' || stdout.split(BEGIN).length !== 2 || stdout.split(END).length !== 2) {
            throw new Error('Expected exactly one behavior results block');
        }
        const start = stdout.indexOf(BEGIN) + BEGIN.length;
        const end = stdout.indexOf(END);
        if (end < start) throw new Error('Behavior results markers are out of order');
        const parsed = JSON.parse(stdout.slice(start, end));
        if (!Array.isArray(parsed?.tests) || !parsed.tests.length) throw new Error('Behavior tests must be a nonempty array');
        const seen = new Set();
        for (const test of parsed.tests) {
            if (!test || typeof test.name !== 'string' || !test.name.trim() || typeof test.passed !== 'boolean') {
                throw new Error('Each behavior test requires a name and boolean passed');
            }
            if (seen.has(test.name)) throw new Error(`Duplicate behavior test: ${test.name}`);
            seen.add(test.name);
        }
        tests = parsed.tests;
        failures.push(...tests.filter((test) => !test.passed).map((test) => `Behavior test failed: ${test.name}`));
    } catch (error) { failures.push(error.message); }
    return { passed: failures.length === 0, tests, failures };
}

function validateEvidenceMapping(requirements, evidence, testResults) {
    const failures = [];
    if (!Array.isArray(requirements?.requirements) || !requirements.requirements.length
        || !Array.isArray(evidence?.entries) || !Array.isArray(testResults?.tests)) {
        return { passed: false, failures: ['Invalid requirements, evidence, or test results shape'] };
    }
    const ids = new Set();
    for (const requirement of requirements.requirements) {
        if (typeof requirement?.id !== 'string' || !requirement.id.trim()
            || typeof requirement.text !== 'string' || !requirement.text.trim() || ids.has(requirement.id)) {
            failures.push('Invalid or duplicate requirement');
        } else ids.add(requirement.id);
    }
    const results = new Map();
    for (const test of testResults.tests) {
        if (typeof test?.name !== 'string' || typeof test.passed !== 'boolean' || results.has(test.name)) {
            failures.push('Invalid or duplicate behavior test result');
        } else results.set(test.name, test.passed);
    }
    const covered = new Set();
    for (const entry of evidence.entries) {
        const id = entry?.requirement_id;
        if (!ids.has(id)) failures.push(`Unknown requirement: ${String(id)}`);
        if (covered.has(id)) failures.push(`Duplicate evidence entry: ${id}`);
        covered.add(id);
        if (!Array.isArray(entry?.tests) || !entry.tests.length) {
            failures.push(`Requirement ${id} has no evidence tests`);
            continue;
        }
        for (const name of entry.tests) {
            if (!results.has(name)) failures.push(`Requirement ${id} references missing test: ${String(name)}`);
            else if (results.get(name) !== true) failures.push(`Requirement ${id} references failed test: ${name}`);
        }
    }
    for (const id of ids) if (!covered.has(id)) failures.push(`Missing evidence for requirement: ${id}`);
    return { passed: failures.length === 0, failures };
}

function composeQcVerdict({ checker, behavior, evidence, findings = [] }) {
    const errors = findings.filter((finding) => finding.severity === 'ERROR');
    return { checker, behavior, evidence, findings,
        passed: checker?.passed === true && behavior?.passed === true && evidence?.passed === true && errors.length === 0 };
}

module.exports = { parseBehaviorResults, validateEvidenceMapping, composeQcVerdict };
