'use strict';

// Parallel isolated workers (SPEC-SQUAD-P5 §4). Tasks start as soon as their
// worker is free, their runtime has a slot (Q-P5-6) and their allowed_files do
// not overlap a running task. Integration stays one at a time: task.qc still
// waits for every active worker lease, because a worker's authority is bound to
// the baseline it started from.

const { readBinding } = require('../squad/bindings');
const { repoPathsOverlap } = require('./workspace');

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
// one task; results come back in the same order as items.
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
                .then((result) => { results[item.index] = result; }, (error) => { results[item.index] = { error }; })
                .finally(() => running.delete(item.index));
            running.set(item.index, { ...item, promise });
        }
        if (!running.size) break; // nothing can start: cannot happen, every item fits an empty pool
        await Promise.race([...running.values()].map((entry) => entry.promise));
    }
    for (const result of results) if (result && result.error) throw result.error;
    return results;
}

module.exports = { DEFAULT_CONCURRENCY, concurrencyLimits, runScheduled };
