'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { canonicalizeEvent } = require('../../lib/dual/authority-store');
const { validateTaskPath } = require('../../lib/dual/task-workspace');
const { assertAllowedDiff } = require('../../lib/dual/scope-guard');
const { failure } = require('./squad-live');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (digest, mode) => digest === null ? undefined : `${0o100000 | mode}:${digest}`;
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(file => a.get(file) !== b.get(file)).sort();

// This observes file state, not file-operation traces. A QC window is reconciled
// at RPC completion because source writes precede their durable receipt event.
function createSourceGuard({ root, capture, authority, now = () => new Date().toISOString() }) {
    let expected = capture(), latched, qcTask = null, inQc = false, timer, integrations = 0, checks = 0, intervalMs = 500;
    const violations = [], consumed = new Set();
    function reject(code, files = []) {
        if (!latched) {
            violations.push({ code, at: now(), changed_files: files });
            latched = failure(code, files.join(', '));
        }
        throw latched;
    }
    function snapshot() {
        try { return capture(); }
        catch { return reject('ACCEPTANCE_SOURCE_OBSERVATION_FAILED'); }
    }
    function check() {
        if (latched) throw latched;
        if (inQc) return;
        checks++;
        const actual = snapshot();
        const files = changed(expected, actual);
        if (files.length) reject('ACCEPTANCE_SOURCE_DRIFT', files);
    }
    function readJson(relative) {
        validateTaskPath(root, relative);
        const file = path.join(root, relative), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw failure('ACCEPTANCE_SOURCE_RECEIPT_INVALID');
        const bytes = fs.readFileSync(file);
        return { bytes, value: JSON.parse(bytes) };
    }
    function acceptIntegration(record) {
        if (latched) throw latched;
        let next;
        try {
            const state = authority.derive(), task = state.tasks[record.task_id], handoff = task?.isolatedHandoff;
            const anchor = authority.readEvents().find(e => e.sequence === record.sequence);
            if (!inQc || qcTask && qcTask !== record.task_id || !handoff || consumed.has(record.sequence)
                || anchor?.type !== 'gate.result' || anchor.status !== 'PASSED' || anchor.task_id !== record.task_id
                || anchor.session_id !== state.sessionId || anchor.plan_revision !== state.planRevision
                || anchor.details?.integration_receipt !== record.integration_receipt
                || anchor.details?.result_sha256 !== record.result_sha256
                || handoff.attempt !== record.attempt || handoff.result_sha256 !== record.result_sha256) throw new Error('anchor');
            const stored = readJson(handoff.handoff_path);
            if (sha(stored.bytes) !== handoff.handoff_sha256) throw new Error('handoff');
            const { result } = stored.value, { resultSha256, ...payload } = result;
            if (sha(canonicalizeEvent(payload)) !== resultSha256 || resultSha256 !== record.result_sha256
                || result.bindingSha256 !== task.isolatedWorkspace.reference.bindingSha256
                || result.sessionId !== state.sessionId || result.planRevision !== state.planRevision
                || result.taskId !== record.task_id || result.attempt !== record.attempt) throw new Error('result');
            const receipt = readJson(record.integration_receipt).value;
            if (receipt.schema_version !== 1 || receipt.resultSha256 !== resultSha256
                || receipt.bindingSha256 !== result.bindingSha256) throw new Error('receipt');
            assertAllowedDiff({ changedFiles: result.changes.map(c => c.path), allowedFiles: task.allowed_files,
                denyPatterns: task.deny_patterns || [] });
            next = new Map(expected);
            const paths = new Set();
            for (const change of result.changes) {
                validateTaskPath(root, change.path);
                if (paths.has(change.path) || next.get(change.path) !== fingerprint(change.beforeSha256, change.beforeMode)) throw new Error('before');
                paths.add(change.path);
                if (change.afterSha256 === null) next.delete(change.path);
                else {
                    if (sha(Buffer.from(change.contentBase64, 'base64')) !== change.afterSha256) throw new Error('after');
                    next.set(change.path, fingerprint(change.afterSha256, change.afterMode));
                }
            }
        } catch (error) { return reject('ACCEPTANCE_SOURCE_RECEIPT_INVALID'); }
        const files = changed(next, snapshot());
        if (files.length) reject('ACCEPTANCE_SOURCE_DRIFT', files);
        expected = next; consumed.add(record.sequence); integrations++;
    }
    return {
        check, acceptIntegration,
        beginQc(taskId) {
            if (inQc) throw failure('ACCEPTANCE_SOURCE_QC_OVERLAP');
            check(); inQc = true; qcTask = taskId;
        },
        endQc() { inQc = false; qcTask = null; check(); },
        start({ intervalMs: interval = 500, onFailure }) {
            if (timer) throw failure('ACCEPTANCE_SOURCE_OBSERVER_STARTED');
            intervalMs = interval;
            timer = setInterval(() => {
                try { check(); }
                catch (error) { clearInterval(timer); timer = null; onFailure(error); }
            }, interval);
        },
        close() { clearInterval(timer); timer = null; },
        summary: () => ({ protocol: 'source-observer-v1', checks, integrations, violations: structuredClone(violations),
            passed: !latched, intervalMs, qcReconciliation: 'anchored-receipt-and-exact-bytes',
            limitations: 'Sampled file state; transient write-and-restore between samples and writer attribution are not observed.' }),
    };
}

module.exports = { createSourceGuard };
