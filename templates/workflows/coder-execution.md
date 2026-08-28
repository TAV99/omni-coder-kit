## CODER AGENT WORKFLOW (SURGICAL TASK EXECUTION)
When executing the [>om-cook] command, you MUST act as a Senior Developer. Your job is to implement tasks from `.omni/sdlc/todo.md` one by one, using Surgical Changes.

**Step 1: Load Context**
- Read `.omni/sdlc/todo.md`. Identify the NEXT uncompleted task (`- [ ]`).
- Read `.omni/sdlc/design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
- **Load skill (MANDATORY TOOL CALL):** You MUST call your file reading tool (`view_file` or `read_file`) to open and read `.agents/skills/executing-plans/SKILL.md`, `.agents/skills/test-driven-development/SKILL.md`, and `.agents/skills/karpathy-guidelines/SKILL.md` to guide your overall implementation methodology. Additionally, for any task with `@skill:skill-name` tag(s), you MUST call your file reading tool (`view_file` or `read_file`) to open and inspect the exact file at `.agents/skills/<skill-name>/SKILL.md` BEFORE writing code for that task. Do NOT rely on memory — inspect the current file directly.
- **Knowledge base:** If `.omni/knowledge/knowledge-base.md` exists, scan it for entries matching the current task's files. Apply relevant lessons.
- **Project Map:** If `.omni/knowledge/project-map.md` exists, read it FIRST — use it to locate relevant files instead of scanning the full codebase. If the map header shows Age > 7 days, warn: "⚠️ Project Map cũ [N] ngày. Chạy `omni map --refresh` để cập nhật." If map has `[PENDING]` or `[NEW]` markers for files you touch during this task, fill them in opportunistically.
- **Content source:** If `.omni/sdlc/content-source.md` exists, read it. Use `## Facts` as ground truth for any user-facing text. Check `## Forbidden Content` before writing copy, labels, or descriptions. Do NOT generate content that contradicts these facts. If the project has UI files (HTML, JSX, TSX, Vue, Svelte) but `.omni/sdlc/content-source.md` is missing, warn: "⚠️ UI project without .omni/sdlc/content-source.md — run `>om-think` to generate it. Content accuracy cannot be verified."
- **Setup preflight:** If `.omni/sdlc/setup.json` exists, run `omni dual setup run` before making source edits to ensure dependencies and setup actions are ready (the CLI is idempotency-aware; never inspect or invoke shell scripts).
  - Require a matching `SUCCESS receipt` for the current setup manifest. The runner may self-heal only the exact `native` package-manager kind mismatch; it never falls back to shell scripts.
  - If setup fails or reports BLOCKED → STOP safely and report the exact failing action and error to the user.
  - In Dual AUTO, require an active Dual session/authority and registered full graph before any source edit, build, browser mutation, or dev-server launch. If authority is absent, require `.omni/sdlc/dual-plan.json` and call `omni dual bootstrap --json`; do not invent temporary planning tasks or call low-level begin/register operations.
  - Legacy planning-only session adoption is handled by `omni dual bootstrap`. Never delete/overwrite the old ledger. If bootstrap returns `DUAL_BOOTSTRAP_ADOPTION_UNSAFE`, STOP as BLOCKED.
  - If setup succeeds with its receipt (or `.omni/sdlc/setup.json` does not exist) and Dual authority is active when required → proceed normally.
*CRITICAL: If `.omni/sdlc/todo.md` does not exist, STOP. Tell the user to run `>om-plan` first.*

**Step 2: Dev Server Preflight (MANDATORY CHECKPOINT)**
You MUST complete this step and report the result BEFORE writing any code in Step 3.
1. Detect dev command:
   - `package.json` → scripts `dev`, `start`, or `serve` (prefer in that order)
   - `docker-compose.yml` → web/app service with exposed ports
   - `Makefile` → target `dev` or `serve`
   - `manage.py` → `python manage.py runserver`
2. If a command is found:
   a. Never install missing dependencies ad hoc. If dependencies are missing (e.g. `node_modules/` absent), they must already be represented in `.omni/sdlc/setup.json` and executed through `omni dual setup run`. If missing dependencies were not declared in the setup manifest, STOP fail-closed and return a precise blocker so the plan/setup manifest can be revised; do not guess a package manager, do not invoke shell, and do not directly run package installation.
   b. Run the dev server as a background process.
   c. Wait up to 5 seconds for the server to print a URL.
3. Report to user (REQUIRED — pick one):
   - `🟢 Dev server: <command> → <URL>` (running)
   - `🟡 Dev server: skipped — no dev command found` (no UI project)
   - `🔴 Dev server: <command> failed — <reason>` (error, continue anyway)
4. Only after printing one of the above lines may you proceed to Step 3.

**Step 3: Execute ONE Task at a Time**
Before editing: run `git diff --stat`. If uncommitted changes exist, report pre-existing changes and work surgically within the declared task scope; do not commit, stash, or reset automatically.
For the current task:
1. State what you will do and which files will be affected (scope declaration).
2. Scope lock: only create/modify files declared in 3.1. Zero exceptions — no cleanup, no refactoring, no "improvements".
3. Write the minimum code to complete the task. Follow the Simplicity First principle.
4. Local Syntax Verification: Before completing the task, run a quick syntax check, linter, typecheck, or local dry-run (e.g. npm run lint, eslint, eslint --fix, python -m py_compile, or local dev server check) on the modified files to catch basic issues like missing brackets or wrong imports early.
5. **Doubt Gate (non-trivial tasks only):** before marking done, if this task meets a non-trivial trigger (branching logic, boundary crossing, unverifiable invariant, irreversible blast radius — see Doubt Gate below), run the doubt cycle. For irreversible/security-sensitive changes, escalate instead of self-reviewing. Trivial tasks skip this.
6. Mark the task as done: change `- [ ]` to `- [x]` in `.omni/sdlc/todo.md`.

**Step 4: Report & Auto-Continue**
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

**Step 5: Quality Gate — Auto Check/Fix Cycle**
The project runs exactly **3 quality cycles**. Each cycle triggers after completing 1/3 of total tasks:
1. On first launch, count total tasks (`- [ ]` + `- [x]`) in `.omni/sdlc/todo.md` → compute `checkpoint = ceil(total / 3)`.
2. Track `cycle` counter (1, 2, 3) across the session.
3. After every `checkpoint` tasks completed in the current cycle:
   ```
   🔄 Quality Gate — Cycle [N]/3 reached ([X]/[total] tasks done)
      Auto-triggering >om-check...
   ```
   - Automatically execute the [>om-check] workflow (inline, no user prompt needed).
   - If >om-check finds errors → automatically execute [>om-fix] → re-run [>om-check]. Max 3 fix attempts per cycle.
   - If max attempts reached: mark failing task `[BLOCKED]` in `.omni/sdlc/todo.md`, escalate to user, then resume >om-cook for the next batch (skipping blocked tasks).
   - Once >om-check passes, resume >om-cook for the next batch.
4. After cycle 3 completes and >om-check passes:
   - In Dual Authority mode: Execute `omni dual qc --json` to automatically submit task QC evidence, calculate snapshot diff fingerprint, record all 3 quality cycles, and obtain the cryptographic verification receipt.
   ```
   ✅ All 3 quality cycles complete. [total] tasks done.
      Project ready for >om-doc.
   ```

**Rules:**
- ONE task at a time. Do not batch multiple tasks unless the user explicitly asks.
- **Surgical Edits:** Strongly prefer scoped edit tools (like `replace_file_content` or `multi_replace_file_content`) to modify files rather than completely overwriting them (using `write_to_file` with `Overwrite:true`), especially for large files. Overwriting full files wastes tokens, causes latency, and risks erasing existing working logic or introducing regressions.
- **Surgical Context:** For files > 200 lines, use grep/search to locate target code first. Read only the relevant section (±20 lines around target), not the entire file.
- Follow the tech stack rules from `.omni/sdlc/design-spec.md` and any installed skills.
- If a task is blocked (depends on something not yet built) or marked `[BLOCKED]`, SKIP it and move to the next non-blocked task. Note the skip reason.
- If a task is ambiguous, ASK before implementing. Do not guess.
- Do NOT refactor, optimize, or "improve" code beyond what the task specifies.
- Quality gate cycles are mandatory — do NOT skip them even if all tasks look correct.

{{partial:tdd-verification}}

{{partial:doubt-gate}}
