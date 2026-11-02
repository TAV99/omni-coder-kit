'use strict';

// Claude Code CLI adapter (SPEC-SQUAD-P4 §2–§3). Behaviour verified against
// claude 2.1.316 (spec appendix A, V22–V31, R1–R3): permission modes do not
// limit tools reliably, so profiles are enforced with an explicit --tools list;
// --json-schema takes the schema text, not a path; `-p /model` lists aliases.

const fs = require('node:fs');
const path = require('node:path');
const {
    SquadRuntimeError, defineRuntime, parseTurn, assertSessionRef, assertPermission, binaryOf, invocation,
} = require('./contract');
const { runProbe, probeFailure } = require('./probe');
const { userBinCandidates } = require('./install-paths');
const { mountBundle } = require('../mount');
const { parseJsonObject, settle } = require('./result');
const { readClaudeTranscript } = require('./transcript');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_SCHEMA_BYTES = 64 * 1024;
const READ_TOOLS = 'Read,Grep,Glob,Skill';
const STATIC_MODELS = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);

function claudeHome(ctx) {
    const pathApi = ctx.platform === 'win32' ? path.win32 : path.posix;
    const fromEnv = typeof ctx.env.CLAUDE_CONFIG_DIR === 'string' && ctx.env.CLAUDE_CONFIG_DIR.trim();
    return fromEnv || pathApi.join(ctx.homedir, '.claude');
}

function extraCandidates(ctx) {
    if (ctx.platform === 'win32') {
        const list = [path.win32.join(ctx.env.USERPROFILE || ctx.homedir, '.local', 'bin', 'claude.exe')];
        if (ctx.env.APPDATA) list.push(path.win32.join(ctx.env.APPDATA, 'npm', 'claude.cmd'));
        return list;
    }
    return [...userBinCandidates('claude', ctx.homedir), path.posix.join(claudeHome(ctx), 'local', 'claude')];
}

// Every profile runs with --permission-prompts none: anything that would ask is refused.
function permissionFlags(profile, opts = {}) {
    assertPermission('claude', profile, opts);
    if (profile === 'read-only') return ['--tools', READ_TOOLS, '--permission-prompts', 'none'];
    if (profile === 'workspace-write') {
        return ['--permission-mode', 'acceptEdits', '--tools', `${READ_TOOLS},Edit,Write`, '--permission-prompts', 'none'];
    }
    return ['--permission-mode', 'bypassPermissions', '--permission-prompts', 'none'];
}

function effortArgs(effort) {
    return effort ? ['--effort', effort] : [];
}

// claude reads CLAUDE.md from cwd up to the filesystem root, past the git root (C9).
// In an isolated worker root every ancestor's memory files are excluded; skills and
// .claude/settings.json already stop at the worker's own git root (V26, R3). The
// worker root is a copy of the project, so its own .claude/settings.json may carry
// the orchestrator's hooks: disableAllHooks turns them off (V32).
// TODO(win32): claudeMdExcludes globs are untested with drive-letter paths.
function isolationFlags(turn) {
    if (turn.isolatedRoot !== true) return [];
    const excludes = [];
    for (let dir = path.dirname(turn.cwd); ; dir = path.dirname(dir)) {
        excludes.push(path.join(dir, 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'), path.join(dir, '.claude', 'rules', '**'));
        if (path.dirname(dir) === dir) break;
    }
    return ['--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true, claudeMdExcludes: excludes })];
}

function schemaArgs(turn, ctx) {
    if (!turn.jsonSchemaPath) return [];
    const fsImpl = (ctx && ctx.fsImpl) || fs;
    let text;
    try {
        text = String(fsImpl.readFileSync(turn.jsonSchemaPath, 'utf8'));
    } catch (error) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', `cannot read jsonSchemaPath: ${error.message}`);
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_SCHEMA_BYTES) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', `jsonSchemaPath exceeds ${MAX_SCHEMA_BYTES} bytes`);
    }
    // Re-serialize so the argv carries one compact line of valid JSON.
    const schema = parseJsonObject(text);
    if (!schema) throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'jsonSchemaPath is not a JSON object');
    return ['--json-schema', JSON.stringify(schema)];
}

async function version(ctx) {
    const result = await runProbe(runtime, ctx, ['--version']);
    if (!result.ok) return probeFailure(result, 'claude --version');
    const match = /(\d+\.\d+\.\d+\S*)\s+\(Claude Code\)/.exec(result.stdout || '');
    return match
        ? { ok: true, version: match[1], raw: result.stdout.trim() }
        : { ok: false, code: 'SQUAD_RUNTIME_PARSE_FAILED', reason: 'claude --version output not recognized' };
}

async function authStatus(ctx) {
    const result = await runProbe(runtime, ctx, ['auth', 'status']);
    if (result.timedOut || result.error_code === 'TIMEOUT') {
        return { state: 'unknown', method: null, evidence: 'claude auth status timed out' };
    }
    const status = parseJsonObject(String(result.stdout || '').trim());
    if (status && status.loggedIn === true) {
        const method = typeof status.authMethod === 'string' ? status.authMethod : null;
        return { state: 'authenticated', method, evidence: `claude auth status: logged in${method ? ` via ${method}` : ''}` };
    }
    if (status && status.loggedIn === false) {
        return { state: 'unauthenticated', method: null, evidence: 'claude auth status: not logged in', fix: 'chạy: claude auth login' };
    }
    const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    return { state: 'unknown', method: null, evidence: text.slice(0, 200) || 'claude auth status gave no output' };
}

// `claude -p /model` is a local command: it prints the alias list without calling a model (V31).
function parseModelAliases(text) {
    const match = /Available:\s*(.+?)(?:,?\s*or a full model ID)?\.?\s*$/im.exec(String(text || ''));
    if (!match) return [];
    return match[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(s));
}

const modelEntry = (id) => ({ id, label: id, family: 'anthropic', efforts: [...EFFORTS], defaultEffort: null });

async function listModels(ctx) {
    const result = await runProbe(runtime, ctx, ['-p', '/model', '--output-format', 'json', '--model', 'haiku',
        '--permission-prompts', 'none']);
    const envelope = result.ok ? parseJsonObject(String(result.stdout || '').trim()) : null;
    const aliases = envelope && typeof envelope.result === 'string' ? parseModelAliases(envelope.result) : [];
    if (aliases.length) {
        return { ok: true, source: 'cli', models: aliases.map(modelEntry), fullIdPrefix: 'claude-', note: 'tên đủ claude-… cũng dùng được' };
    }
    return { ok: true, source: 'static', models: STATIC_MODELS.map(modelEntry), fullIdPrefix: 'claude-',
        note: `claude -p /model không cho danh sách${result.ok ? '' : ` (${probeFailure(result, 'claude -p /model').reason})`}; tên đủ claude-… cũng dùng được` };
}

function headlessArgs(turn, ctx) {
    return [
        '-p', turn.prompt,
        '--output-format', turn.outputFormat,
        '--model', turn.model,
        ...effortArgs(turn.effort),
        ...permissionFlags(turn.permission, turn),
        ...isolationFlags(turn),
        ...turn.addDirs.flatMap((dir) => ['--add-dir', dir]),
        ...schemaArgs(turn, ctx),
    ];
}

function buildHeadless(rawTurn, ctx) {
    const turn = parseTurn(rawTurn, runtime);
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    return invocation({ command, args: [...prefixArgs, ...headlessArgs(turn, ctx)],
        cwd: turn.cwd, timeoutMs: turn.timeoutMs, prompt: turn.prompt });
}

function buildResume(sessionRef, rawTurn, ctx) {
    assertSessionRef(sessionRef);
    const turn = parseTurn(rawTurn, runtime);
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    return invocation({ command, args: [...prefixArgs, ...headlessArgs(turn, ctx), '--resume', sessionRef],
        cwd: turn.cwd, timeoutMs: turn.timeoutMs, prompt: turn.prompt });
}

// `session` (omni ui, SPEC-SQUAD-P6 §5): `{ newId }` pins the id of a fresh
// session so its transcript is known (V41); `{ resumeId }` reopens one (V43).
function interactiveCommand(binding = {}, ctx) {
    const { model, effort, cwd, session = {} } = binding;
    if (typeof model !== 'string' || !model.trim() || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'interactiveCommand needs a model and an absolute cwd');
    }
    if (effort !== undefined && !EFFORTS.includes(effort)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', `Effort "${effort}" is not supported by claude`);
    }
    const { command, prefixArgs } = binaryOf(runtime, ctx);
    if (session.newId !== undefined) assertSessionRef(session.newId);
    if (session.resumeId !== undefined) assertSessionRef(session.resumeId);
    const sessionArgs = session.resumeId ? ['--resume', session.resumeId] : session.newId ? ['--session-id', session.newId] : [];
    return invocation({ command, args: [...prefixArgs, '--model', model, ...effortArgs(effort), ...sessionArgs], cwd, timeoutMs: 0 });
}

// claude -p --output-format json prints one `type: "result"` object (V23). With
// --tools a missing tool is simply absent, so permission_denials is usually empty (C14).
function parseResult(raw, opts = {}) {
    const envelope = parseJsonObject(String(raw.stdout || '').trim());
    if (!envelope || envelope.type !== 'result') return settle(raw, { malformed: true }, opts);
    const u = envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : null;
    const usage = u ? {
        inputTokens: u.input_tokens ?? null,
        outputTokens: u.output_tokens ?? null,
        thinkingTokens: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) ?? null,
    } : null;
    const payload = envelope.structured_output && typeof envelope.structured_output === 'object'
        ? envelope.structured_output
        : typeof envelope.result === 'string' ? parseJsonObject(envelope.result.trim()) : null;
    const failed = envelope.is_error === true || (typeof envelope.subtype === 'string' && envelope.subtype.startsWith('error'));
    const status = failed ? 'failed' : envelope.subtype === 'success' ? 'succeeded' : 'unknown';
    return settle(raw, {
        status, payload, usage,
        deniedActions: Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [],
        sessionRef: typeof envelope.session_id === 'string' ? envelope.session_id : null,
    }, opts);
}

// Project skills: claude reads <root>/.claude/skills up to the repository root (C10).
const SKILL_DIRS = Object.freeze(['.claude/skills']);

function mountSkills({ store, root, skills, roleId, now, deterministic }) {
    return mountBundle({ store, root, skillDir: SKILL_DIRS[0], skills, roleId, now, deterministic });
}

// Per-user skills every role on this CLI sees; they cannot be isolated (Q-P4-2).
function userSkillDirs(ctx) {
    const pathApi = ctx.platform === 'win32' ? path.win32 : path.posix;
    return [pathApi.join(claudeHome(ctx), 'skills')];
}

// Per-user memory every role on this CLI reads; it cannot be isolated (Q-P4-2).
function userInstructionFiles(ctx) {
    const pathApi = ctx.platform === 'win32' ? path.win32 : path.posix;
    return [pathApi.join(claudeHome(ctx), 'CLAUDE.md')];
}

const runtime = defineRuntime({
    id: 'claude',
    displayName: 'Claude Code',
    binary: { name: 'claude', envOverride: 'OMNI_CLAUDE_PATH', extraCandidates },
    capabilities: {
        interactive: true, mcp: true, hooks: true, headless: true, write: true, resume: true,
        structuredOutput: true, transcript: true, sandbox: true, usage: true, multiModel: false,
    },
    efforts: EFFORTS,
    version,
    authStatus,
    listModels,
    buildHeadless,
    buildResume,
    parseResult,
    interactiveCommand,
    readTranscript: readClaudeTranscript,
    permissionFlags,
    skillDirs: () => [...SKILL_DIRS],
    mountSkills,
    userSkillDirs,
    userInstructionFiles,
});

module.exports = runtime;
