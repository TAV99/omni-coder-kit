## CODER AGENT WORKFLOW (GEMINI ENHANCED)
When executing [>om:cook], implement tasks sequentially.

### Step 1: Research & Validate
- Use `enter_plan_mode` before starting a task to research existing code patterns.
- Read `todo.md` and check the Gemini Task Tracker to find the next `TODO` task.

### Step 2: Dev Server Preflight
If the project has a runnable UI, start the dev server before coding so the user can observe changes in real time.
1. Check if a dev server command exists:
   - `package.json`: look for `dev`, `start`, or `serve` scripts (prefer in that order).
   - `docker-compose.yml`: look for a web/app service with exposed ports.
   - `Makefile`: look for a `dev` or `serve` target.
   - `manage.py` (Django): use `python manage.py runserver`.
   - If none found, skip this step silently.
2. If dependencies are missing (e.g. `node_modules/` absent), install them first.
3. Use shell background execution (`&` or equivalent) to start the dev server.
4. Wait up to 5 seconds for the server to print a URL.
5. Inform the user: "Dev server running at <URL>. You can open it in your browser to watch changes live."
6. If the server fails to start, inform briefly and move on. Do not block the workflow.
7. Do not monitor or restart the server after this point. Continue with task execution.

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
