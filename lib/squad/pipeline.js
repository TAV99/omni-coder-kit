'use strict';

// Declarative pipeline (SPEC-SQUAD-P3 §2): phase → role → gate. When a
// project has .omni/squad/pipeline.yaml it is the only source of phase
// ownership. P3 does not rewrite the dual engine: assertEngineSupports()
// accepts only pipelines the current engine can run.

const { z } = require('zod');
const { SquadConfigError, parseYamlFile, schemaError } = require('./yaml');

const PHASE_ID = /^[a-z][a-z0-9-]{0,31}$/;

const PhaseSchema = z.object({
    id: z.string().regex(PHASE_ID),
    role: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    gate: z.enum(['human', 'human-always']).optional(),
    auto_ok: z.boolean().optional(),
    on_needs_fix: z.string().regex(PHASE_ID).optional(),
    max_corrections: z.number().int().min(0).max(10).optional(),
}).strict().superRefine((phase, ctx) => {
    if (phase.auto_ok !== undefined && phase.gate !== 'human') {
        ctx.addIssue({ code: 'custom', path: ['auto_ok'], message: 'auto_ok only applies to gate: human' });
    }
    if (phase.max_corrections !== undefined && phase.on_needs_fix === undefined) {
        ctx.addIssue({ code: 'custom', path: ['max_corrections'], message: 'max_corrections needs on_needs_fix' });
    }
});

const PipelineSchema = z.object({
    schema_version: z.literal(1),
    preset: z.enum(['dual', 'squad']),
    phases: z.array(PhaseSchema).min(1).max(32),
}).strict().superRefine((pipeline, ctx) => {
    const seen = new Map();
    pipeline.phases.forEach((phase, index) => {
        if (seen.has(phase.id)) ctx.addIssue({ code: 'custom', path: ['phases', index, 'id'], message: `duplicate phase "${phase.id}"` });
        if (phase.on_needs_fix !== undefined && !seen.has(phase.on_needs_fix)) {
            ctx.addIssue({ code: 'custom', path: ['phases', index, 'on_needs_fix'], message: `"${phase.on_needs_fix}" must be an earlier phase` });
        }
        seen.set(phase.id, index);
    });
});

function parsePipeline(value, source, roles) {
    const parsed = PipelineSchema.safeParse(value);
    if (!parsed.success) throw schemaError(source, parsed.error.issues);
    for (const phase of parsed.data.phases) {
        if (roles && !roles[phase.role]) {
            throw new SquadConfigError(`${source}: phase "${phase.id}" uses undefined role "${phase.role}"`, { source });
        }
    }
    return Object.freeze({ ...parsed.data, source });
}

function loadPipeline(filePath, roles, options = {}) {
    return parsePipeline(parseYamlFile(filePath, options), filePath, roles);
}

// .omni/squad/pipeline.yaml if the project has one, else null (P2 rules apply).
function readPipelineIfAny(projectRoot, roles, { fsImpl = require('node:fs') } = {}) {
    const file = require('node:path').join(projectRoot, '.omni', 'squad', 'pipeline.yaml');
    return fsImpl.existsSync(file) ? loadPipeline(file, roles, { fsImpl }) : null;
}

function phaseOwnersFromPipeline(pipeline) {
    return Object.fromEntries(pipeline.phases.map((phase) => [phase.id, phase.role]));
}

// What the 3.1.x dual engine can run (SPEC-SQUAD-P3 §2.3). P5 opens qc → reviewer.
const ENGINE_PHASES = Object.freeze([
    ['spec', 'orchestrator'], ['plan', 'orchestrator'],
    ['scout', 'worker'], ['implement', 'worker'], ['review', 'worker'],
    ['qc', 'orchestrator'], ['integrate', 'orchestrator'],
]);

// Returns { supported, problems: string[] } — never throws for an unsupported shape.
function assertEngineSupports(pipeline) {
    const problems = [];
    const ids = pipeline.phases.map((p) => p.id);
    const expected = ENGINE_PHASES.map(([id]) => id);
    if (ids.join(',') !== expected.join(',')) problems.push(`thứ tự phase phải là ${expected.join(' → ')} (đang là ${ids.join(' → ')})`);
    const byId = Object.fromEntries(pipeline.phases.map((p) => [p.id, p]));
    for (const [id, role] of ENGINE_PHASES) {
        // SPEC-SQUAD-P5 §2: an independent reviewer may hold the qc phase.
        if (byId[id] && byId[id].role !== role && !(id === 'qc' && byId[id].role === 'reviewer')) {
            problems.push(`phase ${id} phải thuộc vai ${role} (đang là ${byId[id].role})`);
        }
    }
    if (byId.integrate && byId.integrate.gate !== 'human-always') problems.push('integrate phải có gate: human-always (D8)');
    const fix = byId.qc?.on_needs_fix;
    if (fix !== undefined && fix !== 'implement') problems.push('qc phải có on_needs_fix: implement');
    return { supported: problems.length === 0, problems };
}

module.exports = {
    PipelineSchema, ENGINE_PHASES, parsePipeline, loadPipeline, readPipelineIfAny, phaseOwnersFromPipeline, assertEngineSupports,
};
