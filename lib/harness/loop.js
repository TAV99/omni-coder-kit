'use strict';

// ---------------------------------------------------------------------------
// Harness orchestrator (HARNESS-UPGRADE-PLAN §2/§4; HARNESS-SPEC-PHASE-1 §4).
//
// Pha 0 gave `--dry-run` planning. Pha 1 adds the LIVE loop: drive a provider
// per state, run real gates that block, and self-run cook → check → fix across
// the 3 quality cycles, pausing before SHIP.
//
// Guardrails (docs/orchestration-patterns.md):
//  - Artifact = hand-off. Transitions are decided by reading .omni/sdlc/* files
//    (todo.md, gate result), NEVER by parsing the agent's prose summary.
//  - Depth = 1: loop → provider → back to loop. Providers don't spawn providers.
//  - Never auto-ship: DOC pauses before SHIP unless --yes-ship; SHIP never pushes.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

const {
    PIPELINE, TERMINAL, planPipeline, createState, loadState, saveState, transition,
} = require('./state');
const { createBudget, addUsage } = require('./budget');
const { appendEvent, logTransition } = require('./events');
const { parseTodo, computeCheckpoint, markBlockedTask } = require('./tasks');
const { runPipeline: realRunPipeline } = require('./gates/pipeline');
const { getProvider, getProviderFromSpec } = require('./providers');
const { fanout, CHECK_LENSES } = require('./fanout');
const { readLessonsFor, appendLesson } = require('./memory');
const { runDebate: realRunDebate } = require('./debate');
const { resolveWorkflow } = require('../workflows/resolve');

// What each phase does + the artifact it hands off (read/write contract).
const STATE_PLAN = Object.freeze({
    INIT: { agent: '—', artifact: '.omni/ (DNA + workflows)', note: 'Khởi tạo config & workflow' },
    BRAINSTORM: { agent: 'Architect', artifact: '.omni/sdlc/design-spec.md', note: 'Phân tích yêu cầu + DNA detection' },
    EQUIP: { agent: 'Skill Manager', artifact: '.omni/manifest.json', note: 'Đề xuất/cài skill theo tech stack' },
    PLAN: { agent: 'PM', artifact: '.omni/sdlc/todo.md', note: 'Phân rã micro-task atomic' },
    COOK: { agent: 'Coder', artifact: '.omni/sdlc/todo.md (+ source)', note: 'Surgical changes, 1 task/lần' },
    CHECK: { agent: 'QA', artifact: '.omni/sdlc/test-report.md', note: 'Gate P0–P5, blocking thật' },
    FIX: { agent: 'Debugger', artifact: '.omni/sdlc/test-report.md', note: 'Reproduce → root cause → surgical fix' },
    DOC: { agent: 'Tech Writer', artifact: 'README.md / API docs', note: 'Tài liệu hoá những gì đã build' },
    SHIP: { agent: 'Release Eng', artifact: '.omni/sdlc/ship-report.md', note: 'Release readiness, staged rollout, KHÔNG tự deploy' },
    DONE: { agent: '—', artifact: '—', note: 'Hoàn tất' },
});

const LOOP_NOTE = 'COOK ⇄ CHECK ⇄ FIX: mỗi 1/3 task chạy 1 quality cycle (tối đa 3 lần fix → BLOCKED escalate).';

// state → >om: step → workflow file (templates/overlays/*/rules/workflow-commands.md).
const STEP_WORKFLOW = Object.freeze({
    brainstorm: 'requirement-analysis.md',
    equip: 'skill-manager.md',
    plan: 'task-planning.md',
    cook: 'coder-execution.md',
    check: 'qa-testing.md',
    fix: 'debugger-workflow.md',
    doc: 'documentation-writer.md',
    ship: 'shipping.md',
});

const STATE_STEP = Object.freeze({
    BRAINSTORM: 'brainstorm', EQUIP: 'equip', PLAN: 'plan',
    COOK: 'cook', FIX: 'fix', DOC: 'doc', SHIP: 'ship',
    // CHECK runs the programmatic gate, not a provider step.
});

// Stable ~500-token context brief from artifacts (NOT a dynamic paraphrase).
function buildSharedBrief(projectDir, maxChars = 2000) {
    const spec = path.join(projectDir || process.cwd(), '.omni', 'sdlc', 'design-spec.md');
    if (!fs.existsSync(spec)) return '';
    try {
        return fs.readFileSync(spec, 'utf-8').slice(0, maxChars);
    } catch {
        return '';
    }
}

function resolveStepWorkflow(step, projectDir) {
    const file = STEP_WORKFLOW[step];
    return file ? resolveWorkflow(file, projectDir) : null;
}

// Build the dry-run plan: ordered phases from `from` to DONE + the quality loop note.
function planRun({ from = 'INIT', provider = 'host-cli' } = {}) {
    const sequence = planPipeline(from).map((state) => ({
        state,
        ...(STATE_PLAN[state] || { agent: '?', artifact: '?', note: '' }),
    }));
    return { provider, from, sequence, loopNote: LOOP_NOTE, budget: createBudget() };
}

// ---------------------------------------------------------------------------
// Live loop (HARNESS-SPEC-PHASE-1 §4)
// ---------------------------------------------------------------------------

async function runHarness(projectDir, opts = {}) {
    const {
        dryRun = false,
        from = 'INIT',
        provider = 'host-cli',
        yesShip = false,
        budget: budgetOverrides,
        ide = 'claudecode',
        fanout: fanoutOpt, // true|false; default: on for agent-capable providers
        lenses = CHECK_LENSES,
        memory: memoryOpt, // true|false; default on
        debate: debateSpecs = null, // ['host-cli:claudecode','host-cli:antigravity']
        debateOn = [],              // ['check','ship']
        debateRounds = 2,
        // injectable for tests:
        runPipeline = realRunPipeline,
        runLens = null,
        runDebate = realRunDebate,
        onEvent = null,
    } = opts;

    // --- dry-run: keep Pha 0 behavior (plan only, no execution) ---
    if (dryRun) {
        return { executed: false, mode: 'dry-run', plan: planRun({ from, provider: 'dry-run' }) };
    }

    const dir = projectDir || process.cwd();
    let state = loadState(dir) || createState({ provider, from });
    if (!state.status) state.status = 'running';
    const budget = createBudget(budgetOverrides);
    const prov = getProvider(provider, { ide });
    const brief = buildSharedBrief(dir);
    const emit = (e) => { const rec = appendEvent(dir, e); if (onEvent) onEvent(rec); return rec; };

    // Memory: inject knowledge-base lessons matching touched files into the
    // COOK/FIX brief (Pha 2e). Lazily recomputed since todo.md changes per cycle.
    const memoryEnabled = memoryOpt !== false;
    const todoFiles = () => {
        try {
            const md = fs.readFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), 'utf-8');
            return [...new Set(md.match(/[\w./-]+\.[A-Za-z0-9]{1,5}/g) || [])];
        } catch { return []; }
    };

    const step = async (name) => {
        const workflowPath = resolveStepWorkflow(name, dir);
        let useBrief = brief;
        if (memoryEnabled && (name === 'cook' || name === 'fix')) {
            const lessons = readLessonsFor(dir, todoFiles());
            if (lessons) useBrief = `${brief}\n\n${lessons}`;
        }
        const r = await prov.runStep(name, { projectDir: dir, state, workflowPath, sharedBrief: useBrief });
        emit({ type: 'provider', provider: prov.name, action: name, exitCode: r.exitCode, durationMs: r.durationMs });
        if (r.usage) {
            addUsage(state, r.usage);
            emit({ type: 'usage', step: name, ...r.usage });
        }
        return r;
    };
    const go = (to, reason) => {
        const from2 = state.state;
        state = transition(state, to, { reason });
        logTransition(dir, from2, to, { reason });
        if (onEvent) onEvent({ type: 'transition', from: from2, to, reason });
        saveState(dir, state);
    };

    // Fan-out (Pattern 3): run quality lenses in parallel, MERGE here in the loop
    // (depth = 1). Default on for agent-capable providers; off for dry-run unless
    // a runLens is injected (tests). Returns { reports, anyFail } or null if skipped.
    const fanoutEnabled = (fanoutOpt !== false) && (runLens || prov.name !== 'dry-run');
    const lensRunner = runLens || (async (lens) => {
        const r = await prov.runStep(lens.step, {
            projectDir: dir, state, workflowPath: resolveStepWorkflow(lens.step, dir), sharedBrief: brief, lens,
        });
        if (r.usage) { addUsage(state, r.usage); emit({ type: 'usage', step: `${lens.name}`, ...r.usage }); }
        return { lens: lens.name, ok: r.ok, findings: r.ok ? [] : [r.summary], durationMs: r.durationMs };
    });
    // Adversarial debate (Pha 3c): high-stakes gate. Returns true if the loop
    // should ESCALATE (pause) — split/inconclusive is not auto-fixed.
    const debateEnabled = (phase) => Array.isArray(debateSpecs) && debateSpecs.length > 0 && (debateOn || []).includes(phase);
    const escalateOnDebate = async (phase, question) => {
        if (!debateEnabled(phase)) return false;
        const participants = debateSpecs.map((s) => getProviderFromSpec(s, { ide }));
        const claim = { question, artifactPaths: ['.omni/sdlc/test-report.md', '.omni/sdlc/todo.md'] };
        const res = await runDebate({ projectDir: dir, claim, participants, rounds: debateRounds, onEvent });
        if (res.consensus === 'agree' && res.verdict === 'pass') return false;
        state.status = 'paused';
        emit({ type: 'pause', reason: `debate ${res.consensus} (${res.verdict}) at ${phase} — escalate to user, no blind-fix` });
        saveState(dir, state);
        return true;
    };

    const runFanout = async (phase) => {
        if (!fanoutEnabled) return null;
        const reports = await fanout(lenses, lensRunner, { concurrency: 3 });
        const anyFail = reports.some((r) => !r.ok);
        emit({ type: 'fanout', phase, lenses: reports.map((r) => ({ name: r.lens, ok: r.ok })), durationMs: reports.reduce((s, r) => s + (r.durationMs || 0), 0) });
        return { reports, anyFail };
    };

    // Per-turn guard: COOK can "stay" without a transition (provider not done),
    // so iteration/wallclock limits are checked against loop turns, not just
    // transitions. Fix-attempt exhaustion is owned by the FIX state below.
    let turns = 0;
    let pendingFixCapture = false; // a FIX ran; capture a lesson if the next CHECK passes
    while (!TERMINAL.includes(state.state)) {
        turns++;
        const elapsedMs = state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0;
        if (turns > budget.maxIterations) {
            state.status = 'paused';
            emit({ type: 'pause', reason: `Đạt giới hạn ${budget.maxIterations} iterations` });
            saveState(dir, state);
            break;
        }
        if (elapsedMs >= budget.maxWallclockMs) {
            state.status = 'paused';
            emit({ type: 'pause', reason: `Đạt giới hạn thời gian ${Math.round(budget.maxWallclockMs / 60000)} phút` });
            saveState(dir, state);
            break;
        }
        if (budget.maxCostUsd != null && (state.costUsd || 0) >= budget.maxCostUsd) {
            state.status = 'paused';
            emit({ type: 'pause', reason: `Đạt giới hạn chi phí $${budget.maxCostUsd}` });
            saveState(dir, state);
            break;
        }

        switch (state.state) {
            case 'INIT':
                go('BRAINSTORM', 'init complete');
                break;
            case 'BRAINSTORM':
                await step('brainstorm');
                go('EQUIP', 'design-spec ready');
                break;
            case 'EQUIP':
                await step('equip');
                go('PLAN', 'skills equipped');
                break;
            case 'PLAN':
                await step('plan');
                go('COOK', 'todo ready');
                break;
            case 'COOK': {
                await step('cook');
                const t = parseTodo(dir);
                const cp = computeCheckpoint(t.total);
                if (t.remaining === 0 || t.completed >= state.cycle * cp) {
                    go('CHECK', `checkpoint cycle ${state.cycle} (${t.completed}/${t.total})`);
                } else {
                    saveState(dir, state); // stay in COOK
                }
                break;
            }
            case 'CHECK': {
                const gate = runPipeline(dir);
                emit({ type: 'gate', gate: 'pipeline', passed: gate.passed, failures: gate.failures });
                // Fan-out review lenses (Pattern 3) — merge here: any lens fail → FIX.
                const fan = await runFanout('check');
                const lensFail = fan ? fan.anyFail : false;
                const t = parseTodo(dir);
                if (!gate.passed || lensFail) {
                    go('FIX', `gate fail ${gate.failures.join(',') || ''}${lensFail ? ' +lens' : ''}`);
                } else if (await escalateOnDebate('check', 'Are the completed tasks correct and safe (no hidden bug/security/migration risk)?')) {
                    return state; // debate split/inconclusive → escalate to user, do not blind-fix
                } else {
                    // A fix that preceded this passing CHECK is a confirmed lesson (auto >om:learn).
                    if (pendingFixCapture && memoryEnabled) {
                        const files = todoFiles();
                        appendLesson(dir, {
                            date: new Date().toISOString().slice(0, 10),
                            title: 'Harness fix resolved a gate/lens failure',
                            scope: files.join(', ') || '(project)',
                            pattern: `gate/lens failure in cycle ${state.cycle}`,
                            fix: 'resolved after the harness fix cycle re-ran CHECK to green',
                        });
                        emit({ type: 'learn', cycle: state.cycle, scope: files });
                    }
                    pendingFixCapture = false;
                    if (t.remaining > 0) go('COOK', 'gate pass, more tasks');
                    else go('DOC', 'gate pass, all tasks done');
                }
                break;
            }
            case 'FIX':
                if (state.fixAttempts > budget.maxFixAttempts) {
                    const marked = markBlockedTask(dir);
                    emit({ type: 'blocked', reason: `fix attempts exhausted (${budget.maxFixAttempts}) cycle ${state.cycle}`, taskRef: marked });
                    state.status = 'blocked';
                    go('BLOCKED', 'fix attempts exhausted');
                    saveState(dir, state);
                    return state;
                }
                await step('fix');
                pendingFixCapture = true;
                go('CHECK', 're-check after fix');
                break;
            case 'DOC':
                await step('doc');
                if (!yesShip) {
                    state.status = 'paused';
                    emit({ type: 'pause', reason: 'awaiting user approval before SHIP' });
                    saveState(dir, state);
                    return state;
                }
                if (await escalateOnDebate('ship', 'Is this release ready and safe to ship (rollout/rollback/no irreversible risk)?')) {
                    return state; // pre-SHIP debate split → escalate, never auto-ship
                }
                go('SHIP', 'approved for ship');
                break;
            case 'SHIP':
                await runFanout('ship'); // advisory: user already approved; lenses surface release risks, don't block
                await step('ship');
                go('DONE', 'shipped (staged, no auto-deploy)');
                break;
            default:
                // BLOCKED or unknown — escalate / stop.
                state.status = state.state === 'BLOCKED' ? 'blocked' : 'error';
                saveState(dir, state);
                return state;
        }
    }

    if (TERMINAL.includes(state.state)) {
        state.status = 'done';
        emit({ type: 'done', state: state.state });
        saveState(dir, state);
    }
    return state;
}

module.exports = { STATE_PLAN, LOOP_NOTE, STEP_WORKFLOW, STATE_STEP, PIPELINE, planRun, buildSharedBrief, resolveStepWorkflow, runHarness };
