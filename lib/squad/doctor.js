'use strict';

// Squad checks for `omni skills:doctor` (SPEC-SQUAD-P2 §9). Pure: returns
// findings, the command layer prints them and sets the exit code.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultRegistry } = require('./runtimes');
const { probeContext } = require('./runtimes/contract');
const { loadRoles } = require('./roles');
const { loadCatalog, resolveBundles } = require('./skills-catalog');
const { createSkillStore, isSkillDir } = require('./skill-store');
const { inspectMount } = require('./mount');
const { readBinding, slotsOf } = require('./bindings');
const { readPipelineIfAny, assertEngineSupports } = require('./pipeline');

const SQUAD_DIR = path.join('.omni', 'squad');

function runSquadChecks({ projectRoot, registry = defaultRegistry, homedir = os.homedir(), env = process.env, fsImpl = fs }) {
    if (!fsImpl.existsSync(path.join(projectRoot, SQUAD_DIR))) return null;
    const findings = [];
    const error = (code, message) => findings.push({ level: 'error', code, message });
    const warn = (code, message) => findings.push({ level: 'warn', code, message });

    let roles;
    let catalog;
    let pipeline;
    try {
        roles = loadRoles(path.join(projectRoot, SQUAD_DIR, 'roles'), { fsImpl });
        catalog = loadCatalog(path.join(projectRoot, SQUAD_DIR, 'skills.yaml'), roles, { fsImpl });
        pipeline = readPipelineIfAny(projectRoot, roles, { fsImpl });
    } catch (e) {
        error(e.code || 'SQUAD_CONFIG_INVALID', e.message);
        return findings;
    }
    let binding = null;
    try {
        binding = readBinding(projectRoot, { fsImpl });
    } catch (e) {
        error('SQUAD_BINDING_INVALID', e.message);
    }
    if (!binding) warn('SQUAD_BINDING_MISSING', 'chưa gắn CLI/model cho các vai — chạy "omni squad setup"');

    if (pipeline) {
        const engine = assertEngineSupports(pipeline);
        if (!engine.supported) warn('SQUAD_PIPELINE_ENGINE_UNSUPPORTED', `pipeline ${pipeline.preset} chưa chạy được bằng engine hiện tại: ${engine.problems.join('; ')}`);
        if (binding) {
            const used = new Set(pipeline.phases.map((p) => p.role));
            if (used.has('reviewer') && !binding.roles.reviewer) error('SQUAD_PIPELINE_BINDING_MISMATCH', 'pipeline giao phase cho reviewer nhưng chưa gắn CLI/model cho reviewer — chạy "omni squad setup --preset squad"');
            if (binding.roles.reviewer && !used.has('reviewer')) warn('SQUAD_PIPELINE_BINDING_MISMATCH', 'đã gắn reviewer nhưng pipeline không giao phase nào cho reviewer');
        }
    } else {
        warn('SQUAD_PIPELINE_MISSING', 'chưa có .omni/squad/pipeline.yaml — chạy "omni squad setup" để thêm (dùng --keep-skills nếu không muốn chuyển skill)');
    }
    const { bundles, overlaps } = resolveBundles({ catalog, roles, reviewerBound: Boolean(binding?.roles.reviewer), pipeline });
    for (const { skill, roles: ids } of overlaps) error('SQUAD_SKILL_OVERLAP', `"${skill}" thuộc nhiều vai: ${ids.join(', ')} (thêm vào shared_core nếu cố ý)`);

    const store = createSkillStore(projectRoot, { fsImpl });
    const missing = [...new Set(Object.values(bundles).flat())].filter((name) => !store.has(name)).sort();
    if (missing.length) error('SQUAD_SKILL_MISSING', `thiếu trong ${path.join('.omni', 'skills')}: ${missing.join(', ')}`);

    if (binding) {
        let orchestrator = null;
        try { orchestrator = registry.get(binding.roles.orchestrator.runtime); } catch { error('SQUAD_BINDING_INVALID', `unknown runtime "${binding.roles.orchestrator.runtime}"`); }
        if (orchestrator && typeof orchestrator.skillDirs === 'function') {
            const skillDir = orchestrator.skillDirs('project')[0];
            const report = inspectMount({ store, root: projectRoot, skillDir, skills: bundles.orchestrator, roleId: 'orchestrator', fsImpl });
            if (report.drift.length || report.absent.length || report.extra.length || report.adoptable.length) {
                warn('SQUAD_SKILL_DRIFT', `${skillDir} lệch so với bộ skill của orchestrator (${[...report.drift, ...report.absent, ...report.extra, ...report.adoptable].join(', ')}) — chạy "omni squad skills sync"`);
            }
            if (report.unmanaged.length) {
                warn('SQUAD_SKILL_UNMANAGED', `${skillDir} có skill omni không quản lý, orchestrator sẽ thấy chúng: ${report.unmanaged.join(', ')}`);
            }
        }
        // Per-user skill dirs leak into every role that uses the same CLI (F6).
        const ctx = probeContext({ homedir, env });
        for (const runtimeId of [...new Set(slotsOf(binding).map((s) => s.slot.runtime))]) {
            let runtime;
            try { runtime = registry.get(runtimeId); } catch { continue; }
            for (const file of typeof runtime.userInstructionFiles === 'function' ? runtime.userInstructionFiles(ctx) : []) {
                if (fsImpl.existsSync(file)) warn('SQUAD_USER_INSTRUCTIONS_GLOBAL', `${file} — mọi vai dùng ${runtimeId} đều đọc file này, omni không cô lập được`);
            }
            if (typeof runtime.userSkillDirs !== 'function') continue;
            for (const dir of runtime.userSkillDirs(ctx)) {
                const count = fsImpl.existsSync(dir) ? fsImpl.readdirSync(dir).filter((n) => isSkillDir(path.join(dir, n), fsImpl)).length : 0;
                if (count) warn('SQUAD_USER_SKILLS_GLOBAL', `${dir} có ${count} skill — mọi vai dùng ${runtimeId} đều thấy chúng, omni không cô lập được`);
            }
        }
    }
    return findings;
}

module.exports = { runSquadChecks };
