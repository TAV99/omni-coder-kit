'use strict';

const TURN_SOFT_BUDGET_MS = 10 * 60 * 1000;
const TURN_HARD_BUDGET_MS = 20 * 60 * 1000;
const TURN_HEARTBEAT_MS = 60 * 1000;
const TURN_NO_PROGRESS_MS = 5 * 60 * 1000;
const TURN_NUDGE_GRACE_MS = 2 * 60 * 1000;
const TURN_POLL_MS = 1000;

// Heartbeats prove the supervisor is alive; only worker evidence counts as progress.
function createTurnWatchdog(options = {}) {
    const { now = Date.now, softMs = TURN_SOFT_BUDGET_MS, hardMs = TURN_HARD_BUDGET_MS,
        heartbeatMs = TURN_HEARTBEAT_MS, noProgressMs = TURN_NO_PROGRESS_MS,
        graceMs = TURN_NUDGE_GRACE_MS } = options;
    for (const value of [softMs, hardMs, heartbeatMs, noProgressMs, graceMs]) {
        if (!Number.isFinite(value) || value <= 0) throw new TypeError('Turn thresholds must be positive');
    }
    if (softMs > hardMs) throw new TypeError('Soft budget exceeds hard budget');
    const startedAt = now();
    let lastProgressAt = startedAt, lastHeartbeatAt = startedAt, nudgedAt = null, warned = false, stopped = null, hadEvidence = false;
    return {
        progress(isEvidence = true) {
            if (!stopped) {
                lastProgressAt = now();
                if (isEvidence && isEvidence !== 'activity') hadEvidence = true;
            }
        },
        activity() { if (!stopped) lastProgressAt = now(); },
        check() {
            const at = now(), elapsedMs = at - startedAt;
            const heartbeat = at - lastHeartbeatAt >= heartbeatMs;
            if (heartbeat) lastHeartbeatAt = at;
            const soft = !warned && elapsedMs >= softMs;
            if (soft) warned = true;
            let action = 'ok';
            if (stopped) action = stopped === 'no_evidence' ? 'fail-fast' : 'stall';
            else if (elapsedMs >= hardMs) { stopped = 'hard_budget'; action = 'stall'; }
            else if (nudgedAt !== null && at - lastProgressAt >= noProgressMs && at - nudgedAt >= graceMs) {
                stopped = 'no_progress'; action = 'stall';
            } else if (nudgedAt === null && at - lastProgressAt >= noProgressMs) {
                if (!hadEvidence) {
                    stopped = 'no_evidence';
                    action = 'fail-fast';
                } else {
                    nudgedAt = at;
                    action = 'nudge';
                }
            }
            return { action, reason: stopped, soft, heartbeat, startedAt, at, elapsedMs, lastProgressAt, nudgedAt, hadEvidence };
        },
    };
}

module.exports = { createTurnWatchdog, TURN_SOFT_BUDGET_MS, TURN_HARD_BUDGET_MS, TURN_HEARTBEAT_MS,
    TURN_NO_PROGRESS_MS, TURN_NUDGE_GRACE_MS, TURN_POLL_MS };
