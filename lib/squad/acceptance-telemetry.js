'use strict';

// Acceptance-only private evidence. This observer never participates in authority
// or retries. All capture errors are contained and make completeness fail closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const withContext = (identity, action) => context.run(identity, action);
const SETTING = 'OMNI_SQUAD_ACCEPTANCE_EVIDENCE';
const RESULT_TURN = Symbol('acceptance-runtime-turn');
const captures = new Map();
const OUTPUT_LIMIT = 1024 * 1024;
const TAIL_BYTES = 2048;

function childEnv(env) {
    if (!env || !Object.hasOwn(env, SETTING)) return env;
    const clean = { ...env }; delete clean[SETTING]; return clean;
}
function linkResult(result, turn) {
    if (turn && result && typeof result === 'object') { try { result[RESULT_TURN] = turn; } catch {} }
    return result;
}
const turnFor = result => result?.[RESULT_TURN] || null;
function atomicJson(file, value) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch {} }
}
function privateDirectory(directory) {
    const absolute = path.resolve(directory);
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe capture directory');
    fs.chmodSync(absolute, 0o700);
}
function jsonErrors(stdout) {
    const values = [];
    try { values.push(JSON.parse(stdout)); } catch {
        for (const line of stdout.split(/\r?\n/)) { try { values.push(JSON.parse(line)); } catch {} }
    }
    return values.filter(v => v && typeof v === 'object' &&
        (v.error != null || v.errors != null || v.type === 'error' || v.type === 'turn.failed' || v.is_error === true ||
        (typeof v.subtype === 'string' && v.subtype.startsWith('error')) || (typeof v.status === 'string' && /^(ERROR|FAILED|FAILURE)$/i.test(v.status))));
}
function captureError(capture, entry) {
    capture.errors.push(entry);
    if (!capture.warned) {
        capture.warned = true;
        try { fs.writeSync(2, 'OMNI_SQUAD_ACCEPTANCE_CAPTURE_INCOMPLETE\n'); } catch {}
    }
}

function createTurn(meta, { env = process.env } = {}) {
    if (typeof env?.[SETTING] !== 'string' || !env[SETTING]) return null;
    meta = { ...(context.getStore() || {}), ...meta };
    meta.retryFrom?.retry({ policy: meta.retryPolicy, applied: true, reason: meta.retryReason || null });
    const directory = path.resolve(env[SETTING]);
    let capture = captures.get(directory);
    if (!capture) {
        capture = { directory, turns: new Map(), active: new Set(), errors: [], writable: false };
        captures.set(directory, capture);
        try { privateDirectory(directory); privateDirectory(path.join(directory, 'turns')); capture.writable = true; }
        catch (error) { captureError(capture, { code: error.code || 'CAPTURE_INIT_FAILED', operation: 'initialize' }); }
    }
    let binding = meta.binding;
    if (!binding && meta.cwd && ['workspace', 'review'].includes(path.basename(meta.cwd))) {
        try { binding = JSON.parse(fs.readFileSync(path.join(path.dirname(meta.cwd), 'binding.json'), 'utf8')); } catch {}
    }
    const record = { schema_version: 1, turnId: crypto.randomUUID(), runtime: meta.runtime, model: meta.model ?? null,
        role: meta.role, kind: meta.kind, cwd: meta.cwd ?? null, taskId: meta.taskId ?? meta.binding?.task_id ?? binding?.taskId ?? null,
        phase: meta.phase ?? null, attempt: meta.attempt ?? binding?.attempt ?? binding?.execution?.attempt ?? null, phaseAttempt: meta.phaseAttempt ?? null,
        invocationId: meta.invocationId ?? null, messageId: meta.messageId ?? null,
        bindingRef: meta.bindingRef ?? null, sessionRef: meta.sessionRef ?? meta.binding?.conversation_id ?? null,
        startedAt: new Date().toISOString(), endedAt: null, pid: null, processStarted: false, sameRuntimeCountAtEnd: null,
        exitCode: null, timedOut: false, overflowed: false, spawnError: null, executionError: null, stdout: '', stderr: '',
        stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, stdoutBase64: '', stderrBase64: '',
        stderrTail: '', stderrTailBase64: '', jsonErrors: [], usage: null,
        contract: { status: 'pending', code: null, layer: null }, retry: null, finalized: false };
    capture.turns.set(record.turnId, record);
    let tail = Buffer.alloc(0), stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), ended = false;
    function status() {
        const records = [...capture.turns.values()];
        return { schema_version: 1, protocol: 'omni-acceptance-telemetry-v1', complete: capture.errors.length === 0,
            turnCount: records.length, endedCount: records.filter(r => r.endedAt).length,
            finalizedCount: records.filter(r => r.finalized).length,
            pendingTurnIds: records.filter(r => !r.finalized).map(r => r.turnId), errors: capture.errors };
    }
    function persist() {
        if (!capture.writable) return;
        record.stdoutBase64 = stdout.toString('base64'); record.stderrBase64 = stderr.toString('base64');
        record.finalized = Boolean(record.endedAt && record.contract.status !== 'pending');
        try { atomicJson(path.join(directory, 'turns', record.turnId + '.json'), record); }
        catch (error) { captureError(capture, { code: error.code || 'CAPTURE_WRITE_FAILED', operation: 'turn', turnId: record.turnId }); }
        try { atomicJson(path.join(directory, 'capture-status.json'), status()); }
        catch (error) {
            captureError(capture, { code: error.code || 'CAPTURE_WRITE_FAILED', operation: 'status', turnId: record.turnId });
            // Absence/stale pending status also fails collector validation. Never
            // expose private output or change the observed invocation's outcome.
        }
    }
    function end(exitCode, error) {
        if (ended) return;
        ended = true;
        record.sameRuntimeCountAtEnd = [...capture.active].filter(id => capture.turns.get(id)?.runtime === record.runtime).length;
        capture.active.delete(record.turnId);
        record.exitCode = Number.isInteger(exitCode) ? exitCode : null;
        record.endedAt = new Date().toISOString();
        if (error) record.spawnError = { code: error.code ?? null, message: String(error.message || error) };
        persist();
    }
    function stream(name, chunk) {
        try {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            record[`${name}Bytes`] += bytes.length;
            if (name === 'stderr') {
                tail = bytes.length >= TAIL_BYTES ? Buffer.from(bytes.subarray(-TAIL_BYTES)) : Buffer.concat([tail, bytes]).subarray(-TAIL_BYTES);
                stderr = Buffer.concat([stderr, bytes.subarray(0, Math.max(0, OUTPUT_LIMIT - stderr.length))]);
                record.stderr = stderr.toString('utf8'); record.stderrTail = tail.toString('utf8'); record.stderrTailBase64 = tail.toString('base64');
            } else { stdout = Buffer.concat([stdout, bytes.subarray(0, Math.max(0, OUTPUT_LIMIT - stdout.length))]); record.stdout = stdout.toString('utf8'); }
            record[`${name}Truncated`] = record[`${name}Bytes`] > OUTPUT_LIMIT;
        } catch (error) { captureError(capture, { code: error.code || 'CAPTURE_STREAM_FAILED', operation: name, turnId: record.turnId }); }
    }
    const turn = {
        turnId: record.turnId,
        wrapSpawn(spawnImpl) {
            return (command, args, options) => {
                let child;
                try { child = spawnImpl(command, args, options?.env ? { ...options, env: childEnv(options.env) } : options); }
                catch (error) { end(null, error); throw error; }
                const started = () => {
                    if (!record.processStarted && Number.isSafeInteger(child?.pid) && child.pid > 0 && !ended) {
                        record.processStarted = true; record.pid = child.pid; capture.active.add(record.turnId); persist();
                    }
                };
                started(); child?.once?.('spawn', started);
                child?.stdout?.on?.('data', data => stream('stdout', data));
                child?.stderr?.on?.('data', data => stream('stderr', data));
                child?.once?.('close', code => end(code));
                child?.once?.('error', error => {
                    // A started child may emit error before close (e.g. aborted).
                    // Keep it active until close confirms quiescence.
                    record[record.processStarted ? 'executionError' : 'spawnError'] = { code: error.code ?? null, message: String(error.message || error) };
                    if (!record.processStarted) end(null, error); else persist();
                });
                return child;
            };
        },
        complete(raw, error) {
            try {
                if (raw) {
                    if (!record.stdoutBytes && raw.stdout) stream('stdout', raw.stdout);
                    if (!record.stderrBytes && raw.stderr) stream('stderr', raw.stderr);
                    record.exitCode = Number.isInteger(raw.exitCode ?? raw.code) ? (raw.exitCode ?? raw.code) : record.exitCode;
                    record.timedOut ||= raw.timedOut === true || raw.error_code === 'TIMEOUT';
                    record.overflowed ||= raw.overflowed === true || raw.overflow === true;
                }
                record.jsonErrors = jsonErrors(record.stdout);
                try {
                    const parsed = require('./runtimes').defaultRegistry.get(record.runtime).parseResult({ ...raw, exitCode: record.exitCode, stdout: record.stdout }, {});
                    record.usage = parsed.usage ?? null; record.sessionRef = parsed.sessionRef || record.sessionRef;
                } catch {}
                if (error) record[record.processStarted ? 'executionError' : 'spawnError'] = { code: error.code ?? null, message: String(error.message || error) };
                if (error || record.timedOut || record.overflowed || (raw && record.exitCode !== 0)) {
                    record.contract = { status: 'failed', code: error?.code || raw?.error_code || (record.timedOut ? 'TIMEOUT' : record.overflowed ? 'OUTPUT_OVERFLOW' : 'EXIT_NONZERO'), layer: 'process' };
                    record.retry ||= { policy: 'none', applied: false, reason: null };
                }
                if (!ended && !record.processStarted) end(record.exitCode, error);
                persist();
            } catch (cause) { captureError(capture, { code: cause.code || 'CAPTURE_COMPLETE_FAILED', operation: 'complete', turnId: record.turnId }); persist(); }
        },
        contract(outcome) {
            if (record.contract.status !== 'failed' || outcome.status === 'failed') record.contract = { status: outcome.status, code: outcome.code ?? null, layer: outcome.layer ?? 'contract' };
            if (!record.retry) record.retry = { policy: 'none', applied: false, reason: null };
            persist();
        },
        retry(annotation) { record.retry = { policy: annotation.policy, applied: Boolean(annotation.applied), reason: annotation.reason ?? null }; persist(); },
    };
    persist();
    return turn;
}
module.exports = { SETTING, withContext, createTurn, childEnv, linkResult, turnFor };
