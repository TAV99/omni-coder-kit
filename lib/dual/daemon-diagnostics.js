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

module.exports = { logDaemonDiagnostic, installDaemonFatalDiagnostics };
