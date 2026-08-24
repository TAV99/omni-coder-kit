# Codex Native Omni Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Omni workflow directly invocable as a native Codex project skill.

**Architecture:** A single `buildCodexNativeWorkflowSkills()` helper maps stable skill names to existing workflow filenames and returns generated `.codex/skills/<name>/SKILL.md` file descriptors. `buildInitConfig()` attaches these descriptors only for `codex` and `dual`; no workflow body is duplicated.

**Tech Stack:** Node.js CommonJS, `node:test`, filesystem-backed templates.

## Global Constraints

- Preserve `.omni/workflows/` as the sole workflow-content source.
- Native skills must not grant permissions, execute commands, or create slash-command emulation.
- Keep `>om-*` documented only as a compatibility alias.
- Do not change non-Codex init output.

---

### Task 1: Define and prove the generated native-skill contract

**Files:**
- Modify: `test/init.test.js`

**Interfaces:**
- Consumes: `buildInitConfig(ide, opts)`.
- Produces: tests expecting thirteen `.codex/skills/<skill>/SKILL.md` descriptors for `codex` and `dual`.

- [x] Write tests asserting `om-think` references `.omni/workflows/requirement-analysis.md`, `om-cook` references `.omni/workflows/coder-execution.md`, and all expected skill directories are emitted for Codex and dual.
- [x] Run `node --test test/init.test.js` and confirm failure because native workflow skills are absent.

### Task 2: Implement thin native workflow skill generation

**Files:**
- Modify: `lib/init/strategies.js`

**Interfaces:**
- Consumes: a static name-to-workflow mapping inside `buildCodexNativeWorkflowSkills()`.
- Produces: `{ path, content, overwritePrompt: false }` descriptors and native skill directories.

- [x] Add `buildCodexNativeWorkflowSkills()` with the thirteen exact mappings.
- [x] Generate each `SKILL.md` with YAML name/description and an instruction to read the exact workflow before acting.
- [x] Attach descriptors and directories for `ide === 'codex' || ide === 'dual'`.
- [x] Run the focused tests and confirm they pass.

### Task 3: Update the Codex dispatcher language

**Files:**
- Modify: `lib/init/strategies.js`
- Test: `test/init.test.js`

**Interfaces:**
- Consumes: generated `AGENTS.md` content.
- Produces: a dispatcher that makes `$om-*` preferred and retains `>om-*` as compatibility text.

- [x] Add an assertion against Codex `AGENTS.md` for native `$om-think` guidance and compatibility `>om-think` guidance.
- [x] Replace stale wording that calls `>om-*` the stable primary command.
- [x] Rerun focused tests.

### Task 4: Regression verification

**Files:**
- Verify: all changed files

- [x] Run `git diff --check`.
- [x] Run `npm test`.
- [x] Inspect the generated descriptors with a test-only `buildInitConfig('codex', ...)` call and verify no duplicate workflow body is embedded.
