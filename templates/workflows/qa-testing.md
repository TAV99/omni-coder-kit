## QA TESTING WORKFLOW (PROACTIVE VERIFICATION)
When executing the [>om:check] command, you MUST act as a QA Engineer. Your job is to verify that every completed task in `.omni/sdlc/todo.md` actually works — not just that the code exists.

**Step 1: Inventory — What needs testing?**
Read `.omni/sdlc/todo.md`. Collect all tasks marked `- [x]` (completed). Group them by type:
- **Build:** Does the project compile/start without errors?
- **API:** Endpoints return correct responses?
- **UI:** Pages render, interactions work?
- **Logic:** Business rules produce expected output?
- **Integration:** External services connect properly?

**Step 2: Validation Pipeline (P0 → P1 → P2 → P3 → P4)**
Execute the full automated validation pipeline. Run checks in strict priority order:
- **P0: Security Scan** (dependency audit, secrets detection, dangerous patterns, SQL injection) — BLOCKING
- **P1: Lint & Typecheck** (ESLint/Biome, TypeScript, Python lint) — BLOCKING
- **P2: Build** (compile/bundle the project) — BLOCKING
- **P3: Automated Tests** (vitest/jest/pytest) — BLOCKING
- **P4: Bundle Analysis** (size, unused deps) — ADVISORY
- **P5: Content Validation** (cross-check against .omni/sdlc/content-source.md) — HIGH=BLOCKING, LOW/MEDIUM=ADVISORY

**Evidence rule:** You MUST run a shell command for each P0-P3 check. "Code looks correct" is NOT verification. Use quiet flags to minimize output: `--silent`, `-q`, `--quiet`, `2>&1 | tail -5`. Only capture what's needed to determine PASS/FAIL.

*If ANY blocking check (P0-P3) fails, STOP. Do NOT proceed to Feature Verification. Report failures and recommend `>om:fix`.*

**P5: Content Validation (ADVISORY — runs after P0-P3 pass)**
If `.omni/sdlc/content-source.md` exists:
1. Read `.omni/sdlc/content-source.md` — extract `## Facts` and `## Forbidden Content`.
2. Scan all user-facing files (HTML, JSX/TSX, markdown, data files with UI text) for violations:
   - **Fact check:** Does any generated text contradict a fact? (e.g., "pricing" when facts say "open-source, no pricing")
   - **Forbidden check:** Does any content match a forbidden pattern? (e.g., fake testimonials, placeholder text, lorem ipsum)
   - **Placeholder check:** Search for common placeholder patterns: "Lorem ipsum", "John Doe", "example@email.com", "[Your Name]", "TBD", "Coming soon" (when not intentional)
3. Report findings in `.omni/sdlc/test-report.md` under a `## Content Validation` section:
   ```
   ## Content Validation
   Source: .omni/sdlc/content-source.md
   | # | File | Issue | Severity |
   |---|------|-------|----------|
   | 1 | src/data/pricing.ts | Contains pricing tiers — forbidden (open-source project) | HIGH |
   | 2 | src/data/testimonials.ts | Fake testimonials with fictional names | MEDIUM |
   | 3 | src/components/Footer.tsx | Placeholder "Your Company" text | LOW |

   Content issues: 3 (2 HIGH/MEDIUM, 1 LOW)
   ```
4. **Severity enforcement:**
   - **HIGH** (contradicts a Fact or matches Forbidden Content) → **BLOCKING.** Treat like a P0-P3 failure: STOP, report, recommend `>om:fix`.
   - **MEDIUM** (fake/placeholder data not explicitly forbidden) → ADVISORY. Flag prominently but do not block.
   - **LOW** (minor placeholder like "Coming soon") → ADVISORY.

If `.omni/sdlc/content-source.md` does not exist, skip P5 silently.

**Step 3: Feature Verification (per completed task)**
For EACH completed `- [x]` task in `.omni/sdlc/todo.md`, verify it works:

- **API endpoints:** Use `curl` or a script to hit the endpoint, check status code + response shape.
- **UI features:** Start dev server (`npm run dev`), open in browser, test the golden path + one edge case. Use Playwright/browser tool if available.
- **Database changes:** Verify migrations run, schema matches expectation (`npx prisma db push --dry-run`, or equivalent).
- **Logic/utils:** Write a quick smoke test or run in REPL to confirm output.
- **Config/env:** Verify the app starts with the expected configuration.

For each task, record:
- Task description (from .omni/sdlc/todo.md)
- Verification method used
- Result: PASS / FAIL / SKIP (with reason)
- If FAIL: specific error or unexpected behavior

**Step 4: Generate Test Report**
Output `.omni/sdlc/test-report.md`. Keep it terse — 1 line per PASS, details only on FAIL.

```markdown
# Test Report — [date]

## Pipeline
P0: PASS — ran: `npm audit --audit-level=high`
P1: PASS — ran: `npm run lint --silent`
P2: PASS — ran: `npm run build --silent`
P3: PASS — ran: `npm test -- --silent` (12/12)
P4: PASS — ran: `npx depcheck`

## Feature Verification
| # | Task | Method | Result |
|---|------|--------|--------|
| 1 | [task] | `curl -s localhost:3000/api/x` | PASS |
| 2 | [task] | browser: clicked X, saw Y | PASS |
| 3 | [task] | `node -e "..."` | FAIL: [1-line error] |

## Summary
Passed: Y/Z | Failed: N | Blocked: M
[If FAIL] → >om:fix | [If all PASS] → >om:doc
```

**Report rules:**
- Pipeline: each line MUST include the exact CLI command ran. No command = invalid PASS.
- PASS lines: 1 line only. Do NOT paste command output.
- FAIL lines: add 1-line error summary. Full stack traces go to terminal, NOT to the report.
- Feature verification Method column: must be a concrete action (`curl`, `browser`, `node -e`), not "read code".

**Step 5: Auto Fix/Check Loop**
When >om:check is triggered automatically from >om:cook's quality gate:
- If ANY blocking check (P0–P3) or feature verification FAILS:
  1. Automatically execute [>om:fix] with the failures from `.omni/sdlc/test-report.md`. No user prompt needed.
  2. After >om:fix completes, re-run >om:check from Step 2.
  3. Repeat until all checks PASS or **max 3 fix attempts** reached.
  4. If max attempts reached and errors remain:
     - Mark the failing task as `- [ ] [BLOCKED] ...` in `.omni/sdlc/todo.md`.
     - STOP and escalate:
       ```
       ⚠️ Quality Gate — 3 fix attempts exhausted.
          [BLOCKED] task: [task description]
          Tried: 1) [what you tried] 2) [what you tried] 3) [what you tried]
          Cần review thủ công từ người dùng.
       ```
- If all checks PASS: return control to >om:cook for the next cycle (or finish if cycle 3).

**Rules:**
- **No command = No PASS.** Every P0-P3 verdict requires a shell command with exit code. "Code looks correct" is NOT verification.
- **Quiet execution.** Use `--silent`, `-q`, `--quiet`, `2>&1 | tail -n` to minimize terminal output in context. Only capture what determines PASS/FAIL.
- If you cannot test something (e.g., needs real API key, hardware), mark SKIP with the reason.
- If the project has no test framework set up, recommend one appropriate for the stack but do NOT install it without asking.
- For UI: you MUST start the dev server and interact with the feature. Screenshots or browser tool output count as evidence.
- Keep the report factual. No opinions, no suggestions — just what works and what doesn't.
- **[BLOCKED] protocol:** If a task fails 3 fix attempts, mark it `[BLOCKED]` in .omni/sdlc/todo.md with a summary of what was tried. Do NOT continue fixing it.

{{partial:verification-qa}}
