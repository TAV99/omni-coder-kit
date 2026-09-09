'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EnvelopeSchema, computeEventHash } = require('./authority-store');

function decodeLedgerRecord(raw, previousHash) {
    if (raw && typeof raw === 'object' && raw.event && raw.previous_hash && raw.event_hash) {
        const parsed = EnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
            const error = new Error('Malformed authority ledger envelope');
            error.code = 'DUAL_OBSERVER_ENVELOPE_INVALID';
            throw error;
        }
        const envelope = parsed.data;
        if (envelope.previous_hash !== previousHash) {
            const error = new Error('Authority ledger hash chain is broken');
            error.code = 'DUAL_OBSERVER_HASH_CHAIN_BROKEN';
            throw error;
        }
        const expectedHash = computeEventHash(envelope.previous_hash, envelope.event);
        if (expectedHash !== envelope.event_hash) {
            const error = new Error('Authority ledger event hash is invalid');
            error.code = 'DUAL_OBSERVER_HASH_INVALID';
            throw error;
        }
        const event = { ...envelope.event };
        Object.defineProperty(event, 'previous_hash', { value: envelope.previous_hash, enumerable: true });
        Object.defineProperty(event, 'event_hash', { value: envelope.event_hash, enumerable: true });
        return { event, nextHash: envelope.event_hash, envelope };
    }
    // Read pre-envelope/legacy ledgers for diagnostics only. They do not grant
    // authority and are intentionally not used for hash-chain state.
    return { event: raw, nextHash: previousHash, envelope: null };
}

/**
 * Formats a Dual Authority event for human-readable console display.
 */
function formatEvent(evt) {
    const seq = evt.sequence ?? '-';
    const type = evt.type || 'unknown';
    const time = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString('vi-VN') : '--:--:--';
    const taskId = evt.task_id ? ` [${evt.task_id}]` : '';

    let detail = '';
    switch (type) {
        case 'session.created':
            detail = `Session created (ID: ${evt.session_id}, Mode: ${evt.mode})`;
            break;
        case 'session.blocked':
            detail = `SESSION BLOCKED (${evt.blocker_code}): ${evt.reason}`;
            break;
        case 'session.verified':
            detail = `SESSION VERIFIED (receipt SHA: ${evt.receipt_sha256?.slice(0, 12)})`;
            break;
        case 'capability.result':
            detail = `Capability preflight: ${evt.status}`;
            break;
        case 'plan.registered':
            detail = `Plan registered (rev ${evt.plan_revision}, ${evt.total_tasks} tasks${evt.acceptance_policy ? ', with acceptance policy' : ''})`;
            break;
        case 'task.routed':
            detail = `Routed to ${evt.owner} (${evt.authority_state})`;
            break;
        case 'task.lease_acquired':
            detail = `Lease acquired by ${evt.assigned_worker} (TTL: ${evt.ttl_ms}ms)`;
            break;
        case 'lease.acquired':
            detail = `Lease acquired by ${evt.owner} (TTL: ${evt.ttl_ms}ms)`;
            break;
        case 'task.lease_released':
            detail = `Lease released: ${evt.reason}`;
            break;
        case 'lease.released':
            detail = `Lease released: ${evt.reason}`;
            break;
        case 'task.lease_renewed':
            detail = `Lease renewed (attempt ${evt.attempt})`;
            break;
        case 'lease.renewed':
            detail = `Lease renewed (TTL: ${evt.ttl_ms}ms)`;
            break;
        case 'task.context_question':
            detail = `Worker question: ${evt.question}`;
            break;
        case 'task.context_answered':
            detail = `Question answered`;
            break;
        case 'task.handoff_submitted':
            detail = `Handoff submitted (attempt ${evt.attempt}) -> ready for QC`;
            break;
        case 'task.process.started':
            detail = `Process started: ${evt.command} (PID ${evt.pid})`;
            break;
        case 'task.process.exited':
            detail = `Process exited: ${evt.command} (code ${evt.exit_code}${evt.signal ? ', signal ' + evt.signal : ''})`;
            break;
        case 'gate.result':
            detail = `Gate ${evt.gate_id}: ${evt.status}`;
            break;
        case 'task.completed':
            detail = `Task COMPLETED (outcome: ${evt.outcome})`;
            break;
        case 'task.failed':
            detail = `Task FAILED: ${evt.reason}`;
            break;
        case 'acceptance.correction.started':
            detail = `Acceptance correction started (attempt ${evt.attempt}): ${evt.reason}`;
            break;
        case 'acceptance.correction.completed':
            detail = `Acceptance correction completed: ${evt.status}`;
            break;
        case 'quality.generation.invalidated':
            detail = `Quality generation invalidated: ${evt.previous_fingerprint?.slice(0, 12)} -> ${evt.new_fingerprint?.slice(0, 12)}`;
            break;
        default:
            detail = JSON.stringify(evt);
            break;
    }

    return `[${time}] #${seq} ${type}${taskId} - ${detail}`;
}

class DualObserver {
    constructor(options = {}) {
        this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
        this.ledgerPath = options.ledgerPath || path.join(this.workspaceRoot, '.omni', 'runs', 'dual-authority', 'events.ndjson');
        this.statePath = options.statePath || path.join(this.workspaceRoot, '.omni', 'runs', 'dual-authority', 'state.json');
        this.onEvent = options.onEvent || null;
        this.onError = options.onError || null;
        this.onStateChange = options.onStateChange || null;

        this.byteOffset = 0;
        this.lastSequence = -1;
        this.lastHash = '0'.repeat(64);
        this.prefixHash = null;
        this.contentHash = null;
        this.consumedPrefixHash = null;
        this.ledgerMode = null;
        this.ledgerIdentity = null;
        this.integrityError = null;
        this.partialBuffer = '';
        this.knownEvents = [];
        this.currentState = null;
        this.timer = null;
    }

    resetCursor() {
        this.byteOffset = 0;
        this.lastSequence = -1;
        this.lastHash = '0'.repeat(64);
        this.partialBuffer = '';
        this.knownEvents = [];
        this.prefixHash = null;
        this.contentHash = null;
        this.consumedPrefixHash = null;
        this.ledgerMode = null;
        this.integrityError = null;
    }

    /**
     * Incrementally reads new bytes from the ledger using cursor semantics.
     * Handles file truncation/rewrites cleanly, and ensures Windows file locks
     * are never held open across reads.
     */
    readIncremental() {
        if (this.integrityError) {
            return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState,
                integrity_error: this.integrityError };
        }
        if (!fs.existsSync(this.ledgerPath)) {
            this.syncState();
            return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState };
        }

        let stat;
        try {
            stat = fs.statSync(this.ledgerPath);
        } catch (err) {
            if (this.onError) this.onError(err);
            return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState };
        }

        // File rewrite or truncation detection
        const identity = `${stat.dev ?? ''}:${stat.ino ?? ''}`;
        if (this.ledgerIdentity && identity !== this.ledgerIdentity) {
            this.resetCursor();
        }
        this.ledgerIdentity = identity;
        if (stat.size < this.byteOffset) {
            this.resetCursor();
        }

        if (this.byteOffset > 0 && this.consumedPrefixHash) {
            try {
                const currentPrefix = fs.readFileSync(this.ledgerPath).subarray(0, this.byteOffset);
                const currentPrefixHash = crypto.createHash('sha256').update(currentPrefix).digest('hex');
                if (currentPrefixHash !== this.consumedPrefixHash) {
                    const error = new Error('Authority ledger bytes changed after observation');
                    error.code = 'DUAL_OBSERVER_PREFIX_REWRITE';
                    this.integrityError = error.code;
                    if (this.onError) this.onError(error);
                    return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState, integrity_error: error.code };
                }
            } catch (error) {
                if (this.onError) this.onError(error);
                return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState, integrity_error: error.code || 'DUAL_OBSERVER_READ_FAILED' };
            }
        }

        if (stat.size === this.byteOffset) {
            this.syncState();
            return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState };
        }

        const length = stat.size - this.byteOffset;
        const buffer = Buffer.alloc(length);
        let bytesRead = 0;

        let fd = null;
        try {
            fd = fs.openSync(this.ledgerPath, 'r');
            bytesRead = fs.readSync(fd, buffer, 0, length, this.byteOffset);
        } catch (err) {
            if (this.onError) this.onError(err);
            return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState };
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch {}
            }
        }

        this.byteOffset += bytesRead;
        try {
            const fullContent = fs.readFileSync(this.ledgerPath);
            this.contentHash = crypto.createHash('sha256').update(fullContent).digest('hex');
            const consumedPrefix = fullContent.subarray(0, Math.min(this.byteOffset, fullContent.length));
            this.consumedPrefixHash = crypto.createHash('sha256').update(consumedPrefix).digest('hex');
            const prefix = fullContent.subarray(0, Math.min(this.byteOffset, 4096));
            this.prefixHash = crypto.createHash('sha256').update(prefix).digest('hex');
        } catch {}
        const chunk = buffer.toString('utf8', 0, bytesRead);
        const fullText = this.partialBuffer + chunk;

        const lastNewlineIndex = fullText.lastIndexOf('\n');
        if (lastNewlineIndex === -1) {
            this.partialBuffer = fullText;
            this.syncState();
            return { newEvents: [], totalEvents: this.knownEvents.length, state: this.currentState };
        }

        const completeSegment = fullText.slice(0, lastNewlineIndex);
        this.partialBuffer = fullText.slice(lastNewlineIndex + 1);

        const lines = completeSegment.split('\n');
        const newEvents = [];

        for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            try {
                const rawRecord = JSON.parse(trimmed);
                const recordMode = rawRecord && typeof rawRecord === 'object'
                    && rawRecord.event && rawRecord.previous_hash && rawRecord.event_hash
                    ? 'enveloped' : 'legacy';
                if (this.ledgerMode && this.ledgerMode !== recordMode) {
                    const error = new Error('Mixed legacy and enveloped authority ledger records are forbidden');
                    error.code = 'DUAL_OBSERVER_LEDGER_FORMAT_MIXED';
                    throw error;
                }
                this.ledgerMode = recordMode;
                const decoded = decodeLedgerRecord(rawRecord, this.lastHash);
                const event = decoded.event;
                if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
                    const error = new Error('Ledger record does not contain a typed event');
                    error.code = 'DUAL_OBSERVER_EVENT_INVALID';
                    throw error;
                }
                this.lastHash = decoded.nextHash;
                newEvents.push(event);
                this.knownEvents.push(event);
                if (typeof event.sequence === 'number') {
                    this.lastSequence = event.sequence;
                }
                if (this.onEvent) {
                    const formatted = formatEvent(event);
                    this.onEvent(event, formatted);
                }
            } catch (parseErr) {
                this.integrityError = parseErr.code || 'DUAL_OBSERVER_RECORD_INVALID';
                if (this.onError) this.onError(parseErr);
                // Do not project any later records from a batch whose cursor
                // can no longer be proven against the authority chain.
                break;
            }
        }

        this.syncState();
        return { newEvents, totalEvents: this.knownEvents.length, state: this.currentState,
            ...(this.integrityError ? { integrity_error: this.integrityError } : {}) };
    }

    syncState() {
        if (!fs.existsSync(this.statePath)) return;
        try {
            const raw = fs.readFileSync(this.statePath, 'utf8');
            const parsed = JSON.parse(raw);
            this.currentState = parsed;
            if (this.onStateChange) this.onStateChange(parsed);
        } catch {}
    }

    start(intervalMs = 500) {
        if (this.timer) return;
        this.readIncremental();
        this.timer = setInterval(() => {
            this.readIncremental();
        }, intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = {
    DualObserver,
    formatEvent,
    decodeLedgerRecord,
};
