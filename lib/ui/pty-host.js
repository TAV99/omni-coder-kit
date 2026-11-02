'use strict';

// Orchestrator PTY for `omni ui` (SPEC-SQUAD-P6 §5, P6b): runs the bound
// orchestrator CLI in a pseudo-terminal, keeps a 1 MiB ring of output for
// scrollback and re-attach, and lets one attached tab type at a time.
// node-pty is optional: without it the host reports `available: false` and the
// rest of the UI stays read-only (V39).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readBinding } = require('../squad/bindings');
const { defaultRegistry, resolveBinary } = require('../squad/runtimes');

const RING_BYTES = 1024 * 1024;
const MAX_INPUT = 64 * 1024;
const STATE_FILE = path.join('.omni', 'ui', 'orchestrator.json');
// Markers a parent agent session leaves in the env; inherited, they change the
// child CLI's behaviour (claude stops saving its transcript, V40).
const PARENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'AI_AGENT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'];
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const CODEX_RESUME = /codex resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

// node-pty 1.1.0 ships its prebuilt spawn-helper without the execute bit, so
// every spawn fails with `posix_spawnp failed` until it is fixed (V39).
function ensureSpawnHelper(ptyMain, { fsImpl = fs, platform = process.platform, arch = process.arch } = {}) {
    if (platform === 'win32') return;
    const root = path.join(path.dirname(ptyMain), '..');
    for (const helper of [path.join(root, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'), path.join(root, 'build', 'Release', 'spawn-helper')]) {
        if (!fsImpl.existsSync(helper)) continue;
        try { fsImpl.accessSync(helper, fs.constants.X_OK); } catch { fsImpl.chmodSync(helper, 0o755); }
    }
}

function loadNodePty({ requireImpl = require } = {}) {
    try {
        const main = requireImpl.resolve('node-pty');
        ensureSpawnHelper(main);
        const pty = requireImpl('node-pty');
        return { spawnPty: (command, args, options) => pty.spawn(command, args, options) };
    } catch (error) {
        return { reason: error.code === 'MODULE_NOT_FOUND' ? 'node-pty is not installed' : `node-pty failed to load: ${error.message}` };
    }
}

function childEnv(env) {
    const out = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of PARENT_SESSION_ENV) delete out[key];
    return out;
}

function createPtyHost({ projectRoot, spawnPty, unavailableReason = null, env = process.env, ringBytes = RING_BYTES,
    registry = defaultRegistry, resolve = (runtime) => resolveBinary(runtime.binary, { env }), now = () => new Date().toISOString() } = {}) {
    const stateFile = path.join(projectRoot, STATE_FILE);
    const listeners = new Map();
    let ring = [];
    let ringSize = 0;
    let seq = 0;
    let child = null;
    let writer = null;
    let tail = '';
    let size = { cols: 100, rows: 30 };
    let status = { status: 'idle' };

    const readSaved = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
    const save = (value) => {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\n`);
    };
    const emit = (event, payload) => { for (const listener of listeners.values()) listener(event, payload); };
    const setStatus = (next) => { status = next; emit('state', snapshot()); };

    function snapshot() {
        const saved = readSaved();
        return { available: Boolean(spawnPty), ...(spawnPty ? {} : { reason: unavailableReason || 'node-pty is not available' }),
            ...status, writer, clients: listeners.size, cols: size.cols, rows: size.rows,
            resumable: Boolean(saved && saved.session_id) ? { runtime: saved.runtime, session_id: saved.session_id } : null };
    }

    function push(data) {
        seq += 1;
        ring.push({ seq, data });
        ringSize += data.length;
        while (ringSize > ringBytes && ring.length > 1) ringSize -= ring.shift().data.length;
        tail = (tail + data).slice(-4096);
        emit('data', { seq, data });
    }

    function orchestratorCommand({ resume }) {
        const binding = readBinding(projectRoot);
        if (!binding) throw Object.assign(new Error('no squad binding — run omni squad setup'), { code: 'UI_PTY_NO_BINDING' });
        const { runtime: runtimeId, model, effort } = binding.roles.orchestrator;
        const runtime = registry.get(runtimeId);
        if (typeof runtime.interactiveCommand !== 'function') {
            throw Object.assign(new Error(`${runtimeId} has no interactive mode`), { code: 'UI_PTY_NOT_INTERACTIVE' });
        }
        const resolved = resolve(runtime);
        if (!resolved.found) throw Object.assign(new Error(resolved.reason || `${runtimeId} not found`), { code: 'UI_PTY_NOT_FOUND' });
        const saved = readSaved();
        let session = {};
        // Resume only the session this UI recorded for the same runtime (D18: never `--last`).
        if (resume && saved && saved.runtime === runtimeId && saved.session_id) session = { resumeId: saved.session_id };
        else if (runtimeId === 'claude') session = { newId: crypto.randomUUID() };
        const invocation = runtime.interactiveCommand({ model, ...(effort ? { effort } : {}), cwd: projectRoot, session }, { resolved });
        return { runtimeId, model, invocation, sessionId: session.resumeId || session.newId || null };
    }

    function start({ resume = false } = {}) {
        if (!spawnPty) throw Object.assign(new Error(unavailableReason || 'node-pty is not available'), { code: 'UI_PTY_UNAVAILABLE' });
        if (child) throw Object.assign(new Error('the orchestrator is already running'), { code: 'UI_PTY_RUNNING' });
        let runtimeId; let model; let invocation; let sessionId; let spawned;
        try {
            ({ runtimeId, model, invocation, sessionId } = orchestratorCommand({ resume }));
            spawned = spawnPty(invocation.command, [...invocation.args], { name: 'xterm-256color', cols: size.cols, rows: size.rows,
                cwd: invocation.cwd, env: childEnv(env) });
        } catch (error) {
            setStatus({ status: 'failed', error: error.message, code: error.code || null });
            throw error;
        }
        tail = '';
        child = spawned;
        const startedAt = now();
        // Recorded even without an id (codex): the transcript is found by cwd + start time (§6).
        save({ runtime: runtimeId, session_id: sessionId, started_at: startedAt });
        push(`\r\n\x1b[2m[omni] ${[invocation.command, ...invocation.args].join(' ')}\x1b[0m\r\n`);
        spawned.onData((data) => { if (child === spawned) push(data); });
        spawned.onExit(({ exitCode, signal }) => {
            if (child !== spawned) return;
            child = null;
            // codex prints `codex resume <id>` on exit; keep it so "resume" reopens this session.
            const ids = [...tail.replace(ANSI, '').matchAll(CODEX_RESUME)].map((match) => match[1]);
            if (runtimeId === 'codex' && ids.length) save({ runtime: runtimeId, session_id: ids.at(-1), started_at: startedAt });
            push(`\r\n\x1b[2m[omni] orchestrator exited (code ${exitCode}${signal ? `, signal ${signal}` : ''})\x1b[0m\r\n`);
            setStatus({ status: 'exited', runtime: runtimeId, model, exit_code: exitCode, signal: signal || null, started_at: startedAt });
        });
        setStatus({ status: 'running', runtime: runtimeId, model, pid: spawned.pid, started_at: startedAt });
        return snapshot();
    }

    // Chunks after `afterSeq`; `reset` when part of what the client missed left the ring.
    function attach(listener, afterSeq = 0) {
        const clientId = crypto.randomUUID();
        const firstSeq = ring.length ? ring[0].seq : seq + 1;
        const after = Number.isSafeInteger(afterSeq) && afterSeq >= 0 && afterSeq <= seq ? afterSeq : 0;
        const replay = { reset: after < firstSeq - 1, chunks: ring.filter((chunk) => chunk.seq > after) };
        listeners.set(clientId, listener);
        if (!writer) writer = clientId;
        emit('state', snapshot());
        return { clientId, replay, detach() {
            listeners.delete(clientId);
            if (writer === clientId) writer = null;
            emit('state', snapshot());
        } };
    }

    function assertWriter(clientId) {
        if (!listeners.has(clientId)) throw Object.assign(new Error('unknown client'), { code: 'UI_PTY_CLIENT' });
        if (writer !== clientId) throw Object.assign(new Error('another tab is typing — take control first'), { code: 'UI_PTY_NOT_WRITER' });
    }

    return {
        start,
        attach,
        status: snapshot,
        // The orchestrator session this UI last started: { runtime, session_id, started_at } or null.
        sessionRef: readSaved,
        // codex learns its id late (transcript or exit line); keep it for resume and the timeline.
        recordSession(runtimeId, sessionId) {
            const saved = readSaved();
            if (saved && saved.runtime === runtimeId && !saved.session_id && typeof sessionId === 'string') save({ ...saved, session_id: sessionId });
        },
        claim(clientId) {
            if (!listeners.has(clientId)) throw Object.assign(new Error('unknown client'), { code: 'UI_PTY_CLIENT' });
            writer = clientId;
            emit('state', snapshot());
        },
        input(clientId, data) {
            assertWriter(clientId);
            if (typeof data !== 'string' || !data || data.length > MAX_INPUT) throw Object.assign(new Error('bad input'), { code: 'UI_PTY_INPUT' });
            if (!child) throw Object.assign(new Error('the orchestrator is not running'), { code: 'UI_PTY_STOPPED' });
            child.write(data);
        },
        resize(clientId, cols, rows) {
            assertWriter(clientId);
            if (![cols, rows].every(Number.isInteger) || cols < 2 || cols > 1000 || rows < 2 || rows > 500) {
                throw Object.assign(new Error('bad size'), { code: 'UI_PTY_INPUT' });
            }
            size = { cols, rows };
            if (child) child.resize(cols, rows);
        },
        stop() {
            const running = child;
            child = null;
            if (running) { try { running.kill('SIGHUP'); } catch { /* already gone */ } }
            for (const listener of listeners.values()) listener('close');
            listeners.clear();
        },
    };
}

module.exports = { createPtyHost, loadNodePty, ensureSpawnHelper, childEnv, PARENT_SESSION_ENV };
