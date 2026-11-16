'use strict';

// One `omni ui` per project. Two instances each resume the same orchestrator
// conversation and drive one dual session with interleaved instructions
// (omni-p8-test 2026-11-16: two `omni ui --resume` ran concurrently, two UI
// measurements raced, and a contradicting instruction had already blocked
// 4c2bc1ae). Orca keeps one current coordinator per Run; this lock does the same
// for the orchestrator pane. A lock whose process is gone is taken over.

const fs = require('node:fs');
const path = require('node:path');

function lockPath(root) {
    return path.join(root, '.omni', 'runtime', 'ui', 'ui.lock');
}

function alive(pid, kill = process.kill) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readLock(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Returns { acquired: true, update, release } or { acquired: false, holder }.
function acquireUiLock(root, { pid = process.pid, now = () => new Date().toISOString(), kill = process.kill } = {}) {
    const file = lockPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let tries = 0; tries < 2; tries++) {
        try {
            const fd = fs.openSync(file, 'wx', 0o600);
            const record = { pid, started_at: now() };
            fs.writeSync(fd, JSON.stringify(record));
            fs.closeSync(fd);
            const owned = () => readLock(file)?.pid === pid;
            return {
                acquired: true,
                update(fields) { if (owned()) fs.writeFileSync(file, JSON.stringify({ ...readLock(file), ...fields })); },
                release() { if (owned()) { try { fs.unlinkSync(file); } catch {} } },
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const holder = readLock(file);
            if (holder && holder.pid !== pid && alive(holder.pid, kill)) return { acquired: false, holder };
            try { fs.unlinkSync(file); } catch {} // stale, unreadable or our own leftover
        }
    }
    return { acquired: false, holder: readLock(file) };
}

module.exports = { acquireUiLock, lockPath };
