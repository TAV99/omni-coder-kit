# Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 issues — file size guard, rules sync corrupt detection, init God Function extraction, --dry-run preview mode

**Architecture:** Tasks 1-3 are independent. Task 4 depends on Tasks 2+3. Each task adds tests first (TDD), then implementation, then integration.

**Tech Stack:** Node.js, CommonJS, `node:test` + `node:assert/strict`, `fs.statSync`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `lib/scanner/constants.js` | Add `MAX_FILE_SIZE` constant (Task 1) |
| `lib/scanner/scan.js` | Size guard in `countLOC()` (Task 1) |
| `lib/scanner/landmines.js` | Size guard in `grepLandmines()` (Task 1) |
| `test/scanner/landmines.test.js` | Add size guard test (Task 1) |
| `lib/rules/sync.js` | Marker integrity check, `dryRun` option (Tasks 2+4) |
| `test/rules.test.js` | Corrupt marker + dryRun tests (Tasks 2+4) |
| `bin/omni.js` | Handle `'corrupt'` return, `--dry-run` flag, delegate init to strategies (Tasks 2+3+4) |
| `lib/init/strategies.js` | `buildInitConfig()` + per-IDE builders + 8 helper functions (Task 3) |
| `lib/init/index.js` | Re-export `buildInitConfig` (Task 3) |
| `test/init.test.js` | Strategy output tests (Task 3) |

---

### Task 1: MAX_FILE_SIZE Guard

**Files:**
- Modify: `lib/scanner/constants.js`
- Modify: `lib/scanner/scan.js:37-48` (countLOC)
- Modify: `lib/scanner/landmines.js:10-39` (grepLandmines)
- Modify: `test/scanner/landmines.test.js`

- [ ] **Step 1: Add MAX_FILE_SIZE constant**

In `lib/scanner/constants.js`, add after line 21 (`const MAX_LANDMINES = 50;`):

```js
const MAX_FILE_SIZE = 1 * 1024 * 1024;
```

Update the `module.exports` to include `MAX_FILE_SIZE`:

```js
module.exports = { IGNORED_DIRS, MANIFEST_FILES, MAX_DEPTH, MAX_LANDMINES, MAX_FILE_SIZE, SOURCE_EXTENSIONS };
```

- [ ] **Step 2: Write the failing test**

Append to `test/scanner/landmines.test.js`, inside the `grepLandmines` describe block (after the "truncates text at 120 characters" test, before the closing `});` of the describe):

```js
    test('skips files larger than MAX_FILE_SIZE (1MB)', () => {
        const bigContent = '// TODO: should be skipped\n' + 'x'.repeat(1.5 * 1024 * 1024);
        fs.writeFileSync(path.join(tmpDir, 'huge.js'), bigContent);
        const result = grepLandmines(tmpDir, ['huge.js']);
        assert.equal(result.length, 0, 'large files should be silently skipped');
    });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/scanner/landmines.test.js`

Expected: The new test FAILS — `grepLandmines` currently reads all files regardless of size, so it finds the TODO in `huge.js` and returns 1 result.

- [ ] **Step 4: Add size guard to countLOC in scan.js**

In `lib/scanner/scan.js`, update the import on line 5:

```js
const { IGNORED_DIRS, SOURCE_EXTENSIONS, MAX_DEPTH, MAX_FILE_SIZE } = require('./constants');
```

Replace the `countLOC` function (lines 37-48):

```js
function countLOC(dir, allFiles) {
    let loc = 0;
    for (const rel of allFiles) {
        const ext = path.extname(rel);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const fullPath = path.join(dir, rel);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }
        try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            loc += content.split('\n').length;
        } catch {}
    }
    return loc;
}
```

- [ ] **Step 5: Add size guard to grepLandmines in landmines.js**

In `lib/scanner/landmines.js`, update the import on line 5:

```js
const { MAX_LANDMINES, SOURCE_EXTENSIONS, MAX_FILE_SIZE } = require('./constants');
```

In the `grepLandmines` function, add the size check right after the `SOURCE_EXTENSIONS` check (after `if (!SOURCE_EXTENSIONS.has(ext)) continue;` on line 16). Insert:

```js
        const fullPath = path.join(dir, rel);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }
```

And update the `readFileSync` call on line 18 to use `fullPath` instead of `path.join(dir, rel)`:

```js
            const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/scanner/landmines.test.js`

Expected: ALL tests pass including the new "skips files larger than MAX_FILE_SIZE" test.

- [ ] **Step 7: Run full test suite**

Run: `node --test test/*.test.js test/**/*.test.js`

Expected: All tests pass (no regressions).

- [ ] **Step 8: Commit**

```bash
git add lib/scanner/constants.js lib/scanner/scan.js lib/scanner/landmines.js test/scanner/landmines.test.js
git commit -m "fix: add MAX_FILE_SIZE guard to countLOC and grepLandmines (skip >1MB files)"
```

---

### Task 2: Rules Sync Marker Integrity Check

**Files:**
- Modify: `lib/rules/sync.js`
- Modify: `test/rules.test.js`
- Modify: `bin/omni.js:1380,1397` (handle `'corrupt'` return)

- [ ] **Step 1: Write the failing tests**

Append to `test/rules.test.js` (after the last `syncRulesToConfig` test):

```js
test('syncRulesToConfig: returns corrupt when only start marker present', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config\n\n<!-- omni:rules -->\nold rules here\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n', 'utf-8');

    const original = fs.readFileSync(claudePath, 'utf-8');
    const result = syncRulesToConfig(() => 'CLAUDE.md', dir);
    assert.equal(result, 'corrupt');

    const after = fs.readFileSync(claudePath, 'utf-8');
    assert.equal(after, original, 'file should not be modified when corrupt');
});

test('syncRulesToConfig: returns corrupt when only end marker present', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config\n\n<!-- /omni:rules -->\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n', 'utf-8');

    const original = fs.readFileSync(claudePath, 'utf-8');
    const result = syncRulesToConfig(() => 'CLAUDE.md', dir);
    assert.equal(result, 'corrupt');

    const after = fs.readFileSync(claudePath, 'utf-8');
    assert.equal(after, original, 'file should not be modified when corrupt');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/rules.test.js`

Expected: The 2 new tests FAIL — currently `syncRulesToConfig` doesn't check marker integrity and either replaces or appends.

- [ ] **Step 3: Implement marker integrity check**

Replace the entire `syncRulesToConfig` function in `lib/rules/sync.js`:

```js
function syncRulesToConfig(findConfigFileFn, projectDir) {
    const configFile = findConfigFileFn();
    if (!configFile) return false;
    const configPath = path.join(projectDir, configFile);
    const rulesPath = path.join(projectDir, RULES_FILE);
    if (!fs.existsSync(rulesPath)) return false;

    const rulesRaw = fs.readFileSync(rulesPath, 'utf-8');
    const lines = rulesRaw.split('\n').filter(l => l.startsWith('- ')).join('\n');
    if (!lines) return false;

    let config = fs.readFileSync(configPath, 'utf-8');
    const startMarker = '<!-- omni:rules -->';
    const endMarker = '<!-- /omni:rules -->';

    const hasStart = config.includes(startMarker);
    const hasEnd = config.includes(endMarker);
    if (hasStart !== hasEnd) return 'corrupt';

    const injection = `${startMarker}\n## PERSONAL RULES\n${lines}\n${endMarker}`;

    if (hasStart && hasEnd) {
        const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
        config = config.replace(regex, injection);
    } else {
        config += `\n\n${injection}\n`;
    }
    fs.writeFileSync(configPath, config, 'utf-8');
    return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/rules.test.js`

Expected: ALL tests pass including the 2 new "corrupt" tests.

- [ ] **Step 5: Update bin/omni.js call sites to handle 'corrupt'**

In `bin/omni.js`, find line ~1380 (inside the `edit` action):

```js
            if (configFile && syncRulesToConfig(findConfigFile, process.cwd())) {
                console.log(chalk.green(`   ✅ Đã sync vào ${configFile}\n`));
            } else if (configFile) {
                console.log(chalk.yellow(`   ⚠️  Không thể sync vào ${configFile}. Chạy ${chalk.cyan('omni rules sync')} thủ công.\n`));
            }
```

Replace with:

```js
            if (configFile) {
                const syncResult = syncRulesToConfig(findConfigFile, process.cwd());
                if (syncResult === 'corrupt') {
                    console.log(chalk.red(`   ⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công rồi chạy ${chalk.cyan('omni rules sync')}.\n`));
                } else if (syncResult) {
                    console.log(chalk.green(`   ✅ Đã sync vào ${configFile}\n`));
                } else {
                    console.log(chalk.yellow(`   ⚠️  Không thể sync vào ${configFile}. Chạy ${chalk.cyan('omni rules sync')} thủ công.\n`));
                }
            }
```

Find line ~1397 (inside the `sync` action):

```js
            if (syncRulesToConfig(findConfigFile, process.cwd())) {
                console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
            } else {
                console.log(chalk.red('\n❌ Sync thất bại.\n'));
            }
```

Replace with:

```js
            const syncResult = syncRulesToConfig(findConfigFile, process.cwd());
            if (syncResult === 'corrupt') {
                console.log(chalk.red(`\n⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công trước khi sync.\n`));
            } else if (syncResult) {
                console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
            } else {
                console.log(chalk.red('\n❌ Sync thất bại.\n'));
            }
```

- [ ] **Step 6: Run full test suite**

Run: `node --test test/*.test.js test/**/*.test.js`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/rules/sync.js test/rules.test.js bin/omni.js
git commit -m "fix: detect corrupt markers in rules sync — return 'corrupt' instead of duplicating"
```

---

### Task 3: Extract Init Strategies

**Files:**
- Create: `lib/init/strategies.js`
- Create: `lib/init/index.js`
- Create: `test/init.test.js`
- Modify: `bin/omni.js`

This is the largest task. It moves 8 config-generation functions from `bin/omni.js` into `lib/init/strategies.js`, then refactors the init handler to call `buildInitConfig()` and loop over the returned file list.

- [ ] **Step 1: Write the tests**

Create `test/init.test.js`:

```js
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildInitConfig } = require('../lib/init');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-init-test-'));
}

describe('buildInitConfig', () => {
    const baseOpts = {
        strictness: 'hardcore',
        parsedRules: { language: 'Tiếng Việt', codingStyle: ['camelCase'], forbidden: ['any'], custom: [] },
        rulesContent: '# Personal Rules\n',
        projectDir: '/tmp/fake-project',
        dnaProfile: { hasUI: false, hasBackend: false, hasAPI: false },
    };

    test('claudecode: returns CLAUDE.md as main config file', () => {
        const config = buildInitConfig('claudecode', baseOpts);
        assert.ok(config.files.length > 0, 'should return at least one file');
        const mainFile = config.files.find(f => f.path === 'CLAUDE.md');
        assert.ok(mainFile, 'should include CLAUDE.md');
        assert.equal(mainFile.overwritePrompt, true);
        assert.ok(mainFile.content.includes('Generated by Omni-Coder Kit'));
        assert.ok(mainFile.content.includes('PERSONAL RULES'));
    });

    test('codex: returns AGENTS.md as main config file', () => {
        const config = buildInitConfig('codex', baseOpts);
        const mainFile = config.files.find(f => f.path === 'AGENTS.md');
        assert.ok(mainFile, 'should include AGENTS.md');
        assert.ok(mainFile.content.includes('Generated by Omni-Coder Kit'));
    });

    test('gemini: returns GEMINI.md as main config file', () => {
        const config = buildInitConfig('gemini', baseOpts);
        const mainFile = config.files.find(f => f.path === 'GEMINI.md');
        assert.ok(mainFile, 'should include GEMINI.md');
    });

    test('dual: returns both CLAUDE.md and AGENTS.md', () => {
        const config = buildInitConfig('dual', baseOpts);
        const claude = config.files.find(f => f.path === 'CLAUDE.md');
        const agents = config.files.find(f => f.path === 'AGENTS.md');
        assert.ok(claude, 'should include CLAUDE.md');
        assert.ok(agents, 'should include AGENTS.md');
    });

    test('cursor: returns .cursorrules as main config file', () => {
        const config = buildInitConfig('cursor', baseOpts);
        const mainFile = config.files.find(f => f.path === '.cursorrules');
        assert.ok(mainFile, 'should include .cursorrules');
    });

    test('windsurf: returns .windsurfrules as main config file', () => {
        const config = buildInitConfig('windsurf', baseOpts);
        const mainFile = config.files.find(f => f.path === '.windsurfrules');
        assert.ok(mainFile, 'should include .windsurfrules');
    });

    test('generic: returns SYSTEM_PROMPT.md as main config file', () => {
        const config = buildInitConfig('generic', baseOpts);
        const mainFile = config.files.find(f => f.path === 'SYSTEM_PROMPT.md');
        assert.ok(mainFile, 'should include SYSTEM_PROMPT.md');
    });

    test('returns rules.md when rulesContent is present', () => {
        const config = buildInitConfig('claudecode', baseOpts);
        const rulesFile = config.files.find(f => f.path === path.join('.omni', 'rules.md'));
        assert.ok(rulesFile, 'should include .omni/rules.md');
        assert.equal(rulesFile.overwritePrompt, false);
    });

    test('does not return rules.md when rulesContent is null', () => {
        const config = buildInitConfig('claudecode', { ...baseOpts, rulesContent: null });
        const rulesFile = config.files.find(f => f.path === path.join('.omni', 'rules.md'));
        assert.equal(rulesFile, undefined, 'should not include .omni/rules.md');
    });

    test('returns manifest object', () => {
        const config = buildInitConfig('claudecode', baseOpts);
        assert.ok(config.manifest, 'should return manifest');
        assert.equal(config.manifest.configFile, 'CLAUDE.md');
        assert.equal(config.manifest.ide, 'claudecode');
    });

    test('returns dirs array including .omni/workflows', () => {
        const config = buildInitConfig('claudecode', baseOpts);
        assert.ok(Array.isArray(config.dirs));
        assert.ok(config.dirs.includes(path.join('.omni', 'workflows')));
    });

    test('includes workflow copy files', () => {
        const config = buildInitConfig('claudecode', baseOpts);
        const wfFiles = config.files.filter(f => f.path.startsWith(path.join('.omni', 'workflows')));
        assert.ok(wfFiles.length > 0, 'should have workflow files');
        assert.ok(wfFiles.every(f => f.overwritePrompt === false));
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/init.test.js`

Expected: FAIL — `../lib/init` module does not exist.

- [ ] **Step 3: Create lib/init/index.js**

```js
'use strict';

const { buildInitConfig } = require('./strategies');

module.exports = { buildInitConfig };
```

- [ ] **Step 4: Create lib/init/strategies.js**

This file contains `buildInitConfig` and all 8 helper functions moved from `bin/omni.js`. The file uses only `fs`, `path`, and project-internal modules.

```js
'use strict';

const fs = require('fs');
const path = require('path');

const { IDE_CONFIG_FILE, createManifest, getAgentFlags } = require('../helpers');
const { parseRules, formatMarkdown, formatInject } = require('../rules');
const { buildWorkflows, getOverlayDir } = require('../workflows');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

function readTemplate(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        throw new Error(`Không đọc được template ${path.basename(filePath)}: ${err.message}`);
    }
}

function buildCommandRegistry(ide) {
    const isClaudeCode = ide === 'claudecode' || ide === 'dual';
    const isCodex = ide === 'codex';
    const isGemini = ide === 'gemini';

    if (isClaudeCode) {
        return [
            '## WORKFLOW COMMANDS',
            '> Claude Code: dung `/om:*` slash commands (auto-complete) hoac `>om:*` trong chat.',
            '',
            'When the user invokes a `>om:` command or `/om:` slash command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Slash | Agent Strategy | Workflow File |',
            '|---------|-------|---------------|---------------|',
            '| `>om:brainstorm` | `/om:brainstorm` | Main session | `.omni/workflows/requirement-analysis.md` |',
            '| `>om:equip` | `/om:equip` | Main session | `.omni/workflows/skill-manager.md` |',
            '| `>om:plan` | `/om:plan` | Main session | `.omni/workflows/task-planning.md` |',
            '| `>om:cook` | `/om:cook` | Main -> sub-agents (parallel) | `.omni/workflows/coder-execution.md` |',
            '| `>om:check` | `/om:check` | Main session | `.omni/workflows/qa-testing.md` |',
            '| `>om:fix` | `/om:fix` | Main session | `.omni/workflows/debugger-workflow.md` |',
            '| `>om:doc` | `/om:doc` | Main session | `.omni/workflows/documentation-writer.md` |',
            '| `>om:learn` | `/om:learn` | Main session | `.omni/workflows/knowledge-learn.md` |',
            '| `>om:map` | `/om:map` | Architect | `.omni/workflows/project-map.md` |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Full SDLC overview and pipeline diagram',
            '- `.omni/knowledge/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (isGemini) {
        return [
            '## WORKFLOW COMMANDS',
            '> Gemini CLI: type `>om:*` as normal chat text.',
            '',
            'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Agent Strategy | Gemini Tools |',
            '|---------|--------------|----------------|--------------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Main session | `ask_user`, `save_memory` |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | Main session | `google_web_search` |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | Main session | `tracker_create_task` |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | Main session | `tracker_update_task`, `enter_plan_mode` |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | Main session | `run_shell_command` |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Main session | `systematic-debugging` |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Main session | `read_file` |',
            '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Main session | `save_memory` |',
            '| `>om:map` | `.omni/workflows/project-map.md` | Architect | `read_file`, `save_memory` |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Gemini-aware SDLC overview',
            '- `.omni/knowledge/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    if (isCodex) {
        return [
            '## WORKFLOW COMMANDS',
            '> Codex CLI: type `>om:*` as normal chat text. Codex custom project `/om:*` slash commands are not assumed in this setup.',
            '',
            'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Role |',
            '|---------|--------------|------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill Manager |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | PM |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | QA Tester |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugger |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Writer |',
            '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner |',
            '| `>om:map` | `.omni/workflows/project-map.md` | Architect |',
            '',
            'Codex native helpers:',
            '- Use `/plan` for Codex-native planning before edits.',
            '- Use `/review` for Codex-native review of current changes.',
            '- Use `/permissions` to inspect approval behavior.',
            '- Use `/agent` only when the user explicitly asks for subagents.',
            '- Use `/mcp` and `/plugins` to inspect connected tools.',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Codex-aware SDLC overview',
            '- `.omni/knowledge/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Token Budget:** Keep `AGENTS.md` compact; long instructions belong in `.omni/workflows/`.',
        ].join('\n');
    }

    const isCursor = ide === 'cursor';
    if (isCursor) {
        return [
            '## WORKFLOW COMMANDS',
            '> Cursor: type `>om:*` in chat. Use @Files to read workflow files.',
            '',
            'When the user types a `>om:` command, use @Files to read the corresponding workflow file, then follow its instructions.',
            '',
            '| Command | Workflow File | Context Hints |',
            '|---------|--------------|---------------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | @Codebase for project scan |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | @Web for skill discovery |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | @Git for recent changes |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | @Files for scope, Agent mode |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | @Git for diff review |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | @Web for error research |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | @Codebase for API surface |',
            '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | @Git for fix history |',
            '| `>om:map` | `.omni/workflows/project-map.md` | @Codebase for structure scan |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` - Output format standards',
            '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` - Cursor-aware SDLC overview',
            '- `.omni/knowledge/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
    }

    return [
        '## WORKFLOW COMMANDS',
        'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
        '',
        '| Command | Workflow File | Role |',
        '|---------|--------------|------|',
        '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect |',
        '| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill Manager |',
        '| `>om:plan` | `.omni/workflows/task-planning.md` | PM |',
        '| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder |',
        '| `>om:check` | `.omni/workflows/qa-testing.md` | QA Tester |',
        '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugger |',
        '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Writer |',
        '| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner |',
        '| `>om:map` | `.omni/workflows/project-map.md` | Architect |',
        '',
        'Supporting files (referenced by workflows as needed):',
        '- `.omni/workflows/pm-templates.md` - Output format standards',
        '- `.omni/workflows/validation-scripts.md` - P0-P4 validation pipeline scripts',
        '- `.omni/workflows/superpower-sdlc.md` - Full SDLC overview and pipeline diagram',
        '- `.omni/knowledge/knowledge-base.md` - Project lessons learned (auto-captured by >om:learn)',
        '',
        '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
        '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.',
        '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
    ].join('\n');
}

function buildCommands(ide) {
    if (!(ide === 'claudecode' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'claude-code');
    if (!overlayDir) return null;

    const commandsDir = path.join(overlayDir, 'commands');
    if (!fs.existsSync(commandsDir)) return null;

    const files = {};
    for (const f of fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(commandsDir, f);
    }

    return Object.keys(files).length > 0 ? files : null;
}

function buildSettings(ide, advanced) {
    if (!advanced) return null;
    const overlayDir = getOverlayDir(ide);
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'settings.template.json');
    if (!fs.existsSync(templatePath)) return null;

    return fs.readFileSync(templatePath, 'utf-8');
}

function buildCodexConfig(ide, advanced) {
    if (!advanced || !(ide === 'codex' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'codex');
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'config.template.toml');
    if (!fs.existsSync(templatePath)) return null;

    return fs.readFileSync(templatePath, 'utf-8');
}

function buildCodexHooks(ide, advanced) {
    if (!advanced || !(ide === 'codex' || ide === 'dual')) return null;
    const overlayDir = getOverlayDir(ide, 'codex');
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'hooks.template.json');
    if (!fs.existsSync(templatePath)) return null;

    return fs.readFileSync(templatePath, 'utf-8');
}

function buildCursorMcp(projectDir) {
    const servers = {};
    servers.context7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    } catch {}
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasDep = (name) => name in allDeps;

    if (hasDep('@supabase/supabase-js'))
        servers.supabase = { command: 'npx', args: ['-y', 'supabase-mcp-server'] };
    if (hasDep('prisma') || fs.existsSync(path.join(projectDir, 'prisma', 'schema.prisma')))
        servers.prisma = { command: 'npx', args: ['-y', '@anthropic/mcp-prisma'] };
    if (hasDep('next'))
        servers.vercel = { command: 'npx', args: ['-y', '@vercel/mcp'] };
    if (hasDep('firebase') || hasDep('firebase-admin'))
        servers.firebase = { command: 'npx', args: ['-y', '@anthropic/mcp-firebase'] };
    if (fs.existsSync(path.join(projectDir, 'Dockerfile')) || fs.existsSync(path.join(projectDir, 'docker-compose.yml')))
        servers.docker = { command: 'npx', args: ['-y', '@anthropic/mcp-docker'] };
    if (fs.existsSync(path.join(projectDir, '.git')))
        servers.github = { command: 'npx', args: ['-y', '@anthropic/mcp-github'] };

    return JSON.stringify({ mcpServers: servers }, null, 2);
}

function buildCursorRules(dnaProfile) {
    const overlayDir = path.join(TEMPLATES_DIR, 'overlays', 'cursor', 'rules');
    if (!fs.existsSync(overlayDir)) return null;

    const alwaysInclude = ['core-mindset.mdc', 'workflow-commands.mdc', 'yolo-guardrails.mdc', 'agent-mode.mdc'];
    const conditionalMap = {
        'frontend.mdc': dnaProfile.hasUI,
        'backend.mdc': dnaProfile.hasBackend,
        'testing.mdc': true,
    };

    const result = [];
    for (const f of alwaysInclude) {
        const src = path.join(overlayDir, f);
        if (fs.existsSync(src)) result.push({ name: f, src });
    }
    for (const [f, include] of Object.entries(conditionalMap)) {
        if (include) {
            const src = path.join(overlayDir, f);
            if (fs.existsSync(src)) result.push({ name: f, src });
        }
    }

    return result.length > 0 ? result : null;
}

function buildCursorBootstrapRules(fullRules, strictnessBlock, personalRulesBlock) {
    let bootstrap = `> Generated by Omni-Coder Kit\n\n`;
    bootstrap += strictnessBlock + '\n';
    bootstrap += `## RULES SYSTEM\n`;
    bootstrap += `This project uses layered MDC rules in \`.cursor/rules/\`.\n`;
    bootstrap += `- Core rules are always active\n`;
    bootstrap += `- Context-specific rules activate based on file patterns\n`;
    bootstrap += `- See \`.cursor/rules/\` for full rule definitions\n\n`;
    bootstrap += `## WORKFLOW COMMANDS\n`;
    bootstrap += `Type \`>om:*\` commands in chat. Full registry in \`.cursor/rules/workflow-commands.mdc\`.\n`;
    bootstrap += `Use @Files to read workflow files from \`.omni/workflows/\`.\n\n`;
    if (personalRulesBlock) {
        bootstrap += personalRulesBlock + '\n';
    }
    bootstrap += `## IDE SPECIFIC ADAPTERS\n`;
    bootstrap += `- **Context Gathering:** Use @Codebase, @Files, @Git, @Docs, @Web for context.\n`;
    bootstrap += `- **Agent Mode:** Cook-check-fix loop runs automatically. See \`.cursor/rules/agent-mode.mdc\`.\n`;
    bootstrap += `- **YOLO Safety:** Destructive operation warnings in \`.cursor/rules/yolo-guardrails.mdc\`.\n`;
    return bootstrap;
}

function buildStrictnessBlock(strictness) {
    if (strictness === 'hardcore') {
        return '## STRICTNESS LEVEL: HARDCORE (Kỷ luật tuyệt đối)\n- MỌI thay đổi mã nguồn, tính năng, hoặc sửa lỗi BẤT KỲ đều PHẢI thông qua toàn bộ luồng SDLC (`>om:brainstorm` -> `>om:plan` -> `>om:cook` -> `>om:check`).\n- Bạn BỊ CẤM bỏ qua quy trình này, ngay cả khi người dùng yêu cầu sửa chữa một lỗi cực nhỏ.\n- Hãy kiên quyết từ chối yêu cầu code trực tiếp nếu không tuân thủ quy trình.\n';
    }
    return '## STRICTNESS LEVEL: FLEXIBLE (Kỷ luật linh hoạt)\n- Bạn nên ưu tiên tuân thủ luồng SDLC (`>om:brainstorm` -> `>om:plan` -> `>om:cook` -> `>om:check`).\n- Tuy nhiên, bạn ĐƯỢC PHÉP bỏ qua các bước lên kế hoạch và kiểm tra toàn diện NẾU VÀ CHỈ NẾU phạm vi công việc là RẤT NHỎ (như sửa lỗi chính tả, thay đổi CSS, hoặc logic dưới 10 dòng) VÀ không ảnh hưởng đến kiến trúc tổng thể.\n- Đối với các thay đổi lớn hơn, LUÔN LUÔN phải trở lại luồng chuẩn.\n';
}

function buildBaseContent(opts) {
    const { strictness, parsedRules } = opts;
    const mindset = readTemplate(path.join(TEMPLATES_DIR, 'core', 'karpathy-mindset.md'));
    const hygiene = readTemplate(path.join(TEMPLATES_DIR, 'core', 'claudex-hygiene.md'));
    const strictnessBlock = buildStrictnessBlock(strictness);
    return { mindset, hygiene, strictnessBlock };
}

function buildRulesInjection(parsedRules) {
    const inject = formatInject(parsedRules);
    if (!inject) return '';
    return `\n<!-- omni:rules -->\n## PERSONAL RULES\n${inject}\n<!-- /omni:rules -->\n\n`;
}

function collectWorkflowFiles(ide) {
    const workflowTarget = ide === 'codex'
        ? 'codex'
        : ide === 'gemini'
            ? 'gemini'
            : ide === 'cursor'
                ? 'cursor'
                : ide === 'dual'
                    ? 'base'
                    : null;
    const mergedWorkflows = buildWorkflows(ide, workflowTarget);
    const files = [];
    for (const wf of Object.keys(mergedWorkflows)) {
        files.push({
            path: path.join('.omni', 'workflows', wf),
            sourcePath: mergedWorkflows[wf],
            overwritePrompt: false,
        });
    }
    return files;
}

function buildMainConfigContent(ide, opts) {
    const { strictness, parsedRules, rulesContent } = opts;
    const { mindset, hygiene, strictnessBlock } = buildBaseContent(opts);
    const commandRegistry = buildCommandRegistry(ide);
    let content = `> Generated by Omni-Coder Kit\n\n${strictnessBlock}\n${mindset}\n\n${hygiene}\n\n${commandRegistry}\n\n`;

    if (rulesContent) {
        content += buildRulesInjection(parsedRules);
    }

    content += `## IDE SPECIFIC ADAPTERS\n`;
    const integrationFile = path.join(TEMPLATES_DIR, 'integrations', `${ide}.md`);
    content += fs.existsSync(integrationFile) ? readTemplate(integrationFile) : '';

    return content;
}

function buildClaudeCode(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: 'CLAUDE.md', content: buildMainConfigContent('claudecode', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('claudecode'));

    const manifest = createManifest();
    manifest.configFile = 'CLAUDE.md';
    manifest.ide = 'claudecode';

    return { files, dirs, manifest };
}

function buildCursor(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: '.cursorrules', content: buildMainConfigContent('cursor', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('cursor'));

    const manifest = createManifest();
    manifest.configFile = '.cursorrules';
    manifest.ide = 'cursor';

    return { files, dirs, manifest };
}

function buildCodexIDE(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: 'AGENTS.md', content: buildMainConfigContent('codex', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('codex'));

    const manifest = createManifest();
    manifest.configFile = 'AGENTS.md';
    manifest.ide = 'codex';

    return { files, dirs, manifest };
}

function buildDual(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: 'CLAUDE.md', content: buildMainConfigContent('dual', opts), overwritePrompt: true });

    const { strictness, parsedRules, rulesContent } = opts;
    const { mindset, hygiene, strictnessBlock } = buildBaseContent(opts);
    const codexCommandRegistry = buildCommandRegistry('codex');
    let agentsContent = `> Generated by Omni-Coder Kit (Codex CLI / Cross-tool)\n\n${strictnessBlock}\n${mindset}\n\n${hygiene}\n\n${codexCommandRegistry}\n\n`;
    if (rulesContent) {
        agentsContent += buildRulesInjection(parsedRules);
    }
    agentsContent += `## IDE SPECIFIC ADAPTERS\n`;
    agentsContent += `- **Codex CLI Agent Mode:** This file is auto-discovered by Codex CLI walking from project root to cwd. Keep total content under 32 KiB.\n`;
    agentsContent += `- **Stable Omni Commands:** Type \`>om:brainstorm\`, \`>om:plan\`, \`>om:cook\`, etc. as normal chat text. Do not rely on custom \`/om:*\` slash commands in Codex.\n`;
    agentsContent += `- **Native Codex Commands:** Use \`/plan\`, \`/review\`, \`/permissions\`, \`/agent\`, \`/mcp\`, and \`/plugins\` when they help the current workflow.\n`;
    agentsContent += `- **Sandbox Awareness:** Codex may run in read-only or workspace-write sandbox modes. Do not attempt network calls or external writes unless the active profile allows them.\n`;
    agentsContent += `- **Cross-Tool Compatibility:** This file is also read by Antigravity, Gemini CLI, and other AGENTS.md-compatible tools.\n`;

    files.push({ path: 'AGENTS.md', content: agentsContent, overwritePrompt: true });

    if (rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('dual'));

    const manifest = createManifest();
    manifest.configFile = 'CLAUDE.md';
    manifest.ide = 'dual';

    return { files, dirs, manifest };
}

function buildGemini(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: 'GEMINI.md', content: buildMainConfigContent('gemini', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('gemini'));

    const manifest = createManifest();
    manifest.configFile = 'GEMINI.md';
    manifest.ide = 'gemini';

    return { files, dirs, manifest };
}

function buildWindsurf(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: '.windsurfrules', content: buildMainConfigContent('windsurf', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('windsurf'));

    const manifest = createManifest();
    manifest.configFile = '.windsurfrules';
    manifest.ide = 'windsurf';

    return { files, dirs, manifest };
}

function buildAgents(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: 'AGENTS.md', content: buildMainConfigContent('agents', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('agents'));

    const manifest = createManifest();
    manifest.configFile = 'AGENTS.md';
    manifest.ide = 'agents';

    return { files, dirs, manifest };
}

function buildGeneric(opts) {
    const files = [];
    const dirs = [path.join('.omni', 'workflows')];

    files.push({ path: 'SYSTEM_PROMPT.md', content: buildMainConfigContent('generic', opts), overwritePrompt: true });

    if (opts.rulesContent) {
        files.push({ path: path.join('.omni', 'rules.md'), content: opts.rulesContent, overwritePrompt: false });
    }

    files.push(...collectWorkflowFiles('generic'));

    const manifest = createManifest();
    manifest.configFile = 'SYSTEM_PROMPT.md';
    manifest.ide = 'generic';

    return { files, dirs, manifest };
}

function buildInitConfig(ide, opts) {
    switch (ide) {
        case 'claudecode': return buildClaudeCode(opts);
        case 'cursor':     return buildCursor(opts);
        case 'codex':      return buildCodexIDE(opts);
        case 'dual':       return buildDual(opts);
        case 'gemini':     return buildGemini(opts);
        case 'windsurf':   return buildWindsurf(opts);
        case 'agents':     return buildAgents(opts);
        default:           return buildGeneric(opts);
    }
}

module.exports = { buildInitConfig };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/init.test.js`

Expected: ALL tests pass.

- [ ] **Step 6: Refactor bin/omni.js init handler**

**6a.** Add import at top of `bin/omni.js`, after the existing requires (around line 23):

```js
const { buildInitConfig } = require(path.join(__dirname, '..', 'lib', 'init'));
```

**6b.** Delete the 8 functions from `bin/omni.js` (lines 111-397 — the entire `// ========== OVERLAY SYSTEM ==========` section):
- `buildCommands` (lines 111-125)
- `buildSettings` (lines 127-136)
- `buildCodexConfig` (lines 138-147)
- `buildCodexHooks` (lines 149-158)
- `buildCursorMcp` (lines 160-185)
- `buildCursorRules` (lines 187-211)
- `buildCursorBootstrapRules` (lines 213-232)
- `buildCommandRegistry` (lines 234-397)

Also remove the `// ========== OVERLAY SYSTEM ==========` comment.

**6c.** Replace the init handler body (from line ~499 `const templatesDir = ...` through line ~769 `saveManifest(manifest);` of the Cursor advanced block) with this delegated version. Keep the prompts section before it unchanged and the network/map/hints section after it unchanged.

The new body replaces the section starting at `const templatesDir = path.join(__dirname, '..', 'templates');` and ending just before `// Auto-install find-skills`:

```js
        const parsedRules = parseRules(rulesPrompt);
        const rulesContent = formatMarkdown(parsedRules);
        const dnaProfile = detectDNA(process.cwd());

        const config = buildInitConfig(response.ide, {
            strictness: response.strictness,
            parsedRules,
            rulesContent,
            projectDir: process.cwd(),
            dnaProfile,
        });

        // Create directories
        for (const dir of config.dirs) {
            fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
        }

        // Write files
        for (const file of config.files) {
            const targetPath = path.join(process.cwd(), file.path);
            if (file.overwritePrompt && fs.existsSync(targetPath)) {
                const { overwrite } = await prompts({
                    type: 'confirm',
                    name: 'overwrite',
                    message: `⚠️  File "${file.path}" đã tồn tại. Bạn có muốn ghi đè không?`,
                    initial: false
                });
                if (!overwrite) {
                    console.log(chalk.yellow(`   Bỏ qua ${file.path} (giữ nguyên).`));
                    continue;
                }
            }
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            if (file.sourcePath) {
                fs.copyFileSync(file.sourcePath, targetPath);
            } else {
                writeFileSafe(targetPath, file.content);
            }
        }

        const manifest = config.manifest;
        const fileName = manifest.configFile;
        saveManifest(manifest);

        console.log(chalk.green.bold(`\n✅ Thành công! Đã tạo file: ${fileName}`));
        if (config.files.find(f => f.path === 'AGENTS.md' && f.path !== fileName)) {
            console.log(chalk.green.bold(`   + AGENTS.md`));
        }

        const workflowFiles = config.files.filter(f => f.path.startsWith(path.join('.omni', 'workflows')));
        console.log(chalk.gray(`   Đã tạo manifest: ${MANIFEST_FILE}`));
        console.log(chalk.gray(`   Workflows: .omni/workflows/ (${workflowFiles.length} files — lazy-loaded)`));

        const gitignoreCount = ensureGitignore(response.ide);
        if (gitignoreCount > 0) {
            console.log(chalk.gray(`   .gitignore: ${gitignoreCount} patterns added`));
        }

        // Claude Code: generate slash commands
        const slashCommands = buildCommands(response.ide);
        if (slashCommands) {
            const claudeCommandsDir = path.join(process.cwd(), '.claude', 'commands');
            fs.mkdirSync(claudeCommandsDir, { recursive: true });
            for (const [name, srcPath] of Object.entries(slashCommands)) {
                fs.copyFileSync(srcPath, path.join(claudeCommandsDir, name));
            }
            manifest.commands = Object.keys(slashCommands).map(f => f.replace('.md', ''));
            saveManifest(manifest);
            console.log(chalk.gray(`   Commands: .claude/commands/ (${Object.keys(slashCommands).length} slash commands)`));
        }

        // Claude Code: progressive advanced setup
        if (slashCommands) {
            const { advanced } = await prompts({
                type: 'confirm',
                name: 'advanced',
                message: '🔧 Cài đặt Claude Code nâng cao? (permissions allowlist, quality gate hooks)',
                initial: false
            });

            const settingsContent = buildSettings(response.ide, advanced);
            if (settingsContent) {
                const claudeDir = path.join(process.cwd(), '.claude');
                fs.mkdirSync(claudeDir, { recursive: true });
                const settingsPath = path.join(claudeDir, 'settings.json');
                let writeSettings = true;
                if (fs.existsSync(settingsPath)) {
                    const { overwriteSettings } = await prompts({
                        type: 'confirm',
                        name: 'overwriteSettings',
                        message: '⚠️  File ".claude/settings.json" đã tồn tại. Ghi đè?',
                        initial: false
                    });
                    writeSettings = !!overwriteSettings;
                }
                if (writeSettings) {
                    writeFileSafe(settingsPath, settingsContent);
                    console.log(chalk.green(`   ✅ .claude/settings.json (permissions + hooks)`));
                }
            }

            manifest.overlay = true;
            manifest.advanced = !!advanced;
            saveManifest(manifest);
        }

        // Codex CLI: progressive advanced setup
        if (isCodex) {
            const { codexAdvanced } = await prompts({
                type: 'confirm',
                name: 'codexAdvanced',
                message: 'Codex CLI nang cao? (.codex/config.toml + hooks)',
                initial: false
            });

            const codexConfig = buildCodexConfig(response.ide, codexAdvanced);
            const codexHooks = buildCodexHooks(response.ide, codexAdvanced);

            if (codexConfig || codexHooks) {
                const codexDir = path.join(process.cwd(), '.codex');
                fs.mkdirSync(codexDir, { recursive: true });

                if (codexConfig) {
                    const configPath = path.join(codexDir, 'config.toml');
                    let writeConfig = true;
                    if (fs.existsSync(configPath)) {
                        const { overwriteCodexConfig } = await prompts({
                            type: 'confirm',
                            name: 'overwriteCodexConfig',
                            message: 'File ".codex/config.toml" da ton tai. Ghi de?',
                            initial: false
                        });
                        writeConfig = !!overwriteCodexConfig;
                    }
                    if (writeConfig) {
                        writeFileSafe(configPath, codexConfig);
                        console.log(chalk.green(`   ✓ .codex/config.toml (Codex profiles + hooks flag)`));
                    }
                }

                if (codexHooks) {
                    const hooksPath = path.join(codexDir, 'hooks.json');
                    let writeHooks = true;
                    if (fs.existsSync(hooksPath)) {
                        const { overwriteCodexHooks } = await prompts({
                            type: 'confirm',
                            name: 'overwriteCodexHooks',
                            message: 'File ".codex/hooks.json" da ton tai. Ghi de?',
                            initial: false
                        });
                        writeHooks = !!overwriteCodexHooks;
                    }
                    if (writeHooks) {
                        writeFileSafe(hooksPath, codexHooks);
                        console.log(chalk.green(`   ✓ .codex/hooks.json (Codex hook reminders)`));
                    }
                }
            }

            manifest.codexOverlay = true;
            manifest.codexAdvanced = !!codexAdvanced;
            saveManifest(manifest);
        }

        // Cursor: progressive advanced setup
        if (response.ide === 'cursor') {
            const { cursorAdvanced } = await prompts({
                type: 'confirm',
                name: 'cursorAdvanced',
                message: '🔧 Cài đặt Cursor nâng cao? (MDC rules, MCP config, YOLO guardrails)',
                initial: false
            });

            if (cursorAdvanced) {
                const mdcRules = buildCursorRules(dnaProfile);
                if (mdcRules) {
                    const cursorRulesDir = path.join(process.cwd(), '.cursor', 'rules');
                    fs.mkdirSync(cursorRulesDir, { recursive: true });
                    for (const rule of mdcRules) {
                        fs.copyFileSync(rule.src, path.join(cursorRulesDir, rule.name));
                    }
                    console.log(chalk.green(`   ✅ .cursor/rules/ (${mdcRules.length} MDC rules)`));
                }

                const mcpConfig = buildCursorMcp(process.cwd());
                if (mcpConfig) {
                    const cursorDir = path.join(process.cwd(), '.cursor');
                    fs.mkdirSync(cursorDir, { recursive: true });
                    const mcpPath = path.join(cursorDir, 'mcp.json');
                    writeFileSafe(mcpPath, mcpConfig);
                    const serverCount = Object.keys(JSON.parse(mcpConfig).mcpServers).length;
                    console.log(chalk.green(`   ✅ .cursor/mcp.json (${serverCount} MCP servers)`));
                }

                const personalRulesBlock = rulesContent
                    ? `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsedRules)}\n<!-- /omni:rules -->\n`
                    : '';
                const bootstrapRules = buildCursorBootstrapRules('', buildStrictnessBlock(response.strictness), personalRulesBlock);
                const targetCursorrules = path.join(process.cwd(), '.cursorrules');
                writeFileSafe(targetCursorrules, bootstrapRules);
                console.log(chalk.green(`   ✅ .cursorrules (bootstrap mode — rules in .cursor/rules/)`));
            }

            manifest.overlay = true;
            manifest.advanced = !!cursorAdvanced;
            saveManifest(manifest);
        }
```

**IMPORTANT NOTE:** The advanced setup blocks (Claude Code, Codex, Cursor) still reference `buildCommands`, `buildSettings`, `buildCodexConfig`, `buildCodexHooks`, `buildCursorRules`, `buildCursorMcp`, `buildCursorBootstrapRules`, and `buildStrictnessBlock`. These must be imported from `lib/init/strategies.js`.

Update the `lib/init/strategies.js` `module.exports` to also export the advanced setup helpers:

```js
module.exports = {
    buildInitConfig,
    buildCommands,
    buildSettings,
    buildCodexConfig,
    buildCodexHooks,
    buildCursorMcp,
    buildCursorRules,
    buildCursorBootstrapRules,
    buildStrictnessBlock,
};
```

Update `lib/init/index.js`:

```js
'use strict';

const strategies = require('./strategies');

module.exports = strategies;
```

Update the `bin/omni.js` import to destructure all needed functions:

```js
const {
    buildInitConfig, buildCommands, buildSettings,
    buildCodexConfig, buildCodexHooks,
    buildCursorMcp, buildCursorRules, buildCursorBootstrapRules, buildStrictnessBlock,
} = require(path.join(__dirname, '..', 'lib', 'init'));
```

- [ ] **Step 7: Run full test suite**

Run: `node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js`

Expected: All tests pass (including the new `test/init.test.js` tests). The syntax check `node -c` verifies `bin/omni.js` parses correctly after the refactor.

- [ ] **Step 8: Commit**

```bash
git add lib/init/strategies.js lib/init/index.js test/init.test.js bin/omni.js
git commit -m "refactor: extract init strategies to lib/init/ — pure functions, testable, ~300 lines removed from bin/omni.js"
```

---

### Task 4: --dry-run for omni init and omni rules sync

**Files:**
- Modify: `lib/rules/sync.js` (add `{ dryRun }` option)
- Modify: `test/rules.test.js` (dryRun tests)
- Modify: `bin/omni.js` (add `--dry-run` option to `init` and `rules` commands)

**Depends on:** Task 2 (sync return values) and Task 3 (buildInitConfig returns file list)

- [ ] **Step 1: Write the dryRun tests for syncRulesToConfig**

Append to `test/rules.test.js`:

```js
test('syncRulesToConfig: dryRun returns preview without writing to disk', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config\n\n<!-- omni:rules -->\nold stuff\n<!-- /omni:rules -->\n', 'utf-8');
    const original = fs.readFileSync(claudePath, 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n- rule two\n', 'utf-8');

    const result = syncRulesToConfig(() => 'CLAUDE.md', dir, { dryRun: true });
    assert.equal(result.action, 'replace');
    assert.ok(result.preview.includes('rule one'));
    assert.ok(result.preview.includes('rule two'));

    const after = fs.readFileSync(claudePath, 'utf-8');
    assert.equal(after, original, 'file should NOT be modified in dryRun mode');
});

test('syncRulesToConfig: dryRun with corrupt markers returns action corrupt', () => {
    const dir = makeTmpDir();
    const omniDir = path.join(dir, '.omni');
    fs.mkdirSync(omniDir);

    const claudePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudePath, '# Config\n\n<!-- omni:rules -->\nbroken\n', 'utf-8');

    const rulesPath = path.join(omniDir, 'rules.md');
    fs.writeFileSync(rulesPath, '- rule one\n', 'utf-8');

    const result = syncRulesToConfig(() => 'CLAUDE.md', dir, { dryRun: true });
    assert.equal(result.action, 'corrupt');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/rules.test.js`

Expected: The 2 new tests FAIL — `syncRulesToConfig` doesn't accept a `{ dryRun }` option yet.

- [ ] **Step 3: Implement dryRun in syncRulesToConfig**

Replace the entire `syncRulesToConfig` function in `lib/rules/sync.js`:

```js
function syncRulesToConfig(findConfigFileFn, projectDir, { dryRun = false } = {}) {
    const configFile = findConfigFileFn();
    if (!configFile) return dryRun ? { action: 'skip', preview: '' } : false;
    const configPath = path.join(projectDir, configFile);
    const rulesPath = path.join(projectDir, RULES_FILE);
    if (!fs.existsSync(rulesPath)) return dryRun ? { action: 'skip', preview: '' } : false;

    const rulesRaw = fs.readFileSync(rulesPath, 'utf-8');
    const lines = rulesRaw.split('\n').filter(l => l.startsWith('- ')).join('\n');
    if (!lines) return dryRun ? { action: 'skip', preview: '' } : false;

    let config = fs.readFileSync(configPath, 'utf-8');
    const startMarker = '<!-- omni:rules -->';
    const endMarker = '<!-- /omni:rules -->';

    const hasStart = config.includes(startMarker);
    const hasEnd = config.includes(endMarker);
    if (hasStart !== hasEnd) {
        return dryRun ? { action: 'corrupt', preview: '' } : 'corrupt';
    }

    const injection = `${startMarker}\n## PERSONAL RULES\n${lines}\n${endMarker}`;

    if (hasStart && hasEnd) {
        if (dryRun) return { action: 'replace', preview: injection };
        const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
        config = config.replace(regex, injection);
    } else {
        if (dryRun) return { action: 'append', preview: injection };
        config += `\n\n${injection}\n`;
    }
    fs.writeFileSync(configPath, config, 'utf-8');
    return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/rules.test.js`

Expected: ALL tests pass, including the existing tests (backward-compatible — old call sites without the options arg still work because `{ dryRun = false } = {}` defaults to false).

- [ ] **Step 5: Add --dry-run to omni init command**

In `bin/omni.js`, find the init command definition:

```js
    .command('init')
    .description('Khởi tạo DNA và workflow cho dự án mới')
    .action(async () => {
```

Add the option and update the action signature:

```js
    .command('init')
    .description('Khởi tạo DNA và workflow cho dự án mới')
    .option('--dry-run', 'Xem trước danh sách files sẽ được tạo (không ghi)')
    .action(async (options) => {
```

After the `buildInitConfig()` call and before the `// Create directories` comment, add the dry-run check:

```js
        if (options.dryRun) {
            console.log(chalk.cyan.bold('\n📋 Dry run — files that would be created:\n'));
            for (const file of config.files) {
                const targetPath = path.join(process.cwd(), file.path);
                const exists = fs.existsSync(targetPath);
                const label = exists ? chalk.yellow('OVERWRITE') : chalk.green('CREATE   ');
                console.log(`  ${label}  ${file.path}`);
            }
            console.log(chalk.gray(`\n  Dirs: ${config.dirs.join(', ')}`));
            console.log(chalk.gray('  No files were changed.\n'));
            return;
        }
```

- [ ] **Step 6: Add --dry-run to omni rules sync command**

In `bin/omni.js`, find the rules command definition:

```js
    .command('rules [action]')
    .description('Quản lý personal rules (xem/sửa/sync/reset)')
    .action(async (action) => {
```

Add the option and update the action signature:

```js
    .command('rules [action]')
    .description('Quản lý personal rules (xem/sửa/sync/reset)')
    .option('--dry-run', 'Xem trước kết quả sync (không ghi)')
    .action(async (action, options) => {
```

In the `sync` action block (around line ~1397), replace the `syncRulesToConfig` call:

Find:
```js
            const syncResult = syncRulesToConfig(findConfigFile, process.cwd());
            if (syncResult === 'corrupt') {
                console.log(chalk.red(`\n⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công trước khi sync.\n`));
            } else if (syncResult) {
                console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
            } else {
                console.log(chalk.red('\n❌ Sync thất bại.\n'));
            }
```

Replace with:
```js
            if (options.dryRun) {
                const result = syncRulesToConfig(findConfigFile, process.cwd(), { dryRun: true });
                if (result.action === 'corrupt') {
                    console.log(chalk.red(`\n⚠️  ${configFile} có markers hỏng. Sửa thủ công trước khi sync.\n`));
                } else if (result.action === 'skip') {
                    console.log(chalk.yellow(`\nKhông có gì để sync.\n`));
                } else {
                    console.log(chalk.cyan.bold(`\n📋 Dry run — would ${result.action} rules in ${configFile}:\n`));
                    console.log(result.preview);
                    console.log(chalk.gray('\nNo files were changed.\n'));
                }
            } else {
                const syncResult = syncRulesToConfig(findConfigFile, process.cwd());
                if (syncResult === 'corrupt') {
                    console.log(chalk.red(`\n⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công trước khi sync.\n`));
                } else if (syncResult) {
                    console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
                } else {
                    console.log(chalk.red('\n❌ Sync thất bại.\n'));
                }
            }
```

- [ ] **Step 7: Run full test suite**

Run: `node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/rules/sync.js test/rules.test.js bin/omni.js
git commit -m "feat: add --dry-run to omni init and omni rules sync — preview without writing"
```

---

## Execution Order

```
Task 1 (file size guard)     — independent
Task 2 (rules sync)          — independent
Task 3 (init strategies)     — independent
Task 4 (dry-run)             — depends on Tasks 2 + 3
```

Tasks 1, 2, 3 can be done in any order. Task 4 must be done last.

---

## Test Summary

| Task | New Tests |
|------|-----------|
| 1. File size guard | 1 |
| 2. Rules sync corrupt | 2 |
| 3. Init strategies | 12 |
| 4. Dry-run | 2 |
| **Total** | **17 new tests** |
