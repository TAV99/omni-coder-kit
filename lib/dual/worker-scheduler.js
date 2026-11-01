'use strict';

// Parallel isolated workers (SPEC-SQUAD-P5 §4). Tasks start as soon as their
// worker is free, their runtime has a slot (Q-P5-6) and their allowed_files do
// not overlap a running task. Integration stays one at a time: task.qc still
// waits for every active worker lease, because a worker's authority is bound to
// the baseline it started from.

const { readBinding } = require('../squad/bindings');
const { repoPathsOverlap } = require('./workspace');
const { logDaemonDiagnostic } = require('./daemon-diagnostics');
const { redactDiagnostic } = require('./validator-security');

const DEFAULT_CONCURRENCY = Object.freeze({ codex: 2, claude: 2, agy: 1 });

function concurrencyLimits(workspaceRoot) {
    let configured = {};
    try { configured = readBinding(workspaceRoot)?.limits?.concurrency || {}; } catch { configured = {}; }
    return { ...DEFAULT_CONCURRENCY, ...configured };
}

function overlaps(left, right) {
    return left.allowedFiles.some((a) => right.allowedFiles.some((b) => repoPathsOverlap(a, b)));
}

// items: [{ key, workerId, runtime, allowedFiles }] in plan order. start(item) runs
// one task; results come back in the same order as items. A task that throws
// becomes its own FAILED result (logged with its code) so its siblings keep theirs.
async function runScheduled(items, { limits, start }) {
    const results = new Array(items.length);
    const pending = items.map((item, index) => ({ ...item, index }));
    const running = new Map();
    const canStart = (item) => {
        const active = [...running.values()];
        return !active.some((other) => other.workerId === item.workerId)
            && active.filter((other) => other.runtime === item.runtime).length < (limits[item.runtime] ?? 1)
            && !active.some((other) => overlaps(other, item));
    };
    while (pending.length || running.size) {
        for (let i = 0; i < pending.length;) {
            const item = pending[i];
            if (!canStart(item)) { i++; continue; }
            pending.splice(i, 1);
            const promise = Promise.resolve().then(() => start(item))
                .then((result) => { results[item.index] = result; }, (error) => {
                    const taskId = item.taskId ?? item.key;
                    const summary = redactDiagnostic(error?.message || String(error), { maxLength: 1024 });
                    // The diagnostic log keeps only task_id/code/message, so the abort and guard causes ride in the message.
                    const causes = [error?.abortReason && `abort ${error.abortReason.code}: ${error.abortReason.message}`,
                        error?.guardDiagnostic && `guard ${error.guardDiagnostic.code}: ${error.guardDiagnostic.message}`,
                        error?.guardError && `guard ${error.guardError.code}: ${error.guardError.message}`].filter(Boolean);
                    try {
                        logDaemonDiagnostic('worker.task.failed', { task_id: taskId, code: error?.code || 'DUAL_WORKER_FAILED',
                            message: [summary, ...causes].join(' | ') });
                    } catch {}
                    results[item.index] = { taskId, status: 'FAILED', code: error?.code || 'DUAL_WORKER_FAILED', summary };
                })
                .finally(() => running.delete(item.index));
            running.set(item.index, { ...item, promise });
        }
        if (!running.size) break; // nothing can start: cannot happen, every item fits an empty pool
        await Promise.race([...running.values()].map((entry) => entry.promise));
    }
    return results;
}

module.exports = { DEFAULT_CONCURRENCY, concurrencyLimits, runScheduled };
