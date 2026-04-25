const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── Evidence-Based Testing (qa-testing.md) ─────────────────────────────────

describe('Evidence-Based Testing — qa-testing.md', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'qa-testing.md'), 'utf-8'
    );

    it('requires shell command for each P0-P3 check', () => {
        assert.ok(content.includes('MUST run a shell command for each P0-P3'));
    });

    it('rejects "code looks correct" as verification', () => {
        assert.ok(content.includes('"Code looks correct" is NOT verification'));
    });

    it('mandates quiet flags to minimize output', () => {
        assert.ok(content.includes('--silent'));
        assert.ok(content.includes('-q'));
        assert.ok(content.includes('--quiet'));
    });

    it('report template includes CLI command per pipeline check', () => {
        assert.ok(content.includes('ran: `npm audit'));
        assert.ok(content.includes('ran: `npm run lint'));
        assert.ok(content.includes('ran: `npm run build'));
        assert.ok(content.includes('ran: `npm test'));
    });

    it('PASS lines are 1 line only — no command output', () => {
        assert.ok(content.includes('PASS lines: 1 line only. Do NOT paste command output'));
    });

    it('FAIL lines require 1-line error summary', () => {
        assert.ok(content.includes('FAIL lines: add 1-line error summary'));
    });

    it('Feature verification Method must be concrete action', () => {
        assert.ok(content.includes('must be a concrete action'));
        assert.ok(content.includes('not "read code"'));
    });

    it('has "No command = No PASS" rule', () => {
        assert.ok(content.includes('No command = No PASS'));
    });

    it('has "Quiet execution" rule', () => {
        assert.ok(content.includes('Quiet execution'));
    });
});

// ─── Circuit Breaker [BLOCKED] tag ──────────────────────────────────────────

describe('Circuit Breaker [BLOCKED] — qa-testing.md', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'qa-testing.md'), 'utf-8'
    );

    it('marks failing task as [BLOCKED] in todo.md', () => {
        assert.ok(content.includes('[BLOCKED]'));
        assert.ok(content.includes('Mark the failing task as'));
    });

    it('escalation message includes what was tried', () => {
        assert.ok(content.includes('Tried: 1)'));
    });

    it('has [BLOCKED] protocol in rules', () => {
        assert.ok(content.includes('[BLOCKED] protocol'));
        assert.ok(content.includes('Do NOT continue fixing it'));
    });
});

describe('Circuit Breaker [BLOCKED] — coder-execution.md (base)', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
        assert.ok(content.includes('mark failing task'));
    });

    it('skips [BLOCKED] tasks', () => {
        assert.ok(content.includes('marked `[BLOCKED]`, SKIP'));
    });
});

describe('Circuit Breaker [BLOCKED] — claude-code overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
    });

    it('skips [BLOCKED] tasks', () => {
        assert.ok(content.includes('`[BLOCKED]`, move it'));
    });
});

describe('Circuit Breaker [BLOCKED] — codex overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
    });

    it('has skip rule for [BLOCKED] tasks', () => {
        assert.ok(content.includes('Skip tasks marked `[BLOCKED]`'));
    });
});

describe('Circuit Breaker [BLOCKED] — gemini overlay', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'overlays', 'gemini', 'workflows', 'coder-execution.md'), 'utf-8'
    );

    it('quality gate marks [BLOCKED] on max attempts', () => {
        assert.ok(content.includes('[BLOCKED]'));
    });

    it('updates tracker with BLOCKED status', () => {
        assert.ok(content.includes('tracker_update_task'));
        assert.ok(content.includes('BLOCKED'));
    });
});

// ─── Surgical Scope (coder-execution — all variants) ────────────────────────

describe('Surgical Scope — git clean check + scope lock', () => {
    const variants = [
        { name: 'base', path: path.join(TEMPLATES, 'workflows', 'coder-execution.md') },
        { name: 'claude-code', path: path.join(TEMPLATES, 'overlays', 'claude-code', 'workflows', 'coder-execution.md') },
        { name: 'codex', path: path.join(TEMPLATES, 'overlays', 'codex', 'workflows', 'coder-execution.md') },
        { name: 'gemini', path: path.join(TEMPLATES, 'overlays', 'gemini', 'workflows', 'coder-execution.md') },
    ];

    for (const v of variants) {
        const content = fs.readFileSync(v.path, 'utf-8');

        it(`${v.name}: requires git diff --stat before editing`, () => {
            assert.ok(content.includes('git diff --stat'));
        });

        it(`${v.name}: has scope lock — no refactoring`, () => {
            assert.ok(
                content.includes('no cleanup, no refactoring') || content.includes('No cleanup, no refactoring') ||
                content.includes('Zero exceptions — no cleanup, no refactoring')
            );
        });
    }
});

// ─── Hypotheses step (debugger-workflow.md) ──────────────────────────────────

describe('Systematic Debugging — hypotheses step', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'debugger-workflow.md'), 'utf-8'
    );

    it('has Step 3.5: Hypotheses as REQUIRED', () => {
        assert.ok(content.includes('Step 3.5: Hypotheses (REQUIRED'));
    });

    it('requires listing 2-3 hypotheses before fixing', () => {
        assert.ok(content.includes('list 2-3 possible root causes'));
    });

    it('has hypothesis output format', () => {
        assert.ok(content.includes('🔍 Hypotheses:'));
        assert.ok(content.includes('Testing: #'));
    });

    it('blocks fixing until hypotheses are written', () => {
        assert.ok(content.includes('Do NOT fix anything until'));
    });

    it('Step 4 references chosen hypothesis', () => {
        assert.ok(content.includes('identified in your chosen hypothesis'));
    });

    it('failed fix returns to hypotheses, not shotgun', () => {
        assert.ok(content.includes('return to Step 3.5 and test the next hypothesis'));
    });

    it('hypotheses step appears BEFORE Step 4', () => {
        const hypIndex = content.indexOf('Step 3.5: Hypotheses');
        const fixIndex = content.indexOf('Step 4: Apply Surgical Fix');
        assert.ok(hypIndex < fixIndex);
    });
});

// ─── Knowledge Base (>om:learn) ─────────────────────────────────────────────

describe('Knowledge Base — knowledge-learn.md workflow', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'knowledge-learn.md'), 'utf-8'
    );

    it('analyzes git diff for recent fix', () => {
        assert.ok(content.includes('git diff'));
    });

    it('evaluates if fix is worth recording', () => {
        assert.ok(content.includes('trivial'));
        assert.ok(content.includes('Skip recording'));
    });

    it('has entry format with Scope, Pattern, Fix', () => {
        assert.ok(content.includes('**Scope:**'));
        assert.ok(content.includes('**Pattern:**'));
        assert.ok(content.includes('**Fix:**'));
    });

    it('enforces max 20 entries', () => {
        assert.ok(content.includes('Max 20'));
        assert.ok(content.includes('remove the oldest'));
    });

    it('creates knowledge-base.md if not exists', () => {
        assert.ok(content.includes('does not exist, create it'));
    });
});

describe('Knowledge Base — auto-trigger from >om:fix', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'debugger-workflow.md'), 'utf-8'
    );

    it('has Step 6: Auto-Learn after verified fix', () => {
        assert.ok(content.includes('Step 6: Auto-Learn'));
    });

    it('triggers >om:learn workflow automatically', () => {
        assert.ok(content.includes('execute the [>om:learn] workflow'));
    });

    it('only triggers on PASS (not on failed fix)', () => {
        assert.ok(content.includes('no learn — nothing to record yet'));
    });
});

describe('Knowledge Base — read in cook and fix', () => {
    const cook = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'coder-execution.md'), 'utf-8'
    );
    const fix = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'debugger-workflow.md'), 'utf-8'
    );

    it('cook Step 1 reads knowledge-base.md', () => {
        assert.ok(cook.includes('knowledge-base.md'));
        assert.ok(cook.includes('scan it for entries matching'));
    });

    it('fix Step 1 reads knowledge-base.md', () => {
        assert.ok(fix.includes('knowledge-base.md'));
        assert.ok(fix.includes('matches a known pattern'));
    });
});

describe('Knowledge Base — command registry includes >om:learn', () => {
    const omniJs = fs.readFileSync(
        path.join(__dirname, '..', 'bin', 'omni.js'), 'utf-8'
    );

    it('Claude Code registry has >om:learn', () => {
        assert.ok(omniJs.includes("'| `>om:learn` | `/om:learn`"));
    });

    it('Gemini registry has >om:learn', () => {
        assert.ok(omniJs.includes("'| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Main session | `save_memory`"));
    });

    it('generic registry has >om:learn', () => {
        assert.ok(omniJs.includes("'| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner |'"));
    });
});

describe('Knowledge Base — Claude Code slash command', () => {
    const cmdPath = path.join(TEMPLATES, 'overlays', 'claude-code', 'commands', 'om:learn.md');

    it('om:learn.md slash command exists', () => {
        assert.ok(fs.existsSync(cmdPath));
    });

    it('references knowledge-learn.md workflow', () => {
        const content = fs.readFileSync(cmdPath, 'utf-8');
        assert.ok(content.includes('knowledge-learn.md'));
    });
});
