'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildInitConfig } = require('../../lib/init');
const { runSetup } = require('../../lib/squad/setup');
const { readBinding, writeBinding } = require('../../lib/squad/bindings');
const { DualPlanTaskSchema } = require('../../lib/dual/contracts');

const FIXTURE = path.resolve(__dirname, '../fixtures/acceptance');
const suite = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'tasks.json'), 'utf8'));
const ALL_TASK_IDS = Object.freeze(suite.tasks.map((task) => task.id));
const role = (runtime, model, effort) => Object.freeze({ runtime, model, effort });
const codex = role('codex', 'gpt-6.1-sol', 'high');
const agy = role('agy', 'gemini-3.8-flash-high', 'high');
const claude = role('claude', 'sonnet', 'low');
const reviewer = role('codex', 'gpt-6-luna', 'low');
const CONFIGS = Object.freeze({
    A: Object.freeze({ preset: 'dual', orchestrator: codex, workers: [agy], reviewer: null }),
    B: Object.freeze({ preset: 'dual', orchestrator: codex, workers: [claude], reviewer: null }),
    C: Object.freeze({ preset: 'squad', orchestrator: claude, workers: [agy, claude], reviewer }),
    D: Object.freeze({ preset: 'squad', orchestrator: codex, workers: [agy], reviewer }),
});
const fail = (message) => { throw Object.assign(new Error(message), { code: 'ACCEPTANCE_BAD_ARGS' }); };

function parseAcceptanceArgs(argv) {
    const args = { outDir: null, config: null, taskIds: [...ALL_TASK_IDS], auto: false };
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--auto') {
            if (seen.has(arg)) fail('Duplicate --auto');
            seen.add(arg); args.auto = true;
        } else if (arg === '--config' || arg === '--tasks') {
            if (seen.has(arg)) fail(`Duplicate ${arg}`);
            seen.add(arg);
            const value = argv[++index];
            if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
            if (arg === '--config') args.config = value;
            else {
                const ids = value.split(',');
                if (new Set(ids).size !== ids.length || ids.some((id) => !ALL_TASK_IDS.includes(id))) fail('Invalid or duplicate task IDs');
                args.taskIds = ALL_TASK_IDS.filter((id) => ids.includes(id));
            }
        } else if (!arg.startsWith('--') && !args.outDir) args.outDir = path.resolve(arg);
        else fail(`Unknown argument ${arg}`);
    }
    if (!args.outDir || !Object.hasOwn(CONFIGS, args.config)) fail('Use <out-dir> --config A|B|C|D [--tasks T01,T03] [--auto]');
    return args;
}

function acceptanceTasks(configName, taskIds = ALL_TASK_IDS) {
    const config = CONFIGS[configName];
    if (!config || !taskIds.length || new Set(taskIds).size !== taskIds.length || taskIds.some((id) => !ALL_TASK_IDS.includes(id))) fail('Invalid config/task selection');
    return suite.tasks.filter((task) => taskIds.includes(task.id)).map((task) => {
        const { id, ...contract } = structuredClone(task);
        const index = configName === 'C' ? (Number(id.slice(1)) - 1) % 2 : 0;
        const worker = config.workers[index];
        const registration = { ...contract, worker: `worker-${index + 1}`, model: worker.model, effort: worker.effort };
        DualPlanTaskSchema.parse(registration);
        return registration;
    });
}

async function prepareAcceptanceProject({ config: configName, taskIds = ALL_TASK_IDS, auto = false, registry, parent = os.tmpdir(), onCreated = () => {} }) {
    const config = CONFIGS[configName];
    const tasks = acceptanceTasks(configName, taskIds);
    const container = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'omni-squad-acceptance-')));
    fs.chmodSync(container, 0o700);
    const root = path.join(container, 'workspace');
    const home = path.join(container, 'setup-home');
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(home, { mode: 0o700 });
    onCreated({ root, container, home });
    const project = path.join(FIXTURE, 'bookshelf');
    fs.cpSync(project, root, { recursive: true, filter: (file) => file !== path.join(project, 'plans/finance-format.md') });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Omni Acceptance');
    git('config', 'user.email', 'omni-acceptance@example.invalid');
    git('add', '--', 'lib', 'bin', 'test', 'README.md', 'package.json', 'plans/plan.md');
    git('commit', '-m', 'Bookshelf acceptance baseline v1');
    const baselineCommit = git('rev-parse', 'HEAD').trim();
    const generated = buildInitConfig('dual', { dualPair: 'codex-agy', mode: auto ? 'auto' : 'manual', projectDir: root,
        workerModel: config.workers[0].model, workerEffort: config.workers[0].effort });
    for (const file of generated.files) {
        const target = path.join(root, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.sourcePath ? fs.readFileSync(file.sourcePath) : file.content, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(root, '.omni/manifest.json'), JSON.stringify(generated.manifest, null, 2) + '\n', { mode: 0o600 });
    const bind = (id, value) => `${id}=${value.runtime}:${value.model}:${value.effort}`;
    const setup = await runSetup({ projectRoot: root, homedir: home, yes: true, preset: config.preset, workers: config.workers.length,
        binds: [bind('orchestrator', config.orchestrator), ...config.workers.map((worker, index) => bind(`worker-${index + 1}`, worker)),
            ...(config.reviewer ? [bind('reviewer', config.reviewer)] : [])], ...(registry ? { registry } : {}) });
    // The explicit acceptance --auto flag configures this fresh binding, never a decision event.
    const binding = { ...readBinding(root), auto };
    writeBinding(root, binding);
    const planSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'plans/plan.md'))).digest('hex');
    return { root, container, home, tasks, config: configName, binding, setup, baselineCommit, planSha256,
        suiteVersion: suite.suite_version, completeSuite: tasks.length === ALL_TASK_IDS.length };
}

module.exports = { CONFIGS, ALL_TASK_IDS, FIXTURE, parseAcceptanceArgs, acceptanceTasks, prepareAcceptanceProject };
