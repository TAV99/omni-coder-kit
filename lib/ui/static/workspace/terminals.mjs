/**
 * Terminal client view component for Omni UI Workspace (T10)
 *
 * Implements:
 * - attachTerminalView({ terminalId, container, transport, onResize, onError }) -> { dispose(), fit(), focus() }
 * - Reuses single xterm instance per attached view
 * - Handles SSE stream data, reset events, and input claim
 * - Read-only enforcement for non-interactive views
 * - Graceful fallback when xterm is not available in headless/test environments
 */

import { paletteForXterm } from './theme.mjs';

/**
 * Attaches a terminal view to a DOM container.
 *
 * @param {object} options
 * @param {string} options.terminalId
 * @param {HTMLElement} options.container
 * @param {object} [options.transport] Transport adapter { streamUrl, inputUrl, claimUrl, resizeUrl, fetchImpl, eventSourceImpl }
 * @param {function} [options.onState] Called with each server `state` event and the server-assigned client id
 * @param {string} [options.clientId]
 * @param {boolean} [options.interactive=true]
 * @param {string} [options.theme='graphite']
 * @param {function} [options.onResize]
 * @param {function} [options.onError]
 * @returns {object} { dispose(), fit(), focus(), sendInput(data), isInteractive() }
 */
// `system` follows the OS light/dark setting, like the page does.
function systemDark() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function attachTerminalView({
    terminalId,
    container,
    transport = {},
    clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    interactive = true,
    theme = 'graphite',
    onResize = null,
    onError = null,
    onState = null,
} = {}) {
    if (!terminalId) {
        throw new Error('terminalId is required');
    }
    if (!container) {
        throw new Error('container element is required');
    }

    const fetchFn = transport.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const EventSourceClass = transport.eventSourceImpl || (typeof EventSource !== 'undefined' ? EventSource : null);

    let disposed = false;
    let xtermInstance = null;
    let fitAddon = null;
    let eventSource = null;
    let currentCols = 80;
    let currentRows = 24;
    let lastGeneration = null;

    // Create wrapper element
    const termWrapper = (container.ownerDocument || document).createElement('div');
    termWrapper.className = 'os-xterm-wrapper';
    termWrapper.style.width = '100%';
    termWrapper.style.height = '100%';
    termWrapper.style.minHeight = '140px';
    termWrapper.style.overflow = 'hidden';
    container.appendChild(termWrapper);

    // Initialize xterm if present in environment, or fallback text element
    const hasXterm = typeof window !== 'undefined' && typeof window.Terminal === 'function';
    if (hasXterm) {
        const TerminalClass = window.Terminal;
        const FitClass = window.FitAddon?.FitAddon;

        xtermInstance = new TerminalClass({
            cursorBlink: interactive,
            disableStdin: !interactive,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.4,
            theme: paletteForXterm(theme, systemDark()),
            convertEol: true,
        });

        if (FitClass) {
            fitAddon = new FitClass();
            xtermInstance.loadAddon(fitAddon);
        }

        xtermInstance.open(termWrapper);
        if (fitAddon) {
            try {
                fitAddon.fit();
                currentCols = xtermInstance.cols;
                currentRows = xtermInstance.rows;
            } catch {
                // Ignore initial fit on unattached DOM
            }
        }

        if (interactive) {
            xtermInstance.onData(data => {
                if (disposed) return;
                sendInput(data);
            });
        }
    } else {
        // Fallback for headless testing or environments without xterm.js loaded
        const fallbackPre = (container.ownerDocument || document).createElement('pre');
        fallbackPre.className = 'os-terminal-fallback';
        fallbackPre.style.margin = '0';
        fallbackPre.style.padding = '8px';
        fallbackPre.style.fontFamily = 'ui-monospace, monospace';
        fallbackPre.style.fontSize = '11px';
        fallbackPre.style.lineHeight = '1.5';
        fallbackPre.style.whiteSpace = 'pre-wrap';
        fallbackPre.style.wordBreak = 'break-all';
        fallbackPre.style.height = '100%';
        fallbackPre.style.overflowY = 'auto';
        termWrapper.appendChild(fallbackPre);

        xtermInstance = {
            write: text => {
                fallbackPre.textContent += text;
                fallbackPre.scrollTop = fallbackPre.scrollHeight;
            },
            clear: () => {
                fallbackPre.textContent = '';
            },
            reset: () => {
                fallbackPre.textContent = '';
            },
            focus: () => {
                fallbackPre.focus?.();
            },
            cols: 80,
            rows: 24,
        };
    }

    // Connect to SSE stream. The server (terminal-routes.js, server.js
    // /api/pty/stream) sends output as unnamed events whose data is a JSON
    // string, a `hello` event that names this client, and `state` events.
    const streamUrl = transport.streamUrl || `/api/terminals/${encodeURIComponent(terminalId)}/stream`;
    let serverClientId = null;
    const writeChunk = raw => {
        if (disposed || !xtermInstance) return;
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* raw text */ }
        if (typeof parsed === 'string') xtermInstance.write(parsed);
        else if (parsed && typeof parsed.data === 'string') xtermInstance.write(parsed.data);
    };
    if (EventSourceClass) {
        eventSource = new EventSourceClass(streamUrl);

        eventSource.addEventListener('message', event => writeChunk(event.data));
        eventSource.addEventListener('data', event => writeChunk(event.data));

        eventSource.addEventListener('hello', event => {
            if (disposed) return;
            try {
                const hello = JSON.parse(event.data);
                if (hello.client_id) serverClientId = hello.client_id;
                if (hello.reset && xtermInstance) xtermInstance.reset?.();
                if (hello.generation) lastGeneration = hello.generation;
            } catch {
                // Ignore a malformed hello
            }
        });

        eventSource.addEventListener('reset', event => {
            if (disposed) return;
            if (xtermInstance) {
                xtermInstance.reset?.();
            }
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.generation) {
                    lastGeneration = parsed.generation;
                }
            } catch {
                // Ignore parse error on reset
            }
        });

        eventSource.addEventListener('state', event => {
            if (disposed) return;
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.generation) {
                    lastGeneration = parsed.generation;
                }
                if (typeof onState === 'function') onState(parsed, serverClientId);
            } catch {
                // Ignore
            }
        });

        eventSource.onerror = err => {
            if (disposed) return;
            if (typeof onError === 'function') {
                onError(err);
            }
        };
    }

    // Keys go out in order through one queue, and Enter is always its own
    // write: a CLI reads text + Enter in one burst as a paste (V40).
    let queue = Promise.resolve(true);
    let pendingKeys = '';
    let flushTimer = null;
    const keyWaiters = [];

    function post(url, body) {
        if (!fetchFn) return Promise.resolve(false);
        const send = () => fetchFn(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(res => res.ok, err => {
            if (typeof onError === 'function') onError(err);
            return false;
        });
        queue = queue.then(send, send);
        return queue;
    }

    function activeClientId() {
        return serverClientId || clientId;
    }

    function flushKeys() {
        clearTimeout(flushTimer);
        if (!pendingKeys) return queue;
        const data = pendingKeys;
        const waiters = keyWaiters.splice(0);
        pendingKeys = '';
        const inputUrl = transport.inputUrl || `/api/terminals/${encodeURIComponent(terminalId)}/input`;
        const sent = post(inputUrl, { client_id: activeClientId(), data });
        sent.then(ok => waiters.forEach(resolve => resolve(ok)));
        return sent;
    }

    function sendInput(data) {
        if (!interactive) {
            console.warn('[terminals] Cannot send input to read-only terminal view');
            return Promise.resolve(false);
        }
        if (!fetchFn) return Promise.resolve(false);
        const inputUrl = transport.inputUrl || `/api/terminals/${encodeURIComponent(terminalId)}/input`;
        let last = queue;
        for (const part of String(data).split(/(\r)/)) {
            if (!part) continue;
            if (part === '\r') {
                flushKeys();
                last = post(inputUrl, { client_id: activeClientId(), data: '\r' });
                continue;
            }
            pendingKeys += part;
        }
        clearTimeout(flushTimer);
        if (!pendingKeys) return last;
        // Resolves with this write's result once the batched keys are sent.
        return new Promise(resolve => {
            keyWaiters.push(resolve);
            flushTimer = setTimeout(flushKeys, 16);
        });
    }

    function claimWriter() {
        if (!interactive || !fetchFn) return Promise.resolve(false);
        const claimUrl = transport.claimUrl || `/api/terminals/${encodeURIComponent(terminalId)}/claim`;
        return post(claimUrl, { client_id: activeClientId() });
    }

    function sendSize(cols, rows) {
        if (!interactive || !fetchFn) return Promise.resolve(false);
        const resizeUrl = transport.resizeUrl || `/api/terminals/${encodeURIComponent(terminalId)}/resize`;
        return post(resizeUrl, { client_id: activeClientId(), cols, rows });
    }

    function fit() {
        if (disposed || !fitAddon || !xtermInstance) return;
        try {
            fitAddon.fit();
            if (xtermInstance.cols !== currentCols || xtermInstance.rows !== currentRows) {
                currentCols = xtermInstance.cols;
                currentRows = xtermInstance.rows;
                if (typeof onResize === 'function') {
                    onResize(currentCols, currentRows);
                }
                sendSize(currentCols, currentRows);
            }
        } catch {
            // Ignore fit failure if container is unattached or hidden
        }
    }

    // Fit, then tell the server the size even when it did not change (a tab
    // that just became the writer must size the PTY).
    function syncSize() {
        if (disposed) return Promise.resolve(false);
        fit();
        if (xtermInstance && xtermInstance.cols && xtermInstance.rows) {
            currentCols = xtermInstance.cols;
            currentRows = xtermInstance.rows;
        }
        return sendSize(currentCols, currentRows);
    }

    function focus() {
        if (disposed || !xtermInstance) return;
        try {
            xtermInstance.focus?.();
        } catch {
            // Ignore
        }
    }

    function setTheme(newTheme) {
        if (disposed || !xtermInstance || !xtermInstance.options) return;
        try {
            xtermInstance.options.theme = paletteForXterm(newTheme, systemDark());
        } catch {
            // Ignore
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(flushTimer);
        keyWaiters.splice(0).forEach(resolve => resolve(false));

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        if (xtermInstance && typeof xtermInstance.dispose === 'function') {
            xtermInstance.dispose();
            xtermInstance = null;
        }

        if (termWrapper.parentNode) {
            termWrapper.parentNode.removeChild(termWrapper);
        }
    }

    return {
        terminalId,
        clientId,
        dispose,
        fit,
        focus,
        setTheme,
        sendInput,
        claimWriter,
        sendSize,
        syncSize,
        clientIdNow: activeClientId,
        isInteractive: () => interactive,
    };
}
