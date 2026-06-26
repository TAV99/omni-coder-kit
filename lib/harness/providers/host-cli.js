'use strict';

// Host-CLI provider (HARNESS-SPEC-PHASE-1 §2.7) — the heart of Pha 1.
//
// Drives the host agent headless (Claude Code: `claude -p`). The loop resolves
// the workflow file per step and passes it in ctx; this provider only builds the
// prompt and shells out. State is NOT inferred from the agent's prose — it lives
// in the artifacts the workflow writes (todo.md, test-report.md, …).

const { runCommand } = require('../tools/shell');

function create({ ide = 'claudecode', timeoutMs = 10 * 60 * 1000 } = {}) {
    return {
        name: 'host-cli',
        async runStep(step, ctx = {}) {
            const wf = ctx.workflowPath || '(unresolved workflow)';
            const prompt = `Read \`${wf}\` and execute the >om:${step} workflow strictly. `
                + `Do not summarize back — write your results to the artifacts the workflow specifies. `
                + `Context brief:\n${ctx.sharedBrief || '(no brief)'}`;

            // Pha 1 supports the Claude Code host. Other IDEs land in Pha 2.
            if (ide !== 'claudecode' && ide !== 'dual') {
                return { ok: false, exitCode: 2, summary: `host-cli Pha 1 chỉ hỗ trợ Claude Code (ide=${ide})`, durationMs: 0 };
            }

            const cmd = `claude -p ${JSON.stringify(prompt)} --permission-mode acceptEdits`;
            const started = Date.now();
            let res;
            try {
                res = runCommand(cmd, { cwd: ctx.projectDir, timeoutMs });
            } catch (e) {
                return { ok: false, exitCode: 1, summary: String(e && e.message || e), durationMs: Date.now() - started };
            }
            const durationMs = Date.now() - started;
            if (res.exitCode === 127 || /not found|command not found/i.test(res.stderr || '')) {
                return { ok: false, exitCode: 127, summary: 'claude CLI not found', durationMs };
            }
            if (res.timedOut) {
                return { ok: false, exitCode: 124, summary: `>om:${step} timed out sau ${Math.round(timeoutMs / 1000)}s`, durationMs };
            }
            return {
                ok: res.exitCode === 0,
                exitCode: res.exitCode,
                summary: String(res.stdout || '').slice(-400),
                durationMs,
            };
        },
    };
}

module.exports = { create };
