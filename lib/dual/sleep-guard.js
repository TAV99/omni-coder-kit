'use strict';

// O4 (docs/SQUAD-ORCA-ADOPTION.md): a host sleep during a worker lease strands
// the task in NEEDS_PROCESS_EVIDENCE (HANDOFF-P7 §12), and the ledger rightly
// never settles that without proof. Prevent it instead: while any worker lease
// is held, one `caffeinate -i -s -w <pid>` blocks idle sleep (and system sleep
// on AC). -w ends it with this process, so a crashed daemon leaves no holder.
// It cannot stop a lid close or an empty battery. Opt out: OMNI_SLEEP_GUARD=off.

const { spawn: nodeSpawn } = require('node:child_process');

const CAFFEINATE = '/usr/bin/caffeinate';

function createSleepGuard({ platform = process.platform, env = process.env, spawn = nodeSpawn, pid = process.pid } = {}) {
    const enabled = platform === 'darwin' && env.OMNI_SLEEP_GUARD !== 'off';
    let holders = 0;
    let child = null;

    function start() {
        try {
            const started = spawn(CAFFEINATE, ['-i', '-s', '-w', String(pid)], { stdio: 'ignore', detached: false });
            started.on?.('error', () => { if (child === started) child = null; });
            started.on?.('exit', () => { if (child === started) child = null; });
            started.unref?.();
            child = started;
        } catch {
            child = null; // best effort: a missing caffeinate never blocks a lease
        }
    }

    function stop() {
        const current = child;
        child = null;
        try { current?.kill?.(); } catch { /* already gone */ }
    }

    function acquire() {
        if (!enabled) return () => {};
        holders += 1;
        if (!child) start();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            holders -= 1;
            if (holders === 0) stop();
        };
    }

    return { acquire, active: () => holders };
}

const defaultSleepGuard = createSleepGuard();

module.exports = { createSleepGuard, defaultSleepGuard };
