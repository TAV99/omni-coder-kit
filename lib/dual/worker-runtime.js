'use strict';

// Headless worker turns per runtime (SPEC-SQUAD-P3 §4.4). The worker slot keeps
// its internal id 'agy' (P3b); the runtime bound to it decides the argv and how
// the reply is read. agy keeps its legacy argv; codex and claude (SPEC-SQUAD-P4 §4)
// go through their adapters.

const fs = require('node:fs');
const os = require('node:os');
const { z } = require('zod');
const codexRuntime = require('../squad/runtimes/codex');
const claudeRuntime = require('../squad/runtimes/claude');
const { strictJsonSchema, stripNullOptionals } = require('../squad/runtimes/strict-schema');
const { modelAvailable, classifyRuntimeFailure } = require('../squad/runtimes/contract');
const { resolveCodexPath, resolveClaudeCommand } = require('./binary-paths');
const { DualAgyRunnerError, buildAgyInvocation, workerPhasePrompt } = require('./agy-runner');
const { DualAgyOutputError, extractAgyPayload, validatePayload } = require('./agy-output');

const WORKER_RUNTIMES = Object.freeze(['agy', 'codex', 'claude']);
const ADAPTERS = Object.freeze({ codex: codexRuntime, claude: claudeRuntime });
// 'model-default' (agy-model) means: pass no effort and let the model decide.
const effortOf = (value) => (typeof value === 'string' && value.trim() && value.trim() !== 'model-default' ? value.trim() : undefined);

function assertWorkerRuntime(runtime) {
    if (!WORKER_RUNTIMES.includes(runtime)) {
        throw new DualAgyRunnerError('DUAL_WORKER_RUNTIME_UNSUPPORTED',
            `Worker runtime "${runtime}" is not supported by the dual engine (supported: ${WORKER_RUNTIMES.join(', ')})`);
    }
    return runtime;
}

// Command and prefix args that start the bound worker CLI.
function workerCommandFor(runtime, { agyCommand = 'agy', agyPrefixArgs = [], workerCommand, workerPrefixArgs } = {}) {
    if (assertWorkerRuntime(runtime) === 'agy') return { command: agyCommand, prefixArgs: agyPrefixArgs };
    if (workerCommand) return { command: workerCommand, prefixArgs: workerPrefixArgs || [] };
    return runtime === 'claude' ? resolveClaudeCommand() : { command: resolveCodexPath() || 'codex', prefixArgs: workerPrefixArgs || [] };
}

// codex --output-schema runs in strict mode (V17); claude --json-schema does not
// (V24). agy's toolAction/toolSummary extras are an agy convention and stay out.
function workerOutputSchema(runtime, schemaObj) {
    if (assertWorkerRuntime(runtime) === 'agy') return schemaObj;
    const { toolAction, toolSummary, ...properties } = schemaObj.properties || {};
    const schema = { ...schemaObj, properties,
        ...(Array.isArray(schemaObj.required) ? { required: schemaObj.required.filter((key) => key in properties) } : {}) };
    return runtime === 'codex' ? strictJsonSchema(schema) : schema;
}

function buildWorkerInvocation({ runtime, isolatedRoot = false, ...args }) {
    if (assertWorkerRuntime(runtime) === 'agy') return buildAgyInvocation(args);
    const prompt = workerPhasePrompt({ ...args, runtime });
    const { command, prefixArgs } = workerCommandFor(runtime, args);
    let invocation;
    try {
        invocation = ADAPTERS[runtime].buildHeadless({
            prompt, cwd: args.repoRoot, model: args.model.trim(),
            ...(effortOf(args.effort) ? { effort: effortOf(args.effort) } : {}),
            // Writes only inside the worker's own git root; shared mode stays sandboxed to the repo.
            permission: args.phase === 'implement' ? (isolatedRoot ? 'full-auto' : 'workspace-write') : 'read-only',
            isolatedRoot, jsonSchemaPath: args.schemaPath, timeoutMs: args.timeoutMs,
        }, { resolved: { found: true, command, prefixArgs } });
    } catch (cause) {
        throw new DualAgyRunnerError('DUAL_WORKER_CONFIG_MISSING', cause.message, { cause });
    }
    return { command: invocation.command, args: [...invocation.args], cwd: invocation.cwd,
        timeoutMs: invocation.timeoutMs, redactedArgs: [...invocation.args] };
}

// Same error codes as the agy path so the orchestrator's retry rules apply unchanged.
const CODEX_ERRORS = Object.freeze({
    SQUAD_RUNTIME_EXIT_NONZERO: ['DUAL_AGY_EXIT_NONZERO', 'Worker process exited unsuccessfully'],
    SQUAD_RUNTIME_TURN_FAILED: ['DUAL_AGY_EXIT_NONZERO', 'Worker turn failed'],
    SQUAD_RUNTIME_OUTPUT_MALFORMED: ['DUAL_AGY_OUTPUT_MALFORMED', 'Worker output is not the CLI JSON format'],
    SQUAD_RUNTIME_TURN_UNFINISHED: ['DUAL_AGY_OUTPUT_MALFORMED', 'Worker turn did not complete'],
    SQUAD_RUNTIME_DENIED_ACTIONS: ['DUAL_AGY_EXIT_NONZERO', 'Worker tool actions were denied'],
    SQUAD_RUNTIME_TIMEOUT: ['DUAL_AGY_TIMEOUT', 'Worker timed out'],
});

function extractWorkerPayload(runtime, result, schema) {
    if (assertWorkerRuntime(runtime) === 'agy') return extractAgyPayload(result, schema);
    if (result.exitCode === 0 && (typeof result.stdout !== 'string' || !result.stdout.trim())) {
        throw new DualAgyOutputError('DUAL_AGY_EMPTY_OUTPUT', 'Worker process returned empty output');
    }
    const parsed = ADAPTERS[runtime].parseResult(result, {});
    if (parsed.completion !== 'succeeded') {
        const [code, message] = CODEX_ERRORS[parsed.errorCode] || ['DUAL_AGY_OUTPUT_MALFORMED', 'Worker output was not usable'];
        throw new DualAgyOutputError(code, message);
    }
    if (parsed.payload === null) {
        throw new DualAgyOutputError('DUAL_AGY_OUTPUT_MALFORMED', 'Worker reply did not contain a JSON payload');
    }
    // Strict mode sent optional fields back as null; drop them before the zod contract.
    const payload = stripNullOptionals(parsed.payload, z.toJSONSchema(schema, { unrepresentable: 'any' }));
    return { payload: validatePayload(payload, schema), extractionMode: `${runtime}_output_schema`, warnings: [] };
}

// Version and model probe for a codex or claude worker through its adapter:
// codex reads its model cache (hidden models included; a missing cache leaves
// the version to decide), claude lists aliases and takes any full claude-… id.
async function probeAdapterWorker({ runtime = 'codex', command, prefixArgs = [], cwd, env = process.env, spawnImpl, model }) {
    const adapter = ADAPTERS[runtime];
    const ctx = { spawnImpl, env, cwd, timeoutMs: runtime === 'claude' ? 60_000 : 15_000, maxOutputBytes: 64 * 1024,
        platform: process.platform, homedir: os.homedir(), fsImpl: fs, cache: new Map(), includeHidden: true,
        resolved: { found: true, command, prefixArgs: [...prefixArgs] } };
    const version = await adapter.version(ctx);
    if (!version.ok) {
        return { ok: false, code: version.code === 'SQUAD_RUNTIME_PARSE_FAILED' ? 'DUAL_PREFLIGHT_AGY_VERSION_INVALID' : 'DUAL_PREFLIGHT_AGY_MISSING',
            message: 'Worker CLI is not available or failed --version check', cause: version.reason };
    }
    const listed = await adapter.listModels(ctx);
    if (!modelAvailable(listed, model)) {
        return { ok: false, code: 'DUAL_PREFLIGHT_MODEL_UNAVAILABLE',
            message: `Failed to query models or model ${model} is not available`, cause: listed.reason || 'required exact model missing' };
    }
    return { ok: true, version: version.version };
}

// SPEC-SQUAD-P7 §6.1: rate_limited | auth_expired | other for one finished
// worker turn. agy has no adapter classifier (V37 not observed) → 'other'.
function classifyWorkerFailure(runtime, result) {
    if (!WORKER_RUNTIMES.includes(runtime) || !result || result.timedOut) return { kind: 'other' };
    return classifyRuntimeFailure(ADAPTERS[runtime], result);
}

module.exports = {
    WORKER_RUNTIMES, assertWorkerRuntime, workerCommandFor, workerOutputSchema,
    buildWorkerInvocation, extractWorkerPayload, probeAdapterWorker, classifyWorkerFailure,
    probeCodexWorker: (options) => probeAdapterWorker({ ...options, runtime: 'codex' }),
};
