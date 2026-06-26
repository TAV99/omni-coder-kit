'use strict';

// ---------------------------------------------------------------------------
// Append-only event log (HARNESS-UPGRADE-PLAN §4.1 events.js, Pha 0).
//
// .omni/run/events.ndjson — one JSON object per line. Audit trail + resume
// fallback: state.json can be reconstructed from the last transition event.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { runDir } = require('./state');

const EVENTS_FILE = 'events.ndjson';

function eventsPath(projectDir) {
    return path.join(runDir(projectDir), EVENTS_FILE);
}

// Append one event. `event` is merged with a timestamp; `ts` is not overwritten
// if the caller already supplied one.
function appendEvent(projectDir, event) {
    const dir = runDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    const record = { ts: new Date().toISOString(), ...event };
    fs.appendFileSync(eventsPath(projectDir), JSON.stringify(record) + '\n', 'utf-8');
    return record;
}

// Convenience: record a state transition.
function logTransition(projectDir, from, to, meta = {}) {
    return appendEvent(projectDir, { type: 'transition', from, to, ...meta });
}

function readEvents(projectDir) {
    const file = eventsPath(projectDir);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
}

// Reconstruct the latest state name from the event log (resume fallback when
// state.json is missing/corrupt). Returns null if no transition recorded.
function lastStateFromEvents(projectDir) {
    const events = readEvents(projectDir);
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'transition' && events[i].to) return events[i].to;
    }
    return null;
}

module.exports = { EVENTS_FILE, eventsPath, appendEvent, logTransition, readEvents, lastStateFromEvents };
