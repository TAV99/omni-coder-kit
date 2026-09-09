'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
        case 'task.lease_released':
            detail = `Lease released: ${evt.reason}`;
            break;
        case 'task.lease_renewed':
            detail = `Lease renewed (attempt ${evt.attempt})`;
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
        this.partialBuffer = '';
        this.knownEvents = [];
        this.currentState = null;
        this.timer = null;
    }

    /**
     * Incrementally reads new bytes from the ledger using cursor semantics.
     * Handles file truncation/rewrites cleanly, and ensures Windows file locks
     * are never held open across reads.
     */
    readIncremental() {
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
        if (stat.size < this.byteOffset) {
            this.byteOffset = 0;
            this.lastSequence = -1;
            this.partialBuffer = '';
            this.knownEvents = [];
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
                const event = JSON.parse(trimmed);
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
                if (this.onError) this.onError(parseErr);
            }
        }

        this.syncState();
        return { newEvents, totalEvents: this.knownEvents.length, state: this.currentState };
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
};
