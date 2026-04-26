const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Content Source-of-Truth — requirement-analysis.md ─────────────────────

describe('Content Source-of-Truth — brainstorm generates content-source.md', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'requirement-analysis.md'), 'utf-8'
    );

    it('Phase 2 references content-source.md generation', () => {
        assert.ok(content.includes('content-source.md'));
    });

    it('content-source.md has defined format with Facts section', () => {
        assert.ok(content.includes('## Facts'));
    });

    it('content-source.md has Tone section', () => {
        assert.ok(content.includes('## Tone'));
    });

    it('content-source.md has Forbidden Content section', () => {
        assert.ok(content.includes('## Forbidden Content'));
    });

    it('content-source.md generation appears AFTER design-spec.md', () => {
        const specIndex = content.indexOf('design-spec.md');
        const contentSourceIndex = content.indexOf('content-source.md');
        assert.ok(specIndex > 0);
        assert.ok(contentSourceIndex > specIndex);
    });
});

// ─── Content Source-of-Truth — cook reads content-source.md ────────────────

describe('Content Source-of-Truth — cook reads content-source.md', () => {
    const variants = [
        { name: 'base', path: path.join(TEMPLATES, 'workflows', 'coder-execution.md') },
        { name: 'claude-code', path: path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md') },
        { name: 'cursor', path: path.join(TEMPLATES, 'overlays', 'cursor', 'workflows', 'coder-execution.md') },
    ];

    for (const v of variants) {
        it(`${v.name}: Step 1 references content-source.md`, () => {
            const content = fs.readFileSync(v.path, 'utf-8');
            assert.ok(content.includes('content-source.md'));
        });
    }
});

// ─── Content Source-of-Truth — check validates content ─────────────────────

describe('Content Source-of-Truth — check validates content', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'qa-testing.md'), 'utf-8'
    );

    it('has P5: Content Validation step', () => {
        assert.ok(content.includes('P5: Content Validation'));
    });

    it('P5 cross-checks against content-source.md', () => {
        assert.ok(content.includes('content-source.md'));
    });

    it('P5 checks for placeholder/fake data', () => {
        assert.ok(content.includes('placeholder') || content.includes('fake'));
    });

    it('P5 is ADVISORY not BLOCKING', () => {
        const p5Line = content.split('\n').find(l => l.includes('P5: Content Validation'));
        assert.ok(p5Line);
        assert.ok(p5Line.includes('ADVISORY'));
    });

    it('P5 appears after P4', () => {
        const p4Index = content.indexOf('P4: Bundle Analysis');
        const p5Index = content.indexOf('P5: Content Validation');
        assert.ok(p4Index > 0);
        assert.ok(p5Index > p4Index);
    });
});
