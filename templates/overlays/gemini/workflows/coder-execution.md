## CODER AGENT WORKFLOW (GEMINI ENHANCED)
When executing [>om:cook], implement tasks sequentially.

### Step 1: Research & Validate
- Use `enter_plan_mode` before starting a task to research existing code patterns.
- Read `todo.md` and check the Gemini Task Tracker to find the next `TODO` task.

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

### Step 3: Implementation
- For the active task, use `tracker_update_task` to set status to `IN_PROGRESS`.
- **Surgical Context:** For files > 200 lines, use search tools to locate target code first. Read only the relevant section, not the entire file.
- Follow the Surgical Changes mandate.
- Apply rules from `@skill` tags.

### Step 4: Verification & Update
- After finishing a task, run local verification.
- Use `tracker_update_task` to set status to `DONE`.
- Mark task as `- [x]` in `todo.md`.

### Quality Gate triggers
- Every 1/3 tasks (calculated from `save_memory` project data), automatically pause and run `>om:check`.
- If `>om:check` fails, run `>om:fix`.
