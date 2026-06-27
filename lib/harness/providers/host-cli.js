'use strict';

// Host-CLI provider (HARNESS-SPEC-PHASE-1 §2.7 + PHASE-2 §2d multi-IDE) — the
// heart of Pha 1. Drives the host agent headless. State is NOT inferred from
// the agent's prose — it lives in the artifacts the workflow writes.
//
// Per-IDE startup commands (README integration table):
//   claudecode/dual → claude -p "<prompt>" --permission-mode acceptEdits
//   gemini          → gemini --yolo -p "<prompt>"
//   codex           → codex exec "<prompt>"

const { runCommand: realRun } = require('../tools/shell');

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
            return { cmd: `claude -p ${q} --permission-mode acceptEdits` };
        case 'gemini':
            return { cmd: `gemini --yolo -p ${q}` };
        case 'codex':
            return { cmd: `codex exec ${q}` };
        case 'antigravity': {
            // `agy -p`/`--print` = confirmed headless one-shot. Known gotcha:
            // early versions drop stdout under a pipe — harmless for the
            // artifact-driven loop; use manual-relay for debate if stdout empties.
            const model = opts.model ? ` --model ${opts.model}` : '';
            return { cmd: `agy --dangerously-skip-permissions${model} -p ${q}` };
        }
        default:
            return { error: `host-cli chưa hỗ trợ ide=${ide}` };
    }
}

// modelByStep: omitted → no --model (verified-safe default, unchanged behavior).
//   'auto' → use ANTIGRAVITY_MODEL_BY_STEP preset (opt-in; verify model ids for
//   your agy build). An object → explicit per-step map.
function create({ ide = 'claudecode', timeoutMs = 10 * 60 * 1000, runCommand = realRun, modelByStep = null } = {}) {
    const modelFor = (step) => {
        if (modelByStep === 'auto') return ANTIGRAVITY_MODEL_BY_STEP[step];
        if (modelByStep && typeof modelByStep === 'object') return modelByStep[step];
        return undefined;
    };
    return {
        name: 'host-cli',
        buildCommand: (step, ctx = {}) => buildCommand(ide, promptFor(step, ctx), { model: modelFor(step) }),
        async runStep(step, ctx = {}) {
            const built = buildCommand(ide, promptFor(step, ctx), { model: modelFor(step) });
            if (built.error) return { ok: false, exitCode: 2, summary: built.error, durationMs: 0 };

            const started = Date.now();
            let res;
            try {
                res = runCommand(built.cmd, { cwd: ctx.projectDir, timeoutMs });
            } catch (e) {
                return { ok: false, exitCode: 1, summary: String((e && e.message) || e), durationMs: Date.now() - started };
            }
            const durationMs = Date.now() - started;
            if (res.exitCode === 127 || /not found|command not found/i.test(res.stderr || '')) {
                return { ok: false, exitCode: 127, summary: `${ide} CLI not found`, durationMs };
            }
            if (res.timedOut) {
                return { ok: false, exitCode: 124, summary: `>om:${step} timed out sau ${Math.round(timeoutMs / 1000)}s`, durationMs };
            }
            return { ok: res.exitCode === 0, exitCode: res.exitCode, summary: String(res.stdout || '').slice(-400), durationMs };
        },
    };
}

function promptFor(step, ctx) {
    const wf = ctx.workflowPath || '(unresolved workflow)';
    return `Read \`${wf}\` and execute the >om:${step} workflow strictly. `
        + `Do not summarize back — write your results to the artifacts the workflow specifies. `
        + `Context brief:\n${ctx.sharedBrief || '(no brief)'}`;
}

module.exports = { create, buildCommand, ANTIGRAVITY_MODEL_BY_STEP };
