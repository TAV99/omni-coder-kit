/**
 * Plain text viewer for Omni UI (T08)
 */

export function renderTextViewer({ content, container, openLink }) {
    container.innerHTML = '';
    const doc = typeof document !== 'undefined' ? document : (container.ownerDocument || null);

    if (doc) {
        const wrapper = doc.createElement('div');
        wrapper.className = 'os-doc-page os-text-view';
        const pre = doc.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-word';
        pre.style.font = '11px/1.7 ui-monospace, SFMono-Regular, monospace';
        pre.textContent = content || '';
        wrapper.appendChild(pre);
        container.appendChild(wrapper);
    } else {
        container.innerHTML = `<div class="os-doc-page os-text-view"><pre>${content || ''}</pre></div>`;
    }

    return {
        dispose() {
            container.innerHTML = '';
        }
    };
}
