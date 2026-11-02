'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { redactDiagnostic } = require('../../lib/dual/validator-security');
const { saveReport } = require('./squad-live');

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credentials|(?:^|[_-])token(?:$|[_-]))/i;
function redactReport(value, { homeDirs = [os.homedir()], secrets = [] } = {}) {
    const seen = new WeakSet();
    const string = (raw) => {
        let text = String(raw).replace(/\\\//g, '/');
        for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
            for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) text = text.split(form).join('[REDACTED]');
        }
        text = redactDiagnostic(text, { maxLength: 1024 * 1024 });
        for (const home of homeDirs.filter(Boolean)) {
            for (const form of new Set([home, home.replace(/\\/g, '\\\\')])) text = text.split(form).join('[HOME]');
        }
        return text.replace(/\/(?:Users|home)\/[^/\s"'<>\\]+/gi, '[HOME]')
            .replace(/\/root(?=\/|\b)/g, '[HOME]')
            .replace(/\b[A-Z]:\\+(?:Users|Documents and Settings)\\+[^\\/\s"'<>]+/gi, '[HOME]')
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
            .replace(/(https?:\/\/[^\s"#]+)#[^\s"]+/gi, '$1#[REDACTED]')
            .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b/g, '[REDACTED]');
    };
    const visit = (entry) => {
        if (typeof entry === 'string') return string(entry);
        if (entry === null || typeof entry !== 'object') return entry;
        if (seen.has(entry)) return '[CIRCULAR]';
        seen.add(entry);
        let result;
        if (entry instanceof Date) result = entry.toISOString();
        else if (Buffer.isBuffer(entry)) result = string(entry.toString('utf8'));
        else if (Array.isArray(entry)) result = entry.map(visit);
        else {
            result = {};
            for (const [key, item] of Object.entries(entry)) {
                let name = string(key);
                while (Object.hasOwn(result, name)) name += '_';
                result[name] = SECRET_KEY.test(key) ? '[REDACTED]' : visit(item);
            }
        }
        seen.delete(entry);
        return result;
    };
    return visit(value);
}

function utf8Tail(value, limit = 2048) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''));
    let start = Math.max(0, bytes.length - limit);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString('utf8');
}

function collectRuntimeEvidence(directory, redaction = {}, { daemonLog } = {}) {
    const problems = [], turns = [];
    let status;
    try { status = JSON.parse(fs.readFileSync(path.join(directory, 'capture-status.json'), 'utf8')); }
    catch { problems.push({ code: 'CAPTURE_STATUS_MISSING' }); }
    try {
        for (const name of fs.readdirSync(path.join(directory, 'turns')).filter((file) => file.endsWith('.json')).sort()) {
            try {
                const file = path.join(directory, 'turns', name);
                if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlink');
                const turn = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!turn.turnId || !turn.runtime || turn.finalized !== true) problems.push({ code: 'CAPTURE_TURN_INCOMPLETE', file: name });
                turns.push(turn);
            } catch { problems.push({ code: 'CAPTURE_TURN_INVALID', file: name }); }
        }
    } catch { problems.push({ code: 'CAPTURE_TURNS_MISSING' }); }
    if (new Set(turns.map((turn) => turn.turnId)).size !== turns.length) problems.push({ code: 'CAPTURE_DUPLICATE_TURN' });
    if (daemonLog) {
        try {
            if (fs.readFileSync(daemonLog, 'utf8').includes('OMNI_SQUAD_ACCEPTANCE_CAPTURE_INCOMPLETE')) problems.push({ code: 'CAPTURE_IO_FAILURE' });
        } catch { problems.push({ code: 'CAPTURE_DAEMON_LOG_MISSING' }); }
    }
    if (!status || status.schema_version !== 1 || status.protocol !== 'omni-acceptance-telemetry-v1' || status.complete !== true
        || !Array.isArray(status.errors) || status.errors.length || !Array.isArray(status.pendingTurnIds) || status.pendingTurnIds.length
        || [status.turnCount, status.endedCount, status.finalizedCount].some((count) => count !== turns.length)) {
        problems.push({ code: 'CAPTURE_NOT_COMPLETE' });
    }
    const runtimeFailures = turns.filter((turn) => turn.exitCode !== 0 || turn.spawnError || turn.executionError || turn.timedOut || turn.overflowed
        || ['failed', 'unknown'].includes(turn.contract?.status)).map((turn) => {
        const source = turn.stderrTailBase64 ? Buffer.from(turn.stderrTailBase64, 'base64') : Buffer.from(turn.stderrTail || '');
        const safe = redactReport({ turnId: turn.turnId, runtime: turn.runtime, model: turn.model, role: turn.role, kind: turn.kind,
            taskId: turn.taskId, phase: turn.phase, attempt: turn.attempt, phaseAttempt: turn.phaseAttempt,
            invocationId: turn.invocationId, startedAt: turn.startedAt, endedAt: turn.endedAt, processStarted: turn.processStarted,
            sameRuntimeCountAtEnd: turn.sameRuntimeCountAtEnd, exitCode: turn.exitCode, timedOut: turn.timedOut,
            overflowed: turn.overflowed, spawnError: turn.spawnError, executionError: turn.executionError, jsonErrors: turn.jsonErrors || [],
            contract: turn.contract, retry: turn.retry ?? null, usage: turn.usage ?? null }, redaction);
        const prefix = turn.stderrBase64 ? Buffer.from(turn.stderrBase64, 'base64') : Buffer.from(turn.stderr || '');
        const full = turn.stderrTruncated !== true && Number.isInteger(turn.stderrBytes) && turn.stderrBytes === prefix.length;
        // Redact complete diagnostics before clipping. A ring tail may begin in
        // the middle of a secret whose label was discarded; remove that fragment.
        const diagnostic = full ? prefix.toString('utf8') : source.length >= 2048
            ? '[TRUNCATED]' + utf8Tail(source).replace(/^\S*/, '') : source.toString('utf8');
        safe.stderrTail = utf8Tail(redactReport(diagnostic, redaction));
        return safe;
    });
    return { complete: problems.length === 0, problems, status, turns, runtimeFailures };
}

function copyPrivateEvidence(source, target) {
    const hashes = {};
    const copy = (from, to, relative) => {
        const stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) throw Object.assign(new Error('Evidence copy refuses symlinks'), { code: 'ACCEPTANCE_EVIDENCE_SYMLINK' });
        if (stat.isDirectory()) {
            fs.mkdirSync(to, { recursive: true, mode: 0o700 }); fs.chmodSync(to, 0o700);
            for (const name of fs.readdirSync(from).sort()) copy(path.join(from, name), path.join(to, name), relative ? `${relative}/${name}` : name);
        } else if (stat.isFile()) {
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
            const bytes = fs.readFileSync(from);
            fs.writeFileSync(to, bytes, { mode: 0o600 }); fs.chmodSync(to, 0o600);
            hashes[relative || path.basename(from)] = createHash('sha256').update(bytes).digest('hex');
        } else throw Object.assign(new Error('Unsupported evidence file'), { code: 'ACCEPTANCE_EVIDENCE_FILE_TYPE' });
    };
    copy(source, target, '');
    return { files: Object.keys(hashes).length, sha256: hashes };
}

function writeAcceptanceReport(directory, report, redaction = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    const safe = redactReport(report, redaction);
    saveReport(path.join(directory, 'report.json'), safe);
    const measurements = safe.measurements || {};
    const lines = ['# Squad acceptance report', '', `Config: ${safe.config || 'unknown'}. Result: ${safe.ok ? 'PASS' : 'INCOMPLETE / FAIL'}.`,
        `Suite: ${safe.completeSuite ? 'complete' : 'partial'}.`, '', '| Threshold | Result |', '|---|---|'];
    for (const [name, threshold] of Object.entries(measurements.thresholds || {})) {
        lines.push(`| ${name} | ${threshold.passed ? 'PASS' : 'FAIL'} |`);
    }
    lines.push('', '## Traceable violations', '');
    for (const [name, threshold] of Object.entries(measurements.thresholds || {})) {
        for (const violation of threshold.violations || []) lines.push(`- ${name}: ${JSON.stringify(violation)}`);
    }
    lines.push('', '## Run details', '', '```json', JSON.stringify(safe, null, 2), '```', '');
    const temp = path.join(directory, `report.md.${process.pid}.tmp`);
    fs.writeFileSync(temp, lines.join('\n'), { mode: 0o600 }); fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, path.join(directory, 'report.md'));
    return safe;
}

module.exports = { redactReport, utf8Tail, collectRuntimeEvidence, copyPrivateEvidence, writeAcceptanceReport };
