/**
 * Markdown viewer for Omni UI (T08)
 * Parses markdown, enforces strict XSS sanitization, and routes relative links to openLink.
 */

export function sanitizeHtml(raw) {
    if (typeof raw !== 'string') return '';
    // Strip scripts, iframes, objects, forms, and event handlers
    return raw
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
        .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
        .replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '')
        .replace(/ on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/href\s*=\s*["']?\s*javascript:[^"'>]*/gi, 'href="#"');
}

export function parseMarkdownBasic(text) {
    if (!text) return '';
    const lines = text.split('\n');
    const out = [];
    let inCode = false;
    let codeBuffer = [];

    for (const line of lines) {
        if (line.startsWith('```')) {
            if (inCode) {
                out.push(`<pre class="os-code-block"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
                codeBuffer = [];
                inCode = false;
            } else {
                inCode = true;
            }
            continue;
        }

        if (inCode) {
            codeBuffer.push(line);
            continue;
        }

        if (line.startsWith('# ')) {
            out.push(`<h2>${formatInline(line.slice(2))}</h2>`);
        } else if (line.startsWith('## ')) {
            out.push(`<h3>${formatInline(line.slice(3))}</h3>`);
        } else if (line.startsWith('### ')) {
            out.push(`<h4>${formatInline(line.slice(4))}</h4>`);
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
            out.push(`<li>${formatInline(line.slice(2))}</li>`);
        } else if (line.trim() === '') {
            // empty line
        } else {
            out.push(`<p>${formatInline(line)}</p>`);
        }
    }

    if (inCode && codeBuffer.length > 0) {
        out.push(`<pre class="os-code-block"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
    }

    return out.join('\n');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatInline(str) {
    return escapeHtml(str)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" data-project-link="true">$1</a>');
}

export function renderMarkdownViewer({ content, container, openLink }) {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'os-doc-page os-markdown-view';

    let html = '';
    if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
        html = window.marked.parse(content || '');
    } else {
        html = parseMarkdownBasic(content || '');
    }

    if (typeof window !== 'undefined' && window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
        html = window.DOMPurify.sanitize(html);
    } else {
        html = sanitizeHtml(html);
    }

    wrapper.innerHTML = html;

    // Route relative links through openLink
    if (openLink && typeof openLink === 'function') {
        const links = wrapper.querySelectorAll('a');
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#')) {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    openLink(href);
                });
            }
        }
    }

    container.appendChild(wrapper);

    return {
        dispose() {
            container.innerHTML = '';
        }
    };
}
