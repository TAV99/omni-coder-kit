'use strict';

// Observability & heartbeat (docs/SPEC-OBSERVABILITY-HEARTBEAT.md §3).
// All injected — no real spawn / CLI / git is touched.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
    formatStepStart, formatStepEnd, formatTick, formatTimeout, TIMEOUT_HINTS,
    formatDuration, lastLines, createHeartbeat,
} = require('../lib/harness/observability');
const { nextTask } = require('../lib/harness/tasks');
const { runCommandAsync } = require('../lib/harness/tools/shell');
const hostCli = require('../lib/harness/providers/host-cli');
const { appendEvent, eventsPath, readEventsFrom, eventsByteLength, summarizeEvents } = require('../lib/harness/events');
const { renderRunEvent, printRunSummary } = require('../lib/commands/run');
const { runHarness } = require('../lib/harness/loop');

// chalk@4 is plain under a non-TTY, but strip ANSI defensively (FORCE_COLOR).
const strip = (s) => String(s).replace(/\[[0-9;]*m/g, '');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omni-obs-'));

// A fake child_process for runCommandAsync — emits asynchronously then closes.
function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null } = {}) {
    return () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            if (error) { child.emit('error', error); return; }
            if (stdout) child.stdout.emit('data', Buffer.from(stdout));
            if (stderr) child.stderr.emit('data', Buffer.from(stderr));
            child.emit('close', code, null);
        });
        return child;
    };
}

// ─── OBS-1: boundary heartbeat formatters + nextTask ───────────────────────
describe('OBS-1 — step boundary formatters', () => {
    test('formatStepStart: full line matches the mockup shape', () => {
        const at = new Date(2026, 0, 1, 14, 3, 21);
        const line = formatStepStart({ state: 'COOK', ide: 'antigravity', model: 'gemini-3-pro', taskIdx: 3, total: 8, desc: 'thêm hàm sub()', at });
        assert.equal(line, '▶ COOK · agent=antigravity(gemini-3-pro) · task 3/8 "thêm hàm sub()" · 14:03:21');
    });

    test('formatStepStart: no model, no tasks → bare agent + clock only', () => {
        const at = new Date(2026, 0, 1, 9, 5, 7);
        const line = formatStepStart({ state: 'PLAN', ide: 'claudecode', at });
        assert.equal(line, '▶ PLAN · agent=claudecode · 09:05:07');
    });

    test('formatStepEnd: success carries duration + files', () => {
        assert.equal(
            formatStepEnd({ state: 'COOK', sec: 31, exitCode: 0, files: ['src/sub.js', 'test/sub.test.js'] }),
            '✓ COOK xong (31s, exit=0) — files: src/sub.js, test/sub.test.js'
        );
    });

    test('formatStepEnd: success without files omits the files clause', () => {
        assert.equal(formatStepEnd({ state: 'DOC', sec: 4, exitCode: 0 }), '✓ DOC xong (4s, exit=0)');
    });

    test('formatStepEnd: failure shows exit code', () => {
        assert.equal(formatStepEnd({ state: 'CHECK', sec: 12, exitCode: 1 }), '✗ CHECK exit=1 (12s)');
    });

    test('nextTask: first unchecked, skipping [BLOCKED], strips tags', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'),
            '- [x] done one\n- [ ] [BLOCKED] stuck\n- [ ] [ACCEPT] R3: add validate input\n', 'utf-8');
        const t = nextTask(dir);
        assert.equal(t.total, 3);
        assert.equal(t.idx, 2);          // 1 completed → next is position 2
        assert.equal(t.desc, 'R3: add validate input');
    });

    test('nextTask: missing todo.md → zeros', () => {
        assert.deepEqual(nextTask(tmp()), { idx: 0, total: 0, desc: '' });
    });
});

// ─── OBS-2: error / timeout surfacing ──────────────────────────────────────
describe('OBS-2 — stderr + timeout surfacing', () => {
    test('host-cli runStep returns stderrTail on failure', async () => {
        const failRun = () => ({ exitCode: 1, stdout: '', stderr: 'noise\n● sub() should subtract\n  expected 2 received -2\n', timedOut: false });
        const prov = hostCli.create({ ide: 'claudecode', runCommand: failRun });
        const r = await prov.runStep('check', { projectDir: '/tmp' });
        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 1);
        assert.match(r.stderrTail, /should subtract/);
    });

    test('host-cli runStep flags timeout with timeoutMs', async () => {
        const toRun = () => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true });
        const prov = hostCli.create({ ide: 'claudecode', runCommand: toRun, timeoutMs: 600000 });
        const r = await prov.runStep('cook', { projectDir: '/tmp' });
        assert.equal(r.timedOut, true);
        assert.equal(r.exitCode, 124);
        assert.equal(r.timeoutMs, 600000);
    });

    test('renderRunEvent: failed step-end prints stderr tail', () => {
        const lines = renderRunEvent({ type: 'step-end', state: 'CHECK', sec: 5, exitCode: 1, stderrTail: '● sub() should subtract' }).map(strip);
        const s = lines.join('\n');
        assert.match(s, /✗ CHECK exit=1/);
        assert.match(s, /stderr:/);
        assert.match(s, /should subtract/);
    });

    test('renderRunEvent: timeout step-end prints ⏱ + hints', () => {
        const lines = renderRunEvent({ type: 'step-end', state: 'COOK', sec: 600, timedOut: true, timeoutMs: 600000 }).map(strip);
        const s = lines.join('\n');
        assert.match(s, /⏱ COOK timeout sau 10m/);
        assert.match(s, /--yolo/);          // a hint is present
        assert.equal(lines.length, 1 + TIMEOUT_HINTS.length);
    });

    test('renderRunEvent: blocked + pause include the resume hint', () => {
        assert.match(renderRunEvent({ type: 'blocked', reason: 'x' }).map(strip).join('\n'), /omni run --resume/);
        assert.match(renderRunEvent({ type: 'pause', reason: 'y' }).map(strip).join('\n'), /omni run --resume/);
    });

    test('lastLines: keeps only the trailing N non-empty lines', () => {
        const txt = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n\n';
        const out = lastLines(txt, 15).split('\n');
        assert.equal(out.length, 15);
        assert.equal(out[out.length - 1], 'l19');
    });
});

// ─── OBS-3: async spawn + heartbeat ticker + stream forwarding ─────────────
describe('OBS-3 — runCommandAsync + heartbeat ticker', () => {
    test('runCommandAsync: resolves {exitCode,stdout} from a fake spawn', async () => {
        const res = await runCommandAsync('echo hi', { spawnFn: fakeSpawn({ stdout: 'hi\n', code: 0 }) });
        assert.equal(res.exitCode, 0);
        assert.equal(res.stdout, 'hi\n');
        assert.equal(res.timedOut, false);
    });

    test('runCommandAsync: forwards stdout chunks to onStdout', async () => {
        const chunks = [];
        await runCommandAsync('x', { spawnFn: fakeSpawn({ stdout: 'chunk-A\n' }), onStdout: (s) => chunks.push(s) });
        assert.deepEqual(chunks, ['chunk-A\n']);
    });

    test('runCommandAsync: ENOENT → exit 127', async () => {
        const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
        const res = await runCommandAsync('nope', { spawnFn: fakeSpawn({ error: err }) });
        assert.equal(res.exitCode, 127);
    });

    test('runCommandAsync: denied command rejects WITHOUT spawning', async () => {
        let spawned = false;
        await assert.rejects(
            () => runCommandAsync('rm -rf /', { spawnFn: () => { spawned = true; return new EventEmitter(); } }),
            /deny-list/
        );
        assert.equal(spawned, false);
    });

    test('createHeartbeat: onTick fires with elapsed seconds; stop clears', () => {
        let fire = null; let cleared = false; let now = 0;
        const ticks = [];
        const hb = createHeartbeat({
            onTick: (sec) => ticks.push(sec), intervalMs: 10000, now: () => now,
            setIntervalFn: (fn) => { fire = fn; return { unref() {} }; },
            clearIntervalFn: () => { cleared = true; },
        });
        hb.start();
        assert.equal(hb.running, true);
        now = 12000; fire();   // simulate the 10s timer firing at t=12s
        now = 23000; fire();
        hb.stop();
        assert.deepEqual(ticks, [12, 23]);
        assert.equal(cleared, true);
        assert.equal(hb.running, false);
    });

    test('host-cli create({stream:true}) uses the async path + forwards onStdout', async () => {
        let asyncUsed = false;
        const captured = [];
        const fakeAsync = async (cmd, opts) => {
            asyncUsed = true;
            if (opts.onStdout) opts.onStdout('agent says hi\n');
            return { exitCode: 0, stdout: 'agent says hi\n', stderr: '', timedOut: false };
        };
        const prov = hostCli.create({ ide: 'antigravity', stream: true, runCommandAsync: fakeAsync, onStdout: (s) => captured.push(s) });
        const r = await prov.runStep('cook', { projectDir: '/tmp' });
        assert.equal(asyncUsed, true);
        assert.equal(r.ok, true);
        assert.deepEqual(captured, ['agent says hi\n']);
        assert.equal(prov.ide, 'antigravity');           // provider exposes ide
        assert.equal(typeof prov.modelFor, 'function');   // …and modelFor for step-start
    });

    test('host-cli default (no stream) stays on the sync path', async () => {
        let syncUsed = false;
        const fakeSync = () => { syncUsed = true; return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'claudecode', runCommand: fakeSync });
        await prov.runStep('plan', { projectDir: '/tmp' });
        assert.equal(syncUsed, true);
    });
});

// ─── OBS-4: run log --follow incremental read ──────────────────────────────
describe('OBS-4 — readEventsFrom incremental tail', () => {
    test('reads only newly appended lines; ignores a partial trailing line', () => {
        const dir = tmp();
        appendEvent(dir, { type: 'transition', from: 'INIT', to: 'COOK' });
        const first = readEventsFrom(dir, 0);
        assert.equal(first.events.length, 1);
        assert.equal(first.events[0].to, 'COOK');

        appendEvent(dir, { type: 'step-start', step: 'cook', state: 'COOK' });
        const second = readEventsFrom(dir, first.offset);
        assert.equal(second.events.length, 1);
        assert.equal(second.events[0].type, 'step-start');

        // No new data → empty.
        assert.equal(readEventsFrom(dir, second.offset).events.length, 0);

        // A half-written record is NOT consumed until its newline lands.
        fs.appendFileSync(eventsPath(dir), '{"type":"step-end"');
        const partial = readEventsFrom(dir, second.offset);
        assert.equal(partial.events.length, 0);
        assert.equal(partial.offset, second.offset);
        fs.appendFileSync(eventsPath(dir), ',"exitCode":0}\n');
        const completed = readEventsFrom(dir, partial.offset);
        assert.equal(completed.events.length, 1);
        assert.equal(completed.events[0].type, 'step-end');
    });

    test('eventsByteLength tracks the attach cursor', () => {
        const dir = tmp();
        assert.equal(eventsByteLength(dir), 0);
        appendEvent(dir, { type: 'pause', reason: 'x' });
        assert.ok(eventsByteLength(dir) > 0);
    });
});

// ─── OBS-5: acceptance progress + run total ────────────────────────────────
describe('OBS-5 — acceptance progress + run summary', () => {
    test('renderRunEvent acceptance shows met/total + unmet ids', () => {
        const s = renderRunEvent({ type: 'acceptance', allMet: false, met: 2, total: 3, failed: ['R3'] }).map(strip).join('\n');
        assert.match(s, /requirements: 2\/3 đạt/);
        assert.match(s, /chưa đạt: R3/);
    });

    test('summarizeEvents sums duration + tokens across states', () => {
        const events = [
            { type: 'transition', to: 'COOK' },
            { type: 'provider', durationMs: 1000 },
            { type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
            { type: 'transition', to: 'CHECK' },
            { type: 'provider', durationMs: 500 },
        ];
        const { totals } = summarizeEvents(events);
        assert.equal(totals.providerCalls, 2);
        assert.equal(totals.durationMs, 1500);
        assert.equal(totals.inputTokens + totals.outputTokens, 150);
    });

    test('printRunSummary: host-cli (no usage) → steps + time, no tok/cost', () => {
        const dir = tmp();
        appendEvent(dir, { type: 'transition', to: 'COOK' });
        appendEvent(dir, { type: 'provider', durationMs: 65000 });
        appendEvent(dir, { type: 'provider', durationMs: 43000 });
        const logs = [];
        const orig = console.log;
        console.log = (...a) => logs.push(a.join(' '));
        try { printRunSummary(dir); } finally { console.log = orig; }
        const out = strip(logs.join('\n'));
        assert.match(out, /📊 2 bước/);
        assert.match(out, /1m48s/);     // 108s → 1m48s
        assert.doesNotMatch(out, /tok/);
    });

    test('formatDuration: seconds and minutes', () => {
        assert.equal(formatDuration(31000), '31s');
        assert.equal(formatDuration(108000), '1m48s');
        assert.equal(formatDuration(120000), '2m');
    });
});

// ─── Integration: live loop emits step-start / step-end into the log ───────
describe('OBS-1 integration — step events persisted + delivered', () => {
    test('runHarness (dry-run) emits step-start/step-end through onEvent + ndjson', async () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), '- [x] a\n', 'utf-8');
        const seen = [];
        const passGate = () => ({ passed: true, results: [], failures: [] });
        await runHarness(dir, {
            from: 'COOK', provider: 'dry-run', runPipeline: passGate,
            onEvent: (e) => seen.push(e),
        });
        const starts = seen.filter((e) => e.type === 'step-start');
        const ends = seen.filter((e) => e.type === 'step-end');
        assert.ok(starts.some((e) => e.step === 'cook' && e.state === 'COOK'));
        assert.ok(ends.some((e) => e.step === 'cook' && e.exitCode === 0));

        // …and they are durable in events.ndjson (so `omni run log` sees them).
        const { readEvents } = require('../lib/harness/events');
        const persisted = readEvents(dir).filter((e) => e.type === 'step-start' || e.type === 'step-end');
        assert.ok(persisted.length >= 2);
    });
});
