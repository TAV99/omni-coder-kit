'use strict';

// `omni squad setup` (SPEC-SQUAD-P2 §8.2): role files, per-role bindings,
// skill store, and the orchestrator's skill mount in the project root.
// Worker roots are mounted per task by the isolated runner (P2c).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { defaultRegistry } = require('./runtimes');
const { loadRoles } = require('./roles');
const { loadCatalog, resolveBundles } = require('./skills-catalog');
const { readPipelineIfAny, assertEngineSupports } = require('./pipeline');
const { createSkillStore } = require('./skill-store');
const { displaceUnmanaged } = require('./mount');
const { applyGitignore } = require('./gitignore');
const { writeClaudeOrchestratorConfig } = require('./claude-orchestrator');
const { writeCodexOrchestratorConfig } = require('./codex-orchestrator');
const {
    PRESETS, SquadBindingError, parseBinding, writeBinding, readUserDefaults, writeUserDefaults,
    checkBinding, engineSupport, legacyManifestFields,
} = require('./bindings');
const { FE_SKILLS, TEST_SKILLS, UI_SKILLS } = require('../skills');

const SQUAD_DIR = path.join('.omni', 'squad');
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates', 'squad');
// Project skill dirs imported into the store on setup (unmanaged copies only).
const IMPORT_DIRS = ['.agents/skills', '.claude/skills'];
const STACK_SKILLS = new Set([...FE_SKILLS, ...TEST_SKILLS, ...UI_SKILLS].map((s) => s.name));

function copyTemplates(projectRoot, preset, fsImpl) {
    const created = [];
    const pairs = [
        ...fsImpl.readdirSync(path.join(TEMPLATE_DIR, 'roles')).map((name) => [path.join('roles', name), path.join('roles', name)]),
        ['skills.yaml', 'skills.yaml'],
        [path.join('pipelines', `${preset}.yaml`), 'pipeline.yaml'],
    ];
    for (const [from, to] of pairs) {
        const target = path.join(projectRoot, SQUAD_DIR, to);
        if (fsImpl.existsSync(target)) continue; // never overwrite the user's edits
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        fsImpl.copyFileSync(path.join(TEMPLATE_DIR, from), target);
        created.push(path.join(SQUAD_DIR, to));
    }
    return created;
}

// "worker-2=agy:gemini-3.8-flash-high" → { id: 'worker-2', runtime, model, effort? }
function parseBind(text) {
    const match = /^(orchestrator|reviewer|worker(?:-[1-9][0-9]?)?)=([a-z][a-z0-9-]{1,31}):([^:\s]+)(?::([a-z]+))?$/.exec(String(text).trim());
    if (!match) throw new SquadBindingError(`--bind "${text}": expected <role>=<runtime>:<model>[:<effort>]`);
    const id = match[1] === 'worker' ? 'worker-1' : match[1];
    return { id, runtime: match[2], model: match[3], ...(match[4] ? { effort: match[4] } : {}) };
}

function slotIds(preset, workers) {
    const count = Math.min(Math.max(workers, PRESETS[preset].workers[0]), PRESETS[preset].workers[1]);
    return ['orchestrator', ...Array.from({ length: count }, (_, i) => `worker-${i + 1}`), ...(PRESETS[preset].reviewer ? ['reviewer'] : [])];
}

const roleOf = (id) => (id.startsWith('worker-') ? 'worker' : id);

async function chooseSlot({ id, roles, registry, reports, ask, fallback }) {
    const role = roles[roleOf(id)];
    const ready = new Set(reports.filter((r) => r.ready).map((r) => r.id));
    const eligible = registry.eligibleFor(role.requires).filter((runtimeId) => ready.has(runtimeId));
    if (eligible.length === 0) {
        throw new SquadBindingError(`${id}: no ready CLI has ${role.requires.join(', ')} — run "omni squad runtimes" to see what to fix`);
    }
    const runtime = await ask.select({ message: `${id}: CLI`, choices: eligible, initial: fallback?.runtime });
    const models = reports.find((r) => r.id === runtime)?.models?.models || [];
    const model = models.length
        ? await ask.select({ message: `${id}: model`, choices: models.map((m) => m.id), initial: fallback?.runtime === runtime ? fallback.model : undefined })
        : await ask.text({ message: `${id}: model (${runtime} không liệt kê model)` });
    const efforts = models.find((m) => m.id === model)?.efforts || null;
    let effort;
    if (efforts && efforts.length === 1) [effort] = efforts;
    else if (efforts && efforts.length > 1) {
        const preferred = fallback?.model === model ? fallback.effort : models.find((m) => m.id === model).defaultEffort;
        effort = await ask.select({ message: `${id}: effort`, choices: efforts, initial: preferred });
    }
    return { runtime, model, ...(effort ? { effort } : {}) };
}

// Fills stack.worker from stack skills already in the store, keeping comments.
function fillWorkerStack(catalogFile, catalog, store, fsImpl) {
    if ((catalog.stack.worker || []).length > 0) return [];
    const assigned = new Set([
        ...catalog.shared_core, ...catalog.exclude,
        ...Object.values(catalog.roles).flat(), ...Object.values(catalog.phases).flat(), ...Object.values(catalog.stack).flat(),
    ]);
    const picks = store.list().filter((name) => STACK_SKILLS.has(name) && !assigned.has(name));
    if (picks.length === 0) return [];
    const doc = YAML.parseDocument(fsImpl.readFileSync(catalogFile, 'utf8'));
    doc.setIn(['stack', 'worker'], picks);
    fsImpl.writeFileSync(catalogFile, String(doc));
    return picks;
}

async function runSetup({
    projectRoot, preset = 'dual', workers = 1, binds = [], yes = false, displace,
    registry = defaultRegistry, ask, homedir = os.homedir(), now = () => new Date(),
    probeCtx = {}, fsImpl = fs,
}) {
    if (!PRESETS[preset]) throw new SquadBindingError(`unknown preset "${preset}" (dual | squad)`);
    const root = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(projectRoot) : fsImpl.realpathSync(projectRoot);
    const reports = await registry.probeAll(probeCtx);

    const created = copyTemplates(root, preset, fsImpl);
    const roles = loadRoles(path.join(root, SQUAD_DIR, 'roles'), { fsImpl });
    const pipeline = readPipelineIfAny(root, roles, { fsImpl });
    const catalogFile = path.join(root, SQUAD_DIR, 'skills.yaml');

    // 1. Bindings: --bind wins, then (with --yes) last-used defaults, else ask.
    const given = Object.fromEntries(binds.map(parseBind).map((b) => [b.id, b]));
    const defaults = readUserDefaults(homedir, { fsImpl })[preset] || {};
    const defaultOf = (id) => (id.startsWith('worker-') ? (defaults.worker || []).find((w) => w.id === id) : defaults[id]) || null;
    const chosen = {};
    for (const id of slotIds(preset, workers)) {
        const pick = given[id] || (yes ? defaultOf(id) : null);
        if (pick) {
            const { id: _ignored, ...slot } = pick;
            chosen[id] = slot;
        } else if (yes || !ask) {
            throw new SquadBindingError(`${id}: no binding — pass --bind ${id}=<runtime>:<model>[:<effort>]`);
        } else {
            chosen[id] = await chooseSlot({ id, roles, registry, reports, ask, fallback: defaultOf(id) });
        }
    }
    const binding = parseBinding({
        schema_version: 1,
        preset,
        roles: {
            orchestrator: chosen.orchestrator,
            worker: Object.keys(chosen).filter((id) => id.startsWith('worker-')).map((id) => ({ id, ...chosen[id] })),
            reviewer: chosen.reviewer || null,
        },
        probed: Object.fromEntries(reports.filter((r) => r.version?.ok).map((r) => [r.id, r.version.version])),
        updated_at: now().toISOString(),
    });
    const check = checkBinding(binding, { roles, registry, reports });
    if (pipeline && pipeline.preset !== preset) {
        check.warnings.push({ code: 'SQUAD_PIPELINE_PRESET_MISMATCH',
            message: `.omni/squad/pipeline.yaml is preset ${pipeline.preset}, setup used ${preset}; the existing pipeline was kept` });
    }
    if (check.errors.length) throw new SquadBindingError(check.errors.map((e) => e.message).join('; '), { errors: check.errors });
    writeBinding(root, binding, { fsImpl });
    writeUserDefaults(homedir, binding, { fsImpl });

    const manifestFile = path.join(root, '.omni', 'manifest.json');
    const legacy = legacyManifestFields(binding, reports);
    if (legacy && fsImpl.existsSync(manifestFile)) {
        const manifest = JSON.parse(fsImpl.readFileSync(manifestFile, 'utf8'));
        fsImpl.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, ...legacy }, null, 2)}\n`);
    }
    // The orchestrator gets the omni_dual MCP server and hook bridge: claude (SPEC-SQUAD-P4 §5)
    // and codex alike, so setup alone is enough whichever CLI holds the role.
    const orchestratorRuntime = binding.roles.orchestrator.runtime;
    const orchestratorConfig = orchestratorRuntime === 'claude' ? writeClaudeOrchestratorConfig({ projectRoot: root, fsImpl })
        : orchestratorRuntime === 'codex' ? writeCodexOrchestratorConfig({ projectRoot: root, fsImpl }) : null;
    if (orchestratorConfig) check.warnings.push(...orchestratorConfig.warnings);

    // 2. Gitignore D10, skill store, stack skills.
    const gitignore = applyGitignore(root, [], { fsImpl });
    const store = createSkillStore(root, { fsImpl });
    const imported = { imported: [], same: [], conflicts: [] };
    for (const dir of IMPORT_DIRS) {
        const result = store.importFrom(path.join(root, dir));
        for (const key of Object.keys(imported)) imported[key].push(...result[key]);
    }
    let catalog = loadCatalog(catalogFile, roles, { fsImpl });
    const stackFilled = fillWorkerStack(catalogFile, catalog, store, fsImpl);
    if (stackFilled.length) catalog = loadCatalog(catalogFile, roles, { fsImpl });
    const { bundles, overlaps } = resolveBundles({ catalog, roles, reviewerBound: Boolean(binding.roles.reviewer), pipeline });

    // 3. Orchestrator mount in the project root; move foreign skills aside first.
    const orchestrator = registry.get(binding.roles.orchestrator.runtime);
    let displaced = { moved: [], to: null };
    let mount = null;
    if (typeof orchestrator.skillDirs === 'function') {
        const skillDir = orchestrator.skillDirs('project')[0];
        const keep = new Set(bundles.orchestrator);
        const shouldDisplace = displace !== undefined ? displace
            : yes ? true
                : await ask.confirm({ message: `Chuyển các skill không thuộc vai orchestrator ra khỏi ${skillDir} (vào ${path.join('.omni', 'skills', '.displaced')}, không xóa)?`, initial: true });
        if (shouldDisplace) displaced = displaceUnmanaged({ store, root, skillDir, keep, now: now(), fsImpl });
        mount = orchestrator.mountSkills({ store, root, skills: bundles.orchestrator, roleId: 'orchestrator', now: now() });
    }

    return {
        root, binding, warnings: check.warnings, engine: engineSupport(binding), created,
        pipeline: pipeline ? { preset: pipeline.preset, ...assertEngineSupports(pipeline) } : null,
        gitignore, imported, stackFilled, bundles, overlaps, displaced, mount,
        orchestratorConfig: orchestratorConfig ? orchestratorConfig.written : [],
    };
}

module.exports = { runSetup, parseBind, slotIds, SQUAD_DIR, TEMPLATE_DIR };
