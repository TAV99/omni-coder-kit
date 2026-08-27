'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_DIR = path.join(__dirname, '..', 'templates', 'workflows');
const PLANNING_PATH = path.join(WORKFLOW_DIR, 'task-planning.md');
const CODER_PATH = path.join(WORKFLOW_DIR, 'coder-execution.md');
const SKILL_MGR_PATH = path.join(WORKFLOW_DIR, 'skill-manager.md');
const DUAL_SKILL_PATH = path.join(__dirname, '..', 'templates', 'codex-gemini', 'SKILL.md');

function readNormalized(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.replace(/\r\n/g, '\n');
}

describe('Workflow Command & Setup Contracts (Task 7B)', () => {
    const planning = readNormalized(PLANNING_PATH);
    const coder = readNormalized(CODER_PATH);
    const skillMgr = readNormalized(SKILL_MGR_PATH);
    const allTemplates = [
        { name: 'task-planning.md', content: planning },
        { name: 'coder-execution.md', content: coder },
        { name: 'skill-manager.md', content: skillMgr },
    ];

    describe('1. Global Stale Pattern Scans', () => {
        for (const { name, content } of allTemplates) {
            test(`${name}: contains no setup.sh reference`, () => {
                assert.equal(
                    content.includes('setup.sh'),
                    false,
                    `${name} must not contain references to setup.sh`
                );
            });

            test(`${name}: contains no bash setup.sh invocation`, () => {
                assert.equal(
                    /bash\s+setup\.sh/i.test(content),
                    false,
                    `${name} must not contain bash setup.sh`
                );
            });

            test(`${name}: contains no obsolete omni auto-equip command`, () => {
                assert.equal(
                    content.includes('omni auto-equip'),
                    false,
                    `${name} must not contain omni auto-equip`
                );
            });

            test(`${name}: contains no legacy bare omni equip command`, () => {
                // Must use `omni skills add ...` instead of `omni equip ...`
                const bareEquipMatch = content.match(/\bomni\s+equip\b(?!\s+add)/g);
                assert.equal(
                    bareEquipMatch,
                    null,
                    `${name} must not contain bare 'omni equip' commands: ${JSON.stringify(bareEquipMatch)}`
                );
            });
        }
    });

    describe('2. Task Planning Workflow (.omni/sdlc/setup.json & typed actions)', () => {
        test('specifies .omni/sdlc/setup.json path and omni dual setup run', () => {
            assert.ok(
                planning.includes('.omni/sdlc/setup.json'),
                'task-planning.md must reference .omni/sdlc/setup.json'
            );
            assert.ok(
                planning.includes('omni dual setup run'),
                'task-planning.md must reference omni dual setup run'
            );
        });

        test('includes versioned envelope { schema_version: 1, actions: [...] }', () => {
            assert.ok(
                planning.includes('"schema_version": 1') || planning.includes('"schema_version":1'),
                'task-planning.md must include schema_version: 1'
            );
            assert.ok(
                planning.includes('"actions"') || planning.includes('actions'),
                'task-planning.md must include actions list in envelope'
            );
        });

        test('defines typed action schema fields (kind, program, args, cwd)', () => {
            assert.ok(planning.includes('"kind"'), 'task-planning.md must document action field "kind"');
            assert.ok(planning.includes('"program"'), 'task-planning.md must document action field "program"');
            assert.ok(planning.includes('"args"'), 'task-planning.md must document action field "args"');
            assert.ok(planning.includes('"cwd"'), 'task-planning.md must document action field "cwd"');
        });

        test('guides kind: package-manager with program: auto and typed kinds', () => {
            assert.ok(
                planning.includes('package-manager'),
                'task-planning.md must document package-manager kind'
            );
            assert.ok(
                planning.includes('auto'),
                'task-planning.md must document program: auto for package-manager lockfile detection'
            );
            assert.ok(
                planning.includes('native'),
                'task-planning.md must document native kind'
            );
            assert.ok(
                planning.includes('node-cli'),
                'task-planning.md must document node-cli kind'
            );
        });

        test('documents shell:false semantics and rejects shell operators/strings', () => {
            assert.ok(
                /shell:\s*false/i.test(planning) || /shell\s*=\s*false/i.test(planning) || /shell\s+false/i.test(planning) || /no\s+shell/i.test(planning) || /without\s+shell/i.test(planning),
                'task-planning.md must explain shell: false / direct process execution semantics'
            );
        });

        test('guides unsafe/unrepresentable infrastructure to blockers or code tasks rather than shell actions', () => {
            assert.ok(
                /blocker|manual|code task|unrepresentable|destructive/i.test(planning),
                'task-planning.md must handle unsafe infrastructure as manual/blocker/code tasks'
            );
        });

        test('instructs auto-continue on setup success and fail-closed stop on failure without shell fallback', () => {
            assert.ok(
                /auto-continue|automatically continue|continue automatically/i.test(planning),
                'task-planning.md must instruct automatic continuation on setup success'
            );
            assert.ok(
                /fail-closed|stop safely|never fall back to shell|no shell fallback/i.test(planning),
                'task-planning.md must enforce fail-closed failure handling without shell fallback'
            );
        });

        test('self-heals only native package-manager kind mismatches and requires a SUCCESS receipt', () => {
            assert.match(planning, /native.*package-manager.*repair|repair.*native.*package-manager/is);
            assert.match(planning, /SUCCESS receipt/i);
            assert.match(planning, /ambiguous|security/i);
        });
    });

    describe('3. Coder Execution Workflow (Preflight & Dirty Tree Safety)', () => {
        test('calls omni dual setup run if .omni/sdlc/setup.json exists', () => {
            assert.ok(
                coder.includes('.omni/sdlc/setup.json'),
                'coder-execution.md must reference .omni/sdlc/setup.json'
            );
            assert.ok(
                coder.includes('omni dual setup run'),
                'coder-execution.md must reference omni dual setup run'
            );
        });

        test('prohibits ad-hoc dependency installation in dev server preflight', () => {
            assert.equal(
                /install dependencies if missing/i.test(coder),
                false,
                'coder-execution.md must not instruct ad-hoc "install dependencies if missing"'
            );
        });

        test('enforces manifest-only dependencies and fail-closed blocker for undeclared missing dependencies', () => {
            assert.ok(
                /never install.*(?:missing )?dependencies ad[- ]?hoc|do not install.*(?:missing )?dependencies ad[- ]?hoc/i.test(coder),
                'coder-execution.md must explicitly prohibit ad-hoc dependency installation'
            );
            assert.ok(
                /fail-closed/i.test(coder) && /blocker/i.test(coder),
                'coder-execution.md must instruct fail-closed blocker on undeclared missing dependencies'
            );
            assert.ok(
                /do not guess|never guess|not guess/i.test(coder),
                'coder-execution.md must prohibit guessing package managers'
            );
        });

        test('does not mandate automatic git commit/stash on dirty tree', () => {
            // Must not instruct agent to blindly run git commit / git stash automatically
            assert.equal(
                /commit or stash first/i.test(coder),
                false,
                'coder-execution.md must not instruct automatic commit or stash of dirty worktrees'
            );
        });

        test('requires both setup receipt and active Dual authority before source edits', () => {
            assert.match(coder, /SUCCESS receipt/i);
            assert.match(coder, /active Dual (?:session|authority)/i);
            assert.match(coder, /before.*source edit|source edit.*before/i);
        });
    });

    describe('4. Skill Manager Workflow (Canonical CLI Migration)', () => {
        test('uses canonical omni skills -y for universal skills', () => {
            assert.ok(
                skillMgr.includes('omni skills -y'),
                'skill-manager.md must use omni skills -y'
            );
        });

        test('uses canonical omni skills for interactive/terminal execution', () => {
            assert.ok(
                skillMgr.includes('omni skills\n') || skillMgr.includes('omni skills ') || skillMgr.includes('`omni skills`'),
                'skill-manager.md must use canonical omni skills'
            );
        });

        test('uses canonical omni skills add for individual skill installation', () => {
            assert.ok(
                skillMgr.includes('omni skills add'),
                'skill-manager.md must use omni skills add <source>'
            );
        });
    });

    describe('5. Dual Token Economy & Phase Isolation', () => {
        const dualSkill = readNormalized(DUAL_SKILL_PATH);

        test('keeps Codex on semantic artifacts and reserves raw attempts for failures', () => {
            assert.match(dualSkill, /semantic artifacts first/i);
            assert.match(dualSkill, /raw stdout\/stderr only/i);
        });

        test('forbids Codex source, build, or browser writes until the AGY lease is released', () => {
            assert.match(dualSkill, /no source, build, or browser writes/i);
            assert.match(dualSkill, /AGY lease is released/i);
        });

        test('uses one typed bootstrap controller after planning and forbids temporary bootstrap tasks', () => {
            assert.match(dualSkill, /design.*skill.*dual-plan\.json.*omni dual bootstrap --json/is);
            assert.match(dualSkill, /Never create a temporary `bootstrap-plan-artifacts`/i);
            assert.match(dualSkill, /never call `omni_dual_begin`\/`omni_dual_register_plan` directly/i);
        });

        test('defines fail-closed legacy adoption without deleting ledgers', () => {
            assert.match(dualSkill, /legacy planning-only session/i);
            assert.match(dualSkill, /fails closed/i);
            assert.doesNotMatch(dualSkill, /rm\s+-rf|Remove-Item/i);
        });
    });
});
