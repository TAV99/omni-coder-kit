/**
 * Viewer index and dispatcher for Omni UI (T08)
 */

import { renderTextViewer } from './text.mjs';
import { renderMarkdownViewer } from './markdown.mjs';
import { renderHtmlViewer } from './html.mjs';
import { renderPdfViewer } from './pdf.mjs';
import { renderDocxViewer } from './docx.mjs';

export function renderViewer(params = {}) {
    const { type, container } = params;
    if (!container) {
        throw new Error('renderViewer requires a container element');
    }

    switch (type) {
        case 'markdown':
            return renderMarkdownViewer(params);
        case 'html':
            return renderHtmlViewer(params);
        case 'pdf':
            return renderPdfViewer(params);
        case 'docx':
            return renderDocxViewer(params);
        case 'text':
        default:
            return renderTextViewer(params);
    }
}

export {
    renderTextViewer,
    renderMarkdownViewer,
    renderHtmlViewer,
    renderPdfViewer,
    renderDocxViewer,
};
