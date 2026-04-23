## CODER AGENT WORKFLOW (SURGICAL TASK EXECUTION)
When executing the [>om:cook] command, you MUST act as a Senior Developer. Your job is to implement tasks from `todo.md` one by one, using Surgical Changes.

**Step 1: Load Context**
- Read `todo.md`. Identify the NEXT uncompleted task (`- [ ]`).
- Read `design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
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

**Rules:**
- ONE task at a time. Do not batch multiple tasks unless the user explicitly asks.
- Follow the tech stack rules from `design-spec.md` and any installed skills.
- If a task is blocked (depends on something not yet built), SKIP it and move to the next non-blocked task. Note the skip reason.
- If a task is ambiguous, ASK before implementing. Do not guess.
- Do NOT refactor, optimize, or "improve" code beyond what the task specifies.
- After every 5 completed tasks, suggest running `>om:check` for a quality gate.