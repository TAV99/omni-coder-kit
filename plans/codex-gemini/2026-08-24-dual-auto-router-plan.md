# Dual Auto Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route bounded Dual Auto tasks to Gemini 3.7 Flash High with evidence artifacts and Codex final ownership.

**Architecture:** The existing PowerShell transaction wrapper gains deterministic `route`, `implement`, and `review` actions. Generated Dual Auto configuration writes policy/schema/prompt artifacts and augments the native `om-think` dispatcher only for the supported pair.

**Tech Stack:** Node.js CommonJS tests, PowerShell, Antigravity `agy` print mode.

## Global Constraints

- Gemini model: `gemini-3.7-flash-high`; effort: `high`.
- Dispatch only after preflight status is exactly `safe`.
- Gemini gets at most three allowed files and cannot commit, push, deploy, or bypass permissions.
- Codex owns task specification, routing approval, and final QC.

---

### Task 1: Prove routing and generated-mode contracts

- [x] Add RED tests for Dual Auto router artifacts/native-skill instructions and wrapper route/worker stop conditions.
- [x] Run focused tests and confirm missing actions/artifacts fail.

### Task 2: Add task routing artifacts and native auto dispatcher

- [x] Keep task specs, route, evidence, and review as transaction artifacts; the router rejects missing required spec fields.
- [x] Add the Dual Auto `$om-think` orchestration instructions only for `dualPair=codex-agy` and `mode=auto`.
- [x] Verify manual Dual output does not include auto dispatcher language.

### Task 3: Implement wrapper route, implement, and review actions

- [x] Route incomplete, risky, or over-three-file specs to Codex.
- [x] Invoke Gemini with verified model/effort/mode for Gemini-owned tasks.
- [x] Write evidence/review artifacts and fail closed on bad output or non-zero exit.

### Task 4: Verify

- [x] Run focused router/wrapper/init tests.
- [x] Run `git diff --check` and `npm test`.
