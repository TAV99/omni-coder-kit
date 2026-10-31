'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRoles } = require('../lib/squad/roles');
const { loadCatalog, parseCatalog, resolveBundles, phaseOwners } = require('../lib/squad/skills-catalog');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');
const roles = loadRoles(path.join(TEMPLATES, 'roles'));
const shipped = loadCatalog(path.join(TEMPLATES, 'skills.yaml'), roles);

test('shipped catalog has no overlap with or without a reviewer', () => {
    for (const reviewerBound of [false, true]) {
        assert.deepEqual(resolveBundles({ catalog: shipped, roles, reviewerBound }).overlaps, [], `reviewer=${reviewerBound}`);
    }
});

test('qc skills follow the qc owner', () => {
    const solo = resolveBundles({ catalog: shipped, roles, reviewerBound: false });
    assert.equal(solo.owners.qc, 'orchestrator');
    assert.ok(solo.bundles.orchestrator.includes('om-check'));
    assert.equal(solo.bundles.reviewer, undefined);
    const withReviewer = resolveBundles({ catalog: shipped, roles, reviewerBound: true });
    assert.equal(withReviewer.owners.qc, 'reviewer');
    assert.ok(withReviewer.bundles.reviewer.includes('om-check'));
    assert.ok(!withReviewer.bundles.orchestrator.includes('om-check'));
});

test('bundle = shared_core + role + stack + held phases − exclude', () => {
    const catalog = parseCatalog({
        schema_version: 1, shared_core: ['core'], roles: { orchestrator: ['plan-x'], worker: ['code-x', 'banned'] },
        phases: { implement: ['impl-x'], qc: ['qc-x'] }, stack: { worker: ['vitest'] }, exclude: ['other'],
    }, 'c.yaml', roles);
    const { bundles } = resolveBundles({ catalog, roles });
    assert.deepEqual(bundles.worker, ['code-x', 'banned', 'core', 'impl-x', 'vitest'].sort());
    assert.deepEqual(bundles.orchestrator, ['core', 'plan-x', 'qc-x']);
});

test('a skill in two roles is an overlap unless it is shared_core', () => {
    const catalog = parseCatalog({ schema_version: 1, shared_core: ['core'],
        roles: { orchestrator: ['dup', 'core'], worker: ['dup', 'core'] } }, 'c.yaml', roles);
    assert.deepEqual(resolveBundles({ catalog, roles }).overlaps, [{ skill: 'dup', roles: ['orchestrator', 'worker'] }]);
});

test('catalog contradictions and unknown roles are rejected', () => {
    assert.throws(() => parseCatalog({ schema_version: 1, roles: { worker: ['x'] }, exclude: ['x'] }, 'c.yaml', roles),
        /"x" is in both exclude and roles\.worker/);
    assert.throws(() => parseCatalog({ schema_version: 1, roles: { designer: ['x'] } }, 'c.yaml', roles),
        /roles\.designer is not a defined role/);
    assert.throws(() => parseCatalog({ schema_version: 1, roles: {}, extra: 1 }, 'c.yaml', roles), { code: 'SQUAD_CONFIG_INVALID' });
    assert.throws(() => parseCatalog({ schema_version: 1, roles: { worker: ['Bad_Name'] } }, 'c.yaml', roles), { code: 'SQUAD_CONFIG_INVALID' });
});

test('phase owners come from role phases plus the qc rule', () => {
    assert.deepEqual(phaseOwners(roles), {
        spec: 'orchestrator', plan: 'orchestrator', integrate: 'orchestrator',
        scout: 'worker', implement: 'worker', correction: 'worker', qc: 'orchestrator',
    });
});
