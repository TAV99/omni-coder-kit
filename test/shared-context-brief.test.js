const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Shared Context Brief — Claude Code overlay ───────────────────────────

describe('Shared Context Brief — Claude Code cook overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('has Context Brief step before spawning agents', () => {
        assert.ok(content.includes('Context Brief'));
    });

    it('context brief step appears BEFORE Step 6a (parallel execution)', () => {
        const briefIndex = content.indexOf('Context Brief');
        const parallelIndex = content.indexOf('Step 6a: Parallel Execution');
        assert.ok(briefIndex > 0);
        assert.ok(briefIndex < parallelIndex);
    });

    it('extracts shared facts from design-spec.md', () => {
        assert.ok(content.includes('design-spec.md'));
        assert.ok(content.includes('extract') || content.includes('Extract'));
    });

    it('brief includes tech stack summary', () => {
        assert.ok(content.includes('tech stack') || content.includes('Tech Stack'));
    });

    it('brief includes shared file inventory', () => {
        assert.ok(content.includes('shared file') || content.includes('Shared files'));
    });

    it('brief is passed to each sub-agent prompt', () => {
        assert.ok(content.includes('context brief') || content.includes('Context Brief'));
        const briefMention = content.indexOf('Context Brief');
        const agentSection = content.indexOf('self-contained prompt');
        assert.ok(agentSection > briefMention);
    });

    it('brief has token budget limit', () => {
        assert.ok(
            content.includes('~500 tokens') || content.includes('500 tokens') ||
            content.includes('under 500') || content.includes('< 500') ||
            content.includes('concise') || content.includes('compact')
        );
    });

    it('instructs agents NOT to re-read files already in the brief', () => {
        assert.ok(
            content.includes('do not re-read') || content.includes('Do NOT re-read') ||
            content.includes('already summarized') || content.includes('skip reading')
        );
    });
});
