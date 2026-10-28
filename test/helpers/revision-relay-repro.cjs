'use strict';
// Read-only trial-16 replay; all evidence mutations happen in a temporary copy.
// node test/helpers/revision-relay-repro.cjs <evidence-dir> <demo-root> [--fixed]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createAuthorityStore } = require('../../lib/dual/authority-store');
const { assertOperationAuthorized } = require('../../lib/dual/operation-lifecycle');
const { taskReadiness } = require('../../lib/dual/task-scheduler');
const { createDaemonHostDeps } = require('../../lib/dual/discussion/daemon-ports');
const { createDiscussionRelay } = require('../../lib/dual/discussion/relay');
const { createDiscussionAdapter } = require('../../lib/dual/discussion/adapter');

async function main() {
    const [evidence, demo, mode] = process.argv.slice(2);
    const fixed = mode === '--fixed';
    assert.ok(evidence && demo, 'Provide evidence directory and read-only demo root');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-relay-repro-'));
    let relay;
    try {
        const authorityDir = path.join(root, 'authority');
        fs.cpSync(path.join(demo, '.omni/runs/dual-authority'), authorityDir, { recursive: true });
        const lines = fs.readFileSync(path.join(evidence, 'authority-events.ndjson'), 'utf8').trim().split('\n');
        const events = lines.slice(0, 94).map(JSON.parse);
        assert.equal(events.at(-1).event.sequence, 94);
        const report = JSON.parse(fs.readFileSync(path.join(evidence, 'report-trial-16.json')));
        assert.equal(report.failedStage, 'candidateScout');
        assert.equal(report.errorCode, 'AUTHORITY_STALE');
        const operationContent = fs.readFileSync(path.join(evidence, 'authority-operations.ndjson'), 'utf8')
            .trim().split('\n').slice(0, 3).join('\n') + '\n';
        fs.writeFileSync(path.join(authorityDir, 'events.ndjson'), lines.slice(0, 94).join('\n') + '\n');
        fs.writeFileSync(path.join(authorityDir, 'operations.ndjson'), operationContent);
        const time = Date.parse(events.at(-1).event.timestamp);
        const store = createAuthorityStore(authorityDir, { clock: () => new Date(time) });
        const prepared = events.findLast(({ event }) => event.type === 'task.workspace.prepared').event;
        const taskId = prepared.task_id;
        const revisionId = prepared.revision_id;
        const operationId = events.findLast(({ event }) => event.type === 'task.operation.ledger.committed').event.operation_id;
        const scoped = store.forRevision(taskId, revisionId);
        const initial = scoped.derive();
        const contract = task => JSON.stringify(['goal', 'owner', 'model', 'effort', 'risk', 'execution_mode', 'allowed_files',
            'generated_outputs', 'context_files', 'deny_patterns', 'validation_commands', 'depends_on', 'correction', 'dependency_mode'].map(k => task[k]));
        let authorizeCalls = 0;
        const authorize = () => {
            authorizeCalls++;
            const now = scoped.derive();
            const ok = now.sessionId === initial.sessionId && now.planRevision === initial.planRevision
                && now.sessionState === 'EXECUTING' && now.tasks[taskId]?.owner === 'agy'
                && JSON.stringify(now.currentBaseline) === JSON.stringify(initial.currentBaseline)
                && contract(now.tasks[taskId]) === contract(initial.tasks[taskId])
                && taskReadiness(now, taskId).status === 'READY'
                && now.leases[prepared.lease_id]?.status === 'active';
            if (!ok) return false;
            try { assertOperationAuthorized({ authorityStore: scoped, taskId, leaseId: prepared.lease_id, operationId }); return true; }
            catch { return false; }
        };
        assert.equal(authorize(), true);
        const directory = path.join(demo, '.omni/runs/dual-discussion/isolated');
        const manifestName = fs.readdirSync(directory).find(name => name.endsWith('.manifest.json')
            && JSON.parse(fs.readFileSync(path.join(directory, name))).operation_id === operationId);
        assert.ok(manifestName, 'Candidate manifest matches trial operation');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, manifestName)));
        const { discussion_snapshot_sha256, conversation_ids, ...identity } = manifest;
        const text = JSON.stringify(identity);
        assert.equal(crypto.createHash('sha256').update(text).digest('hex'), discussion_snapshot_sha256);
        const journal = fs.readFileSync(path.join(directory, manifestName.replace('.manifest.json', ''), 'journal.jsonl'), 'utf8')
            .trim().split('\n').map(line => JSON.parse(line).event);
        assert.deepEqual(journal.map(e => e.type), ['registered', 'received']);
        const bindings = journal[0].bindings.map(({ binding_ref, ...binding }) => binding);
        const envelope = journal[1].envelope;
        const operations = operationContent.trim().split('\n').map(JSON.parse);
        const state = { leaseEvents: events, sessionId: initial.sessionId, expectedPlanRevision: initial.planRevision,
            expectedSnapshotSha256: discussion_snapshot_sha256,
            operationLedger: { records: operations.map(e => e.record), record_hashes: operations.map(e => e.record_hash),
                content_sha256: crypto.createHash('sha256').update(operationContent).digest('hex') } };
        const deps = createDaemonHostDeps({ authority: () => state, authorize, leaseId: prepared.lease_id, now: () => time,
            ...(fixed ? { replayAuthority: (records, time) => store.replayDiscussionAuthority(records, time) } : {}),
            preflight: { codexProbe: async () => true, run: async (_root, { workerModel }) => ({
                status: 'PASSED', to_state: 'CAPABILITY_SAFE',
                checks: ['authority_ledger_integrity', 'baseline_backend', 'project_configuration', 'agy_cli_and_model', 'mcp_and_hook_setup']
                    .map(name => ({ name, status: 'PASSED' })),
                details: { agy_version: '1.2.3', agy_model: workerModel,
                    agy_evidence: { version: '1.2.3', model: workerModel } },
            }) } });
        const adapters = Object.fromEntries(['codex', 'agy'].map(provider => [provider, createDiscussionAdapter({
            id: 'repro-' + provider, provider, version: '1', mode: 'fake',
            profile: { format: 'json', requireConversationMatch: true, allowlistedTerminalMarkers: ['fixture.completed'] },
            invoke: async ({ binding, invocationId }) => {
                assert.equal(fixed, true, 'Authority-denied dispatch must not invoke provider');
                return { exitCode: 0, stdout: JSON.stringify({ conversationId: binding.conversation_id, invocationId }), stderr: '' };
            }, classify: raw => ({ completion: 'succeeded', payload: { schema_version: 1, kind: 'reply', body: 'Repro answer' },
                observedConversationId: JSON.parse(raw.stdout).conversationId, observedInvocationId: JSON.parse(raw.stdout).invocationId,
                terminalMarker: 'fixture.completed', evidenceRef: 'fixture', hasTerminalError: false }) })]));
        relay = await createDiscussionRelay({ enabled: true, stateDir: path.join(root, 'relay'), bindings,
            snapshot: { text, sha256: discussion_snapshot_sha256 }, clock: () => time,
            authority: { check: deps.checkAuthority }, capabilityVerifier: { verify: deps.verifyCapability,
                verifyRecovery: () => false }, adapters });
        await relay.receive(envelope);
        if (fixed) assert.equal((await relay.dispatch(envelope.message_id)).provider, 'succeeded');
        else await assert.rejects(relay.dispatch(envelope.message_id), { code: 'AUTHORITY_STALE' });
        assert.equal(authorize(), true);
        console.log(JSON.stringify({ result: fixed ? 'fixed' : 'reproduced', phase: 'scout', dispatch: 'first_question_after_two_seeds',
            message_id: envelope.message_id, authority_prefix: 94, authorize: true, authorizeCalls,
            provider_invocations: (await relay.inspect()).invocation_count }));
    } finally {
        await relay?.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
