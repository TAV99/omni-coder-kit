/**
 * Timeline feed component for Omni UI Workspace (T10)
 *
 * Implements:
 * - mountTimeline({ contextId, feed, container, onOpenResource }) -> { dispose(), update(events) }
 * - Preserves scroll position across feed updates
 * - Displays approval gates with TTY commands
 * - Renders safe links to server-provided resources
 * - Auto-scrolls only when reader is pinned to the bottom
 */

/**
 * Formats a timestamp into HH:MM or relative time.
 */
function formatTime(isoString) {
    if (!isoString) return '';
    try {
        const d = new Date(isoString);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

/**
 * Mounts a timeline view in the container.
 *
 * @param {object} options
 * @param {string} options.contextId
 * @param {Array<object>} [options.events=[]]
 * @param {HTMLElement} options.container
 * @param {function} [options.onOpenResource] Callback when user clicks a file or output link
 * @returns {object} { dispose(), update(events), scrollToBottom() }
 */
export function mountTimeline({
    contextId,
    events = [],
    container,
    onOpenResource = null,
} = {}) {
    if (!container) {
        throw new Error('container element is required');
    }

    const doc = container.ownerDocument || document;
    let disposed = false;
    let currentEvents = Array.isArray(events) ? [...events] : [];

    // Root wrapper
    const root = doc.createElement('div');
    root.className = 'os-timeline-mount';
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';
    root.style.overflowY = 'auto';
    container.appendChild(root);

    // Unread / new events pill indicator
    const newItemsIndicator = doc.createElement('button');
    newItemsIndicator.type = 'button';
    newItemsIndicator.className = 'os-new-items-pill';
    newItemsIndicator.textContent = '↓ Tin mới';
    newItemsIndicator.style.display = 'none';
    newItemsIndicator.style.position = 'sticky';
    newItemsIndicator.style.bottom = '12px';
    newItemsIndicator.style.alignSelf = 'center';
    newItemsIndicator.style.zIndex = '10';
    newItemsIndicator.style.padding = '4px 12px';
    newItemsIndicator.style.borderRadius = '12px';
    newItemsIndicator.style.fontSize = '11px';
    newItemsIndicator.style.backgroundColor = 'var(--os-accent, #4c6b59)';
    newItemsIndicator.style.color = 'var(--os-inverse, #ffffff)';
    newItemsIndicator.style.border = 'none';
    newItemsIndicator.style.cursor = 'pointer';
    newItemsIndicator.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    root.appendChild(newItemsIndicator);

    newItemsIndicator.addEventListener('click', () => {
        scrollToBottom();
        newItemsIndicator.style.display = 'none';
    });

    let isNearBottom = true;
    root.addEventListener('scroll', () => {
        const threshold = 40;
        isNearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < threshold;
        if (isNearBottom) {
            newItemsIndicator.style.display = 'none';
        }
    });

    function isScrolledToBottom() {
        const threshold = 40;
        return root.scrollHeight - root.scrollTop - root.clientHeight < threshold;
    }

    function scrollToBottom() {
        root.scrollTop = root.scrollHeight;
    }

    function node(tag, text, className) {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined && text !== null && text !== '') el.textContent = String(text);
        return el;
    }

    // The approved event layout (time · track · body), built with
    // textContent only: event text is agent output, never markup.
    function renderEvent(event) {
        const el = node('div', null, `os-event${event.roleId ? ` os-role-${String(event.roleId).replace(/[^a-z0-9_-]/gi, '')}` : ''}`);
        el.appendChild(node('time', formatTime(event.timestamp || event.created_at)));
        const track = node('div', null, 'os-event-track');
        track.appendChild(node('span'));
        el.appendChild(track);

        const body = node('div', null, 'os-event-body');
        const who = node('div', event.sender || event.roleId || 'System', 'os-event-who');
        if (event.target) who.appendChild(node('span', `→ ${event.target}`));
        body.appendChild(who);
        if (event.title) body.appendChild(node('h3', event.title));
        const text = event.message || event.text || event.summary;
        if (text) body.appendChild(node('p', text));

        // Gate / approval notice: the command runs in the person's own TTY.
        if (event.gate || event.approval) {
            const gate = event.gate || event.approval;
            const box = node('div', null, 'os-approval');
            box.appendChild(node('span', 'CHỜ NGƯỜI DÙNG DUYỆT', 'os-eyebrow'));
            box.appendChild(node('code', gate.command || `omni squad approve ${gate.id || 'gate'}`));
            box.appendChild(node('small', 'Duyệt qua terminal TTY của bạn'));
            body.appendChild(box);
        }

        if (event.resources && Array.isArray(event.resources)) {
            for (const res of event.resources) {
                const btn = node('button', `${res.title || res.path || res.id} ↗`, 'os-link');
                btn.type = 'button';
                btn.addEventListener('click', () => {
                    if (typeof onOpenResource === 'function') {
                        onOpenResource({ kind: res.kind, id: res.id, path: res.path || '' });
                    }
                });
                body.appendChild(btn);
            }
        }

        el.appendChild(body);
        return el;
    }

    function render() {
        const wasAtBottom = isScrolledToBottom();
        root.replaceChildren();

        if (currentEvents.length === 0) {
            const emptyEl = doc.createElement('div');
            emptyEl.className = 'os-timeline-empty';
            emptyEl.style.padding = '24px 16px';
            emptyEl.style.fontSize = '11px';
            emptyEl.style.color = 'var(--os-sub, #66746e)';
            emptyEl.style.textAlign = 'center';
            emptyEl.textContent = 'Chưa có sự kiện nào trong session này.';
            root.appendChild(emptyEl);
            return;
        }

        for (const ev of currentEvents) {
            root.appendChild(renderEvent(ev));
        }

        root.appendChild(newItemsIndicator);

        if (wasAtBottom) {
            scrollToBottom();
            newItemsIndicator.style.display = 'none';
        } else {
            newItemsIndicator.style.display = 'block';
        }
    }

    function update(newEvents) {
        if (disposed) return;
        currentEvents = Array.isArray(newEvents) ? [...newEvents] : [];
        render();
    }

    render();

    return {
        contextId,
        update,
        scrollToBottom,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            root.replaceChildren();
            if (root.parentNode) {
                root.parentNode.removeChild(root);
            }
        },
    };
}
