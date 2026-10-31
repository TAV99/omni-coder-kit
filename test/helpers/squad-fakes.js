'use strict';

// Fakes for squad runtime tests: a scripted child_process.spawn and an in-memory fs.

const { EventEmitter } = require('node:events');

// script(command, args) → { stdout, stderr, code, hang }
function fakeSpawn(script = () => ({})) {
    const calls = [];
    const impl = (command, args, options) => {
        calls.push({ command, args, options });
        const result = script(command, args) || {};
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4242;
        let closed = false;
        const close = (code, signal) => {
            if (closed) return;
            closed = true;
            child.emit('close', code, signal);
        };
        child.kill = (signal) => { setImmediate(() => close(null, signal || 'SIGTERM')); return true; };
        setImmediate(() => {
            child.emit('spawn');
            if (result.hang) return;
            if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
            if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
            close(result.code ?? 0, null);
        });
        return child;
    };
    impl.calls = calls;
    return impl;
}

// files: { [path]: string }. Every listed path is a regular file.
function fakeFs(files = {}) {
    const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return {
        statSync(p) {
            if (!Object.prototype.hasOwnProperty.call(files, p)) throw enoent(p);
            return { isFile: () => true, size: Buffer.byteLength(String(files[p])) };
        },
        readFileSync(p) {
            if (!Object.prototype.hasOwnProperty.call(files, p)) throw enoent(p);
            return String(files[p]);
        },
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    };
}

module.exports = { fakeSpawn, fakeFs };
