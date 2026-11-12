'use strict';

// SPEC-SQUAD-P8 §5.2 (P8c): the first-run setup page — role slots per preset,
// last-used or first-ready defaults, the apply body, and the page's safety rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../../lib/ui/static/workspace/setup.mjs');
const PRESETS = { squad: { workers: [1, 8], reviewer: true }, dual: { workers: [1, 1], reviewer: false } };
const RUNTIMES = [
    { id: 'claude', ready: true, version: { ok: true, version: '2.1.316' }, models: { ok: true, models: [
        { id: 'sonnet', efforts: ['low', 'medium', 'high'], defaultEffort: null }, { id: 'opus', efforts: ['high'], defaultEffort: 'high' }] } },
    { id: 'codex', ready: true, models: { ok: true, models: [{ id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] } },
    { id: 'agy', ready: false, detect: { found: true }, auth: { state: 'unauthenticated' }, models: { ok: false } },
    { id: 'opencode', ready: false, detect: { found: false } },
];

test('role slots follow the preset and clamp the worker count', async () => {
    const { slotIdsFor } = await load();
    assert.deepEqual(slotIdsFor('dual', 3, PRESETS), ['orchestrator', 'worker-1']);
    assert.deepEqual(slotIdsFor('squad', 2, PRESETS), ['orchestrator', 'worker-1', 'worker-2', 'reviewer']);
    assert.deepEqual(slotIdsFor('squad', 99, PRESETS).length, 10);
});

test('a CLI that is missing or signed out is named, not offered', async () => {
    const { runtimeProblem } = await load();
    assert.deepEqual(RUNTIMES.map(runtimeProblem), [null, null, 'chưa đăng nhập', 'chưa cài']);
    assert.equal(runtimeProblem(undefined), 'không có trên máy');
});

test('defaults: last-used binding when still usable, else the first ready CLI and its default effort', async () => {
    const { defaultSlot } = await load();
    const defaults = { squad: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }] } };
    assert.deepEqual(defaultSlot('orchestrator', { preset: 'squad', defaults, runtimes: RUNTIMES }), { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    // agy is signed out, so its last-used worker falls back to the first ready CLI.
    assert.deepEqual(defaultSlot('worker-1', { preset: 'squad', defaults, runtimes: RUNTIMES }), { runtime: 'claude', model: 'sonnet', effort: 'low' });
    assert.deepEqual(defaultSlot('reviewer', { preset: 'squad', defaults: {}, runtimes: RUNTIMES }), { runtime: 'claude', model: 'sonnet', effort: 'low' });
    assert.deepEqual(defaultSlot('orchestrator', { preset: 'dual', defaults: {}, runtimes: [] }), { runtime: '', model: '', effort: '' });
});

test('the apply body carries only the preset slots, drops empty efforts and keeps displace', async () => {
    const { applyBody } = await load();
    const form = { preset: 'dual', workers: 1, presets: PRESETS, displace: false, slots: {
        orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        'worker-1': { runtime: 'claude', model: 'sonnet', effort: '' },
        reviewer: { runtime: 'claude', model: 'opus', effort: 'high' } } };
    assert.deepEqual(applyBody(form, 'req-00000001'), { request_id: 'req-00000001', preset: 'dual', workers: 1, displace: false,
        binds: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, 'worker-1': { runtime: 'claude', model: 'sonnet' } } });
});

test('the setup page renders server data as text and has no gate decision', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'ui', 'static', 'workspace', 'setup.mjs'), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(source, /approve|gate\.decide/i);
    assert.match(source, /textContent/);
});

test('the app opens the setup page when the server is in setup mode', async () => {
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'ui', 'static', 'workspace', 'app.mjs'), 'utf8');
    assert.match(app, /state\.mode === 'setup'\) return mountSetup\(/);
    const { createApiClient } = await import('../../lib/ui/static/workspace/app.mjs');
    const calls = [];
    const api = createApiClient({ fetchImpl: async (url, init) => { calls.push([url, init.method]); return { ok: true, status: 200, text: async () => '{}' }; } });
    await api.setupRuntimes(true);
    await api.setupPreflight({ preset: 'dual' });
    await api.setupApply({ preset: 'dual' });
    assert.deepEqual(calls, [['/api/setup/runtimes?refresh=1', 'GET'], ['/api/setup/preflight', 'POST'], ['/api/setup/apply', 'POST']]);
});
