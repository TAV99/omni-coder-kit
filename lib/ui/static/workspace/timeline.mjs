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
 * Escapes HTML characters safely.
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

    function renderEvent(event) {
        const el = doc.createElement('div');
        el.className = `os-event ${event.roleId ? `os-role-${escapeHtml(event.roleId)}` : ''}`;
        el.style.marginBottom = '14px';

        const timeStr = formatTime(event.timestamp || event.created_at);
        const sender = event.sender || event.roleId || 'System';
        const target = event.target ? ` → ${escapeHtml(event.target)}` : '';

        let contentHtml = `
            <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--os-sub, #66746e); margin-bottom:4px;">
                <span><strong>${escapeHtml(sender)}</strong>${target}</span>
                <time>${escapeHtml(timeStr)}</time>
            </div>
        `;

        if (event.title) {
            contentHtml += `<h4 style="margin:0 0 4px; font-size:12px; font-weight:600;">${escapeHtml(event.title)}</h4>`;
        }

        if (event.message || event.text || event.summary) {
            const body = event.message || event.text || event.summary;
            contentHtml += `<p style="margin:0 0 6px; font-size:11px; line-height:1.5; color:var(--os-text, #222a28); white-space:pre-wrap;">${escapeHtml(body)}</p>`;
        }

        // Gate / approval notice
        if (event.gate || event.approval) {
            const gate = event.gate || event.approval;
            contentHtml += `
                <div class="os-approval" style="border-left:2px solid var(--os-accent, #4c6b59); padding:8px 10px; background:var(--os-side, #f4f6f5); margin-top:8px;">
                    <span class="os-eyebrow" style="font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--os-accent, #4c6b59);">CHỜ DUYỆT (HUMAN GATE)</span>
                    <code style="display:block; font-size:10px; margin-top:4px; font-family:monospace; background:transparent;">${escapeHtml(gate.command || `omni squad approve ${gate.id || 'gate'}`)}</code>
                    <small style="display:block; font-size:9px; color:var(--os-sub, #66746e); margin-top:4px;">Duyệt qua terminal TTY của bạn</small>
                </div>
            `;
        }

        // Attached links or resources
        if (event.resources && Array.isArray(event.resources)) {
            contentHtml += `<div class="os-event-resources" style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">`;
            for (const res of event.resources) {
                contentHtml += `<button type="button" class="os-link-btn" data-res-kind="${escapeHtml(res.kind)}" data-res-id="${escapeHtml(res.id)}" data-res-path="${escapeHtml(res.path || '')}" style="font-size:10px; color:var(--os-accent, #4c6b59); background:none; border:none; padding:0; cursor:pointer; text-decoration:underline;">${escapeHtml(res.title || res.path || res.id)} ↗</button>`;
            }
            contentHtml += `</div>`;
        }

        el.innerHTML = contentHtml;

        // Wire resource button clicks
        el.querySelectorAll('.os-link-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (typeof onOpenResource === 'function') {
                    onOpenResource({
                        kind: btn.dataset.resKind,
                        id: btn.dataset.resId,
                        path: btn.dataset.resPath,
                    });
                }
            });
        });

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
