const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Example Extraction ─────────────────────────────────────────────────────

describe('Token Optimization — example extraction', () => {
    const mainContent = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'requirement-analysis.md'), 'utf-8'
    );
    const examples = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'interview-examples.md'), 'utf-8'
    );

    it('interview-examples.md exists and has content', () => {
        assert.ok(examples.length > 500, 'examples file should have substantial content');
    });

    it('requirement-analysis.md references interview-examples.md', () => {
        assert.ok(mainContent.includes('interview-examples.md'));
    });

    it('requirement-analysis.md no longer contains inline VD examples', () => {
        assert.ok(!mainContent.includes('VD e-commerce:'), 'inline e-commerce example should be extracted');
        assert.ok(!mainContent.includes('VD blog:'), 'inline blog example should be extracted');
        assert.ok(!mainContent.includes('VD task app:'), 'inline task app example should be extracted');
    });

    it('interview-examples.md contains all slot templates', () => {
        assert.ok(examples.includes('goal (mục tiêu)'));
        assert.ok(examples.includes('users (người dùng)'));
        assert.ok(examples.includes('features (tính năng)'));
        assert.ok(examples.includes('constraints (ràng buộc)'));
        assert.ok(examples.includes('edge_cases (trường hợp biên)'));
    });

    it('requirement-analysis.md keeps Question Format Rule (not an example)', () => {
        assert.ok(mainContent.includes('Question Format Rule'));
        assert.ok(mainContent.includes('Mô tả ngắn'));
        assert.ok(mainContent.includes('Gợi ý trả lời'));
        assert.ok(mainContent.includes('Ví dụ cụ thể'));
    });
});

// ─── Surgical Context Rule ──────────────────────────────────────────────────

describe('Token Optimization — surgical context rule', () => {
    it('base coder-execution has surgical context rule', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('Surgical Context'));
        assert.ok(content.includes('200 lines'));
        assert.ok(content.includes('grep/search'));
    });

    it('Claude Code overlay has surgical context rule', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('Surgical Context'));
        assert.ok(content.includes('200 lines'));
    });

    it('Codex overlay has surgical context rule', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('Surgical Context'));
        assert.ok(content.includes('200 lines'));
    });

    it('Gemini overlay has surgical context rule', () => {
        const content = fs.readFileSync(
            path.join(TEMPLATES, 'overlays', 'gemini', 'workflows', 'coder-execution.md'), 'utf-8'
        );
        assert.ok(content.includes('Surgical Context'));
        assert.ok(content.includes('200 lines'));
    });
});

// ─── Context-Aware Verbosity ────────────────────────────────────────────────

describe('Token Optimization — context-aware verbosity', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'core', 'claudex-hygiene.md'), 'utf-8'
    );

    it('has Context-Aware Verbosity section', () => {
        assert.ok(content.includes('Context-Aware Verbosity'));
    });

    it('defines terse mode for >om:cook', () => {
        assert.ok(content.includes('>om:cook'));
        assert.ok(content.includes('Terse'));
    });

    it('defines terse-on-pass for >om:check', () => {
        assert.ok(content.includes('>om:check'));
        assert.ok(content.includes('PASS'));
        assert.ok(content.includes('FAIL'));
    });

    it('defines verbose mode for >om:brainstorm', () => {
        assert.ok(content.includes('>om:brainstorm'));
        assert.ok(content.includes('Verbose'));
    });

    it('always verbose on errors', () => {
        assert.ok(content.includes('On errors'));
        assert.ok(content.includes('Always verbose') || content.includes('always verbose'));
    });

    it('has lazy examples rule', () => {
        assert.ok(content.includes('Lazy Examples'));
        assert.ok(content.includes('interview-examples.md'));
    });
});
