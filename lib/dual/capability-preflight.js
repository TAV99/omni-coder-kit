'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { detectBaselineBackend } = require('./baseline');
const { resolveConfiguredWorkerModel, resolveConfiguredWorkerEffort, resolveConfiguredWorkerRuntime, resolveConfiguredOrchestrator, workerConfigurationError } = require('./agy-model');
const { hasClaudeOrchestratorMcp } = require('../squad/claude-orchestrator');
const {
    RETRYABLE_PRESPAWN_RESOURCE_CODES,
    spawnBoundedProcess,
    preSpawnResourceFailureCode,
} = require('../squad/runtimes/spawn-bounded');
const { defaultRegistry, modelAvailable } = require('../squad/runtimes');
const { workerCommandFor } = require('./worker-runtime');

class DualCapabilityPreflightError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualCapabilityPreflightError';
        this.code = code;
        this.details = details;
    }
}

const RETRYABLE_PREFLIGHT_ERROR = Symbol('dual-capability-preflight-retry-proof');

function createRetryablePreflightError(errorCode) {
    const error = new DualCapabilityPreflightError(
        'DUAL_CAPABILITY_RETRYABLE',
        'Capability availability probe could not start because local process resources are temporarily unavailable',
        { probe_code: errorCode }
    );
    Object.defineProperty(error, RETRYABLE_PREFLIGHT_ERROR, { value: errorCode });
    return error;
}

function getRetryableCapabilityPreflightCode(error) {
    const errorCode = error && error[RETRYABLE_PREFLIGHT_ERROR];
    return error instanceof DualCapabilityPreflightError
        && error.code === 'DUAL_CAPABILITY_RETRYABLE'
        && RETRYABLE_PRESPAWN_RESOURCE_CODES.has(errorCode)
        ? errorCode
        : null;
}


function parseAgyModelsOutput(rawOutput, targetModel) {
    if (!rawOutput || typeof targetModel !== 'string' || !targetModel.trim()) return false;

    if (Array.isArray(rawOutput)) {
        return rawOutput.some((m) => {
            if (typeof m === 'string') return m === targetModel;
            if (m && typeof m === 'object') {
                return [m.id, m.name, m.model].includes(targetModel);
            }
            return false;
        });
    }

    if (typeof rawOutput === 'object') {
        if (Array.isArray(rawOutput.models)) {
            return parseAgyModelsOutput(rawOutput.models, targetModel);
        }
        if (Array.isArray(rawOutput.data)) {
            return parseAgyModelsOutput(rawOutput.data, targetModel);
        }
        return false;
    }

    if (typeof rawOutput !== 'string') return false;
    const trimmed = rawOutput.trim();
    if (!trimmed) return false;

    // Try JSON parsing
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
            return parseAgyModelsOutput(parsed, targetModel);
        }
    } catch {}

    // Tabular/line parsing: each line starts with model ID separated by whitespace/tab
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
        const row = line.trim();
        if (!row) continue;
        const tokens = row.split(/\s+/);
        if (tokens[0] === targetModel) {
            return true;
        }
    }

    return false;
}

function parseAgyVersionOutput(rawOutput) {
    if (!rawOutput || typeof rawOutput !== 'string') return null;
    const trimmed = rawOutput.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^agy(?:\s+version)?\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i)
        || trimmed.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
    if (match && match[1]) {
        return match[1].trim();
    }
    return null;
}

function validateCapabilityResult(result, expectedModel, options = {}) {
    const invalid = (reason) => ({ valid: false, reason });
    if (!result || typeof result !== 'object') {
        return invalid('Capability result must be an object');
    }
    if (result.status !== 'PASSED' || result.to_state !== 'CAPABILITY_SAFE') {
        return invalid('Capability result is not PASSED/CAPABILITY_SAFE');
    }
    const checks = result.checks;
    if (!Array.isArray(checks) || checks.length === 0) {
        return invalid('Capability result checks must be a non-empty array');
    }
    if (options.provider === 'codex') {
        return checks.every((check) => check && ['PASSED', 'OPTIONAL_SKIPPED'].includes(check.status))
            ? { valid: true }
            : invalid('Capability result contains checks that did not pass');
    }
    if (typeof expectedModel !== 'string' || !expectedModel.trim()) {
        return invalid(workerConfigurationError(null, 'configured'));
    }
    const targetCheck = checks.find((c) => c && c.name === 'agy_cli_and_model');
    if (!targetCheck || targetCheck.status !== 'PASSED') {
        return invalid('Capability result is missing a PASSED agy_cli_and_model check');
    }

    const details = result.details && typeof result.details === 'object' ? result.details : {};
    const evidence = details.agy_evidence && typeof details.agy_evidence === 'object'
        ? details.agy_evidence
        : {};
    const rawVersions = [details.agy_version, evidence.version]
        .filter((value) => value !== undefined && value !== null && value !== '');
    const parsedVersions = rawVersions.map((value) => parseAgyVersionOutput(value));
    const models = [details.agy_model, evidence.model]
        .filter((value) => value !== undefined && value !== null && value !== '');

    const targetModel = expectedModel.trim();

    if (
        parsedVersions.length === 0 ||
        parsedVersions.some((value) => !value) ||
        new Set(parsedVersions).size !== 1 ||
        models.length === 0 ||
        models.some((value) => value !== targetModel)
    ) {
        return invalid('Capability result is missing exact durable AGY version/model evidence');
    }

    return {
        valid: true,
        version: parsedVersions[0],
        model: targetModel,
    };
}

async function runCapabilityPreflight(workspaceRoot, options = {}) {
    const targetModel = resolveConfiguredWorkerModel(workspaceRoot, options);
    const {
        authorityStore,
        configRoot = workspaceRoot,
        fsImpl = fs,
        spawnImpl = spawn,
        env = process.env, signal, prespawnGuard, cwd = workspaceRoot,
        customChecks,
        checkLedger,
        checkBaseline,
        checkConfig,
        checkAgy,
        checkMcp,
        agyVersion,
        agyModels,
        agyCommand = 'agy',
        agyPrefixArgs = [],
        timeoutMs = 15_000,
        maxOutputBytes = 64 * 1024,
    } = options;

    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
        return {
            status: 'BLOCKED',
            to_state: 'BLOCKED',
            checks: [
                {
                    name: 'workspace_root',
                    status: 'BLOCKED',
                    reason: 'workspaceRoot is invalid or missing',
                },
            ],
            details: {},
        };
    }

    const configurationError = options.provider === 'codex' ? null
        : workerConfigurationError(targetModel, resolveConfiguredWorkerEffort(workspaceRoot, options),
            resolveConfiguredWorkerRuntime(workspaceRoot, options));
    if (configurationError) {
        return {
            status: 'BLOCKED',
            to_state: 'BLOCKED',
            checks: [{ name: 'agy_cli_and_model', status: 'BLOCKED', reason: configurationError }],
            details: {},
        };
    }

    if (typeof customChecks === 'function') {
        const customResult = await customChecks(workspaceRoot, options);
        const validation = validateCapabilityResult(customResult, targetModel, options);
        if (validation.valid) {
            return customResult;
        }
        return {
            status: 'BLOCKED',
            to_state: 'BLOCKED',
            checks: [{
                name: 'agy_cli_and_model',
                status: 'BLOCKED',
                reason: 'Custom capability result is missing exact durable AGY version/model evidence',
            }],
            details: {},
        };
    }

    const checks = [];
    let detectedAgyVersion = null;
    let retryableProbeResourceCode = null;

    // 1. Authority Ledger Integrity
    if (typeof checkLedger === 'function') {
        const res = await checkLedger(workspaceRoot, options);
        checks.push(res);
    } else if (authorityStore && typeof authorityStore.verifyIntegrity === 'function') {
        try {
            const integrity = authorityStore.verifyIntegrity();
            if (integrity && integrity.valid) {
                checks.push({
                    name: 'authority_ledger_integrity',
                    status: 'PASSED',
                });
            } else {
                checks.push({
                    name: 'authority_ledger_integrity',
                    status: 'BLOCKED',
                    reason: 'Authority ledger integrity check failed',
                });
            }
        } catch (err) {
            checks.push({
                name: 'authority_ledger_integrity',
                status: 'BLOCKED',
                reason: `Authority store error: ${err.message}`,
            });
        }
    } else {
        checks.push({
            name: 'authority_ledger_integrity',
            status: 'BLOCKED',
            reason: 'authorityStore is missing or uninitialized',
        });
    }

    // 2. Baseline Backend
    if (typeof checkBaseline === 'function') {
        const res = await checkBaseline(workspaceRoot, options);
        checks.push(res);
    } else {
        try {
            const backend = detectBaselineBackend(workspaceRoot, { fsImpl });
            if (backend === 'git' || backend === 'snapshot') {
                checks.push({
                    name: 'baseline_backend',
                    status: 'PASSED',
                });
            } else {
                checks.push({
                    name: 'baseline_backend',
                    status: 'BLOCKED',
                    reason: `Unsupported baseline backend: ${backend}`,
                });
            }
        } catch (err) {
            checks.push({
                name: 'baseline_backend',
                status: 'BLOCKED',
                reason: `Failed to detect baseline backend: ${err.message}`,
            });
        }
    }

    // 3. Project Configuration (.codex/config.toml and .codex/hooks.json)
    if (typeof checkConfig === 'function') {
        const res = await checkConfig(configRoot, options);
        checks.push(res);
    } else {
        const configPath = path.join(configRoot, '.codex', 'config.toml');
        const hooksPath = path.join(configRoot, '.codex', 'hooks.json');

        let configOk = false;
        let hooksOk = false;
        let configReason = '';

        if (fsImpl.existsSync(configPath)) {
            try {
                const configStr = fsImpl.readFileSync(configPath, 'utf8');
                if (configStr.includes('codex_hooks')) {
                    configReason = 'Deprecated codex_hooks feature flag detected; use [features] hooks = true';
                } else if (/\[features\][\s\S]*?\bhooks\s*=\s*true/.test(configStr)) {
                    configOk = true;
                } else {
                    configReason = '.codex/config.toml missing [features] hooks = true';
                }
            } catch (err) {
                configReason = `Failed to read .codex/config.toml: ${err.message}`;
            }
        } else {
            configReason = '.codex/config.toml does not exist';
        }

        if (fsImpl.existsSync(hooksPath)) {
            try {
                const hooksObj = JSON.parse(fsImpl.readFileSync(hooksPath, 'utf8'));
                if (hooksObj && hooksObj.hooks && typeof hooksObj.hooks === 'object') {
                    hooksOk = true;
                } else {
                    configReason = '.codex/hooks.json is missing hooks container';
                }
            } catch (err) {
                configReason = `Failed to parse .codex/hooks.json: ${err.message}`;
            }
        } else {
            configReason = '.codex/hooks.json does not exist';
        }

        if (configOk && hooksOk) {
            checks.push({
                name: 'project_configuration',
                status: 'PASSED',
            });
        } else {
            checks.push({
                name: 'project_configuration',
                status: 'BLOCKED',
                reason: configReason || 'Project configuration check failed',
            });
        }
    }

    // 4. Verify the configured AGY model for AGY providers.
    if (options.provider === 'codex') {
        checks.push({ name: 'agy_cli_and_model', status: 'OPTIONAL_SKIPPED' });
    } else if (typeof checkAgy === 'function') {
        const res = await checkAgy(workspaceRoot, options);
        const actualVersion = parseAgyVersionOutput(res?.details?.agy_version || res?.details?.agy_evidence?.version || '');
        const actualModel = res?.details?.agy_model || res?.details?.agy_evidence?.model;
        if (res?.status === 'PASSED' && actualVersion && actualModel === targetModel) {
            detectedAgyVersion = actualVersion;
            checks.push({ name: 'agy_cli_and_model', status: 'PASSED' });
        } else if (res?.status === 'PASSED') {
            checks.push({
                name: 'agy_cli_and_model',
                status: 'BLOCKED',
                reason: 'AGY check passed without exact durable version/model evidence',
            });
        } else {
            checks.push(res && typeof res === 'object'
                ? res
                : { name: 'agy_cli_and_model', status: 'BLOCKED', reason: 'AGY check returned an invalid result' });
        }
    } else if (agyVersion !== undefined || agyModels !== undefined) {
        const parsedVer = typeof agyVersion === 'string'
            ? parseAgyVersionOutput(agyVersion)
            : null;
        const modelOk = parseAgyModelsOutput(agyModels, targetModel);
        if (parsedVer && modelOk) {
            detectedAgyVersion = parsedVer;
            checks.push({
                name: 'agy_cli_and_model',
                status: 'PASSED',
            });
        } else {
            checks.push({
                name: 'agy_cli_and_model',
                status: 'BLOCKED',
                reason: `AGY CLI or required model ${targetModel} is unavailable`,
            });
        }
    } else {
        let guardDenied = false;
        let guardFailure;
        // Probe through the worker's runtime adapter (SPEC-SQUAD-P3 §4.2); the
        // strict version regex and retryable resource codes stay here (§4.3).
        const unavailable = (failure, reason) => {
            retryableProbeResourceCode = preSpawnResourceFailureCode(failure.raw);
            checks.push({
                name: 'agy_cli_and_model',
                status: 'BLOCKED',
                reason: retryableProbeResourceCode
                    ? 'Agy availability probe could not start because local process resources are temporarily unavailable'
                    : reason,
            });
        };
        try {
            // An unknown runtime id fails the check below, like a missing CLI.
            const workerRuntime = defaultRegistry.get(resolveConfiguredWorkerRuntime(configRoot, options));
            const { command: workerCommand, prefixArgs: workerPrefixArgs } = workerCommandFor(workerRuntime.id,
                { agyCommand, agyPrefixArgs, workerCommand: options.workerCommand, workerPrefixArgs: options.workerPrefixArgs });
            const probeCtx = { spawnImpl, env, signal, cwd, timeoutMs, maxOutputBytes, fsImpl, cache: new Map(),
                platform: process.platform, homedir: os.homedir(), includeHidden: true,
                resolved: { found: true, command: workerCommand, prefixArgs: [...workerPrefixArgs] },
                prespawnGuard: prespawnGuard && (async (context) => {
                    try { await prespawnGuard(context); }
                    catch (error) { guardDenied = true; guardFailure = error; throw error; }
                }) };
            const versionResult = await workerRuntime.version(probeCtx);
            const actualVersion = versionResult.ok
                ? (workerRuntime.id === 'agy' ? parseAgyVersionOutput(versionResult.raw) : versionResult.version)
                : null;

            if (!versionResult.ok && versionResult.code !== 'SQUAD_RUNTIME_PARSE_FAILED') {
                unavailable(versionResult, 'Agy CLI is not available or failed --version check');
            } else if (!actualVersion) {
                checks.push({
                    name: 'agy_cli_and_model',
                    status: 'BLOCKED',
                    reason: 'Failed to parse valid Agy version string',
                });
            } else {
                const modelsResult = await workerRuntime.listModels(probeCtx);
                if (!modelsResult.ok) {
                    unavailable(modelsResult, 'Failed to query models from Agy CLI');
                } else if (modelAvailable(modelsResult, targetModel)) {
                    // source 'none': codex has not written its model cache yet; the version probe decides.
                    detectedAgyVersion = actualVersion;
                    checks.push({
                        name: 'agy_cli_and_model',
                        status: 'PASSED',
                    });
                } else {
                    checks.push({
                        name: 'agy_cli_and_model',
                        status: 'BLOCKED',
                        reason: `Required model ${targetModel} is not available in Agy`,
                    });
                }
            }
        } catch (err) {
            if (guardDenied) throw guardFailure;
            checks.push({
                name: 'agy_cli_and_model',
                status: 'BLOCKED',
                reason: `AGY CLI check failed: ${err.message}`,
            });
        }
    }

    // 5. MCP and Hook Setup (mcp_servers.omni_dual in .codex/config.toml, or
    // .mcp.json for a claude orchestrator - SPEC-SQUAD-P4 §5)
    if (typeof checkMcp === 'function') {
        const res = await checkMcp(configRoot, options);
        checks.push(res);
    } else if (resolveConfiguredOrchestrator(configRoot, options).runtime === 'claude') {
        checks.push(hasClaudeOrchestratorMcp(configRoot, fsImpl)
            ? { name: 'mcp_and_hook_setup', status: 'PASSED' }
            : { name: 'mcp_and_hook_setup', status: 'BLOCKED', reason: '.mcp.json is missing mcpServers.omni_dual (run omni squad setup)' });
    } else {
        const configPath = path.join(configRoot, '.codex', 'config.toml');
        let mcpOk = false;
        if (fsImpl.existsSync(configPath)) {
            try {
                const configStr = fsImpl.readFileSync(configPath, 'utf8');
                if (
                    configStr.includes('[mcp_servers.omni_dual]') ||
                    configStr.includes('mcp_servers.omni_dual')
                ) {
                    mcpOk = true;
                }
            } catch {
                mcpOk = false;
            }
        }
        if (mcpOk) {
            checks.push({
                name: 'mcp_and_hook_setup',
                status: 'PASSED',
            });
        } else {
            checks.push({
                name: 'mcp_and_hook_setup',
                status: 'BLOCKED',
                reason: '.codex/config.toml is missing [mcp_servers.omni_dual] declaration',
            });
        }
    }

    // Aggregate status
    let overallStatus = 'PASSED';
    for (const c of checks) {
        if (c.status !== 'PASSED' && c.status !== 'OPTIONAL_SKIPPED') {
            overallStatus = c.status;
            break;
        }
    }

    if (retryableProbeResourceCode) {
        const agyChecks = checks.filter((check) => check.name === 'agy_cli_and_model');
        const unrelatedChecksPassed = checks.every((check) => check.name === 'agy_cli_and_model'
            || check.status === 'PASSED'
            || check.status === 'OPTIONAL_SKIPPED');
        if (
            overallStatus !== 'PASSED' &&
            agyChecks.length === 1 &&
            agyChecks[0].status === 'BLOCKED' &&
            unrelatedChecksPassed
        ) {
            throw createRetryablePreflightError(retryableProbeResourceCode);
        }
    }

    const toState = overallStatus === 'PASSED' ? 'CAPABILITY_SAFE' : 'BLOCKED';
    const details = overallStatus === 'PASSED' && detectedAgyVersion
        ? {
            agy_version: detectedAgyVersion,
            agy_model: targetModel,
            agy_evidence: {
                version: detectedAgyVersion,
                model: targetModel,
            },
        }
        : {};

    return {
        status: overallStatus,
        to_state: toState,
        checks,
        details,
    };
}

module.exports = {
    DualCapabilityPreflightError,
    spawnBoundedProcess,
    parseAgyModelsOutput,
    parseAgyVersionOutput,
    validateCapabilityResult,
    runCapabilityPreflight,
    getRetryableCapabilityPreflightCode,
};
