'use strict';

// P7f (real-orchestrator tier) gate delegation, user decision 2026-11-10:
// the person approves spec/plan gates on a TTY; afterwards integrate gates of
// tasks in exactly that human-approved plan are approved for them and recorded
// as actor 'test' / via 'test-harness'. Nothing here approves a spec or plan
// gate, and any mismatch leaves the gate pending for the person.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PROTOCOL = 'squad-agent-plan-bound-delegation-v1';
const MAX_MS = 4 * 3600000;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const gitHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 20_000 }).trim();
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function createAgentDelegation({ root, baselineCommit, privateDir, deadline, preset, now = Date.now }) {
    const created = now();
    if (!(deadline > created && deadline - created <= MAX_MS) || gitHead(root) !== baselineCommit) fail('AGENT_DELEGATION_INVALID');
    const value = { protocol: PROTOCOL, id: crypto.randomUUID(), root, preset, baselineCommit,
        createdAt: new Date(created).toISOString(), expiresAt: new Date(deadline).toISOString(),
        scope: 'integrate gates of tasks in the human-approved plan revision only',
        authority: 'User decision 2026-11-10: the user approves the plan; do not make them type codes for every integrate gate.' };
    const bytes = JSON.stringify(value, null, 2) + '\n';
    const file = path.join(privateDir, 'agent-gate-delegation.json');
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
}

function loadAgentDelegation({ root, path: file, sha256, now = Date.now }) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('AGENT_DELEGATION_INVALID');
    const bytes = fs.readFileSync(file), value = JSON.parse(bytes);
    if (sha(bytes) !== sha256 || value.protocol !== PROTOCOL || value.root !== root
        || !(Date.parse(value.expiresAt) > now()) || Date.parse(value.expiresAt) - Date.parse(value.createdAt) > MAX_MS) {
        fail('AGENT_DELEGATION_INVALID');
    }
    return { ...value, artifactSha256: sha256 };
}

// The human plan decision this delegation may build on, or null.
function humanPlanApproval(derived) {
    const gate = derived.approvals?.[`plan-r${derived.planRevision}`];
    if (!gate || gate.status !== 'approved' || gate.actor !== 'human' || gate.via !== 'cli-tty') return null;
    if (!derived.plan || derived.plan.planSha256 !== gate.digest) return null;
    return gate;
}

function createPlanBoundApprover({ root, delegation, ref, authorityStore, now = Date.now }) {
    return (gate) => {
        try {
            const time = now();
            if (time < Date.parse(delegation.createdAt) || time >= Date.parse(delegation.expiresAt)) return false;
            if (sha(fs.readFileSync(ref.path)) !== ref.sha256 || root !== delegation.root) return false;
            if (gitHead(root) !== delegation.baselineCommit) return false;
            if (gate?.status !== 'pending' || gate.phase !== 'integrate' || !/^[a-f0-9]{64}$/.test(gate.digest || '')) return false;
            const derived = authorityStore.derive();
            if (!humanPlanApproval(derived)) return false;
            const task = derived.tasks?.[gate.task_id];
            return Boolean(task && gate.gate_id === `integrate-${gate.task_id}`);
        } catch { return false; }
    };
}

// Whether a recorded decision is one this delegation could have made.
function isAgentDelegatedDecision(gate, decision, delegation) {
    if (!delegation || delegation.protocol !== PROTOCOL || decision.actor !== 'test' || decision.via !== 'test-harness') return false;
    const time = Date.parse(decision.timestamp || decision.decided_at);
    return gate.phase === 'integrate' && decision.digest === gate.digest
        && time >= Date.parse(delegation.createdAt) && time < Date.parse(delegation.expiresAt);
}

module.exports = { PROTOCOL, createAgentDelegation, loadAgentDelegation, createPlanBoundApprover, humanPlanApproval, isAgentDelegatedDecision };
