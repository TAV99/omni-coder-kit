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
const { spawnSync } = require('child_process');

const {
    PIPELINE, TERMINAL, planPipeline, createState, loadState, saveState, transition,
} = require('./state');
const { createBudget, addUsage } = require('./budget');
const { appendEvent, logTransition } = require('./events');
const { parseTodo, nextTask, computeCheckpoint, markBlockedTask } = require('./tasks');
const { createHeartbeat } = require('./observability');
const { runPipeline: realRunPipeline } = require('./gates/pipeline');
const { getProvider, getProviderFromSpec } = require('./providers');
const { fanout, CHECK_LENSES } = require('./fanout');
const { readLessonsFor, appendLesson } = require('./memory');
const { runDebate: realRunDebate } = require('./debate');
const { runAcceptance: realRunAcceptance, writeConformance } = require('./acceptance');
const { parseRequirements, buildRequirements } = require('./intake');
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
    ACCEPTANCE: { agent: 'Acceptance', artifact: '.omni/sdlc/conformance.md', note: 'Đối chiếu từng yêu cầu vs requirements.md + spec gốc (debate cross-model)' },
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
    acceptance: 'acceptance.md',
    intake: 'intake.md',
    doc: 'documentation-writer.md',
    ship: 'shipping.md',
});

const STATE_STEP = Object.freeze({
    BRAINSTORM: 'brainstorm', EQUIP: 'equip', PLAN: 'plan',
    COOK: 'cook', FIX: 'fix', ACCEPTANCE: 'acceptance', DOC: 'doc', SHIP: 'ship',
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

// Best-effort set of files git sees as dirty (porcelain paths). Used to diff
// before/after a step so step-end can report "files: …" (OBS-1). Returns null
// when not a git repo / git unavailable — callers degrade to no file list.
function gitStatusSet(projectDir) {
    try {
        const r = spawnSync('git', ['-C', projectDir || process.cwd(), 'status', '--porcelain'], {
            encoding: 'utf-8', timeout: 5000,
        });
        if (r.status !== 0 || typeof r.stdout !== 'string') return null;
        return new Set(
            r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean),
        );
    } catch {
        return null;
    }
}

// Files that became dirty DURING a step (after − before). Capped for display.
function changedFiles(before, after, cap = 8) {
    if (before && after) return [...after].filter((f) => !before.has(f)).slice(0, cap);
    if (after) return [...after].slice(0, cap);
    return [];
}

// Human-readable "which gate + which file" for a BLOCKED reason (FIX 3). Pulls
// the first finding line from each failing gate result; '' when no detail.
function describeGateFailures(results, failures) {
    const failing = (results || []).filter((r) => r && r.status === 'fail');
    const parts = [];
    for (const r of failing) {
        const firstLine = String(r.output || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
        parts.push(firstLine ? `${r.id} ${r.name}: ${firstLine}` : `${r.id} ${r.name}`);
    }
    return parts.join(' | ');
}

// Phase-4: every unmet requirement becomes a concrete `[ACCEPT] R<id>` task in
// todo.md so COOK has unambiguous targets next round (artifact = hand-off).
function appendAcceptanceTasks(projectDir, unmet = []) {
    if (!unmet.length) return;
    const file = path.join(projectDir || process.cwd(), '.omni', 'sdlc', 'todo.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let md = '';
    try { md = fs.readFileSync(file, 'utf-8'); } catch { md = ''; }
    const lines = [];
    if (md && !md.endsWith('\n')) lines.push('');
    if (!/Acceptance-driven tasks/i.test(md)) lines.push('## Acceptance-driven tasks');
    for (const r of unmet) {
        const id = r.id;
        // Skip if this exact task already exists.
        if (md.includes(`[ACCEPT] ${id}:`)) continue;
        lines.push(`- [ ] [ACCEPT] ${id}: ${r.text || ''}`);
    }
    if (lines.length === 0) return;
    fs.writeFileSync(file, md + lines.join('\n') + '\n', 'utf-8');
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
        yolo = false,      // true → host-cli claude/codex bỏ qua mọi permission (đồng bộ agy)
        stream = false,    // OBS-3: forward raw agent stdout (prefix │). Heartbeat ticker is always on.
        fanout: fanoutOpt, // true|false; default: on for agent-capable providers
        lenses = CHECK_LENSES,
        memory: memoryOpt, // true|false; default on
        debate: debateSpecs = null, // ['host-cli:claudecode','host-cli:antigravity']
        debateOn = [],              // ['check','ship']
        debateRounds = 2,
        // Phase-4 acceptance ------------------------------------------------
        specFile = null,           // path to a customer spec file → intake before loop
        specText = null,           // inline customer spec/Q&A (alternative to specFile)
        acceptSpecs = null,        // ['host-cli:claudecode','host-cli:antigravity'] — debate participants for ACCEPTANCE
        acceptOnly = false,        // run ACCEPTANCE state only, then return (omni run accept)
        stepTimeoutMs,
        // injectable for tests:
        runPipeline = realRunPipeline,
        runLens = null,
        runDebate = realRunDebate,
        runAcceptance = realRunAcceptance,
        onEvent = null,
    } = opts;

    // --- dry-run: keep Pha 0 behavior (plan only, no execution) ---
    if (dryRun) {
        return { executed: false, mode: 'dry-run', plan: planRun({ from, provider: 'dry-run' }) };
    }

    // Absolute path is required so agy's --add-dir (SPEC-FIX-ANTIGRAVITY-WORKSPACE)
    // scopes correctly; idempotent for paths that are already absolute.
    const dir = path.resolve(projectDir || process.cwd());
    const runStartedAt = Date.now();
    let state = loadState(dir) || createState({ provider, from });
    if (!state.status) state.status = 'running';
    if (state.acceptanceRounds == null) state.acceptanceRounds = 0;
    const budget = createBudget(budgetOverrides);
    // OBS-3: run real steps through the async spawn path so the heartbeat ticker
    // below actually fires mid-step (spawnSync would block the event loop). With
    // --stream, raw agent stdout is forwarded line-by-line, prefixed.
    const onStdoutRaw = stream
        ? (chunk) => { process.stdout.write(String(chunk).replace(/^/gm, '   │ ')); }
        : null;
    const prov = getProvider(provider, { ide, yolo, async: true, stream, onStdout: onStdoutRaw, timeoutMs: stepTimeoutMs });
    const brief = buildSharedBrief(dir);
    const emit = (e) => { const rec = appendEvent(dir, e); if (onEvent) onEvent(rec); return rec; };
    // Heartbeat ticks are console-only (NOT persisted) to keep events.ndjson lean.
    const tick = (e) => { if (onEvent) onEvent(e); };

    // Phase-4 intake: turn a customer spec/text into requirements.md BEFORE the
    // loop starts (idempotent — skipped if requirements.md already exists).
    if (specFile || specText) {
        let txt = specText || '';
        if (specFile) {
            try { txt = fs.readFileSync(specFile, 'utf-8'); }
            catch (err) { throw new Error(`--spec không đọc được ${specFile}: ${err.message}`); }
        }
        if (txt.trim()) {
            const intakeRes = await buildRequirements({ projectDir: dir, specText: txt, provider: prov, ide });
            emit({ type: 'intake', path: intakeRes.path, count: intakeRes.count, skipped: intakeRes.skipped || null });
            // FIX 4: a spec that yields zero requirements is almost always too
            // vague — surface it loudly instead of silently cooking nothing.
            if (!intakeRes.skipped && (intakeRes.count || 0) === 0) {
                emit({ type: 'intake-warning', reason: 'intake sinh 0 requirement/task — spec quá mơ hồ? Kiểm tra lại --spec.' });
            }
        }
    }

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
        // OBS-1: boundary heartbeat. ▶ before, ✓/✗ after — so the terminal is
        // never silent across a step. Task k/n only shown for cook/fix.
        const stateName = state.state;
        const model = (typeof prov.modelFor === 'function') ? prov.modelFor(name) : undefined;
        const taskInfo = (name === 'cook' || name === 'fix') ? nextTask(dir) : { idx: 0, total: 0, desc: '' };
        emit({
            type: 'step-start', step: name, state: stateName, ide,
            model: model || null, taskIdx: taskInfo.idx, total: taskInfo.total, desc: taskInfo.desc || null,
        });

        const before = gitStatusSet(dir);
        // OBS-3: live heartbeat. Independent of child stdout, so it still proves
        // "còn sống" even when agy swallows stdout under a non-TTY pipe.
        const hb = createHeartbeat({ onTick: (sec) => tick({ type: 'heartbeat', step: name, state: stateName, sec }) });
        hb.start();
        let r;
        try {
            r = await prov.runStep(name, { projectDir: dir, state, workflowPath, sharedBrief: useBrief, signal: opts.signal });
        } finally {
            hb.stop();
        }
        const files = changedFiles(before, gitStatusSet(dir));

        emit({ type: 'provider', provider: prov.name, action: name, exitCode: r.exitCode, durationMs: r.durationMs });
        if (r.usage) {
            addUsage(state, r.usage);
            emit({ type: 'usage', step: name, ...r.usage });
        }
        emit({
            type: 'step-end', step: name, state: stateName,
            exitCode: r.exitCode, durationMs: r.durationMs, sec: Math.round((r.durationMs || 0) / 1000),
            files, stderrTail: r.ok ? null : (r.stderrTail || null),
            timedOut: !!r.timedOut, timeoutMs: r.timeoutMs || null,
        });
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
        const participants = debateSpecs.map((s) => getProviderFromSpec(s, { ide, yolo, timeoutMs: stepTimeoutMs }));
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
        const elapsedMs = Date.now() - runStartedAt;
        if (turns > budget.maxIterations) {
            state.status = 'paused';
            emit({ type: 'pause', reason: `Đạt giới hạn ${budget.maxIterations} iterations` });
            saveState(dir, state);
            break;
        }
        if (elapsedMs >= budget.maxWallclockMs) {
            state.status = 'paused';
            emit({ type: 'pause', reason: `Đạt giới hạn thời gian phiên (${Math.round(budget.maxWallclockMs / 60000)} phút) — chạy 'omni run --resume' để cấp lại thời gian` });
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
                // FIX 4: nothing to build. By COOK, PLAN/intake have already run
                // (they precede COOK in the pipeline), so an empty todo.md means
                // there genuinely are no tasks — BLOCK with guidance instead of
                // churning CHECK/FIX on a project that was never planned.
                if (parseTodo(dir).total === 0) {
                    const reason = 'Chưa có task để COOK: chạy >om:plan (hoặc cung cấp --spec hợp lệ) để sinh .omni/sdlc/todo.md';
                    emit({ type: 'blocked', reason });
                    state.status = 'blocked';
                    go('BLOCKED', reason);
                    saveState(dir, state);
                    return state;
                }
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
                    // FIX 3: no-progress detection. If the SAME failing gate-set
                    // survives a fix cycle, the agent can't move it (often a
                    // finding outside product scope) → escalate to BLOCKED fast
                    // instead of churning CHECK⇄FIX until the wallclock.
                    const sig = [...(gate.failures || [])].sort().join(',') + (lensFail ? '+lens' : '');
                    if (state.cameFromFix) {
                        state.noProgress = (state.lastFailures === sig) ? (state.noProgress || 0) + 1 : 0;
                    }
                    state.lastFailures = sig;
                    state.cameFromFix = false;
                    emit({ type: 'fix-attempt', failures: gate.failures, lensFail, noProgress: state.noProgress || 0 });

                    if ((state.noProgress || 0) >= budget.maxFixAttempts) {
                        const offending = describeGateFailures(gate.results, gate.failures);
                        const reason = `Gate ${gate.failures.join(',') || '(lens)'} không sửa được sau ${state.noProgress} lần${offending ? `; ${offending}` : ''}`;
                        const marked = markBlockedTask(dir);
                        emit({ type: 'blocked', reason, taskRef: marked });
                        state.status = 'blocked';
                        go('BLOCKED', reason);
                        saveState(dir, state);
                        return state;
                    }
                    go('FIX', `gate fail ${gate.failures.join(',') || ''}${lensFail ? ' +lens' : ''}`);
                } else if (await escalateOnDebate('check', 'Are the completed tasks correct and safe (no hidden bug/security/migration risk)?')) {
                    return state; // debate split/inconclusive → escalate to user, do not blind-fix
                } else {
                    // Gate green → reset no-progress tracking.
                    state.noProgress = 0;
                    state.lastFailures = null;
                    state.cameFromFix = false;
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
                    else go('ACCEPTANCE', 'gate pass, all tasks done → acceptance');
                }
                break;
            }
            case 'ACCEPTANCE': {
                const requirements = parseRequirements(dir);
                if (!requirements.length) {
                    // No customer-spec workflow in this project → keep legacy behaviour.
                    emit({ type: 'acceptance', allMet: true, met: 0, total: 0, failed: [], reason: 'no-requirements' });
                    go('DOC', 'no requirements.md → skip acceptance');
                    break;
                }
                const participants = Array.isArray(acceptSpecs) && acceptSpecs.length
                    ? acceptSpecs.map((s) => getProviderFromSpec(s, { ide, yolo, timeoutMs: stepTimeoutMs }))
                    : (Array.isArray(debateSpecs) && debateSpecs.length
                        ? debateSpecs.map((s) => getProviderFromSpec(s, { ide, yolo, timeoutMs: stepTimeoutMs }))
                        : []);
                const res = await runAcceptance({
                    projectDir: dir,
                    requirements,
                    runDebate,
                    participants,
                    rounds: debateRounds,
                    onEvent,
                });
                state.acceptanceRounds = (state.acceptanceRounds || 0) + 1;
                writeConformance(dir, res.report, { round: state.acceptanceRounds });
                emit({ type: 'acceptance', allMet: res.allMet, met: res.report.length - res.failed.length, total: res.report.length, failed: res.failed, round: state.acceptanceRounds });

                if (res.allMet) {
                    state.acceptanceRounds = 0;
                    saveState(dir, state);
                    if (acceptOnly) { state.status = 'done'; saveState(dir, state); return state; }
                    go('DOC', 'all requirements met');
                    break;
                }

                if (acceptOnly) {
                    // Stand-alone `omni run accept` — report + stop, do not re-cook.
                    state.status = 'paused';
                    emit({ type: 'pause', reason: `acceptance: ${res.failed.length} requirement(s) chưa đạt (${res.failed.join(', ')})` });
                    saveState(dir, state);
                    return state;
                }

                // Append "[ACCEPT] R<id>" tasks into todo.md so COOK has concrete targets.
                appendAcceptanceTasks(dir, res.report.filter((r) => !r.met));

                if (state.acceptanceRounds >= budget.maxAcceptanceRounds) {
                    const reason = `acceptance chưa đạt sau ${state.acceptanceRounds} vòng — unmet: ${res.failed.join(', ')}`;
                    emit({ type: 'blocked', reason });
                    state.status = 'blocked';
                    go('BLOCKED', reason);
                    saveState(dir, state);
                    return state;
                }

                go('COOK', `fix unmet requirements (round ${state.acceptanceRounds})`);
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
                state.cameFromFix = true; // FIX 3: next CHECK compares against lastFailures
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

module.exports = { STATE_PLAN, LOOP_NOTE, STEP_WORKFLOW, STATE_STEP, PIPELINE, planRun, buildSharedBrief, resolveStepWorkflow, appendAcceptanceTasks, runHarness };
