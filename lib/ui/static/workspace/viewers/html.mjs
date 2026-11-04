/**
 * Sandboxed HTML preview viewer for Omni UI (T08)
 * Strict sandbox: NO allow-scripts, NO allow-same-origin, strict meta CSP.
 */

export function buildSafeHtmlDocument(rawHtml) {
    const csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:;\">";
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${csp}
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #242c30;
    margin: 16px;
    background: #ffffff;
  }
</style>
</head>
<body>
${rawHtml || ''}
</body>
</html>`;
}

export function renderHtmlViewer({ content, container }) {
    container.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'os-html-preview';
    iframe.setAttribute('sandbox', ''); // Empty sandbox means maximum restrictions: no scripts, no same-origin
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.minHeight = '350px';
    iframe.style.border = '0';
    iframe.style.borderRadius = '4px';

    iframe.srcdoc = buildSafeHtmlDocument(content);
    container.appendChild(iframe);

    return {
        dispose() {
            iframe.srcdoc = '';
            container.innerHTML = '';
        }
    };
}
