'use strict';

// Orchestrator transcripts (SPEC-SQUAD-P6 §6, V41): bounded, incremental reads of
// the session file an interactive CLI writes, turned into user/assistant/tool
// entries for the `omni ui` timeline. Unknown or broken lines are skipped; any
// read problem yields no entries rather than an error (plan §4.3).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_READ_BYTES = 1024 * 1024;
const MAX_TEXT = 4000;

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

// Complete JSON lines of `file` from byte `offset` on, at most MAX_READ_BYTES;
// the offset only moves past whole lines, so a line being written is read later.
// `ends[i]` is the byte offset just after records[i], so a reader can resume there.
function readJsonl(file, offset = 0, { fsImpl = fs, maxBytes = MAX_READ_BYTES } = {}) {
    let fd;
    try {
        const size = fsImpl.statSync(file).size;
        if (offset >= size) return { records: [], ends: [], offset: Math.min(offset, size) };
        const length = Math.min(size - offset, maxBytes);
        const buffer = Buffer.alloc(length);
        fd = fsImpl.openSync(file, 'r');
        fsImpl.readSync(fd, buffer, 0, length, offset);
        const end = buffer.lastIndexOf(0x0a);
        if (end === -1) {
            // One line longer than the read window cannot be shown; step over it.
            return { records: [], ends: [], offset: length === maxBytes ? offset + length : offset };
        }
        const records = [];
        const ends = [];
        let start = 0;
        while (start <= end) {
            const stop = buffer.indexOf(0x0a, start);
            const line = buffer.subarray(start, stop).toString('utf8');
            start = stop + 1;
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line)); ends.push(offset + start); } catch { /* skip a broken line */ }
        }
        return { records, ends, offset: offset + end + 1 };
    } catch {
        return { records: [], ends: [], offset };
    } finally {
        if (fd !== undefined) fsImpl.closeSync(fd);
    }
}

const realpath = (dir, fsImpl = fs) => { try { return fsImpl.realpathSync.native(dir); } catch { return path.resolve(dir); } };

// ---------------------------------------------------------------- claude ----

function claudeRoot(ctx = {}) {
    const env = ctx.env || process.env;
    return env.CLAUDE_CONFIG_DIR || path.join(ctx.homedir || os.homedir(), '.claude');
}

// ~/.claude/projects/<cwd with every char outside [A-Za-z0-9-] as '-'>/<session>.jsonl (V41).
function claudeTranscriptFile(sessionId, cwd, ctx = {}) {
    const fsImpl = ctx.fsImpl || fs;
    const projects = path.join(claudeRoot(ctx), 'projects');
    const direct = path.join(projects, realpath(cwd, fsImpl).replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`);
    if (fsImpl.existsSync(direct)) return direct;
    // Long paths get a shortened folder name: look for the one file with this id.
    try {
        for (const dir of fsImpl.readdirSync(projects)) {
            const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
            if (fsImpl.existsSync(candidate)) return candidate;
        }
    } catch { /* no projects folder yet */ }
    return null;
}

function claudeEntries(records, ends = []) {
    const entries = [];
    for (const [index, record] of records.entries()) {
        if (!['user', 'assistant'].includes(record.type) || record.isMeta || record.isSidechain || !record.message) continue;
        const { content } = record.message;
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
        const text = blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim();
        const base = { id: record.uuid || null, at: record.timestamp || null, end: ends[index] ?? null };
        if (record.type === 'user') {
            // Tool results and slash-command echoes are not the person talking.
            if (!text || /^<(command-|local-command-)/.test(text)) continue;
            entries.push({ ...base, role: 'user', text: clip(text) });
            continue;
        }
        if (text) entries.push({ ...base, role: 'assistant', text: clip(text) });
        for (const block of blocks) {
            if (block && block.type === 'tool_use' && typeof block.name === 'string') entries.push({ ...base, role: 'tool', text: block.name.slice(0, 120) });
        }
    }
    return entries;
}

function readClaudeTranscript(ref = {}, ctx = {}) {
    const fsImpl = ctx.fsImpl || fs;
    const file = ref.cursor?.file || (ref.sessionId && ref.cwd ? claudeTranscriptFile(ref.sessionId, ref.cwd, ctx) : null);
    if (!file) return { found: false, sessionId: ref.sessionId || null, entries: [], cursor: ref.cursor || null };
    const { records, ends, offset } = readJsonl(file, ref.cursor?.offset || 0, { fsImpl });
    return { found: true, sessionId: ref.sessionId || null, file, entries: claudeEntries(records, ends), cursor: { file, offset } };
}

// ----------------------------------------------------------------- codex ----

function codexRoot(ctx = {}) {
    const env = ctx.env || process.env;
    return env.CODEX_HOME || path.join(ctx.homedir || os.homedir(), '.codex');
}

// Day folders sessions/YYYY/MM/DD from `since` (UTC and local, since codex names
// them by local date) through today.
function dayFolders(root, since, now = new Date()) {
    const start = new Date(since.getTime() - 24 * 3600 * 1000);
    const folders = new Set();
    for (let day = new Date(start); day <= new Date(now.getTime() + 24 * 3600 * 1000); day = new Date(day.getTime() + 24 * 3600 * 1000)) {
        const pad = (n) => String(n).padStart(2, '0');
        folders.add(path.join(root, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())));
        folders.add(path.join(root, 'sessions', String(day.getUTCFullYear()), pad(day.getUTCMonth() + 1), pad(day.getUTCDate())));
    }
    return [...folders];
}

// Only rollouts that could be ours are opened, and only their first line is read:
// the session_meta must name this project and start after the PTY did.
function findCodexRollout({ sessionId, cwd, since }, ctx = {}) {
    const fsImpl = ctx.fsImpl || fs;
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    if (Number.isNaN(sinceDate.getTime())) return null;
    const wantedCwd = cwd ? realpath(cwd, fsImpl) : null;
    let best = null;
    for (const folder of dayFolders(codexRoot(ctx), sinceDate, ctx.now ? ctx.now() : new Date())) {
        let names;
        try { names = fsImpl.readdirSync(folder); } catch { continue; }
        for (const name of names) {
            if (!/^rollout-.*\.jsonl$/.test(name)) continue;
            const file = path.join(folder, name);
            if (sessionId) {
                if (name.includes(sessionId)) return { file, sessionId };
                continue;
            }
            try { if (fsImpl.statSync(file).mtimeMs < sinceDate.getTime() - 5000) continue; } catch { continue; }
            const meta = readJsonl(file, 0, { fsImpl, maxBytes: 256 * 1024 }).records[0];
            const payload = meta && meta.type === 'session_meta' ? meta.payload : null;
            if (!payload || typeof payload.cwd !== 'string' || realpath(payload.cwd, fsImpl) !== wantedCwd) continue;
            const started = new Date(payload.timestamp || meta.timestamp).getTime();
            if (!(started >= sinceDate.getTime() - 5000)) continue;
            if (!best || started < best.started) best = { file, sessionId: payload.id || payload.session_id || null, started };
        }
    }
    return best ? { file: best.file, sessionId: best.sessionId } : null;
}

function codexText(content) {
    return (Array.isArray(content) ? content : []).filter((part) => part && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
}

function codexEntries(records, ends = []) {
    const entries = [];
    for (const [index, record] of records.entries()) {
        const payload = record && record.type === 'event_msg' ? record.payload : null;
        if (!payload) continue;
        const at = record.timestamp || null;
        const end = ends[index] ?? null;
        if (payload.type === 'item_completed' && payload.item) {
            const { item } = payload;
            const text = codexText(item.content);
            if (item.type === 'UserMessage' && text) entries.push({ id: item.id || null, at, end, role: 'user', text: clip(text) });
            if (item.type === 'AgentMessage' && text) entries.push({ id: item.id || null, at, end, role: 'assistant', text: clip(text), ...(item.phase ? { phase: item.phase } : {}) });
        } else if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
            entries.push({ id: null, at, end, role: 'user', text: clip(payload.message.trim()) });
        } else if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
            entries.push({ id: null, at, end, role: 'assistant', text: clip(payload.message.trim()) });
        }
    }
    return entries;
}

function readCodexTranscript(ref = {}, ctx = {}) {
    const fsImpl = ctx.fsImpl || fs;
    let file = ref.cursor?.file || null;
    let sessionId = ref.sessionId || null;
    if (!file) {
        const found = findCodexRollout({ sessionId, cwd: ref.cwd, since: ref.since }, ctx);
        if (!found) return { found: false, sessionId, entries: [], cursor: null };
        ({ file } = found);
        sessionId = sessionId || found.sessionId;
    }
    const { records, ends, offset } = readJsonl(file, ref.cursor?.offset || 0, { fsImpl });
    if (!sessionId) {
        const meta = records.find((record) => record.type === 'session_meta');
        sessionId = meta?.payload?.id || null;
    }
    return { found: true, sessionId, file, entries: codexEntries(records, ends), cursor: { file, offset } };
}

module.exports = { readJsonl, claudeTranscriptFile, readClaudeTranscript, findCodexRollout, readCodexTranscript, MAX_TEXT };
