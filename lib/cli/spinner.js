'use strict';

// ---------------------------------------------------------------------------
// TTY-aware animated spinner (docs/SPEC-HEARTBEAT-SPINNER.md §2).
//
// One live line at the bottom of the terminal: braille frames + label + Ns.
// `stopAndLog` clears the line, prints a real line, leaves spinner stopped;
// `resume` re-attaches the animation on the next line. Under a non-TTY the
// animate ops are no-ops — `stopAndLog` just prints the line, so `tee`/CI
// logs stay clean and `events.ndjson` remains the source of truth.
//
// Pure UI — no harness coupling. Tests inject a fake stream + fake timer.
// ---------------------------------------------------------------------------

const DEFAULT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner({
    stream = process.stdout,
    frames = DEFAULT_FRAMES,
    intervalMs = 80,
    isTTY,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
} = {}) {
    const tty = (typeof isTTY === 'boolean') ? isTTY : !!(stream && stream.isTTY);
    let label = '';
    let timer = null;
    let frameIdx = 0;
    let startedAt = 0;
    let active = false;
    let cursorHidden = false;

    const write = (s) => { if (stream && typeof stream.write === 'function') stream.write(s); };
    const clearLine = () => { if (tty) write('\r\x1b[2K'); };
    const hideCursor = () => { if (tty && !cursorHidden) { write('\x1b[?25l'); cursorHidden = true; } };
    const showCursor = () => { if (tty && cursorHidden) { write('\x1b[?25h'); cursorHidden = false; } };

    const render = () => {
        if (!tty) return;
        const sec = Math.max(0, Math.floor((now() - startedAt) / 1000));
        const frame = frames[frameIdx % frames.length];
        const suffix = ` · ${sec}s`;
        const maxCols = (stream && typeof stream.columns === 'number') ? stream.columns : 80;
        const overhead = frame.length + 1 + suffix.length;
        let displayLabel = label;
        if (displayLabel.length + overhead > maxCols) {
            const cut = Math.max(0, maxCols - overhead - 3);
            displayLabel = displayLabel.slice(0, cut) + '...';
        }
        write(`\r\x1b[2K${frame} ${displayLabel}${suffix}`);
    };

    const start = (text) => {
        if (typeof text === 'string') label = text;
        if (!tty) { active = true; return; }
        if (active) { render(); return; }
        active = true;
        startedAt = now();
        frameIdx = 0;
        hideCursor();
        render();
        timer = setIntervalFn(() => {
            frameIdx = (frameIdx + 1) % frames.length;
            render();
        }, intervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    };

    const setLabel = (text) => {
        label = String(text == null ? '' : text);
        if (active && tty) render();
    };

    const stop = () => {
        if (timer) { clearIntervalFn(timer); timer = null; }
        if (tty) { clearLine(); showCursor(); }
        active = false;
    };

    const stopAndLog = (line) => {
        if (timer) { clearIntervalFn(timer); timer = null; }
        if (tty) { clearLine(); showCursor(); }
        active = false;
        if (line != null) write(String(line) + '\n');
    };

    const resume = (text) => {
        if (typeof text === 'string') label = text;
        if (!tty) { active = true; return; }
        if (active) { render(); return; }
        start(label);
    };

    const isActive = () => active;

    return { start, setLabel, stopAndLog, resume, stop, isActive };
}

module.exports = { createSpinner, DEFAULT_FRAMES };
