## CODEX CODER WORKFLOW (SURGICAL TASK EXECUTION)

When executing `>om:cook` in Codex CLI, act as a Senior Developer. Implement tasks from `todo.md` one at a time unless the user explicitly asks for subagent delegation.

### Step 1: Load Context

- Read `todo.md` and identify the next unchecked task.
- Read `design-spec.md` for architecture and constraints.
- Read relevant files before editing. Do not assume file structure.
- If the task has `@skill:name` tags, load the installed skill instructions before coding.
- If `todo.md` does not exist, stop and tell the user to run `>om:plan` first.

### Step 2: Dev Server Preflight

If the project has a runnable UI, start the dev server before coding so the user can observe changes in real time.

1. Check if a dev server command exists:
   - `package.json`: look for `dev`, `start`, or `serve` scripts (prefer in that order).
   - `docker-compose.yml`: look for a web/app service with exposed ports.
   - `Makefile`: look for a `dev` or `serve` target.
   - `manage.py` (Django): use `python manage.py runserver`.
   - If none found, skip this step silently.
2. If dependencies are missing (e.g. `node_modules/` absent), install them first.
3. Run the dev server as a background process.
4. Wait up to 5 seconds for the server to print a URL.
5. Inform the user: "Dev server running at <URL>. You can open it in your browser to watch changes live."
6. If the sandbox blocks the server (network or port restriction), inform the user and skip this step.
7. Do not monitor or restart the server after this point. Continue with task execution.

### Step 3: Codex Safety Preflight

- Respect the active Codex sandbox mode and approval policy.
- Do not attempt network operations such as `npm install`, `curl`, or `git push` unless the current sandbox/profile allows them or the user explicitly authorizes them.
- Do not use destructive commands such as `rm -rf`, `git reset --hard`, or force push without explicit user instruction.
- If a command fails because of sandbox or approval limits, explain the needed command and ask the user to rerun with an appropriate Codex profile or approval.

### Step 4: Execute One Task

For the current task:

1. State the task and likely files affected.
2. Make the smallest code change that satisfies the task.
3. Run the narrowest useful verification command.
4. Mark the task done in `todo.md` by changing `- [ ]` to `- [x]`.
5. Report files changed, verification result, and next task.

### Step 5: Subagents

Use Codex subagents only when all conditions are true:

- The user explicitly asks for subagents, parallel agents, or delegation.
- At least two remaining tasks are independent.
- The tasks have disjoint write scopes.
- The next local step is not blocked on the delegated result.

When using subagents, define each agent's owned files and tell agents they are not alone in the codebase. Review their changes before integrating.

### Step 6: Quality Gate

The project runs exactly 3 quality cycles:

1. Count total task checkboxes in `todo.md`.
2. Compute `checkpoint = ceil(total / 3)`.
3. After each checkpoint, run `>om:check`.
4. If blocking failures exist, run `>om:fix`, then rerun `>om:check`.
5. Repeat fixes up to 3 times per cycle before escalating to the user.

### Rules

- Keep edits surgical.
- Do not refactor unrelated code.
- Do not batch unrelated tasks.
- Do not claim completion without fresh verification output.
