'use strict';

// SPEC-HEARTBEAT-SPINNER.md §5 — TTY-aware spinner unit tests.
// Inject a fake stream + fake timer; assert frame cycling, label updates,
// stopAndLog clears + prints, and the non-TTY no-op path.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createSpinner } = require('../lib/cli/spinner');

function fakeStream({ tty = true } = {}) {
    const writes = [];
    return {
        isTTY: tty,
        write: (s) => { writes.push(String(s)); return true; },
        writes,
    };
}

function fakeTimer() {
    let fire = null;
    return {
        setIntervalFn: (fn) => { fire = fn; return { unref() {} }; },
        clearIntervalFn: () => { fire = null; },
        tick: () => { if (fire) fire(); },
        get fire() { return fire; },
    };
}

describe('spinner — TTY mode', () => {
    test('start writes the first frame + label + seconds', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        let now = 1000;
        const sp = createSpinner({
            stream, isTTY: true, intervalMs: 80,
            now: () => now, setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('Khởi động…');
        assert.equal(sp.isActive(), true);
        const joined = stream.writes.join('');
        assert.match(joined, /Khởi động…/);
        assert.match(joined, /· 0s/);
        // First frame in the braille set.
        assert.match(joined, /⠋/);
        // Cursor hidden.
        assert.match(joined, /\x1b\[\?25l/);
        sp.stop();
    });

    test('frame cycles on each interval tick', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: true, now: () => 0,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('x');
        t.tick(); t.tick();
        const joined = stream.writes.join('');
        // Multiple distinct frames have been written.
        const frames = new Set();
        for (const ch of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') if (joined.includes(ch)) frames.add(ch);
        assert.ok(frames.size >= 2, `expected ≥2 frames, got ${frames.size}`);
        sp.stop();
    });

    test('setLabel updates the displayed label immediately', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: true, now: () => 0,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('first');
        const before = stream.writes.length;
        sp.setLabel('second');
        const after = stream.writes.slice(before).join('');
        assert.match(after, /second/);
    });

    test('seconds counter advances with now()', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        let now = 0;
        const sp = createSpinner({
            stream, isTTY: true, now: () => now,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('x');
        now = 7000; t.tick();
        const joined = stream.writes.join('');
        assert.match(joined, /· 7s/);
        sp.stop();
    });

    test('stopAndLog clears the spinner line, prints line, leaves stopped', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: true, now: () => 0,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('label');
        const before = stream.writes.length;
        sp.stopAndLog('✓ task xong → tiếp: làm thêm');
        assert.equal(sp.isActive(), false);
        assert.equal(t.fire, null);
        const after = stream.writes.slice(before).join('');
        // Line cleared (\r\x1b[2K) and the message printed with newline.
        assert.match(after, /\r\x1b\[2K/);
        assert.match(after, /✓ task xong → tiếp: làm thêm\n/);
        // Cursor restored.
        assert.match(after, /\x1b\[\?25h/);
    });

    test('resume re-attaches the animation after stopAndLog', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: true, now: () => 0,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('label');
        sp.stopAndLog('hello');
        assert.equal(sp.isActive(), false);
        sp.resume();
        assert.equal(sp.isActive(), true);
        assert.notEqual(t.fire, null);
        sp.stop();
    });

    test('stop is idempotent and restores cursor', () => {
        const stream = fakeStream();
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: true, now: () => 0,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('x');
        sp.stop();
        sp.stop(); // no throw
        const joined = stream.writes.join('');
        assert.match(joined, /\x1b\[\?25h/);
    });
});

describe('spinner — non-TTY (no animation)', () => {
    test('start/setLabel/resume do NOT write \\r or frames', () => {
        const stream = fakeStream({ tty: false });
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: false, now: () => 0,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('label');
        sp.setLabel('label 2');
        t.tick(); // would render if active in TTY
        sp.resume();
        const joined = stream.writes.join('');
        assert.equal(joined.includes('\r'), false);
        assert.equal(joined.includes('\x1b['), false);
        // No braille frames written.
        for (const ch of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏') {
            assert.equal(joined.includes(ch), false, `unexpected frame ${ch} in non-TTY mode`);
        }
        // Timer was never installed.
        assert.equal(t.fire, null);
    });

    test('stopAndLog still prints the line in non-TTY mode', () => {
        const stream = fakeStream({ tty: false });
        const t = fakeTimer();
        const sp = createSpinner({
            stream, isTTY: false,
            setIntervalFn: t.setIntervalFn, clearIntervalFn: t.clearIntervalFn,
        });
        sp.start('x');
        sp.stopAndLog('✓ task xong');
        assert.equal(stream.writes.join(''), '✓ task xong\n');
    });
});
