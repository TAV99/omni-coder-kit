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
 * @param {object} [options.transport] Transport adapter { streamUrl, inputUrl, claimUrl, fetchImpl, eventSourceImpl }
 * @param {string} [options.clientId]
 * @param {boolean} [options.interactive=true]
 * @param {string} [options.theme='graphite']
 * @param {function} [options.onResize]
 * @param {function} [options.onError]
 * @returns {object} { dispose(), fit(), focus(), sendInput(data), isInteractive() }
 */
export function attachTerminalView({
    terminalId,
    container,
    transport = {},
    clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    interactive = true,
    theme = 'graphite',
    onResize = null,
    onError = null,
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
            theme: paletteForXterm(theme),
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

    // Connect to SSE stream
    const streamUrl = transport.streamUrl || `/api/terminals/${encodeURIComponent(terminalId)}/stream?client_id=${encodeURIComponent(clientId)}`;
    if (EventSourceClass) {
        eventSource = new EventSourceClass(streamUrl);

        eventSource.addEventListener('data', event => {
            if (disposed) return;
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.data && xtermInstance) {
                    xtermInstance.write(parsed.data);
                }
            } catch (err) {
                if (xtermInstance) {
                    xtermInstance.write(event.data);
                }
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

    async function sendInput(data) {
        if (!interactive) {
            console.warn('[terminals] Cannot send input to read-only terminal view');
            return false;
        }
        if (!fetchFn) return false;

        const inputUrl = transport.inputUrl || `/api/terminals/${encodeURIComponent(terminalId)}/input`;
        try {
            const res = await fetchFn(inputUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: clientId,
                    data,
                }),
            });
            return res.ok;
        } catch (err) {
            if (typeof onError === 'function') {
                onError(err);
            }
            return false;
        }
    }

    async function claimWriter() {
        if (!interactive || !fetchFn) return false;
        const claimUrl = transport.claimUrl || `/api/terminals/${encodeURIComponent(terminalId)}/claim`;
        try {
            const res = await fetchFn(claimUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: clientId }),
            });
            return res.ok;
        } catch (err) {
            return false;
        }
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
            }
        } catch {
            // Ignore fit failure if container is unattached or hidden
        }
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
            xtermInstance.options.theme = paletteForXterm(newTheme);
        } catch {
            // Ignore
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;

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
        isInteractive: () => interactive,
    };
}
