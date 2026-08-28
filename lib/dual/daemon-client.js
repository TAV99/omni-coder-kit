'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
    computeWorkspaceId,
    getRuntimeDir,
} = require('./daemon-lock');

class DualDaemonClientError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualDaemonClientError';
        this.code = code;
        this.details = details;
    }
}

const ALLOWED_DISCOVERY_KEYS = new Set([
    'protocol_version',
    'workspace_id',
    'workspace_root',
    'pid',
    'started_at',
    'host',
    'port',
    'token',
]);

const MAX_RESPONSE_BYTES = 64 * 1024; // 64 KiB
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

function validateDiscoveryRecord(rawDiscovery, canonicalWorkspaceRoot, expectedWorkspaceId) {
    if (!rawDiscovery || typeof rawDiscovery !== 'object' || Array.isArray(rawDiscovery)) {
        throw new DualDaemonClientError('DUAL_DISCOVERY_CORRUPT', 'Discovery file must contain a JSON object');
    }

    const keys = Object.keys(rawDiscovery);
    if (keys.length !== ALLOWED_DISCOVERY_KEYS.size) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            `Discovery file must contain exactly ${ALLOWED_DISCOVERY_KEYS.size} keys, found ${keys.length}`
        );
    }

    for (const key of keys) {
        if (!ALLOWED_DISCOVERY_KEYS.has(key)) {
            throw new DualDaemonClientError(
                'DUAL_DISCOVERY_CORRUPT',
                `Discovery file contains unexpected key: ${key}`
            );
        }
    }

    if (rawDiscovery.protocol_version !== 1) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            `Unsupported protocol_version: ${rawDiscovery.protocol_version}`
        );
    }

    if (typeof rawDiscovery.workspace_id !== 'string' || rawDiscovery.workspace_id !== expectedWorkspaceId) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_WORKSPACE_MISMATCH',
            `Discovery workspace_id (${rawDiscovery.workspace_id}) does not match expected workspace (${expectedWorkspaceId})`
        );
    }

    if (typeof rawDiscovery.workspace_root !== 'string' || rawDiscovery.workspace_root !== canonicalWorkspaceRoot) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_WORKSPACE_MISMATCH',
            `Discovery workspace_root (${rawDiscovery.workspace_root}) does not match expected root (${canonicalWorkspaceRoot})`
        );
    }

    if (
        typeof rawDiscovery.pid !== 'number' ||
        !Number.isInteger(rawDiscovery.pid) ||
        rawDiscovery.pid <= 0
    ) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            'Discovery pid must be a positive integer'
        );
    }

    if (
        typeof rawDiscovery.started_at !== 'string' ||
        isNaN(Date.parse(rawDiscovery.started_at))
    ) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            'Discovery started_at must be a valid ISO date string'
        );
    }

    if (rawDiscovery.host !== '127.0.0.1') {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            `Discovery host must be literal '127.0.0.1', got: ${rawDiscovery.host}`
        );
    }

    if (
        typeof rawDiscovery.port !== 'number' ||
        !Number.isInteger(rawDiscovery.port) ||
        rawDiscovery.port < 1 ||
        rawDiscovery.port > 65535
    ) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            'Discovery port must be an integer between 1 and 65535'
        );
    }

    if (
        typeof rawDiscovery.token !== 'string' ||
        !HEX_64_PATTERN.test(rawDiscovery.token)
    ) {
        throw new DualDaemonClientError(
            'DUAL_DISCOVERY_CORRUPT',
            'Discovery token must be a 64-character lowercase hex string'
        );
    }

    return rawDiscovery;
}

function createDaemonClient(options = {}) {
    const {
        workspaceRoot,
        timeoutMs = 500,
        fsImpl = fs,
        httpImpl = http,
        cryptoImpl = crypto,
    } = options;

    if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_ROOT_INVALID',
            'workspaceRoot is required and must be a non-empty string'
        );
    }

    let canonicalWorkspaceRoot;
    try {
        if (!fsImpl.existsSync(workspaceRoot)) {
            throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
        }
        canonicalWorkspaceRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(workspaceRoot)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
    } catch (err) {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_ROOT_INVALID',
            `Invalid workspaceRoot: ${err.message}`,
            { cause: err }
        );
    }

    const workspaceId = computeWorkspaceId(canonicalWorkspaceRoot, cryptoImpl);
    const runtimeDir = getRuntimeDir(canonicalWorkspaceRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');

    function readValidatedDiscovery() {
        if (!fsImpl.existsSync(discoveryPath)) {
            throw new DualDaemonClientError(
                'DUAL_DISCOVERY_MISSING',
                `Daemon discovery file not found at ${discoveryPath}`
            );
        }

        let rawContent;
        try {
            rawContent = fsImpl.readFileSync(discoveryPath, 'utf8');
        } catch (err) {
            throw new DualDaemonClientError(
                'DUAL_DISCOVERY_CORRUPT',
                `Failed to read discovery file: ${err.message}`,
                { cause: err }
            );
        }

        let parsed;
        try {
            parsed = JSON.parse(rawContent);
        } catch (err) {
            throw new DualDaemonClientError(
                'DUAL_DISCOVERY_CORRUPT',
                `Failed to parse discovery file as JSON: ${err.message}`,
                { cause: err }
            );
        }

        return validateDiscoveryRecord(parsed, canonicalWorkspaceRoot, workspaceId);
    }

    function readDiscovery() {
        const discovery = readValidatedDiscovery();
        return {
            protocol_version: discovery.protocol_version,
            workspace_id: discovery.workspace_id,
            workspace_root: discovery.workspace_root,
            pid: discovery.pid,
            started_at: discovery.started_at,
            host: discovery.host,
            port: discovery.port,
        };
    }

    function request(method, params = {}, requestOptions = {}) {
        return new Promise((resolve, reject) => {
            let discovery;
            try {
                discovery = readValidatedDiscovery();
            } catch (err) {
                return reject(err);
            }

            const activeTimeoutMs = requestOptions.timeoutMs !== undefined ? requestOptions.timeoutMs : timeoutMs;

            const bodyPayload = {
                protocol_version: 1,
                workspace_id: workspaceId,
                method,
                params: (params !== undefined && params !== null) ? params : {},
            };

            const bodyStr = JSON.stringify(bodyPayload);
            const bodyBuffer = Buffer.from(bodyStr, 'utf8');

            let settled = false;
            function safeResolve(val) {
                if (!settled) {
                    settled = true;
                    resolve(val);
                }
            }
            function safeReject(err) {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            }

            const headers = {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': bodyBuffer.length,
                'Authorization': `Bearer ${discovery.token}`,
            };

            const req = (httpImpl || http).request({
                hostname: '127.0.0.1',
                port: discovery.port,
                path: '/rpc',
                method: 'POST',
                headers,
                timeout: activeTimeoutMs,
            }, (res) => {
                const chunks = [];
                let bytesReceived = 0;
                let responseTooLarge = false;

                res.on('data', (chunk) => {
                    if (responseTooLarge) return;
                    bytesReceived += chunk.length;
                    if (bytesReceived > MAX_RESPONSE_BYTES) {
                        responseTooLarge = true;
                        req.destroy();
                        safeReject(new DualDaemonClientError(
                            'DUAL_CLIENT_RESPONSE_TOO_LARGE',
                            `Response body exceeded maximum allowed size of ${MAX_RESPONSE_BYTES} bytes`
                        ));
                        return;
                    }
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    if (responseTooLarge) return;

                    const resStr = Buffer.concat(chunks).toString('utf8');
                    let resJson;
                    try {
                        resJson = JSON.parse(resStr);
                    } catch (parseErr) {
                        return safeReject(new DualDaemonClientError(
                            'DUAL_CLIENT_MALFORMED_RESPONSE',
                            `Failed to parse response JSON: ${parseErr.message}`
                        ));
                    }

                    if (!resJson || typeof resJson !== 'object' || Array.isArray(resJson)) {
                        return safeReject(new DualDaemonClientError(
                            'DUAL_CLIENT_MALFORMED_RESPONSE',
                            'Response JSON must be an object'
                        ));
                    }

                    if (resJson.error) {
                        const errObj = resJson.error;
                        const errCode = (errObj && typeof errObj.code === 'string') ? errObj.code : 'DUAL_CLIENT_RPC_ERROR';
                        const errMsg = (errObj && typeof errObj.message === 'string') ? errObj.message : 'Daemon RPC error';
                        const errDetails = (errObj && typeof errObj.details === 'object' && errObj.details !== null) ? errObj.details : {};
                        return safeReject(new DualDaemonClientError(errCode, errMsg, errDetails));
                    }

                    if (resJson.result !== undefined) {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            return safeResolve(resJson.result);
                        }
                        return safeReject(new DualDaemonClientError(
                            'DUAL_CLIENT_HTTP_ERROR',
                            `HTTP status ${res.statusCode}`
                        ));
                    }

                    return safeReject(new DualDaemonClientError(
                        'DUAL_CLIENT_MALFORMED_RESPONSE',
                        'Response object missing result or error'
                    ));
                });
            });

            req.on('timeout', () => {
                req.destroy();
                safeReject(new DualDaemonClientError(
                    'DUAL_CLIENT_TIMEOUT',
                    `Request to daemon timed out after ${activeTimeoutMs}ms`
                ));
            });

            req.on('error', (err) => {
                if (err.code === 'ECONNREFUSED') {
                    safeReject(new DualDaemonClientError(
                        'DUAL_CLIENT_CONNECTION_REFUSED',
                        `Connection refused by daemon at 127.0.0.1:${discovery.port}`
                    ));
                } else if (err.code === 'ETIMEDOUT' || err.message === 'timeout') {
                    safeReject(new DualDaemonClientError(
                        'DUAL_CLIENT_TIMEOUT',
                        `Request to daemon timed out after ${activeTimeoutMs}ms`
                    ));
                } else {
                    safeReject(new DualDaemonClientError(
                        'DUAL_CLIENT_CONNECTION_ERROR',
                        `Connection error: ${err.message}`,
                        { cause: err }
                    ));
                }
            });

            req.write(bodyBuffer);
            req.end();
        });
    }

    function health(requestOptions) {
        return request('health', {}, requestOptions);
    }

    function beginSession(params, requestOptions) {
        return request('session.begin', params || {}, requestOptions);
    }

    function status(sessionId, requestOptions) {
        const params = (typeof sessionId === 'string') ? { session_id: sessionId } : (sessionId || {});
        return request('session.status', params, requestOptions);
    }

    function registerPlan(sessionId, params = {}, requestOptions) {
        const payload = (typeof sessionId === 'string') ? { session_id: sessionId, ...params } : (sessionId || {});
        return request('plan.register', payload, requestOptions);
    }

    function resumeSession(sessionId, requestOptions) {
        const payload = (typeof sessionId === 'string') ? { session_id: sessionId } : (sessionId || {});
        return request('session.resume', payload, requestOptions);
    }

    function evaluateHook(sessionId, params = {}, requestOptions) {
        const payload = (typeof sessionId === 'string') ? { session_id: sessionId, ...params } : (sessionId || {});
        return request('hook.evaluate', payload, requestOptions);
    }

    function evaluateCompletion(sessionId, params = {}, requestOptions) {
        const payload = (typeof sessionId === 'string') ? { session_id: sessionId, ...params } : (sessionId || {});
        return request('completion.evaluate', payload, requestOptions);
    }

    function stop(requestOptions) {
        return request('daemon.stop', {}, requestOptions);
    }

    async function waitForHealthy(waitOptions = {}) {
        const {
            timeoutMs: totalTimeoutMs = 5000,
            intervalMs = 50,
        } = waitOptions;

        const deadline = Date.now() + totalTimeoutMs;
        const retryableCodes = new Set([
            'DUAL_DISCOVERY_MISSING',
            'DUAL_CLIENT_CONNECTION_REFUSED',
            'DUAL_CLIENT_TIMEOUT',
        ]);

        while (Date.now() <= deadline) {
            try {
                const result = await health({ timeoutMs: Math.min(timeoutMs, Math.max(100, intervalMs * 2)) });
                if (result && result.status === 'healthy') {
                    return result;
                }
            } catch (err) {
                if (!retryableCodes.has(err.code)) {
                    // Fail fast on schema, security, corruption, workspace mismatch
                    throw err;
                }

                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
            }
        }

        throw new DualDaemonClientError(
            'DUAL_CLIENT_TIMEOUT',
            `Daemon did not become healthy within ${totalTimeoutMs}ms`
        );
    }

    return {
        workspaceId,
        workspaceRoot: canonicalWorkspaceRoot,
        readDiscovery,
        request,
        health,
        beginSession,
        status,
        sessionStatus: status,
        registerPlan,
        resumeSession,
        evaluateHook,
        evaluateCompletion,
        stop,
        waitForHealthy,
    };
}

module.exports = {
    DualDaemonClientError,
    createDaemonClient,
};
