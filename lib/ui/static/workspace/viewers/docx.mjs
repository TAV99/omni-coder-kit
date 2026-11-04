/**
 * DOCX document viewer for Omni UI (T08)
 * Semantic read-only preview of Word documents.
 */

export function renderDocxViewer({ name, size, handle, revision, content, container }) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'os-doc-page os-docx-view';

    const header = document.createElement('div');
    header.className = 'os-doc-meta';
    header.textContent = `${(name || 'DOCUMENT.DOCX').toUpperCase()} / DOCX READ ONLY (${Math.round((size || 0) / 1024)} KiB)`;

    const body = document.createElement('div');
    body.style.padding = '15px 0';

    if (content) {
        body.innerHTML = content;
    } else {
        body.innerHTML = `
            <div style="padding: 20px 10px; border: 1px solid var(--os-line, #ccc); border-radius: 4px;">
                <h3 style="margin: 0; font-size: 14px;">${name || 'Word Document'}</h3>
                <p style="font-size: 11px; color: var(--os-sub, #666); margin-top: 8px;">
                    Bản xem trước ngữ nghĩa chỉ đọc. Tài liệu Word được hiển thị an toàn không kèm script.
                </p>
                <div style="margin-top: 14px;">
                    <a href="/api/files/${handle}/content?revision=${revision}" download="${name || 'document.docx'}"
                       style="font-size: 11px; color: var(--os-accent, #4b6876); text-decoration: underline;">
                        Tải file gốc (.docx) ↗
                    </a>
                </div>
            </div>
        `;
    }

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    container.appendChild(wrapper);

    return {
        dispose() {
            container.innerHTML = '';
        }
    };
}
