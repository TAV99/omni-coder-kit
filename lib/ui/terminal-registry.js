'use strict';

// Terminal Registry for Omni UI Workspace (T03)
// Enforces max 8 interactive terminals/project, ownership, independent
// lifecycles, and clean shutdown.

const crypto = require('node:crypto');
const { createTerminalSession } = require('./terminal-session');

const MAX_INTERACTIVE_TERMINALS = 8;

function createTerminalRegistry({
    projectRoot,
    spawnPty = null,
    unavailableReason = null,
    env = process.env,
    now = () => new Date().toISOString(),
} = {}) {
    const terminals = new Map(); // terminalId -> session

    function activeCount() {
        let count = 0;
        for (const session of terminals.values()) {
            const s = session.summary();
            if (s.status === 'running' || s.status === 'idle') {
                count += 1;
            }
        }
        return count;
    }

    function create(spec = {}) {
        if (activeCount() >= MAX_INTERACTIVE_TERMINALS) {
            const err = new Error(`Maximum limit of ${MAX_INTERACTIVE_TERMINALS} interactive terminals reached for this project`);
            err.code = 'TERMINAL_LIMIT_EXCEEDED';
            err.status = 429;
            throw err;
        }

        const id = spec.id || crypto.randomUUID();
        const contextId = spec.contextId || 'default';
        const kind = spec.kind || 'user-shell';
        const cwd = spec.cwd || projectRoot || process.cwd();

        const session = createTerminalSession({
            id,
            contextId,
            kind,
            cwd,
            runtime: spec.runtime || null,
            spawnPty: spec.spawnPty || spawnPty,
            unavailableReason,
            env,
            now,
        });

        terminals.set(id, session);

        if (spec.autoStart) {
            const shellCmd = spec.command || (process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/zsh');
            const shellArgs = spec.args || [];
            try {
                session.start({ command: shellCmd, args: shellArgs, cwd });
            } catch (err) {
                // Return summary reflecting failed status
            }
        }

        return session.summary();
    }

    function list(contextId) {
        const results = [];
        for (const session of terminals.values()) {
            const s = session.summary();
            if (!contextId || s.contextId === contextId) {
                results.push(s);
            }
        }
        return results;
    }

    function get(id) {
        return terminals.get(id) || null;
    }

    function findSession(id) {
        const session = terminals.get(id);
        if (!session) {
            const err = new Error(`Terminal ${id} not found`);
            err.code = 'TERMINAL_NOT_FOUND';
            err.status = 404;
            throw err;
        }
        return session;
    }

    function attach(id, listener, after) {
        const session = findSession(id);
        return session.attach(listener, after);
    }

    function claim(id, clientId) {
        const session = findSession(id);
        session.claim(clientId);
        return session.summary();
    }

    function input(id, clientId, data) {
        const session = findSession(id);
        session.input(clientId, data);
    }

    function resize(id, clientId, cols, rows) {
        const session = findSession(id);
        session.resize(clientId, cols, rows);
    }

    function stop(id) {
        const session = terminals.get(id);
        if (session) {
            session.stop();
            return session.summary();
        }
        return null;
    }

    function closeAll() {
        for (const session of terminals.values()) {
            session.stop();
        }
        terminals.clear();
    }

    return {
        create,
        list,
        get,
        attach,
        claim,
        input,
        resize,
        stop,
        closeAll,
        activeCount,
    };
}

module.exports = {
    createTerminalRegistry,
    MAX_INTERACTIVE_TERMINALS,
};
