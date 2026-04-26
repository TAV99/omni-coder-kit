const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CURSOR_RULES_DIR = path.join(__dirname, '..', 'templates', 'overlays', 'cursor', 'rules');

function parseMdcFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const fm = {};
    for (const line of match[1].split('\n')) {
        const [key, ...rest] = line.split(':');
        if (key && rest.length) fm[key.trim()] = rest.join(':').trim();
    }
    return fm;
}

const ALWAYS_ACTIVE_FILES = [
    'core-mindset.mdc',
    'workflow-commands.mdc',
    'yolo-guardrails.mdc',
    'agent-mode.mdc',
];

const CONDITIONAL_FILES = [
    'backend.mdc',
    'frontend.mdc',
    'testing.mdc',
];

const ALL_MDC_FILES = [...ALWAYS_ACTIVE_FILES, ...CONDITIONAL_FILES];

describe('Cursor MDC rule templates', () => {
    it('all expected MDC files exist', () => {
        for (const f of ALL_MDC_FILES) {
            assert.ok(fs.existsSync(path.join(CURSOR_RULES_DIR, f)), `${f} should exist`);
        }
    });

    it('every MDC file has valid frontmatter with description', () => {
        for (const f of ALL_MDC_FILES) {
            const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, f), 'utf-8');
            const fm = parseMdcFrontmatter(content);
            assert.ok(fm, `${f} should have frontmatter`);
            assert.ok(fm.description, `${f} should have description`);
        }
    });

    it('always-active files have alwaysApply: true', () => {
        for (const f of ALWAYS_ACTIVE_FILES) {
            const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, f), 'utf-8');
            const fm = parseMdcFrontmatter(content);
            assert.equal(fm.alwaysApply, 'true', `${f} should have alwaysApply: true`);
        }
    });

    it('conditional files have non-empty globs', () => {
        for (const f of CONDITIONAL_FILES) {
            const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, f), 'utf-8');
            const fm = parseMdcFrontmatter(content);
            assert.ok(fm.globs && fm.globs.length > 0, `${f} should have globs`);
        }
    });

    it('conditional files do NOT have alwaysApply: true', () => {
        for (const f of CONDITIONAL_FILES) {
            const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, f), 'utf-8');
            const fm = parseMdcFrontmatter(content);
            assert.notEqual(fm.alwaysApply, 'true', `${f} should not have alwaysApply: true`);
        }
    });

    it('core-mindset.mdc references Karpathy principles', () => {
        const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, 'core-mindset.mdc'), 'utf-8');
        assert.ok(content.includes('Think Before Coding') || content.includes('Socratic Gate'));
        assert.ok(content.includes('Simplicity First'));
        assert.ok(content.includes('Surgical Changes'));
    });

    it('workflow-commands.mdc references >om: commands', () => {
        const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, 'workflow-commands.mdc'), 'utf-8');
        assert.ok(content.includes('>om:brainstorm'));
        assert.ok(content.includes('>om:cook'));
        assert.ok(content.includes('>om:check'));
        assert.ok(content.includes('@Files'));
    });

    it('yolo-guardrails.mdc references destructive commands', () => {
        const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, 'yolo-guardrails.mdc'), 'utf-8');
        assert.ok(content.includes('rm -rf') || content.includes('rm -r'));
        assert.ok(content.includes('git push --force') || content.includes('force push'));
        assert.ok(content.includes('DROP TABLE') || content.includes('DELETE FROM'));
    });

    it('agent-mode.mdc references cook-check-fix loop', () => {
        const content = fs.readFileSync(path.join(CURSOR_RULES_DIR, 'agent-mode.mdc'), 'utf-8');
        assert.ok(content.includes('quality') || content.includes('Quality'));
        assert.ok(content.includes('>om:fix') || content.includes('>om:check'));
    });
});
