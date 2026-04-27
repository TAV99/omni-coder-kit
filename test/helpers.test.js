const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const {
    parseSource, isValidSkillName, createManifest, IDE_AGENT_MAP,
    IDE_CONFIG_FILE, getAgentFlags, getOverlayNameForTarget, detectDNA,
} = require(path.join(__dirname, '..', 'lib', 'helpers'));
const { parseRules, formatMarkdown, formatInject } = require(path.join(__dirname, '..', 'lib', 'rules'));
const buildRulesContent = (rp) => formatMarkdown(parseRules(rp));
const extractRulesForInject = (rp) => formatInject(parseRules(rp));

// ─── parseSource ─────────────────────────────────────────────────────────────

describe('parseSource', () => {
    it('parses owner/repo format', () => {
        assert.equal(parseSource('vercel-labs/skills'), 'vercel-labs/skills');
    });

    it('parses owner/repo with trailing slash', () => {
        assert.equal(parseSource('vercel-labs/skills/'), 'vercel-labs/skills');
    });

    it('parses full GitHub URL', () => {
        assert.equal(parseSource('https://github.com/obra/superpowers'), 'obra/superpowers');
    });

    it('parses GitHub URL with www', () => {
        assert.equal(parseSource('https://www.github.com/obra/superpowers'), 'obra/superpowers');
    });

    it('parses GitHub URL with subpath', () => {
        assert.equal(parseSource('https://github.com/owner/repo/tree/main/skills'), 'owner/repo/tree/main/skills');
    });

    it('parses git SSH format', () => {
        assert.equal(parseSource('git@github.com:owner/repo.git'), 'owner/repo');
    });

    it('strips .git suffix', () => {
        assert.equal(parseSource('owner/repo.git'), 'owner/repo');
    });

    it('returns null for empty input', () => {
        assert.equal(parseSource(''), null);
        assert.equal(parseSource(null), null);
        assert.equal(parseSource(undefined), null);
    });

    it('returns null for path traversal attempt', () => {
        assert.equal(parseSource('owner/../etc/passwd'), null);
    });

    it('returns null for single segment', () => {
        assert.equal(parseSource('just-a-name'), null);
    });

    it('handles whitespace', () => {
        assert.equal(parseSource('  vercel-labs/skills  '), 'vercel-labs/skills');
    });

    it('handles dots in repo name', () => {
        assert.equal(parseSource('owner/repo.name'), 'owner/repo.name');
    });

    it('handles underscores and hyphens', () => {
        assert.equal(parseSource('my_org/my-repo'), 'my_org/my-repo');
    });
});

// ─── isValidSkillName ────────────────────────────────────────────────────────

describe('isValidSkillName', () => {
    it('accepts lowercase with hyphens', () => {
        assert.ok(isValidSkillName('find-skills'));
        assert.ok(isValidSkillName('systematic-debugging'));
    });

    it('accepts lowercase alphanumeric', () => {
        assert.ok(isValidSkillName('skill123'));
    });

    it('rejects uppercase', () => {
        assert.ok(!isValidSkillName('FindSkills'));
    });

    it('rejects underscores', () => {
        assert.ok(!isValidSkillName('find_skills'));
    });

    it('rejects dots', () => {
        assert.ok(!isValidSkillName('my.skill'));
    });

    it('rejects spaces', () => {
        assert.ok(!isValidSkillName('my skill'));
    });

    it('rejects empty string', () => {
        assert.ok(!isValidSkillName(''));
    });
});

// ─── buildRulesContent ───────────────────────────────────────────────────────

describe('buildRulesContent', () => {
    it('returns null when all fields empty', () => {
        assert.equal(buildRulesContent({ language: '', codingStyle: '', forbidden: '', custom: '' }), null);
    });

    it('returns null when all fields undefined', () => {
        assert.equal(buildRulesContent({}), null);
    });

    it('builds language section', () => {
        const result = buildRulesContent({ language: 'Tiếng Việt' });
        assert.ok(result.includes('## Ngôn ngữ'));
        assert.ok(result.includes('- Tiếng Việt'));
        assert.ok(result.includes('# Personal Rules'));
    });

    it('builds coding style with semicolon splitting', () => {
        const result = buildRulesContent({ codingStyle: 'camelCase; 2-space indent; prefer const' });
        assert.ok(result.includes('## Coding Style'));
        assert.ok(result.includes('- camelCase'));
        assert.ok(result.includes('- 2-space indent'));
        assert.ok(result.includes('- prefer const'));
    });

    it('builds forbidden patterns', () => {
        const result = buildRulesContent({ forbidden: 'no any; no class components' });
        assert.ok(result.includes('## Forbidden Patterns'));
        assert.ok(result.includes('- no any'));
        assert.ok(result.includes('- no class components'));
    });

    it('builds custom rules', () => {
        const result = buildRulesContent({ custom: 'commit tiếng Việt; luôn viết test' });
        assert.ok(result.includes('## Custom Rules'));
        assert.ok(result.includes('- commit tiếng Việt'));
    });

    it('builds all sections together', () => {
        const result = buildRulesContent({
            language: 'English',
            codingStyle: 'PEP8',
            forbidden: 'no eval',
            custom: 'type hints required',
        });
        assert.ok(result.includes('## Ngôn ngữ'));
        assert.ok(result.includes('## Coding Style'));
        assert.ok(result.includes('## Forbidden Patterns'));
        assert.ok(result.includes('## Custom Rules'));
    });

    it('includes date in header', () => {
        const result = buildRulesContent({ language: 'English' });
        const today = new Date().toISOString().split('T')[0];
        assert.ok(result.includes(today));
    });

    it('filters empty segments from semicolons', () => {
        const result = buildRulesContent({ codingStyle: 'rule1;; ;rule2' });
        assert.ok(result.includes('- rule1'));
        assert.ok(result.includes('- rule2'));
        assert.ok(!result.includes('- \n'));
    });
});

// ─── extractRulesForInject ───────────────────────────────────────────────────

describe('extractRulesForInject', () => {
    it('formats language with bold label', () => {
        const result = extractRulesForInject({ language: 'Tiếng Việt' });
        assert.ok(result.includes('**Ngôn ngữ:**'));
        assert.ok(result.includes('Tiếng Việt'));
    });

    it('formats forbidden with KHÔNG prefix', () => {
        const result = extractRulesForInject({ forbidden: 'no any; no eval' });
        assert.ok(result.includes('**KHÔNG:** no any'));
        assert.ok(result.includes('**KHÔNG:** no eval'));
    });

    it('returns empty string when no rules', () => {
        assert.equal(extractRulesForInject({}), '');
    });

    it('combines all rule types', () => {
        const result = extractRulesForInject({
            language: 'English',
            codingStyle: 'camelCase',
            forbidden: 'no var',
            custom: 'use pnpm',
        });
        const lines = result.split('\n');
        assert.equal(lines.length, 4);
    });
});

// ─── createManifest ──────────────────────────────────────────────────────────

describe('createManifest', () => {
    it('returns correct default structure', () => {
        const m = createManifest();
        const PKG = require(path.join(__dirname, '..', 'package.json'));
        assert.equal(m.version, PKG.version);
        assert.equal(m.configFile, null);
        assert.ok(Array.isArray(m.skills.external));
        assert.equal(m.skills.external.length, 0);
    });

    it('returns a new object each call', () => {
        const a = createManifest();
        const b = createManifest();
        assert.notEqual(a, b);
        a.configFile = 'test';
        assert.equal(b.configFile, null);
    });
});

// ─── getAgentFlags ───────────────────────────────────────────────────────────

describe('getAgentFlags', () => {
    it('returns correct flags for claudecode', () => {
        assert.equal(getAgentFlags({ ide: 'claudecode' }), '--agent claude-code');
    });

    it('returns correct flags for codex', () => {
        assert.equal(getAgentFlags({ ide: 'codex' }), '--agent codex');
    });

    it('returns correct flags for dual', () => {
        assert.equal(getAgentFlags({ ide: 'dual' }), '--agent claude-code codex');
    });

    it('returns correct flags for agents', () => {
        assert.equal(getAgentFlags({ ide: 'agents' }), '--agent claude-code codex antigravity');
    });

    it('returns empty string for generic', () => {
        assert.equal(getAgentFlags({ ide: 'generic' }), '');
    });
});

// ─── getOverlayNameForTarget — cursor ────────────────────────────────────────

describe('getOverlayNameForTarget — cursor', () => {
    it('returns "cursor" for ide=cursor, target=cursor', () => {
        assert.equal(getOverlayNameForTarget('cursor', 'cursor'), 'cursor');
    });

    it('returns null for ide=claudecode, target=cursor', () => {
        assert.equal(getOverlayNameForTarget('claudecode', 'cursor'), null);
    });

    it('returns null for ide=cursor, target=claude-code', () => {
        assert.equal(getOverlayNameForTarget('cursor', 'claude-code'), null);
    });

    it('returns null for ide=codex, target=cursor', () => {
        assert.equal(getOverlayNameForTarget('codex', 'cursor'), null);
    });
});

// ─── Core template files exist ───────────────────────────────────────────────

describe('Core template files exist', () => {
    const coreFiles = [
        'core/karpathy-mindset.md',
        'core/claudex-hygiene.md',
    ];

    for (const file of coreFiles) {
        it(`${file} exists and is non-empty`, () => {
            const p = path.join(TEMPLATES, file);
            assert.ok(fs.existsSync(p), `${file} should exist`);
            const content = fs.readFileSync(p, 'utf-8');
            assert.ok(content.length > 100, `${file} should have substantial content`);
        });
    }
});

// ─── Base workflow files exist ───────────────────────────────────────────────

describe('Base workflow files exist', () => {
    const expectedWorkflows = [
        'coder-execution.md',
        'debugger-workflow.md',
        'documentation-writer.md',
        'interview-examples.md',
        'knowledge-learn.md',
        'pm-templates.md',
        'qa-testing.md',
        'requirement-analysis.md',
        'skill-manager.md',
        'superpower-sdlc.md',
        'task-planning.md',
        'validation-scripts.md',
    ];

    for (const wf of expectedWorkflows) {
        it(`workflows/${wf} exists`, () => {
            assert.ok(fs.existsSync(path.join(TEMPLATES, 'workflows', wf)));
        });
    }
});

// ─── detectDNA ──────────────────────────────────────────────────────────────

describe('detectDNA', () => {
    it('returns all false for empty project', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dna-test-'));
        try {
            const dna = detectDNA(tmpDir);
            assert.equal(dna.hasUI, false);
            assert.equal(dna.hasBackend, false);
            assert.equal(dna.hasAPI, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects hasUI from React dependency', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dna-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' }
            }));
            const dna = detectDNA(tmpDir);
            assert.equal(dna.hasUI, true);
            assert.equal(dna.hasBackend, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects hasBackend from Express dependency', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dna-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                dependencies: { express: '^4.18.0' }
            }));
            const dna = detectDNA(tmpDir);
            assert.equal(dna.hasBackend, true);
            assert.equal(dna.hasAPI, true);
            assert.equal(dna.hasUI, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects hasBackend from server directory', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dna-test-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'server'));
            const dna = detectDNA(tmpDir);
            assert.equal(dna.hasBackend, true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects hasAPI from routes directory', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dna-test-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'routes'));
            const dna = detectDNA(tmpDir);
            assert.equal(dna.hasAPI, true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects fullstack project (React + Express)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dna-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                dependencies: { react: '^18.0.0', express: '^4.18.0' }
            }));
            const dna = detectDNA(tmpDir);
            assert.equal(dna.hasUI, true);
            assert.equal(dna.hasBackend, true);
            assert.equal(dna.hasAPI, true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
