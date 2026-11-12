'use strict';

// First-run squad setup from `omni ui` (SPEC-SQUAD-P8 §5): list the CLIs on this
// machine, check a candidate binding without writing, and apply it through the
// same runSetup that `omni squad setup` uses. Setup decides no gate, writes no
// ledger event and starts no daemon session.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSetup, slotIds, SQUAD_DIR, TEMPLATE_DIR } = require('../squad/setup');
const { loadRoles } = require('../squad/roles');
const { PRESETS, parseBinding, checkBinding, readUserDefaults } = require('../squad/bindings');
const { projectTrust } = require('../squad/trust');
const { defaultRegistry } = require('../squad/runtimes');

const CACHE_MS = 60_000;
const NAME = /^[a-z][a-z0-9-]{1,31}$/;
const MODEL = /^[^:\s]{1,128}$/;
const EFFORT = /^[a-z]{1,16}$/;

function setupError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

// { preset, workers, binds: { orchestrator: {runtime, model, effort?}, 'worker-1': …, reviewer? } }
function normalize(body) {
    const preset = body?.preset;
    if (!PRESETS[preset]) throw setupError(400, 'UI_SETUP_INVALID', 'preset must be "squad" or "dual"');
    const [min, max] = PRESETS[preset].workers;
    const workers = body.workers === undefined ? min : body.workers;
    if (!Number.isInteger(workers) || workers < min || workers > max) {
        throw setupError(400, 'UI_SETUP_INVALID', `workers must be ${min}..${max} for ${preset}`);
    }
    const ids = slotIds(preset, workers);
    const binds = body.binds && typeof body.binds === 'object' && !Array.isArray(body.binds) ? body.binds : {};
    const extra = Object.keys(binds).filter((id) => !ids.includes(id));
    if (extra.length) throw setupError(400, 'UI_SETUP_INVALID', `unexpected roles: ${extra.join(', ')}`);
    const slots = {};
    for (const id of ids) {
        const slot = binds[id];
        if (!slot || !NAME.test(slot.runtime || '') || !MODEL.test(slot.model || '')
            || (slot.effort !== undefined && slot.effort !== null && slot.effort !== '' && !EFFORT.test(slot.effort))) {
            throw setupError(400, 'UI_SETUP_INVALID', `${id}: choose a CLI and a model`);
        }
        slots[id] = { runtime: slot.runtime, model: slot.model, ...(slot.effort ? { effort: slot.effort } : {}) };
    }
    return { preset, workers, ids, slots };
}

function candidateBinding({ preset, slots }, reports, now) {
    return parseBinding({
        schema_version: 1,
        preset,
        roles: {
            orchestrator: slots.orchestrator,
            worker: Object.keys(slots).filter((id) => id.startsWith('worker-')).map((id) => ({ id, ...slots[id] })),
            reviewer: slots.reviewer || null,
        },
        probed: Object.fromEntries(reports.filter((r) => r.version?.ok).map((r) => [r.id, r.version.version])),
        updated_at: now().toISOString(),
    });
}

function createSetupService({ root, registry = defaultRegistry, runSetupImpl = runSetup, trustImpl = projectTrust,
    homedir = os.homedir(), now = () => new Date(), clock = () => Date.now(), cacheMs = CACHE_MS, fsImpl = fs } = {}) {
    let cache = null;
    let applying = null;
    const applied = new Map();

    const configured = () => fsImpl.existsSync(path.join(root, SQUAD_DIR));

    async function reports(refresh = false) {
        if (!refresh && cache && clock() - cache.at < cacheMs) return cache.reports;
        const probed = await registry.probeAll({});
        cache = { at: clock(), reports: probed };
        return probed;
    }

    async function runtimes({ refresh = false } = {}) {
        const list = await reports(refresh);
        return { runtimes: list, defaults: readUserDefaults(homedir, { fsImpl }), presets: Object.fromEntries(
            Object.entries(PRESETS).map(([id, preset]) => [id, { workers: preset.workers, reviewer: Boolean(preset.reviewer) }])) };
    }

    async function preflight(body) {
        const candidate = normalize(body);
        const list = await reports(false);
        const roles = loadRoles(path.join(TEMPLATE_DIR, 'roles'), { fsImpl });
        let check;
        try {
            check = checkBinding(candidateBinding(candidate, list, now), { roles, registry, reports: list });
        } catch (error) {
            check = { errors: [{ code: error.code || 'SQUAD_BINDING_INVALID', message: error.message }], warnings: [] };
        }
        let trust = null;
        try { trust = trustImpl(candidate.slots.orchestrator.runtime, root, { homedir }); } catch { trust = null; }
        return { ok: check.errors.length === 0, errors: check.errors, warnings: check.warnings, trust };
    }

    async function apply(body) {
        const requestId = body?.request_id;
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) {
            throw setupError(400, 'UI_SETUP_INVALID', 'request_id is required');
        }
        if (applied.has(requestId)) return applied.get(requestId);
        if (applying) throw setupError(409, 'UI_SETUP_BUSY', 'setup is already running');
        if (configured()) throw setupError(409, 'UI_SETUP_DONE', 'this project already has .omni/squad — edit roles in the workspace');
        const candidate = normalize(body);
        const binds = candidate.ids.map((id) => {
            const slot = candidate.slots[id];
            return `${id}=${slot.runtime}:${slot.model}${slot.effort ? `:${slot.effort}` : ''}`;
        });
        applying = (async () => {
            const result = await runSetupImpl({ projectRoot: root, preset: candidate.preset, workers: candidate.workers, binds,
                yes: true, displace: body.displace !== false, registry, homedir, now, fsImpl });
            return { ok: true, preset: candidate.preset, created: result.created || [], warnings: result.warnings || [],
                orchestrator_config: result.orchestratorConfig || [], displaced: result.displaced?.moved || [] };
        })();
        try {
            const summary = await applying;
            applied.set(requestId, summary);
            return summary;
        } catch (error) {
            throw setupError(400, error.code || 'UI_SETUP_FAILED', error.message);
        } finally {
            applying = null;
        }
    }

    return { configured, runtimes, preflight, apply };
}

module.exports = { createSetupService, normalize };
