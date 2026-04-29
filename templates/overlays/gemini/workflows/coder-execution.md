## CODER AGENT WORKFLOW — GEMINI CLI ENHANCED (TASK TRACKER INTEGRATION)
When executing [>om:cook], you MUST act as a Senior Developer. Your job is to implement tasks from `.omni/sdlc/todo.md` one by one, using Gemini CLI native tools for tracking and memory.

### Step 1: Load Context
- Read `.omni/sdlc/todo.md` via `read_file`. Identify the NEXT uncompleted task (`- [ ]`).
- Read `.omni/sdlc/design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
- **Load skill:** If the task has `@skill:skill-name` tag(s), read the corresponding skill file(s) and apply those rules during implementation.
- **Knowledge base:** If `.omni/knowledge/knowledge-base.md` exists, scan it for entries matching the current task's files. Apply relevant lessons.
- **Project Map:** If `.omni/knowledge/project-map.md` exists, read it FIRST via `read_file`. Use ## Structure to navigate instead of scanning. Warn if Age > 7 days. Fill `[PENDING]`/`[NEW]` markers opportunistically for files touched during tasks.
- **Content source:** If `.omni/sdlc/content-source.md` exists, read it. Use `## Facts` as ground truth for any user-facing text. Check `## Forbidden Content` before writing copy, labels, or descriptions. Do NOT generate content that contradicts these facts. If the project has UI files (HTML, JSX, TSX, Vue, Svelte) but `.omni/sdlc/content-source.md` is missing, warn: "⚠️ UI project without .omni/sdlc/content-source.md — run `>om:brainstorm` to generate it. Content accuracy cannot be verified."
- **Infra pre-check:** If `setup.sh` exists in the project root, verify infrastructure is ready before coding:
  - Check: Docker running? DB accessible? `.env` exists? Dependencies installed?
  - If any check fails → STOP. Tell the user: "Chạy `bash setup.sh` trước khi tiếp tục >om:cook."
  - If all checks pass or `setup.sh` does not exist → proceed normally.
- **Gemini Task Tracker sync:** Use `tracker_create_task` to register the current task if not already tracked.
*CRITICAL: If `.omni/sdlc/todo.md` does not exist, STOP. Tell the user to run `>om:plan` first.*

### Step 2: Dev Server Preflight (MANDATORY CHECKPOINT)
You MUST complete this step and report the result BEFORE writing any code in Step 3.
1. Detect dev command:
   - `package.json` → scripts `dev`, `start`, or `serve` (prefer in that order)
   - `docker-compose.yml` → web/app service with exposed ports
   - `Makefile` → target `dev` or `serve`
   - `manage.py` → `python manage.py runserver`
2. If a command is found:
   a. Install dependencies if missing (e.g. `node_modules/` absent).
   b. Use shell background execution (`&` or equivalent) to start the dev server.
   c. Wait up to 5 seconds for the server to print a URL.
3. Report to user (REQUIRED — pick one):
   - `🟢 Dev server: <command> → <URL>` (running)
   - `🟡 Dev server: skipped — no dev command found` (no UI project)
   - `🔴 Dev server: <command> failed — <reason>` (error, continue anyway)
4. Only after printing one of the above lines may you proceed to Step 3.

### Step 3: Research & Plan
- Use `enter_plan_mode` before starting a task to research existing code patterns.
- **Surgical Context:** For files > 200 lines, use search tools to locate target code first. Read only the relevant section, not the entire file.
- Plan the minimal set of changes needed. Declare scope: which files will be created or modified.

### Step 4: Implementation
Before editing: run `git diff --stat`. If uncommitted changes exist from a prior task, commit or stash first.
- Use `tracker_update_task` to set the active task status to `IN_PROGRESS`.
- Scope lock: only create/modify files declared in Step 3. Zero exceptions — no cleanup, no refactoring, no "improvements".
- Write the minimum code to complete the task. Follow the Simplicity First principle.
- Apply rules from `@skill` tags.
- After writing code, verify it works (compile check, quick test, or logical validation).

### Step 5: Verification & Update
- Run local verification (test, lint, type-check as appropriate).
- Use `tracker_update_task` to set status to `DONE`.
- Mark task as `- [x]` in `.omni/sdlc/todo.md`.
- Use `save_memory` to record progress data (tasks completed, current cycle).

### Step 6: Report & Auto-Continue
After completing a task, report:
```
✅ [Task description] — Done
   Files changed: [list]
   Progress: [completed]/[total] tasks (Cycle [1|2|3]/3)
   Next task: [next uncompleted task from .omni/sdlc/todo.md]
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

### Step 7: Quality Gate — Auto Check/Fix Cycle
The project runs exactly **3 quality cycles**. Each cycle triggers after completing 1/3 of total tasks:
1. On first launch, count total tasks (`- [ ]` + `- [x]`) in `.omni/sdlc/todo.md` → compute `checkpoint = ceil(total / 3)`.
2. Track `cycle` counter (1, 2, 3) via `save_memory`.
3. After every `checkpoint` tasks completed in the current cycle:
   ```
   🔄 Quality Gate — Cycle [N]/3 reached ([X]/[total] tasks done)
      Auto-triggering >om:check...
   ```
   - Automatically execute the [>om:check] workflow (inline, no user prompt needed).
   - If >om:check finds errors → automatically execute [>om:fix] → re-run [>om:check]. Max 3 fix attempts per cycle.
   - If max attempts reached: mark failing task `[BLOCKED]` in `.omni/sdlc/todo.md`, use `tracker_update_task` to set status `BLOCKED`, escalate to user, skip and continue.
   - Once >om:check passes, resume >om:cook for the next batch.
4. After cycle 3 completes and >om:check passes:
   ```
   ✅ All 3 quality cycles complete. [total] tasks done.
      Project ready for >om:doc.
   ```

### Rules
- ONE task at a time. Do not batch multiple tasks unless the user explicitly asks.
- **Surgical Context:** For files > 200 lines, use search tools to locate target code first. Read only the relevant section (±20 lines around target), not the entire file.
- Follow the tech stack rules from `.omni/sdlc/design-spec.md` and any installed skills.
- If a task is blocked (depends on something not yet built) or marked `[BLOCKED]`, SKIP it and move to the next non-blocked task. Note the skip reason.
- If a task is ambiguous, ASK before implementing. Do not guess.
- Do NOT refactor, optimize, or "improve" code beyond what the task specifies.
- Quality gate cycles are mandatory — do NOT skip them even if all tasks look correct.

**TDD Discipline — Test-Driven Development:**
Before writing production code, follow Red-Green-Refactor:

| Step | Action | Verify |
|------|--------|--------|
| RED | Write ONE failing test for the next behavior | Run test — must FAIL (feature missing, not typo) |
| GREEN | Write minimal code to pass | Run test — PASS. All other tests still pass. |
| REFACTOR | Clean up (duplication, names) | All tests still green |

Iron Law: No production code without a failing test first. Wrote code before test? Delete it. Start over.
Good tests: Minimal (one behavior), Clear (name = behavior), Real (no mocks unless unavoidable).
Reject: "Too simple to test" → 30 seconds. "Test after" → proves nothing. "TDD slows me down" → faster than debugging.

**Verification Discipline — Evidence Before Claims:**
Before claiming ANY task is complete:
1. IDENTIFY what command proves the claim
2. RUN the command fresh
3. READ output, check exit code
4. Only THEN claim the result

"Should work", "probably passes", "looks correct" = NOT verified. Run the command.
