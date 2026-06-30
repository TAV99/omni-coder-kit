'use strict';

// Host-CLI provider (HARNESS-SPEC-PHASE-1 §2.7 + PHASE-2 §2d multi-IDE) — the
// heart of Pha 1. Drives the host agent headless. State is NOT inferred from
// the agent's prose — it lives in the artifacts the workflow writes.
//
// Per-IDE startup commands (README integration table):
//   claudecode/dual → claude -p "<prompt>" --permission-mode acceptEdits
//   gemini          → gemini --yolo -p "<prompt>"
//   codex           → codex exec "<prompt>"

const { runCommand: realRun, runCommandAsync: realRunAsync } = require('../tools/shell');
const { lastLines } = require('../observability');

// agy/Gemini CLI model names per step (verified: --model flag, v1.0.5). Fast
// model for scans/simple edits, Pro for reasoning-heavy work. Override via
// create({ modelByStep }). Only emitted when a model is resolved.
const ANTIGRAVITY_MODEL_BY_STEP = {
    map: 'gemini-3-flash', scan: 'gemini-3-flash', brainstorm: 'gemini-3-flash',
    cook: 'gemini-3-pro', fix: 'gemini-3-pro', check: 'gemini-3-pro', security: 'gemini-3-pro',
};

// Returns { cmd } or { error } for an unsupported ide. opts.model (optional)
// adds a `--model` flag where the host CLI supports it (agy).
function buildCommand(ide, prompt, opts = {}) {
    const q = JSON.stringify(prompt);
    switch (ide) {
        case 'claudecode':
        case 'dual':
            // Mặc định an toàn: acceptEdits (chỉ tự duyệt sửa file). --yolo →
            // --dangerously-skip-permissions (bỏ qua cả lệnh shell) để loop tự
            // lái không treo, đồng bộ với agy. Harness vẫn chặn qua tools/shell.js.
            return { cmd: opts.yolo
                ? `claude -p ${q} --dangerously-skip-permissions`
                : `claude -p ${q} --permission-mode acceptEdits` };
        case 'gemini':
            return { cmd: `gemini --yolo -p ${q}` };
        case 'codex':
            return { cmd: opts.yolo ? `codex exec --dangerously-bypass-approvals-and-sandbox ${q}` : `codex exec ${q}` };
        case 'antigravity': {
            // `agy -p`/`--print` = confirmed headless one-shot. Known gotcha:
            // early versions drop stdout under a pipe — harmless for the
            // artifact-driven loop; use manual-relay for debate if stdout empties.
            const model = opts.model ? ` --model ${opts.model}` : '';
            // ROOT FIX (SPEC-FIX-ANTIGRAVITY-WORKSPACE): agy ignores the shell's
            // cwd and writes into ~/.gemini/antigravity-cli/scratch/ by default
            // — invisible to the harness, which then never observes progress and
            // burns the 10-minute OS timeout. `--add-dir` scopes agy to the
            // project so it reads/writes the actual workflow + artifacts.
            const addDir = opts.projectDir ? ` --add-dir ${JSON.stringify(opts.projectDir)}` : '';
            // Keep agy's own --print-timeout ~30s BELOW the harness OS timeout
            // so agy returns (with output) before omni SIGKILLs blind. Floor 30s.
            const printTimeout = opts.printTimeoutSec ? ` --print-timeout ${opts.printTimeoutSec}s` : '';
            return { cmd: `agy --dangerously-skip-permissions${addDir}${model}${printTimeout} -p ${q}` };
        }
        default:
            return { error: `host-cli chưa hỗ trợ ide=${ide}` };
    }
}

// modelByStep: omitted → no --model (verified-safe default, unchanged behavior).
//   'auto' → use ANTIGRAVITY_MODEL_BY_STEP preset (opt-in; verify model ids for
//   your agy build). An object → explicit per-step map.
function create({
    ide = 'claudecode', timeoutMs = 10 * 60 * 1000,
    runCommand = realRun, runCommandAsync = realRunAsync,
    modelByStep = null, yolo = false,
    // OBS-3: async = use the spawn path (event loop free → heartbeat ticks fire).
    // stream = additionally forward raw stdout via onStdout. async implied by stream.
    async = false, stream = false, onStdout = null,
} = {}) {
    const modelFor = (step) => {
        if (modelByStep === 'auto') return ANTIGRAVITY_MODEL_BY_STEP[step];
        if (modelByStep && typeof modelByStep === 'object') return modelByStep[step];
        return undefined;
    };
    const useAsync = async || stream;
    // Keep agy's print-timeout 30s under our OS timeout so it returns with
    // output instead of being killed mid-step (sàn 30s for very short budgets).
    const printTimeoutSec = Math.max(30, Math.round(timeoutMs / 1000) - 30);
    return {
        name: 'host-cli',
        ide,
        modelFor,
        buildCommand: (step, ctx = {}) => buildCommand(ide, promptFor(step, ctx), {
            model: modelFor(step), yolo,
            projectDir: ctx.projectDir,
            printTimeoutSec,
        }),
        async runStep(step, ctx = {}) {
            const model = modelFor(step);
            const built = buildCommand(ide, promptFor(step, ctx), {
                model, yolo,
                projectDir: ctx.projectDir,
                printTimeoutSec,
            });
            if (built.error) return { ok: false, exitCode: 2, summary: built.error, durationMs: 0, stderrTail: built.error, model };

            const started = Date.now();
            let res;
            try {
                res = useAsync
                    ? await runCommandAsync(built.cmd, { cwd: ctx.projectDir, timeoutMs, onStdout, signal: ctx.signal })
                    : runCommand(built.cmd, { cwd: ctx.projectDir, timeoutMs });
            } catch (e) {
                const msg = String((e && e.message) || e);
                return { ok: false, exitCode: 1, summary: msg, durationMs: Date.now() - started, stderrTail: msg, model };
            }
            const durationMs = Date.now() - started;
            // OBS-2: surface the tail of stderr (not just an exit code) so a fail
            // shows WHY. Computed for every outcome; consumed only when !ok.
            const stderrTail = lastLines(res.stderr || '', 15);
            if (res.exitCode === 127 || /not found|command not found/i.test(res.stderr || '')) {
                return { ok: false, exitCode: 127, summary: `${ide} CLI not found`, durationMs, stderrTail, model };
            }
            if (res.timedOut) {
                return { ok: false, exitCode: 124, summary: `>om:${step} timed out sau ${Math.round(timeoutMs / 1000)}s`, durationMs, timedOut: true, timeoutMs, stderrTail, model };
            }
            return { ok: res.exitCode === 0, exitCode: res.exitCode, summary: String(res.stdout || '').slice(-400), durationMs, stderrTail, model };
        },
    };
}

function promptFor(step, ctx) {
    const wf = ctx.workflowPath || '(unresolved workflow)';
    // Anchor working dir WITHOUT telling the agent to execute files. agy is
    // literal: "run ALL files" / "execute <file>.md" made it `sh` the markdown
    // workflow → "Permission denied" → hang/timeout. Be explicit: read & follow.
    const dirLine = ctx.projectDir
        ? `Your working directory is \`${ctx.projectDir}\`. Create and edit project files there; do NOT use any scratch directory.\n`
        : '';
    return `${dirLine}`
        + `Open and READ the instructions in \`${wf}\` — it is a Markdown playbook (documentation). `
        + `Do NOT run or execute that file as a script. `
        + `Then carry out the >om:${step} task by FOLLOWING those instructions on this project. `
        + `Do not summarize back — write your results into the artifacts the playbook specifies. `
        + `Context brief:\n${ctx.sharedBrief || '(no brief)'}`;
}

module.exports = { create, buildCommand, promptFor, ANTIGRAVITY_MODEL_BY_STEP };
