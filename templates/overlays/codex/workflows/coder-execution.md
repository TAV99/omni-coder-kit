## CODEX CODER WORKFLOW (SURGICAL TASK EXECUTION)

When executing `>om:cook` in Codex CLI, act as a Senior Developer. Implement tasks from `.omni/sdlc/todo.md` one at a time unless the user explicitly asks for subagent delegation.

### Step 1: Load Context

- Read `.omni/sdlc/todo.md` and identify the next unchecked task.
- Read `.omni/sdlc/design-spec.md` for architecture and constraints.
- Read relevant files before editing. Do not assume file structure.
- If the task has `@skill:name` tags, load the installed skill instructions before coding.
- If `.omni/knowledge/project-map.md` exists, read it first to understand project structure. Warn if Age > 7 days.
- If `.omni/sdlc/todo.md` does not exist, stop and tell the user to run `>om:plan` first.

### Step 2: Dev Server Preflight (MANDATORY CHECKPOINT)
You MUST complete this step and report the result BEFORE writing any code.
1. Detect dev command:
   - `package.json` → scripts `dev`, `start`, or `serve` (prefer in that order)
   - `docker-compose.yml` → web/app service with exposed ports
   - `Makefile` → target `dev` or `serve`
   - `manage.py` → `python manage.py runserver`
2. If a command is found:
   a. Install dependencies if missing (e.g. `node_modules/` absent).
   b. Run the dev server as a background process.
   c. Wait up to 5 seconds for the server to print a URL.
   d. If the sandbox blocks the server (network or port restriction), report and skip.
3. Report to user (REQUIRED — pick one):
   - `🟢 Dev server: <command> → <URL>` (running)
   - `🟡 Dev server: skipped — no dev command found` (no UI project)
   - `🟡 Dev server: skipped — sandbox restriction` (Codex sandbox blocked)
   - `🔴 Dev server: <command> failed — <reason>` (error, continue anyway)
4. Only after printing one of the above lines may you proceed to Step 3.

### Step 3: Codex Safety Preflight

- Respect the active Codex sandbox mode and approval policy.
- Do not attempt network operations such as `npm install`, `curl`, or `git push` unless the current sandbox/profile allows them or the user explicitly authorizes them.
- Do not use destructive commands such as `rm -rf`, `git reset --hard`, or force push without explicit user instruction.
- If a command fails because of sandbox or approval limits, explain the needed command and ask the user to rerun with an appropriate Codex profile or approval.

### Step 4: Execute One Task

Before editing: run `git diff --stat`. If uncommitted changes exist from a prior task, commit or stash first.
For the current task:

1. State the task and which files will be affected (scope declaration).
2. Scope lock: only create/modify files declared in 4.1. No cleanup, no refactoring, no "improvements".
3. Make the smallest code change that satisfies the task.
4. Run the narrowest useful verification command.
5. Mark the task done in `.omni/sdlc/todo.md` by changing `- [ ]` to `- [x]`.
6. Report files changed, verification result, and next task.

### Step 5: Subagents

Use Codex subagents only when all conditions are true:

- The user explicitly asks for subagents, parallel agents, or delegation.
- At least two remaining tasks are independent.
- The tasks have disjoint write scopes.
- The next local step is not blocked on the delegated result.

When using subagents, define each agent's owned files and tell agents they are not alone in the codebase. Review their changes before integrating.

### Step 6: Quality Gate

The project runs exactly 3 quality cycles:

1. Count total task checkboxes in `.omni/sdlc/todo.md`.
2. Compute `checkpoint = ceil(total / 3)`.
3. After each checkpoint, run `>om:check`.
4. If blocking failures exist, run `>om:fix`, then rerun `>om:check`.
5. Max 3 fix attempts per cycle. If still failing: mark task `[BLOCKED]` in `.omni/sdlc/todo.md`, escalate to user, skip and continue.

### Rules

- **Surgical Context:** For files > 200 lines, use grep/search to locate target code first. Read only the relevant section, not the entire file.
- Keep edits surgical.
- Do not refactor unrelated code.
- Do not batch unrelated tasks.
- Skip tasks marked `[BLOCKED]` — do not attempt to fix them.
- Do not claim completion without fresh verification output.

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
