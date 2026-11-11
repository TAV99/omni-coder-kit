'use strict';

// Generic injected PTY session lifecycle (T03)
// Decoupled from orchestrator binding lookups. Supports single-writer,
// generation-tracked replay, bounded 1 MiB UTF-8 ring, and clean child env.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RING_BYTES = 1024 * 1024; // 1 MiB
const MAX_INPUT = 64 * 1024;    // 64 KiB
const MAX_PENDING_CLIENT_BYTES = 4 * 1024 * 1024; // 4 MiB client backpressure limit

const PARENT_SESSION_ENV = [
    'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'AI_AGENT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'
];

function childEnv(env = process.env) {
    const out = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of PARENT_SESSION_ENV) delete out[key];
    return out;
}

function createTerminalSession({
    id = crypto.randomUUID(),
    contextId = 'default',
    kind = 'user-shell',
    cwd = process.cwd(),
    runtime = null,
    spawnPty = null,
    unavailableReason = null,
    env = process.env,
    ringBytes = RING_BYTES,
    now = () => new Date().toISOString(),
} = {}) {
    const listeners = new Map(); // clientId -> { listener, pendingBytes }
    let ring = [];
    let ringSize = 0;
    let seq = 0;
    let generation = 1;
    let child = null;
    let writer = null;
    let size = { cols: 100, rows: 30 };
    let status = { status: 'idle' };
    let nativeSessionId = null;

    function summary() {
        return {
            id,
            contextId,
            kind,
            runtime,
            cwd,
            status: status.status,
            nativeSessionId,
            writerClientId: writer,
            generation,
            cols: size.cols,
            rows: size.rows,
            clients: listeners.size,
            available: Boolean(spawnPty),
            ...(spawnPty ? {} : { reason: unavailableReason || 'node-pty is not available' }),
        };
    }

    function emit(event, payload) {
        for (const [clientId, client] of listeners.entries()) {
            if (event === 'data' && payload && typeof payload.data === 'string') {
                const bytes = Buffer.byteLength(payload.data, 'utf8');
                client.pendingBytes += bytes;
                if (client.pendingBytes > MAX_PENDING_CLIENT_BYTES) {
                    // Backpressure disconnect: slow consumer queue exceeded 4 MiB
                    listeners.delete(clientId);
                    if (writer === clientId) writer = null;
                    try {
                        client.listener('error', { code: 'TERMINAL_CLIENT_OVERFLOW', message: 'Client disconnected due to output overflow' });
                    } catch {}
                    continue;
                }
            }
            try {
                client.listener(event, payload);
            } catch {
                // Client error
            }
        }
    }

    function push(data) {
        seq += 1;
        const entry = { seq, data, generation };
        ring.push(entry);
        ringSize += Buffer.byteLength(data, 'utf8');
        while (ringSize > ringBytes && ring.length > 1) {
            const removed = ring.shift();
            ringSize -= Buffer.byteLength(removed.data, 'utf8');
        }
        emit('data', { seq, data, generation });
    }

    function start({ command, args = [], cwd: runCwd = cwd, env: runEnv = env } = {}) {
        if (!spawnPty) {
            const err = new Error(unavailableReason || 'node-pty is not available');
            err.code = 'UI_PTY_UNAVAILABLE';
            status = { status: 'failed', error: err.message };
            throw err;
        }

        if (child) {
            const err = new Error('Terminal session is already running');
            err.code = 'UI_PTY_RUNNING';
            throw err;
        }

        generation += 1;
        seq = 0;
        ring = [];
        ringSize = 0;

        let spawned;
        try {
            spawned = spawnPty(command, args, {
                name: 'xterm-256color',
                cols: size.cols,
                rows: size.rows,
                cwd: runCwd,
                env: childEnv(runEnv),
            });
        } catch (err) {
            status = { status: 'failed', error: err.message, code: err.code || null };
            emit('state', summary());
            throw err;
        }

        child = spawned;
        const startedAt = now();
        status = { status: 'running', pid: spawned.pid, started_at: startedAt };

        spawned.onData((data) => {
            if (child === spawned) push(data);
        });

        spawned.onExit(({ exitCode, signal }) => {
            if (child !== spawned) return;
            child = null;
            status = { status: 'exited', exit_code: exitCode, signal: signal || null, started_at: startedAt };
            emit('state', summary());
        });

        emit('state', summary());
        return summary();
    }

    function attach(listener, after = { seq: 0, generation: 0 }) {
        const clientId = crypto.randomUUID();
        const firstSeq = ring.length ? ring[0].seq : seq + 1;
        const requestedGen = typeof after === 'object' && after !== null ? Number(after.generation || 0) : 0;
        const requestedSeq = typeof after === 'object' && after !== null ? Number(after.seq || 0) : Number(after || 0);

        const genMismatch = requestedGen !== 0 && requestedGen !== generation;
        const seqTooOld = requestedSeq < firstSeq - 1;
        const needsReset = genMismatch || seqTooOld;

        const chunks = needsReset ? [...ring] : ring.filter((chunk) => chunk.seq > requestedSeq);
        const replay = {
            reset: needsReset,
            generation,
            chunks,
        };

        listeners.set(clientId, { listener, pendingBytes: 0 });
        if (!writer) writer = clientId;
        emit('state', summary());

        return {
            clientId,
            replay,
            detach() {
                listeners.delete(clientId);
                if (writer === clientId) writer = null;
                emit('state', summary());
            },
            ack(bytesProcessed) {
                const client = listeners.get(clientId);
                if (client) {
                    client.pendingBytes = Math.max(0, client.pendingBytes - bytesProcessed);
                }
            }
        };
    }

    function claim(clientId) {
        if (!listeners.has(clientId)) {
            const err = new Error('unknown client');
            err.code = 'UI_PTY_CLIENT';
            throw err;
        }
        writer = clientId;
        emit('state', summary());
    }

    function assertWriter(clientId) {
        if (!listeners.has(clientId)) {
            const err = new Error('unknown client');
            err.code = 'UI_PTY_CLIENT';
            throw err;
        }
        if (writer !== clientId) {
            const err = new Error('another tab is typing — take control first');
            err.code = 'UI_PTY_NOT_WRITER';
            throw err;
        }
    }

    function input(clientId, data) {
        assertWriter(clientId);
        if (typeof data !== 'string' || !data || Buffer.byteLength(data, 'utf8') > MAX_INPUT) {
            const err = new Error('bad input or exceeds 64 KiB');
            err.code = 'UI_PTY_INPUT';
            throw err;
        }
        if (!child) {
            const err = new Error('terminal is not running');
            err.code = 'UI_PTY_STOPPED';
            throw err;
        }
        child.write(data);
    }

    function resize(clientId, cols, rows) {
        assertWriter(clientId);
        if (![cols, rows].every(Number.isInteger) || cols < 2 || cols > 1000 || rows < 2 || rows > 500) {
            const err = new Error('bad size');
            err.code = 'UI_PTY_INPUT';
            throw err;
        }
        size = { cols, rows };
        if (child) {
            child.resize(cols, rows);
        }
    }

    function stop() {
        const running = child;
        child = null;
        if (running) {
            try { running.kill('SIGHUP'); } catch {}
        }
        status = { status: 'exited' };
        for (const { listener } of listeners.values()) {
            try { listener('close'); } catch {}
        }
        listeners.clear();
        writer = null;
    }

    return {
        id,
        contextId,
        kind,
        summary,
        start,
        attach,
        claim,
        input,
        resize,
        stop,
        setNativeSessionId(sid) { nativeSessionId = sid; },
    };
}

module.exports = {
    createTerminalSession,
    childEnv,
    RING_BYTES,
    MAX_INPUT,
    MAX_PENDING_CLIENT_BYTES,
};
