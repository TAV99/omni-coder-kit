'use strict';

// Codex CLI adapter (SPEC-SQUAD-P1 §3–§5). Flags verified against codex-cli
// 0.147.0 (spec appendix V1–V3): `exec resume` has no -C/-s/--add-dir, so
// resume sets the sandbox through `-c` and takes its cwd from the process.

const path = require('node:path');
const {
    SquadRuntimeError, defineRuntime, parseTurn, assertSessionRef, assertPermission, binaryOf, invocation,
} = require('./contract');
const { modelFamily } = require('./families');
const { runProbe, probeFailure } = require('./probe');
const { userBinCandidates } = require('./install-paths');
const { mountBundle } = require('../mount');
const { parseJsonObject, settle } = require('./result');
const { readCodexTranscript } = require('./transcript');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MAX_CACHE_BYTES = 1024 * 1024;

function codexHome(ctx) {
    const pathApi = ctx.platform === 'win32' ? path.win32 : path.posix;
    const fromEnv = typeof ctx.env.CODEX_HOME === 'string' && ctx.env.CODEX_HOME.trim();
    return fromEnv || pathApi.join(ctx.env.USERPROFILE && ctx.platform === 'win32' ? ctx.env.USERPROFILE : ctx.homedir, '.codex');
}

function extraCandidates(ctx) {
    if (ctx.platform === 'win32') {
        const list = [path.win32.join(codexHome(ctx), 'packages', 'standalone', 'current', 'bin', 'codex.exe')];
        if (ctx.env.APPDATA) list.push(path.win32.join(ctx.env.APPDATA, 'npm', 'codex.cmd'));
        return list;
    }
    return [
        ...userBinCandidates('codex', ctx.homedir),
        path.posix.join(codexHome(ctx), 'packages', 'standalone', 'current', 'bin', 'codex'),
    ];
}

function effortConfig(effort) {
    return effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
}

function permissionFlags(profile, opts = {}) {
    assertPermission('codex', profile, opts);
    if (profile === 'full-auto') return ['--dangerously-bypass-approvals-and-sandbox'];
    return ['-s', profile];
}

// `exec resume` has no -s; the sandbox goes through config overrides instead.
function resumeSandbox(profile, opts, addDirs) {
    assertPermission('codex', profile, opts);
    if (profile === 'full-auto') return ['--dangerously-bypass-approvals-and-sandbox'];
    const flags = ['-c', `sandbox_mode="${profile}"`];
    if (addDirs.length) flags.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(addDirs)}`);
    return flags;
}

async function version(ctx) {
    const result = await runProbe(runtime, ctx, ['--version']);
    if (!result.ok) return probeFailure(result, 'codex --version');
    const match = /codex-cli\s+(\d+\.\d+\.\d+\S*)/.exec(result.stdout || '');
    return match
        ? { ok: true, version: match[1], raw: result.stdout.trim() }
        : { ok: false, code: 'SQUAD_RUNTIME_PARSE_FAILED', reason: 'codex --version output not recognized' };
}

async function authStatus(ctx) {
    const result = await runProbe(runtime, ctx, ['login', 'status']);
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.code === 0 && /Logged in/i.test(text)) {
        const method = /using\s+(.+?)\s*$/im.exec(text);
        return { state: 'authenticated', method: method ? method[1] : null, evidence: text.trim().split(/\r?\n/)[0] };
    }
    if (/Not logged in/i.test(text)) {
        return { state: 'unauthenticated', method: null, evidence: 'Not logged in', fix: 'chạy: codex login' };
    }
    if (result.timedOut || result.error_code === 'TIMEOUT') {
        return { state: 'unknown', method: null, evidence: 'codex login status timed out' };
    }
    return { state: 'unknown', method: null, evidence: text.trim().slice(0, 200) || 'codex login status gave no output' };
}

async function listModels(ctx) {
    const cachePath = (ctx.platform === 'win32' ? path.win32 : path.posix).join(codexHome(ctx), 'models_cache.json');
    let raw;
    try {
        const stat = ctx.fsImpl.statSync(cachePath);
        if (stat.size > MAX_CACHE_BYTES) {
            return { ok: false, code: 'SQUAD_RUNTIME_PARSE_FAILED', reason: 'models_cache.json is larger than 1 MiB' };
        }
        raw = ctx.fsImpl.readFileSync(cachePath, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return { ok: true, source: 'none', models: [], note: 'chạy codex một lần để tạo cache' };
        }
        return { ok: false, code: 'SQUAD_RUNTIME_PROBE_FAILED', reason: `cannot read models_cache.json: ${error.message}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, code: 'SQUAD_RUNTIME_PARSE_FAILED', reason: 'models_cache.json is not valid JSON' };
    }
    if (!parsed || !Array.isArray(parsed.models)) {
        return { ok: false, code: 'SQUAD_RUNTIME_PARSE_FAILED', reason: 'models_cache.json has no models array' };
    }
    const models = parsed.models
        // Hidden models are still callable; the dual daemon probe accepts them (SPEC-SQUAD-P3 §4.3).
        .filter((m) => m && typeof m.slug === 'string' && (m.visibility === 'list' || ctx.includeHidden === true))
        .map((m) => {
            const efforts = Array.isArray(m.supported_reasoning_levels)
                ? m.supported_reasoning_levels.map((l) => l && l.effort).filter((e) => typeof e === 'string')
                : [];
            return {
                id: m.slug,
                label: typeof m.display_name === 'string' ? m.display_name : m.slug,
                family: modelFamily(m.slug),
                efforts: efforts.length ? efforts : null,
                defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
            };
        });
    return { ok: true, source: 'cache', models };
}

function buildHeadless(rawTurn, ctx) {
    const turn = parseTurn(rawTurn, runtime);
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    const args = [
        ...prefixArgs, 'exec', '--skip-git-repo-check',
        ...(turn.outputFormat === 'json' ? ['--json'] : []),
        '-C', turn.cwd,
        '-m', turn.model,
        ...effortConfig(turn.effort),
        ...permissionFlags(turn.permission, turn),
        ...isolationConfig(turn),
        ...turn.addDirs.flatMap((dir) => ['--add-dir', dir]),
        ...(turn.jsonSchemaPath ? ['--output-schema', turn.jsonSchemaPath] : []),
        turn.prompt,
    ];
    return invocation({ command, args, cwd: turn.cwd, timeoutMs: turn.timeoutMs, prompt: turn.prompt });
}

function buildResume(sessionRef, rawTurn, ctx) {
    assertSessionRef(sessionRef);
    const turn = parseTurn(rawTurn, runtime);
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    const args = [
        ...prefixArgs, 'exec', 'resume', '--skip-git-repo-check', sessionRef, turn.prompt,
        ...(turn.outputFormat === 'json' ? ['--json'] : []),
        '-m', turn.model,
        ...effortConfig(turn.effort),
        ...resumeSandbox(turn.permission, turn, turn.addDirs),
        ...isolationConfig(turn),
        ...(turn.jsonSchemaPath ? ['--output-schema', turn.jsonSchemaPath] : []),
    ];
    return invocation({ command, args, cwd: turn.cwd, timeoutMs: turn.timeoutMs, prompt: turn.prompt });
}

// `session.resumeId` reopens a TUI session (`codex resume <id>`, V43); codex
// cannot pin the id of a new one, so `session.newId` is not accepted.
function interactiveCommand(binding = {}, ctx) {
    const { model, effort, cwd, session = {} } = binding;
    if (typeof model !== 'string' || !model.trim() || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'interactiveCommand needs a model and an absolute cwd');
    }
    if (effort !== undefined && !EFFORTS.includes(effort)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', `Effort "${effort}" is not supported by codex`);
    }
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    if (session.newId !== undefined) throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'codex cannot pin a new session id');
    if (session.resumeId !== undefined) assertSessionRef(session.resumeId);
    const resume = session.resumeId ? ['resume', session.resumeId] : [];
    return invocation({ command, args: [...prefixArgs, ...resume, '-m', model, ...effortConfig(effort), '-C', cwd], cwd, timeoutMs: 0 });
}

// codex exec --json prints JSONL events. With --output-schema the payload is the
// last agent_message's text, itself a JSON string (V3).
function parseResult(raw, opts = {}) {
    let sessionRef = null;
    let message = null;
    let usage = null;
    let status = 'unknown';
    let sawEvent = false;
    for (const line of String(raw.stdout || '').split(/\r?\n/)) {
        const event = line.trim() ? parseJsonObject(line.trim()) : null;
        if (!event || typeof event.type !== 'string') continue;
        sawEvent = true;
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionRef = event.thread_id;
        else if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message'
            && typeof event.item.text === 'string') message = event.item.text;
        else if (event.type === 'turn.completed') {
            status = 'succeeded';
            const u = event.usage || {};
            usage = { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null,
                thinkingTokens: u.reasoning_output_tokens ?? null };
        } else if (event.type === 'turn.failed' || event.type === 'error') status = 'failed';
    }
    if (!sawEvent) return settle(raw, { malformed: true }, opts);
    return settle(raw, { status, sessionRef, usage, payload: message === null ? null : parseJsonObject(message.trim()) }, opts);
}

// In an isolated worker root, an empty project_root_markers keeps codex from
// walking up to the parent repo's .agents/skills, AGENTS.md and .codex/config.toml
// (SPEC-SQUAD-P2 §6.4, verified V9).
function isolationConfig(turn) {
    return turn.isolatedRoot === true ? ['-c', 'project_root_markers=[]'] : [];
}

// Workspace skills: both codex and agy read <root>/.agents/skills (SPEC-SQUAD-P2 §6.2, F1/F2).
const SKILL_DIRS = Object.freeze(['.agents/skills']);

function mountSkills({ store, root, skills, roleId, now, deterministic }) {
    return mountBundle({ store, root, skillDir: SKILL_DIRS[0], skills, roleId, now, deterministic });
}

// Per-user skill dirs every role on this CLI sees; they cannot be isolated (F6).
function userSkillDirs(ctx) {
    const pathApi = ctx.platform === 'win32' ? path.win32 : path.posix;
    return [pathApi.join(ctx.homedir, '.agents', 'skills'), pathApi.join(codexHome(ctx), 'skills')];
}

const runtime = defineRuntime({
    id: 'codex',
    displayName: 'Codex CLI',
    binary: { name: 'codex', envOverride: 'OMNI_CODEX_PATH', extraCandidates },
    capabilities: {
        interactive: true, mcp: true, hooks: true, headless: true, write: true, resume: true,
        structuredOutput: true, transcript: true, sandbox: true, usage: false, multiModel: false,
    },
    efforts: EFFORTS,
    version,
    authStatus,
    listModels,
    buildHeadless,
    buildResume,
    parseResult,
    interactiveCommand,
    readTranscript: readCodexTranscript,
    permissionFlags,
    skillDirs: () => [...SKILL_DIRS],
    mountSkills,
    userSkillDirs,
});

module.exports = runtime;
