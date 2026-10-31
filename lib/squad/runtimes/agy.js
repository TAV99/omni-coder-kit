'use strict';

// Antigravity CLI (agy) adapter (SPEC-SQUAD-P1 §3–§5). Behaviour verified
// against agy 1.4.7 (spec appendix V4–V6): there is no login/status command,
// so auth is inferred from `agy models`; headless `--mode accept-edits` still
// soft-denies write_file, so workspace-write is unsupported.

const path = require('node:path');
const {
    SquadRuntimeError, defineRuntime, parseTurn, assertSessionRef, assertPermission, binaryOf, invocation,
} = require('./contract');
const { modelFamily } = require('./families');
const { runProbe, probeFailure } = require('./probe');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function extraCandidates(ctx) {
    if (ctx.platform === 'win32') {
        return ctx.env.LOCALAPPDATA ? [path.win32.join(ctx.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')] : [];
    }
    return [
        path.posix.join(ctx.homedir, '.local', 'bin', 'agy'),
        path.posix.join(ctx.homedir, 'bin', 'agy'),
    ];
}

function permissionFlags(profile, opts = {}) {
    assertPermission('agy', profile, opts);
    if (profile === 'read-only') return ['--mode', 'plan'];
    if (profile === 'workspace-write') {
        throw new SquadRuntimeError('SQUAD_RUNTIME_PERMISSION_UNSUPPORTED',
            'agy cannot grant scoped writes in headless mode; use full-auto inside an isolated worker root');
    }
    return ['--mode', 'accept-edits', '--dangerously-skip-permissions'];
}

// agy's own --print-timeout must end before the OS timeout so agy returns output
// instead of being killed blind: 30 s of headroom, or half the budget when short.
function printTimeoutSeconds(timeoutMs) {
    const withHeadroom = Math.floor((timeoutMs - 30_000) / 1000);
    return withHeadroom >= 30 ? withHeadroom : Math.max(1, Math.floor(timeoutMs / 2000));
}

function parseModels(stdout) {
    const text = String(stdout || '').trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : (parsed && (parsed.models || parsed.data));
        if (Array.isArray(list)) {
            return list.map((m) => (typeof m === 'string' ? { id: m, label: m }
                : m && typeof m === 'object' ? { id: m.id || m.name || m.model, label: m.display_name || m.label || m.name || m.id } : null))
                .filter((m) => m && typeof m.id === 'string' && m.id);
        }
    } catch {
        // not JSON — fall through to the tab-separated listing
    }
    return text.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^Fetching available models/i.test(line))
        .map((line) => {
            const [id, ...rest] = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
            return { id: id.trim(), label: rest.join(line.includes('\t') ? '\t' : ' ').trim() || id.trim() };
        })
        .filter((m) => m.id);
}

// `agy models` hits the network; auth and model listing share one spawn per probe.
function modelsProbe(ctx) {
    const key = 'agy:models';
    if (!ctx.cache.has(key)) ctx.cache.set(key, runProbe(runtime, ctx, ['models']));
    return ctx.cache.get(key);
}

async function version(ctx) {
    const result = await runProbe(runtime, ctx, ['--version']);
    if (!result.ok) return probeFailure(result, 'agy --version');
    const match = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout || '');
    return match
        ? { ok: true, version: match[1], raw: result.stdout.trim() }
        : { ok: false, code: 'SQUAD_RUNTIME_PARSE_FAILED', reason: 'agy --version output not recognized' };
}

async function authStatus(ctx) {
    const result = await modelsProbe(ctx);
    const stderr = String(result.stderr || '');
    if (result.ok && parseModels(result.stdout).length > 0) {
        const apiKey = typeof ctx.env.GEMINI_API_KEY === 'string' && ctx.env.GEMINI_API_KEY.trim();
        return { state: 'authenticated', method: apiKey ? 'api-key' : 'inferred:models', evidence: 'agy models listed models' };
    }
    if (/please sign in|authentication required|not signed in/i.test(stderr)) {
        return { state: 'unauthenticated', method: null, evidence: stderr.trim().split(/\r?\n/).pop(),
            fix: 'chạy agy không tham số để đăng nhập' };
    }
    if (/keyring is locked/i.test(stderr)) {
        return { state: 'unknown', method: null, evidence: 'secret keyring is locked', fix: 'mở khóa keyring của hệ điều hành' };
    }
    if (result.timedOut || result.error_code === 'TIMEOUT') {
        return { state: 'unknown', method: null, evidence: 'agy models timed out' };
    }
    return { state: 'unknown', method: null, evidence: stderr.trim().slice(0, 200) || 'agy models gave no models' };
}

async function listModels(ctx) {
    const result = await modelsProbe(ctx);
    if (!result.ok) return probeFailure(result, 'agy models');
    const models = parseModels(result.stdout).map((m) => ({
        id: m.id,
        label: m.label,
        family: modelFamily(m.id),
        efforts: [...EFFORTS],
        defaultEffort: null,
    }));
    return { ok: true, source: 'cli', models };
}

function buildHeadless(rawTurn, ctx) {
    const turn = parseTurn(rawTurn, runtime);
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    const args = [
        ...prefixArgs,
        '-p', turn.prompt,
        '--output-format', turn.outputFormat,
        '--model', turn.model,
        ...(turn.effort ? ['--effort', turn.effort] : []),
        ...permissionFlags(turn.permission, turn),
        // agy ignores the shell cwd unless the directory is added explicitly.
        '--add-dir', turn.cwd,
        ...turn.addDirs.flatMap((dir) => ['--add-dir', dir]),
        ...(turn.jsonSchemaPath ? ['--json-schema', turn.jsonSchemaPath] : []),
        '--print-timeout', `${printTimeoutSeconds(turn.timeoutMs)}s`,
    ];
    return invocation({ command, args, cwd: turn.cwd, timeoutMs: turn.timeoutMs, prompt: turn.prompt });
}

function buildResume(sessionRef, rawTurn, ctx) {
    assertSessionRef(sessionRef);
    const base = buildHeadless(rawTurn, ctx);
    const prompt = parseTurn(rawTurn, runtime).prompt;
    return invocation({ command: base.command, args: [...base.args, '--conversation', sessionRef],
        cwd: base.cwd, timeoutMs: base.timeoutMs, prompt });
}

function interactiveCommand(binding = {}, ctx) {
    const { model, effort, cwd } = binding;
    if (typeof model !== 'string' || !model.trim() || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'interactiveCommand needs a model and an absolute cwd');
    }
    if (effort !== undefined && !EFFORTS.includes(effort)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', `Effort "${effort}" is not supported by agy`);
    }
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    return invocation({ command, args: [...prefixArgs, '--model', model, ...(effort ? ['--effort', effort] : []), '--add-dir', cwd],
        cwd, timeoutMs: 0 });
}

const runtime = defineRuntime({
    id: 'agy',
    displayName: 'Antigravity CLI',
    binary: { name: 'agy', envOverride: 'OMNI_AGY_PATH', extraCandidates },
    capabilities: {
        interactive: true, mcp: true, hooks: true, headless: true, write: true, resume: true,
        structuredOutput: true, transcript: false, sandbox: true, usage: true, multiModel: true,
    },
    efforts: EFFORTS,
    version,
    authStatus,
    listModels,
    buildHeadless,
    buildResume,
    interactiveCommand,
    permissionFlags,
});

module.exports = runtime;
