'use strict';

// Per-person bindings role → runtime → model → effort (SPEC-SQUAD-P2 §8.1, D2, D9).
// Project file: .omni/squad.local.json (ignored). User file: ~/.omni/squad.json
// only remembers the last choice per preset to pre-fill the next setup.

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { modelFamily } = require('./runtimes/families');

const LOCAL_FILE = path.join('.omni', 'squad.local.json');
const USER_FILE = path.join('.omni', 'squad.json');
const PRESETS = Object.freeze({
    dual: { workers: [1, 1], reviewer: false },
    squad: { workers: [1, 8], reviewer: true },
});

const Slot = z.object({
    runtime: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    model: z.string().trim().min(1).max(128),
    effort: z.string().regex(/^[a-z]+$/).optional(),
}).strict();
const WorkerSlot = Slot.extend({ id: z.string().regex(/^worker-[1-9][0-9]?$/) }).strict();

const BindingSchema = z.object({
    schema_version: z.literal(1),
    preset: z.enum(Object.keys(PRESETS)),
    roles: z.object({
        orchestrator: Slot,
        worker: z.array(WorkerSlot).min(1).max(8),
        reviewer: Slot.nullable(),
    }).strict(),
    probed: z.record(z.string(), z.string()).default({}),
    // D8: AUTO skips only gates marked auto_ok; set by `omni squad auto` on a TTY.
    auto: z.boolean().optional(),
    updated_at: z.string(),
}).strict().superRefine((binding, ctx) => {
    const preset = PRESETS[binding.preset];
    const count = binding.roles.worker.length;
    if (count < preset.workers[0] || count > preset.workers[1]) {
        ctx.addIssue({ code: 'custom', path: ['roles', 'worker'], message: `preset ${binding.preset} needs ${preset.workers.join('..')} workers` });
    }
    if (!preset.reviewer && binding.roles.reviewer) {
        ctx.addIssue({ code: 'custom', path: ['roles', 'reviewer'], message: `preset ${binding.preset} has no reviewer` });
    }
    const ids = binding.roles.worker.map((w) => w.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['roles', 'worker'], message: 'worker ids must be unique' });
});

class SquadBindingError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SquadBindingError';
        this.code = 'SQUAD_BINDING_INVALID';
        this.details = details;
    }
}

function parseBinding(value, source = LOCAL_FILE) {
    const parsed = BindingSchema.safeParse(value);
    if (!parsed.success) {
        throw new SquadBindingError(`${source}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    }
    return parsed.data;
}

function readJson(file, fsImpl) {
    if (!fsImpl.existsSync(file)) return null;
    try {
        return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new SquadBindingError(`${file}: not valid JSON (${error.message})`);
    }
}

function writeJson(file, value, fsImpl) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fsImpl.renameSync(temp, file);
}

function readBinding(projectRoot, { fsImpl = fs } = {}) {
    const file = path.join(projectRoot, LOCAL_FILE);
    const value = readJson(file, fsImpl);
    return value === null ? null : parseBinding(value, file);
}

function writeBinding(projectRoot, binding, { fsImpl = fs } = {}) {
    writeJson(path.join(projectRoot, LOCAL_FILE), parseBinding(binding), fsImpl);
}

function readUserDefaults(homedir, { fsImpl = fs } = {}) {
    try {
        const value = readJson(path.join(homedir, USER_FILE), fsImpl);
        return value && value.schema_version === 1 && value.last && typeof value.last === 'object' ? value.last : {};
    } catch {
        return {};
    }
}

function writeUserDefaults(homedir, binding, { fsImpl = fs } = {}) {
    const last = { ...readUserDefaults(homedir, { fsImpl }), [binding.preset]: binding.roles };
    writeJson(path.join(homedir, USER_FILE), { schema_version: 1, last }, fsImpl);
}

// Slots in setup order: orchestrator, worker-1..N, reviewer.
function slotsOf(binding) {
    const slots = [{ role: 'orchestrator', id: 'orchestrator', slot: binding.roles.orchestrator }];
    for (const worker of binding.roles.worker) slots.push({ role: 'worker', id: worker.id, slot: worker });
    if (binding.roles.reviewer) slots.push({ role: 'reviewer', id: 'reviewer', slot: binding.roles.reviewer });
    return slots;
}

// Checks a binding against role requirements and live probe reports.
// Returns { errors: [{ code, message }], warnings: [{ code, message }] }.
function checkBinding(binding, { roles, registry, reports = [] }) {
    const errors = [];
    const warnings = [];
    const reportOf = Object.fromEntries(reports.map((r) => [r.id, r]));
    for (const { role, id, slot } of slotsOf(binding)) {
        let runtime;
        try {
            runtime = registry.get(slot.runtime);
        } catch {
            errors.push({ code: 'SQUAD_BINDING_INVALID', message: `${id}: unknown runtime "${slot.runtime}"` });
            continue;
        }
        const missing = (roles[role]?.requires || []).filter((key) => !runtime.capabilities[key]);
        if (missing.length) errors.push({ code: 'SQUAD_BINDING_INVALID', message: `${id}: ${slot.runtime} lacks ${missing.join(', ')}` });
        const report = reportOf[slot.runtime];
        if (report && !report.ready) warnings.push({ code: 'SQUAD_RUNTIME_NOT_READY', message: `${id}: ${slot.runtime} is not ready on this machine` });
        const models = report?.models?.ok ? report.models.models : [];
        const model = models.find((m) => m.id === slot.model);
        if (models.length && !model) errors.push({ code: 'SQUAD_BINDING_INVALID', message: `${id}: model "${slot.model}" is not offered by ${slot.runtime}` });
        if (model && slot.effort !== undefined && !(model.efforts || []).includes(slot.effort)) {
            errors.push({ code: 'SQUAD_BINDING_INVALID',
                message: `${id}: effort "${slot.effort}" is not valid for ${slot.model}${model.efforts ? ` (${model.efforts.join(', ')})` : ' (no effort setting)'}` });
        }
    }
    warnings.push(...sharingWarnings(binding));
    return { errors, warnings };
}

// D18: shared accounts/quota and model-family independence.
function sharingWarnings(binding) {
    const warnings = [];
    const slots = slotsOf(binding);
    const byRuntime = new Map();
    for (const { id, slot } of slots) byRuntime.set(slot.runtime, [...(byRuntime.get(slot.runtime) || []), id]);
    for (const [runtime, ids] of byRuntime) {
        if (ids.length > 1) warnings.push({ code: 'SQUAD_SHARED_ACCOUNT', message: `${ids.join(', ')} share ${runtime}: one account and one quota` });
    }
    const family = (slot) => modelFamily(slot.model);
    const { orchestrator, worker, reviewer } = binding.roles;
    if (reviewer) {
        if (worker.some((w) => family(w) === family(reviewer) && family(reviewer) !== 'unknown')) {
            warnings.push({ code: 'SQUAD_QC_SAME_FAMILY_AS_WORKER', message: `reviewer and a worker both use ${family(reviewer)} models: QC is not independent` });
        }
        if (family(orchestrator) === family(reviewer) && family(reviewer) !== 'unknown') {
            warnings.push({ code: 'SQUAD_QC_SAME_FAMILY_AS_ORCHESTRATOR', message: `orchestrator and reviewer both use ${family(reviewer)} models` });
        }
    }
    return warnings;
}

// The 3.1.2 dual engine runs only orchestrator=codex + one agy worker that takes
// an explicit effort (SPEC-SQUAD-P2 §8.2 step 5). P3 lifts this.
const WORKER_RUNTIMES = Object.freeze(['agy', 'codex', 'claude']);

function engineSupport(binding) {
    const reasons = [];
    const [first, ...rest] = binding.roles.worker;
    if (binding.roles.orchestrator.runtime !== 'codex') reasons.push('orchestrator must be codex');
    // The dual engine drives agy, codex (SPEC-SQUAD-P3 §4.4) or claude (SPEC-SQUAD-P4 §4) as worker.
    if (!WORKER_RUNTIMES.includes(first.runtime)) reasons.push('worker must be agy, codex or claude');
    if (rest.length) reasons.push('only one worker');
    if (binding.roles.reviewer) reasons.push('no reviewer role yet');
    return { supported: reasons.length === 0, reasons };
}

// Legacy dual reads manifest.workerModel/workerEffort; keep them in step. A model
// that takes no effort (agy Claude) clears a stale workerEffort: undefined drops
// the key when the manifest is written back as JSON.
function legacyManifestFields(binding, reports = []) {
    const worker = binding.roles.worker[0];
    if (!WORKER_RUNTIMES.includes(worker.runtime)) return null;
    const model = reports.find((r) => r.id === worker.runtime)?.models?.models?.find((m) => m.id === worker.model);
    return { workerRuntime: worker.runtime, workerModel: worker.model,
        workerEffort: worker.effort || model?.defaultEffort || undefined };
}

module.exports = {
    LOCAL_FILE, USER_FILE, PRESETS, BindingSchema, SquadBindingError,
    parseBinding, readBinding, writeBinding, readUserDefaults, writeUserDefaults,
    slotsOf, checkBinding, sharingWarnings, engineSupport, legacyManifestFields,
};
