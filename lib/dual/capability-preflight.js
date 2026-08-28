'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { detectBaselineBackend } = require('./baseline');

class DualCapabilityPreflightError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualCapabilityPreflightError';
        this.code = code;
        this.details = details;
    }
}

function spawnBoundedProcess(command, args, options = {}) {
    const {
        spawnImpl = spawn,
        timeoutMs = 15_000,
        maxOutputBytes = 64 * 1024,
        cwd,
        env,
    } = options;

    if (
        typeof command !== 'string' || !command.trim() ||
        !Array.isArray(args) || !args.every((arg) => typeof arg === 'string') ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0
    ) {
        return Promise.resolve({
            ok: false,
            error: 'INVALID_BOUNDED_PROCESS_OPTIONS: command, args, timeoutMs, or maxOutputBytes is invalid',
            error_code: 'INVALID_BOUNDED_PROCESS_OPTIONS',
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
        });
    }

    return new Promise((resolve) => {
        let settled = false;
        let timer = null;

        function settle(result) {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            resolve(result);
        }

        let child;
        try {
            child = spawnImpl(command, args, {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                ...(cwd ? { cwd } : {}),
                ...(env ? { env } : {}),
            });
        } catch (err) {
            return settle({
                ok: false,
                error: err.message,
                code: null,
                signal: null,
                stdout: '',
                stderr: '',
            });
        }

        if (!child || typeof child.on !== 'function') {
            return settle({
                ok: false,
                error: 'Failed to spawn child process',
                code: null,
                signal: null,
                stdout: '',
                stderr: '',
            });
        }

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timer = setTimeout(() => {
                try {
                    if (typeof child.kill === 'function') {
                        child.kill('SIGKILL');
                    }
                } catch {}
                settle({
                    ok: false,
                    error: `TIMEOUT: Process timed out after ${timeoutMs}ms`,
                    error_code: 'TIMEOUT',
                    timedOut: true,
                    code: null,
                    signal: 'SIGKILL',
                    stdout,
                    stderr,
                });
            }, timeoutMs);
        }

        if (child.stdout && typeof child.stdout.on === 'function') {
            child.stdout.on('data', (chunk) => {
                if (settled) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                stdoutBytes += buf.length;
                if (stdoutBytes > maxOutputBytes) {
                    try {
                        if (typeof child.kill === 'function') child.kill('SIGTERM');
                    } catch {}
                    return settle({
                        ok: false,
                        error: `STDOUT_OVERFLOW: stdout exceeded ${maxOutputBytes} bytes`,
                        overflow: true,
                        code: null,
                        signal: 'SIGTERM',
                        stdout: '',
                        stderr: '',
                    });
                }
                stdout += buf.toString('utf8');
            });
        }

        if (child.stderr && typeof child.stderr.on === 'function') {
            child.stderr.on('data', (chunk) => {
                if (settled) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                stderrBytes += buf.length;
                if (stderrBytes > maxOutputBytes) {
                    try {
                        if (typeof child.kill === 'function') child.kill('SIGTERM');
                    } catch {}
                    return settle({
                        ok: false,
                        error: `STDERR_OVERFLOW: stderr exceeded ${maxOutputBytes} bytes`,
                        overflow: true,
                        code: null,
                        signal: 'SIGTERM',
                        stdout: '',
                        stderr: '',
                    });
                }
                stderr += buf.toString('utf8');
            });
        }

        child.on('error', (err) => {
            settle({
                ok: false,
                error: err.message,
                code: null,
                signal: null,
                stdout,
                stderr,
            });
        });

        child.on('close', (code, signal) => {
            settle({
                ok: code === 0,
                code,
                signal,
                stdout,
                stderr,
                error: code === 0 ? null : (stderr || `Process exited with code ${code}`),
            });
        });
    });
}

function parseAgyModelsOutput(rawOutput) {
    if (!rawOutput) return false;
    const targetModel = 'gemini-3.7-flash-high';

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
            return parseAgyModelsOutput(rawOutput.models);
        }
        if (Array.isArray(rawOutput.data)) {
            return parseAgyModelsOutput(rawOutput.data);
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
            return parseAgyModelsOutput(parsed);
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

function validateCapabilityResult(result) {
    const invalid = (reason) => ({ valid: false, reason });
    if (!result || typeof result !== 'object') {
        return invalid('Capability result must be an object');
    }
    if (result.status !== 'PASSED' || result.to_state !== 'CAPABILITY_SAFE') {
        return invalid('Capability result is not PASSED/CAPABILITY_SAFE');
    }

    const agyCheck = Array.isArray(result.checks)
        ? result.checks.find((check) => check && check.name === 'agy_cli_and_model')
        : null;
    if (!agyCheck || agyCheck.status !== 'PASSED') {
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

    if (
        parsedVersions.length === 0 ||
        parsedVersions.some((value) => !value) ||
        new Set(parsedVersions).size !== 1 ||
        models.length === 0 ||
        models.some((value) => value !== 'gemini-3.7-flash-high')
    ) {
        return invalid('Capability result is missing exact durable AGY version/model evidence');
    }

    return {
        valid: true,
        version: parsedVersions[0],
        model: 'gemini-3.7-flash-high',
    };
}

async function runCapabilityPreflight(workspaceRoot, options = {}) {
    const {
        authorityStore,
        fsImpl = fs,
        spawnImpl = spawn,
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

    if (typeof customChecks === 'function') {
        const customResult = await customChecks(workspaceRoot, options);
        const validation = validateCapabilityResult(customResult);
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
        const res = await checkConfig(workspaceRoot, options);
        checks.push(res);
    } else {
        const configPath = path.join(workspaceRoot, '.codex', 'config.toml');
        const hooksPath = path.join(workspaceRoot, '.codex', 'hooks.json');

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

    // 4. AGY CLI Executable and Exact Model gemini-3.7-flash-high
    if (typeof checkAgy === 'function') {
        const res = await checkAgy(workspaceRoot, options);
        const actualVersion = parseAgyVersionOutput(res?.details?.agy_version || res?.details?.agy_evidence?.version || '');
        const actualModel = res?.details?.agy_model || res?.details?.agy_evidence?.model;
        if (res?.status === 'PASSED' && actualVersion && actualModel === 'gemini-3.7-flash-high') {
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
        const modelOk = parseAgyModelsOutput(agyModels);
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
                reason: 'AGY CLI or required model gemini-3.7-flash-high is unavailable',
            });
        }
    } else {
        // Run bounded live check: agy --version and agy models
        try {
            const versionResult = await spawnBoundedProcess(agyCommand, [...agyPrefixArgs, '--version'], {
                spawnImpl,
                timeoutMs,
                maxOutputBytes,
                cwd: workspaceRoot,
            });

            if (!versionResult.ok) {
                checks.push({
                    name: 'agy_cli_and_model',
                    status: 'BLOCKED',
                    reason: 'Agy CLI is not available or failed --version check',
                });
            } else {
                const actualVersion = parseAgyVersionOutput(versionResult.stdout);
                if (!actualVersion) {
                    checks.push({
                        name: 'agy_cli_and_model',
                        status: 'BLOCKED',
                        reason: 'Failed to parse valid Agy version string',
                    });
                } else {
                    const modelsResult = await spawnBoundedProcess(agyCommand, [...agyPrefixArgs, 'models'], {
                        spawnImpl,
                        timeoutMs,
                        maxOutputBytes,
                        cwd: workspaceRoot,
                    });

                    if (!modelsResult.ok) {
                        checks.push({
                            name: 'agy_cli_and_model',
                            status: 'BLOCKED',
                            reason: 'Failed to query models from Agy CLI',
                        });
                    } else {
                        const modelOk = parseAgyModelsOutput(modelsResult.stdout);
                        if (modelOk) {
                            detectedAgyVersion = actualVersion;
                            checks.push({
                                name: 'agy_cli_and_model',
                                status: 'PASSED',
                            });
                        } else {
                            checks.push({
                                name: 'agy_cli_and_model',
                                status: 'BLOCKED',
                                reason: 'Required model gemini-3.7-flash-high is not available in Agy',
                            });
                        }
                    }
                }
            }
        } catch (err) {
            checks.push({
                name: 'agy_cli_and_model',
                status: 'BLOCKED',
                reason: `AGY CLI check failed: ${err.message}`,
            });
        }
    }

    // 5. MCP and Hook Setup (mcp_servers.omni_dual in .codex/config.toml)
    if (typeof checkMcp === 'function') {
        const res = await checkMcp(workspaceRoot, options);
        checks.push(res);
    } else {
        const configPath = path.join(workspaceRoot, '.codex', 'config.toml');
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

    const toState = overallStatus === 'PASSED' ? 'CAPABILITY_SAFE' : 'BLOCKED';
    const details = overallStatus === 'PASSED' && detectedAgyVersion
        ? {
            agy_version: detectedAgyVersion,
            agy_model: 'gemini-3.7-flash-high',
            agy_evidence: {
                version: detectedAgyVersion,
                model: 'gemini-3.7-flash-high',
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
};
