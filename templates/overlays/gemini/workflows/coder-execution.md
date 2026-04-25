## CODER AGENT WORKFLOW (GEMINI ENHANCED)
When executing [>om:cook], implement tasks sequentially.

### Step 1: Research & Validate
- Use `enter_plan_mode` before starting a task to research existing code patterns.
- Read `todo.md` and check the Gemini Task Tracker to find the next `TODO` task.

### Step 2: Implementation
- For the active task, use `tracker_update_task` to set status to `IN_PROGRESS`.
- Follow the Surgical Changes mandate.
- Apply rules from `@skill` tags.

### Step 3: Verification & Update
- After finishing a task, run local verification.
- Use `tracker_update_task` to set status to `DONE`.
- Mark task as `- [x]` in `todo.md`.

### Quality Gate triggers
- Every 1/3 tasks (calculated from `save_memory` project data), automatically pause and run `>om:check`.
- If `>om:check` fails, run `>om:fix`.
