'use strict';

// Skill catalog (SPEC-SQUAD-P2 §5): which skills each role and phase gets.
// A phase's skills follow whichever role holds that phase, so QC skills move
// from the orchestrator to the reviewer when a reviewer is bound.

const { z } = require('zod');
const { SquadConfigError, parseYamlFile, schemaError } = require('./yaml');
const { phaseOwnersFromPipeline } = require('./pipeline');

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[a-z][a-z0-9-]{0,31}$/;
const Skill = z.string().regex(SKILL_NAME);
const SkillList = z.array(Skill).max(200);

const CatalogSchema = z.object({
    schema_version: z.literal(1),
    shared_core: SkillList.default([]),
    roles: z.record(z.string().regex(KEY), SkillList),
    phases: z.record(z.string().regex(KEY), SkillList).default({}),
    stack: z.record(z.string().regex(KEY), SkillList).default({}),
    exclude: SkillList.default([]),
}).strict();

function parseCatalog(value, source, roles) {
    const parsed = CatalogSchema.safeParse(value);
    if (!parsed.success) throw schemaError(source, parsed.error.issues);
    const catalog = parsed.data;
    for (const section of ['roles', 'stack']) {
        for (const id of Object.keys(catalog[section])) {
            if (roles && !roles[id]) throw new SquadConfigError(`${source}: ${section}.${id} is not a defined role`, { source });
        }
    }
    const excluded = new Set(catalog.exclude);
    const listed = [
        ['shared_core', catalog.shared_core],
        ...Object.entries(catalog.roles).map(([id, list]) => [`roles.${id}`, list]),
        ...Object.entries(catalog.phases).map(([id, list]) => [`phases.${id}`, list]),
        ...Object.entries(catalog.stack).map(([id, list]) => [`stack.${id}`, list]),
    ];
    for (const [where, list] of listed) {
        const clash = list.find((skill) => excluded.has(skill));
        if (clash) throw new SquadConfigError(`${source}: "${clash}" is in both exclude and ${where}`, { source });
    }
    return Object.freeze({ ...catalog, source });
}

function loadCatalog(filePath, roles, options = {}) {
    return parseCatalog(parseYamlFile(filePath, options), filePath, roles);
}

// Who holds each phase. P2 rule (P3 replaces it with pipeline.yaml): a role's
// own phases, plus `qc` → reviewer when one is bound, otherwise orchestrator.
function phaseOwners(roles, { reviewerBound = false } = {}) {
    const owners = {};
    for (const role of Object.values(roles)) {
        if (role.id === 'reviewer' && !reviewerBound) continue;
        for (const phase of role.phases) owners[phase] = role.id;
    }
    owners.qc = reviewerBound ? 'reviewer' : 'orchestrator';
    return owners;
}

// bundles: { [roleId]: sorted skill names }, overlaps: skills held by ≥2 roles outside shared_core.
// With a pipeline (SPEC-SQUAD-P3 §2), phase ownership and the active roles come from it.
function resolveBundles({ catalog, roles, reviewerBound = false, pipeline = null }) {
    const owners = pipeline ? phaseOwnersFromPipeline(pipeline) : phaseOwners(roles, { reviewerBound });
    const active = pipeline
        ? Object.keys(roles).filter((id) => ['orchestrator', 'worker'].includes(id) || Object.values(owners).includes(id))
        : Object.keys(roles).filter((id) => id !== 'reviewer' || reviewerBound);
    const excluded = new Set(catalog.exclude);
    const bundles = {};
    for (const id of active) {
        const skills = new Set([
            ...catalog.shared_core,
            ...(catalog.roles[id] || []),
            ...(catalog.stack[id] || []),
            ...Object.entries(catalog.phases).filter(([phase]) => owners[phase] === id).flatMap(([, list]) => list),
        ]);
        bundles[id] = [...skills].filter((skill) => !excluded.has(skill)).sort();
    }
    const shared = new Set(catalog.shared_core);
    const holders = new Map();
    for (const [id, list] of Object.entries(bundles)) {
        for (const skill of list) holders.set(skill, [...(holders.get(skill) || []), id]);
    }
    const overlaps = [...holders].filter(([skill, ids]) => ids.length > 1 && !shared.has(skill))
        .map(([skill, ids]) => ({ skill, roles: ids }));
    return { bundles, owners, overlaps };
}

module.exports = { CatalogSchema, SKILL_NAME, parseCatalog, loadCatalog, phaseOwners, resolveBundles };
