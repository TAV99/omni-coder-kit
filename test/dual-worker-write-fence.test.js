'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createWorkerWriteFence } = require('../lib/dual/worker-write-fence');

function fixture(t) {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-write-fence-'));
    const sourceRoot = path.join(container, 'source');
    const workerRoot = path.join(sourceRoot, '.omni', 'worker');
    fs.mkdirSync(workerRoot, { recursive: true });
    const source = path.join(sourceRoot, 'file.txt');
    fs.writeFileSync(source, 'original');
    t.after(() => fs.rmSync(container, { recursive: true, force: true }));
    return { container: fs.realpathSync(container), sourceRoot: fs.realpathSync(sourceRoot),
        workerRoot: fs.realpathSync(workerRoot), source: fs.realpathSync(source) };
}
function run(fence, code, args) {
    const r = fence.spawn(process.execPath, ['-e', code, ...args], { encoding: 'utf8', timeout: 10000, shell: false });
    assert.equal(r.status, 0, String(r.stderr || r.error || 'child failed'));
    return JSON.parse(r.stdout);
}

test('OS fence blocks source writes and file operations while private writes and controller integration work',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t);
        const fence = createWorkerWriteFence({ ...f, spawn: cp.spawnSync });
        const result = run(fence, `
            const fs=require('fs'),p=require('path'),cp=require('child_process');
            const [source,worker,container]=process.argv.slice(1),s=p.join(source,'file.txt');
            const blocked={};
            const probe=(name,fn)=>{try{fn();blocked[name]=false;console.log(JSON.stringify(blocked));process.exit(0);}catch(e){blocked[name]=['EPERM','EACCES'].includes(e.code);}};
            fs.writeFileSync(p.join(worker,'private.txt'),'private');
            probe('write',()=>fs.writeFileSync(s,'bad'));
            probe('create',()=>fs.writeFileSync(p.join(source,'new.txt'),'bad'));
            probe('unlink',()=>fs.unlinkSync(s));
            probe('rename',()=>fs.renameSync(s,p.join(worker,'moved.txt')));
            probe('chmod',()=>fs.chmodSync(s,0o777));
            probe('sourceRename',()=>fs.renameSync(source,source+'-moved'));
            probe('ancestorRename',()=>fs.renameSync(container,container+'-moved'));
            fs.symlinkSync(s,p.join(worker,'alias'));
            probe('symlink',()=>fs.writeFileSync(p.join(worker,'alias'),'bad'));
            probe('hardlink',()=>{fs.linkSync(s,p.join(worker,'link'));fs.writeFileSync(p.join(worker,'link'),'bad');});
            probe('dotdot',()=>fs.writeFileSync(p.join(worker,'..','..','file.txt'),'bad'));
            if(s.startsWith('/private/var/'))probe('varAlias',()=>fs.writeFileSync(s.replace('/private/var/','/var/'),'bad'));
            const shell=cp.spawnSync('/bin/sh',['-c','printf bad > "$1"','probe',s]);
            blocked.shell=shell.status!==0;
            const nested=cp.spawnSync(process.execPath,['-e',"try{require('fs').writeFileSync(process.argv[1],'bad');process.exit(2)}catch(e){process.exit(['EACCES','EPERM'].includes(e.code)?0:3)}",s],{detached:true});
            blocked.detachedDescendant=nested.status===0;
            console.log(JSON.stringify(blocked));`, [f.sourceRoot, f.workerRoot, f.container]);
        for (const [operation, denied] of Object.entries(result)) assert.equal(denied, true, operation);
        assert.ok(Object.keys(result).length >= 11);
        assert.equal(fs.readFileSync(f.source, 'utf8'), 'original');
        assert.equal(fs.readFileSync(path.join(f.workerRoot, 'private.txt'), 'utf8'), 'private');
        fs.writeFileSync(f.source, 'controller integration');
        assert.equal(fs.readFileSync(f.source, 'utf8'), 'controller integration');
    });

test('OMNI_WORKER_WRITE_FENCE=off is the only explicit opt-out; it spawns unfenced on any platform', (t) => {
    const f = fixture(t);
    for (const platform of ['linux', 'win32', 'darwin']) {
        const calls = [];
        const fence = createWorkerWriteFence({ ...f, platform, env: { OMNI_WORKER_WRITE_FENCE: ' OFF ' },
            spawn: (...args) => { calls.push(args); return 'child'; } });
        assert.equal(fence.backend, 'none');
        assert.equal(fence.spawn('agy', ['-p'], { cwd: f.workerRoot }), 'child');
        assert.deepEqual(calls, [['agy', ['-p'], { cwd: f.workerRoot }]]);
    }
    for (const value of ['0', 'false', 'no', 'disabled', '']) {
        assert.throws(() => createWorkerWriteFence({ ...f, platform: 'linux', env: { OMNI_WORKER_WRITE_FENCE: value } }),
            (error) => error.code === 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' && /OMNI_WORKER_WRITE_FENCE=off/.test(error.message));
    }
});

test('fence fails closed for unsupported platforms before spawning a worker', (t) => {
    const f = fixture(t); let spawned = false;
    assert.throws(() => createWorkerWriteFence({ ...f, platform: 'win32', spawn() { spawned = true; } })
        .spawn('agy', [], {}), { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
    assert.equal(spawned, false);
});

test('fence rejects an outer shell and a disappeared private root with a typed precondition',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t); let spawned = false;
        const fence = createWorkerWriteFence({ ...f, spawn() { spawned = true; } });
        assert.throws(() => fence.spawn('agy', [], { shell: true }), { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
        assert.equal(spawned, false);
        fs.rmdirSync(f.workerRoot);
        assert.throws(() => fence.spawn('agy', [], { shell: false }), { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
        assert.equal(spawned, false);
    });

test('missing backend, rejected policy and probe exceptions never launch a worker',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t); let spawned = false;
        for (const probe of [() => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }), status: null }),
            () => ({ status: 1 }), () => { throw new Error('probe failed'); }]) {
            assert.throws(() => createWorkerWriteFence({ ...f, probe, spawn() { spawned = true; } }),
                { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
        }
        assert.equal(spawned, false);
    });

test('a pre-existing hardlink into source is refused before worker execution',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t); let spawned = false;
        fs.linkSync(f.source, path.join(f.workerRoot, 'pre-existing-link'));
        assert.throws(() => createWorkerWriteFence({ ...f, spawn() { spawned = true; } })
            .spawn(process.execPath, [], {}), { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
        assert.equal(spawned, false);
        assert.equal(fs.readFileSync(f.source, 'utf8'), 'original');
    });

test('an existing source hardlink outside both roots is refused before execution',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t); let spawned = false;
        fs.linkSync(f.source, path.join(f.container, 'outside-alias'));
        assert.throws(() => createWorkerWriteFence({ ...f, spawn() { spawned = true; } }),
            { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
        assert.equal(spawned, false);
    });

test('a protected source symlink to an outside inode is refused',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t);
        const outside = path.join(f.container, 'outside-file'); fs.writeFileSync(outside, 'outside');
        fs.symlinkSync(outside, path.join(f.sourceRoot, 'external-link'));
        assert.throws(() => createWorkerWriteFence({ ...f }), { code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' });
    });

test('a dangling symlink whose target stays inside source does not reject the fence',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t);
        // e.g. .claude/skills/x -> ../../.agents/skills/x after the skill was removed
        fs.mkdirSync(path.join(f.sourceRoot, '.claude', 'skills'), { recursive: true });
        fs.symlinkSync('../../.agents/skills/gone', path.join(f.sourceRoot, '.claude', 'skills', 'gone'));
        assert.equal(createWorkerWriteFence({ ...f }).backend, 'macos-seatbelt');
    });

test('a dangling symlink that points outside source is refused and named',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t);
        fs.symlinkSync(path.join(f.container, 'missing-outside'), path.join(f.sourceRoot, 'dangling-out'));
        assert.throws(() => createWorkerWriteFence({ ...f }),
            (err) => err.code === 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE' && /dangling-out/.test(err.message));
        fs.unlinkSync(path.join(f.sourceRoot, 'dangling-out'));
        fs.symlinkSync('../../missing-outside', path.join(f.sourceRoot, 'dangling-up'));
        assert.throws(() => createWorkerWriteFence({ ...f }), /dangling-up/);
    });

test('a refused source link names the offending path',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t);
        const outside = path.join(f.container, 'outside-file'); fs.writeFileSync(outside, 'outside');
        fs.symlinkSync(outside, path.join(f.sourceRoot, 'external-link'));
        assert.throws(() => createWorkerWriteFence({ ...f }), /external-link/);
    });

test('concurrently removed artifact directories and symlinks do not reject a valid fence',
    { skip: process.platform !== 'darwin' }, (t) => {
        const f = fixture(t), directory = path.join(f.sourceRoot, 'finalized-artifact');
        fs.mkdirSync(directory);
        const readdir = fs.readdirSync;
        try {
            fs.readdirSync = function (name, ...args) {
                if (name === directory) fs.rmdirSync(directory);
                return readdir.call(this, name, ...args);
            };
            assert.doesNotThrow(() => createWorkerWriteFence({ ...f }));
        } finally { fs.readdirSync = readdir; }
        const link = path.join(f.sourceRoot, 'finalized-link');
        fs.symlinkSync(f.source, link);
        const realpath = fs.realpathSync.native;
        try {
            fs.realpathSync.native = function (name, ...args) {
                if (name === link) fs.unlinkSync(link);
                return realpath.call(this, name, ...args);
            };
            assert.doesNotThrow(() => createWorkerWriteFence({ ...f }));
        } finally { fs.realpathSync.native = realpath; }
    });
