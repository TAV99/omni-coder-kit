'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('T08: document viewers and sandboxed preview', async (t) => {
    const { sanitizeHtml, parseMarkdownBasic } = await import('../../lib/ui/static/workspace/viewers/markdown.mjs');
    const { buildSafeHtmlDocument } = await import('../../lib/ui/static/workspace/viewers/html.mjs');
    const { renderViewer } = await import('../../lib/ui/static/workspace/viewers/index.mjs');

    await t.test('markdown: sanitizeHtml removes malicious tags and attributes', () => {
        const dirty = '<p>Normal text</p><script>alert("xss")</script><img src=x onerror=alert(1)><a href="javascript:alert(2)">click</a>';
        const clean = sanitizeHtml(dirty);

        assert.ok(!clean.includes('<script>'));
        assert.ok(!clean.includes('onerror'));
        assert.ok(!clean.includes('javascript:'));
        assert.ok(clean.includes('<p>Normal text</p>'));
    });

    await t.test('markdown: parseMarkdownBasic handles headers, code blocks and links', () => {
        const md = '# Title\n\nParagraph with `code` and **bold**.\n\n```js\nconsole.log(1);\n```';
        const html = parseMarkdownBasic(md);

        assert.ok(html.includes('<h2>Title</h2>'));
        assert.ok(html.includes('<code>code</code>'));
        assert.ok(html.includes('<strong>bold</strong>'));
        assert.ok(html.includes('<pre class="os-code-block">'));
    });

    await t.test('html: buildSafeHtmlDocument injects strict CSP', () => {
        const doc = buildSafeHtmlDocument('<h1>User Page</h1>');
        assert.ok(doc.includes('Content-Security-Policy'));
        assert.ok(doc.includes("default-src 'none'"));
        assert.ok(doc.includes('<h1>User Page</h1>'));
    });

    await t.test('renderViewer: requires container element and returns dispose()', () => {
        assert.throws(() => {
            renderViewer({ type: 'text' });
        }, /container/i);

        // Mock container
        const container = {
            innerHTML: '',
            appendChild() {},
        };

        const v = renderViewer({ type: 'text', content: 'hello', container });
        assert.equal(typeof v.dispose, 'function');
        v.dispose();
    });
});
