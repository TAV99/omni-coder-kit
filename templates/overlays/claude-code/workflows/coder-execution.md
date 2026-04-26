## CODER AGENT WORKFLOW — CLAUDE CODE ENHANCED (PARALLEL SUB-AGENT EXECUTION)
When executing the [>om:cook] command, you MUST act as a Senior Developer and Orchestrator. Your job is to implement tasks from `todo.md` using parallel sub-agents where possible.

**Step 1: Load Context**
- Read `todo.md`. Collect ALL uncompleted tasks (`- [ ]`).
- Read `design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
- **Load skills:** For tasks with `@skill:skill-name` tag(s), note which skill files need to be passed to sub-agents.
- **Content source:** If `content-source.md` exists, read it. Include relevant facts in sub-agent prompts for tasks that generate user-facing text (UI copy, README, landing pages). Pass `## Forbidden Content` rules to ALL sub-agents.
- **Infra pre-check:** If `setup.sh` exists in the project root, verify infrastructure is ready before coding:
  - Check: Docker running? DB accessible? `.env` exists? Dependencies installed?
  - If any check fails → STOP. Tell the user: "Chạy `bash setup.sh` trước khi tiếp tục /om:cook."
  - If all checks pass or `setup.sh` does not exist → proceed normally.
*CRITICAL: If `todo.md` does not exist, STOP. Tell the user to run `/om:plan` first.*

**Step 2: Dev Server Preflight (MANDATORY CHECKPOINT)**
You MUST complete this step and report the result BEFORE writing any code in Step 3.
1. Detect dev command:
   - `package.json` → scripts `dev`, `start`, or `serve` (prefer in that order)
   - `docker-compose.yml` → web/app service with exposed ports
   - `Makefile` → target `dev` or `serve`
   - `manage.py` → `python manage.py runserver`
2. If a command is found:
   a. Install dependencies if missing (e.g. `node_modules/` absent).
   b. Use `Bash(run_in_background)` to start the dev server.
   c. Wait up to 5 seconds for the server to print a URL.
3. Report to user (REQUIRED — pick one):
   - `🟢 Dev server: <command> → <URL>` (running)
   - `🟡 Dev server: skipped — no dev command found` (no UI project)
   - `🔴 Dev server: <command> failed — <reason>` (error, continue anyway)
4. Only after printing one of the above lines may you proceed to Step 3.

**Step 3: Dependency Graph Analysis**
Analyze all uncompleted tasks and build a dependency graph:

1. **Parse tasks** — group by component/module section in `todo.md`.
2. **Identify dependencies** using these rules:
   - **Component order:** DB/Schema → API/Backend → Frontend/UI (earlier layers block later)
   - **Same file:** Two tasks that create or modify the same file → sequential (merge conflict risk)
   - **Import chain:** Task A creates a module/type, Task B imports it → B depends on A
   - **Independent:** Tasks in different components, different files, no import relationship → can run in parallel
3. **Group into batches** — each batch contains tasks that can run simultaneously.
4. **Cap at 4 agents per batch** — to keep resource usage reasonable.

**Step 4: Present Execution Plan**
Before starting, show the user the plan:
```
📊 Dependency Analysis — [N] tasks total

Batch 1 (parallel, [M] agents):
  ├─ Agent A: [Component] Task description
  ├─ Agent B: [Component] Task description
  └─ Agent C: [Component] Task description

Batch 2 (parallel, [M] agents) — blocked by Batch 1:
  ├─ Agent D: [Component] Task description
  └─ Agent E: [Component] Task description

Batch 3 (sequential) — blocked by Batch 2:
  └─ [Component] Task description

Tiến hành? (y/n)
```

Wait for user confirmation before proceeding.

**Step 5: Decide Execution Strategy**
Choose strategy based on conditions:

| Condition | Strategy |
|-----------|----------|
| ≤ 3 tasks total | Sequential — agent overhead not worth it |
| All tasks modify same file | Sequential — guaranteed conflicts |
| Independent tasks exist across files | Parallel (worktree isolation) |
| User says "tuần tự" / "sequential" | Sequential — respect user choice |

**Step 5.5: Build Context Brief (parallel execution only)**
Before spawning sub-agents, build a compact Context Brief (~500 tokens max) to avoid each agent re-reading the same files:

1. **Extract from `design-spec.md`:**
   - Tech Stack (from Summary table)
   - Project type and goal (1 sentence)
   - Data model summary (table names + key fields, not full schemas)

2. **Shared files inventory:**
   - List files that 2+ tasks in the current batch will need (e.g., `globals.css`, `package.json`, `types.ts`)
   - For each shared file, extract the relevant facts (e.g., color tokens from CSS, exported types from types.ts)
   - Do NOT copy entire file contents — extract only what agents need to know

3. **Content source (if exists):**
   - If `content-source.md` exists, include `## Facts` and `## Forbidden Content` verbatim (these are short)

4. **Format:**
   ```
   === CONTEXT BRIEF (shared — do not re-read these files) ===
   Tech: [stack summary]
   Goal: [1 sentence]
   Data: [table1(key_fields), table2(key_fields)]
   Shared: globals.css → [color tokens: primary=#..., bg=#...] | types.ts → [exported: User, Post, Comment]
   Content rules: [facts + forbidden, if content-source.md exists]
   ===
   ```

5. **Pass to agents:** Include this brief at the TOP of each sub-agent's prompt. Instruct agents: "The Context Brief summarizes shared project state. Do NOT re-read files already summarized in the brief — only read files specific to your task that are not covered."

**Step 6a: Parallel Execution (when applicable)**
For each batch:

1. **Spawn sub-agents** — Use the Agent tool with `isolation: "worktree"` for each task in the batch:
   - **subagent_type:** `"general-purpose"`
   - **mode:** `"auto"`
   - **isolation:** `"worktree"`
   - Each agent receives a self-contained prompt with:
     - The Context Brief (from Step 5.5) at the top
     - The specific task description from `todo.md`
     - Relevant excerpt from `design-spec.md` (only sections NOT already in the Context Brief)
     - Content of skill files referenced by `@skill:` tags (read and include inline)
     - Content rules from `content-source.md` (if exists and task generates user-facing text)
     - List of files to create/modify (scope lock — agent must NOT touch other files)
     - Clear success criteria
     - Instruction: "Do NOT re-read files already summarized in the Context Brief above."
   - Launch all agents in the batch simultaneously (multiple Agent calls in one message).

2. **Wait for all agents in batch to complete.**

3. **Review results** — Check each agent's output:
   - If agent succeeded → mark task as `- [x]` in `todo.md`
   - If agent reported errors → note for manual fix or retry

4. **Merge worktrees** — The worktree auto-merges on success. If merge conflicts occur:
   - Attempt automatic resolution for trivial conflicts
   - If unresolvable → report to user with conflict details

5. **Proceed to next batch** after current batch completes.

**Step 6b: Sequential Execution (fallback)**
Before editing: run `git diff --stat`. If uncommitted changes exist from a prior task, commit or stash first.
Same as base workflow — execute ONE task at a time:
1. State what you will do and which files will be affected (scope declaration).
2. Scope lock: only create/modify files declared in 6b.1. Zero exceptions — no cleanup, no refactoring, no "improvements".
3. Write the minimum code to complete the task. Follow the Simplicity First principle.
4. After writing code, verify it works (compile check, quick test, or logical validation).
5. Mark the task as done: change `- [ ]` to `- [x]` in `todo.md`.

**Step 7: Report & Continue**
After completing each batch (parallel) or task (sequential), report:
```
✅ Batch [N] complete — [tasks done] tasks
   Agents: [list agent results]
   Progress: [completed]/[total] tasks (Cycle [1|2|3]/3)
   Next: Batch [N+1] ([M] tasks, [parallel/sequential])
```

Evaluate whether to continue:
- **Auto-continue (default):** If the batch completed without errors → proceed to next batch immediately.
- **STOP and ask:** Only pause when encountering:
  - Build/compile errors that block subsequent batches
  - Merge conflicts that couldn't be auto-resolved
  - Breaking changes to shared interfaces (API contracts, DB schema, shared types)
  - Security vulnerabilities introduced
  - Task ambiguity that could lead the project in the wrong direction

**Step 8: Quality Gate — Auto Check/Fix Cycle**
The project runs exactly **3 quality cycles**. Each cycle triggers after completing 1/3 of total tasks:
1. On first launch, count total tasks (`- [ ]` + `- [x]`) in `todo.md` → compute `checkpoint = ceil(total / 3)`.
2. Track `cycle` counter (1, 2, 3) across the session.
3. Count tasks completed (across all batches). When completed count reaches checkpoint:
   ```
   🔄 Quality Gate — Cycle [N]/3 reached ([X]/[total] tasks done)
      Auto-triggering >om:check...
   ```
   - Automatically execute the [>om:check] workflow (inline, no user prompt needed).
   - If >om:check finds errors → automatically execute [>om:fix] → re-run [>om:check]. Max 3 fix attempts per cycle.
   - If max attempts reached: mark failing task `[BLOCKED]` in `todo.md`, escalate to user, then resume >om:cook for the next batch (skipping blocked tasks).
   - Once >om:check passes, resume >om:cook for the next batch.
4. After cycle 3 completes and >om:check passes:
   ```
   ✅ All 3 quality cycles complete. [total] tasks done.
      Project ready for /om:doc.
   ```

**Rules:**
- **Surgical Context:** For files > 200 lines, use grep/search to locate target code first. Read only the relevant section (±20 lines around target), not the entire file. Include this rule in sub-agent prompts.
- Follow the tech stack rules from `design-spec.md` and any installed skills.
- If a task is blocked (depends on something not yet built) or marked `[BLOCKED]`, move it to a later batch. Note the skip reason.
- If a task is ambiguous, ASK before implementing. Do not guess.
- Do NOT refactor, optimize, or "improve" code beyond what the task specifies.
- Quality gate cycles are mandatory — do NOT skip them even if all tasks look correct.
- Sub-agent prompts must be self-contained — agents start with zero context about this conversation.
