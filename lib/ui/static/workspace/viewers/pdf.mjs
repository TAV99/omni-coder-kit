/**
 * PDF viewer for Omni UI (T08)
 */

export function renderPdfViewer({ name, size, handle, revision, container }) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'os-doc-page os-pdf-view';

    const header = document.createElement('div');
    header.className = 'os-doc-meta';
    header.textContent = `${(name || 'DOCUMENT.PDF').toUpperCase()} / PDF PREVIEW (${Math.round((size || 0) / 1024)} KiB)`;

    const body = document.createElement('div');
    body.style.padding = '20px 0';
    body.innerHTML = `
        <div style="text-align:center; padding: 30px 10px; border: 1px dashed var(--os-line, #ccc); border-radius: 4px;">
            <p style="font-weight: 500; font-size: 13px;">${name || 'Tài liệu PDF'}</p>
            <p style="font-size: 11px; color: var(--os-sub, #666); margin-top: 6px;">
                Xem trước tài liệu PDF cục bộ.
            </p>
            <div style="margin-top: 16px;">
                <a href="/api/files/${handle}/content?revision=${revision}" target="_blank"
                   style="display:inline-block; font-size:11px; padding:6px 12px; background:var(--os-accent, #4b6876); color:#fff; text-decoration:none; border-radius:3px;">
                    Mở toàn màn hình / Tải về ↗
                </a>
            </div>
        </div>
    `;

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    container.appendChild(wrapper);

    return {
        dispose() {
            container.innerHTML = '';
        }
    };
}
