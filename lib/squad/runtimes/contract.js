'use strict';

// Runtime adapter contract (SPEC-SQUAD-P1 §2). An adapter describes one agent
// CLI: how to find it, how to probe it, and how to build invocations for it.
// Adapters never spawn real work — runners with lease/watchdog/scope-guard do.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { z } = require('zod');

class SquadRuntimeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SquadRuntimeError';
        this.code = code;
        this.details = details;
    }
}

const CAPABILITY_KEYS = Object.freeze([
    'interactive', 'mcp', 'hooks', 'headless', 'write', 'resume',
    'structuredOutput', 'transcript', 'sandbox', 'usage', 'multiModel',
]);

// capability flag → method that must exist when the flag is true
const CAPABILITY_METHODS = Object.freeze({
    resume: 'buildResume',
    interactive: 'interactiveCommand',
    transcript: 'readTranscript',
});

const PERMISSIONS = Object.freeze(['read-only', 'workspace-write', 'full-auto']);
const MAX_PROMPT_BYTES = 256 * 1024;
const SESSION_REF = /^[A-Za-z0-9._:-]{1,128}$/;

const fn = z.custom((value) => typeof value === 'function', { message: 'expected a function' });
const optionalFn = fn.optional();

const DescriptorSchema = z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    displayName: z.string().trim().min(1),
    binary: z.object({
        name: z.string().regex(/^[A-Za-z0-9._-]+$/),
        envOverride: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        extraCandidates: optionalFn,
    }).strict(),
    capabilities: z.object(Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, z.boolean()]))).strict(),
    efforts: z.array(z.string().regex(/^[a-z]+$/)).min(1).nullable(),
    detect: optionalFn,
    version: fn,
    authStatus: fn,
    listModels: fn,
    buildHeadless: fn,
    parseResult: optionalFn,
    buildResume: optionalFn,
    interactiveCommand: optionalFn,
    permissionFlags: fn,
    mountSkills: optionalFn,
    skillDirs: optionalFn,
    userSkillDirs: optionalFn,
    userInstructionFiles: optionalFn,
    writeMcpConfig: optionalFn,
    readTranscript: optionalFn,
}).strict();

function defineRuntime(descriptor) {
    const parsed = DescriptorSchema.safeParse(descriptor);
    if (!parsed.success) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_INVALID_DESCRIPTOR',
            `Invalid runtime descriptor: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    for (const [capability, method] of Object.entries(CAPABILITY_METHODS)) {
        if (descriptor.capabilities[capability] && typeof descriptor[method] !== 'function') {
            throw new SquadRuntimeError('SQUAD_RUNTIME_INVALID_DESCRIPTOR',
                `Runtime ${descriptor.id} declares ${capability} but has no ${method}()`);
        }
    }
    // A headless runtime must also say how to read what a turn produced (SPEC-SQUAD-P3 §4.1).
    if (descriptor.capabilities.headless && typeof descriptor.parseResult !== 'function') {
        throw new SquadRuntimeError('SQUAD_RUNTIME_INVALID_DESCRIPTOR',
            `Runtime ${descriptor.id} declares headless but has no parseResult()`);
    }
    // A runtime that says where it reads skills must also be able to mount them there.
    if ((typeof descriptor.skillDirs === 'function') !== (typeof descriptor.mountSkills === 'function')) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_INVALID_DESCRIPTOR',
            `Runtime ${descriptor.id} must declare skillDirs() and mountSkills() together`);
    }
    return Object.freeze({
        ...descriptor,
        binary: Object.freeze({ ...descriptor.binary }),
        capabilities: Object.freeze({ ...descriptor.capabilities }),
        efforts: descriptor.efforts ? Object.freeze([...descriptor.efforts]) : null,
    });
}

const AbsolutePath = z.string().min(1).refine((value) => path.isAbsolute(value), { message: 'must be an absolute path' });

const HeadlessTurnSchema = z.object({
    prompt: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES,
        { message: `prompt exceeds ${MAX_PROMPT_BYTES} bytes` }),
    cwd: AbsolutePath,
    model: z.string().trim().min(1),
    effort: z.string().trim().min(1).optional(),
    permission: z.enum(PERMISSIONS),
    isolatedRoot: z.boolean().optional(),
    outputFormat: z.enum(['text', 'json']).optional(),
    jsonSchemaPath: AbsolutePath.optional(),
    addDirs: z.array(AbsolutePath).optional(),
    timeoutMs: z.number().int().positive(),
}).strict();

const isInside = (root, target) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Validates a turn for a runtime; returns a normalized copy or throws BAD_TURN.
function parseTurn(turn, runtime) {
    const parsed = HeadlessTurnSchema.safeParse(turn);
    if (!parsed.success) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN',
            `Invalid turn: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'turn'} ${i.message}`).join('; ')}`);
    }
    const value = { addDirs: [], outputFormat: 'json', ...parsed.data };
    if (value.effort !== undefined && (!runtime.efforts || !runtime.efforts.includes(value.effort))) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN',
            `Effort "${value.effort}" is not supported by ${runtime.id}`);
    }
    if (value.jsonSchemaPath && ![value.cwd, ...value.addDirs].some((root) => isInside(root, value.jsonSchemaPath))) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'jsonSchemaPath must be inside cwd or addDirs');
    }
    return value;
}

function assertSessionRef(sessionRef) {
    if (typeof sessionRef !== 'string' || !SESSION_REF.test(sessionRef)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', 'sessionRef must match /^[A-Za-z0-9._:-]{1,128}$/');
    }
}

function assertPermission(runtimeId, profile, opts = {}) {
    if (!PERMISSIONS.includes(profile)) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_BAD_TURN', `Unknown permission profile "${profile}"`);
    }
    if (profile === 'full-auto' && opts.isolatedRoot !== true) {
        throw new SquadRuntimeError('SQUAD_RUNTIME_UNSAFE_PERMISSION',
            `${runtimeId}: full-auto is only allowed inside an isolated worker root`);
    }
}

function redactPrompt(prompt) {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    const digest = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 12);
    return `<prompt:${bytes}B:${digest}>`;
}

// Binary to invoke: the detected one when available, else the bare name.
function binaryOf(runtime, ctx) {
    const resolved = ctx && ctx.resolved;
    if (resolved && resolved.found) return { command: resolved.command, prefixArgs: [...resolved.prefixArgs] };
    return { command: runtime.binary.name, prefixArgs: [] };
}

function invocation({ command, args, cwd, timeoutMs, prompt }) {
    const redacted = prompt === undefined ? [...args] : args.map((arg) => (arg === prompt ? redactPrompt(prompt) : arg));
    return Object.freeze({ command, args: Object.freeze([...args]), cwd, timeoutMs, redactedArgs: Object.freeze(redacted) });
}

function probeContext(ctx = {}) {
    return {
        env: ctx.env || process.env,
        homedir: ctx.homedir || os.homedir(),
        platform: ctx.platform || process.platform,
        execPath: ctx.execPath || process.execPath,
        fsImpl: ctx.fsImpl || fs,
        spawnImpl: ctx.spawnImpl,
        timeoutMs: ctx.timeoutMs || 15_000,
        maxOutputBytes: ctx.maxOutputBytes || 64 * 1024,
        cwd: ctx.cwd || os.tmpdir(),
        resolved: ctx.resolved,
        cache: ctx.cache || new Map(),
        prespawnGuard: ctx.prespawnGuard,
        signal: ctx.signal,
        includeHidden: ctx.includeHidden === true,
    };
}

module.exports = {
    SquadRuntimeError,
    CAPABILITY_KEYS,
    PERMISSIONS,
    MAX_PROMPT_BYTES,
    defineRuntime,
    parseTurn,
    assertSessionRef,
    assertPermission,
    redactPrompt,
    binaryOf,
    invocation,
    probeContext,
};
