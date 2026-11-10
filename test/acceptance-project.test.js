'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readyReports, registryWith } = require('./helpers/squad-project');
const api = () => {
    assert.ok(fs.existsSync(path.join(__dirname, 'helpers/acceptance-project.js')), 'P7c project preparation helper must exist');
    return require('./helpers/acceptance-project');
};

const registry = () => registryWith(readyReports({ codexModels: ['gpt-6.1-sol', 'gpt-6-luna'], claudeModels: ['sonnet'] }));

test('acceptance arguments select a config and canonical task subset without changing worker assignment', () => {
    const { parseAcceptanceArgs, acceptanceTasks } = api();
    const args = parseAcceptanceArgs(['out', '--config', 'C', '--tasks', 'T08,T01', '--auto']);
    assert.equal(args.outDir, path.resolve('out'));
    assert.equal(args.config, 'C');
    assert.equal(args.auto, true);
    assert.deepEqual(args.taskIds, ['T01', 'T08']);
    const tasks = acceptanceTasks(args.config, args.taskIds);
    assert.deepEqual(tasks.map((task) => [task.task_id, task.worker]), [['T01', 'worker-1'], ['T08', 'worker-2']]);
    assert.equal(tasks[0].model, 'gemini-3.8-flash-high');
    assert.equal(tasks[1].model, 'sonnet');
    assert.ok(tasks.every((task) => !('id' in task)));
    assert.deepEqual(acceptanceTasks('C').map((task) => task.worker), Array.from({ length: 10 }, (_, i) => i % 2 ? 'worker-2' : 'worker-1'));
});

test('acceptance rejects incomplete/unknown/duplicate arguments before creating output', () => {
    const { parseAcceptanceArgs, CONFIGS } = api();
    for (const argv of [[], ['out'], ['out', '--config'], ['out', '--config', 'E'],
        ['out', '--config', 'A', '--tasks', 'T11'], ['out', '--config', 'A', '--tasks', 'T01,T01'],
        ['out', '--config', 'A', '--tasks', ''], ['out', '--config', 'A', '--tasks', 'T01,,T03'],
        ['out', '--config', 'A', '--config', 'B'], ['out', '--config', 'A', '--wat'],
        ['out', '--config', 'A', 'another-dir']]) {
        assert.throws(() => parseAcceptanceArgs(argv), { code: 'ACCEPTANCE_BAD_ARGS' });
    }
    assert.deepEqual(Object.keys(CONFIGS), ['A', 'B', 'C', 'D']);
});

test('delegated approvals are an explicit acceptance-only flag, separate from pipeline AUTO', () => {
    const args = api().parseAcceptanceArgs(['out', '--config', 'B', '--delegate-approvals']);
    assert.equal(args.delegateApprovals, true);
    assert.equal(args.auto, false);
    assert.throws(() => api().parseAcceptanceArgs(['out', '--config', 'B', '--delegate-approvals', '--delegate-approvals']),
        { code: 'ACCEPTANCE_BAD_ARGS' });
});

test('T04 registration carries the user-required missing-query error without changing fixture files', () => {
    const t04 = api().acceptanceTasks('B', ['T04'])[0];
    assert.match(t04.goal, /missing.*query.*error/i);
    assert.match(t04.goal, /whitespace.*literal/i);
});

for (const config of ['A', 'B', 'C', 'D']) {
    test(`fresh ${config} project: generated controller, bindings, clean baseline, finance withheld`, async (t) => {
        const { prepareAcceptanceProject, CONFIGS } = api();
        const prepared = await prepareAcceptanceProject({ config, auto: config === 'D', registry: registry() });
        t.after(() => fs.rmSync(prepared.container, { recursive: true, force: true }));
        const { root, binding } = prepared;
        assert.equal(root, fs.realpathSync.native(root));
        for (const file of ['AGENTS.md', 'CLAUDE.md', '.omni/workflows/dual-controller.md', '.codex/skills/om-plan/SKILL.md',
            '.omni/squad/pipeline.yaml']) assert.ok(fs.existsSync(path.join(root, file)), file);
        assert.ok(!fs.existsSync(path.join(root, 'plans/finance-format.md')));
        assert.ok(!fs.existsSync(path.join(root, 'hidden')));
        assert.ok(!fs.existsSync(path.join(root, 'reference')));
        assert.ok(!fs.existsSync(path.join(root, '.omni/runs/dual-authority/events.ndjson')), 'setup cannot decide gates');
        assert.equal(binding.preset, CONFIGS[config].preset);
        assert.equal(binding.roles.worker.length, config === 'C' ? 2 : 1);
        assert.equal(binding.auto, config === 'D');
        assert.ok(prepared.setup.engine.supported);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, '.omni/manifest.json'), 'utf8'));
        assert.equal(manifest.orchestratorRuntime, binding.roles.orchestrator.runtime);
        if (config === 'C') {
            assert.ok(fs.existsSync(path.join(root, '.mcp.json')));
            assert.ok(fs.existsSync(path.join(root, '.claude/settings.json')));
        } else {
            assert.ok(fs.existsSync(path.join(root, '.codex/config.toml')));
            assert.ok(fs.existsSync(path.join(root, '.codex/hooks.json')));
        }
        const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
        assert.match(tracked, /lib\/catalog.js/);
        assert.doesNotMatch(tracked, /finance-format|hidden|reference|AGENTS.md/);
        assert.match(prepared.planSha256, /^[0-9a-f]{64}$/);
        assert.equal(prepared.tasks.length, 10);
    });
}

test('failed setup exposes the retained workspace before probing starts', async (t) => {
    const { prepareAcceptanceProject } = api();
    let created;
    const brokenRegistry = { probeAll: async () => { throw new Error('probe unavailable'); } };
    await assert.rejects(prepareAcceptanceProject({ config: 'A', registry: brokenRegistry,
        onCreated: (paths) => { created = paths; } }), /probe unavailable/);
    assert.ok(created?.root && created?.container && created?.home);
    t.after(() => fs.rmSync(created.container, { recursive: true, force: true }));
    assert.ok(fs.existsSync(path.join(created.root, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(created.root, '.git')));
});
