'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const {
    DiscussionError,
    CEILINGS,
    isPlainObject,
    cloneAndFreeze,
    canonicalizeJson,
    sha256Canonical,
    validateSafePositiveInt,
    validateSafeNonNegativeInt,
    validateSha256,
} = require('./contracts');

const LOCK_FILENAME = 'owner.lock';
const JOURNAL_FILENAME = 'journal.jsonl';
const ALLOWED_ENTRIES = new Set([LOCK_FILENAME, JOURNAL_FILENAME]);
const ALLOWED_EVENT_TYPES = new Set([
    'registered',
    'received',
    'dispatch_intent',
    'observation',
    'response',
    'outcome_unknown',
    'reconciled',
]);
const ZERO_HASH = '0'.repeat(64);

function resolveJournalCaps({ maxBytes, maxEvents } = {}) {
    const resolvedMaxBytes = maxBytes === undefined ? CEILINGS.maxJournalBytes : validateSafePositiveInt(maxBytes, 'maxBytes');
    const resolvedMaxEvents = maxEvents === undefined ? CEILINGS.maxEvents : validateSafePositiveInt(maxEvents, 'maxEvents');
    if (resolvedMaxBytes > CEILINGS.maxJournalBytes) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxBytes exceeds ceiling 8 MiB');
    }
    if (resolvedMaxEvents > CEILINGS.maxEvents) {
        throw new DiscussionError('LIMIT_EXCEEDED', 'maxEvents exceeds ceiling 256');
    }
    return { maxBytes: resolvedMaxBytes, maxEvents: resolvedMaxEvents };
}

async function validateStateDirPath(stateDir, { createIfMissing = false } = {}) {
    if (typeof stateDir !== 'string' || stateDir.trim().length === 0 || stateDir.includes('\u0000')) {
        throw new DiscussionError('INVALID_INPUT', 'stateDir must be a non-empty string path');
    }
    const resolved = path.resolve(stateDir);
    let stat;
    try {
        stat = await fsp.lstat(resolved);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            if (!createIfMissing) {
                return { exists: false, resolved };
            }
            await fsp.mkdir(resolved, { recursive: true });
            stat = await fsp.lstat(resolved);
        } else {
            throw new DiscussionError('JOURNAL_INVALID', `Unable to stat stateDir: ${err.message}`);
        }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new DiscussionError('JOURNAL_INVALID', 'stateDir must be a real directory, not a symlink or file');
    }
    const entries = await fsp.readdir(resolved);
    for (const entry of entries) {
        if (!ALLOWED_ENTRIES.has(entry)) {
            throw new DiscussionError('JOURNAL_INVALID', `stateDir contains unexpected entry '${entry}'`);
        }
        const entryPath = path.join(resolved, entry);
        const entryStat = await fsp.lstat(entryPath);
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
            throw new DiscussionError('JOURNAL_INVALID', `Entry '${entry}' must be a regular file`);
        }
    }
    return { exists: true, resolved };
}

function computeRecordHash({ index, timestamp, prev_hash: prevHash, event }) {
    return sha256Canonical({
        schema_version: 1,
        index,
        timestamp,
        prev_hash: prevHash,
        event,
    });
}

function parseAndValidateJournalContent(content, { maxBytes, maxEvents }) {
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > maxBytes) {
        throw new DiscussionError('JOURNAL_INVALID', 'Existing journal exceeds maxBytes');
    }
    if (content.length === 0) {
        return {
            events: [],
            byteLength: 0,
            lastHash: ZERO_HASH,
            unresolvedInvocations: [],
            hasUnresolvedUnknown: false,
        };
    }
    if (!content.endsWith('\n')) {
        throw new DiscussionError('JOURNAL_INVALID', 'Journal has a torn or incomplete final record');
    }
    const rawLines = content.slice(0, -1).split('\n');
    if (rawLines.length > maxEvents) {
        throw new DiscussionError('JOURNAL_INVALID', 'Existing journal exceeds maxEvents');
    }
    const events = [];
    let expectedPrevHash = ZERO_HASH;
    const unresolvedByInvocation = new Map();

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (line.length === 0 || line.endsWith('\r')) {
            throw new DiscussionError('JOURNAL_INVALID', `Invalid or empty line at record ${i + 1}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (err) {
            throw new DiscussionError('JOURNAL_INVALID', `Malformed JSON at record ${i + 1}: ${err.message}`);
        }
        if (!isPlainObject(parsed)) {
            throw new DiscussionError('JOURNAL_INVALID', `Record ${i + 1} must be a plain object`);
        }
        const keys = Object.keys(parsed);
        if (
            keys.length !== 6
            || parsed.schema_version !== 1
            || parsed.index !== i + 1
            || typeof parsed.timestamp !== 'number'
            || !Number.isSafeInteger(parsed.timestamp)
            || parsed.timestamp < 0
            || typeof parsed.prev_hash !== 'string'
            || typeof parsed.record_hash !== 'string'
            || !isPlainObject(parsed.event)
        ) {
            throw new DiscussionError('JOURNAL_INVALID', `Record ${i + 1} has invalid envelope shape or index`);
        }
        validateSha256(parsed.prev_hash, `record[${i + 1}].prev_hash`);
        validateSha256(parsed.record_hash, `record[${i + 1}].record_hash`);
        if (parsed.prev_hash !== expectedPrevHash) {
            throw new DiscussionError('JOURNAL_INVALID', `Hash chain mismatch at record ${i + 1}`);
        }
        const ev = parsed.event;
        if (typeof ev.type !== 'string' || !ALLOWED_EVENT_TYPES.has(ev.type)) {
            throw new DiscussionError('JOURNAL_INVALID', `Unsupported event type at record ${i + 1}`);
        }
        const expectedRecordHash = computeRecordHash(parsed);
        if (parsed.record_hash !== expectedRecordHash) {
            throw new DiscussionError('JOURNAL_INVALID', `Record hash tamper detected at record ${i + 1}`);
        }

        if (ev.type === 'dispatch_intent') {
            if (typeof ev.invocation_id !== 'string' || typeof ev.message_id !== 'string') {
                throw new DiscussionError('JOURNAL_INVALID', `Invalid dispatch_intent at record ${i + 1}`);
            }
            unresolvedByInvocation.set(ev.invocation_id, {
                invocation_id: ev.invocation_id,
                message_id: ev.message_id,
                binding_ref: ev.binding_ref || null,
                reason: 'in_flight_after_intent',
                index: parsed.index,
            });
        } else if (ev.type === 'observation') {
            if (
                typeof ev.invocation_id === 'string'
                && (ev.completion === 'failed' || ev.discussion_result === 'rejected')
            ) {
                const current = unresolvedByInvocation.get(ev.invocation_id);
                if (current && current.reason === 'in_flight_after_intent') {
                    unresolvedByInvocation.delete(ev.invocation_id);
                }
            }
        } else if (ev.type === 'response') {
            if (typeof ev.invocation_id === 'string') {
                const current = unresolvedByInvocation.get(ev.invocation_id);
                if (current && current.reason === 'in_flight_after_intent') {
                    unresolvedByInvocation.delete(ev.invocation_id);
                }
            }
        } else if (ev.type === 'outcome_unknown') {
            const invId = ev.invocation_id || `unknown-at-${parsed.index}`;
            unresolvedByInvocation.set(invId, {
                invocation_id: invId,
                message_id: ev.message_id || null,
                binding_ref: ev.binding_ref || null,
                reason: ev.reason || 'outcome_unknown',
                index: parsed.index,
            });
        } else if (ev.type === 'reconciled') {
            if (typeof ev.invocation_id === 'string') {
                unresolvedByInvocation.delete(ev.invocation_id);
            }
        }

        expectedPrevHash = parsed.record_hash;
        events.push(cloneAndFreeze(parsed));
    }

    const unresolvedInvocations = [...unresolvedByInvocation.values()].map((item) => cloneAndFreeze(item));
    return {
        events: Object.freeze(events),
        byteLength,
        lastHash: expectedPrevHash,
        unresolvedInvocations: Object.freeze(unresolvedInvocations),
        hasUnresolvedUnknown: unresolvedInvocations.length > 0,
    };
}

async function readLockMetadata(lockPath) {
    if (!fs.existsSync(lockPath)) {
        return { locked: false, owner: null };
    }
    const stat = await fsp.lstat(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new DiscussionError('JOURNAL_INVALID', 'owner.lock must be a regular file');
    }
    let owner = null;
    try {
        const raw = await fsp.readFile(lockPath, 'utf8');
        if (raw.trim().length > 0) {
            owner = cloneAndFreeze(JSON.parse(raw));
        }
    } catch {
        owner = null;
    }
    return { locked: true, owner };
}

async function inspectJournal(options = {}) {
    if (!isPlainObject(options)) {
        throw new DiscussionError('INVALID_INPUT', 'inspectJournal options must be a plain object');
    }
    const { maxBytes, maxEvents } = resolveJournalCaps(options);
    const { exists, resolved } = await validateStateDirPath(options.stateDir, { createIfMissing: false });
    if (!exists) {
        return cloneAndFreeze({
            locked: false,
            owner: null,
            events: [],
            byteLength: 0,
            lastHash: ZERO_HASH,
            unresolvedInvocations: [],
            hasUnresolvedUnknown: false,
        });
    }
    const lockPath = path.join(resolved, LOCK_FILENAME);
    const journalPath = path.join(resolved, JOURNAL_FILENAME);
    const { locked, owner } = await readLockMetadata(lockPath);

    let content = '';
    if (fs.existsSync(journalPath)) {
        const jStat = await fsp.lstat(journalPath);
        if (jStat.isSymbolicLink() || !jStat.isFile()) {
            throw new DiscussionError('JOURNAL_INVALID', 'journal.jsonl must be a regular file');
        }
        if (jStat.size > maxBytes) {
            throw new DiscussionError('JOURNAL_INVALID', 'journal.jsonl exceeds maxBytes');
        }
        content = await fsp.readFile(journalPath, 'utf8');
    }
    const state = parseAndValidateJournalContent(content, { maxBytes, maxEvents });
    return cloneAndFreeze({
        locked,
        owner,
        ...state,
    });
}

async function openJournal(options = {}) {
    if (!isPlainObject(options)) {
        throw new DiscussionError('INVALID_INPUT', 'openJournal options must be a plain object');
    }
    const { maxBytes, maxEvents } = resolveJournalCaps(options);
    const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    const syncHook = typeof options.syncHook === 'function' ? options.syncHook : null;

    const { resolved } = await validateStateDirPath(options.stateDir, { createIfMissing: true });
    const lockPath = path.join(resolved, LOCK_FILENAME);
    const journalPath = path.join(resolved, JOURNAL_FILENAME);

    const ownerToken = crypto.randomBytes(16).toString('hex');
    const startedAt = validateSafeNonNegativeInt(clock(), 'clock()');
    const ownerMeta = {
        schema_version: 1,
        owner_token: ownerToken,
        pid: process.pid,
        started_at: startedAt,
    };

    let lockHandle;
    try {
        lockHandle = await fsp.open(lockPath, 'wx', 0o600);
    } catch (err) {
        if (err && err.code === 'EEXIST') {
            throw new DiscussionError('OWNER_BUSY', 'stateDir is already locked by an active or unresolved owner');
        }
        throw new DiscussionError('JOURNAL_INVALID', `Failed to acquire owner.lock: ${err.message}`);
    }

    try {
        await lockHandle.writeFile(`${canonicalizeJson(ownerMeta)}\n`, 'utf8');
        await lockHandle.sync();
    } finally {
        await lockHandle.close();
    }

    let initialState;
    let journalHandle;
    try {
        let existingContent = '';
        if (fs.existsSync(journalPath)) {
            const stat = await fsp.lstat(journalPath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new DiscussionError('JOURNAL_INVALID', 'journal.jsonl is not a regular file');
            }
            if (stat.size > maxBytes) {
                throw new DiscussionError('JOURNAL_INVALID', 'journal.jsonl exceeds maxBytes');
            }
            existingContent = await fsp.readFile(journalPath, 'utf8');
        }
        initialState = parseAndValidateJournalContent(existingContent, { maxBytes, maxEvents });
        journalHandle = await fsp.open(journalPath, 'a', 0o600);
        await journalHandle.sync();
    } catch (err) {
        if (journalHandle) {
            try { await journalHandle.close(); } catch { /* ignore */ }
        }
        if (err instanceof DiscussionError) {
            throw err;
        }
        throw new DiscussionError('JOURNAL_INVALID', `Failed to open journal: ${err.message}`);
    }

    const records = [...initialState.events];
    let currentBytes = initialState.byteLength;
    let lastHash = initialState.lastHash;
    let closed = false;
    let poisoned = false;
    let handleClosed = false;
    let queue = Promise.resolve();

    async function safeCloseJournalHandle() {
        if (!handleClosed && journalHandle) {
            handleClosed = true;
            try {
                await journalHandle.close();
            } catch {
                // ignore close errors on poisoned handle
            }
        }
    }

    function enqueue(fn) {
        const next = queue.then(fn, fn);
        queue = next.catch(() => {});
        return next;
    }

    async function appendInternal(clonedEvent) {
        if (closed) {
            throw new DiscussionError('RELAY_CLOSED', 'Journal is already closed');
        }
        if (poisoned) {
            throw new DiscussionError('JOURNAL_INVALID', 'Journal is poisoned due to prior write/sync failure');
        }
        const now = validateSafeNonNegativeInt(clock(), 'clock()');
        const index = records.length + 1;
        const prevHash = lastHash;
        const recordHash = computeRecordHash({
            index,
            timestamp: now,
            prev_hash: prevHash,
            event: clonedEvent,
        });
        const record = Object.freeze({
            schema_version: 1,
            index,
            timestamp: now,
            prev_hash: prevHash,
            record_hash: recordHash,
            event: clonedEvent,
        });

        const serializedLine = `${canonicalizeJson(record)}\n`;
        const lineBytes = Buffer.byteLength(serializedLine, 'utf8');

        // Pre-write quota checks: throw LIMIT_EXCEEDED without poisoning
        if (index > maxEvents) {
            throw new DiscussionError('LIMIT_EXCEEDED', `Journal event count exceeds ceiling ${maxEvents}`);
        }
        if (currentBytes + lineBytes > maxBytes) {
            throw new DiscussionError('LIMIT_EXCEEDED', `Journal byte size exceeds ceiling ${maxBytes}`);
        }

        try {
            if (syncHook) {
                await syncHook({ index, event: clonedEvent });
            }
            const buf = Buffer.from(serializedLine, 'utf8');
            const { bytesWritten } = await journalHandle.write(buf, 0, buf.length);
            if (bytesWritten !== buf.length) {
                throw new Error('Short write to journal');
            }
            await journalHandle.sync();
        } catch (err) {
            poisoned = true;
            throw new DiscussionError('JOURNAL_INVALID', `Durable journal write/sync failed: ${err.message}`);
        }

        records.push(record);
        currentBytes += lineBytes;
        lastHash = recordHash;
        return record;
    }

    async function readInternal() {
        const content = records.map((r) => `${canonicalizeJson(r)}\n`).join('');
        const parsed = parseAndValidateJournalContent(content, { maxBytes, maxEvents });
        return cloneAndFreeze({
            locked: !closed || poisoned,
            owner: ownerMeta,
            ...parsed,
        });
    }

    async function closeInternal(closeOpts = {}) {
        if (!isPlainObject(closeOpts)) {
            throw new DiscussionError('INVALID_INPUT', 'close options must be a plain object');
        }
        if (closeOpts.releaseToken !== undefined && closeOpts.releaseToken !== ownerToken) {
            throw new DiscussionError('OWNER_BUSY', 'Cannot close journal with mismatched owner token');
        }
        if (poisoned) {
            if (!closed) {
                closed = true;
                await safeCloseJournalHandle();
            }
            throw new DiscussionError('JOURNAL_INVALID', 'Journal is poisoned; retaining owner.lock');
        }
        if (closed) {
            return;
        }

        if (closeOpts.retainLock === true) {
            closed = true;
            try {
                await journalHandle.sync();
            } finally {
                await safeCloseJournalHandle();
            }
            return;
        }

        try {
            if (syncHook) {
                await syncHook();
            }
            await journalHandle.sync();
            await safeCloseJournalHandle();
            const currentLock = await readLockMetadata(lockPath);
            if (!currentLock.locked || !currentLock.owner || currentLock.owner.owner_token !== ownerToken) {
                poisoned = true;
                throw new DiscussionError('OWNER_BUSY', 'owner.lock token mismatch on release');
            }
            await fsp.unlink(lockPath);
            closed = true;
        } catch (err) {
            poisoned = true;
            closed = true;
            await safeCloseJournalHandle();
            if (err instanceof DiscussionError) {
                throw err;
            }
            throw new DiscussionError('JOURNAL_INVALID', `Failed to cleanly close journal: ${err.message}`);
        }
    }

    return Object.freeze({
        get ownerToken() {
            return ownerToken;
        },
        append(event) {
            let clonedEvent;
            try {
                if (!isPlainObject(event) || typeof event.type !== 'string' || !ALLOWED_EVENT_TYPES.has(event.type)) {
                    throw new DiscussionError('INVALID_INPUT', 'Journal event must be a plain object with a valid type');
                }
                clonedEvent = cloneAndFreeze(event);
            } catch (err) {
                return Promise.reject(err);
            }
            return enqueue(() => appendInternal(clonedEvent));
        },
        read() {
            return enqueue(() => readInternal());
        },
        close(closeOpts = {}) {
            let clonedCloseOpts;
            try {
                if (!isPlainObject(closeOpts)) {
                    throw new DiscussionError('INVALID_INPUT', 'close options must be a plain object');
                }
                clonedCloseOpts = cloneAndFreeze(closeOpts);
            } catch (err) {
                return Promise.reject(err);
            }
            return enqueue(() => closeInternal(clonedCloseOpts));
        },
    });
}

module.exports = Object.freeze({
    openJournal,
    inspectJournal,
});
