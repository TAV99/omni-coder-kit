'use strict';

// Claude Agent SDK provider (HARNESS-SPEC-PHASE-2 §2c).
//
// Calls the LLM directly via the Anthropic SDK (@anthropic-ai/sdk) instead of
// driving `claude -p`. Implements the Pha 1 Provider contract and additionally
// returns `usage: {inputTokens, outputTokens, costUsd, model}` so the loop can
// enforce a token/cost budget. The SDK client is lazily required and injectable
// (tests pass a fake — no real API call in CI).
//
// Model-per-step + pricing verified via the claude-api skill (model IDs + $/MTok).
// Request surface per skill: no temperature/top_p, omit `thinking`, handle the
// `refusal` stop reason.

const fs = require('fs');

// $ per 1M tokens (input / output).
const PRICING = Object.freeze({
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
});

// step → model (addyosmani agent-persona mapping, ADOPT T2.3): cheap scan on
// Haiku, review/build on Sonnet, high-stakes/security on Opus.
const MODEL_BY_STEP = Object.freeze({
    brainstorm: 'claude-opus-4-8',
    equip: 'claude-haiku-4-5',
    plan: 'claude-sonnet-4-6',
    cook: 'claude-sonnet-4-6',
    check: 'claude-sonnet-4-6',
    fix: 'claude-opus-4-8',
    doc: 'claude-haiku-4-5',
    ship: 'claude-sonnet-4-6',
    security: 'claude-opus-4-8',
});

function costUsd(model, inTok, outTok) {
    const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
    return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

function create({ client = null, modelByStep = {}, maxTokens = 8192, defaultModel = 'claude-sonnet-4-6' } = {}) {
    const models = { ...MODEL_BY_STEP, ...modelByStep };
    let sdk = client;

    const getClient = () => {
        if (sdk) return sdk;
        try {
            const Anthropic = require('@anthropic-ai/sdk');
            sdk = new Anthropic(); // reads ANTHROPIC_API_KEY / profile from env
        } catch {
            throw new Error("claude-sdk cần `npm i @anthropic-ai/sdk` (hoặc inject client cho test)");
        }
        return sdk;
    };

    return {
        name: 'claude-sdk',
        async runStep(step, ctx = {}) {
            const model = models[step] || defaultModel;
            let workflowText = '';
            if (ctx.workflowPath) {
                try { workflowText = fs.readFileSync(ctx.workflowPath, 'utf-8'); } catch { /* ignore */ }
            }
            const system = `${workflowText}\n\n--- Context brief ---\n${ctx.sharedBrief || '(no brief)'}`;
            const prompt = `Execute the >om-${step} workflow strictly on this project. `
                + `Write results to the artifacts the workflow specifies — do not summarize back.`;

            const started = Date.now();
            let resp;
            try {
                resp = await getClient().messages.create({
                    model,
                    max_tokens: maxTokens,
                    system,
                    messages: [{ role: 'user', content: prompt }],
                });
            } catch (e) {
                return { ok: false, exitCode: 1, summary: String((e && e.message) || e), durationMs: Date.now() - started };
            }
            const durationMs = Date.now() - started;
            const u = resp.usage || {};
            const inTok = u.input_tokens || 0;
            const outTok = u.output_tokens || 0;
            const text = Array.isArray(resp.content)
                ? resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
                : '';
            const refused = resp.stop_reason === 'refusal';
            return {
                ok: !refused,
                exitCode: refused ? 1 : 0,
                summary: refused ? 'refusal' : text.slice(-400),
                durationMs,
                usage: { inputTokens: inTok, outputTokens: outTok, costUsd: costUsd(model, inTok, outTok), model },
            };
        },
    };
}

module.exports = { create, MODEL_BY_STEP, PRICING, costUsd };
