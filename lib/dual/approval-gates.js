'use strict';

// Human approval gates (SPEC-SQUAD-P3 §5). The engine asks; only a person
// answers, through `omni squad approve` on a TTY. The CLI uses the daemon RPC
// when it runs; no MCP tool approves. Threat model: this stops an agent from
// approving by habit or by mistake, not an agent that fakes a terminal (V16).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class DualApprovalGateError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DualApprovalGateError';
        this.code = code;
    }
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function gateIdFor(phase, { taskId, planRevision } = {}) {
    if (phase === 'integrate') return `integrate-${taskId}`;
    return `${phase}-r${planRevision}`;
}

// Short code the person types back; derived from gate and digest, so it changes
// whenever the content to approve changes.
function confirmationCode(gate) {
    // P7b: one code for the displayed set; order is irrelevant, identities are not.
    if (Array.isArray(gate)) {
        return sha256(gate.map((entry) => `${entry.gate_id}:${entry.digest}`).sort().join(',')).slice(0, 6);
    }
    return sha256(`${gate.gate_id}:${gate.digest}`).slice(0, 6);
}

function howToApprove(gate) {
    return `Người dùng chạy: omni squad approve ${gate.gate_id}`;
}

// In-process seam for the test suite only: no CLI flag, env var or RPC reaches it.
// Every approval it grants is recorded as actor 'test', never as a person's.
let testApprover = null;
function setTestApprover(approver) {
    testApprover = typeof approver === 'function' ? approver : null;
}

// Returns { approved: true } once a person approved exactly this digest;
// otherwise makes sure a request is pending and returns it.
function requireApproval(authorityStore, { phase, taskId, planRevision, digest, summary }) {
    const result = requestApproval(authorityStore, { phase, taskId, planRevision, digest, summary });
    if (result.approved || result.rejected || !testApprover || testApprover(result.gate) !== true) return result;
    authorityStore.append({ schema_version: 2, type: 'gate.approved', gate_id: result.gate.gate_id,
        actor: 'test', via: 'test-harness', digest: result.gate.digest });
    return { approved: true, gate: authorityStore.derive().approvals[result.gate.gate_id] };
}

function requestApproval(authorityStore, { phase, taskId, planRevision, digest, summary }) {
    const derived = authorityStore.derive();
    const gateId = gateIdFor(phase, { taskId, planRevision: planRevision ?? derived.planRevision });
    const current = derived.approvals?.[gateId];
    if (current && current.digest === digest) {
        if (current.status === 'approved') return { approved: true, gate: current };
        if (current.status === 'rejected') return { approved: false, rejected: true, gate: current };
        return { approved: false, gate: current };
    }
    authorityStore.append({ schema_version: 2, type: 'gate.requested', gate_id: gateId, phase,
        ...(taskId ? { task_id: taskId } : {}), digest, summary: String(summary).slice(0, 512) });
    return { approved: false, gate: authorityStore.derive().approvals[gateId] };
}

// What the project's pipeline says about a phase gate (SPEC-SQUAD-P3 §5.2/§5.5).
// No pipeline: spec/plan stay ungated (pre-squad dual); integrate always gates.
// An unreadable pipeline fails closed: the gate stays with the person.
function phaseGatePolicy(projectRoot, phase) {
    if (phase === 'integrate') return { gated: true, autoOk: false };
    if (!fs.existsSync(path.join(projectRoot, '.omni', 'squad', 'pipeline.yaml'))) return { gated: false, autoOk: false };
    try {
        const { loadRoles } = require('../squad/roles');
        const { readPipelineIfAny } = require('../squad/pipeline');
        const pipeline = readPipelineIfAny(projectRoot, loadRoles(path.join(projectRoot, '.omni', 'squad', 'roles')));
        const entry = pipeline.phases.find((candidate) => candidate.id === phase);
        if (!entry || !['human', 'human-always'].includes(entry.gate)) return { gated: false, autoOk: false };
        return { gated: true, autoOk: entry.gate === 'human' && entry.auto_ok === true };
    } catch {
        return { gated: true, autoOk: false };
    }
}

function autoEnabled(projectRoot) {
    try { return require('../squad/bindings').readBinding(projectRoot)?.auto === true; }
    catch { return false; }
}

// requireApproval behind the project's pipeline and the person's AUTO choice.
function requirePhaseApproval(authorityStore, projectRoot, request) {
    const policy = phaseGatePolicy(projectRoot, request.phase);
    if (!policy.gated) return { approved: true, ungated: true };
    if (policy.autoOk && autoEnabled(projectRoot)) {
        const result = requestApproval(authorityStore, request);
        if (result.approved || result.rejected) return result;
        authorityStore.append({ schema_version: 2, type: 'gate.approved', gate_id: result.gate.gate_id,
            actor: 'auto', via: 'pipeline-auto', digest: result.gate.digest });
        return { approved: true, gate: authorityStore.derive().approvals[result.gate.gate_id] };
    }
    return requireApproval(authorityStore, request);
}

function pendingGates(derived) {
    return Object.values(derived.approvals || {}).filter((gate) => gate.status === 'pending');
}

// What status/MCP report so the orchestrator can tell the person what to run.
function awaitingGate(derived) {
    const [gate] = pendingGates(derived);
    return gate ? { gate_id: gate.gate_id, phase: gate.phase, ...(gate.task_id ? { task_id: gate.task_id } : {}),
        summary: gate.summary, digest: gate.digest, how: howToApprove(gate) } : null;
}

function decideGate(authorityStore, { gateId, approve, reason, code }) {
    const gate = authorityStore.derive().approvals?.[gateId];
    if (!gate) throw new DualApprovalGateError('SQUAD_GATE_UNKNOWN', `Không có cổng ${gateId}`);
    if (gate.status !== 'pending') throw new DualApprovalGateError('SQUAD_GATE_NOT_PENDING', `Cổng ${gateId} đã ${gate.status}`);
    if (code !== confirmationCode(gate)) throw new DualApprovalGateError('SQUAD_GATE_CODE_MISMATCH', 'Mã xác nhận không khớp');
    if (!approve && !(typeof reason === 'string' && reason.trim())) {
        throw new DualApprovalGateError('SQUAD_GATE_REASON_REQUIRED', 'Từ chối cần --reason');
    }
    authorityStore.append({ schema_version: 2, type: approve ? 'gate.approved' : 'gate.rejected', gate_id: gateId,
        actor: 'human', via: 'cli-tty', digest: gate.digest, ...(approve ? {} : { reason: reason.trim().slice(0, 1024) }) });
    return authorityStore.derive().approvals[gateId];
}

module.exports = {
    DualApprovalGateError, gateIdFor, confirmationCode, howToApprove,
    requireApproval, requirePhaseApproval, phaseGatePolicy, pendingGates, awaitingGate, decideGate, setTestApprover,
};
