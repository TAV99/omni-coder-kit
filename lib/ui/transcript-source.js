'use strict';

// The orchestrator transcript for the `omni ui` timeline (SPEC-SQUAD-P6 §6, D13).
// Only the session this UI started is read. The browser's cursor holds a hash of
// the file and a byte offset, never a path: the server always picks the file.

const crypto = require('node:crypto');
const { defaultRegistry } = require('../squad/runtimes');

const fileKey = (file) => crypto.createHash('sha256').update(file).digest('hex').slice(0, 32);

function createTranscriptSource({ projectRoot, sessionRef, recordSession = () => {}, registry = defaultRegistry, ctx = {} }) {
    let located = null; // { refKey, file, sessionId }

    // New entries after `cursor` ({ k, o }); each entry carries the cursor right after it.
    function read(cursor) {
        const ref = sessionRef();
        if (!ref || !ref.runtime) return { entries: [], cursor: cursor || null };
        let runtime;
        try { runtime = registry.get(ref.runtime); } catch { return { entries: [], cursor: cursor || null }; }
        if (typeof runtime.readTranscript !== 'function') return { entries: [], cursor: cursor || null };
        const refKey = `${ref.runtime}:${ref.session_id || ''}:${ref.started_at || ''}`;
        const base = { sessionId: ref.session_id || null, cwd: projectRoot, since: ref.started_at || null };
        let result;
        try {
            if (located && located.refKey === refKey) {
                const offset = cursor && cursor.k === fileKey(located.file) ? cursor.o : 0;
                result = runtime.readTranscript({ ...base, sessionId: located.sessionId || base.sessionId, cursor: { file: located.file, offset } }, ctx);
            } else {
                result = runtime.readTranscript(base, ctx);
                if (result.found) {
                    located = { refKey, file: result.file, sessionId: result.sessionId };
                    // The client already has this file up to its offset (a reload, or a resumed session).
                    if (cursor && cursor.k === fileKey(result.file) && cursor.o > 0) {
                        result = runtime.readTranscript({ ...base, cursor: { file: result.file, offset: cursor.o } }, ctx);
                    }
                }
            }
        } catch {
            return { entries: [], cursor: cursor || null };
        }
        if (!result.found) return { entries: [], cursor: cursor || null };
        if (!ref.session_id && result.sessionId) recordSession(ref.runtime, result.sessionId);
        const k = fileKey(result.file);
        const entries = result.entries.map(({ end, role, text, at, phase }) => ({
            source: 'transcript', type: role, at, fields: { body: text, runtime: ref.runtime, ...(phase ? { phase } : {}) },
            cursor: { k, o: end ?? result.cursor.offset },
        }));
        return { entries, cursor: { k, o: result.cursor.offset } };
    }

    return { read };
}

module.exports = { createTranscriptSource, fileKey };
