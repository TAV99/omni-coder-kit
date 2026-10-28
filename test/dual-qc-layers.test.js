'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBehaviorResults: parse, validateEvidenceMapping: validate, composeQcVerdict: compose } = require('../lib/dual/qc-layers');
const block = (value) => `log\n---QC-BEHAVIOR-RESULTS-BEGIN---\n${JSON.stringify(value)}\n---QC-BEHAVIOR-RESULTS-END---\nsummary`;
const results = { tests: [{ name: 'cart', passed: true }] };
const requirements = { requirements: [{ id: 'R1', text: 'Cart works' }] };
const evidence = { entries: [{ requirement_id: 'R1', tests: ['cart'] }] };
test('behavior protocol accepts valid stdout and rejects missing, malformed, empty and ambiguous results', () => {
    assert.equal(parse(block(results)).passed, true);
    for (const stdout of ['', '{}', block(results).replace('"tests"', 'bad'), block({}), block({ tests: [] }),
        block({ tests: [{ name: 'cart', passed: 'true' }] }), block({ tests: [...results.tests, ...results.tests] }),
        block(results) + block(results), '---QC-BEHAVIOR-RESULTS-END------QC-BEHAVIOR-RESULTS-BEGIN---']) {
        assert.equal(parse(stdout).passed, false, stdout);
    }
    assert.equal(parse(block({ tests: [{ name: 'cart', passed: false }] })).passed, false);
});
test('evidence requires all known requirements and existing passing tests', () => {
    assert.deepEqual(validate(requirements, evidence, results), { passed: true, failures: [] });
    for (const [req, ev, res] of [
        [requirements, { entries: [] }, results],
        [requirements, { entries: [...evidence.entries, { requirement_id: 'unknown', tests: ['cart'] }] }, results],
        [requirements, evidence, { tests: [] }],
        [requirements, evidence, { tests: [{ name: 'cart', passed: false }] }],
        [requirements, { entries: [{ requirement_id: 'R1', tests: [] }] }, results],
        [{}, evidence, results], [requirements, {}, results], [requirements, evidence, {}],
        [requirements, { entries: [...evidence.entries, ...evidence.entries] }, results],
    ]) assert.equal(validate(req, ev, res).passed, false);
});
test('verdict requires all three passing layers and no ERROR findings', () => {
    const layers = { checker: { passed: true }, behavior: { passed: true }, evidence: { passed: true } };
    assert.equal(compose(layers).passed, true);
    for (const layer of Object.keys(layers)) {
        assert.equal(compose({ ...layers, [layer]: { passed: false } }).passed, false);
        assert.equal(compose({ ...layers, [layer]: undefined }).passed, false);
    }
    assert.equal(compose({ ...layers, findings: [{ severity: 'WARNING' }] }).passed, true);
    const verdict = compose({ ...layers, findings: [{ severity: 'ERROR' }] });
    assert.equal(verdict.passed, false);
    assert.deepEqual(verdict.checker, layers.checker);
});

test('task contracts preserve optional QC fields and reject unsafe paths and excessive commands', () => {
    const { SpecSchema, DualPlanTaskSchema } = require('../lib/dual/contracts');
    const command = { program: 'node', args: ['scripts/qc-behavior.mjs'], cwd: '.' };
    const spec = { schema_version: 1, task_id: 'TASK-1', expected_base_commit: 'a'.repeat(40), goal: 'Cart',
        allowed_files: ['index.html'], deny_patterns: [], validation_commands: [command], risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1' };
    assert.equal(Object.hasOwn(SpecSchema.parse(spec), 'behavior_commands'), false);
    const fields = { behavior_commands: [command], qc_evidence: { requirements_path: 'scripts/requirements.json', evidence_path: 'scripts/evidence.json' } };
    assert.deepEqual(SpecSchema.parse({ ...spec, ...fields }).qc_evidence, fields.qc_evidence);
    const task = { task_id: 'TASK-1', title: 'Cart', owner: 'agy', goal: 'Cart', category: 'implementation', complexity: 'low', risk: 'low',
        allowed_files: ['index.html'], context_files: [], deny_patterns: [], validation_commands: [command] };
    assert.deepEqual(DualPlanTaskSchema.parse({ ...task, ...fields }).behavior_commands, [command]);
    for (const schemaAndValue of [[SpecSchema, spec], [DualPlanTaskSchema, task]]) {
        const [schema, value] = schemaAndValue;
        assert.equal(schema.safeParse({ ...value, behavior_commands: Array(51).fill(command) }).success, false);
        for (const candidate of ['../outside.json', '/tmp/outside.json', 'C:\\outside.json', 'safe/../../outside.json']) {
            for (const key of ['requirements_path', 'evidence_path']) {
                assert.equal(schema.safeParse({ ...value, ...fields, qc_evidence: { ...fields.qc_evidence, [key]: candidate } }).success, false);
            }
        }
    }
});
