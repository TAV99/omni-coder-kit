'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../../templates/spec-coverage/catalog.v1.json');

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex'); }
function failure(code, message) { const error = new Error(message); error.code = code; throw error; }
function expandCatalog(appTypes = [], version = 1) {
    if (version !== catalog.catalog_version) failure('UNKNOWN_CATALOG_VERSION', `Unsupported catalog version ${version}`);
    if (!Array.isArray(appTypes) || new Set(appTypes).size !== appTypes.length) failure('UNKNOWN_APP_TYPE', 'app_types must be a unique array');
    const result = [...catalog.core];
    for (const type of appTypes) {
        if (type === 'core') continue;
        if (!Object.hasOwn(catalog.extensions, type)) failure('UNKNOWN_APP_TYPE', `Unsupported app type ${type}`);
        result.push(...catalog.extensions[type]);
    }
    if (!appTypes.length) result.push({ id: 'classification.app_types', value_schema: { type: 'array', minItems: 1, items: { enum: ['core', 'booking'] } } });
    return structuredClone(result);
}

const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'pattern', 'description', 'title']);
function validateValueSchema(schema, at = 'value_schema', depth = 0) {
    if (depth > 64) return [`${at}: schema nesting exceeds limit`];
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: schema must be an object`];
    const errors = [];
    const nested = (child, location) => errors.push(...validateValueSchema(child, location, depth + 1));
    for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) errors.push(`${at}: unsupported schema keyword ${key}`);
    if (schema.type !== undefined && !['object','array','string','number','integer','boolean','null'].includes(schema.type)) errors.push(`${at}: invalid type`);
    for (const key of ['minItems','maxItems','minLength','maxLength']) if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) errors.push(`${at}.${key}: expected nonnegative integer`);
    for (const key of ['minimum','maximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) errors.push(`${at}.${key}: expected finite number`);
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') errors.push(`${at}.uniqueItems: expected boolean`);
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) errors.push(`${at}.enum: expected nonempty array`);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(nonempty) || new Set(schema.required).size !== schema.required.length)) errors.push(`${at}.required: expected unique string array`);
    if (schema.properties !== undefined) {
        if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) errors.push(`${at}.properties: expected object`);
        else for (const [key, child] of Object.entries(schema.properties)) nested(child, `${at}.properties.${key}`);
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') nested(schema.additionalProperties, `${at}.additionalProperties`);
    if (schema.items !== undefined) nested(schema.items, `${at}.items`);
    for (const key of ['oneOf','anyOf','allOf']) if (schema[key] !== undefined) {
        if (!Array.isArray(schema[key]) || !schema[key].length) errors.push(`${at}.${key}: expected nonempty schema array`);
        else schema[key].forEach((child, i) => nested(child, `${at}.${key}[${i}]`));
    }
    if (schema.pattern !== undefined) {
        if (typeof schema.pattern !== 'string') errors.push(`${at}.pattern: expected string`);
        else try { new RegExp(schema.pattern); } catch { errors.push(`${at}.pattern: invalid regular expression`); }
    }
    for (const key of ['description','title']) if (schema[key] !== undefined && typeof schema[key] !== 'string') errors.push(`${at}.${key}: expected string`);
    return errors;
}

// Deliberately bounded JSON Schema dialect; unknown keywords fail closed.
function validateValue(value, schema, at = 'value') {
    const errors = validateValueSchema(schema, `${at}.schema`);
    if (errors.length) return errors;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: invalid schema`];
    const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'pattern', 'description', 'title']);
    for (const key of Object.keys(schema)) if (!supported.has(key)) errors.push(`${at}: unsupported schema keyword ${key}`);
    if (schema.oneOf && schema.oneOf.filter(s => !validateValue(value, s, at).length).length !== 1) errors.push(`${at}: must match exactly one schema`);
    if (schema.anyOf && !schema.anyOf.some(s => !validateValue(value, s, at).length)) errors.push(`${at}: must match an allowed schema`);
    if (schema.allOf) for (const item of schema.allOf) errors.push(...validateValue(value, item, at));
    if (Object.hasOwn(schema, 'const') && canonical(value) !== canonical(schema.const)) errors.push(`${at}: constant mismatch`);
    if (schema.enum && !schema.enum.some(v => canonical(v) === canonical(value))) errors.push(`${at}: not in enum`);
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (schema.type && !(schema.type === 'integer' ? Number.isInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === schema.type)) errors.push(`${at}: expected ${schema.type}`);
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
        if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) errors.push(`${at}: duplicate items`);
        if (schema.items) value.forEach((item, i) => errors.push(...validateValue(item, schema.items, `${at}[${i}]`)));
    } else if (value && typeof value === 'object') {
        for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
        for (const [key, item] of Object.entries(value)) {
            if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validateValue(item, schema.properties[key], `${at}.${key}`));
            else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown property`);
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateValue(item, schema.additionalProperties, `${at}.${key}`));
        }
    }
    return errors;
}
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function validateArtifact(artifact) {
    const errors = [], pending_ids = [];
    let definitions = [];
    if (!artifact || typeof artifact !== 'object') return { valid: false, errors: ['Missing artifact'], pending_ids, dimensions: [] };
    const envelope = require('./contracts').SpecCoverageSchema.safeParse(artifact);
    if (!envelope.success) errors.push(...envelope.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
    if (artifact.catalog_version !== 1) errors.push('Unknown or missing catalog_version');
    if (!Array.isArray(artifact.app_types)) errors.push('app_types must be an array');
    if (artifact.schema_version !== 1 || !Number.isInteger(artifact.revision) || artifact.revision < 1) errors.push('Invalid artifact schema_version/revision');
    try { definitions = expandCatalog(artifact.app_types, artifact.catalog_version); } catch (error) { errors.push(error.message); }
    if (!Array.isArray(artifact.classification_sources) || !artifact.classification_sources.length || !artifact.classification_sources.every(nonempty)) errors.push('classification_sources required');
    const defs = new Map(definitions.map(d => [d.id, d]));
    const rows = new Map();
    if (!Array.isArray(artifact.dimensions)) errors.push('dimensions must be an array');
    for (const row of Array.isArray(artifact.dimensions) ? artifact.dimensions : []) {
        if (!row || !nonempty(row.id)) { errors.push('Invalid dimension ID'); continue; }
        if (rows.has(row.id)) errors.push(`Duplicate ID ${row.id}`);
        rows.set(row.id, row);
        if (!defs.has(row.id)) {
            if (!row.value_schema || !nonempty(row.label) || !nonempty(row.reason)) errors.push(`Unknown ID ${row.id}: custom dimension needs label, reason and value_schema`);
            else defs.set(row.id, { id: row.id, value_schema: row.value_schema });
        }
        const schema = defs.get(row.id)?.value_schema;
        if (schema) errors.push(...validateValueSchema(schema, `${row.id}.value_schema`));
        for (const constraint of Array.isArray(row.constraints) ? row.constraints : []) if (constraint && typeof constraint === 'object') errors.push(...validateValueSchema(constraint, `${row.id}.constraint`));
        if (!['unresolved', 'pinned', 'delegated', 'not_applicable'].includes(row.state)) errors.push(`${row.id}: invalid state`);
        if (row.state === 'unresolved') { pending_ids.push(row.id); if (Object.hasOwn(row, 'value')) errors.push(`${row.id}: unresolved cannot contain approved value`); continue; }
        const sources = row.sources;
        if (!Array.isArray(sources) || !sources.length) errors.push(`${row.id}: sources required`);
        for (const source of Array.isArray(sources) ? sources : []) {
            if (!source || !['user', 'approval', 'repository'].includes(source.kind) || !nonempty(source.ref)) errors.push(`${row.id}: unauthorized source`);
            if (source?.kind === 'repository' && (!nonempty(source.path) || !nonempty(source.section) || !/^[a-f0-9]{64}$/.test(source.digest || ''))) errors.push(`${row.id}: repository source requires path, section and digest`);
            if (source?.conflict === true) errors.push(`${row.id}: unresolved source conflict`);
            if (row.state === 'delegated' && !['user', 'approval'].includes(source?.kind)) errors.push(`${row.id}: delegation requires explicit user authorization`);
        }
        if (row.conflicts?.length || row.source_conflict) errors.push(`${row.id}: unresolved source conflict`);
        if (row.state !== 'pinned' && Object.hasOwn(row, 'value')) errors.push(`${row.id}: value is only permitted for pinned decisions`);
        if (row.state !== 'delegated' && Object.hasOwn(row, 'constraints')) errors.push(`${row.id}: constraints are only permitted for delegated decisions`);
        if (row.state !== 'unresolved' && Object.hasOwn(row, 'proposal')) errors.push(`${row.id}: proposal is only permitted for unresolved decisions`);
        if (row.state === 'pinned') {
            if (!Object.hasOwn(row, 'value')) errors.push(`${row.id}: pinned value required`);
            else if (schema) errors.push(...validateValue(row.value, schema, row.id));
        } else if (row.state === 'delegated') {
            if (!Array.isArray(row.constraints)) errors.push(`${row.id}: constraints required`);
            else for (const c of row.constraints) if (!(nonempty(c) || c && typeof c === 'object' && !Array.isArray(c))) errors.push(`${row.id}: invalid constraint`);
            if (Object.hasOwn(row, 'value')) errors.push(`${row.id}: delegated cannot contain pinned value`);
        } else if (row.state === 'not_applicable' && !nonempty(row.reason)) errors.push(`${row.id}: exclusion reason required`);
    }
    for (const def of definitions) if (!rows.has(def.id)) errors.push(`Missing required ID ${def.id}`);
    for (const def of definitions) {
        const row = rows.get(def.id);
        if (!row || row.state !== 'pinned') continue;
        for (const id of def.dependencies || []) {
            const dependency = rows.get(id);
            if (!dependency || ['unresolved', 'not_applicable'].includes(dependency.state)) errors.push(`${def.id}: unresolved dependency ${id}`);
        }
        if (def.shared_with) {
            const other = rows.get(def.shared_with);
            if (other?.state === 'pinned' && canonical(row.value) !== canonical(other.value)) errors.push(`${def.id}: shared-decision conflict with ${def.shared_with}`);
        }
    }
    for (const row of rows.values()) {
        if (!row.shared_decision) continue;
        const other = rows.get(row.shared_decision);
        if (!other || other.state === 'unresolved') errors.push(`${row.id}: unresolved shared decision ${row.shared_decision}`);
        else if (row.state === 'pinned' && other.state === 'pinned' && canonical(row.value) !== canonical(other.value)) errors.push(`${row.id}: shared-decision conflict with ${row.shared_decision}`);
    }
    const hours = rows.get('booking.hours'), slots = rows.get('booking.slots');
    if (hours?.state === 'pinned' && slots?.state === 'pinned') {
        const windows = hours.value?.windows || [];
        const minutes = text => /^\d{2}:\d{2}$/.test(text) ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : NaN;
        for (const window of windows) {
            const [start, end] = String(window).split('-').map(minutes);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > 1440 || slots.value.duration_minutes > end - start) errors.push('booking.slots: incompatible operating window');
        }
    }
    return { valid: errors.length === 0, errors, pending_ids, dimensions: [...defs.values()] };
}

function evaluateGate({ plan, artifact, receipt, baseline, session_id, workspace, reconnaissance_complete = true, reconnaissance_digest, binding_digest } = {}) {
    if (plan?.schema_version === 1) return { state: 'LEGACY_UNCHECKED', allowed: true, warning: 'LEGACY_UNCHECKED: v1 plan has no decision coverage guarantee', pending_ids: [] };
    const report = validateArtifact(artifact);
    const result = (state, extras = {}) => ({ state, allowed: state === 'PASSED', code: state === 'PASSED' ? null : 'SPEC_COVERAGE_REQUIRED', pending_ids: report.pending_ids, errors: report.errors, ...extras });
    if (plan?.schema_version !== 2 || !plan.coverage || !report.valid) return result('INVALID');
    if (binding_digest && plan.coverage.sha256 !== binding_digest) return result(receipt ? 'STALE' : 'INVALID', { errors: [...report.errors, 'Coverage binding hash mismatch'] });
    if (plan.coverage.catalog_version !== artifact.catalog_version) return result(receipt ? 'STALE' : 'INVALID');
    if (!reconnaissance_complete) return result('DRAFT');
    if (receipt && reconnaissance_digest !== undefined && receipt.reconnaissance_digest !== reconnaissance_digest) return result('STALE', { errors: ['Reconnaissance binding changed'] });
    if (receipt && (receipt.coverage_digest !== digest(artifact) || receipt.plan_revision !== plan.plan_revision || receipt.catalog_version !== artifact.catalog_version || (baseline !== undefined && canonical(receipt.baseline) !== canonical(baseline)) || (session_id !== undefined && receipt.session_id !== session_id) || (workspace !== undefined && receipt.workspace !== workspace) || canonical(receipt.task_ids) !== canonical((plan.tasks || []).map(t => t.task_id)))) return result('STALE');
    if (!receipt) return result('AWAITING_APPROVAL');
    const effective = receipt.approved_artifact || artifact;
    if (receipt.approved_artifact && receipt.approved_digest !== digest(effective)) return result('INVALID', { errors: ['Approved artifact digest mismatch'] });
    if (receipt.approved_artifact && (effective.schema_version !== artifact.schema_version || effective.catalog_version !== artifact.catalog_version || effective.revision !== artifact.revision || canonical(effective.app_types) !== canonical(artifact.app_types) || canonical(effective.classification_sources) !== canonical(artifact.classification_sources) || canonical(effective.dimensions.map(d => d.id)) !== canonical(artifact.dimensions.map(d => d.id)))) return result('INVALID', { errors: ['Approval changed candidate identity'] });
    const approved = validateArtifact(effective);
    const ids = new Set(effective.dimensions.map(d => d.id));
    if ((plan.tasks || []).some(task => (task.decision_ids || []).some(id => !ids.has(id)))) return result('INVALID', { errors: ['Task references unknown decision ID'] });
    if (!approved.valid) return result('INVALID', { errors: approved.errors });
    if (approved.pending_ids.length) return result('AWAITING_APPROVAL', { pending_ids: approved.pending_ids });
    if (!nonempty(receipt.actor) || !nonempty(receipt.source) || !nonempty(receipt.timestamp) || !nonempty(receipt.request_id)) return result('INVALID');
    return result('PASSED', { pending_ids: [], effective_artifact: effective });
}

function validateDecisionLog(artifact, entries, { decision_ids, constraint_findings = [] } = {}) {
    const validation = validateArtifact(artifact), errors = [...validation.errors], advisories = [];
    const defs = new Map(validation.dimensions.map(d => [d.id, d])), rows = new Map((artifact?.dimensions || []).map(d => [d.id, d])), seen = new Set();
    if (!Array.isArray(entries)) return { valid: false, errors: ['decision_log must be an array'], advisories };
    for (const entry of entries) {
        const row = rows.get(entry.dimension_id);
        if (seen.has(entry.dimension_id)) errors.push(`${entry.dimension_id}: duplicate decision log`);
        seen.add(entry.dimension_id);
        if (!row || row.state !== 'delegated') { errors.push(`${entry.dimension_id}: new/unresolved or non-delegated decision`); continue; }
        if (decision_ids && !decision_ids.includes(row.id)) errors.push(`${row.id}: decision outside task binding`);
        errors.push(...validateValue(entry.chosen_value, defs.get(row.id).value_schema, row.id));
        if (!nonempty(entry.rationale) || !Array.isArray(entry.evidence_refs) || !entry.evidence_refs.length || !entry.evidence_refs.every(nonempty)) errors.push(`${row.id}: rationale and evidence required`);
        for (const constraint of row.constraints) {
            if (typeof constraint === 'object') errors.push(...validateValue(entry.chosen_value, constraint, `${row.id}.constraint`));
            else if (!constraint_findings.some(f => f.dimension_id === row.id && f.constraint === constraint && f.satisfied === true && nonempty(f.evidence_ref))) errors.push(`${row.id}: textual constraint requires an explicit review finding`);
        }
        advisories.push({ dimension_id: row.id, chosen_value: entry.chosen_value, message: 'A valid delegated choice is advisory, not an unstated preference violation.' });
    }
    for (const id of decision_ids || []) if (rows.get(id)?.state === 'delegated' && !seen.has(id)) errors.push(`${id}: missing decision log`);
    return { valid: !errors.length, errors, advisories };
}

function inside(root, relative) {
    const target = path.resolve(root, relative);
    if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) failure('INVALID_COVERAGE_PATH', 'Coverage path escapes workspace');
    return target;
}
const IGNORE_RECEIPT = Symbol('ignore superseded coverage receipt');
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function inspectWorkspaceCoverage(root, options = {}) {
    const artifact_path = path.join(root, '.omni/sdlc/spec-coverage.json');
    const report_path = path.join(root, '.omni/sdlc/spec-coverage.report.json');
    let plan = options.plan, artifact, receipt = options.receipt;
    try {
        if (!plan) {
            const file = path.join(root, '.omni/sdlc/dual-plan.json');
            if (!fs.existsSync(file)) return { state: 'LEGACY_UNCHECKED', allowed: true, warning: 'LEGACY_UNCHECKED: no v2 plan binding', pending_ids: [], artifact_path, report_path };
            plan = readJson(file);
        }
        if (plan.schema_version === 1) return { ...evaluateGate({ plan }), artifact_path, report_path, plan };
        require('./contracts').DualPlanManifestSchema.parse(plan);
        const filename = inside(root, plan.coverage?.path || '.omni/sdlc/spec-coverage.json');
        const raw = fs.readFileSync(filename);
        artifact = JSON.parse(raw.toString('utf8'));
        if (!options[IGNORE_RECEIPT] && !receipt && fs.existsSync(path.join(root, '.omni/sdlc/spec-coverage.receipt.json'))) receipt = readJson(path.join(root, '.omni/sdlc/spec-coverage.receipt.json'));
        if (receipt) require('./contracts').CoverageReceiptSchema.parse(receipt);
        const gate = evaluateGate({ ...options, plan, artifact, receipt, binding_digest: digest(raw) });
        const sources = (gate.effective_artifact || artifact).dimensions.flatMap(row => row.sources || []).filter(source => source.kind === 'repository');
        for (const source of sources) {
            let currentDigest;
            try { currentDigest = digest(fs.readFileSync(inside(root, source.path))); } catch { currentDigest = null; }
            if (currentDigest !== source.digest) { gate.state = receipt ? 'STALE' : 'INVALID'; gate.allowed = false; gate.code = 'SPEC_COVERAGE_REQUIRED'; gate.errors = [...(gate.errors || []), `Repository convention changed: ${source.path}#${source.section}`]; }
        }
        return { ...gate, artifact_path: filename, report_path, artifact, receipt, plan, candidate_digest: digest(artifact) };
    } catch (error) { return { state: 'INVALID', allowed: false, code: 'SPEC_COVERAGE_REQUIRED', errors: [error.message], pending_ids: [], artifact_path, report_path, plan }; }
}

class CoverageStore {
    constructor(root) { this.root = root; this.directory = path.join(root, '.omni/sdlc/coverage-approvals'); }
    inspect(options = {}) { return inspectWorkspaceCoverage(this.root, options); }
    approve(request, context = {}) {
        if (!nonempty(request?.request_id) || !nonempty(request.actor) || !nonempty(request.source) || !nonempty(request.session_id) || !nonempty(request.workspace) || !Array.isArray(request.decisions)) failure('INVALID_APPROVAL', 'Explicit request identity, actor/source and per-ID decisions required');
        fs.mkdirSync(this.directory, { recursive: true });
        const key = digest(request.request_id), requestDigest = digest(request), recordPath = path.join(this.directory, `${key}.json`);
        if (fs.existsSync(recordPath)) {
            const previous = readJson(recordPath);
            if (previous.request_digest !== requestDigest) failure('APPROVAL_REQUEST_CONFLICT', 'Same request ID has different content');
            return previous;
        }
        const lock = path.join(this.directory, 'approval.lock');
        let fd;
        try { fd = fs.openSync(lock, 'wx'); } catch { failure('COVERAGE_APPROVAL_CONFLICT', 'Concurrent approval; inspect candidate again'); }
        try {
            let current = this.inspect(context);
            if (current.state === 'STALE') {
                const fresh = this.inspect({ ...context, receipt: undefined, [IGNORE_RECEIPT]: true });
                if (fresh.state !== 'AWAITING_APPROVAL') failure('INVALID_COVERAGE', `Cannot reapprove ${fresh.state}`);
                current = fresh;
            }
            if (current.state === 'PASSED') failure('STALE_COVERAGE', 'Candidate was already approved by another request');
            if (!current.artifact || !['AWAITING_APPROVAL', 'PASSED'].includes(current.state)) failure('INVALID_COVERAGE', `Cannot approve ${current.state}`);
            if (request.candidate_digest !== current.candidate_digest || request.plan_revision !== current.plan.plan_revision || (context.session_id !== undefined && context.session_id !== request.session_id) || (context.workspace !== undefined && context.workspace !== request.workspace)) failure('STALE_COVERAGE', 'Candidate digest or plan/session binding changed');
            const draftBinding = digest({ candidate_digest: current.candidate_digest, plan_revision: request.plan_revision, session_id: request.session_id, workspace: request.workspace, baseline: context.baseline ?? request.baseline ?? null, reconnaissance_digest: context.reconnaissance_digest ?? null });
            const draftPath = path.join(this.directory, 'draft.json');
            const draft = fs.existsSync(draftPath) ? readJson(draftPath) : null;
            const artifact = structuredClone(draft?.binding === draftBinding ? draft.artifact : current.artifact), seen = new Set();
            for (const decision of request.decisions) {
                if (!decision || seen.has(decision.id)) failure('INVALID_APPROVAL', 'Duplicate/missing decision ID');
                if (Object.keys(decision).some(key => !['id', 'state', 'value', 'constraints', 'reason'].includes(key))) failure('INVALID_APPROVAL', 'Decision contains fields outside the approval contract');
                seen.add(decision.id);
                const index = artifact.dimensions.findIndex(row => row.id === decision.id);
                if (index < 0 || !['pinned', 'delegated', 'not_applicable'].includes(decision.state)) failure('INVALID_APPROVAL', `Unknown ID/state ${decision.id}`);
                artifact.dimensions[index] = { ...artifact.dimensions[index], ...decision, sources: [{ kind: 'approval', ref: request.source }] };
                delete artifact.dimensions[index].proposal;
                if (decision.state !== 'pinned') delete artifact.dimensions[index].value;
                if (decision.state !== 'delegated') delete artifact.dimensions[index].constraints;
            }
            const validation = validateArtifact(artifact);
            if (!validation.valid) failure('INVALID_APPROVAL', validation.errors.join('; '));
            // A registered v2 plan is immutable: approval records decisions in the receipt,
            // while its candidate digest remains bound to the registered artifact.
            const receipt = { schema_version: 1, request_id: request.request_id, actor: request.actor, source: request.source, timestamp: new Date().toISOString(), session_id: request.session_id, workspace: request.workspace, catalog_version: artifact.catalog_version, coverage_digest: digest(current.artifact), approved_digest: digest(artifact), plan_revision: current.plan.plan_revision, task_ids: current.plan.tasks.map(t => t.task_id), baseline: context.baseline ?? request.baseline ?? null, ...(context.reconnaissance_digest ? { reconnaissance_digest: context.reconnaissance_digest } : {}), decisions: artifact.dimensions.filter(row => row.state !== 'unresolved'), approved_artifact: artifact };
            const result = { request_digest: requestDigest, artifact, receipt, state: validation.pending_ids.length ? 'AWAITING_APPROVAL' : 'PASSED', pending_ids: validation.pending_ids };
            fs.writeFileSync(recordPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
            if (validation.pending_ids.length) fs.writeFileSync(draftPath, JSON.stringify({ binding: draftBinding, artifact }) + '\n');
            if (!validation.pending_ids.length) {
                const receiptPath = path.join(this.root, '.omni/sdlc/spec-coverage.receipt.json');
                const temporary = `${receiptPath}.${process.pid}.tmp`;
                fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
                fs.renameSync(temporary, receiptPath);
            }
            return result;
        } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    }
}

module.exports = { catalog, canonical, digest, expandCatalog, validateValueSchema, validateValue, validateArtifact, evaluateGate, validateDecisionLog, inspectWorkspaceCoverage, CoverageStore };
