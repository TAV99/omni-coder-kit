'use strict';

const fs = require('node:fs');
const { redactDiagnostic } = require('./validator-security');

function logDaemonDiagnostic(event, fields = {}) {
    const entry = { timestamp: new Date().toISOString(), pid: process.pid, event };
    // Explicit allowlist: never serialize error objects, contracts, or arbitrary fields.
    for (const key of ['task_id', 'revision_id', 'code', 'message']) {
        if (fields[key] !== undefined) entry[key] = redactDiagnostic(String(fields[key]), { maxLength: 1024 });
    }
    // Synchronous stderr write preserves fatal diagnostics before process.exit().
    fs.writeSync(2, `${JSON.stringify(entry)}\n`);
}

function installDaemonFatalDiagnostics() {
    for (const event of ['uncaughtException', 'unhandledRejection']) {
        process.on(event, error => {
            logDaemonDiagnostic(event, { code: error?.code || 'DUAL_DAEMON_FATAL',
                message: error?.message || String(error) });
            process.exit(1);
        });
    }
}

// A detached daemon's stderr went to /dev/null, so its diagnostics were lost
// (omni-p8-test 9d288f0b: a scout turn that never dispatched left no trace).
// The spawner points stderr at .omni/runtime/dual/daemon.log instead, keeping
// one previous log once it passes the size bound. Any failure falls back to
// 'ignore': logging must never stop the daemon from starting.
const DAEMON_LOG_MAX_BYTES = 4 * 1024 * 1024;
function openDaemonLogStdio(runtimeDir, { maxBytes = DAEMON_LOG_MAX_BYTES } = {}) {
    try {
        const path = require('node:path');
        fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        const file = path.join(runtimeDir, 'daemon.log');
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (stat && stat.size > maxBytes) fs.renameSync(file, `${file}.1`);
        const fd = fs.openSync(file, 'a', 0o600);
        return { stdio: ['ignore', 'ignore', fd], close: () => { try { fs.closeSync(fd); } catch {} } };
    } catch {
        return { stdio: 'ignore', close: () => {} };
    }
}

module.exports = { logDaemonDiagnostic, installDaemonFatalDiagnostics, openDaemonLogStdio, DAEMON_LOG_MAX_BYTES };
