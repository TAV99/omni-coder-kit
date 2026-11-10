'use strict';

// Acceptance-only use of the existing in-process test approver. Production CLI,
// MCP and daemon entry points never load or enable this module's delegation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { canonicalizeEvent } = require('../../lib/dual/authority-store');
const { DualPlanTaskSchema } = require('../../lib/dual/contracts');
const { validateTaskPath } = require('../../lib/dual/task-workspace');
const { FIXTURE, acceptanceTasks, ALL_TASK_IDS } = require('./acceptance-project');

const PROTOCOL = 'benchmark-delegation-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalizeEvent(a) === canonicalizeEvent(b);
const gitHead = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 20000 }).trim();
const contracts = (config, ids) => acceptanceTasks(config, ids).map(task => DualPlanTaskSchema.parse(task));

function assertFreshFixture(root, baselineCommit) {
    if (fs.realpathSync.native(root) !== root || path.basename(root) !== 'workspace'
        || !path.basename(path.dirname(root)).startsWith('omni-squad-acceptance-') || gitHead(root) !== baselineCommit) throw Error('fixture identity');
    for (const file of ['package.json', 'lib/catalog.js', 'lib/csv.js', 'lib/report.js', 'lib/format.js', 'bin/cli.js']) {
        let parent = root;
        for (const part of file.split('/').slice(0, -1)) {
            parent = path.join(parent, part);
            if (fs.lstatSync(parent).isSymbolicLink()) throw Error('symlinked fixture parent');
        }
        validateTaskPath(root, file);
        const target = path.join(root, file);
        if (!fs.lstatSync(target).isFile() || !fs.readFileSync(target).equals(fs.readFileSync(path.join(FIXTURE, 'bookshelf', file)))) throw Error('fixture source');
    }
    const ledger = path.join(root, '.omni/runs/dual-authority/events.ndjson');
    if (fs.existsSync(ledger) && fs.statSync(ledger).size) throw Error('authority already started');
    for (const file of ['hidden', 'reference', 'plans/finance-format.md']) if (fs.existsSync(path.join(root, file))) throw Error('private oracle exposed');
}

function createDelegation({ prepared, privateDir, deadline }) {
    const created = Date.now();
    try {
        assertFreshFixture(prepared.root, prepared.baselineCommit);
        if (!(deadline > created && deadline - created <= 4 * 3600000)) throw Error('deadline');
        const value = { protocol: PROTOCOL, id: crypto.randomUUID(), root: prepared.root, config: prepared.config,
            baselineCommit: prepared.baselineCommit, planSha256: prepared.planSha256, planRevision: 1,
            taskIds: prepared.tasks.map(task => task.task_id), contracts: prepared.tasks.map(task => DualPlanTaskSchema.parse(task)),
            createdAt: new Date(created).toISOString(), expiresAt: new Date(deadline).toISOString(),
            authority: 'Explicit user delegation of benchmark gate approvals on 2026-11-03; ask only for errors needing a decision.' };
        const bytes = JSON.stringify(value, null, 2) + '\n', file = path.join(privateDir, 'gate-delegation.json');
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        return { path: file, sha256: sha(bytes) };
    } catch { return fail('ACCEPTANCE_DELEGATION_INVALID'); }
}

function loadDelegation({ root, path: file, sha256, now = Date.now }) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('artifact');
        const bytes = fs.readFileSync(file), value = JSON.parse(bytes);
        if (sha(bytes) !== sha256 || value.protocol !== PROTOCOL || value.root !== root
            || !(Date.parse(value.expiresAt) > now()) || !(Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= 4 * 3600000)
            || !Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.some(id => !ALL_TASK_IDS.includes(id))
            || !same(value.contracts, contracts(value.config, value.taskIds))) throw Error('authority');
        assertFreshFixture(root, value.baselineCommit);
        return { ...value, artifactSha256: sha256 };
    } catch { return fail('ACCEPTANCE_DELEGATION_INVALID'); }
}

function createDelegatedApprover({ root, delegation, ref, authorityStore, now = Date.now }) {
    return gate => {
        try {
            if (now() < Date.parse(delegation.createdAt) || now() >= Date.parse(delegation.expiresAt)
                || sha(fs.readFileSync(ref.path)) !== ref.sha256 || root !== delegation.root
                || gitHead(root) !== delegation.baselineCommit) throw Error('expired or changed');
            const d = authorityStore.derive();
            if (d.planRevision !== 1 || d.plan?.planSha256 !== delegation.planSha256
                || !same(Object.keys(d.tasks).sort(), [...delegation.taskIds].sort())) throw Error('plan');
            for (const pin of delegation.contracts) {
                const actual = d.tasks[pin.task_id];
                if (actual.revision_id) throw Error('revision');
                for (const key of Object.keys(pin)) if (key !== 'owner' && !same(actual[key], pin[key])) throw Error('contract');
            }
            if (gate.status !== 'pending' || !/^[a-f0-9]{64}$/.test(gate.digest)) throw Error('gate');
            if (gate.phase === 'plan') {
                if (gate.gate_id !== 'plan-r1' || gate.digest !== delegation.planSha256) throw Error('plan gate');
            } else if (gate.phase === 'integrate') {
                if (!delegation.taskIds.includes(gate.task_id) || gate.gate_id !== `integrate-${gate.task_id}`) throw Error('task gate');
            } else throw Error('phase');
            return true;
        } catch { return fail('ACCEPTANCE_DELEGATION_SCOPE'); }
    };
}

function isDelegatedDecision(gate, decision, delegation) {
    if (!delegation || delegation.protocol !== PROTOCOL || !delegation.id || !/^[a-f0-9]{64}$/.test(delegation.artifactSha256 || '')
        || decision.actor !== 'test' || decision.via !== 'test-harness' || decision.digest !== gate.digest
        || !(decision.type === 'gate.approved' || decision.status === 'approved')) return false;
    if (delegation.planRevision !== 1 || (gate.plan_revision ?? 1) !== delegation.planRevision
        || (decision.plan_revision ?? 1) !== delegation.planRevision
        || !(Date.parse(delegation.expiresAt) - Date.parse(delegation.createdAt) > 0)
        || Date.parse(delegation.expiresAt) - Date.parse(delegation.createdAt) > 4 * 3600000) return false;
    const time = Date.parse(decision.timestamp || decision.decided_at);
    if (!(time >= Date.parse(delegation.createdAt) && time < Date.parse(delegation.expiresAt))) return false;
    if (gate.phase === 'plan') return gate.gate_id === `plan-r${delegation.planRevision}` && gate.digest === delegation.planSha256;
    return gate.phase === 'integrate' && Array.isArray(delegation.taskIds) && delegation.taskIds.includes(gate.task_id)
        && gate.gate_id === `integrate-${gate.task_id}`;
}

module.exports = { createDelegation, loadDelegation, createDelegatedApprover, isDelegatedDecision };
