'use strict';

// Sidebar state for `omni ui` (SPEC-SQUAD-P6 §3): roles and bindings, pipeline,
// session, tasks, active leases and pending gates, read straight from the squad
// files and the authority ledger. Read-only; the daemon need not be running.

const fs = require('node:fs');
const path = require('node:path');
const { createAuthorityStore } = require('../dual/authority-store');
const { pendingGates } = require('../dual/approval-gates');
const { ownerRole } = require('../dual/contracts');
const { readBinding } = require('../squad/bindings');
const { loadRoles } = require('../squad/roles');
const { readPipelineIfAny } = require('../squad/pipeline');

const AUTHORITY_DIR = path.join('.omni', 'runs', 'dual-authority');

function slot(binding) {
    return binding ? { runtime: binding.runtime, model: binding.model, ...(binding.effort ? { effort: binding.effort } : {}) } : null;
}

function squadConfig(projectRoot) {
    const config = { roles: [], pipeline: null, errors: [] };
    try {
        const binding = readBinding(projectRoot);
        if (binding) {
            config.roles.push({ id: 'orchestrator', ...slot(binding.roles.orchestrator) });
            for (const worker of binding.roles.worker) config.roles.push({ id: worker.id, ...slot(worker) });
            if (binding.roles.reviewer) config.roles.push({ id: 'reviewer', ...slot(binding.roles.reviewer) });
            config.preset = binding.preset;
        }
    } catch (error) { config.errors.push(`binding: ${error.message}`); }
    try {
        const rolesDir = path.join(projectRoot, '.omni', 'squad', 'roles');
        if (fs.existsSync(rolesDir)) {
            const pipeline = readPipelineIfAny(projectRoot, loadRoles(rolesDir));
            if (pipeline) config.pipeline = pipeline.phases.map((phase) => ({ id: phase.id, role: phase.role, ...(phase.gate ? { gate: phase.gate } : {}) }));
        }
    } catch (error) { config.errors.push(`pipeline: ${error.message}`); }
    return config;
}

function taskView(id, task) {
    const attempt = task.isolatedWorkspace?.attempt || task.correction?.attempt || 1;
    return {
        task_id: id, state: task.state, owner_role: ownerRole(task.owner), worker: task.worker || (task.owner === 'agy' ? 'worker-1' : null),
        title: task.title || null, attempt, allowed_files: task.allowed_files || [],
        ...(task.qcReview ? { qc_review: { attempt: task.qcReview.attempt, status: task.qcReview.status, verdict: task.qcReview.verdict || null,
            runtime: task.qcReview.runtime } } : {}),
        ...(task.lastOutcome ? { last_outcome: { status: task.lastOutcome.status, code: task.lastOutcome.code } } : {}),
        ...(task.waitingContext ? { waiting_context: true } : {}),
    };
}

// Recent user messages and who has taken each (SPEC-SQUAD-P6 §4).
function messageViews(derived, roles) {
    return Object.values(derived.messages || {}).sort((a, b) => b.sequence - a.sequence).slice(0, 30).map((message) => {
        const recipients = message.to === 'all' ? roles : [message.to];
        return { message_id: message.message_id, to: message.to, body: message.body.length > 400 ? `${message.body.slice(0, 400)}…` : message.body,
            posted_at: message.posted_at,
            delivered: Object.entries(message.delivered).map(([role, delivery]) => ({ role, via: delivery.via, at: delivery.at,
                ...(delivery.task_id ? { task_id: delivery.task_id } : {}) })),
            waiting: recipients.filter((role) => !message.delivered[role]) };
    });
}

function buildState(projectRoot) {
    const state = { project: path.basename(projectRoot), ...squadConfig(projectRoot), session: null, tasks: [], leases: [], gates: [], messages: [] };
    const authorityDir = path.join(projectRoot, AUTHORITY_DIR);
    if (!fs.existsSync(path.join(authorityDir, 'events.ndjson'))) return state;
    try {
        const derived = createAuthorityStore(authorityDir).derive();
        state.session = { id: derived.sessionId, state: derived.sessionState, plan_revision: derived.planRevision };
        state.tasks = Object.entries(derived.tasks || {}).map(([id, task]) => taskView(id, task));
        state.leases = Object.values(derived.leases || {}).filter((lease) => lease.status === 'active')
            .map((lease) => ({ task_id: lease.task_id, owner_role: ownerRole(lease.owner), expires_at: lease.expires_at }));
        // The UI never approves (SPEC-SQUAD-P6 §0.2): it shows the command a person runs.
        state.gates = pendingGates(derived).map((gate) => ({ gate_id: gate.gate_id, phase: gate.phase, summary: gate.summary,
            ...(gate.task_id ? { task_id: gate.task_id } : {}), command: `omni squad approve ${gate.gate_id}` }));
        state.messages = messageViews(derived, state.roles.map((role) => role.id));
    } catch (error) {
        state.errors.push(`authority: ${error.code || error.message}`);
    }
    return state;
}

module.exports = { buildState };
