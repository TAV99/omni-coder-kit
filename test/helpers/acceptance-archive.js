'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { copyPrivateEvidence } = require('./acceptance-evidence');

async function archiveAcceptanceEvidence({ root, outDir, captureDir, daemonLog, turns = [],
    registry = require('../../lib/squad/runtimes').defaultRegistry }) {
    const result = { archives: [], transcripts: [], problems: [] };
    const destination = path.join(outDir, 'private');
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); fs.chmodSync(destination, 0o700);
    function noLinks(from, base) {
        let current = base;
        for (const name of path.relative(base, from).split(path.sep).filter(Boolean)) {
            current = path.join(current, name);
            if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('Evidence symlink'), { code: 'ACCEPTANCE_EVIDENCE_SYMLINK' });
        }
    }
    function copy(source, name, base = root) {
        if (!source || !fs.existsSync(source)) return;
        try {
            noLinks(source, base);
            result.archives.push({ name, ...copyPrivateEvidence(source, path.join(destination, name)) });
        } catch (error) { result.problems.push({ code: error.code || 'EVIDENCE_COPY_FAILED', name }); }
    }
    for (const [directory, name] of [['dual-authority', 'authority'], ['dual-discussion', 'discussion'], ['dual-workspaces', 'workspaces']]) {
        copy(path.join(root, '.omni/runs', directory), name);
    }
    copy(path.join(root, '.omni/codex-gemini'), 'worker-runtime');
    // Capture is already private and can live inside the output tree. Copy it
    // only if it is not the archive destination itself.
    if (captureDir && path.resolve(captureDir) !== path.join(destination, 'runtime-capture')) copy(captureDir, 'runtime-capture', path.dirname(captureDir));
    copy(daemonLog, 'daemon.log', path.dirname(daemonLog || root));
    const sessions = new Set();
    for (const turn of turns) {
        const entry = { runtime: turn.runtime, sessionRef: turn.sessionRef || null, cwd: turn.cwd || null };
        if (!turn.sessionRef || typeof turn.sessionRef !== 'string') { result.transcripts.push({ ...entry, status: 'no-session-reference' }); continue; }
        let cwd;
        try {
            cwd = fs.realpathSync.native(turn.cwd);
            if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('Outside run');
        } catch { result.problems.push({ code: 'TRANSCRIPT_CWD_OUTSIDE_RUN', ...entry }); continue; }
        const key = JSON.stringify([turn.runtime, turn.sessionRef, cwd]);
        if (sessions.has(key)) continue;
        sessions.add(key);
        try {
            const runtime = registry.get(turn.runtime);
            if (typeof runtime.readTranscript !== 'function') { result.transcripts.push({ ...entry, status: 'unsupported' }); continue; }
            const found = await runtime.readTranscript({ sessionId: turn.sessionRef, cwd, ...(turn.startedAt ? { since: turn.startedAt } : {}) });
            if (!found.found || !found.file) { result.transcripts.push({ ...entry, status: 'unavailable' }); continue; }
            if (found.sessionId !== turn.sessionRef) throw Object.assign(new Error('Transcript mismatch'), { code: 'TRANSCRIPT_IDENTITY_MISMATCH' });
            const name = `transcripts/${result.transcripts.length}.jsonl`;
            const copied = copyPrivateEvidence(found.file, path.join(destination, name));
            result.transcripts.push({ ...entry, status: 'copied', archive: name, ...copied });
        } catch (error) { result.problems.push({ code: error.code || 'TRANSCRIPT_READ_FAILED', ...entry }); }
    }
    return result;
}

module.exports = { archiveAcceptanceEvidence };
