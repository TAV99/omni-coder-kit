'use strict';

// Role definitions (SPEC-SQUAD-P2 §4): one YAML file per role in
// .omni/squad/roles/, validated with zod. P2 ships three required roles.

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { CAPABILITY_KEYS } = require('./runtimes/contract');
const { SquadConfigError, parseYamlFile, schemaError } = require('./yaml');

const ROLE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const PHASE_ID = /^[a-z][a-z0-9-]{0,31}$/;

// Required roles and the shape P2 relies on (orchestrator in the project root,
// workers and the reviewer in isolated roots).
const REQUIRED_ROLES = Object.freeze({
    orchestrator: { cardinality: '1', root: 'project' },
    worker: { cardinality: '1..N', root: 'isolated' },
    reviewer: { cardinality: '0..1', root: 'isolated' },
});

const Capability = z.enum(CAPABILITY_KEYS);

const RoleSchema = z.object({
    schema_version: z.literal(1),
    id: z.string().regex(ROLE_ID),
    description: z.string().trim().min(1).max(500),
    cardinality: z.enum(['1', '0..1', '1..N']),
    phases: z.array(z.string().regex(PHASE_ID)).max(32),
    permission: z.enum(['interactive', 'read-only', 'full-auto-isolated']),
    requires: z.array(Capability).max(CAPABILITY_KEYS.length),
    optional: z.array(Capability).max(CAPABILITY_KEYS.length).default([]),
    root: z.enum(['project', 'isolated']),
    // SPEC-SQUAD-P5 §5: per-turn time and turns per task (worker: attempts; reviewer: reviews).
    budget: z.object({
        turn_minutes: z.number().int().min(1).max(240).optional(),
        max_turns: z.number().int().min(1).max(20).optional(),
    }).strict().optional(),
}).strict().superRefine((role, ctx) => {
    if (role.permission === 'full-auto-isolated' && role.root !== 'isolated') {
        ctx.addIssue({ code: 'custom', path: ['permission'], message: 'full-auto-isolated requires root: isolated' });
    }
    if (role.permission === 'interactive' && role.root !== 'project') {
        ctx.addIssue({ code: 'custom', path: ['permission'], message: 'interactive requires root: project' });
    }
    if (new Set(role.phases).size !== role.phases.length) {
        ctx.addIssue({ code: 'custom', path: ['phases'], message: 'phases must be unique' });
    }
});

function parseRole(value, source) {
    const parsed = RoleSchema.safeParse(value);
    if (!parsed.success) throw schemaError(source, parsed.error.issues);
    return Object.freeze({ ...parsed.data, source });
}

// Loads every `<id>.yaml` in rolesDir; returns { [id]: role }.
function loadRoles(rolesDir, { fsImpl = fs } = {}) {
    let names;
    try {
        names = fsImpl.readdirSync(rolesDir).filter((name) => name.endsWith('.yaml')).sort();
    } catch (error) {
        throw new SquadConfigError(`${rolesDir}: cannot read roles directory (${error.code || error.message})`, { source: rolesDir });
    }
    const roles = {};
    for (const name of names) {
        const source = path.join(rolesDir, name);
        const role = parseRole(parseYamlFile(source, { fsImpl }), source);
        if (`${role.id}.yaml` !== name) {
            throw new SquadConfigError(`${source}: id "${role.id}" must match the file name`, { source });
        }
        roles[role.id] = role;
    }
    for (const [id, shape] of Object.entries(REQUIRED_ROLES)) {
        const role = roles[id];
        if (!role) throw new SquadConfigError(`${rolesDir}: missing required role "${id}"`, { source: rolesDir });
        if (role.cardinality !== shape.cardinality || role.root !== shape.root) {
            throw new SquadConfigError(`${role.source}: role "${id}" must have cardinality "${shape.cardinality}" and root "${shape.root}"`,
                { source: role.source });
        }
    }
    return roles;
}

module.exports = { REQUIRED_ROLES, RoleSchema, parseRole, loadRoles };
