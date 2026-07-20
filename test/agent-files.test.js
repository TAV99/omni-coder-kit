'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    AGENT_FILE_PATTERNS,
    BLOCK_START,
    BLOCK_END,
    getAgentFilesVisibility,
    hideAgentFiles,
    showAgentFiles,
    applyVisibility,
} = require(path.join(__dirname, '..', 'lib', 'agent-files'));

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-agent-files-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AGENT_FILE_PATTERNS registry', () => {
    it('includes all required root config files', () => {
        for (const f of [
            'AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
            '.cursorrules', '.windsurfrules', 'SYSTEM_PROMPT.md',
        ]) {
            assert.ok(AGENT_FILE_PATTERNS.includes(f), `missing ${f}`);
        }
    });

    it('includes all required IDE dirs', () => {
        for (const d of ['.claude/', '.codex/', '.cursor/', '.windsurf/', '.gemini/', '.agents/']) {
            assert.ok(AGENT_FILE_PATTERNS.includes(d), `missing ${d}`);
        }
    });
});

describe('hideAgentFiles / showAgentFiles', () => {
    it('hide creates .gitignore with marked block when file missing', () => {
        const r = hideAgentFiles(tmpDir);
        assert.equal(r.changed, true);
        assert.deepEqual(r.patterns, AGENT_FILE_PATTERNS);
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        assert.ok(content.includes(BLOCK_START));
        assert.ok(content.includes(BLOCK_END));
        for (const p of AGENT_FILE_PATTERNS) {
            assert.ok(content.includes(p), `gitignore missing ${p}`);
        }
        assert.equal(getAgentFilesVisibility(tmpDir), 'hidden');
    });

    it('hide is idempotent', () => {
        hideAgentFiles(tmpDir);
        const first = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        const r = hideAgentFiles(tmpDir);
        assert.equal(r.changed, false);
        const second = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        assert.equal(first, second);
    });

    it('show removes hide block only', () => {
        const generated = '# Omni-Coder Kit (generated)\n.omni/\n.claude/\n';
        fs.writeFileSync(path.join(tmpDir, '.gitignore'), generated, 'utf-8');
        hideAgentFiles(tmpDir);
        assert.equal(getAgentFilesVisibility(tmpDir), 'hidden');

        const r = showAgentFiles(tmpDir);
        assert.equal(r.changed, true);
        assert.equal(getAgentFilesVisibility(tmpDir), 'visible');
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        assert.ok(content.includes('# Omni-Coder Kit (generated)'));
        assert.ok(content.includes('.omni/'));
        assert.ok(!content.includes(BLOCK_START));
        assert.ok(!content.includes(BLOCK_END));
        // Root configs from hide block gone; .claude/ may remain from generated block
        assert.ok(!content.includes('AGENTS.md'));
        assert.ok(content.includes('.claude/'));
    });

    it('show is idempotent when already visible', () => {
        fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');
        const r = showAgentFiles(tmpDir);
        assert.equal(r.changed, false);
        assert.equal(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8'), 'node_modules/\n');
    });

    it('show throws when start marker exists without end marker', () => {
        fs.writeFileSync(
            path.join(tmpDir, '.gitignore'),
            `${BLOCK_START}\nAGENTS.md\n`,
            'utf-8'
        );
        assert.throws(() => showAgentFiles(tmpDir), (err) => err.code === 'AGENT_FILES_BLOCK_CORRUPT');
    });

    it('hide appends after existing content', () => {
        fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');
        hideAgentFiles(tmpDir);
        const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
        assert.ok(content.startsWith('node_modules/'));
        assert.ok(content.includes(BLOCK_START));
    });
});

describe('applyVisibility', () => {
    it('hidden and visible map to hide/show', () => {
        applyVisibility(tmpDir, 'hidden');
        assert.equal(getAgentFilesVisibility(tmpDir), 'hidden');
        applyVisibility(tmpDir, 'visible');
        assert.equal(getAgentFilesVisibility(tmpDir), 'visible');
    });

    it('rejects invalid value', () => {
        assert.throws(() => applyVisibility(tmpDir, 'maybe'));
    });
});

describe('createManifest agentFilesVisibility', () => {
    it('defaults to visible', () => {
        const { createManifest } = require(path.join(__dirname, '..', 'lib', 'helpers'));
        const m = createManifest();
        assert.equal(m.agentFilesVisibility, 'visible');
    });
});
