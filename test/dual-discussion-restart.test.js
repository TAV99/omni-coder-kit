'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openJournal, inspectJournal } = require('../lib/dual/discussion/journal');
const { createDiscussionSession } = require('../lib/dual/discussion/session');
const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');
const { runDiscussionPhase } = require('../lib/dual/discussion/phase-bridge');
const { bindingRef, sha256Utf8 } = require('../lib/dual/discussion/contracts');

const STALE_MS = 5 * 60_000 + 1000;
const token = 'a'.repeat(32);
// Verify real ESRCH without spawning provider/process fixtures (sandbox friendly).
function deadPid() {
    const pid = 2147483647;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    return pid;
}
async function directory(t) {
    const result = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-discussion-restart-'));
    t.after(() => fs.rm(result, { recursive: true, force: true }));
    return result;
}
async function owner(stateDir, { pid = deadPid(), age = STALE_MS, ownerToken = token } = {}) {
    const lock = path.join(stateDir, 'owner.lock');
    const metadata = { schema_version: 1, owner_token: ownerToken, pid, started_at: 1 };
    await fs.writeFile(lock, JSON.stringify(metadata) + '\n');
    const date = new Date(Date.now() - age);
    await fs.utimes(lock, date, date);
    return metadata;
}
async function journalFixture(t, lockOptions) {
    const stateDir = await directory(t);
    const writer = await openJournal({ stateDir });
    await writer.append({ type: 'registered', bindings: [], snapshot_sha256: 'b'.repeat(64) });
    await writer.close();
    const metadata = await owner(stateDir, lockOptions);
    return { stateDir, metadata, original: await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8') };
}
async function archives(stateDir) {
    return (await fs.readdir(stateDir)).filter(name => name.startsWith('owner.lock.reclaimed.'));
}

for (const [name, lockOptions, recovery] of [
    ['live pid stays busy even with an old lock', { pid: process.pid }, true],
    ['recent dead owner stays busy', { age: 1000 }, true],
    ['default open never reclaims a stale dead owner', {}, false],
]) {
    test(name, async t => {
        const { stateDir, metadata, original } = await journalFixture(t, lockOptions);
        await assert.rejects(openJournal({ stateDir, reclaimStaleOwner: recovery }), { code: 'OWNER_BUSY' });
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'owner.lock'), 'utf8')), metadata);
        assert.deepEqual(await archives(stateDir), []);
        assert.equal(await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8'), original);
    });
}

test('explicit reclaim archives stale owner metadata and acquires a fresh wx token without rewriting history', async t => {
    const { stateDir, metadata, original } = await journalFixture(t);
    const writer = await openJournal({ stateDir, reclaimStaleOwner: true });
    const names = await archives(stateDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^owner\.lock\.reclaimed\.[0-9]+\.aaaaaaaa$/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, names[0]), 'utf8')), metadata);
    assert.notEqual(writer.ownerToken, metadata.owner_token);
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, 'owner.lock'), 'utf8')).owner_token, writer.ownerToken);
    assert.equal(await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8'), original);
    await writer.append({ type: 'received', envelope: { message_id: 'audit-chain-test' } });
    const view = await inspectJournal({ stateDir });
    assert.equal(view.events.length, 2);
    assert.equal(view.events[1].prev_hash, view.events[0].record_hash);
    await writer.close();
    assert.equal((await archives(stateDir)).length, 1);
});

for (const corruption of ['torn', 'hash']) {
    test(`invalid ${corruption} journal is never reclaimed`, async t => {
        const { stateDir, metadata, original } = await journalFixture(t);
        const invalid = corruption === 'torn' ? original.slice(0, -1) : original.replace('registered', 'received');
        await fs.writeFile(path.join(stateDir, 'journal.jsonl'), invalid);
        await assert.rejects(openJournal({ stateDir, reclaimStaleOwner: true }), { code: 'JOURNAL_INVALID' });
        assert.deepEqual(await archives(stateDir), []);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'owner.lock'), 'utf8')), metadata);
        assert.equal(await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8'), invalid);
    });
}

test('release with a mismatched token stays busy and keeps the current lock', async t => {
    const stateDir = await directory(t);
    const writer = await openJournal({ stateDir });
    await assert.rejects(writer.close({ releaseToken: 'wrong-token' }), { code: 'OWNER_BUSY' });
    assert.equal((await inspectJournal({ stateDir })).owner.owner_token, writer.ownerToken);
    await writer.close();
});

test('concurrent reclaimers yield one writer and one busy loser', async t => {
    const { stateDir } = await journalFixture(t);
    const results = await Promise.allSettled([
        openJournal({ stateDir, reclaimStaleOwner: true }),
        openJournal({ stateDir, reclaimStaleOwner: true }),
    ]);
    const success = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(success.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'OWNER_BUSY');
    assert.equal((await archives(stateDir)).length, 1);
    await success[0].value.close();
});

function sessionOptions(stateDir, { unknown = false, invokeCounter = { value: 0 }, seedCounter = { value: 0 } } = {}) {
    const text = 'Restart fixture snapshot with stable task identity';
    const makeAdapter = provider => createDiscussionAdapter({
        id: `restart-${provider}`, provider, version: '1', mode: 'fake',
        profile: { format: 'json', requireConversationMatch: true, allowlistedTerminalMarkers: ['fixture.completed'] },
        invoke: async ({ binding, invocationId }) => {
            invokeCounter.value += 1;
            return { exitCode: 0, stderr: '', stdout: JSON.stringify({
                conversationId: binding.conversation_id, invocationId,
                payload: { schema_version: 1, kind: 'reply', body: 'Answer from the original conversation' },
            }) };
        },
        classify: raw => {
            const value = JSON.parse(raw.stdout);
            return { completion: unknown ? 'unknown' : 'succeeded', payload: value.payload,
                observedConversationId: value.conversationId, observedInvocationId: value.invocationId,
                terminalMarker: 'fixture.completed', evidenceRef: 'fixture-evidence', hasTerminalError: false };
        },
    });
    return {
        enabled: true, stateDir, sessionId: 'restart-session', taskId: 'restart-task', planRevision: 1,
        snapshot: { text, sha256: sha256Utf8(text) },
        models: { agy: 'gemini-3.8-flash-high' }, efforts: { agy: 'high' },
        seeds: Object.fromEntries(['codex', 'agy'].map(provider => [provider, async () => {
            seedCounter.value += 1;
            return { conversationId: `original-${provider}-conversation` };
        }])),
        adapters: { codex: makeAdapter('codex'), agy: makeAdapter('agy') },
        hostPorts: {
            authority: { check: async () => true },
            capabilityVerifier: {
                verify: async args => ({ allowed: true, evidenceId: 'fixture-capability', expiresAt: Date.now() + 600_000,
                    bindingRef: args.bindingRef, provider: args.provider, adapterId: args.adapterId,
                    adapterVersion: args.adapterVersion, conversationId: args.binding.conversation_id,
                    snapshotSha256: args.snapshotSha256, stage: args.stage }),
                verifyRecovery: async () => ({ allowed: false }),
            },
        },
    };
}
function question(session, id = 'question-1', sequence = 1) {
    const now = Date.now();
    return { schema_version: 1, message_id: id, sender_ref: bindingRef(session.bindings[0]),
        recipient_ref: bindingRef(session.bindings[1]), sequence, kind: 'question', body: 'Continue the same conversation?',
        created_at: now, expires_at: now + 300_000 };
}

for (const unknown of [false, true]) {
    test(`shared session rebuild preserves exact bindings and relay state (${unknown ? 'unknown' : 'clean'}) without seeds or dispatch`, async t => {
        const stateDir = await directory(t);
        const counters = { seedCounter: { value: 0 }, invokeCounter: { value: 0 }, unknown };
        const options = sessionOptions(stateDir, counters);
        const original = await createDiscussionSession(options);
        await original.relay.receive(question(original));
        if (unknown) await assert.rejects(original.relay.dispatch('question-1'), { code: 'OUTCOME_UNKNOWN' });
        else await original.relay.dispatch('question-1');
        const expected = await original.relay.inspect();
        const before = await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8');
        if (unknown) await assert.rejects(original.close(), { code: 'OUTCOME_UNKNOWN' });
        else await original.close();
        await owner(stateDir);
        const recovered = await createDiscussionSession({ ...options, reclaimStaleOwner: true });
        assert.equal(counters.seedCounter.value, 2);
        assert.equal(counters.invokeCounter.value, 1);
        assert.deepEqual(recovered.bindings, original.bindings);
        assert.deepEqual(recovered.conversationIds, original.conversationIds);
        assert.deepEqual(await recovered.relay.inspect(), expected);
        const journal = await inspectJournal({ stateDir });
        assert.deepEqual(expected.bindings, journal.events[0].event.bindings);
        assert.equal(journal.events.filter(record => record.event.type === 'registered').length, 1);
        assert.equal(await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8'), before);
        if (unknown) {
            await assert.rejects(runDiscussionPhase({ session: recovered, phase: 'scout',
                promptBody: 'Do not send this question', messageId: 'replacement-question',
                senderRef: bindingRef(recovered.bindings[0]), recipientRef: bindingRef(recovered.bindings[1]) }),
            error => {
                assert.equal(error.code, 'OUTCOME_UNKNOWN');
                assert.deepEqual(error.details.unknown, expected.unknown);
                return true;
            });
            assert.equal(await fs.readFile(path.join(stateDir, 'journal.jsonl'), 'utf8'), before);
            await assert.rejects(recovered.relay.dispatch('question-1'), { code: 'OUTCOME_UNKNOWN' });
            await assert.rejects(recovered.close(), { code: 'OUTCOME_UNKNOWN' });
            assert.equal(counters.invokeCounter.value, 1);
        } else await recovered.close();
    });
}

test('restart after dispatch_intent without response restores unknown refs and blocks redispatch', async t => {
    const stateDir = await directory(t);
    const counters = { seedCounter: { value: 0 }, invokeCounter: { value: 0 } };
    const options = sessionOptions(stateDir, counters);
    const original = await createDiscussionSession(options);
    const envelope = question(original);
    await original.relay.receive(envelope);
    const originalView = await original.relay.inspect();
    await original.close();
    const writer = await openJournal({ stateDir });
    await writer.append({ type: 'dispatch_intent', message_id: envelope.message_id,
        invocation_id: 'inv-1-1', binding_ref: envelope.recipient_ref, capability_evidence_id: 'fixture-capability' });
    await writer.close();
    await owner(stateDir);
    const recovered = await createDiscussionSession({ ...options, reclaimStaleOwner: true });
    const view = await recovered.relay.inspect();
    assert.equal(view.blocked, true);
    assert.equal(view.invocation_count, 1);
    assert.deepEqual(view.messages, originalView.messages);
    assert.deepEqual(view.unknown, { message_id: envelope.message_id, invocation_id: 'inv-1-1',
        binding_ref: envelope.recipient_ref, reason: 'in_flight_after_intent' });
    assert.equal(view.turns[0].provider, 'outcome_unknown');
    await assert.rejects(recovered.relay.dispatch(envelope.message_id), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(counters.seedCounter.value, 2);
    assert.equal(counters.invokeCounter.value, 0);
    await assert.rejects(recovered.close(), { code: 'OUTCOME_UNKNOWN' });
});

test('rebuild rejects changed model or snapshot instead of seeding a replacement conversation', async t => {
    for (const change of ['model', 'snapshot']) {
        const stateDir = await directory(t);
        const counters = { seedCounter: { value: 0 } };
        const options = sessionOptions(stateDir, counters);
        const original = await createDiscussionSession(options);
        await original.close();
        await owner(stateDir);
        const changed = change === 'model' ? { models: { agy: 'changed-explicit-model' } }
            : { snapshot: { text: 'Changed snapshot', sha256: sha256Utf8('Changed snapshot') } };
        await assert.rejects(createDiscussionSession({ ...options, ...changed, reclaimStaleOwner: true }),
            { code: 'CORRELATION_INVALID' });
        assert.equal(counters.seedCounter.value, 2);
        assert.equal((await inspectJournal({ stateDir })).events.length, 1);
    }
});

test('default session opening a retained owner stays busy before calling any seed', async t => {
    const stateDir = await directory(t);
    const counters = { seedCounter: { value: 0 } };
    const options = sessionOptions(stateDir, counters);
    const original = await createDiscussionSession(options);
    await original.close();
    await owner(stateDir);
    await assert.rejects(createDiscussionSession(options), { code: 'OWNER_BUSY' });
    assert.equal(counters.seedCounter.value, 2);
    assert.deepEqual(await archives(stateDir), []);
});
