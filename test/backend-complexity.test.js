const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

// ─── requirement-analysis.md: DNA Classification ────────────────────────────

describe('Backend Complexity — requirement-analysis DNA', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'requirement-analysis.md'), 'utf-8'
    );

    it('contains DNA Profile block', () => {
        assert.ok(content.includes('DNA Profile:'));
    });

    it('defines backendComplexity levels', () => {
        assert.ok(content.includes('backendComplexity'));
        assert.ok(content.includes('simple'));
        assert.ok(content.includes('moderate'));
        assert.ok(content.includes('complex'));
    });

    it('defines hasUI and hasBackend in DNA', () => {
        assert.ok(content.includes('hasUI'));
        assert.ok(content.includes('hasBackend'));
    });

    it('displays DNA in extraction result', () => {
        assert.ok(content.includes('DNA:'));
        assert.ok(content.includes('Backend simple/moderate/complex'));
    });

    it('includes conditional backend probe question', () => {
        assert.ok(content.includes('Backend complexity probe'));
        assert.ok(content.includes('Backend cần xử lý phức tạp đến mức nào'));
    });

    it('DNA classification appears BEFORE adaptive questions', () => {
        const dnaIndex = content.indexOf('DNA Profile:');
        const questionsIndex = content.indexOf('### Step 2: Adaptive Questions');
        assert.ok(dnaIndex < questionsIndex, 'DNA must appear before Step 2');
    });
});

// ─── interview-examples.md: Backend-Aware Probing ───────────────────────────

describe('Backend Complexity — interview-examples probing', () => {
    const examples = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'interview-examples.md'), 'utf-8'
    );
    const mainContent = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'requirement-analysis.md'), 'utf-8'
    );

    it('main workflow references interview-examples.md', () => {
        assert.ok(mainContent.includes('interview-examples.md'));
    });

    it('features slot has backend probe guidance', () => {
        assert.ok(examples.includes('backendComplexity ≥ moderate'), 'should reference backendComplexity threshold');
        assert.ok(examples.includes('realtime') && examples.includes('background'));
    });

    it('constraints slot has backend probe guidance', () => {
        assert.ok(examples.includes('data consistency'));
        assert.ok(examples.includes('concurrent connections'));
    });

    it('edge_cases slot has backend probe guidance', () => {
        assert.ok(examples.includes('dead letter queue'));
        assert.ok(examples.includes('migration strategy') || examples.includes('Data migration strategy'));
    });
});

// ─── requirement-analysis.md: Design Spec Output ────────────────────────────

describe('Backend Complexity — requirement-analysis spec output', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'requirement-analysis.md'), 'utf-8'
    );

    it('Summary table includes Backend DNA row', () => {
        assert.ok(content.includes('Backend DNA'));
    });

    it('includes [infra] in available tags list', () => {
        assert.ok(content.includes('`[infra]`'));
    });

    it('has Infrastructure section in requirements template', () => {
        assert.ok(content.includes('### Infrastructure'));
        assert.ok(content.includes('[infra]'));
    });

    it('Spec Self-Review includes backend coherence check', () => {
        assert.ok(content.includes('Backend coherence'));
        assert.ok(content.includes('serverless'));
    });

    it('[infra] rules specify pattern and scaling behavior', () => {
        assert.ok(content.includes('scaling') || content.includes('failure behavior'));
    });
});

// ─── skill-manager.md: Conditional Mandatory Groups ─────────────────────────

describe('Backend Complexity — skill-manager conditional groups', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'skill-manager.md'), 'utf-8'
    );

    it('references DNA Profile in Step 2', () => {
        assert.ok(content.includes('DNA Profile') || content.includes('DNA'));
        assert.ok(content.includes('backendComplexity'));
    });

    it('has conditional mandatory groups (not fixed 2)', () => {
        assert.ok(content.includes('Conditional Mandatory Skill Groups'));
    });

    it('Best Practices group is always mandatory', () => {
        assert.ok(content.includes('Always'));
    });

    it('UI/UX/Frontend group is conditional on hasUI', () => {
        assert.ok(content.includes('hasUI'));
    });

    it('Backend/Infrastructure group exists', () => {
        assert.ok(content.includes('Backend/Infrastructure'));
    });

    it('Backend/Infrastructure is conditional on backendComplexity', () => {
        const backendGroupLine = content.split('\n').find(
            line => line.includes('Backend/Infrastructure') && line.includes('moderate')
        );
        assert.ok(backendGroupLine, 'Backend/Infrastructure group should be conditional on moderate+');
    });

    it('describes open-ended backend keyword generation', () => {
        assert.ok(content.includes('keyword generation') || content.includes('Backend keyword generation'));
        assert.ok(content.includes('no hardcoded keyword list') || content.includes('open-ended'));
    });

    it('proposal display includes DNA profile', () => {
        assert.ok(content.includes('DNA: [profile]'));
    });

    it('proposal display shows Backend/Infrastructure group', () => {
        assert.ok(content.includes('Backend/Infrastructure'));
    });
});

// ─── task-planning.md: Backend-Aware Planning ───────────────────────────────

describe('Backend Complexity — task-planning backend awareness', () => {
    const content = fs.readFileSync(
        path.join(TEMPLATES, 'workflows', 'task-planning.md'), 'utf-8'
    );

    it('includes [infra] in tag list', () => {
        assert.ok(content.includes('`[infra]`'));
    });

    it('has [infra] component mapping', () => {
        assert.ok(content.includes('[infra]'));
        assert.ok(content.includes('Infrastructure layer'));
    });

    it('has extended dependency ordering with Cache and Queue', () => {
        assert.ok(content.includes('Cache'));
        assert.ok(content.includes('Queue/Worker'));
        assert.ok(content.includes('Realtime'));
    });

    it('extended ordering places DB before Cache before API', () => {
        assert.ok(
            content.includes('DB → Cache → Queue/Worker → API → Realtime → UI'),
            'Should have full extended ordering chain'
        );
    });

    it('describes flexible [infra] task classification', () => {
        assert.ok(content.includes('[infra]') && content.includes('setup.sh'));
        assert.ok(content.includes('worker logic') || content.includes('event handlers'));
    });
});
