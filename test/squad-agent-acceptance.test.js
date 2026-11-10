'use strict';

// P7f harness pieces that run offline: plan-bound integrate delegation,
// requirements text, orchestrator argv and argument parsing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createAgentDelegation, loadAgentDelegation, createPlanBoundApprover, isAgentDelegatedDecision } = require('./helpers/agent-delegation');
const { parseArgs, requirementsMarkdown, orchestratorCommand, changedSourceFiles } = require('./squad-agent-acceptance');

function repo(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-agent-acceptance-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'x@example.invalid'); git('config', 'user.name', 'x');
    fs.writeFileSync(path.join(root, 'a.js'), '1\n'); git('add', 'a.js'); git('commit', '-q', '-m', 'base');
    const privateDir = path.join(root, '.private'); fs.mkdirSync(privateDir, { mode: 0o700 });
    return { root, privateDir, head: git('rev-parse', 'HEAD').trim() };
}

const digest = 'a'.repeat(64);
function derived({ planActor = 'human', planVia = 'cli-tty', planDigest = digest } = {}) {
    return { planRevision: 1, plan: { planSha256: digest },
        approvals: { 'plan-r1': { gate_id: 'plan-r1', phase: 'plan', status: 'approved', actor: planActor, via: planVia, digest: planDigest } },
        tasks: { 'TASK-1': { task_id: 'TASK-1' } } };
}
const integrate = { gate_id: 'integrate-TASK-1', phase: 'integrate', task_id: 'TASK-1', status: 'pending', digest: 'b'.repeat(64) };

test('plan-bound approver: integrate gates only, and only after a human TTY plan approval of the current plan', (t) => {
    const { root, privateDir, head } = repo(t);
    const ref = createAgentDelegation({ root, baselineCommit: head, privateDir, deadline: Date.now() + 3600000, preset: 'squad' });
    const delegation = loadAgentDelegation({ root, ...ref });
    let state = derived();
    const approve = createPlanBoundApprover({ root, delegation, ref, authorityStore: { derive: () => state } });
    assert.equal(approve(integrate), true);
    assert.equal(approve({ ...integrate, gate_id: 'integrate-OTHER' }), false);
    assert.equal(approve({ ...integrate, task_id: 'MISSING', gate_id: 'integrate-MISSING' }), false);
    assert.equal(approve({ gate_id: 'plan-r1', phase: 'plan', status: 'pending', digest }), false, 'never a plan gate');
    assert.equal(approve({ gate_id: 'spec-r1', phase: 'spec', status: 'pending', digest }), false, 'never a spec gate');
    state = derived({ planActor: 'test', planVia: 'test-harness' });
    assert.equal(approve(integrate), false, 'a delegated plan decision does not count');
    state = derived({ planDigest: 'c'.repeat(64) });
    assert.equal(approve(integrate), false, 'the approved digest must be the current plan');
    state = derived();
    fs.writeFileSync(path.join(root, 'a.js'), '2\n');
    execFileSync('git', ['commit', '-qam', 'moved'], { cwd: root });
    assert.equal(approve(integrate), false, 'a moved baseline ends the delegation');
});

test('plan-bound approver: expiry, tampering and errors leave the gate pending', (t) => {
    const { root, privateDir, head } = repo(t);
    const ref = createAgentDelegation({ root, baselineCommit: head, privateDir, deadline: Date.now() + 3600000, preset: 'dual' });
    const delegation = loadAgentDelegation({ root, ...ref });
    const late = createPlanBoundApprover({ root, delegation, ref, authorityStore: { derive: () => derived() }, now: () => Date.now() + 2 * 3600000 });
    assert.equal(late(integrate), false);
    const broken = createPlanBoundApprover({ root, delegation, ref, authorityStore: { derive: () => { throw new Error('boom'); } } });
    assert.equal(broken(integrate), false);
    fs.chmodSync(ref.path, 0o600); fs.appendFileSync(ref.path, ' ');
    const tampered = createPlanBoundApprover({ root, delegation, ref, authorityStore: { derive: () => derived() } });
    assert.equal(tampered(integrate), false);
    assert.throws(() => loadAgentDelegation({ root, ...ref }), { code: 'AGENT_DELEGATION_INVALID' });
    assert.throws(() => createAgentDelegation({ root, baselineCommit: head, privateDir, deadline: Date.now() + 5 * 3600000 }), { code: 'AGENT_DELEGATION_INVALID' });
});

test('recorded decisions: only integrate test/test-harness decisions inside the window count as delegated', () => {
    const delegation = { protocol: 'squad-agent-plan-bound-delegation-v1', createdAt: '2026-11-10T00:00:00Z', expiresAt: '2026-11-10T04:00:00Z' };
    const gate = { phase: 'integrate', digest, actor: 'test', via: 'test-harness', timestamp: '2026-11-10T01:00:00Z' };
    assert.equal(isAgentDelegatedDecision(gate, gate, delegation), true);
    assert.equal(isAgentDelegatedDecision({ ...gate, phase: 'plan' }, { ...gate, phase: 'plan' }, delegation), false);
    assert.equal(isAgentDelegatedDecision(gate, { ...gate, timestamp: '2026-11-10T05:00:00Z' }, delegation), false);
    assert.equal(isAgentDelegatedDecision(gate, { ...gate, actor: 'human', via: 'cli-tty' }, delegation), false);
});

test('requirements give the four goals without task metadata or hidden-test hints', () => {
    const text = requirementsMarkdown();
    assert.equal((text.match(/^## R\d/gm) || []).length, 4);
    assert.doesNotMatch(text, /allowed_files|Allowed files|hidden|T0\d/);
});

test('orchestrator argv: claude reads project MCP/hooks; codex gets MCP as session flags', () => {
    const binding = { roles: { orchestrator: { runtime: 'claude', model: 'sonnet', effort: 'low' } } };
    const claude = orchestratorCommand({ preset: 'squad', root: '/w', binding });
    assert.ok(claude.args.includes('-p') && claude.args.includes('acceptEdits') && claude.args.includes('mcp__omni_dual__*'));
    assert.ok(!claude.args.includes('bypassPermissions'));
    const codex = orchestratorCommand({ preset: 'dual', root: '/w', binding: { roles: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } } });
    assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(codex.args.some((arg) => arg.startsWith('mcp_servers.omni_dual.args=') && arg.includes('"--workspace","/w"')));
});

test('arguments and changed-file accounting', (t) => {
    assert.deepEqual(parseArgs(['out', '--preset', 'dual']).preset, 'dual');
    assert.throws(() => parseArgs(['out', '--preset', 'other']), { code: 'ACCEPTANCE_BAD_ARGS' });
    const { root, head } = repo(t);
    fs.writeFileSync(path.join(root, 'a.js'), '2\n');
    fs.mkdirSync(path.join(root, '.omni'));
    fs.writeFileSync(path.join(root, '.omni', 'x.json'), '{}');
    fs.writeFileSync(path.join(root, 'new.js'), '');
    assert.deepEqual(changedSourceFiles(root, head), ['.private/agent-gate-delegation.json', 'a.js', 'new.js'].filter((file) => fs.existsSync(path.join(root, file))));
});
