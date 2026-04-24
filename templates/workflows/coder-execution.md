## CODER AGENT WORKFLOW (SURGICAL TASK EXECUTION)
When executing the [>om:cook] command, you MUST act as a Senior Developer. Your job is to implement tasks from `todo.md` one by one, using Surgical Changes.

**Step 1: Load Context**
- Read `todo.md`. Identify the NEXT uncompleted task (`- [ ]`).
- Read `design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
- **Load skill:** If the task has `@skill:skill-name` tag(s), read the corresponding skill file(s) from `.agents/skills/` or `.claude/skills/` and apply those rules during implementation.
- **Infra pre-check:** If `setup.sh` exists in the project root, verify infrastructure is ready before coding:
  - Check: Docker running? DB accessible? `.env` exists? Dependencies installed?
  - If any check fails → STOP. Tell the user: "Chạy `bash setup.sh` trước khi tiếp tục >om:cook."
  - If all checks pass or `setup.sh` does not exist → proceed normally.
*CRITICAL: If `todo.md` does not exist, STOP. Tell the user to run `>om:plan` first.*

**Step 2: Execute ONE Task at a Time**
For the current task:
1. State what you will do and which files will be affected.
2. Write the minimum code to complete the task. Follow the Simplicity First principle.
3. Use Surgical Changes — touch only what the task requires.
4. After writing code, verify it works (compile check, quick test, or logical validation).
5. Mark the task as done: change `- [ ]` to `- [x]` in `todo.md`.

**Step 3: Report & Auto-Continue**
After completing a task, report:
```
✅ [Task description] — Done
   Files changed: [list]
   Progress: [completed]/[total] tasks (Cycle [1|2|3]/3)
   Next task: [next uncompleted task from todo.md]
```
Then evaluate the result:
- **Auto-continue (default):** If the task completed without errors, or only has minor/non-blocking issues — proceed to the next `- [ ]` task immediately. Do NOT ask for confirmation.
- **STOP and ask:** Only pause when encountering:
  - Build/compile errors that block subsequent tasks
  - Breaking changes to shared interfaces (API contracts, DB schema, shared types)
  - Security vulnerabilities introduced
  - Task ambiguity that could lead the project in the wrong direction
  - Dependency conflicts that affect multiple tasks
- If user says stop at any point, summarize progress (X/Y tasks completed).

**Step 4: Quality Gate — Auto Check/Fix Cycle**
The project runs exactly **3 quality cycles**. Each cycle triggers after completing 1/3 of total tasks:
1. On first launch, count total tasks (`- [ ]` + `- [x]`) in `todo.md` → compute `checkpoint = ceil(total / 3)`.
2. Track `cycle` counter (1, 2, 3) across the session.
3. After every `checkpoint` tasks completed in the current cycle:
   ```
   🔄 Quality Gate — Cycle [N]/3 reached ([X]/[total] tasks done)
      Auto-triggering >om:check...
   ```
   - Automatically execute the [>om:check] workflow (inline, no user prompt needed).
   - If >om:check finds errors → automatically execute [>om:fix] → re-run [>om:check]. Repeat until all blocking errors are resolved (max 3 fix attempts per cycle).
   - Once >om:check passes (or max fix attempts reached), resume >om:cook for the next batch.
4. After cycle 3 completes and >om:check passes:
   ```
   ✅ All 3 quality cycles complete. [total] tasks done.
      Project ready for >om:doc.
   ```

**Rules:**
- ONE task at a time. Do not batch multiple tasks unless the user explicitly asks.
- Follow the tech stack rules from `design-spec.md` and any installed skills.
- If a task is blocked (depends on something not yet built), SKIP it and move to the next non-blocked task. Note the skip reason.
- If a task is ambiguous, ASK before implementing. Do not guess.
- Do NOT refactor, optimize, or "improve" code beyond what the task specifies.
- Quality gate cycles are mandatory — do NOT skip them even if all tasks look correct.