'use strict';

const path = require('node:path');
const fs = require('node:fs');

function createContextManager({
    projectRoot,
    registry,
    preferencesStore = null,
    now = () => new Date().toISOString(),
}) {
    let selectedContextId = 'squad';
    const primaryTerminals = new Map(); // contextId -> terminalId

    function deriveAuthoritySessionId() {
        const authorityFile = path.join(projectRoot, '.omni', 'runs', 'dual-authority', 'events.ndjson');
        if (!fs.existsSync(authorityFile)) return null;
        try {
            const lines = fs.readFileSync(authorityFile, 'utf8').trim().split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                const evt = JSON.parse(line);
                if (evt.type === 'session.created' && evt.session_id) {
                    return evt.session_id;
                }
            }
        } catch {}
        return null;
    }

    function getContextStatus(contextId) {
        const termId = primaryTerminals.get(contextId);
        if (!termId) return 'idle';
        const session = registry.get(termId);
        if (!session) return 'idle';
        const s = session.summary();
        return s.status || 'idle';
    }

    function list() {
        return [
            {
                id: 'squad',
                mode: 'squad',
                authoritySessionId: deriveAuthoritySessionId(),
                bindingRevision: null,
                status: getContextStatus('squad'),
            },
            {
                id: 'single',
                mode: 'single',
                authoritySessionId: null,
                bindingRevision: null,
                status: getContextStatus('single'),
            },
        ];
    }

    function get(id) {
        return list().find((c) => c.id === id) || null;
    }

    function getSelectedContextId() {
        return selectedContextId;
    }

    function select(id) {
        if (id !== 'squad' && id !== 'single') {
            const err = new Error(`Invalid context ID "${id}". Must be "squad" or "single"`);
            err.code = 'INVALID_CONTEXT_ID';
            err.status = 400;
            throw err;
        }
        selectedContextId = id;
        return get(id);
    }

    function getPrimaryTerminal(contextId) {
        if (primaryTerminals.has(contextId)) {
            const termId = primaryTerminals.get(contextId);
            const existing = registry.get(termId);
            if (existing) return existing.summary();
        }

        const summary = registry.create({
            contextId,
            kind: 'primary',
            autoStart: true,
        });
        primaryTerminals.set(contextId, summary.id);
        return summary;
    }

    function getWorkspaceSummary() {
        let prefRev = 'initial';
        if (preferencesStore) {
            try {
                prefRev = preferencesStore.read().revision;
            } catch {}
        }

        return {
            selectedContextId,
            contexts: list(),
            capabilities: {
                singleMode: true,
                squadMode: true,
                userShells: true,
                themes: ['system', 'graphite', 'paper', 'midnight'],
            },
            revisions: {
                preferences: prefRev,
            },
        };
    }

    async function handleRoute(req, res, url, { send, readJsonBody }) {
        // GET /api/workspace
        if (req.method === 'GET' && url.pathname === '/api/workspace') {
            send(res, 200, getWorkspaceSummary());
            return true;
        }

        // POST /api/contexts
        if (req.method === 'POST' && url.pathname === '/api/contexts') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
                send(res, 415, { error: 'expected application/json' });
                return true;
            }

            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                send(res, 400, { error: err.message });
                return true;
            }

            const targetMode = body.mode;
            if (targetMode !== 'squad' && targetMode !== 'single') {
                send(res, 400, { error: 'mode must be "squad" or "single"', code: 'INVALID_MODE' });
                return true;
            }

            const ctx = select(targetMode);
            send(res, 200, ctx);
            return true;
        }

        // GET /api/contexts/:id/state
        const stateMatch = /^\/api\/contexts\/([^/]+)\/state$/.exec(url.pathname);
        if (req.method === 'GET' && stateMatch) {
            const ctxId = stateMatch[1];
            const ctx = get(ctxId);
            if (!ctx) {
                send(res, 404, { error: `Context "${ctxId}" not found`, code: 'CONTEXT_NOT_FOUND' });
                return true;
            }

            const terminals = registry.list(ctxId);
            send(res, 200, {
                context: ctx,
                terminals,
            });
            return true;
        }

        return false;
    }

    return {
        list,
        get,
        getSelectedContextId,
        select,
        getPrimaryTerminal,
        getWorkspaceSummary,
        handleRoute,
    };
}

module.exports = {
    createContextManager,
};
