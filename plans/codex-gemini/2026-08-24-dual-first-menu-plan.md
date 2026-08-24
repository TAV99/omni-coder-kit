# Dual-First Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex plus Gemini discoverable as the supported Dual mode pair before SDLC mode selection.

**Architecture:** `handleInit()` owns the interactive onboarding order. It will ask the primary IDE selector, conditionally resolve the supported dual pair, then ask for SDLC mode. `buildInitConfig()` remains the generation boundary and keeps its established `dualPair` contract.

**Tech Stack:** Node.js CommonJS, prompts, node:test.

## Global Constraints

- Only `codex-agy` is selectable in this release.
- Do not change generated files, manifest schema, or Antigravity wrapper behavior.
- Do not expose roadmap pairs as executable choices.

---

### Task 1: Lock the onboarding contract

**Files:**
- Modify: `test/init.test.js`
- Modify: `lib/commands/init.js`

- [x] Add source-level regression assertions for the first dual selector label, immediate pair selector, and sole `codex-agy` choice.
- [x] Run the focused test and observe failure against the current delayed pair flow.

### Task 2: Reorder the interactive prompts

**Files:**
- Modify: `lib/commands/init.js`

- [x] Move the primary IDE choice into its own prompt before SDLC mode.
- [x] Resolve `dualPair` immediately after the primary selector, with `codex-agy` as the only choice.
- [x] Ask SDLC mode only after the pair has been resolved, and rename display text to `Dual mode`.
- [x] Run focused tests and confirm they pass.

### Task 3: Verify regression boundaries

**Files:**
- Verify: `lib/commands/init.js`, `lib/init/strategies.js`, `test/init.test.js`

- [x] Run `git diff --check`.
- [x] Run `npm test`.
- [x] Verify `buildInitConfig('dual', { dualPair: 'codex-agy' })` still emits the Codex-Gemini integration.
