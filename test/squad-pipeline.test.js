'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRoles } = require('../lib/squad/roles');
const { loadCatalog, resolveBundles } = require('../lib/squad/skills-catalog');
const {
    parsePipeline, loadPipeline, readPipelineIfAny, phaseOwnersFromPipeline, assertEngineSupports,
} = require('../lib/squad/pipeline');
const { runSquadChecks } = require('../lib/squad/doctor');
const { writeBinding } = require('../lib/squad/bindings');
const { tempDir, writeSkill } = require('./helpers/squad-project');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');
const roles = loadRoles(path.join(TEMPLATES, 'roles'));
const dual = loadPipeline(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), roles);
const squad = loadPipeline(path.join(TEMPLATES, 'pipelines', 'squad.yaml'), roles);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('shipped presets: dual and squad (reviewer QC, SPEC-SQUAD-P5) both run on the engine', () => {
    assert.deepEqual(assertEngineSupports(dual), { supported: true, problems: [] });
    assert.deepEqual(assertEngineSupports(squad), { supported: true, problems: [] });
    const reviewerScout = plain(squad);
    delete reviewerScout.source;
    reviewerScout.phases = reviewerScout.phases.map((p) => (p.id === 'scout' ? { ...p, role: 'reviewer' } : p));
    assert.match(assertEngineSupports(parsePipeline(reviewerScout, 'p.yaml', roles)).problems.join(), /phase scout phải thuộc vai worker/);
});

test('gate rules: auto_ok only on human gates; integrate must always wait for the user', () => {
    const base = plain(dual);
    delete base.source;
    assert.throws(() => parsePipeline({ ...base, phases: base.phases.map((p) => (p.id === 'scout' ? { ...p, auto_ok: true } : p)) }, 'p.yaml', roles),
        /auto_ok only applies to gate: human/);
    const softIntegrate = { ...base, phases: base.phases.map((p) => (p.id === 'integrate' ? { ...p, gate: 'human', auto_ok: true } : p)) };
    assert.match(assertEngineSupports(parsePipeline(softIntegrate, 'p.yaml', roles)).problems.join(), /integrate phải có gate: human-always/);
});

test('structure errors: duplicates, forward on_needs_fix, unknown role, wrong order', () => {
    const base = plain(dual);
    delete base.source;
    assert.throws(() => parsePipeline({ ...base, phases: [...base.phases, base.phases[0]] }, 'p.yaml', roles), /duplicate phase "spec"/);
    assert.throws(() => parsePipeline({ ...base, phases: base.phases.map((p) => (p.id === 'scout' ? { ...p, on_needs_fix: 'qc' } : p)) }, 'p.yaml', roles),
        /must be an earlier phase/);
    assert.throws(() => parsePipeline({ ...base, phases: base.phases.map((p) => (p.id === 'qc' ? { ...p, role: 'designer' } : p)) }, 'p.yaml', roles),
        /undefined role "designer"/);
    const swapped = { ...base, phases: [base.phases[1], base.phases[0], ...base.phases.slice(2)] };
    assert.match(assertEngineSupports(parsePipeline(swapped, 'p.yaml', roles)).problems.join(), /thứ tự phase/);
    const workerQc = { ...base, phases: base.phases.map((p) => (p.id === 'qc' ? { ...p, role: 'worker' } : p)) };
    assert.match(assertEngineSupports(parsePipeline(workerQc, 'p.yaml', roles)).problems.join(), /phase qc phải thuộc vai orchestrator/);
});

test('the pipeline decides who holds qc, and with it the QC skills', () => {
    assert.equal(phaseOwnersFromPipeline(dual).qc, 'orchestrator');
    assert.equal(phaseOwnersFromPipeline(squad).qc, 'reviewer');
    const catalog = loadCatalog(path.join(TEMPLATES, 'skills.yaml'), roles);
    const viaDual = resolveBundles({ catalog, roles, pipeline: dual });
    assert.ok(viaDual.bundles.orchestrator.includes('om-check'));
    assert.equal(viaDual.bundles.reviewer, undefined);
    const viaSquad = resolveBundles({ catalog, roles, pipeline: squad });
    assert.ok(viaSquad.bundles.reviewer.includes('om-check') && !viaSquad.bundles.orchestrator.includes('om-check'));
});

test('readPipelineIfAny: absent → null; present → loaded', (t) => {
    const root = tempDir(t, 'squad-pipeline-');
    assert.equal(readPipelineIfAny(root, roles), null);
    fs.mkdirSync(path.join(root, '.omni', 'squad'), { recursive: true });
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), path.join(root, '.omni', 'squad', 'pipeline.yaml'));
    assert.equal(readPipelineIfAny(root, roles).preset, 'dual');
});

test('doctor: missing pipeline warns; reviewer pipeline without a reviewer binding is an error', (t) => {
    const root = tempDir(t, 'squad-pipeline-');
    const squadDir = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squadDir, 'roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squadDir, 'roles', name));
    fs.writeFileSync(path.join(squadDir, 'skills.yaml'), 'schema_version: 1\nroles:\n  orchestrator: [plan-x]\n  worker: [code-x]\n');
    for (const name of ['plan-x', 'code-x']) writeSkill(path.join(root, '.omni', 'skills'), name);
    writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-01T00:00:00Z', roles: {
        orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' }, worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } });
    const codes = () => runSquadChecks({ projectRoot: root, homedir: '/nowhere', env: {} }).map((f) => `${f.level}:${f.code}`);
    assert.ok(codes().includes('warn:SQUAD_PIPELINE_MISSING'));
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'squad.yaml'), path.join(squadDir, 'pipeline.yaml'));
    const found = codes();
    assert.ok(found.includes('error:SQUAD_PIPELINE_BINDING_MISMATCH'));
    assert.ok(!found.includes('warn:SQUAD_PIPELINE_ENGINE_UNSUPPORTED'), 'the engine runs reviewer QC since P5');
});
