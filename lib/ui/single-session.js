'use strict';

// Single CLI Session Launcher for Omni UI Workspace (T13)
//
// Implements:
// - Isolated single-agent interactive CLI launches
// - Strict separation from Squad authority and presets
// - Persistent metadata in .omni/ui/single.json
// - Native session correlation and resume tracking
// - Concurrent primary session warnings

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SINGLE_METADATA_FILE = path.join('.omni', 'ui', 'single.json');

function createSingleLauncher({
    root,
    registry = null,
    contexts = null,
    terminalRegistry = null,
    clock = { now: () => Date.now(), iso: () => new Date().toISOString() },
    fsImpl = fs,
} = {}) {
    if (!root) {
        throw new Error('root path is required for single launcher');
    }

    const singleMetaPath = path.join(root, SINGLE_METADATA_FILE);
    const activeSessions = new Map(); // contextId -> session

    function readMetadata() {
        if (!fsImpl.existsSync(singleMetaPath)) {
            return {
                schemaVersion: 1,
                lastSlot: { runtime: 'codex', model: 'gpt-4o' },
                sessions: {},
            };
        }
        try {
            const raw = fsImpl.readFileSync(singleMetaPath, 'utf8');
            return JSON.parse(raw);
        } catch {
            return {
                schemaVersion: 1,
                lastSlot: { runtime: 'codex', model: 'gpt-4o' },
                sessions: {},
            };
        }
    }

    function writeMetadata(data) {
        fsImpl.mkdirSync(path.dirname(singleMetaPath), { recursive: true });
        const tmp = `${singleMetaPath}.${process.pid}.tmp`;
        fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fsImpl.renameSync(tmp, singleMetaPath);
    }

    function checkConcurrentPrimary(contextId) {
        // Check if squad context or another single context is running
        if (contexts && typeof contexts.list === 'function') {
            const all = contexts.list();
            const running = all.filter(c => c.id !== contextId && c.status === 'running');
            if (running.length > 0) {
                return {
                    hasConflict: true,
                    message: `Warning: Another primary session (${running.map(r => r.id).join(', ')}) is currently running. Concurrent writes may conflict.`,
                };
            }
        }
        return { hasConflict: false, message: null };
    }

    /**
     * Starts or resumes a Single CLI session in the specified context.
     */
    async function start(contextId, slot, { resume = false } = {}) {
        if (!contextId) {
            throw new Error('contextId is required');
        }

        const effectiveSlot = slot || readMetadata().lastSlot || { runtime: 'codex', model: 'gpt-4o' };
        const runtimeId = effectiveSlot.runtime;

        // Verify runtime in registry if available
        if (registry) {
            let desc;
            try {
                desc = registry.get(runtimeId);
            } catch {
                const err = new Error(`Unknown or unqualified runtime "${runtimeId}"`);
                err.code = 'RUNTIME_UNAVAILABLE';
                err.status = 422;
                throw err;
            }

            if (!desc || !desc.capabilities?.interactive) {
                const err = new Error(`Runtime "${runtimeId}" does not support interactive CLI sessions`);
                err.code = 'RUNTIME_INCAPABLE';
                err.status = 422;
                throw err;
            }
        }

        const conflictWarning = checkConcurrentPrimary(contextId);

        // Generate or resolve session IDs
        const meta = readMetadata();
        let nativeSessionId = resume && meta.sessions[contextId]?.nativeSessionId
            ? meta.sessions[contextId].nativeSessionId
            : `single-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

        // Create or attach terminal via terminalRegistry
        let terminalId = `term-single-${contextId}`;
        if (terminalRegistry) {
            try {
                const term = terminalRegistry.create({
                    id: terminalId,
                    contextId,
                    kind: 'single',
                    runtime: runtimeId,
                    cwd_relative: '',
                    env: {
                        OMNI_SESSION_MODE: 'single',
                        OMNI_CONTEXT_ID: contextId,
                        OMNI_SINGLE_NATIVE_ID: nativeSessionId,
                    },
                });
                terminalId = term.id;
            } catch (err) {
                // If terminal exists, retrieve it
                terminalId = `term-single-${contextId}`;
            }
        }

        const sessionRecord = {
            contextId,
            terminalId,
            nativeSessionId,
            runtime: runtimeId,
            model: effectiveSlot.model,
            effort: effectiveSlot.effort,
            status: 'running',
            started_at: clock.iso(),
            warning: conflictWarning.hasConflict ? conflictWarning.message : null,
        };

        activeSessions.set(contextId, sessionRecord);

        // Persist metadata
        meta.lastSlot = effectiveSlot;
        meta.sessions[contextId] = {
            terminalId,
            nativeSessionId,
            runtime: runtimeId,
            model: effectiveSlot.model,
            effort: effectiveSlot.effort,
            updated_at: clock.iso(),
        };
        writeMetadata(meta);

        // Update context manager status if available
        if (contexts && typeof contexts.get === 'function') {
            const ctx = contexts.get(contextId);
            if (ctx) {
                ctx.status = 'running';
                ctx.authoritySessionId = terminalId;
            }
        }

        return sessionRecord;
    }

    function status(contextId) {
        if (activeSessions.has(contextId)) {
            return activeSessions.get(contextId);
        }
        const meta = readMetadata();
        const saved = meta.sessions[contextId];
        if (saved) {
            return {
                contextId,
                ...saved,
                status: 'idle',
            };
        }
        return {
            contextId,
            status: 'idle',
            terminalId: null,
            nativeSessionId: null,
        };
    }

    async function stop(contextId) {
        const session = activeSessions.get(contextId);
        if (session) {
            session.status = 'exited';
            if (terminalRegistry) {
                try {
                    terminalRegistry.stop(session.terminalId);
                } catch {
                    // Ignore stop error
                }
            }
            activeSessions.delete(contextId);
        }

        if (contexts && typeof contexts.get === 'function') {
            const ctx = contexts.get(contextId);
            if (ctx) {
                ctx.status = 'idle';
            }
        }

        return { ok: true, contextId };
    }

    return {
        start,
        status,
        stop,
        readMetadata,
        writeMetadata,
        checkConcurrentPrimary,
    };
}

module.exports = {
    createSingleLauncher,
    SINGLE_METADATA_FILE,
};
