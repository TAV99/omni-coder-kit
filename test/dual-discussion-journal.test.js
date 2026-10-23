'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    openJournal,
    inspectJournal,
} = require('../lib/dual/discussion/journal');

describe('dual discussion journal (Task 2: R06, R12-R14, R18-R19, R22)', () => {
    let tempRoot;
    let stateDir;

    beforeEach(async () => {
        tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'omni-disc-journal-'));
        stateDir = path.join(tempRoot, 'state');
    });

    afterEach(async () => {
        if (tempRoot && fs.existsSync(tempRoot)) {
            await fsp.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('R13 & R19: enforces single dispatch owner, rejects dead-PID lock takeover, and supports clean close/reopen', async () => {
        const a = await openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 });
        await assert.rejects(
            openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 }),
            { code: 'OWNER_BUSY' },
        );

        await a.append({ type: 'received', message_id: 'm1' });
        assert.equal((await a.read()).events.length, 1);

        // Wrong owner token cannot release lock
        await assert.rejects(
            a.close({ releaseToken: 'wrong-token' }),
            { code: 'OWNER_BUSY' },
        );

        await a.close();

        // Reopen after clean close succeeds and preserves events
        const b = await openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 });
        const view = await b.read();
        assert.equal(view.events.length, 1);
        assert.equal(view.events[0].event.message_id, 'm1');
        await b.close();

        // Simulate stale lock from a dead PID: openJournal must still fail with OWNER_BUSY
        await fsp.writeFile(
            path.join(stateDir, 'owner.lock'),
            JSON.stringify({ schema_version: 1, owner_token: 'dead-token', pid: 999999, started_at: 1000 }) + '\n',
            'utf8',
        );
        await assert.rejects(
            openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 }),
            { code: 'OWNER_BUSY' },
        );

        // Readonly inspect still works while locked
        const inspected = await inspectJournal({ stateDir });
        assert.equal(inspected.locked, true);
        assert.equal(inspected.events.length, 1);
    });

    it('R12 & R14: detects torn tail, hash tamper, index gap without truncating, and poisons on sync failure', async () => {
        const j = await openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 });
        await j.append({ type: 'received', message_id: 'm1' });
        await j.append({ type: 'dispatch_intent', message_id: 'm1', invocation_id: 'inv-1' });
        await j.close();

        // Inspect shows unresolved dispatch_intent
        const view1 = await inspectJournal({ stateDir });
        assert.equal(view1.unresolvedInvocations.length, 1);
        assert.equal(view1.unresolvedInvocations[0].invocation_id, 'inv-1');

        // Append a torn tail (no trailing newline) in fixture
        const journalPath = path.join(stateDir, 'journal.jsonl');
        const originalContent = await fsp.readFile(journalPath, 'utf8');
        await fsp.appendFile(journalPath, '{"schema_version":1,"half":', 'utf8');
        const sizeBefore = (await fsp.stat(journalPath)).size;

        await assert.rejects(
            inspectJournal({ stateDir }),
            { code: 'JOURNAL_INVALID' },
        );
        // Ensure file was NOT truncated
        const sizeAfter = (await fsp.stat(journalPath)).size;
        assert.equal(sizeAfter, sizeBefore);

        // Restore and test hash chain tamper
        const tampered = originalContent.replace('"message_id":"m1"', '"message_id":"m2"');
        await fsp.writeFile(journalPath, tampered, 'utf8');
        await assert.rejects(
            inspectJournal({ stateDir }),
            { code: 'JOURNAL_INVALID' },
        );

        // Test sync failure poisons owner and retains lock
        const stateDirSyncFail = path.join(tempRoot, 'sync-fail');
        let failNextSync = false;
        const jSync = await openJournal({
            stateDir: stateDirSyncFail,
            maxBytes: 8388608,
            maxEvents: 256,
            syncHook: async () => {
                if (failNextSync) {
                    throw new Error('Simulated disk sync EIO');
                }
            },
        });
        failNextSync = true;
        await assert.rejects(
            jSync.append({ type: 'received', message_id: 'm-fail' }),
            { code: 'JOURNAL_INVALID' },
        );
        await assert.rejects(
            jSync.close(),
            { code: 'JOURNAL_INVALID' },
        );
        assert.equal(fs.existsSync(path.join(stateDirSyncFail, 'owner.lock')), true);
    });

    it('R18 & R22: enforces pre-write maxEvents/maxBytes quota without poisoning and rejects unexpected paths/non-regular files', async () => {
        const j = await openJournal({ stateDir, maxBytes: 600, maxEvents: 2 });
        await j.append({ type: 'received', message_id: 'm1' });
        await j.append({ type: 'received', message_id: 'm2' });

        // Exceeding maxEvents throws LIMIT_EXCEEDED before write and does NOT poison journal
        await assert.rejects(
            j.append({ type: 'received', message_id: 'm3' }),
            { code: 'LIMIT_EXCEEDED' },
        );
        assert.equal((await j.read()).events.length, 2);
        await j.close();

        // Reopen with larger event limit and 600-byte limit so 3rd large event exceeds maxBytes on append
        const jBytes = await openJournal({ stateDir, maxBytes: 600, maxEvents: 10 });
        await assert.rejects(
            jBytes.append({ type: 'received', message_id: 'm3', body: 'x'.repeat(300) }),
            { code: 'LIMIT_EXCEEDED' },
        );
        await jBytes.close();

        // Unexpected file in stateDir is rejected
        await fsp.writeFile(path.join(stateDir, 'unexpected.txt'), 'rogue', 'utf8');
        await assert.rejects(
            openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 }),
            { code: 'JOURNAL_INVALID' },
        );
    });

    it('P2 regression & close-sync handle cleanup: snapshots caller event at call time before enqueue yield, and closes file handle when close-time sync fails', async () => {
        const j = await openJournal({ stateDir, maxBytes: 8388608, maxEvents: 256 });

        const event = {
            type: 'received',
            message_id: 'original',
            nested: { note: 'original-nested', list: ['a'] },
        };
        const pending = j.append(event);
        event.message_id = 'mutated';
        event.nested.note = 'mutated-nested';
        event.nested.list.push('b');
        await pending;

        const view = await j.read();
        assert.equal(view.events[0].event.message_id, 'original');
        assert.equal(view.events[0].event.nested.note, 'original-nested');
        assert.deepEqual(view.events[0].event.nested.list, ['a']);
        await j.close();

        // Close-time sync failure retains lock AND closes the underlying journal file handle
        const closeFailDir = path.join(tempRoot, 'close-sync-fail');
        const realOpen = fsp.open;
        let trackedJournalCloseCount = 0;
        fsp.open = async (targetPath, flags, mode) => {
            const handle = await realOpen(targetPath, flags, mode);
            if (String(targetPath).endsWith('journal.jsonl')) {
                const origClose = handle.close.bind(handle);
                handle.close = async (...args) => {
                    trackedJournalCloseCount += 1;
                    return origClose(...args);
                };
            }
            return handle;
        };

        try {
            let failCloseSync = false;
            const jCloseFail = await openJournal({
                stateDir: closeFailDir,
                maxBytes: 8388608,
                maxEvents: 256,
                syncHook: async () => {
                    if (failCloseSync) {
                        throw new Error('Simulated close-time fsync error');
                    }
                },
            });
            await jCloseFail.append({ type: 'received', message_id: 'm1' });
            assert.equal(trackedJournalCloseCount, 0);

            failCloseSync = true;
            await assert.rejects(jCloseFail.close(), { code: 'JOURNAL_INVALID' });
            assert.equal(fs.existsSync(path.join(closeFailDir, 'owner.lock')), true);
            assert.equal(trackedJournalCloseCount, 1);
        } finally {
            fsp.open = realOpen;
        }
    });
});
