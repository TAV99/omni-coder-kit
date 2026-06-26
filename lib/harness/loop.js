'use strict';

// ---------------------------------------------------------------------------
// Harness orchestrator (HARNESS-UPGRADE-PLAN §2/§4, Pha 0 skeleton).
//
// Pha 0 delivers `omni run --dry-run`: print the planned state sequence and the
// artifact each phase reads/writes — NO LLM calls, NO tool execution. The real
// loop (provider adapter + tool registry + gates) lands in Pha 1/2.
//
// Design guardrail (docs/orchestration-patterns.md, anti-pattern C): each phase
// hands off via a real artifact under .omni/sdlc/, NOT a paraphrased summary.
// The dry-run output surfaces those artifacts so the contract is visible.
// ---------------------------------------------------------------------------

const { PIPELINE, planPipeline, createState } = require('./state');
const { createBudget } = require('./budget');

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

// Build the dry-run plan: ordered phases from `from` to DONE + the quality loop note.
function planRun({ from = 'INIT', provider = 'host-cli' } = {}) {
    const sequence = planPipeline(from).map((state) => ({
        state,
        ...(STATE_PLAN[state] || { agent: '?', artifact: '?', note: '' }),
    }));
    return {
        provider,
        from,
        sequence,
        loopNote: LOOP_NOTE,
        budget: createBudget(),
    };
}

// Pha 0: real execution is not wired (no provider/tools/gates yet). Returns a
// structured refusal so the command layer can guide the user to --dry-run.
function runHarness({ dryRun = false, from = 'INIT', provider = 'host-cli' } = {}) {
    if (dryRun) {
        return { executed: false, mode: 'dry-run', plan: planRun({ from, provider }) };
    }
    return {
        executed: false,
        mode: 'live',
        plan: planRun({ from, provider }),
        reason: 'Harness execution chưa khả dụng (Pha 0 — chỉ skeleton + --dry-run). '
            + 'Provider adapter + tool registry + gates sẽ đến ở Pha 1/2.',
        initialState: createState({ provider, from }),
    };
}

module.exports = { STATE_PLAN, LOOP_NOTE, PIPELINE, planRun, runHarness };
