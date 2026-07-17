'use strict';

// Manual-relay provider (HARNESS-SPEC-PHASE-3 §3a fallback).
//
// Semi-automated host for an agent without a usable headless mode (or whose
// headless stdout is unreliable). runStep writes the prompt to
// .omni/run/relay/<step>.prompt.md and reads the operator's reply from
// .omni/run/relay/<step>.answer.md. Lets any subscription agent (e.g. an
// Antigravity window) join a debate without an API key. `readAnswer` is
// injectable so tests don't block on a file/TTY.

const fs = require('fs');
const path = require('path');

function create({ readAnswer = null, label = 'manual-relay' } = {}) {
    return {
        name: 'manual-relay',
        async runStep(step, ctx = {}) {
            const dir = ctx.projectDir || process.cwd();
            const relayDir = path.join(dir, '.omni', 'run', 'relay');
            fs.mkdirSync(relayDir, { recursive: true });
            const promptPath = path.join(relayDir, `${step}.prompt.md`);
            const answerPath = path.join(relayDir, `${step}.answer.md`);

            const promptText = `# >om-${step} (manual relay — ${label})\n\n`
                + `Workflow: ${ctx.workflowPath || '(none)'}\n\n`
                + `${ctx.sharedBrief || '(no brief)'}\n\n`
                + `--- Dán câu trả lời của agent vào: ${answerPath} ---\n`;
            fs.writeFileSync(promptPath, promptText, 'utf-8');

            const reader = readAnswer || (() => (fs.existsSync(answerPath) ? fs.readFileSync(answerPath, 'utf-8') : null));
            const answer = await reader(step, promptText, { promptPath, answerPath });

            if (answer == null || String(answer).trim() === '') {
                return { ok: false, exitCode: 3, summary: `awaiting manual answer: ${answerPath}`, durationMs: 0 };
            }
            return { ok: true, exitCode: 0, summary: String(answer).slice(-2000), durationMs: 0 };
        },
    };
}

module.exports = { create };
