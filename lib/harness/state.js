'use strict';

// ---------------------------------------------------------------------------
// Harness state machine (HARNESS-UPGRADE-PLAN §4.3, Pha 0).
//
// Canonical SDLC pipeline — extends the plan's diagram to include the SHIP
// phase that templates/workflows/superpower-sdlc.md now ends with
// (>om:doc → >om:ship). Pure logic + JSON persistence; no LLM/tool execution
// yet (that arrives in Pha 1).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const STATES = Object.freeze([
    'INIT', 'BRAINSTORM', 'EQUIP', 'PLAN', 'COOK', 'CHECK', 'FIX', 'ACCEPTANCE', 'DOC', 'SHIP', 'DONE', 'BLOCKED',
]);

// Happy-path order used by --dry-run planning. The COOK ⇄ CHECK ⇄ FIX cycle is
// dynamic at runtime; the linear path is the plan a clean run would follow.
// ACCEPTANCE (Phase-4) sits between CHECK and DOC: gate conformance against
// .omni/sdlc/requirements.md (or pass-through when there is no requirements file).
const PIPELINE = Object.freeze(['INIT', 'BRAINSTORM', 'EQUIP', 'PLAN', 'COOK', 'CHECK', 'ACCEPTANCE', 'DOC', 'SHIP', 'DONE']);

const TERMINAL = Object.freeze(['DONE']);

// Allowed transitions. BLOCKED (escalate-to-user) is reachable from every
// active state; recovery transitions let `--resume` pick the loop back up.
const TRANSITIONS = Object.freeze({
    INIT: ['BRAINSTORM', 'BLOCKED'],
    BRAINSTORM: ['EQUIP', 'BLOCKED'],
    EQUIP: ['PLAN', 'BLOCKED'],
    PLAN: ['COOK', 'BLOCKED'],
    COOK: ['CHECK', 'BLOCKED'],
    CHECK: ['FIX', 'COOK', 'ACCEPTANCE', 'BLOCKED'], // fail→FIX, pass+more→COOK, pass+done→ACCEPTANCE
    FIX: ['CHECK', 'BLOCKED'],
    ACCEPTANCE: ['COOK', 'FIX', 'DOC', 'BLOCKED'], // unmet→COOK/FIX; allMet (or no requirements)→DOC
    DOC: ['SHIP', 'BLOCKED'],
    SHIP: ['DONE', 'BLOCKED'],
    DONE: [],
    BLOCKED: ['COOK', 'CHECK', 'FIX', 'ACCEPTANCE', 'PLAN', 'DONE'], // manual recovery or give up
});

const RUN_SUBDIR = path.join('.omni', 'run');
const STATE_FILE = 'state.json';

function runDir(projectDir) {
    return path.join(projectDir || process.cwd(), RUN_SUBDIR);
}

function isValidState(s) {
    return STATES.includes(s);
}

function canTransition(from, to) {
    if (!isValidState(from) || !isValidState(to)) return false;
    return (TRANSITIONS[from] || []).includes(to);
}

function createState({ provider = 'host-cli', from = 'INIT', dna = null } = {}) {
    if (!isValidState(from)) throw new Error(`Trạng thái khởi đầu không hợp lệ: ${from}`);
    const now = new Date().toISOString();
    return {
        state: from,
        provider,
        dna,
        cycle: 1,
        fixAttempts: 0,
        acceptanceRounds: 0,
        iterations: 0,
        startedAt: now,
        updatedAt: now,
        consecutiveTimeouts: 0,
    };
}

// Pure: returns a NEW state object advanced to `to`. Throws on illegal move.
function transition(state, to, { reason = '' } = {}) {
    if (!canTransition(state.state, to)) {
        throw new Error(`Transition không hợp lệ: ${state.state} → ${to}`);
    }
    const next = {
        ...state,
        state: to,
        iterations: state.iterations + 1,
        updatedAt: new Date().toISOString(),
        lastReason: reason || undefined,
    };
    // Cycle / fix bookkeeping for the COOK ⇄ CHECK ⇄ FIX loop.
    if (to === 'FIX') next.fixAttempts = state.fixAttempts + 1;
    if (state.state === 'CHECK' && to === 'COOK') { next.cycle = state.cycle + 1; next.fixAttempts = 0; }
    return next;
}

// Linear plan from `from` to DONE along the happy path (for --dry-run).
function planPipeline(from = 'INIT') {
    const start = PIPELINE.indexOf(from);
    if (start === -1) return [...PIPELINE];
    return PIPELINE.slice(start);
}

// --- persistence -----------------------------------------------------------

function saveState(projectDir, state) {
    const dir = runDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf-8');
    return path.join(dir, STATE_FILE);
}

function loadState(projectDir) {
    const file = path.join(runDir(projectDir), STATE_FILE);
    if (!fs.existsSync(file)) return null;
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!isValidState(state.state)) return null;
        return state;
    } catch {
        return null;
    }
}

module.exports = {
    STATES, PIPELINE, TERMINAL, TRANSITIONS, RUN_SUBDIR, STATE_FILE,
    runDir, isValidState, canTransition, createState, transition, planPipeline,
    saveState, loadState,
};
