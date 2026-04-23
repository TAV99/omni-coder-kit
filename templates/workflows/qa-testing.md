## QA TESTING WORKFLOW (PROACTIVE VERIFICATION)
When executing the [>om:check] command, you MUST act as a QA Engineer. Your job is to verify that every completed task in `todo.md` actually works — not just that the code exists.

**Step 1: Inventory — What needs testing?**
Read `todo.md`. Collect all tasks marked `- [x]` (completed). Group them by type:
- **Build:** Does the project compile/start without errors?
- **API:** Endpoints return correct responses?
- **UI:** Pages render, interactions work?
- **Logic:** Business rules produce expected output?
- **Integration:** External services connect properly?

**Step 2: Build & Lint Gate**
Run the project's build/lint/typecheck commands. If any fail, STOP and report — no point testing features on broken code.
```
# Detect and run (adapt to project)
npm run build / npm run typecheck / npx tsc --noEmit
npm run lint (if exists)
```
Record: PASS or FAIL + error summary.

**Step 3: Automated Tests**
Run existing test suites. If no tests exist, note it — do NOT skip verification, move to manual checks.
```
npm test / npx vitest run / npx jest (adapt to project)
```
Record: PASS (X/Y tests) or FAIL + failing test names.

**Step 4: Feature Verification (per completed task)**
For EACH completed `- [x]` task in `todo.md`, verify it works:

- **API endpoints:** Use `curl` or a script to hit the endpoint, check status code + response shape.
- **UI features:** Start dev server (`npm run dev`), open in browser, test the golden path + one edge case. Use Playwright/browser tool if available.
- **Database changes:** Verify migrations run, schema matches expectation (`npx prisma db push --dry-run`, or equivalent).
- **Logic/utils:** Write a quick smoke test or run in REPL to confirm output.
- **Config/env:** Verify the app starts with the expected configuration.

For each task, record:
- Task description (from todo.md)
- Verification method used
- Result: PASS / FAIL / SKIP (with reason)
- If FAIL: specific error or unexpected behavior

**Step 5: Generate Test Report**
Output `test-report.md` in this format:

```markdown
# Test Report
> Generated: [date] | Project: [name]

## Build & Lint
- Build: PASS/FAIL
- Lint: PASS/FAIL
- Typecheck: PASS/FAIL

## Automated Tests
- Result: X/Y passed
- Failures: [list if any]

## Feature Verification
| # | Task | Method | Result | Notes |
|---|------|--------|--------|-------|
| 1 | [task from todo] | [curl/browser/repl] | PASS/FAIL | [details] |
| 2 | ... | ... | ... | ... |

## Summary
- Total: X tasks verified
- Passed: Y | Failed: Z | Skipped: W
- Blocking issues: [list any FAIL items that block release]

## Next Steps
- [If all PASS] Ready for >om:doc
- [If FAIL exists] Fix with >om:fix, then re-run >om:check
```

**Rules:**
- Do NOT mark a feature as PASS without actually running/testing it. "The code looks correct" is NOT verification.
- If you cannot test something (e.g., needs real API key, hardware), mark SKIP with the reason.
- If the project has no test framework set up, recommend one appropriate for the stack but do NOT install it without asking.
- For UI: you MUST start the dev server and interact with the feature. Screenshots or browser tool output count as evidence.
- Keep the report factual. No opinions, no suggestions for improvements — just what works and what doesn't.
