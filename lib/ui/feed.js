'use strict';

// Timeline feed for `omni ui` (SPEC-SQUAD-P6 §3): tails the authority ledger and
// the discussion journals read-only, and turns each record into a short,
// display-safe entry. A cursor (lines consumed per file) lets an SSE client
// resume with Last-Event-ID. Partial trailing lines are left for the next read.

const fs = require('node:fs');
const path = require('node:path');

const LEDGER = path.join('.omni', 'runs', 'dual-authority', 'events.ndjson');
const DISCUSSION_DIR = path.join('.omni', 'runs', 'dual-discussion');
const MAX_TEXT = 600;
const LEDGER_FIELDS = ['task_id', 'gate_id', 'phase', 'attempt', 'verdict', 'status', 'code', 'owner', 'state', 'to_state',
    'actor', 'via', 'worker', 'runtime', 'model', 'reason', 'summary', 'findings_count'];

const clip = (value, max = MAX_TEXT) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
};

// Complete lines of a file from `from` on; the trailing partial line is not consumed.
function completeLines(file, from) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return { lines: [], count: from }; }
    const end = content.lastIndexOf('\n');
    if (end === -1) return { lines: [], count: from };
    const all = content.slice(0, end).split('\n');
    return { lines: all.slice(from), count: all.length };
}

function journalFiles(root, dir = path.join(root, DISCUSSION_DIR), depth = 0, found = []) {
    if (depth > 4) return found;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) journalFiles(root, full, depth + 1, found);
        else if (entry.name === 'journal.jsonl') found.push(path.relative(root, full).split(path.sep).join('/'));
    }
    return found.sort();
}

function ledgerEntry(line) {
    let record;
    try { record = JSON.parse(line); } catch { return null; }
    const event = record && (record.event || record);
    if (!event || typeof event.type !== 'string') return null;
    const fields = {};
    for (const key of LEDGER_FIELDS) if (event[key] !== undefined && event[key] !== null) fields[key] = clip(event[key], 300);
    return { source: 'ledger', type: event.type, at: event.timestamp || null, sequence: event.sequence ?? null, fields };
}

function journalEntry(line, file) {
    let record;
    try { record = JSON.parse(line); } catch { return null; }
    const event = record && record.event;
    if (!event || typeof event !== 'object') return null;
    const envelope = event.envelope || event.response_envelope;
    const type = event.type || (event.envelope ? 'message' : event.response_envelope ? 'reply' : 'record');
    const fields = {};
    for (const key of ['completion', 'discussion_result', 'invocation_id', 'schema', 'evidence_ref']) {
        if (event[key] !== undefined) fields[key] = clip(event[key], 200);
    }
    if (envelope) {
        if (envelope.kind) fields.kind = clip(envelope.kind, 40);
        if (envelope.body !== undefined) fields.body = clip(envelope.body);
    }
    return { source: 'discussion', type, at: record.timestamp ? new Date(record.timestamp).toISOString() : null,
        journal: file, fields };
}

function encodeCursor(cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }

function decodeCursor(text) {
    try {
        const value = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
        if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.l) || value.l < 0 || typeof value.j !== 'object') return null;
        return { l: value.l, j: Object.fromEntries(Object.entries(value.j).filter(([, n]) => Number.isSafeInteger(n) && n >= 0)) };
    } catch {
        return null;
    }
}

// New entries since `cursor` (null = from the start); each entry carries the
// cursor right after it, so a client can resume at any entry.
function readSince(projectRoot, cursor = null) {
    const next = { l: cursor?.l ?? 0, j: { ...(cursor?.j || {}) } };
    const entries = [];
    const ledger = completeLines(path.join(projectRoot, LEDGER), next.l);
    ledger.lines.forEach((line) => {
        next.l += 1;
        const entry = ledgerEntry(line);
        if (entry) entries.push({ ...entry, cursor: encodeCursor(next) });
    });
    next.l = Math.max(next.l, ledger.count);
    for (const file of journalFiles(projectRoot)) {
        const read = completeLines(path.join(projectRoot, file), next.j[file] ?? 0);
        read.lines.forEach((line) => {
            next.j[file] = (next.j[file] ?? 0) + 1;
            const entry = journalEntry(line, file);
            if (entry) entries.push({ ...entry, cursor: encodeCursor(next) });
        });
        next.j[file] = Math.max(next.j[file] ?? 0, read.count);
    }
    return { entries, cursor: next };
}

module.exports = { readSince, encodeCursor, decodeCursor, journalFiles, LEDGER };
