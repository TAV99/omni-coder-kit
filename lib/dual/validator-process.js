'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { performance } = require('node:perf_hooks');
const { buildValidatorEnv, redactDiagnostic } = require('./validator-security');

const DEFAULTS = Object.freeze({
    qualityTimeoutMs: 120000,
    correctionTimeoutMs: 30000,
    launchTimeoutMs: 5000,
    cleanupTimeoutMs: 5000,
    maxOutputBytes: 16 * 1024 * 1024,
    maxSummaryBytes: 64 * 1024,
    maxProtocolFrameBytes: 1024 * 1024,
});

const proofsByResult = new WeakMap();
const WINDOWS_LAUNCHER = path.join(__dirname, 'windows-validator-launcher.ps1');
const WINDOWS_JOB_SOURCE = path.join(__dirname, 'windows-validator-job.cs');

class OwnedValidatorError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'OwnedValidatorError';
        this.code = code;
    }
}

function makeError(code, message) {
    return new OwnedValidatorError(code, message);
}

function boundedInteger(value, fallback, maximum, name) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw makeError('DUAL_VALIDATOR_OPTIONS_INVALID', `${name} must be an integer from 1 to ${maximum}`);
    }
    return value;
}

function validateSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)
        || typeof spec.program !== 'string' || !path.isAbsolute(spec.program) || spec.program.includes('\0')
        || !Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
        || typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd) || spec.cwd.includes('\0')
        || !Number.isSafeInteger(spec.commandIndex) || spec.commandIndex < 0
        || typeof spec.runId !== 'string' || !spec.runId
        || !['quality', 'acceptance-correction'].includes(spec.purpose)) {
        throw makeError('DUAL_VALIDATOR_SPEC_INVALID', 'Validator specification must contain a resolved executable, argv, absolute cwd, index, run id, and supported purpose');
    }

    let stat;
    try {
        stat = fs.statSync(spec.cwd);
    } catch {
        throw makeError('DUAL_VALIDATOR_SPEC_INVALID', 'Validator cwd is unavailable');
    }
    if (!stat.isDirectory()) throw makeError('DUAL_VALIDATOR_SPEC_INVALID', 'Validator cwd must be a directory');

    const validatorEnv = buildValidatorEnv(spec.env || {});
    const env = {};
    const seenKeys = new Set();
    for (const [key, value] of Object.entries(validatorEnv).sort(([a], [b]) => a.localeCompare(b))) {
        if (!key || key.includes('\0') || key.includes('=') || value.includes('\0')) continue;
        const normalized = process.platform === 'win32' ? key.toLowerCase() : key;
        if (seenKeys.has(normalized)) continue;
        seenKeys.add(normalized);
        env[key] = value;
    }

    return Object.freeze({
        program: spec.program,
        args: Object.freeze([...spec.args]),
        cwd: path.resolve(spec.cwd),
        commandIndex: spec.commandIndex,
        runId: spec.runId,
        purpose: spec.purpose,
        env: Object.freeze(env),
    });
}

function resultProofReader() {
    return (result) => {
        if (!result || typeof result !== 'object') return null;
        return proofsByResult.get(result) || null;
    };
}

function makeResult(spec, state, proof) {
    const stdout = state.stdoutText.join('');
    const stderr = state.stderrText.join('');
    const canonicalOutput = `${stdout}${stderr ? `\n${stderr}` : ''}`;
    const result = Object.freeze({
        runId: spec.runId,
        purpose: spec.purpose,
        commandIndex: spec.commandIndex,
        exitCode: state.exitCode,
        signal: state.signal,
        failure: state.failure,
        startedMonotonicMs: state.startedMonotonicMs,
        endedMonotonicMs: state.endedMonotonicMs,
        durationMs: Math.max(0, state.endedMonotonicMs - state.startedMonotonicMs),
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
        stdoutSha256: state.stdoutHash.digest('hex'),
        stderrSha256: state.stderrHash.digest('hex'),
        outputSha256: crypto.createHash('sha256').update(canonicalOutput, 'utf8').digest('hex'),
        stdoutSummary: redactDiagnostic(state.stdoutSummary, { maxLength: DEFAULTS.maxSummaryBytes }),
        stderrSummary: redactDiagnostic(state.stderrSummary, { maxLength: DEFAULTS.maxSummaryBytes }),
        stdoutSummaryTruncated: state.stdoutSummaryTruncated,
        stderrSummaryTruncated: state.stderrSummaryTruncated,
        outputTruncated: state.outputTruncated,
        stdoutComplete: state.streamsComplete && !state.outputTruncated,
        stderrComplete: state.streamsComplete && !state.outputTruncated,
        outputComplete: state.streamsComplete && !state.outputTruncated,
        cancellationCode: state.cancellationCode,
    });
    proofsByResult.set(result, Object.freeze({
        cleanupVerified: proof.cleanupVerified === true,
        activeOwnedProcesses: proof.activeOwnedProcesses,
        ownership: proof.ownership,
    }));
    return result;
}

function makeCaptureState(startedMonotonicMs, maxSummaryBytes) {
    return {
        startedMonotonicMs,
        endedMonotonicMs: startedMonotonicMs,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutHash: crypto.createHash('sha256'),
        stderrHash: crypto.createHash('sha256'),
        stdoutDecoder: new StringDecoder('utf8'),
        stderrDecoder: new StringDecoder('utf8'),
        stdoutText: [],
        stderrText: [],
        stdoutSummary: '',
        stderrSummary: '',
        stdoutSummaryBytes: 0,
        stderrSummaryBytes: 0,
        stdoutSummaryTruncated: false,
        stderrSummaryTruncated: false,
        maxSummaryBytes,
        totalBytes: 0,
        outputTruncated: false,
        streamsComplete: false,
        exitCode: null,
        signal: null,
        failure: null,
        cancellationCode: null,
    };
}

function appendSummary(state, stream, text) {
    const summaryKey = `${stream}Summary`;
    const bytesKey = `${stream}SummaryBytes`;
    const truncatedKey = `${stream}SummaryTruncated`;
    const encoded = Buffer.from(text, 'utf8');
    const remaining = Math.max(0, state.maxSummaryBytes - state[bytesKey]);
    if (encoded.length <= remaining) {
        state[summaryKey] += text;
        state[bytesKey] += encoded.length;
    } else {
        state[summaryKey] += encoded.subarray(0, remaining).toString('utf8');
        state[bytesKey] = state.maxSummaryBytes;
        state[truncatedKey] = true;
    }
}

function captureOutput(state, stream, input) {
    let buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const available = Math.max(0, DEFAULTS.maxOutputBytes - state.totalBytes);
    const acceptedLength = Math.min(buffer.length, available);
    const exceeded = buffer.length > acceptedLength;
    if (acceptedLength > 0) {
        buffer = buffer.subarray(0, acceptedLength);
        const bytesKey = `${stream}Bytes`;
        const decoder = state[`${stream}Decoder`];
        const text = decoder.write(buffer);
        state[`${stream}Hash`].update(text, 'utf8');
        state[`${stream}Text`].push(text);
        state[bytesKey] += acceptedLength;
        state.totalBytes += acceptedLength;
        appendSummary(state, stream, text);
    }
    if (exceeded) state.outputTruncated = true;
    return exceeded;
}

function finishDecoders(state) {
    for (const stream of ['stdout', 'stderr']) {
        const text = state[`${stream}Decoder`].end();
        if (!text) continue;
        state[`${stream}Hash`].update(text, 'utf8');
        state[`${stream}Text`].push(text);
        appendSummary(state, stream, text);
    }
}

function finalizeCapture(state, exitCode, signal, failure, cancellationCode, streamsComplete, endedMonotonicMs) {
    finishDecoders(state);
    state.exitCode = exitCode;
    state.signal = signal;
    state.failure = failure;
    state.cancellationCode = cancellationCode;
    state.streamsComplete = streamsComplete;
    state.endedMonotonicMs = endedMonotonicMs;
}

function frameBytes(envelope) {
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (payload.length > DEFAULTS.maxProtocolFrameBytes) throw makeError('DUAL_VALIDATOR_PROTOCOL_INVALID', 'Validator control frame exceeds the protocol limit');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

function protocolMac(secret, sequence, payload) {
    return crypto.createHmac('sha256', secret).update(`${sequence}\n${payload}`, 'utf8').digest('hex');
}

function verifyEnvelope(envelope, secret, expectedSequence) {
    if (!envelope || envelope.sequence !== expectedSequence || typeof envelope.payload !== 'string'
        || typeof envelope.mac !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.mac)) return null;
    const expected = Buffer.from(protocolMac(secret, expectedSequence, envelope.payload), 'hex');
    const provided = Buffer.from(envelope.mac, 'hex');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
    try { return JSON.parse(envelope.payload); } catch { return null; }
}

function runOwnedValidator(specInput, options = {}) {
    let spec;
    try {
        spec = validateSpec(specInput);
    } catch (error) {
        return Promise.reject(error);
    }

    const maxRunTimeout = spec.purpose === 'quality' ? DEFAULTS.qualityTimeoutMs : DEFAULTS.correctionTimeoutMs;
    const timeoutMs = boundedInteger(options.timeoutMs, maxRunTimeout, maxRunTimeout, 'timeoutMs');
    const launchTimeoutMs = boundedInteger(options.launchTimeoutMs, DEFAULTS.launchTimeoutMs, DEFAULTS.launchTimeoutMs, 'launchTimeoutMs');
    const cleanupTimeoutMs = boundedInteger(options.cleanupTimeoutMs, DEFAULTS.cleanupTimeoutMs, DEFAULTS.cleanupTimeoutMs, 'cleanupTimeoutMs');
    const startedMonotonicMs = performance.now();
    const state = makeCaptureState(startedMonotonicMs, DEFAULTS.maxSummaryBytes);

    if (options.signal?.aborted) {
        finalizeCapture(state, null, null, 'CANCELLED', 'internal-abort', true, performance.now());
        return Promise.resolve(makeResult(spec, state, {
            cleanupVerified: true,
            activeOwnedProcesses: 0,
            ownership: process.platform === 'win32' ? 'windows-job' : 'posix-process-group',
        }));
    }

    return process.platform === 'win32'
        ? runWindowsValidator(spec, state, { ...options, timeoutMs, launchTimeoutMs, cleanupTimeoutMs })
        : runPosixValidator(spec, state, { ...options, timeoutMs, cleanupTimeoutMs });
}

function runWindowsValidator(spec, state, options) {
    const secret = crypto.randomBytes(32);
    let helper;
    try {
        helper = spawn(options.powerShellPath || 'powershell.exe', [
            '-NoProfile', '-NonInteractive', '-File', WINDOWS_LAUNCHER,
        ], {
            cwd: spec.cwd,
            env: spec.env,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        finalizeCapture(state, null, null, 'LAUNCH_FAILED', null, true, performance.now());
        return Promise.resolve(makeResult(spec, state, { cleanupVerified: true, activeOwnedProcesses: 0, ownership: 'windows-job' }));
    }

    return new Promise((resolve, reject) => {
        let receiveBuffer = Buffer.alloc(0);
        let expectedSequence = 0;
        let sendSequence = 1;
        let started = false;
        let settled = false;
        let helperClosed = false;
        let protocolFailure = null;
        let exitCode = null;
        let signal = null;
        let failure = null;
        let cancellationCode = null;
        let pendingSettlement = null;
        let launchTimer;
        let runTimer;
        let cleanupTimer;
        let abortHandler;
        let helperError = null;

        const clearTimers = () => {
            clearTimeout(launchTimer);
            clearTimeout(runTimer);
            clearTimeout(cleanupTimer);
        };
        const send = (payload) => {
            if (helperClosed || !helper.stdin || helper.stdin.destroyed) return false;
            try {
                const payloadJson = JSON.stringify(payload);
                const envelope = {
                    sequence: sendSequence,
                    payload: payloadJson,
                    mac: protocolMac(secret, sendSequence, payloadJson),
                };
                sendSequence += 1;
                helper.stdin.write(frameBytes(envelope));
                return true;
            } catch {
                return false;
            }
        };
        const failUncertain = (code, message) => {
            if (settled) return;
            settled = true;
            clearTimers();
            if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
            if (helper && !helperClosed) {
                helper.kill();
                const forceTimer = setTimeout(() => helper.kill('SIGKILL'), options.cleanupTimeoutMs);
                forceTimer.unref?.();
            }
            reject(makeError(code, message));
        };
        const requestStop = (code) => {
            if (settled || failure) return;
            failure = code;
            cancellationCode = code === 'TIMED_OUT' ? 'deadline' : code === 'CANCELLED' ? 'internal-abort' : null;
            send({ type: 'cancel', reason: code, cleanupTimeoutMs: options.cleanupTimeoutMs });
            cleanupTimer = setTimeout(() => {
                failUncertain('DUAL_VALIDATOR_CLEANUP_UNPROVEN', 'Validator helper did not prove process cleanup before the deadline');
            }, options.cleanupTimeoutMs + 1000);
        };

        const complete = (body) => {
            if (settled) return;
            if (protocolFailure) {
                failUncertain('DUAL_VALIDATOR_PROTOCOL_INVALID', 'Validator helper control protocol was invalid');
                return;
            }
            if (body.cleanupVerified !== true || body.activeOwnedProcesses !== 0) {
                failUncertain('DUAL_VALIDATOR_CLEANUP_UNPROVEN', 'Validator helper did not verify an empty owned job');
                return;
            }
            clearTimers();
            if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
            const finalFailure = failure || (body.launchFailed ? 'LAUNCH_FAILED'
                : state.outputTruncated ? 'OUTPUT_LIMIT'
                    : Number.isSafeInteger(body.exitCode) && body.exitCode !== 0 ? 'NONZERO_EXIT' : null);
            const finalCancellation = cancellationCode || (finalFailure === 'OUTPUT_LIMIT' ? 'output-limit' : null);
            finalizeCapture(state,
                Number.isSafeInteger(body.exitCode) ? body.exitCode : null,
                typeof body.signal === 'string' ? body.signal : null,
                finalFailure,
                finalCancellation,
                body.streamsComplete === true,
                performance.now());
            pendingSettlement = makeResult(spec, state, {
                cleanupVerified: true,
                activeOwnedProcesses: 0,
                ownership: 'windows-job',
            });
            if (helperClosed) {
                resolve(pendingSettlement);
            } else {
                helper.stdin.end();
                cleanupTimer = setTimeout(() => {
                    if (!helperClosed) helper.kill();
                    if (!settled) {
                        settled = true;
                        reject(makeError('DUAL_VALIDATOR_HELPER_LOST', 'Validator helper failed to exit after proving cleanup'));
                    }
                }, options.cleanupTimeoutMs);
            }
        };

        const handleBody = (body) => {
            if (!body || typeof body.type !== 'string') {
                protocolFailure = new Error('missing type');
                requestStop('PROTOCOL_INVALID');
                return;
            }
            switch (body.type) {
                case 'helper-ready':
                    return;
                case 'started':
                    if (started) {
                        protocolFailure = new Error('duplicate started');
                        requestStop('PROTOCOL_INVALID');
                        return;
                    }
                    started = true;
                    clearTimeout(launchTimer);
                    runTimer = setTimeout(() => requestStop('TIMED_OUT'), options.timeoutMs);
                    return;
                case 'output': {
                    if (!started || !['stdout', 'stderr'].includes(body.stream) || typeof body.data !== 'string') {
                        protocolFailure = new Error('invalid output frame');
                        requestStop('PROTOCOL_INVALID');
                        return;
                    }
                    let chunk;
                    try { chunk = Buffer.from(body.data, 'base64'); } catch {
                        protocolFailure = new Error('invalid base64');
                        requestStop('PROTOCOL_INVALID');
                        return;
                    }
                    if (chunk.length > 8192 || chunk.toString('base64') !== body.data) {
                        protocolFailure = new Error('invalid output payload');
                        requestStop('PROTOCOL_INVALID');
                        return;
                    }
                    if (captureOutput(state, body.stream, chunk)) requestStop('OUTPUT_LIMIT');
                    return;
                }
                case 'output-limit':
                    state.outputTruncated = true;
                    if (!failure) failure = 'OUTPUT_LIMIT';
                    return;
                case 'launch-failed':
                    if (started) {
                        protocolFailure = new Error('launch failed after start');
                        requestStop('PROTOCOL_INVALID');
                        return;
                    }
                    complete({ ...body, launchFailed: true, streamsComplete: true });
                    return;
                case 'settled':
                    complete(body);
                    return;
                case 'cleanup-unproven':
                    {
                        const stage = typeof body.code === 'string' && /^[a-z0-9-]{1,64}$/.test(body.code) ? body.code : 'unknown';
                        failUncertain('DUAL_VALIDATOR_CLEANUP_UNPROVEN', `Validator helper could not prove cleanup at ${stage}`);
                    }
                    return;
                default:
                    protocolFailure = new Error('unknown frame type');
                    requestStop('PROTOCOL_INVALID');
            }
        };

        helper.stdout.on('data', (chunk) => {
            if (settled) return;
            receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
            while (receiveBuffer.length >= 4) {
                const length = receiveBuffer.readUInt32BE(0);
                if (length < 1 || length > DEFAULTS.maxProtocolFrameBytes) {
                    protocolFailure = new Error('invalid frame length');
                    requestStop('PROTOCOL_INVALID');
                    return;
                }
                if (receiveBuffer.length < length + 4) return;
                const frame = receiveBuffer.subarray(4, length + 4);
                receiveBuffer = receiveBuffer.subarray(length + 4);
                let envelope;
                try { envelope = JSON.parse(frame.toString('utf8')); } catch {
                    protocolFailure = new Error('invalid JSON');
                    requestStop('PROTOCOL_INVALID');
                    return;
                }
                const body = verifyEnvelope(envelope, secret, expectedSequence);
                if (!body) {
                    protocolFailure = new Error('bad MAC or sequence');
                    requestStop('PROTOCOL_INVALID');
                    return;
                }
                expectedSequence += 1;
                handleBody(body);
                if (settled) return;
            }
        });
        helper.stderr.on('data', (chunk) => {
            if (helperError === null) helperError = '';
            if (Buffer.byteLength(helperError) < DEFAULTS.maxSummaryBytes) {
                helperError += chunk.toString('utf8').slice(0, DEFAULTS.maxSummaryBytes);
            }
        });
        helper.on('error', (error) => {
            if (settled) return;
            if (!started && (error.code === 'ENOENT' || error.code === 'EACCES')) {
                complete({ type: 'launch-failed', launchFailed: true, cleanupVerified: true, activeOwnedProcesses: 0, streamsComplete: true, exitCode: null });
                return;
            }
            failUncertain('DUAL_VALIDATOR_HELPER_LOST', 'Validator helper failed before reporting cleanup proof');
        });
        helper.on('close', (code, closeSignal) => {
            helperClosed = true;
            if (settled) return;
            if (pendingSettlement) {
                clearTimeout(cleanupTimer);
                if (code === 0 && !closeSignal) {
                    settled = true;
                    resolve(pendingSettlement);
                } else {
                    failUncertain('DUAL_VALIDATOR_HELPER_LOST', 'Validator helper exited abnormally after cleanup proof');
                }
                return;
            }
            if (!started && code !== null) {
                failUncertain('DUAL_VALIDATOR_HELPER_UNAVAILABLE', 'Validator helper exited before launching the validator');
                return;
            }
            failUncertain('DUAL_VALIDATOR_HELPER_LOST', 'Validator helper disconnected before a settled result');
        });

        launchTimer = setTimeout(() => {
            if (!started && !settled) failUncertain('DUAL_VALIDATOR_HELPER_START_TIMEOUT', 'Validator helper did not start the command before the launch deadline');
        }, options.launchTimeoutMs);
        if (options.signal) {
            abortHandler = () => requestStop('CANCELLED');
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        const request = {
            type: 'start',
            program: spec.program,
            args: spec.args,
            cwd: spec.cwd,
            env: spec.env,
            maxOutputBytes: DEFAULTS.maxOutputBytes,
            cleanupTimeoutMs: options.cleanupTimeoutMs,
            simulateAssignmentFailure: options.windowsTestSeam?.assignmentFailure === true,
        };
        const requestPayload = JSON.stringify(request);
        const initialEnvelope = {
            sequence: 0,
            secret: secret.toString('base64'),
            payload: requestPayload,
            mac: protocolMac(secret, 0, requestPayload),
        };
        try {
            helper.stdin.write(frameBytes(initialEnvelope));
        } catch {
            failUncertain('DUAL_VALIDATOR_PROTOCOL_INVALID', 'Validator helper request could not be written');
        }
    });
}

function groupExists(groupId) {
    try {
        process.kill(-groupId, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        return true;
    }
}

function runPosixValidator(spec, state, options) {
    return new Promise((resolve, reject) => {
        let child;
        let closeCode = null;
        let closeSignal = null;
        let spawnError = null;
        let settled = false;
        let stopping = false;
        let failure = null;
        let cancellationCode = null;
        let timeoutTimer;
        let cleanupTimer;
        let killTimer;
        let pollTimer;
        let abortHandler;

        const cleanupListeners = () => {
            clearTimeout(timeoutTimer);
            clearTimeout(cleanupTimer);
            clearTimeout(killTimer);
            clearTimeout(pollTimer);
            if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
        };
        const finish = (proof) => {
            if (settled) return;
            settled = true;
            cleanupListeners();
            const finalFailure = failure || (spawnError ? 'LAUNCH_FAILED'
                : state.outputTruncated ? 'OUTPUT_LIMIT'
                    : closeCode !== null && closeCode !== 0 ? 'NONZERO_EXIT' : null);
            const finalCancel = cancellationCode || (finalFailure === 'OUTPUT_LIMIT' ? 'output-limit' : null);
            finalizeCapture(state, closeCode, closeSignal, finalFailure, finalCancel, !failure && !state.outputTruncated, performance.now());
            resolve(makeResult(spec, state, proof));
        };
        const cleanupUnproven = () => {
            if (settled) return;
            settled = true;
            cleanupListeners();
            reject(makeError('DUAL_VALIDATOR_CLEANUP_UNPROVEN', 'POSIX process group did not reach zero before the cleanup deadline'));
        };
        const sendSignal = (signalName) => {
            if (!child?.pid) return;
            try { process.kill(-child.pid, signalName); } catch (error) {
                if (error.code !== 'ESRCH') return;
            }
        };
        const requestStop = (code) => {
            if (settled || stopping) return;
            stopping = true;
            failure = code;
            cancellationCode = code === 'TIMED_OUT' ? 'deadline' : code === 'CANCELLED' ? 'internal-abort' : null;
            sendSignal('SIGTERM');
            killTimer = setTimeout(() => sendSignal('SIGKILL'), Math.max(1, Math.floor(options.cleanupTimeoutMs / 2)));
            cleanupTimer = setTimeout(cleanupUnproven, options.cleanupTimeoutMs);
        };
        const pollGroup = () => {
            if (settled) return;
            if (!child?.pid) return;
            if (closeCode !== null || closeSignal !== null || spawnError) {
                if (!groupExists(child.pid)) {
                    finish({ cleanupVerified: true, activeOwnedProcesses: 0, ownership: 'posix-process-group' });
                    return;
                }
            }
            pollTimer = setTimeout(pollGroup, 20);
        };

        try {
            child = spawn(spec.program, spec.args, {
                cwd: spec.cwd,
                env: spec.env,
                shell: false,
                detached: true,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            spawnError = true;
            finish({ cleanupVerified: true, activeOwnedProcesses: 0, ownership: 'posix-process-group' });
            return;
        }
        child.stdout.on('data', (chunk) => {
            if (captureOutput(state, 'stdout', chunk)) requestStop('OUTPUT_LIMIT');
        });
        child.stderr.on('data', (chunk) => {
            if (captureOutput(state, 'stderr', chunk)) requestStop('OUTPUT_LIMIT');
        });
        child.on('error', (error) => {
            if (!child.pid) {
                spawnError = error;
                closeCode = null;
                finish({ cleanupVerified: true, activeOwnedProcesses: 0, ownership: 'posix-process-group' });
                return;
            }
            if (!failure) failure = 'LAUNCH_FAILED';
        });
        child.on('close', (code, closeSignalValue) => {
            closeCode = Number.isSafeInteger(code) ? code : null;
            closeSignal = closeSignalValue || null;
            if (!failure && closeSignal) failure = 'NONZERO_EXIT';
            pollGroup();
        });

        timeoutTimer = setTimeout(() => requestStop('TIMED_OUT'), options.timeoutMs);
        if (options.signal) {
            abortHandler = () => requestStop('CANCELLED');
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }
    });
}

module.exports = {
    OwnedValidatorError,
    createOwnedResultProofReader: resultProofReader,
    runOwnedValidator,
};
