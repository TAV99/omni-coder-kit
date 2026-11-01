'use strict';

// Headless worker turns per runtime (SPEC-SQUAD-P3 §4.4). The worker slot keeps
// its internal id 'agy' (P3b); the runtime bound to it decides the argv and how
// the reply is read. agy keeps its legacy argv; codex goes through its adapter.

const fs = require('node:fs');
const os = require('node:os');
const { z } = require('zod');
const codexRuntime = require('../squad/runtimes/codex');
const { strictJsonSchema, stripNullOptionals } = require('../squad/runtimes/strict-schema');
const { resolveCodexPath } = require('./binary-paths');
const { DualAgyRunnerError, buildAgyInvocation, workerPhasePrompt } = require('./agy-runner');
const { DualAgyOutputError, extractAgyPayload, validatePayload } = require('./agy-output');

const WORKER_RUNTIMES = Object.freeze(['agy', 'codex']);

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
    return { command: workerCommand || resolveCodexPath() || 'codex', prefixArgs: workerPrefixArgs || [] };
}

// codex --output-schema runs in strict mode (V17); agy's toolAction/toolSummary
// extras are an agy convention and stay out of it.
function workerOutputSchema(runtime, schemaObj) {
    if (assertWorkerRuntime(runtime) === 'agy') return schemaObj;
    const { toolAction, toolSummary, ...properties } = schemaObj.properties || {};
    return strictJsonSchema({ ...schemaObj, properties,
        ...(Array.isArray(schemaObj.required) ? { required: schemaObj.required.filter((key) => key in properties) } : {}) });
}

function buildWorkerInvocation({ runtime, isolatedRoot = false, ...args }) {
    if (assertWorkerRuntime(runtime) === 'agy') return buildAgyInvocation(args);
    const prompt = workerPhasePrompt(args);
    const { command, prefixArgs } = workerCommandFor(runtime, args);
    let invocation;
    try {
        invocation = codexRuntime.buildHeadless({
            prompt, cwd: args.repoRoot, model: args.model.trim(),
            ...(typeof args.effort === 'string' && args.effort.trim() ? { effort: args.effort.trim() } : {}),
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
    SQUAD_RUNTIME_OUTPUT_MALFORMED: ['DUAL_AGY_OUTPUT_MALFORMED', 'Worker output is not codex JSONL'],
    SQUAD_RUNTIME_TURN_UNFINISHED: ['DUAL_AGY_OUTPUT_MALFORMED', 'Worker turn did not complete'],
    SQUAD_RUNTIME_DENIED_ACTIONS: ['DUAL_AGY_EXIT_NONZERO', 'Worker tool actions were denied'],
    SQUAD_RUNTIME_TIMEOUT: ['DUAL_AGY_TIMEOUT', 'Worker timed out'],
});

function extractWorkerPayload(runtime, result, schema) {
    if (assertWorkerRuntime(runtime) === 'agy') return extractAgyPayload(result, schema);
    if (result.exitCode === 0 && (typeof result.stdout !== 'string' || !result.stdout.trim())) {
        throw new DualAgyOutputError('DUAL_AGY_EMPTY_OUTPUT', 'Worker process returned empty output');
    }
    const parsed = codexRuntime.parseResult(result, {});
    if (parsed.completion !== 'succeeded') {
        const [code, message] = CODEX_ERRORS[parsed.errorCode] || ['DUAL_AGY_OUTPUT_MALFORMED', 'Worker output was not usable'];
        throw new DualAgyOutputError(code, message);
    }
    if (parsed.payload === null) {
        throw new DualAgyOutputError('DUAL_AGY_OUTPUT_MALFORMED', 'Worker reply did not contain a JSON payload');
    }
    // Strict mode sent optional fields back as null; drop them before the zod contract.
    const payload = stripNullOptionals(parsed.payload, z.toJSONSchema(schema, { unrepresentable: 'any' }));
    return { payload: validatePayload(payload, schema), extractionMode: 'codex_output_schema', warnings: [] };
}

// Version and model probe for a codex worker: `codex-cli X.Y.Z` plus the model
// cache (hidden models included; a missing cache leaves the version to decide).
async function probeCodexWorker({ command, prefixArgs = [], cwd, env = process.env, spawnImpl, model }) {
    const ctx = { spawnImpl, env, cwd, timeoutMs: 15_000, maxOutputBytes: 64 * 1024, platform: process.platform,
        homedir: os.homedir(), fsImpl: fs, cache: new Map(), includeHidden: true,
        resolved: { found: true, command, prefixArgs: [...prefixArgs] } };
    const version = await codexRuntime.version(ctx);
    if (!version.ok) {
        return { ok: false, code: version.code === 'SQUAD_RUNTIME_PARSE_FAILED' ? 'DUAL_PREFLIGHT_AGY_VERSION_INVALID' : 'DUAL_PREFLIGHT_AGY_MISSING',
            message: 'Worker CLI is not available or failed --version check', cause: version.reason };
    }
    const listed = await codexRuntime.listModels(ctx);
    if (!listed.ok || (listed.source !== 'none' && !listed.models.some((entry) => entry.id === model))) {
        return { ok: false, code: 'DUAL_PREFLIGHT_MODEL_UNAVAILABLE',
            message: `Failed to query models or model ${model} is not available`, cause: listed.reason || 'required exact model missing' };
    }
    return { ok: true, version: version.version };
}

module.exports = {
    WORKER_RUNTIMES, assertWorkerRuntime, workerCommandFor, workerOutputSchema,
    buildWorkerInvocation, extractWorkerPayload, probeCodexWorker,
};
