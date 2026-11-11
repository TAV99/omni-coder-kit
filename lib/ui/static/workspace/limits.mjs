/**
 * Provider Rate Limits display component for Omni UI Workspace (T14)
 *
 * Implements:
 * - mountLimitsView({ container, limits, onRefresh }) -> { update(limits), dispose() }
 * - Honest presentation: displays em dash (—) and explanation for unavailable sources
 * - Zero fabricated percentages
 * - Displays reset time, quota windows, and staleness indicator
 */

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function mountLimitsView({
    container,
    limits = [],
    onRefresh = null,
} = {}) {
    if (!container) {
        throw new Error('container is required');
    }

    const doc = container.ownerDocument || document;
    let disposed = false;
    let currentLimits = Array.isArray(limits) ? [...limits] : [];

    function renderItem(obs) {
        const itemEl = doc.createElement('details');
        itemEl.style.fontSize = '11px';
        itemEl.style.marginBottom = '6px';
        itemEl.style.borderBottom = '1px solid var(--os-line, #dfe5e1)';
        itemEl.style.paddingBottom = '4px';

        const summaryEl = doc.createElement('summary');
        summaryEl.style.display = 'flex';
        summaryEl.style.justifyContent = 'space-between';
        summaryEl.style.alignItems = 'center';
        summaryEl.style.cursor = 'pointer';
        summaryEl.style.padding = '4px 0';

        const nameSpan = doc.createElement('span');
        nameSpan.textContent = obs.runtime ? obs.runtime.toUpperCase() : 'RUNTIME';
        nameSpan.style.fontWeight = '500';

        const valSpan = doc.createElement('span');
        valSpan.style.color = 'var(--os-sub, #66746e)';

        if (obs.status === 'available' && obs.windows && obs.windows.length > 0) {
            const firstWin = obs.windows[0];
            if (firstWin.remaining !== null) {
                valSpan.textContent = `${firstWin.remaining} ${firstWin.unit}`;
            } else {
                valSpan.textContent = '—';
            }
        } else {
            valSpan.textContent = '—';
        }

        summaryEl.appendChild(nameSpan);
        summaryEl.appendChild(valSpan);
        itemEl.appendChild(summaryEl);

        const detailsEl = doc.createElement('div');
        detailsEl.style.padding = '6px 0 8px';
        detailsEl.style.fontSize = '10px';
        detailsEl.style.color = 'var(--os-sub, #66746e)';
        detailsEl.style.lineHeight = '1.6';

        let html = '';
        if (obs.status !== 'available') {
            html += `<p style="margin:0 0 4px;"><strong>Trạng thái:</strong> ${escapeHtml(obs.status)}</p>`;
            if (obs.explanation) {
                html += `<p style="margin:0 0 4px;">${escapeHtml(obs.explanation)}</p>`;
            }
        } else {
            for (const win of obs.windows) {
                html += `<div><strong>${escapeHtml(win.label)}:</strong> `;
                if (win.remaining !== null) {
                    html += `Còn lại ${win.remaining} / ${win.limit ?? '∞'} ${win.unit}`;
                } else {
                    html += `—`;
                }
                if (win.resetsAt) {
                    html += `<br><small>Đặt lại: ${new Date(win.resetsAt).toLocaleTimeString()}</small>`;
                }
                html += `</div>`;
            }
        }

        if (obs.stale) {
            html += `<p style="margin:4px 0 0; color:#d69e2e;">⚠️ Dữ liệu cũ (>120s)</p>`;
        }

        detailsEl.innerHTML = html;
        itemEl.appendChild(detailsEl);

        return itemEl;
    }

    function render() {
        if (disposed) return;
        container.replaceChildren();

        if (currentLimits.length === 0) {
            const emptyEl = doc.createElement('small');
            emptyEl.textContent = '— Chưa có dữ liệu từ CLI';
            emptyEl.style.color = 'var(--os-sub, #66746e)';
            container.appendChild(emptyEl);
            return;
        }

        for (const obs of currentLimits) {
            container.appendChild(renderItem(obs));
        }
    }

    render();

    return {
        update: newLimits => {
            if (disposed) return;
            currentLimits = Array.isArray(newLimits) ? [...newLimits] : [];
            render();
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            container.replaceChildren();
        },
    };
}
