'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runSquadChecks } = require('../lib/squad/doctor');
const { writeBinding } = require('../lib/squad/bindings');
const { tempDir, writeSkill } = require('./helpers/squad-project');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');

function squadProject(t, catalogText) {
    const root = tempDir(t, 'squad-doctor-');
    const squad = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squad, 'roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squad, 'roles', name));
    fs.writeFileSync(path.join(squad, 'skills.yaml'), catalogText);
    writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-01T00:00:00Z',
        roles: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' }, worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } });
    for (const name of ['plan-x', 'code-x', 'dup']) writeSkill(path.join(root, '.omni', 'skills'), name);
    return root;
}

const CATALOG = 'schema_version: 1\nroles:\n  orchestrator: [plan-x, dup]\n  worker: [code-x, dup, ghost]\n';

test('no squad dir → doctor skips squad checks', (t) => {
    assert.equal(runSquadChecks({ projectRoot: tempDir(t, 'squad-doctor-'), homedir: '/nowhere', env: {} }), null);
});

test('overlap and missing skills are errors; unmanaged and user-level skills are warnings', (t) => {
    const root = squadProject(t, CATALOG);
    writeSkill(path.join(root, '.agents', 'skills'), 'stray');
    const home = tempDir(t, 'squad-home-');
    writeSkill(path.join(home, '.agents', 'skills'), 'global-one');
    writeSkill(path.join(home, '.gemini', 'antigravity-cli', 'skills'), 'global-two');
    const findings = runSquadChecks({ projectRoot: root, homedir: home, env: {} });
    const codes = (level) => findings.filter((f) => f.level === level).map((f) => f.code).sort();
    assert.deepEqual(codes('error'), ['SQUAD_SKILL_MISSING', 'SQUAD_SKILL_OVERLAP']);
    assert.ok(codes('warn').includes('SQUAD_SKILL_UNMANAGED'));
    assert.equal(findings.filter((f) => f.code === 'SQUAD_USER_SKILLS_GLOBAL').length, 2, 'codex ~/.agents/skills and agy global dir');
    assert.match(findings.find((f) => f.code === 'SQUAD_SKILL_OVERLAP').message, /"dup".*orchestrator, worker/);
});

test('broken YAML and broken binding are reported, not thrown', (t) => {
    const root = squadProject(t, 'schema_version: 1\nroles:\n  worker: [a]\n  worker: [b]\n');
    assert.equal(runSquadChecks({ projectRoot: root, homedir: '/nowhere', env: {} })[0].code, 'SQUAD_CONFIG_INVALID');
    const ok = squadProject(t, CATALOG);
    fs.writeFileSync(path.join(ok, '.omni', 'squad.local.json'), '{ not json');
    assert.ok(runSquadChecks({ projectRoot: ok, homedir: '/nowhere', env: {} }).some((f) => f.code === 'SQUAD_BINDING_INVALID'));
});
