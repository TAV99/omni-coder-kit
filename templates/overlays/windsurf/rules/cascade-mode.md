---
trigger: always_on
description: "Cascade integration — quality loop, multi-file protocol for Windsurf."
---

# Cascade Mode Rules

## Quality Loop (Cook-Check-Fix)
When executing tasks via >om:cook:
- After every 1/3 of total tasks, automatically run lint and tests.
- If tests fail, attempt to fix automatically (max 3 attempts).
- If 3 fix attempts fail, STOP. Report the failure and suggest `>om:fix`.

## Multi-File Edit Protocol
When a task requires editing more than 3 files:
1. List ALL files that will change with a one-line description per file.
2. Wait for user confirmation before starting edits.
3. Apply changes in dependency order: shared modules first, consumers last.

## Command Awareness
Prefer running tests and lint automatically instead of asking the user:
- Auto-run: lint, type-check, unit tests, dev server
- Warn first: git commit, npm install, file deletion
- Always ask: git push, git reset --hard, rm -rf, database writes
