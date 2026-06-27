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

// Aggregate metrics from an event log (HARNESS-SPEC-PHASE-2 §2e observability).
// Pure: attributes provider/usage/fanout duration + token cost to the current
// state (tracked via transition events). Returns { byState, totals }.
function summarizeEvents(events) {
    const blank = () => ({ durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, providerCalls: 0 });
    const byState = {};
    const totals = { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, transitions: 0, providerCalls: 0 };
    const ensure = (s) => (byState[s] = byState[s] || blank());

    let cur = 'INIT';
    for (const e of events || []) {
        if (e.type === 'transition') {
            if (e.to) cur = e.to;
            totals.transitions++;
            ensure(cur);
        } else if (e.type === 'provider' || e.type === 'fanout') {
            const b = ensure(cur);
            b.durationMs += e.durationMs || 0;
            totals.durationMs += e.durationMs || 0;
            if (e.type === 'provider') { b.providerCalls++; totals.providerCalls++; }
        } else if (e.type === 'usage') {
            const b = ensure(cur);
            b.inputTokens += e.inputTokens || 0;
            b.outputTokens += e.outputTokens || 0;
            b.costUsd += e.costUsd || 0;
            totals.inputTokens += e.inputTokens || 0;
            totals.outputTokens += e.outputTokens || 0;
            totals.costUsd += e.costUsd || 0;
        }
    }
    return { byState, totals };
}

module.exports = { EVENTS_FILE, eventsPath, appendEvent, logTransition, readEvents, lastStateFromEvents, summarizeEvents };
