'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runSetup, parseBind } = require('../lib/squad/setup');
const { MOUNT_MARKER } = require('../lib/squad/skill-store');
const { runSquadChecks } = require('../lib/squad/doctor');
const { tempDir, writeSkill, readyReports, registryWith } = require('./helpers/squad-project');

const BINDS = ['orchestrator=codex:gpt-6.1-sol:high', 'worker=agy:gemini-3.8-flash-high'];

function project(t) {
    const root = tempDir(t, 'squad-setup-');
    const skills = path.join(root, '.agents', 'skills');
    for (const name of ['om-think', 'karpathy-guidelines', 'om-cook', 'vitest', 'my-own-skill']) writeSkill(skills, name);
    fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ version: '3.2.0', ide: 'dual' }));
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n\n# Omni-Coder Kit (generated)\n.omni/\n');
    return { root, skills, home: tempDir(t, 'squad-home-') };
}

const run = (p, extra = {}) => runSetup({ projectRoot: p.root, homedir: p.home, binds: BINDS, yes: true,
    registry: registryWith(readyReports()), now: () => new Date('2026-11-01T10:00:00Z'), ...extra });

test('non-interactive setup: files, binding, manifest, store, stack, displacement, mount', async (t) => {
    const p = project(t);
    const result = await run(p);
    assert.deepEqual(result.created.sort(), ['.omni/squad/pipeline.yaml', '.omni/squad/roles/orchestrator.yaml', '.omni/squad/roles/reviewer.yaml',
        '.omni/squad/roles/worker.yaml', '.omni/squad/skills.yaml'].map((f) => f.split('/').join(path.sep)).sort());
    assert.deepEqual(result.pipeline, { preset: 'dual', supported: true, problems: [] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, '.omni', 'squad.local.json'), 'utf8')).roles.worker[0].runtime, 'agy');
    const manifest = JSON.parse(fs.readFileSync(path.join(p.root, '.omni', 'manifest.json'), 'utf8'));
    assert.deepEqual([manifest.ide, manifest.workerModel, manifest.workerEffort], ['dual', 'gemini-3.8-flash-high', 'high']);
    assert.deepEqual(result.imported.imported.sort(), ['karpathy-guidelines', 'my-own-skill', 'om-cook', 'om-think', 'vitest']);
    assert.deepEqual(result.stackFilled, ['vitest']);
    assert.match(fs.readFileSync(path.join(p.root, '.omni', 'squad', 'skills.yaml'), 'utf8'), /# Omni squad skill catalog/, 'comments kept');
    // worker/stack/unassigned skills leave the orchestrator's dir, but are moved, not deleted
    assert.deepEqual(result.displaced.moved, ['my-own-skill', 'om-cook', 'vitest']);
    for (const name of result.displaced.moved) assert.ok(fs.existsSync(path.join(result.displaced.to, name, 'SKILL.md')));
    // identical copies already in place are adopted
    assert.deepEqual(result.mount.adopted.sort(), ['karpathy-guidelines', 'om-think']);
    assert.ok(fs.existsSync(path.join(p.skills, 'om-think', MOUNT_MARKER)));
    assert.ok(result.mount.missing.includes('om-spec'), 'skills absent from the store are reported');
    const gitignore = fs.readFileSync(path.join(p.root, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.omni/*\n!.omni/squad/') && !/^\.omni\/$/m.test(gitignore));
    assert.ok(result.engine.supported);
});

test('a second run is idempotent and never overwrites edited role files', async (t) => {
    const p = project(t);
    await run(p);
    const worker = path.join(p.root, '.omni', 'squad', 'roles', 'worker.yaml');
    fs.writeFileSync(worker, fs.readFileSync(worker, 'utf8').replace('Scouts, implements', 'Edited by me'));
    const again = await run(p);
    assert.deepEqual(again.created, []);
    assert.match(fs.readFileSync(worker, 'utf8'), /Edited by me/);
    assert.deepEqual([again.mount.mounted, again.mount.removed, again.displaced.moved], [[], [], []]);
});

test('--keep-skills leaves foreign skills where they are', async (t) => {
    const p = project(t);
    const result = await run(p, { displace: false });
    assert.deepEqual(result.displaced.moved, []);
    assert.ok(fs.existsSync(path.join(p.skills, 'om-cook', 'SKILL.md')));
});

test('missing bindings and impossible bindings fail clearly', async (t) => {
    const p = project(t);
    await assert.rejects(run(p, { binds: [] }), /orchestrator: no binding/);
    await assert.rejects(run(p, { binds: ['orchestrator=codex:gpt-6.1-sol:high', 'worker=agy:gemini-3.8-flash-high:low'] }),
        /effort "low" is not valid/);
    assert.throws(() => parseBind('worker agy'), /expected <role>=<runtime>:<model>/);
});

test('interactive setup asks per slot and remembers the choice for next time', async (t) => {
    const p = project(t);
    const asked = [];
    const ask = {
        select: async ({ message, choices }) => { asked.push(message); return choices.includes('agy') && message.startsWith('worker') ? 'agy' : choices[0]; },
        text: async () => 'x',
        confirm: async () => false,
    };
    const result = await runSetup({ projectRoot: p.root, homedir: p.home, ask, registry: registryWith(readyReports()) });
    assert.deepEqual(asked, ['orchestrator: CLI', 'orchestrator: model', 'orchestrator: effort', 'worker-1: CLI', 'worker-1: model']);
    assert.equal(result.binding.roles.worker[0].effort, 'high', 'single allowed effort is taken without asking');
    const reused = await run(p, { binds: [] });
    assert.equal(reused.binding.roles.worker[0].model, result.binding.roles.worker[0].model);
});

test('doctor after setup: no errors, reports what is still missing', async (t) => {
    const p = project(t);
    await run(p);
    const findings = runSquadChecks({ projectRoot: p.root, homedir: p.home, env: {} });
    assert.deepEqual(findings.filter((f) => f.level === 'error').map((f) => f.code), ['SQUAD_SKILL_MISSING']);
    for (const name of ['om-spec', 'om-plan']) writeSkill(path.join(p.root, '.omni', 'skills'), name);
    assert.ok(runSquadChecks({ projectRoot: p.root, homedir: p.home, env: {} }).some((f) => f.code === 'SQUAD_SKILL_DRIFT'));
});
