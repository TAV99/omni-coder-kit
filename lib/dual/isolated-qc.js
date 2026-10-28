'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertRuntimeCoverage, assertRuntimeCoverageReview } = require('./coverage-runtime');
const { readAuthorityHandoffAsync } = require('./isolated-authority');
const { integrateTaskResultAsync } = require('./task-integration');
const { readTaskBinding, validateTaskPath, isExcludedTaskPath, isEphemeralWorkspaceArtifact } = require('./task-workspace');
const { verifyPrivateDependenciesAsync, isEphemeralNodeModulesEntry, NODE_MODULES_EPHEMERAL_CACHE_DIRS } = require('./private-dependencies');
const { repoPathKey, repoPathsOverlap } = require('./workspace');
const { resolveSetupInvocation } = require('./setup-runner');
const { createCliResolver } = require('./setup-command');
const { spawnBoundedProcess } = require('./capability-preflight');
const { taskReadiness } = require('./task-scheduler');
const { recordTaskOutcome } = require('./task-correction');
const { createTrackedSpawn, releaseSettledTaskLease } = require('./task-processes');
const { evaluateAttestedReview, reviewAttestationEvidence } = require('./acceptance-policy');
const { listOperations } = require('./operation-lifecycle');
const { parseBehaviorResults, validateEvidenceMapping, composeQcVerdict } = require('./qc-layers');
const { buildValidatorEnv, redactArgv, redactDiagnostic } = require('./validator-security');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const MANIFEST_HASH_CHUNK_BYTES = 1024 * 1024;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function isHandoffRejected(task) {
    return Boolean(task?.handoffRejection || task?.lastOutcome?.code === 'DUAL_CONTROLLER_REVIEW_REJECTED');
}

function requireCompletedIsolatedOperation(authorityStore, derived, taskId, task) {
    const handoffEvent = authorityStore.readEvents().filter((event) => event.type === 'task.workspace.handoff'
        && event.task_id === taskId).at(-1);
    const lease = handoffEvent && derived.leases?.[handoffEvent.lease_id];
    if (!handoffEvent || !lease || lease.task_id !== taskId || lease.owner !== 'agy'
        || handoffEvent.handoff_sha256 !== task.isolatedHandoff?.handoff_sha256
        || handoffEvent.result_sha256 !== task.isolatedHandoff?.result_sha256) {
        fail('DUAL_ISOLATED_OPERATION_INVALID', 'Isolated QC requires the authoritative AGY handoff lease');
    }
    const operations = listOperations({ authorityStore, taskId, leaseId: handoffEvent.lease_id });
    if (operations.length !== 1) {
        fail('DUAL_ISOLATED_OPERATION_INVALID', 'Isolated QC requires exactly one durable AGY operation for the handoff lease');
    }
    const [operation] = operations;
    if (!operation.settled || operation.active || operation.outcome !== 'completed'
        || operation.session_id !== derived.sessionId || operation.workspace_id !== derived.workspaceId
        || operation.plan_revision !== derived.planRevision || operation.task_id !== taskId
        || operation.lease_id !== handoffEvent.lease_id) {
        fail('DUAL_ISOLATED_OPERATION_INVALID', 'Isolated QC requires a matching settled completed AGY operation');
    }
    return { handoffEvent, lease, operation };
}

function isEphemeralRunnerCache(file) {
    const normalized = String(file).replace(/\\/g, '/');
    const parts = normalized.split('/');
    let nodeModulesIndex = -1;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].toLowerCase() === 'node_modules') nodeModulesIndex = i;
    }
    if (nodeModulesIndex === -1 || nodeModulesIndex + 1 >= parts.length) return false;
    const parent = parts.slice(0, nodeModulesIndex + 1).join('/');
    return isEphemeralNodeModulesEntry(parts[nodeModulesIndex + 1], parent);
}

function isContained(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertContainedCache(root, target, relative) {
    let canonical;
    try { canonical = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target); }
    catch (error) { throw new Error(`cache realpath ${relative}: ${error.message}`); }
    if (!isContained(root, canonical)) throw new Error(`cache escapes worker root: ${relative}`);
}

function discoverEphemeralRunnerCaches(workerRoot, failures) {
    const root = fs.realpathSync.native ? fs.realpathSync.native(workerRoot) : fs.realpathSync(workerRoot);
    const caches = [];
    function walk(relative) {
        const absolute = relative ? path.join(root, relative) : root;
        let names;
        try { names = fs.readdirSync(absolute); }
        catch (error) { failures.push(`read cache ancestor ${relative || '.'}: ${error.message}`); return; }
        for (const name of names) {
            const file = relative ? `${relative}/${name}` : name;
            const target = path.join(root, file);
            let stat;
            try { stat = fs.lstatSync(target); }
            catch (error) { failures.push(`stat cache ancestor ${file}: ${error.message}`); continue; }
            if (stat.isSymbolicLink()) { failures.push(`symlink/junction rejected: ${file}`); continue; }
            if (!stat.isDirectory()) continue;
            if (isEphemeralRunnerCache(file)) {
                try {
                    assertContainedCache(root, target, file);
                    caches.push({ file, target });
                } catch (error) { failures.push(error.message); }
                continue;
            }
            walk(file);
        }
    }
    walk('');
    return caches;
}

function cleanEphemeralRunnerCaches(workerRoot, failures = []) {
    for (const { file, target } of discoverEphemeralRunnerCaches(workerRoot, failures)) {
        try { fs.rmSync(target, { recursive: true, force: false }); }
        catch (error) { failures.push(`cleanup ${file}: ${error.message}`); }
    }
    return failures;
}

async function discoverEphemeralRunnerCachesAsync(workerRoot, failures) {
    const root = fs.realpathSync.native ? await fs.promises.realpath(workerRoot) : path.resolve(workerRoot);
    const caches = [];
    async function walk(relative) {
        const absolute = relative ? path.join(root, relative) : root;
        let names;
        try { names = await fs.promises.readdir(absolute); }
        catch (error) { failures.push(`read cache ancestor ${relative || '.'}: ${error.message}`); return; }
        for (const name of names) {
            const file = relative ? `${relative}/${name}` : name;
            const target = path.join(root, file);
            let stat;
            try { stat = await fs.promises.lstat(target); }
            catch (error) { failures.push(`stat cache ancestor ${file}: ${error.message}`); continue; }
            if (stat.isSymbolicLink()) { failures.push(`symlink/junction rejected: ${file}`); continue; }
            if (!stat.isDirectory()) continue;
            if (isEphemeralRunnerCache(file)) {
                try {
                    const canonical = await fs.promises.realpath(target);
                    if (!isContained(root, canonical)) throw new Error(`cache escapes worker root: ${file}`);
                    caches.push({ file, target });
                } catch (error) { failures.push(error.message); }
                continue;
            }
            await walk(file);
        }
    }
    await walk('');
    return caches;
}

async function cleanEphemeralRunnerCachesAsync(workerRoot, failures = []) {
    for (const { file, target } of await discoverEphemeralRunnerCachesAsync(workerRoot, failures)) {
        try { await fs.promises.rm(target, { recursive: true, force: false }); }
        catch (error) { failures.push(`cleanup ${file}: ${error.message}`); }
    }
    return failures;
}

function sameFileIdentity(left, right) {
    return left.isFile() && left.dev === right.dev && left.ino === right.ino
        && left.size === right.size && left.mode === right.mode
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function hashFileSync(target, expectedStat) {
    const fd = fs.openSync(target, 'r');
    const buffer = Buffer.alloc(MANIFEST_HASH_CHUNK_BYTES);
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    try {
        const before = fs.fstatSync(fd);
        if (!sameFileIdentity(before, expectedStat)) fail('DUAL_MANIFEST_DRIFT', `File changed before read: ${target}`);
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            bytes += bytesRead;
            digest.update(buffer.subarray(0, bytesRead));
        }
        const after = fs.fstatSync(fd);
        const current = fs.lstatSync(target);
        if (bytes !== before.size || !sameFileIdentity(after, before) || !sameFileIdentity(current, before)) {
            fail('DUAL_MANIFEST_DRIFT', `File changed during read: ${target}`);
        }
        return digest.digest('hex');
    } finally { fs.closeSync(fd); }
}

async function hashFileAsync(target, expectedStat, tick, signal) {
    const fd = await fs.promises.open(target, 'r');
    const buffer = Buffer.alloc(MANIFEST_HASH_CHUNK_BYTES);
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    try {
        const before = await fd.stat();
        if (!sameFileIdentity(before, expectedStat)) fail('DUAL_MANIFEST_DRIFT', `File changed before read: ${target}`);
        while (true) {
            await tick();
            if (signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated QC was aborted');
            const readResult = await fd.read(buffer, 0, buffer.length, null);
            if (signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated QC was aborted');
            if (readResult.bytesRead === 0) break;
            bytes += readResult.bytesRead;
            digest.update(buffer.subarray(0, readResult.bytesRead));
        }
        const after = await fd.stat();
        const current = await fs.promises.lstat(target);
        if (bytes !== before.size || !sameFileIdentity(after, before) || !sameFileIdentity(current, before)) {
            fail('DUAL_MANIFEST_DRIFT', `File changed during read: ${target}`);
        }
        return digest.digest('hex');
    } finally { await fd.close(); }
}

function validateIntegrationReceipt(root, task, handoff, derived) {
    const gate = derived.gates[`isolated-qc-${task.task_id}`];
    const receipt = gate?.details?.integration_receipt;
    if (!receipt || gate.status !== 'PASSED' || gate.details.result_sha256 !== handoff.result.resultSha256
        || gate.details.handoff_sha256 !== handoff.handoffSha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified task lacks matching integration evidence');
    }
    validateTaskPath(root, receipt);
    let bytes;
    try { bytes = fs.readFileSync(path.join(root, receipt)); }
    catch { fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified integration receipt is missing'); }
    if (sha(bytes) !== gate.evidence_sha256) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified integration receipt changed');
}

async function integratedConflicts(root, handoff, history, { onTick, signal } = {}) {
    const files = [];
    const { binding } = readTaskBinding(root, handoff.reference);
    const expected = new Map(binding.contextFiles.map((file) => {
        const original = binding.sourceFiles.find((entry) => entry.path === file);
        return [file, { hash: original.sha256, mode: original.mode }];
    }));
    for (const change of handoff.result.changes) expected.set(change.path, { hash: change.afterSha256, mode: change.afterMode });
    if (history) {
        const completion = history.events.filter((event) => event.type === 'task.completed' && event.task_id === handoff.result.taskId).at(-1);
        if (!completion) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified task lacks its completion event');
        for (const event of history.events) {
            if (event.type !== 'task.completed' || event.sequence <= completion.sequence) continue;
            if (!event.modified_files.some((file) => expected.has(file))) continue;
            const laterTask = history.derived.tasks[event.task_id];
            if (laterTask?.state !== 'TASK_VERIFIED' || laterTask.execution_mode !== 'isolated') {
                fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Later overlapping work lacks verified private evidence');
            }
            const later = await readAuthorityHandoffAsync(root, laterTask, history.derived, { onTick, signal });
            validateIntegrationReceipt(root, laterTask, later, history.derived);
            if (event.diff_fingerprint !== later.result.resultSha256) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Later completion result mismatch');
            for (const change of later.result.changes) {
                if (!expected.has(change.path)) continue;
                const before = expected.get(change.path);
                if (before.hash !== change.beforeSha256 || before.mode !== change.beforeMode) {
                    fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Accepted overlapping edits do not form a continuous before/after chain');
                }
                expected.set(change.path, { hash: change.afterSha256, mode: change.afterMode });
            }
        }
    }
    for (const [file, original] of expected) {
        validateTaskPath(root, file);
        const target = path.join(root, file);
        if (!fs.existsSync(target)) { if (original.hash !== null) files.push(file); continue; }
        const stat = fs.lstatSync(target);
        if (original.hash === null || !stat.isFile() || (stat.mode & 0o777) !== original.mode
            || sha(fs.readFileSync(target)) !== original.hash) files.push(file);
    }
    return files;
}

function manifestWorker(workerRoot) {
    const root = fs.realpathSync.native ? fs.realpathSync.native(workerRoot) : fs.realpathSync(workerRoot);
    const entries = new Map();
    const failures = [];
    function walk(relative) {
        const absolute = relative ? path.join(root, relative) : root;
        let names;
        try { names = fs.readdirSync(absolute); } catch (error) { failures.push(`read ${relative || '.'}: ${error.message}`); return; }
        for (const name of names) {
            const file = relative ? `${relative}/${name}` : name;
            const target = path.join(root, file);
            let stat;
            try { stat = fs.lstatSync(target); } catch (error) { failures.push(`stat ${file}: ${error.message}`); continue; }
            if (stat.isSymbolicLink()) { failures.push(`symlink/junction rejected: ${file}`); continue; }
            if (stat.isDirectory()) {
                if (isEphemeralRunnerCache(file)) {
                    try { assertContainedCache(root, target, file); }
                    catch (error) { failures.push(error.message); }
                    continue;
                }
                walk(file); continue;
            }
            if (!stat.isFile()) { failures.push(`non-regular output rejected: ${file}`); continue; }
            let canonicalFile;
            try { canonicalFile = validateTaskPath(root, file); }
            catch (error) { failures.push(`invalid output path ${file}: ${error.message}`); continue; }
            let sha256;
            try { sha256 = hashFileSync(target, stat); }
            catch (error) { failures.push(`read ${file}: ${error.message}`); continue; }
            entries.set(canonicalFile, { path: canonicalFile, sha256, mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    walk('');
    return { entries, failures };
}

async function manifestWorkerAsync(workerRoot, options = {}) {
    const { onTick, signal, yieldEvery = 50 } = options;
    const root = fs.realpathSync.native ? await fs.promises.realpath(workerRoot) : path.resolve(workerRoot);
    const entries = new Map();
    const failures = [];
    let ops = 0;

    function checkAbort() {
        if (signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated QC was aborted');
    }

    async function tick() {
        checkAbort();
        if (++ops % yieldEvery === 0) {
            if (typeof onTick === 'function') await onTick();
            await new Promise((resolve) => setImmediate(resolve));
            checkAbort();
        }
    }

    async function walk(relative) {
        const absolute = relative ? path.join(root, relative) : root;
        let names;
        try { names = await fs.promises.readdir(absolute); } catch (error) { failures.push(`read ${relative || '.'}: ${error.message}`); return; }
        for (const name of names) {
            await tick();
            const file = relative ? `${relative}/${name}` : name;
            const target = path.join(root, file);
            let stat;
            try { stat = await fs.promises.lstat(target); } catch (error) { failures.push(`stat ${file}: ${error.message}`); continue; }
            if (stat.isSymbolicLink()) { failures.push(`symlink/junction rejected: ${file}`); continue; }
            if (stat.isDirectory()) {
                if (isEphemeralRunnerCache(file)) {
                    try {
                        const canonical = await fs.promises.realpath(target);
                        if (!isContained(root, canonical)) throw new Error(`cache escapes worker root: ${file}`);
                    } catch (error) { failures.push(error.message); }
                    continue;
                }
                await walk(file); continue;
            }
            if (!stat.isFile()) { failures.push(`non-regular output rejected: ${file}`); continue; }
            let canonicalFile;
            try { canonicalFile = validateTaskPath(root, file); }
            catch (error) { failures.push(`invalid output path ${file}: ${error.message}`); continue; }
            let sha256;
            try { sha256 = await hashFileAsync(target, stat, tick, signal); }
            catch (error) {
                if (error.code === 'DUAL_PRIVATE_SETUP_ABORTED') throw error;
                failures.push(`read ${file}: ${error.message}`); continue;
            }
            entries.set(canonicalFile, { path: canonicalFile, sha256, mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    await walk('');
    return { entries, failures };
}

function cleanDeclaredGenerated(workerRoot, generatedPaths, failures) {
    cleanEphemeralRunnerCaches(workerRoot, failures);
    const root = fs.realpathSync.native ? fs.realpathSync.native(workerRoot) : fs.realpathSync(workerRoot);
    for (const relative of generatedPaths) {
        const target = path.join(root, relative);
        const normalized = path.relative(root, target);
        if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
            failures.push(`generated output escapes worker root: ${relative}`); continue;
        }
        try {
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) { failures.push(`generated output is symlink/junction: ${relative}`); continue; }
            fs.rmSync(target, { recursive: true, force: false });
        } catch (error) { failures.push(`cleanup ${relative}: ${error.message}`); }
    }
}

async function cleanDeclaredGeneratedAsync(workerRoot, generatedPaths, failures) {
    await cleanEphemeralRunnerCachesAsync(workerRoot, failures);
    const root = fs.realpathSync.native ? await fs.promises.realpath(workerRoot) : path.resolve(workerRoot);
    for (const relative of generatedPaths) {
        const target = path.join(root, relative);
        const normalized = path.relative(root, target);
        if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
            failures.push(`generated output escapes worker root: ${relative}`); continue;
        }
        try {
            const stat = await fs.promises.lstat(target);
            if (stat.isSymbolicLink()) { failures.push(`generated output is symlink/junction: ${relative}`); continue; }
            await fs.promises.rm(target, { recursive: true, force: false });
        } catch (error) { failures.push(`cleanup ${relative}: ${error.message}`); }
    }
}

/**
 * Validators may produce only explicitly declared generated outputs. Source and
 * dependency mutations are evidence failures; they are never restored away.
 */
function cleanupEphemeralValidationArtifacts(workerRoot, binding, handoff, options = {}) {
    const before = options.beforeManifest;
    if (!before || !(before.entries instanceof Map) || !Array.isArray(before.failures)) {
        return { ok: false, before: [], after: [], after_cleanup: [], declared_generated_outputs: [], source_mutations: [], dependency_mutations: [], unexpected_outputs: [], failures: ['validator pre-manifest is required'] };
    }
    const declared = new Set([
        ...(binding.generated_outputs || binding.generatedOutputs || []),
    ]);
    const generatedPaths = [];
    const failures = [...before.failures];
    for (const raw of declared) {
        if (typeof raw !== 'string' || !raw || raw.includes('\\') || raw.includes(':') || raw.split('/').some((part) => !part || part === '..')) {
            failures.push(`invalid generated output declaration: ${String(raw)}`); continue;
        }
        try { generatedPaths.push(validateTaskPath(workerRoot, raw.replace(/\/$/, ''))); }
        catch (error) { failures.push(`invalid generated output declaration: ${raw}: ${error.message}`); }
    }
    const after = manifestWorker(workerRoot);
    failures.push(...after.failures);
    const sourcePaths = new Set();
    for (const entry of (binding.sourceFiles || [])) {
        try { sourcePaths.add(validateTaskPath(workerRoot, entry.path)); }
        catch (error) { failures.push(`invalid protected source path: ${entry.path}: ${error.message}`); }
    }
    for (const change of (handoff.result?.changes || [])) {
        if (change.kind !== 'deleted') {
            try { sourcePaths.add(validateTaskPath(workerRoot, change.path)); }
            catch (error) { failures.push(`invalid handed-off source path: ${change.path}: ${error.message}`); }
        }
    }
    const protectedPrefixes = ['node_modules', '.omni', ...(binding.runtimePath ? [binding.runtimePath] : [])];
    for (const generated of generatedPaths) {
        if ([...sourcePaths].some((source) => repoPathsOverlap(generated, source))
            || isExcludedTaskPath(generated)
            || protectedPrefixes.some((prefix) => repoPathsOverlap(generated, prefix))) {
            failures.push(`generated output overlaps protected source/dependency/runtime path: ${generated}`);
        }
    }
    const beforeFiles = before.entries;
    const afterFiles = after.entries;
    const cleanupPaths = [...generatedPaths];
    const sourceMutations = [], dependencyMutations = [], unexpectedOutputs = [];
    const isGenerated = (file) => generatedPaths.some((prefix) => repoPathsOverlap(file, prefix));
    const isDependency = (file) => repoPathsOverlap(file, 'node_modules');
    const allFiles = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
    for (const file of allFiles) {
        const oldEntry = beforeFiles.get(file), newEntry = afterFiles.get(file);
        if (oldEntry && newEntry && oldEntry.sha256 === newEntry.sha256 && oldEntry.mode === newEntry.mode) continue;
        if (isEphemeralRunnerCache(file)) continue;
        if (isDependency(file)) { dependencyMutations.push(file); continue; }
        if ([...sourcePaths].some((source) => repoPathKey(source) === repoPathKey(file))) { sourceMutations.push(file); continue; }
        if (!oldEntry && isEphemeralWorkspaceArtifact(file)) { cleanupPaths.push(file); continue; }
        if (!oldEntry && isGenerated(file)) continue;
        if (!oldEntry || !newEntry) unexpectedOutputs.push(file);
    }
    if (failures.length === 0 && sourceMutations.length === 0 && dependencyMutations.length === 0 && unexpectedOutputs.length === 0) {
        cleanDeclaredGenerated(workerRoot, cleanupPaths, failures);
    }
    const afterCleanup = manifestWorker(workerRoot);
    failures.push(...afterCleanup.failures);
    return {
        ok: failures.length === 0 && sourceMutations.length === 0 && dependencyMutations.length === 0 && unexpectedOutputs.length === 0,
        before: [...beforeFiles.values()], after: [...afterFiles.values()], after_cleanup: [...afterCleanup.entries.values()],
        declared_generated_outputs: generatedPaths, source_mutations: sourceMutations,
        dependency_mutations: dependencyMutations, unexpected_outputs: unexpectedOutputs, failures,
    };
}

async function cleanupEphemeralValidationArtifactsAsync(workerRoot, binding, handoff, options = {}) {
    const before = options.beforeManifest;
    if (!before || !(before.entries instanceof Map) || !Array.isArray(before.failures)) {
        return { ok: false, before: [], after: [], after_cleanup: [], declared_generated_outputs: [], source_mutations: [], dependency_mutations: [], unexpected_outputs: [], failures: ['validator pre-manifest is required'] };
    }
    const declared = new Set([
        ...(binding.generated_outputs || binding.generatedOutputs || []),
    ]);
    const generatedPaths = [];
    const failures = [...before.failures];
    for (const raw of declared) {
        if (typeof raw !== 'string' || !raw || raw.includes('\\') || raw.includes(':') || raw.split('/').some((part) => !part || part === '..')) {
            failures.push(`invalid generated output declaration: ${String(raw)}`); continue;
        }
        try { generatedPaths.push(validateTaskPath(workerRoot, raw.replace(/\/$/, ''))); }
        catch (error) { failures.push(`invalid generated output declaration: ${raw}: ${error.message}`); }
    }
    const after = await manifestWorkerAsync(workerRoot, {
        onTick: options.onTick,
        signal: options.signal,
        yieldEvery: options.yieldEvery,
        priorManifest: before,
    });
    failures.push(...after.failures);
    const sourcePaths = new Set();
    for (const entry of (binding.sourceFiles || [])) {
        try { sourcePaths.add(validateTaskPath(workerRoot, entry.path)); }
        catch (error) { failures.push(`invalid protected source path: ${entry.path}: ${error.message}`); }
    }
    for (const change of (handoff.result?.changes || [])) {
        if (change.kind !== 'deleted') {
            try { sourcePaths.add(validateTaskPath(workerRoot, change.path)); }
            catch (error) { failures.push(`invalid handed-off source path: ${change.path}: ${error.message}`); }
        }
    }
    const protectedPrefixes = ['node_modules', '.omni', ...(binding.runtimePath ? [binding.runtimePath] : [])];
    for (const generated of generatedPaths) {
        if ([...sourcePaths].some((source) => repoPathsOverlap(generated, source))
            || isExcludedTaskPath(generated)
            || protectedPrefixes.some((prefix) => repoPathsOverlap(generated, prefix))) {
            failures.push(`generated output overlaps protected source/dependency/runtime path: ${generated}`);
        }
    }
    const beforeFiles = before.entries;
    const afterFiles = after.entries;
    const cleanupPaths = [...generatedPaths];
    const sourceMutations = [], dependencyMutations = [], unexpectedOutputs = [];
    const isGenerated = (file) => generatedPaths.some((prefix) => repoPathsOverlap(file, prefix));
    const isDependency = (file) => repoPathsOverlap(file, 'node_modules');
    const allFiles = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
    for (const file of allFiles) {
        const oldEntry = beforeFiles.get(file), newEntry = afterFiles.get(file);
        if (oldEntry && newEntry && oldEntry.sha256 === newEntry.sha256 && oldEntry.mode === newEntry.mode) continue;
        if (isEphemeralRunnerCache(file)) continue;
        if (isDependency(file)) { dependencyMutations.push(file); continue; }
        if ([...sourcePaths].some((source) => repoPathKey(source) === repoPathKey(file))) { sourceMutations.push(file); continue; }
        if (!oldEntry && isEphemeralWorkspaceArtifact(file)) { cleanupPaths.push(file); continue; }
        if (!oldEntry && isGenerated(file)) continue;
        if (!oldEntry || !newEntry) unexpectedOutputs.push(file);
    }
    if (failures.length === 0 && sourceMutations.length === 0 && dependencyMutations.length === 0 && unexpectedOutputs.length === 0) {
        await cleanDeclaredGeneratedAsync(workerRoot, cleanupPaths, failures);
    }
    const afterCleanup = await manifestWorkerAsync(workerRoot, {
        onTick: options.onTick,
        signal: options.signal,
        yieldEvery: options.yieldEvery,
        priorManifest: after,
    });
    failures.push(...afterCleanup.failures);
    return {
        ok: failures.length === 0 && sourceMutations.length === 0 && dependencyMutations.length === 0 && unexpectedOutputs.length === 0,
        before: [...beforeFiles.values()], after: [...afterFiles.values()], after_cleanup: [...afterCleanup.entries.values()],
        declared_generated_outputs: generatedPaths, source_mutations: sourceMutations,
        dependency_mutations: dependencyMutations, unexpected_outputs: unexpectedOutputs, failures,
    };
}

async function completeIsolatedTask({ workspaceRoot, authorityStore, sessionId, taskId, planRevision, signal, revisionChecks }) {
    const root = fs.realpathSync.native(workspaceRoot);
    const initial = authorityStore.derive();
    assertRuntimeCoverage(root, { derived: initial });
    if (initial.sessionId !== sessionId || initial.planRevision !== planRevision
        || fs.realpathSync.native(initial.workspaceRoot) !== root) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'QC request does not match current authority');
    }
    const task = initial.tasks[taskId];
    if (!task || task.execution_mode !== 'isolated' || !task.isolatedHandoff) {
        fail('DUAL_ISOLATED_QC_NOT_READY', 'An isolated handoff is required before Codex QC');
    }
    if (isHandoffRejected(task)) {
        fail('DUAL_CONTROLLER_REVIEW_REJECTED', 'Controller rejected this handoff; request a bounded correction before QC');
    }
    // QC must be anchored to the AGY lease that authored the handoff. This
    // check intentionally runs before reading worker manifests or acquiring a
    // Codex lease, so missing/active/failed lineage cannot mutate the source or
    // append a misleading completion.
    requireCompletedIsolatedOperation(authorityStore, initial, taskId, task);
    const heartbeat = () => {
        if (signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated QC was aborted');
    };
    const handoff = await readAuthorityHandoffAsync(root, task, initial, { onTick: heartbeat, signal });
    // The handoff read yields. Rejection/correction may have won while it was
    // pending, so reserve the QC lease from fresh authority in one synchronous
    // turn. The existing lease then fences rejection throughout integration.
    const current = authorityStore.derive();
    assertRuntimeCoverageReview(root, path.join(handoff.reference.workerRoot, '.omni/codex-gemini/runs', taskId), taskId, { derived: current });
    if (isHandoffRejected(current.tasks[taskId])) {
        fail('DUAL_CONTROLLER_REVIEW_REJECTED', 'Controller rejected this handoff; request a bounded correction before QC');
    }
    if (current.sessionId !== sessionId || current.planRevision !== planRevision
        || fs.realpathSync.native(current.workspaceRoot) !== root
        || JSON.stringify(current.currentBaseline) !== JSON.stringify(initial.currentBaseline)
        || JSON.stringify({ ...current.tasks[taskId], executions: undefined }) !== JSON.stringify({ ...task, executions: undefined })) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'QC authority changed while reading the handoff');
    }
    if (task.state === 'TASK_VERIFIED') {
        validateIntegrationReceipt(root, task, handoff, current);
        const files = await integratedConflicts(root, handoff, { derived: current, events: authorityStore.readEvents() }, { onTick: heartbeat, signal });
        const qcLayers = current.gates[`isolated-qc-${taskId}`]?.details?.qcLayers;
        return files.length ? { status: 'CONFLICT', files } : { status: 'TASK_VERIFIED', taskId, alreadyVerified: true,
            ...(qcLayers ? { qcLayers } : {}) };
    }
    if (current.sessionState !== 'EXECUTING') fail('DUAL_ISOLATED_QC_NOT_READY', 'Session is not executing');
    const readiness = taskReadiness(current, taskId);
    if (readiness.status !== 'READY') return { taskId, ...readiness };
    // Until per-file reservations land, exclude any other active source writer.
    if (Object.values(current.leases).some((lease) => lease.status === 'active')) return { status: 'WAITING_FOR_LEASE' };
    const lease = authorityStore.acquireLease(taskId, 'codex', { ttlMs: 120000 });
    authorityStore.append({ schema_version: 2, type: 'task.execution.started', task_id: taskId,
        lease_id: lease.lease_id, controller_pid: process.pid });
    const trackedSpawn = createTrackedSpawn({ authorityStore, taskId, leaseId: lease.lease_id });
    let renewalError;
    const timer = setInterval(() => {
        try { authorityStore.renewLease(lease.lease_id, { ttlMs: 120000 }); } catch (error) { renewalError = error; }
    }, 10000);
    timer.unref();
    const guard = () => {
        const now = authorityStore.derive();
        assertRuntimeCoverage(root, { derived: now });
        return !renewalError && now.sessionId === sessionId && now.planRevision === planRevision
            && now.sessionState === 'EXECUTING' && now.leases[lease.lease_id]?.status === 'active'
            && !isHandoffRejected(now.tasks[taskId])
            && JSON.stringify(now.currentBaseline) === JSON.stringify(initial.currentBaseline)
            && JSON.stringify({ ...now.tasks[taskId], executions: undefined }) === JSON.stringify({ ...task, executions: undefined })
            && taskReadiness(now, taskId).status === 'READY'
            && !Object.values(now.leases).some((other) => other.lease_id !== lease.lease_id && other.status === 'active');
    };
    const commands = [];
    const layered = task.behavior_commands !== undefined || task.qc_evidence !== undefined;
    const checker = { passed: false, failures: [] };
    const behavior = { passed: task.behavior_commands === undefined, skipped: task.behavior_commands === undefined, tests: [], failures: [] };
    const evidence = { passed: task.qc_evidence === undefined, skipped: task.qc_evidence === undefined, failures: [] };
    let findings = [];
    const qcDetails = () => layered ? { qcLayers: composeQcVerdict({ checker, behavior, evidence, findings }) } : {};
    try {
        const workerRoot = handoff.reference.workerRoot;
        if (handoff.reference.workerDependencies) {
            await verifyPrivateDependenciesAsync({
                workerRoot,
                artifactRoot: path.dirname(path.join(root, handoff.reference.bindingPath)),
                reference: handoff.reference.workerDependencies,
                onTick: () => { if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked'); },
                signal,
            });
        }
        const validationBeforeManifest = await manifestWorkerAsync(workerRoot, {
            onTick: () => { if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked'); },
            signal,
        });
        if (validationBeforeManifest.failures.length) {
            fail('DUAL_QC_WORKSPACE_MANIFEST_FAILED', `Cannot capture validator baseline: ${validationBeforeManifest.failures.join('; ')}`);
        }
        const env = buildValidatorEnv(process.env, {
            GIT_CEILING_DIRECTORIES: path.dirname(workerRoot).replace(/\\/g, '/'),
        });
        if (!Array.isArray(task.validation_commands) || (!task.validation_commands.length && !initial.revisionContext)) {
            fail('DUAL_ISOLATED_QC_NOT_READY', 'Registered validation commands are required');
        }
        const validationCommands = initial.revisionContext
            ? require('./task-revision').uniqueCommands([...task.validation_commands,
                ...((initial.plan?.acceptance_policy || initial.plan?.acceptancePolicy)?.checks || [])
                    .filter((check) => check.kind === 'command').map((check) => check.command)])
            : task.validation_commands;
        const registeredCommands = [
            ...validationCommands.map((command) => ({ command, layer: 'checker' })),
            ...(task.behavior_commands || []).map((command) => ({ command, layer: 'behavior' })),
        ];
        for (const { command, layer } of registeredCommands) {
            if (layer === 'behavior') checker.passed = true;
            if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked');
            await readAuthorityHandoffAsync(root, task, authorityStore.derive(), { onTick: heartbeat, signal });
            const kind = ['npm', 'pnpm', 'yarn', 'bun'].includes(command.program) ? 'package-manager' : 'native';
            const invocation = resolveSetupInvocation({ kind, ...command }, {
                workspaceRoot: workerRoot, env, resolveExecutable: createCliResolver(workerRoot, { env }),
            });
            const started = Date.now();
            const output = await spawnBoundedProcess(invocation.command, invocation.args, {
                cwd: invocation.cwd, env, timeoutMs: 60000, maxOutputBytes: 64 * 1024, spawnImpl: trackedSpawn,
            });
            commands.push({ command: redactDiagnostic(
                `${command.program} ${redactArgv(command.args).join(' ')}`.trim(),
                { maxLength: 4096 }
            ),
                exit_code: output.code ?? 1, duration_ms: Math.max(1, Date.now() - started),
                output_sha256: sha(`${output.stdout || ''}\0${output.stderr || ''}`) });
            if (layer === 'behavior') {
                const parsed = parseBehaviorResults(output.stdout);
                const names = new Set(behavior.tests.map((test) => test.name));
                behavior.failures.push(...parsed.failures);
                for (const test of parsed.tests) {
                    if (names.has(test.name)) behavior.failures.push(`Duplicate behavior test across commands: ${test.name}`);
                    names.add(test.name);
                    behavior.tests.push(test);
                }
                behavior.passed = behavior.failures.length === 0;
            }
            if (!output.ok || output.code !== 0 || (layer === 'behavior' && !behavior.passed)) {
                const failedLayer = layer === 'behavior' ? behavior : checker;
                failedLayer.passed = false;
                failedLayer.failures.push(`Registered command failed: ${commands.at(-1).command}; exit ${output.code ?? 'unavailable'}`);
                const code = layer === 'behavior' ? 'DUAL_QC_BEHAVIOR_FAILED' : 'DUAL_QC_VALIDATION_FAILED';
                recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                    code, summary: redactDiagnostic(
                        `Registered command failed: ${commands.at(-1).command}; exit ${output.code ?? 'unavailable'}`,
                        { maxLength: 2048 }
                    ) });
                return { status: 'NEEDS_FIX', taskId, commands, ...qcDetails(), ...(layered ? { code } : {}) };
            }
        }
        checker.passed = true;
        if (task.behavior_commands !== undefined && !task.behavior_commands.length) {
            behavior.passed = false;
            behavior.failures.push('Behavior commands must produce at least one results block');
            recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                code: 'DUAL_QC_BEHAVIOR_FAILED', summary: behavior.failures[0] });
            return { status: 'NEEDS_FIX', taskId, commands, code: 'DUAL_QC_BEHAVIOR_FAILED', ...qcDetails() };
        }
        if (task.qc_evidence !== undefined) {
            try {
                const readJson = async (relative) => {
                    validateTaskPath(workerRoot, relative);
                    const target = await fs.promises.realpath(path.resolve(workerRoot, relative));
                    if (!isContained(await fs.promises.realpath(workerRoot), target)) throw new Error(`QC evidence escapes worker root: ${relative}`);
                    return JSON.parse(await fs.promises.readFile(target, 'utf8'));
                };
                const requirements = await readJson(task.qc_evidence.requirements_path);
                const mapping = await readJson(task.qc_evidence.evidence_path);
                Object.assign(evidence, validateEvidenceMapping(requirements, mapping, behavior));
            } catch (error) {
                evidence.passed = false;
                evidence.failures.push(redactDiagnostic(error.message, { maxLength: 2048 }));
            }
            if (!evidence.passed) {
                recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                    code: 'DUAL_QC_EVIDENCE_FAILED', summary: redactDiagnostic(evidence.failures.join('; '), { maxLength: 2048 }) });
                return { status: 'NEEDS_FIX', taskId, commands, code: 'DUAL_QC_EVIDENCE_FAILED', ...qcDetails() };
            }
        }
        if (layered) {
            const review = JSON.parse(await fs.promises.readFile(path.join(workerRoot, handoff.artifactPath, 'review.json'), 'utf8'));
            findings = review.findings || [];
            if (!composeQcVerdict({ checker, behavior, evidence, findings }).passed) {
                recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                    code: 'DUAL_QC_EVIDENCE_FAILED', summary: 'QC review contains ERROR findings' });
                return { status: 'NEEDS_FIX', taskId, commands, code: 'DUAL_QC_EVIDENCE_FAILED', ...qcDetails() };
            }
        }
        const { binding } = readTaskBinding(root, task.isolatedWorkspace.reference);
        const cleanup = await cleanupEphemeralValidationArtifactsAsync(workerRoot, binding, handoff, {
            beforeManifest: validationBeforeManifest,
            onTick: () => { if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked'); },
            signal,
        });
        if (!cleanup.ok) {
            const detail = JSON.stringify({ source_mutations: cleanup.source_mutations, dependency_mutations: cleanup.dependency_mutations,
                unexpected_outputs: cleanup.unexpected_outputs, failures: cleanup.failures }).slice(0, 1800);
            recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                code: 'DUAL_QC_WORKSPACE_MUTATION', summary: `Validator workspace mutation rejected: ${detail}` });
            return { status: 'NEEDS_FIX', taskId, commands, ...qcDetails(), cleanup };
        }
        if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked');
        await readAuthorityHandoffAsync(root, task, authorityStore.derive(), { onTick: heartbeat, signal });

        const currentDerived = authorityStore.derive();
        const acceptancePolicy = currentDerived.plan?.acceptance_policy || currentDerived.plan?.acceptancePolicy;
        if (acceptancePolicy && Array.isArray(acceptancePolicy.checks)) {
            const preIntegrationChecks = acceptancePolicy.checks.filter(
                (check) => check.phase === 'pre_integration' && check.kind === 'review' && check.task_id === taskId
            );
            if (preIntegrationChecks.length > 0) {
                const attestation = Object.values(currentDerived.reviewAttestations || {}).reverse().find((candidate) =>
                    candidate.review_phase === 'pre_integration'
                    && candidate.task_id === taskId
                    && candidate.plan_revision === planRevision
                    && candidate.policy_sha256 === (currentDerived.plan?.acceptance_policy_sha256
                        || currentDerived.plan?.acceptancePolicySha256)
                    && candidate.result_sha256 === task.isolatedHandoff.result_sha256
                    && candidate.diff_fingerprint === task.isolatedHandoff.result_sha256);
                if (!attestation) {
                    return { status: 'NEEDS_REVIEW', taskId, commands, ...qcDetails(), missing: preIntegrationChecks.map((c) => c.id) };
                }
                const candidateEvidence = reviewAttestationEvidence(attestation);

                let evalResult;
                try {
                    evalResult = evaluateAttestedReview(acceptancePolicy, candidateEvidence, {
                        reviewPhase: 'pre_integration',
                        taskId,
                        resultSha256: task.isolatedHandoff.result_sha256,
                    });
                } catch (err) {
                    recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                        code: err.code || 'DUAL_ACCEPTANCE_EVIDENCE_INVALID', summary: `Pre-integration acceptance review rejected: ${err.message}` });
                    return { status: 'NEEDS_FIX', taskId, commands, ...qcDetails(), error: err.message };
                }

                if (evalResult.status === 'NEEDS_FIX') {
                    recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                        code: 'DUAL_ACCEPTANCE_PREINTEGRATION_FAILED',
                        summary: `Pre-integration acceptance check failed: ${evalResult.failed.map((f) => `${f.check_id} (${f.status})`).join(', ')}` });
                    return { status: 'NEEDS_FIX', taskId, commands, ...qcDetails(), failed: evalResult.failed };
                }

                if (evalResult.status === 'NEEDS_REVIEW') {
                    return { status: 'NEEDS_REVIEW', taskId, commands, ...qcDetails(), missing: evalResult.missing };
                }

                const checksById = new Map(preIntegrationChecks.map((check) => [check.id, check]));
                for (const checkResult of candidateEvidence.check_results) {
                    const registeredCheck = checksById.get(checkResult.check_id);
                    if (!registeredCheck) continue;
                    const gateStatus = checkResult.status === 'PASS' ? 'PASSED'
                        : checkResult.status === 'FAIL' ? 'FAILED'
                            : checkResult.status;
                    authorityStore.append({
                        schema_version: 2,
                        type: 'gate.result',
                        gate_id: `acceptance-${checkResult.check_id}`,
                        task_id: taskId,
                        status: gateStatus,
                        evidence_sha256: candidateEvidence.evidence_sha256,
                        reason: checkResult.findings.length
                            ? checkResult.findings.join('; ').slice(0, 256)
                            : `Independent pre-integration acceptance check ${checkResult.status.toLowerCase()}`,
                        details: {
                            required: registeredCheck.required,
                            check_id: checkResult.check_id,
                            policy_sha256: candidateEvidence.policy_sha256,
                            result_sha256: candidateEvidence.result_sha256,
                            review_execution_id: attestation.review_execution_id,
                            review_attestation_sha256: attestation.attestation_sha256,
                        },
                    });
                }
            }
        }

        if (initial.revisionContext) {
            let checked;
            try {
                if (typeof revisionChecks !== 'function') fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Full revision certification is required');
                checked = await revisionChecks();
                if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority changed during full contract certification');
            } catch (error) {
                if (error.code === 'DUAL_REVISION_REVIEW_REQUIRED') return { status: 'NEEDS_REVIEW', taskId, commands, ...qcDetails() };
                recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                    code: 'DUAL_QC_VALIDATION_FAILED', summary: 'Full revision certification failed; inspect candidate evidence before bounded correction' });
                throw error;
            }
            authorityStore.append({ schema_version: 2, type: 'gate.result', gate_id: `isolated-qc-${taskId}`,
                task_id: taskId, status: 'PASSED', evidence_sha256: handoff.handoffSha256,
                reason: 'Candidate commands and independent review validated without changing the verified source',
                details: { required: true, handoff_sha256: handoff.handoffSha256,
                    result_sha256: handoff.result.resultSha256, commands: checked.commands,
                    review_evidence: checked.review_evidence, evidence_reference: checked.authorityEvidence.reference } });
            return { status: 'QC_VALIDATED', taskId, ...qcDetails(), commands: checked.commands, checked, candidate_sha256: handoff.result.resultSha256 };
        }

        const integration = await integrateTaskResultAsync({ workspaceRoot: root, reference: handoff.reference,
            result: handoff.result, expectedResultSha256: task.isolatedHandoff.result_sha256, authorize: guard,
            onTick: () => { if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked'); }, signal });
        if (!['INTEGRATED', 'ALREADY_INTEGRATED'].includes(integration.status)) {
            if (integration.status === 'CONFLICT') recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id,
                status: 'CONFLICT', code: 'DUAL_SOURCE_CONFLICT', summary: `Source conflict: ${integration.files.join(', ')}` });
            return { ...integration, taskId, commands, ...qcDetails() };
        }
        const integrationSha = sha(fs.readFileSync(path.join(root, integration.receiptPath)));
        for (const [name, digest] of [
            ['delegation', handoff.handoffSha256],
            ['scope', handoff.result.resultSha256],
            ['review', handoff.artifactHashes['review.json']],
        ]) {
            authorityStore.append({ schema_version: 2, type: 'gate.result', gate_id: `${name}-${taskId}`,
                task_id: taskId, status: 'PASSED', evidence_sha256: digest,
                reason: `Isolated ${name} evidence validated against anchored handoff and integrated result`,
                details: { required: true, handoff_sha256: handoff.handoffSha256,
                    result_sha256: handoff.result.resultSha256, integration_receipt: integration.receiptPath } });
        }
        authorityStore.append({ schema_version: 2, type: 'gate.result', gate_id: `isolated-qc-${taskId}`,
            task_id: taskId, status: 'PASSED', evidence_sha256: integrationSha,
            reason: 'Independent registered validation passed and controller integrated the anchored private result',
            details: { required: true, handoff_sha256: task.isolatedHandoff.handoff_sha256,
                result_sha256: task.isolatedHandoff.result_sha256, integration_receipt: integration.receiptPath, commands, ...qcDetails() } });
        const conflicts = await integratedConflicts(root, handoff);
        if (conflicts.length) return { status: 'CONFLICT', taskId, files: conflicts, commands, ...qcDetails() };
        if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority changed before task completion');
        authorityStore.append({ schema_version: 2, type: 'task.completed', task_id: taskId, owner: 'agy',
            authority_state: 'TASK_VERIFIED', modified_files: handoff.result.changes.map((change) => change.path),
            diff_fingerprint: handoff.result.resultSha256, verdict: 'SUCCESS', verified_by: 'codex' });
        return { status: 'TASK_VERIFIED', taskId, commands, ...qcDetails(), integrationReceipt: integration.receiptPath };
    } finally {
        clearInterval(timer);
        releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id, reason: 'isolated_codex_qc_finished' });
    }
}

module.exports = {
    completeIsolatedTask,
    cleanupEphemeralValidationArtifacts,
    cleanupEphemeralValidationArtifactsAsync,
    cleanEphemeralRunnerCaches,
    cleanEphemeralRunnerCachesAsync,
    isEphemeralRunnerCache,
    manifestWorker,
    manifestWorkerAsync,
};
