'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTaskBinding, validateTaskPath, scanTaskWorkspace } = require('./task-workspace');
const { createConfiguredSnapshotBaseline } = require('./snapshot-policy');
const { canonicalizeEvent } = require('./authority-store');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function write(root, relative, value) {
    validateTaskPath(root, relative);
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    try {
        const fd = fs.openSync(path.join(root, relative), 'wx');
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    catch (error) {
        if (error.code === 'EEXIST') fail('DUAL_CHECKPOINT_EXISTS', 'Checkpoint evidence is write-once');
        throw error;
    }
    return { path: relative, sha256: hash(bytes) };
}
function read(root, reference) {
    validateTaskPath(root, reference.path);
    const stat = fs.statSync(path.join(root, reference.path));
    if (!stat.isFile() || stat.size > 384 * 1024 * 1024) fail('DUAL_CHECKPOINT_TAMPERED', 'Invalid checkpoint evidence size or type');
    const bytes = fs.readFileSync(path.join(root, reference.path));
    if (hash(bytes) !== reference.sha256) fail('DUAL_CHECKPOINT_TAMPERED', 'Checkpoint evidence hash changed');
    return JSON.parse(bytes);
}
function files(workerRoot, binding) {
    return [...scanTaskWorkspace(workerRoot, { runtimePath: binding.runtimePath,
        dependencies: binding.dependencyMode === 'npm-ci' }).values()];
}
function manifestFiles(entries) { return entries.map(({ bytes, ...entry }) => entry); }
function saveOriginalWorkspace(workspaceRoot, reference) {
    const { binding, workerRoot } = readTaskBinding(workspaceRoot, reference);
    return write(workspaceRoot, `${path.dirname(reference.bindingPath)}/original-workspace.json`,
        files(workerRoot, binding).map(({ bytes, ...entry }) => ({ ...entry, contentBase64: bytes.toString('base64') })));
}
function persistCheckpoint({ workspaceRoot, reference, milestone, sequence }) {
    const { binding, workerRoot } = readTaskBinding(workspaceRoot, reference);
    if (!milestone || typeof milestone.summary !== 'string' || !milestone.summary.trim()
        || typeof milestone.next !== 'string' || !milestone.next.trim()) {
        fail('DUAL_CHECKPOINT_INVALID', 'Completed milestone summary and next handoff are required');
    }
    const manifest = { schema_version: 1, phase: 'implement', milestone,
        completedMilestones: [...(reference.resumeLineage?.completedMilestones || []), milestone],
        sourceAttempt: binding.attempt, sourceReference: reference,
        originalBaseline: reference.originalBaseline, files: manifestFiles(files(workerRoot, binding)) };
    return write(workspaceRoot, `${path.dirname(reference.bindingPath)}/checkpoint-${sequence}.json`, manifest);
}

// Called only by the guarded authority API. Never remeasure a resumed baseline.
function prepareCheckpointResume({ workspaceRoot, sourceReference, checkpoint, attempt, sessionId, planRevision, task }) {
    try {
        const { binding, workerRoot } = readTaskBinding(workspaceRoot, sourceReference);
        if (binding.sessionId !== sessionId || binding.taskId !== task.task_id || binding.planRevision !== planRevision
            || !Number.isSafeInteger(attempt) || attempt <= binding.attempt) {
            fail('DUAL_CHECKPOINT_INVALID', 'Resume requires the same task and plan and a newer attempt');
        }
        const sourceDir = path.dirname(sourceReference.bindingPath);
        const checkpoints = fs.readdirSync(path.join(workspaceRoot, sourceDir)).filter(name => /^checkpoint-\d+\.json$/.test(name))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        if (checkpoints.length && checkpoint?.path !== `${sourceDir}/${checkpoints.at(-1)}`) {
            fail('DUAL_CHECKPOINT_INVALID', 'Explicit resume must name the latest completed checkpoint');
        }
        const baseline = sourceReference.originalBaseline;
        const originalWorkspace = sourceReference.originalWorkspace;
        if (!baseline || !originalWorkspace) fail('DUAL_CHECKPOINT_INVALID', 'Original baseline and retry workspace references are required');
        if (baseline.sha256 !== sourceReference.workerBaselineSha256) fail('DUAL_CHECKPOINT_TAMPERED', 'Original baseline reference changed');
        const baselineValue = read(workspaceRoot, baseline);
        const contractRef = { path: `${sourceDir}/worker-contract.json`, sha256: sourceReference.workerContractSha256 };
        const contract = read(workspaceRoot, contractRef);
        const original = read(workspaceRoot, originalWorkspace);
        let entries = original, milestone = null, completedMilestones = [];
        if (checkpoint) {
            const manifest = read(workspaceRoot, checkpoint);
            if (manifest.schema_version !== 1 || manifest.phase !== 'implement'
                || canonicalizeEvent(manifest.sourceReference) !== canonicalizeEvent(sourceReference)
                || manifest.sourceAttempt !== binding.attempt
                || canonicalizeEvent(manifest.originalBaseline) !== canonicalizeEvent(baseline)) {
                fail('DUAL_CHECKPOINT_TAMPERED', 'Checkpoint source identity changed');
            }
            const current = files(workerRoot, binding);
            if (JSON.stringify(manifest.files) !== JSON.stringify(manifestFiles(current))) {
                fail('DUAL_CHECKPOINT_TAMPERED', 'Preserved workspace differs from completed milestone');
            }
            entries = current.map(({ bytes, ...entry }) => ({ ...entry, contentBase64: bytes.toString('base64') }));
            completedMilestones = manifest.completedMilestones;
            milestone = { summary: completedMilestones.map(item => item.summary).join('\n'), next: manifest.milestone.next };
        }
        // All source evidence has been validated before claiming a new attempt.
        const nextDir = sourceDir.replace(/attempt-\d+$/, `attempt-${attempt}`);
        validateTaskPath(workspaceRoot, nextDir);
        fs.mkdirSync(path.join(workspaceRoot, nextDir));
        const nextRoot = path.join(workspaceRoot, nextDir, 'workspace');
        fs.mkdirSync(nextRoot);
        for (const entry of entries) {
            validateTaskPath(nextRoot, entry.path);
            const bytes = Buffer.from(entry.contentBase64, 'base64');
            if (hash(bytes) !== entry.sha256) fail('DUAL_CHECKPOINT_TAMPERED', 'Retry workspace content changed');
            const target = path.join(nextRoot, entry.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes, { flag: 'wx', mode: entry.mode });
            fs.chmodSync(target, entry.mode);
        }
        const startup = createConfiguredSnapshotBaseline({ root: nextRoot }).baseline.capture();
        const startupReference = write(workspaceRoot, `${nextDir}/resume-workspace-baseline.json`, startup);
        const resumeLineage = { startupReference, mode: checkpoint ? 'checkpoint' : 'baseline-retry', resumedFrom: checkpoint?.sha256 || null,
            checkpoint: checkpoint || null, sourceAttempt: binding.attempt, sourceBindingSha256: sourceReference.bindingSha256,
            sourceBindingPath: sourceReference.bindingPath, attempt, originalBaseline: baseline, milestone, completedMilestones };
        // Keep sourceFiles + snapshotSha256 unchanged: integration measures the entire original diff.
        const nextBinding = { ...binding, attempt, workerPath: `${nextDir}/workspace`, resumeLineage };
        const bindingBytes = `${canonicalizeEvent(nextBinding)}\n`;
        const bindingFd = fs.openSync(path.join(workspaceRoot, nextDir, 'binding.json'), 'wx');
        try { fs.writeFileSync(bindingFd, bindingBytes); fs.fsyncSync(bindingFd); } finally { fs.closeSync(bindingFd); }
        write(workspaceRoot, `${nextDir}/worker-baseline.json`, baselineValue);
        write(workspaceRoot, `${nextDir}/worker-contract.json`, contract);
        write(workspaceRoot, `${nextDir}/resume-lineage.json`, resumeLineage);
        return { bindingPath: `${nextDir}/binding.json`, bindingSha256: hash(bindingBytes), workerRoot: nextRoot,
            workerBaselineSha256: baseline.sha256, workerContractSha256: contractRef.sha256,
            originalBaseline: baseline, originalWorkspace, resumeLineage };
    } catch (error) {
        if (error.code?.startsWith('DUAL_CHECKPOINT_') || error.code === 'EEXIST') throw error;
        throw Object.assign(new Error(`Resume source validation failed: ${error.message}`, { cause: error }), { code: 'DUAL_CHECKPOINT_TAMPERED' });
    }
}
module.exports = { saveOriginalWorkspace, persistCheckpoint, prepareCheckpointResume };
