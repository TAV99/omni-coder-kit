## CODER AGENT WORKFLOW — CURSOR ENHANCED (AGENT MODE + YOLO-AWARE)
When executing the [>om:cook] command, you MUST act as a Senior Developer. Your job is to implement tasks from `.omni/sdlc/todo.md` one by one.

**Step 1: Load Context**
- Read `.omni/sdlc/todo.md`. Identify the NEXT uncompleted task (`- [ ]`).
- Read `.omni/sdlc/design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
- **Load skill:** If the task has `@skill:skill-name` tag(s), read the corresponding skill file(s) and apply those rules during implementation.
- **Knowledge base:** If `.omni/knowledge/knowledge-base.md` exists, scan it for entries matching the current task's files. Apply relevant lessons.
- **Project Map:** If `.omni/knowledge/project-map.md` exists, read it with @Files FIRST — use ## Structure and ## Key Patterns to locate relevant code instead of using @Codebase blindly. Warn if Age > 7 days.
- **Content source:** If `.omni/sdlc/content-source.md` exists, read it with @Files. Use `## Facts` as ground truth for any user-facing text. Check `## Forbidden Content` before writing copy. Do NOT generate content that contradicts these facts. If the project has UI files but `.omni/sdlc/content-source.md` is missing, warn: "⚠️ UI project without .omni/sdlc/content-source.md — run `>om:brainstorm` to generate it."
- **Infra pre-check:** If `setup.sh` exists in the project root, verify infrastructure is ready before coding:
  - Check: Docker running? DB accessible? `.env` exists? Dependencies installed?
  - If any check fails → STOP. Tell the user: "Run `bash setup.sh` before continuing >om:cook."
  - If all checks pass or `setup.sh` does not exist → proceed normally.
*CRITICAL: If `.omni/sdlc/todo.md` does not exist, STOP. Tell the user to run `>om:plan` first.*

**Step 2: Dev Server Preflight (MANDATORY CHECKPOINT)**
You MUST complete this step and report the result BEFORE writing any code in Step 3.
1. Detect dev command:
   - `package.json` → scripts `dev`, `start`, or `serve` (prefer in that order)
   - `docker-compose.yml` → web/app service with exposed ports
   - `Makefile` → target `dev` or `serve`
   - `manage.py` → `python manage.py runserver`
2. If a command is found:
   a. Install dependencies if missing (e.g. `node_modules/` absent).
   b. Run the dev server as a background process.
   c. Wait up to 5 seconds for the server to print a URL.
3. Report to user (REQUIRED — pick one):
   - `🟢 Dev server: <command> → <URL>` (running)
   - `🟡 Dev server: skipped — no dev command found` (no UI project)
   - `🔴 Dev server: <command> failed — <reason>` (error, continue anyway)
4. Only after printing one of the above lines may you proceed to Step 3.

**Step 3: Cursor Context Gathering**
Before editing any file for the current task:
- Use @Codebase to scan overall architecture if this is the first task.
- Use @Files to read all files relevant to this specific task.
- Use @Git to check recent changes in the area you're about to modify.
- Use @Docs to verify API/library usage when using external dependencies.

**Step 4: YOLO Mode Awareness**
When running in YOLO mode (auto-approve terminal commands):
- ✅ AUTO-RUN: lint, type-check, test, build, dev server, git status/diff/log
- ⚠️ WARN FIRST: git commit, npm install, file deletion
- 🚫 ALWAYS ASK: git push, git reset --hard, rm -rf, database mutations

When NOT in YOLO mode, ask for confirmation before any terminal command.

**Step 5: Execute ONE Task at a Time**
Before editing: run `git diff --stat`. If uncommitted changes exist from a prior task, commit or stash first.
For the current task:
1. State what you will do and which files will be affected (scope declaration).
2. Scope lock: only create/modify files declared in 5.1. Zero exceptions — no cleanup, no refactoring, no "improvements".
3. Write the minimum code to complete the task. Follow the Simplicity First principle.
4. After writing code, verify it works (compile check, quick test, or logical validation).
5. Mark the task as done: change `- [ ]` to `- [x]` in `.omni/sdlc/todo.md`.

**Multi-File Edit Protocol (Agent Mode):**
When a task requires editing more than 3 files:
1. List ALL files that will change with a one-line description per file.
2. Wait for user confirmation before starting edits.
3. Apply changes in dependency order: shared modules first, consumers last.

**Step 6: Report & Auto-Continue**
After completing a task, report:
```
✅ [Task description] — Done
   Files changed: [list]
   Progress: [completed]/[total] tasks (Cycle [1|2|3]/3)
   Next task: [next uncompleted task from .omni/sdlc/todo.md]
```
Then evaluate the result:
- **Auto-continue (default):** If the task completed without errors — proceed to the next task immediately.
- **STOP and ask:** Only pause when encountering:
  - Build/compile errors that block subsequent tasks
  - Breaking changes to shared interfaces
  - Security vulnerabilities introduced
  - Task ambiguity

**Step 7: Quality Gate — Auto Check/Fix Cycle**
The project runs exactly **3 quality cycles**. Each cycle triggers after completing 1/3 of total tasks:
1. On first launch, count total tasks in `.omni/sdlc/todo.md` → compute `checkpoint = ceil(total / 3)`.
2. Track `cycle` counter (1, 2, 3) across the session.
3. After every `checkpoint` tasks completed in the current cycle:
   ```
   🔄 Quality Gate — Cycle [N]/3 reached ([X]/[total] tasks done)
      Auto-triggering >om:check...
   ```
   - Automatically execute the [>om:check] workflow (no user prompt needed).
   - In Agent mode: auto-run lint and test commands directly.
   - If >om:check finds errors → automatically execute [>om:fix] → re-run [>om:check]. Max 3 fix attempts per cycle.
   - If max attempts reached: mark failing task `[BLOCKED]` in `.omni/sdlc/todo.md`, escalate to user, then resume.
   - Once >om:check passes, resume >om:cook.
4. After cycle 3 completes and >om:check passes:
   ```
   ✅ All 3 quality cycles complete. [total] tasks done.
      Project ready for >om:doc.
   ```

**Rules:**
- ONE task at a time. Do not batch multiple tasks.
- **Surgical Context:** For files > 200 lines, use search to locate target code first. Read only the relevant section.
- Follow the tech stack rules from `.omni/sdlc/design-spec.md` and any installed skills.
- If a task is blocked or marked `[BLOCKED]`, skip it and note the reason.
- If a task is ambiguous, ASK before implementing.
- Do NOT refactor or "improve" code beyond what the task specifies.
- Quality gate cycles are mandatory — do NOT skip them.

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
