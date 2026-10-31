'use strict';

// Worker-root isolation for dual/squad tasks (SPEC-SQUAD-P2 §7, appendix §6.5).
// Only active once a project has .omni/squad: the project's role skill dirs are
// not copied into the worker root, the worker root becomes its own git root
// (agy walks up to the nearest git root to find skills — V8), and the worker
// bundle is mounted with timestamp-free markers so the mount is part of the
// worker baseline and identical across checkpoint resumes.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultRegistry } = require('./runtimes');
const { loadRoles } = require('./roles');
const { loadCatalog, resolveBundles } = require('./skills-catalog');
const { createSkillStore } = require('./skill-store');
const { mountBundle } = require('./mount');
const { readBinding } = require('./bindings');

const SQUAD_DIR = path.join('.omni', 'squad');
const WORKER_ID = 'worker-1';

// Skill dirs every registered runtime reads inside an isolated root.
function roleSkillDirs(registry = defaultRegistry) {
    const dirs = new Set();
    for (const runtime of registry.list()) {
        if (typeof runtime.skillDirs === 'function') for (const dir of runtime.skillDirs('isolated')) dirs.add(dir);
    }
    return [...dirs].sort();
}

// null when the project has no squad config (legacy dual behaviour is kept).
function workerSkillPlan(projectRoot, { registry = defaultRegistry, fsImpl = fs } = {}) {
    if (!fsImpl.existsSync(path.join(projectRoot, SQUAD_DIR))) return null;
    const roles = loadRoles(path.join(projectRoot, SQUAD_DIR, 'roles'), { fsImpl });
    const catalog = loadCatalog(path.join(projectRoot, SQUAD_DIR, 'skills.yaml'), roles, { fsImpl });
    const binding = readBinding(projectRoot, { fsImpl });
    const { bundles } = resolveBundles({ catalog, roles, reviewerBound: Boolean(binding?.roles.reviewer) });
    let runtime = null;
    const runtimeId = binding?.roles.worker[0]?.runtime;
    if (runtimeId) {
        try { runtime = registry.get(runtimeId); } catch { runtime = null; }
    }
    return { skillDirs: roleSkillDirs(registry), ownedPaths: [...roleSkillDirs(registry), '.git'], bundle: bundles.worker, runtime };
}

function gitInit(workerRoot, projectRoot) {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(workerRoot).replace(/\\/g, '/') };
    for (const name of Object.keys(env)) {
        if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].includes(name.toUpperCase())) delete env[name];
    }
    const result = spawnSync('git', ['init', '-q'], { cwd: workerRoot, env, shell: false, stdio: 'ignore', timeout: 30_000, windowsHide: true });
    if (result.status === 0) return true;
    // Without git the project cannot be a git repo either, so nothing above the
    // worker root can leak; inside a git repo a failed init must stop the task.
    if (fs.existsSync(path.join(projectRoot, '.git'))) {
        throw Object.assign(new Error('Cannot make the worker root its own git root (git init failed); project skills would leak into the worker'),
            { code: 'DUAL_TASK_WORKSPACE_ISOLATION' });
    }
    return false;
}

function isolateWorkerRoot({ projectRoot, workerRoot, plan, fsImpl = fs }) {
    const gitRoot = gitInit(workerRoot, projectRoot);
    const store = createSkillStore(projectRoot, { fsImpl });
    const args = { store, root: workerRoot, skills: plan.bundle, roleId: WORKER_ID, deterministic: true };
    const mount = plan.runtime && typeof plan.runtime.mountSkills === 'function'
        ? plan.runtime.mountSkills(args)
        : mountBundle({ ...args, skillDir: plan.skillDirs[0], fsImpl });
    return { gitRoot, mount };
}

module.exports = { WORKER_ID, roleSkillDirs, workerSkillPlan, isolateWorkerRoot };
