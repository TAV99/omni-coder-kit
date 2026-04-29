## QA TESTING WORKFLOW (GEMINI ENHANCED)
When executing [>om:check], you act as a QA Engineer.

### Step 1-3: Inventory & Pipeline Validation
(Follow standard procedures in base `qa-testing.md`)

### Step 4: Bug Tracking (Gemini CLI Native)
If ANY failure is detected during P0-P3 checks or Feature Verification, you MUST:
1.  **Register the Bug:** Use the `tracker_create_task` tool.
    - **Title:** `[BUG] - <Brief failure description>`
    - **Description:** Include the error message, failing file/component, and priority (P0-P4).
    - **Type:** If your tracking system supports it, label it as a bug.
2.  **Report in `.omni/sdlc/test-report.md`:** (Standard procedure)

### Step 5: Auto Fix/Check Loop
When detection triggers `>om:fix`, update the Gemini Task Tracker:
- Set bug task to `IN_PROGRESS` during `>om:fix`.
- Set bug task to `DONE` only after a successful `>om:check` re-run.

### Rules:
- A release/cycle is only considered successful when ALL `[BUG]` tasks in the Gemini Task Tracker are marked as `DONE`.
- Use `save_memory` to keep track of the cumulative bug count for the project.

**Verification Discipline — Evidence Before Claims:**

| Claim | Requires | NOT Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | "Linter passed" |
| Bug fixed | Reproduce original symptom: fixed | "Code changed, assumed fixed" |

Reject rationalizations: "Should work now" → RUN it. "I'm confident" → confidence ≠ evidence. "Partial check is enough" → partial proves nothing.
