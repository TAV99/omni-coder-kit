'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getProvider } = require('../lib/harness/providers');
const claudeSdk = require('../lib/harness/providers/claude-sdk');
const budget = require('../lib/harness/budget');

// Fake Anthropic SDK client — records the request, returns a canned message.
function fakeClient(captured) {
    return {
        messages: {
            create: async (req) => {
                captured.req = req;
                return {
                    stop_reason: 'end_turn',
                    content: [{ type: 'text', text: 'done' }],
                    usage: { input_tokens: 1000, output_tokens: 500 },
                };
            },
        },
    };
}

test('getProvider knows claude-sdk', () => {
    const p = getProvider('claude-sdk', { client: { messages: { create: async () => ({}) } } });
    assert.strictEqual(p.name, 'claude-sdk');
});

test('getProvider rejects unknown provider', () => {
    assert.throws(() => getProvider('gpt-9'), /không hỗ trợ/);
});

test('claude-sdk: conforms to Provider contract + returns usage with costUsd', async () => {
    const captured = {};
    const p = claudeSdk.create({ client: fakeClient(captured) });
    const r = await p.runStep('cook', { projectDir: '/x', sharedBrief: 'brief' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.usage);
    assert.strictEqual(r.usage.inputTokens, 1000);
    assert.strictEqual(r.usage.outputTokens, 500);
    // cook → sonnet ($3 in / $15 out per MTok): 1000/1e6*3 + 500/1e6*15 = 0.003 + 0.0075
    assert.ok(Math.abs(r.usage.costUsd - 0.0105) < 1e-9);
    assert.strictEqual(captured.req.model, 'claude-sonnet-4-6');
    // request surface: no temperature/top_p, no thinking
    assert.strictEqual(captured.req.temperature, undefined);
    assert.strictEqual(captured.req.thinking, undefined);
});

test('claude-sdk: model-per-step (fix→opus, doc→haiku) + override', async () => {
    const captured = {};
    const p = claudeSdk.create({ client: fakeClient(captured) });
    await p.runStep('fix', { projectDir: '/x' });
    assert.strictEqual(captured.req.model, 'claude-opus-4-8');
    await p.runStep('doc', { projectDir: '/x' });
    assert.strictEqual(captured.req.model, 'claude-haiku-4-5');

    const p2 = claudeSdk.create({ client: fakeClient(captured), modelByStep: { cook: 'claude-opus-4-8' } });
    await p2.runStep('cook', { projectDir: '/x' });
    assert.strictEqual(captured.req.model, 'claude-opus-4-8');
});

test('claude-sdk: refusal → ok:false', async () => {
    const client = { messages: { create: async () => ({ stop_reason: 'refusal', content: [], usage: {} }) } };
    const p = claudeSdk.create({ client });
    const r = await p.runStep('cook', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 1);
});

test('claude-sdk: SDK error is caught, not thrown', async () => {
    const client = { messages: { create: async () => { throw new Error('rate limited'); } } };
    const p = claudeSdk.create({ client });
    const r = await p.runStep('cook', {});
    assert.strictEqual(r.ok, false);
    assert.match(r.summary, /rate limited/);
});

// --- budget cost/token accounting -----------------------------------------

test('budget.addUsage accumulates tokens + cost', () => {
    const s = {};
    budget.addUsage(s, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    budget.addUsage(s, { inputTokens: 200, outputTokens: 0, costUsd: 0.02 });
    assert.strictEqual(s.tokens, 350);
    assert.ok(Math.abs(s.costUsd - 0.03) < 1e-9);
});

test('budget.checkBudget stops when cost exceeds maxCostUsd', () => {
    const b = budget.createBudget({ maxCostUsd: 1 });
    assert.strictEqual(budget.checkBudget({ iterations: 0, fixAttempts: 0, costUsd: 0.5 }, b, { elapsedMs: 0 }).stop, false);
    assert.match(budget.checkBudget({ iterations: 0, fixAttempts: 0, costUsd: 1.5 }, b, { elapsedMs: 0 }).reason, /chi phí/);
});

test('budget.createBudget validates maxCostUsd / maxTokens', () => {
    assert.throws(() => budget.createBudget({ maxCostUsd: 0 }), /maxCostUsd/);
    assert.throws(() => budget.createBudget({ maxTokens: -1 }), /maxTokens/);
    assert.doesNotThrow(() => budget.createBudget({ maxTokens: null }));
});
