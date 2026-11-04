'use strict';

// Binding Service for Omni UI (T11)
//
// Implements:
// - catalog(roleId): Runtimes, models, and efforts eligible for a given role, checking engineSupport
// - preflight(candidate): 60s TTL candidate digest, engine/sharing warnings, validation without active changes
// - saveDraft(candidate, expectedRevision): Atomic persistence to .omni/ui/binding-drafts.json
// - getDraft(): Reads current draft
// - apply(request): Refuses execution or delegates to daemon coordinator (T12)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    BindingSchema,
    checkBinding,
    sharingWarnings,
    engineSupport,
    readBinding,
} = require('../squad/bindings');
const { loadRoles, REQUIRED_ROLES } = require('../squad/roles');

const DRAFT_FILE = path.join('.omni', 'ui', 'binding-drafts.json');
const PREFLIGHT_TTL_MS = 60000; // 60 seconds

function normalizeCandidate(candidate, defaultTimestamp = new Date().toISOString()) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    return {
        schema_version: 1,
        preset: candidate.preset || 'squad',
        roles: {
            orchestrator: candidate.roles?.orchestrator ? {
                runtime: candidate.roles.orchestrator.runtime,
                model: candidate.roles.orchestrator.model,
                effort: candidate.roles.orchestrator.effort || undefined,
            } : null,
            worker: Array.isArray(candidate.roles?.worker) ? candidate.roles.worker.map(w => ({
                id: w.id,
                runtime: w.runtime,
                model: w.model,
                effort: w.effort || undefined,
            })) : [],
            reviewer: candidate.roles?.reviewer ? {
                runtime: candidate.roles.reviewer.runtime,
                model: candidate.roles.reviewer.model,
                effort: candidate.roles.reviewer.effort || undefined,
            } : null,
        },
        auto: Boolean(candidate.auto),
        limits: candidate.limits || undefined,
        updated_at: candidate.updated_at || defaultTimestamp,
    };
}

function computeDigest(normalized) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex');
}

function createBindingService({
    root,
    registry,
    roles = null,
    draftsFile = null,
    clock = { now: () => Date.now(), iso: () => new Date().toISOString() },
    coordinator = null,
    fsImpl = fs,
} = {}) {
    if (!root) {
        throw new Error('root path is required for binding service');
    }

    const draftFilePath = draftsFile || path.join(root, DRAFT_FILE);
    const preflightCache = new Map(); // digest -> { result, expiresAt }

    // Lazy load or resolve roles
    function getRoles() {
        if (roles) return roles;
        try {
            return loadRoles(root, { fsImpl });
        } catch {
            return REQUIRED_ROLES;
        }
    }

    // Reads current active binding revision
    function getActiveRevision() {
        try {
            const active = readBinding(root, { fsImpl });
            if (!active) return 'initial';
            return crypto.createHash('sha256')
                .update(JSON.stringify(active))
                .digest('hex')
                .slice(0, 16);
        } catch {
            return 'initial';
        }
    }

    /**
     * Lists eligible runtimes, models, and efforts for a given role.
     */
    async function catalog(roleId) {
        if (!roleId || typeof roleId !== 'string') {
            throw new Error('roleId is required');
        }

        const allRoles = getRoles();
        const role = allRoles[roleId];
        if (!role) {
            return {
                roleId,
                supported: false,
                error: `Unknown role: ${roleId}`,
                runtimes: [],
            };
        }

        let reports = [];
        if (registry && typeof registry.probeAll === 'function') {
            try {
                reports = await registry.probeAll({});
            } catch {
                reports = [];
            }
        }
        const reportOf = Object.fromEntries(reports.map(r => [r.id, r]));

        const runtimesList = [];
        const registered = registry ? registry.list() : [];

        for (const desc of registered) {
            const runtimeId = desc.id;
            const issues = [];
            const report = reportOf[runtimeId];

            // 1. Role capability check
            const missingCaps = (role.requires || []).filter(cap => !desc.capabilities?.[cap]);
            if (missingCaps.length > 0) {
                issues.push(`Lacks required capabilities: ${missingCaps.join(', ')}`);
            }

            // 2. Engine support check
            if (roleId === 'orchestrator' && !['codex', 'claude'].includes(runtimeId)) {
                issues.push('Orchestrator role requires codex or claude (engine limitation)');
            }

            // 3. Probed models and efforts
            let models = [];
            if (report?.models?.ok && Array.isArray(report.models.models)) {
                models = report.models.models.map(m => ({
                    id: m.id,
                    name: m.name || m.id,
                    efforts: m.efforts || desc.efforts || [],
                    defaultEffort: m.defaultEffort,
                }));
            }

            const eligible = issues.length === 0;
            runtimesList.push({
                id: runtimeId,
                displayName: desc.displayName || runtimeId,
                eligible,
                issues,
                capabilities: desc.capabilities || {},
                models,
                efforts: desc.efforts || [],
            });
        }

        return {
            roleId,
            supported: true,
            runtimes: runtimesList,
        };
    }

    /**
     * Preflights a complete candidate binding.
     */
    async function preflight(candidate) {
        if (!candidate || typeof candidate !== 'object') {
            throw new Error('candidate binding object is required');
        }

        const normalized = normalizeCandidate(candidate, clock.iso());
        const digest = computeDigest(normalized);
        const now = clock.now();

        // Check cache
        const cached = preflightCache.get(digest);
        if (cached && cached.expiresAt > now) {
            return cached.result;
        }

        const errors = [];
        const warnings = [];

        // Validate schema
        const parseRes = BindingSchema.safeParse(normalized);
        if (!parseRes.success) {
            parseRes.error.issues.forEach(issue => {
                errors.push({
                    code: 'SQUAD_BINDING_SCHEMA',
                    message: `${issue.path.join('.') || 'root'}: ${issue.message}`,
                });
            });
        }

        // If schema is valid, perform deep checks
        if (parseRes.success) {
            let reports = [];
            if (registry && typeof registry.probeAll === 'function') {
                try {
                    reports = await registry.probeAll({});
                } catch {
                    reports = [];
                }
            }

            const allRoles = getRoles();
            const checked = checkBinding(parseRes.data, {
                roles: allRoles,
                registry,
                reports,
            });
            errors.push(...checked.errors);
            warnings.push(...checked.warnings);

            const eng = engineSupport(parseRes.data);
            if (!eng.supported) {
                eng.reasons.forEach(r => {
                    errors.push({ code: 'ENGINE_NOT_SUPPORTED', message: r });
                });
            }
        }

        const activeRevision = getActiveRevision();
        const expiresAt = now + PREFLIGHT_TTL_MS;
        const result = {
            valid: errors.length === 0,
            digest,
            active_revision: activeRevision,
            expires_at: new Date(expiresAt).toISOString(),
            errors,
            warnings,
        };

        preflightCache.set(digest, { result, expiresAt });
        return result;
    }

    /**
     * Reads current binding draft if available.
     */
    function getDraft() {
        if (!fsImpl.existsSync(draftFilePath)) {
            return null;
        }
        try {
            const raw = fsImpl.readFileSync(draftFilePath, 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * Saves a binding draft to .omni/ui/binding-drafts.json.
     */
    async function saveDraft(candidate, expectedRevision = null) {
        if (!candidate || typeof candidate !== 'object') {
            throw new Error('candidate is required');
        }

        const currentDraft = getDraft();
        if (expectedRevision && currentDraft && currentDraft.revision !== expectedRevision) {
            const err = new Error(`Draft revision conflict: expected ${expectedRevision}, found ${currentDraft.revision}`);
            err.code = 'DRAFT_CONFLICT';
            err.status = 409;
            throw err;
        }

        const normalized = normalizeCandidate(candidate);
        const newRevision = crypto.randomUUID();
        const record = {
            schemaVersion: 1,
            draft_id: `draft-${Date.now().toString(36)}`,
            revision: newRevision,
            candidate: normalized,
            updated_at: clock.iso(),
        };

        fsImpl.mkdirSync(path.dirname(draftFilePath), { recursive: true });
        const tempPath = `${draftFilePath}.${process.pid}.${Date.now()}.tmp`;
        fsImpl.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        fsImpl.renameSync(tempPath, draftFilePath);

        return record;
    }

    /**
     * Requests applying a binding.
     * Unavailable until coordinator is connected in T12.
     */
    async function apply(request) {
        if (!coordinator) {
            const err = new Error('Binding apply is not available until safe daemon coordinator is initialized (T12)');
            err.code = 'APPLY_UNAVAILABLE';
            err.status = 503;
            throw err;
        }
        return coordinator.apply(request);
    }

    return {
        catalog,
        preflight,
        getDraft,
        saveDraft,
        apply,
        getActiveRevision,
    };
}

module.exports = {
    createBindingService,
    DRAFT_FILE,
    PREFLIGHT_TTL_MS,
};
