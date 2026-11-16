'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireUiLock, lockPath } = require('../lib/ui/ui-lock');

function root(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const liveKill = () => true; // every pid probes as alive
const deadKill = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };

test('a second omni ui for the same project is refused while the first is alive', (t) => {
    const dir = root(t);
    const first = acquireUiLock(dir, { pid: 1001, kill: liveKill });
    assert.equal(first.acquired, true);
    first.update({ port: 54483 });
    const second = acquireUiLock(dir, { pid: 1002, kill: liveKill });
    assert.equal(second.acquired, false);
    assert.equal(second.holder.pid, 1001);
    assert.equal(second.holder.port, 54483);
    assert.equal(fs.statSync(lockPath(dir)).mode & 0o777, 0o600);
});

test('a lock left by a dead process is taken over', (t) => {
    const dir = root(t);
    acquireUiLock(dir, { pid: 1001, kill: liveKill });
    const next = acquireUiLock(dir, { pid: 1002, kill: deadKill });
    assert.equal(next.acquired, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid, 1002);
});

test('release removes only the owner\'s lock, and other projects are independent', (t) => {
    const dir = root(t), other = root(t);
    const first = acquireUiLock(dir, { pid: 1001, kill: liveKill });
    assert.equal(acquireUiLock(other, { pid: 1002, kill: liveKill }).acquired, true);
    const stale = acquireUiLock(dir, { pid: 1003, kill: deadKill }); // takes over
    first.release(); // no longer the owner: must not delete 1003's lock
    assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid, 1003);
    stale.release();
    assert.equal(fs.existsSync(lockPath(dir)), false);
});
