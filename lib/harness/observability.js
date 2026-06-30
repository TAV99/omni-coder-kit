'use strict';

// ---------------------------------------------------------------------------
// Observability & heartbeat helpers (docs/SPEC-OBSERVABILITY-HEARTBEAT.md).
//
// Pure formatters (NO chalk) + a heartbeat ticker. The loop/run.js layer adds
// colour; everything here stays testable without a TTY and without spawning.
// ---------------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

// HH:MM:SS from a Date (default = now). `at` injectable for deterministic tests.
function clock(at) {
    const d = at instanceof Date ? at : new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// "agy(gemini-3-pro)" | "claudecode" | "agent" (model optional).
function formatAgent(ide, model) {
    const name = ide || 'agent';
    return model ? `${name}(${model})` : name;
}

// ▶ COOK · agent=agy(gemini-3-pro) · task 3/8 "thêm hàm sub()" · 14:03:21
function formatStepStart({ state, ide, model, taskIdx, total, desc, at } = {}) {
    let line = `▶ ${state} · agent=${formatAgent(ide, model)}`;
    if (total) {
        line += ` · task ${taskIdx || 0}/${total}`;
        if (desc) line += ` "${desc}"`;
    }
    line += ` · ${clock(at)}`;
    return line;
}

// ✓ COOK xong (31s, exit=0) — files: src/sub.js, test/sub.test.js
// ✗ COOK exit=1 (12s)
function formatStepEnd({ state, sec, exitCode, files } = {}) {
    if (exitCode === 0) {
        let line = `✓ ${state} xong (${sec}s, exit=0)`;
        if (files && files.length) line += ` — files: ${files.join(', ')}`;
        return line;
    }
    return `✗ ${state} exit=${exitCode} (${sec}s)`;
}

// ⏳ đang chạy… 12s
function formatTick(sec) {
    return `⏳ đang chạy… ${sec}s`;
}

// ⏱ COOK timeout sau 10m
function formatTimeout({ state, timeoutMs } = {}) {
    return `⏱ ${state} timeout sau ${Math.round((timeoutMs || 0) / 60000)}m`;
}

// Hints printed under a timeout (OBS-2) — the three usual causes.
const TIMEOUT_HINTS = Object.freeze([
    'agent có thể đang chờ permission — thử lại với --yolo.',
    'agy/agent nuốt stdout qua pipe non-TTY? thử --stream để xem raw output.',
    'task thực sự dài → tăng timeout (timeoutMs / --max-iterations).',
]);

// "6 bước · 1m48s" style duration: <Ns> | <Nm><SSs>.
function formatDuration(ms) {
    const total = Math.round((ms || 0) / 1000);
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m${pad2(s)}s` : `${m}m`;
}

// Last N non-empty-trailing lines of stderr (OBS-2 surfacing). Pure.
function lastLines(text, n = 15) {
    if (!text) return '';
    const lines = String(text).split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).join('\n');
}

// ---------------------------------------------------------------------------
// Heartbeat ticker (OBS-3). Calls onTick(elapsedSec) every intervalMs while a
// step runs. Only fires when the Node event loop is FREE — i.e. when the
// provider uses the async spawn path (runCommandAsync), never under spawnSync.
//
// Timer + clock fns are injectable so tests can drive it deterministically.
// ---------------------------------------------------------------------------
function createHeartbeat({
    onTick,
    intervalMs = 10000,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
} = {}) {
    let handle = null;
    let started = 0;
    return {
        start() {
            if (handle) return;
            started = now();
            handle = setIntervalFn(() => {
                const sec = Math.max(0, Math.round((now() - started) / 1000));
                if (onTick) onTick(sec);
            }, intervalMs);
            // Never keep the process alive on the ticker alone.
            if (handle && typeof handle.unref === 'function') handle.unref();
        },
        stop() {
            if (!handle) return;
            clearIntervalFn(handle);
            handle = null;
        },
        get running() { return handle !== null; },
    };
}

module.exports = {
    clock, formatAgent, formatStepStart, formatStepEnd, formatTick,
    formatTimeout, TIMEOUT_HINTS, formatDuration, lastLines, createHeartbeat,
};
