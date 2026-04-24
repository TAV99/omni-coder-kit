# Claude Code Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a layered overlay system to omni-coder-kit so that Claude Code users get native slash commands (`/om:*`), sub-agent parallel execution in `/om:cook`, and progressive advanced setup (settings + hooks) — while keeping 100% backward compatibility for other IDEs.

**Architecture:** Base workflow templates stay generic (all IDEs). A new `templates/overlays/claude-code/` directory holds Claude Code-specific overrides: 7 slash command files, 2 overlay workflow files, and a settings template. `omni init` merges base + overlay when the user selects Claude Code. A progressive prompt offers advanced config (permissions + hooks).

**Tech Stack:** Node.js (CommonJS), chalk, commander, prompts, fs/path — all already in the project.

---

## File Structure

### New files to create:

```
templates/overlays/claude-code/
├── commands/
│   ├── om:brainstorm.md        # Thin launcher → requirement-analysis.md
│   ├── om:equip.md             # Thin launcher → skill-manager.md
│   ├── om:plan.md              # Thin launcher → task-planning.md
│   ├── om:cook.md              # Thin launcher → coder-execution.md
│   ├── om:check.md             # Thin launcher → qa-testing.md
│   ├── om:fix.md               # Thin launcher → debugger-workflow.md
│   └── om:doc.md               # Thin launcher → documentation-writer.md
├── settings.template.json      # Permissions allowlist + hooks
└── workflows/
    ├── coder-execution.md      # Override: +dependency graph +sub-agent parallel
    └── superpower-sdlc.md      # Override: +enhanced command registry +agent strategy
```

### Existing files to modify:

```
bin/omni.js                     # Add overlay merge logic, progressive prompt, buildWorkflows/buildCommands/buildSettings
```

---

## Task 1: Create overlay directory structure and slash command templates

**Files:**
- Create: `templates/overlays/claude-code/commands/om:brainstorm.md`
- Create: `templates/overlays/claude-code/commands/om:equip.md`
- Create: `templates/overlays/claude-code/commands/om:plan.md`
- Create: `templates/overlays/claude-code/commands/om:cook.md`
- Create: `templates/overlays/claude-code/commands/om:check.md`
- Create: `templates/overlays/claude-code/commands/om:fix.md`
- Create: `templates/overlays/claude-code/commands/om:doc.md`

- [ ] **Step 1: Create the overlay directory tree**

```bash
mkdir -p templates/overlays/claude-code/commands
mkdir -p templates/overlays/claude-code/workflows
```

- [ ] **Step 2: Create `om:brainstorm.md` slash command**

Write to `templates/overlays/claude-code/commands/om:brainstorm.md`:

```markdown
Read the workflow file `.omni/workflows/requirement-analysis.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the Solutions Architect. Follow the 2-phase adaptive interview process defined in the workflow file.
If the user has not described what they want to build, ask them first.
```

- [ ] **Step 3: Create `om:equip.md` slash command**

Write to `templates/overlays/claude-code/commands/om:equip.md`:

```markdown
Read the workflow file `.omni/workflows/skill-manager.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the Skill Manager. Ensure universal skills are installed, then discover project-specific skills.
If `design-spec.md` does not exist, tell the user to run /om:brainstorm first.
```

- [ ] **Step 4: Create `om:plan.md` slash command**

Write to `templates/overlays/claude-code/commands/om:plan.md`:

```markdown
Read the workflow file `.omni/workflows/task-planning.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the PM. Transform design-spec.md into micro-tasks in todo.md.
If `design-spec.md` does not exist, tell the user to run /om:brainstorm first.
```

- [ ] **Step 5: Create `om:cook.md` slash command**

Write to `templates/overlays/claude-code/commands/om:cook.md`:

```markdown
Read the workflow file `.omni/workflows/coder-execution.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the Senior Developer. Execute tasks from todo.md using the sub-agent parallel strategy defined in the workflow.
If `todo.md` does not exist, tell the user to run /om:plan first.
```

- [ ] **Step 6: Create `om:check.md` slash command**

Write to `templates/overlays/claude-code/commands/om:check.md`:

```markdown
Read the workflow file `.omni/workflows/qa-testing.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the QA Engineer. Verify every completed task in todo.md actually works.
If `todo.md` does not exist, tell the user to run /om:plan first.
```

- [ ] **Step 7: Create `om:fix.md` slash command**

Write to `templates/overlays/claude-code/commands/om:fix.md`:

```markdown
Read the workflow file `.omni/workflows/debugger-workflow.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the Senior Debugger. Read test-report.md or user-reported errors, then diagnose and fix systematically.
If no error information is available, ask the user for specifics before proceeding.
```

- [ ] **Step 8: Create `om:doc.md` slash command**

Write to `templates/overlays/claude-code/commands/om:doc.md`:

```markdown
Read the workflow file `.omni/workflows/documentation-writer.md` and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the Technical Writer. Generate README.md and API docs in Vietnamese based on actual implemented code.
If no code has been written yet, tell the user to run /om:cook first.
```

- [ ] **Step 9: Verify all 7 command files exist**

```bash
ls -la templates/overlays/claude-code/commands/
```

Expected: 7 files (`om:brainstorm.md`, `om:equip.md`, `om:plan.md`, `om:cook.md`, `om:check.md`, `om:fix.md`, `om:doc.md`)

- [ ] **Step 10: Commit**

```bash
git add templates/overlays/claude-code/commands/
git commit -m "thêm 7 slash command templates cho Claude Code overlay (/om:*)"
```

---

## Task 2: Create settings template for progressive setup

**Files:**
- Create: `templates/overlays/claude-code/settings.template.json`

- [ ] **Step 1: Create the settings template file**

Write to `templates/overlays/claude-code/settings.template.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run build)",
      "Bash(npm run lint)",
      "Bash(npm test)",
      "Bash(npx vitest*)",
      "Bash(npx jest*)",
      "Bash(git status)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git add*)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(find *)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(git push --force*)",
      "Bash(git reset --hard*)"
    ]
  },
  "hooks": {
    "postToolCall": [
      {
        "matcher": "Write|Edit",
        "command": "echo '[omni] File changed — remember quality gate at checkpoint'"
      }
    ]
  }
}
```

- [ ] **Step 2: Verify JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('templates/overlays/claude-code/settings.template.json', 'utf-8')); console.log('Valid JSON')"
```

Expected: `Valid JSON`

- [ ] **Step 3: Commit**

```bash
git add templates/overlays/claude-code/settings.template.json
git commit -m "thêm settings template cho Claude Code progressive setup (permissions + hooks)"
```

---

## Task 3: Create overlay workflow — `superpower-sdlc.md` (enhanced command registry)

**Files:**
- Create: `templates/overlays/claude-code/workflows/superpower-sdlc.md`

- [ ] **Step 1: Create the overlay superpower-sdlc.md**

Write to `templates/overlays/claude-code/workflows/superpower-sdlc.md`:

```markdown
## STRICT WORKFLOW COMMANDS (CLAUDE CODE ENHANCED)
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command.

> Claude Code users: dùng `/om:*` slash commands (auto-complete) hoặc `>om:*` trong chat — cả hai đều hoạt động.

| Command | Slash | Agent Strategy | Workflow File |
|---------|-------|---------------|---------------|
| `>om:brainstorm` | `/om:brainstorm` | Main session | `.omni/workflows/requirement-analysis.md` |
| `>om:equip` | `/om:equip` | Main session | `.omni/workflows/skill-manager.md` |
| `>om:plan` | `/om:plan` | Main session | `.omni/workflows/task-planning.md` |
| `>om:cook` | `/om:cook` | Main → sub-agents (parallel) | `.omni/workflows/coder-execution.md` |
| `>om:check` | `/om:check` | Main session | `.omni/workflows/qa-testing.md` |
| `>om:fix` | `/om:fix` | Main session | `.omni/workflows/debugger-workflow.md` |
| `>om:doc` | `/om:doc` | Main session | `.omni/workflows/documentation-writer.md` |

### Agent Strategy Guide
- **Main session:** Execute directly in current conversation. Suitable for interactive workflows (brainstorm, fix) and workflows needing full project context (doc, check).
- **Main → sub-agents (parallel):** Main session analyzes dependency graph, then dispatches General sub-agents with worktree isolation for independent tasks. Used by `/om:cook` only.

### Command Descriptions
- **[>om:brainstorm]:** Activates the Solutions Architect Agent. Extracts info from user prompt, classifies complexity (small/medium/large), asks only what's missing (adaptive interview), auto-decomposes large projects, then outputs `design-spec.md` in hybrid format (summary table + tagged requirement list). → See ADAPTIVE ARCHITECT WORKFLOW section.
- **[>om:equip]:** Activates the Skill Manager Agent. Reads the tech stack from `design-spec.md` and proposes `npx skills add` commands to fetch necessary expert skills from skills.sh. → See AGENT SKILLS MANAGER section.
- **[>om:plan]:** Activates the PM Agent. Reads `design-spec.md` and breaks it into detailed micro-tasks in `todo.md`. Each task must be atomic (<20 min) and use `- [ ]` checkbox format. → See PM AGENT WORKFLOW section.
- **[>om:cook]:** Activates the Coder Agent. Analyzes dependency graph in `todo.md`, groups independent tasks into batches, spawns parallel sub-agents with worktree isolation. Quality gate triggers at each 1/3 checkpoint. → See CODER AGENT WORKFLOW section.
- **[>om:check]:** Activates the QA Tester Agent. Verifies every completed task in `todo.md` actually works (build, tests, feature verification). Outputs `test-report.md`. → See QA TESTING WORKFLOW section.
- **[>om:fix]:** Activates the Debugger Agent. Reads `test-report.md` or user-reported errors. Reproduces → Root cause analysis → Surgical fix → Verify. Never shotgun-fix. → See DEBUGGER AGENT WORKFLOW section.
- **[>om:doc]:** Activates the Technical Writer Agent. Reads actual code + design-spec + test-report and generates README.md and API docs in Vietnamese. Documents only what was actually built. → See TECHNICAL WRITER WORKFLOW section.

*Critical Note: Any attempt to bypass the planning steps (>om:brainstorm or >om:plan) to write code immediately MUST be rejected.*

## AUTOMATED QUALITY PIPELINE
When >om:cook is running, the system enforces **3 quality cycles** based on total task count:
```
>om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:doc
```
- Checkpoint = ceil(total_tasks / 3). Quality gate triggers automatically at each checkpoint.
- Fix/check loop runs up to 3 attempts per cycle. If unresolved, escalate to user.
- After all 3 cycles pass, project is ready for >om:doc.
```

- [ ] **Step 2: Verify file was created correctly**

```bash
wc -l templates/overlays/claude-code/workflows/superpower-sdlc.md
```

Expected: ~50-60 lines

- [ ] **Step 3: Commit**

```bash
git add templates/overlays/claude-code/workflows/superpower-sdlc.md
git commit -m "thêm overlay superpower-sdlc.md: enhanced command registry với agent strategy"
```

---

## Task 4: Create overlay workflow — `coder-execution.md` (sub-agent parallel)

This is the most important overlay — it replaces the base sequential coder workflow with dependency graph analysis and sub-agent parallel dispatch.

**Files:**
- Create: `templates/overlays/claude-code/workflows/coder-execution.md`

- [ ] **Step 1: Create the overlay coder-execution.md**

Write to `templates/overlays/claude-code/workflows/coder-execution.md`:

```markdown
## CODER AGENT WORKFLOW — CLAUDE CODE ENHANCED (PARALLEL SUB-AGENT EXECUTION)
When executing the [>om:cook] command, you MUST act as a Senior Developer and Orchestrator. Your job is to implement tasks from `todo.md` using parallel sub-agents where possible.

**Step 1: Load Context**
- Read `todo.md`. Collect ALL uncompleted tasks (`- [ ]`).
- Read `design-spec.md` for architectural context (schema, endpoints, tech stack).
- Read existing project files to understand current state. Do NOT assume file structure.
- **Load skills:** For tasks with `@skill:skill-name` tag(s), note which skill files need to be passed to sub-agents.
- **Infra pre-check:** If `setup.sh` exists in the project root, verify infrastructure is ready before coding:
  - Check: Docker running? DB accessible? `.env` exists? Dependencies installed?
  - If any check fails → STOP. Tell the user: "Chạy `bash setup.sh` trước khi tiếp tục /om:cook."
  - If all checks pass or `setup.sh` does not exist → proceed normally.
*CRITICAL: If `todo.md` does not exist, STOP. Tell the user to run `/om:plan` first.*

**Step 2: Dependency Graph Analysis**
Analyze all uncompleted tasks and build a dependency graph:

1. **Parse tasks** — group by component/module section in `todo.md`.
2. **Identify dependencies** using these rules:
   - **Component order:** DB/Schema → API/Backend → Frontend/UI (earlier layers block later)
   - **Same file:** Two tasks that create or modify the same file → sequential (merge conflict risk)
   - **Import chain:** Task A creates a module/type, Task B imports it → B depends on A
   - **Independent:** Tasks in different components, different files, no import relationship → can run in parallel
3. **Group into batches** — each batch contains tasks that can run simultaneously.
4. **Cap at 4 agents per batch** — to keep resource usage reasonable.

**Step 3: Present Execution Plan**
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

**Step 4: Decide Execution Strategy**
Choose strategy based on conditions:

| Condition | Strategy |
|-----------|----------|
| ≤ 3 tasks total | Sequential — agent overhead not worth it |
| All tasks modify same file | Sequential — guaranteed conflicts |
| Independent tasks exist across files | Parallel (worktree isolation) |
| User says "tuần tự" / "sequential" | Sequential — respect user choice |

**Step 5a: Parallel Execution (when applicable)**
For each batch:

1. **Spawn sub-agents** — Use the Agent tool with `isolation: "worktree"` for each task in the batch:
   - **subagent_type:** `"general-purpose"`
   - **mode:** `"auto"`
   - **isolation:** `"worktree"`
   - Each agent receives a self-contained prompt with:
     - The specific task description from `todo.md`
     - Relevant excerpt from `design-spec.md` (only the section relevant to this task)
     - Content of skill files referenced by `@skill:` tags (read and include inline)
     - List of files to create/modify
     - Clear success criteria
   - Launch all agents in the batch simultaneously (multiple Agent calls in one message).

2. **Wait for all agents in batch to complete.**

3. **Review results** — Check each agent's output:
   - If agent succeeded → mark task as `- [x]` in `todo.md`
   - If agent reported errors → note for manual fix or retry

4. **Merge worktrees** — The worktree auto-merges on success. If merge conflicts occur:
   - Attempt automatic resolution for trivial conflicts
   - If unresolvable → report to user with conflict details

5. **Proceed to next batch** after current batch completes.

**Step 5b: Sequential Execution (fallback)**
Same as base workflow — execute ONE task at a time:
1. State what you will do and which files will be affected.
2. Write the minimum code to complete the task. Follow the Simplicity First principle.
3. Use Surgical Changes — touch only what the task requires.
4. After writing code, verify it works (compile check, quick test, or logical validation).
5. Mark the task as done: change `- [ ]` to `- [x]` in `todo.md`.

**Step 6: Report & Continue**
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

**Step 7: Quality Gate — Auto Check/Fix Cycle**
The project runs exactly **3 quality cycles**. Each cycle triggers after completing 1/3 of total tasks:
1. On first launch, count total tasks (`- [ ]` + `- [x]`) in `todo.md` → compute `checkpoint = ceil(total / 3)`.
2. Track `cycle` counter (1, 2, 3) across the session.
3. Count tasks completed (across all batches). When completed count reaches checkpoint:
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
      Project ready for /om:doc.
   ```

**Rules:**
- Follow the tech stack rules from `design-spec.md` and any installed skills.
- If a task is blocked (depends on something not yet built), move it to a later batch. Note the skip reason.
- If a task is ambiguous, ASK before implementing. Do not guess.
- Do NOT refactor, optimize, or "improve" code beyond what the task specifies.
- Quality gate cycles are mandatory — do NOT skip them even if all tasks look correct.
- Sub-agent prompts must be self-contained — agents start with zero context about this conversation.
```

- [ ] **Step 2: Verify file was created correctly**

```bash
wc -l templates/overlays/claude-code/workflows/coder-execution.md
```

Expected: ~100-120 lines

- [ ] **Step 3: Commit**

```bash
git add templates/overlays/claude-code/workflows/coder-execution.md
git commit -m "thêm overlay coder-execution.md: dependency graph + sub-agent parallel dispatch"
```

---

## Task 5: Update `bin/omni.js` — Add overlay helper functions

This task adds the three new helper functions (`buildWorkflows`, `buildCommands`, `buildSettings`) to `omni.js` without changing the existing init flow yet. Task 6 will wire them in.

**Files:**
- Modify: `bin/omni.js:36-65` (after existing helpers, before CLI commands)

- [ ] **Step 1: Add `buildWorkflows` function**

Insert the following after the `findSkillConflict` function (after line 173, before the `// ========== CLI COMMANDS ==========` comment at line 175):

```javascript
// ========== OVERLAY SYSTEM ==========

function getOverlayDir(ide) {
    const overlayMap = { claudecode: 'claude-code', dual: 'claude-code' };
    const overlayName = overlayMap[ide];
    if (!overlayName) return null;
    const dir = path.join(__dirname, '..', 'templates', 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide) {
    const templatesDir = path.join(__dirname, '..', 'templates');
    const baseDir = path.join(templatesDir, 'workflows');
    const files = {};

    for (const f of fs.readdirSync(baseDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(baseDir, f);
    }

    const overlayDir = getOverlayDir(ide);
    if (overlayDir) {
        const overlayWorkflowDir = path.join(overlayDir, 'workflows');
        if (fs.existsSync(overlayWorkflowDir)) {
            for (const f of fs.readdirSync(overlayWorkflowDir).filter(f => f.endsWith('.md'))) {
                files[f] = path.join(overlayWorkflowDir, f);
            }
        }
    }

    return files;
}

function buildCommands(ide) {
    const overlayDir = getOverlayDir(ide);
    if (!overlayDir) return null;

    const commandsDir = path.join(overlayDir, 'commands');
    if (!fs.existsSync(commandsDir)) return null;

    const files = {};
    for (const f of fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(commandsDir, f);
    }

    return Object.keys(files).length > 0 ? files : null;
}

function buildSettings(ide, advanced) {
    if (!advanced) return null;
    const overlayDir = getOverlayDir(ide);
    if (!overlayDir) return null;

    const templatePath = path.join(overlayDir, 'settings.template.json');
    if (!fs.existsSync(templatePath)) return null;

    return fs.readFileSync(templatePath, 'utf-8');
}
```

- [ ] **Step 2: Verify syntax is correct**

```bash
node -c bin/omni.js
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add bin/omni.js
git commit -m "thêm overlay helper functions: buildWorkflows, buildCommands, buildSettings"
```

---

## Task 6: Update `bin/omni.js` — Wire overlay into `init` command

This task modifies the existing `init` command to use the overlay system: merge workflows, generate slash commands, add progressive prompt, and enhance the Claude Code adapter.

**Files:**
- Modify: `bin/omni.js` — the `init` action (lines 186-496)

- [ ] **Step 1: Replace workflow copy logic with `buildWorkflows`**

Find the existing workflow copy block (lines 258-264):

```javascript
        const omniWorkflowsDir = path.join(process.cwd(), '.omni', 'workflows');
        fs.mkdirSync(omniWorkflowsDir, { recursive: true });
        const workflowSrcDir = path.join(templatesDir, 'workflows');
        const workflowFiles = fs.readdirSync(workflowSrcDir).filter(f => f.endsWith('.md'));
        for (const wf of workflowFiles) {
            fs.copyFileSync(path.join(workflowSrcDir, wf), path.join(omniWorkflowsDir, wf));
        }
```

Replace with:

```javascript
        const omniWorkflowsDir = path.join(process.cwd(), '.omni', 'workflows');
        fs.mkdirSync(omniWorkflowsDir, { recursive: true });
        const mergedWorkflows = buildWorkflows(response.ide);
        const workflowFiles = Object.keys(mergedWorkflows);
        for (const wf of workflowFiles) {
            fs.copyFileSync(mergedWorkflows[wf], path.join(omniWorkflowsDir, wf));
        }
```

- [ ] **Step 2: Enhance the Claude Code adapter section**

Find the existing Claude Code case (lines 307-309):

```javascript
            case 'claudecode':
                fileName = 'CLAUDE.md';
                finalRules += `- **Claude/OpenCode CLI Safety:** DO NOT execute destructive terminal commands (e.g., rm -rf) without explicit user permission.\n`;
                break;
```

Replace with:

```javascript
            case 'claudecode':
                fileName = 'CLAUDE.md';
                finalRules += `### Claude Code Integration\n`;
                finalRules += `- **Native Commands:** Dùng \`/om:brainstorm\`, \`/om:cook\`, ... (auto-complete) hoặc gõ \`>om:brainstorm\`, \`>om:cook\` trong chat — cả hai đều hoạt động.\n`;
                finalRules += `- **Sub-Agent Execution:** Khi \`/om:cook\` chạy, phân tích dependency graph trong \`todo.md\` và spawn parallel agents (worktree isolation) cho tasks độc lập. Xem chi tiết: \`.omni/workflows/coder-execution.md\`\n`;
                finalRules += `- **Task Tracking:** Dùng TaskCreate/TaskUpdate để track progress khi thực thi tasks, thay vì chỉ dựa vào \`todo.md\` checkboxes.\n`;
                finalRules += `- **Safety:** KHÔNG thực thi destructive commands (rm -rf, git push --force, git reset --hard) mà không có permission user.\n`;
                finalRules += `- **Workflow Files:** Tất cả logic nằm trong \`.omni/workflows/\`. Khi nhận lệnh \`>om:*\` hoặc \`/om:*\`, đọc file tương ứng rồi thực thi.\n`;
                break;
```

- [ ] **Step 3: Update the command registry for Claude Code**

Find the `commandRegistry` array (starts at line 266). Replace the entire `const commandRegistry = [...]` block with:

```javascript
        const isClaudeCode = response.ide === 'claudecode' || response.ide === 'dual';

        const commandRegistry = isClaudeCode ? [
            '## WORKFLOW COMMANDS',
            '> Claude Code: dùng `/om:*` slash commands (auto-complete) hoặc `>om:*` trong chat.',
            '',
            'When the user invokes a `>om:` command or `/om:` slash command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Slash | Agent Strategy | Workflow File |',
            '|---------|-------|---------------|---------------|',
            '| `>om:brainstorm` | `/om:brainstorm` | Main session | `.omni/workflows/requirement-analysis.md` |',
            '| `>om:equip` | `/om:equip` | Main session | `.omni/workflows/skill-manager.md` |',
            '| `>om:plan` | `/om:plan` | Main session | `.omni/workflows/task-planning.md` |',
            '| `>om:cook` | `/om:cook` | Main → sub-agents (parallel) | `.omni/workflows/coder-execution.md` |',
            '| `>om:check` | `/om:check` | Main session | `.omni/workflows/qa-testing.md` |',
            '| `>om:fix` | `/om:fix` | Main session | `.omni/workflows/debugger-workflow.md` |',
            '| `>om:doc` | `/om:doc` | Main session | `.omni/workflows/documentation-writer.md` |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` — Output format standards',
            '- `.omni/workflows/validation-scripts.md` — P0–P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` — Full SDLC overview and pipeline diagram',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook → check → fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n') : [
            '## WORKFLOW COMMANDS',
            'When the user invokes a `>om:` command, read the corresponding workflow file and follow its instructions.',
            '',
            '| Command | Workflow File | Role |',
            '|---------|--------------|------|',
            '| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect |',
            '| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill Manager |',
            '| `>om:plan` | `.omni/workflows/task-planning.md` | PM |',
            '| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder |',
            '| `>om:check` | `.omni/workflows/qa-testing.md` | QA Tester |',
            '| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugger |',
            '| `>om:doc` | `.omni/workflows/documentation-writer.md` | Writer |',
            '',
            'Supporting files (referenced by workflows as needed):',
            '- `.omni/workflows/pm-templates.md` — Output format standards',
            '- `.omni/workflows/validation-scripts.md` — P0–P4 validation pipeline scripts',
            '- `.omni/workflows/superpower-sdlc.md` — Full SDLC overview and pipeline diagram',
            '',
            '**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.',
            '**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook → check → fix). See coder-execution.md.',
            '**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.',
        ].join('\n');
```

- [ ] **Step 4: Add slash commands generation + progressive prompt after file write**

Find the block that writes the config file and logs success (around lines 362-398). After the manifest save and workflow log (after line 406: `console.log(chalk.gray(\`   Workflows: .omni/workflows/ (\${workflowFiles.length} files — lazy-loaded)\`));`), insert the following:

```javascript
        // Claude Code: generate slash commands
        const commands = buildCommands(response.ide);
        if (commands) {
            const claudeCommandsDir = path.join(process.cwd(), '.claude', 'commands');
            fs.mkdirSync(claudeCommandsDir, { recursive: true });
            for (const [name, srcPath] of Object.entries(commands)) {
                fs.copyFileSync(srcPath, path.join(claudeCommandsDir, name));
            }
            manifest.commands = Object.keys(commands).map(f => f.replace('.md', ''));
            console.log(chalk.gray(`   Commands: .claude/commands/ (${Object.keys(commands).length} slash commands)`));
        }

        // Claude Code: progressive advanced setup
        if (commands) {
            const { advanced } = await prompts({
                type: 'confirm',
                name: 'advanced',
                message: '🔧 Cài đặt Claude Code nâng cao? (permissions allowlist, quality gate hooks)',
                initial: false
            });

            const settingsContent = buildSettings(response.ide, advanced);
            if (settingsContent) {
                const claudeDir = path.join(process.cwd(), '.claude');
                fs.mkdirSync(claudeDir, { recursive: true });
                const settingsPath = path.join(claudeDir, 'settings.json');
                let writeSettings = true;
                if (fs.existsSync(settingsPath)) {
                    const { overwriteSettings } = await prompts({
                        type: 'confirm',
                        name: 'overwriteSettings',
                        message: '⚠️  File ".claude/settings.json" đã tồn tại. Ghi đè?',
                        initial: false
                    });
                    writeSettings = !!overwriteSettings;
                }
                if (writeSettings) {
                    writeFileSafe(settingsPath, settingsContent);
                    console.log(chalk.green(`   ✅ .claude/settings.json (permissions + hooks)`));
                }
            }

            manifest.overlay = true;
            manifest.advanced = !!advanced;
        }
```

- [ ] **Step 5: Update manifest version**

Find the `createManifest` function (line 107-109):

```javascript
function createManifest() {
    return { version: '1.0.0', configFile: null, skills: { external: [] } };
}
```

Replace with:

```javascript
function createManifest() {
    return { version: '2.1.0', configFile: null, skills: { external: [] } };
}
```

- [ ] **Step 6: Verify syntax is correct**

```bash
node -c bin/omni.js
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add bin/omni.js
git commit -m "tích hợp overlay system vào omni init: merge workflows, slash commands, progressive setup"
```

---

## Task 7: Update `omni commands` to show slash commands

The `commands` CLI command should show `/om:*` slash commands alongside `>om:*` text commands.

**Files:**
- Modify: `bin/omni.js:756-781` (the `commands` action)

- [ ] **Step 1: Update the commands display**

Find the commands array in the `commands` action (lines 758-766):

```javascript
        const commands = [
            { cmd: '>om:brainstorm', role: 'Architect',  desc: 'Phỏng vấn yêu cầu → đề xuất Tech Stack → xuất design-spec.md' },
            { cmd: '>om:equip',      role: 'Skill Mgr',  desc: 'Cài universal skills + tìm & đề xuất skills từ skills.sh theo design-spec' },
            { cmd: '>om:plan',       role: 'PM',          desc: 'Phân tích design-spec → micro-tasks trong todo.md (<20 phút/task)' },
            { cmd: '>om:cook',       role: 'Coder',       desc: 'Thực thi từng task trong todo.md, surgical changes, 1 task/lần' },
            { cmd: '>om:check',      role: 'QA Tester',   desc: 'Validation pipeline: security → lint → build → test → feature verify' },
            { cmd: '>om:fix',        role: 'Debugger',    desc: 'Reproduce → root cause → surgical fix → verify (không shotgun-fix)' },
            { cmd: '>om:doc',        role: 'Writer',      desc: 'Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt' },
        ];
```

Replace with:

```javascript
        const commands = [
            { cmd: '>om:brainstorm', slash: '/om:brainstorm', role: 'Architect',  desc: 'Phỏng vấn yêu cầu → đề xuất Tech Stack → xuất design-spec.md' },
            { cmd: '>om:equip',      slash: '/om:equip',      role: 'Skill Mgr',  desc: 'Cài universal skills + tìm & đề xuất skills từ skills.sh theo design-spec' },
            { cmd: '>om:plan',       slash: '/om:plan',        role: 'PM',          desc: 'Phân tích design-spec → micro-tasks trong todo.md (<20 phút/task)' },
            { cmd: '>om:cook',       slash: '/om:cook',        role: 'Coder',       desc: 'Sub-agent parallel execution, dependency graph, worktree isolation' },
            { cmd: '>om:check',      slash: '/om:check',       role: 'QA Tester',   desc: 'Validation pipeline: security → lint → build → test → feature verify' },
            { cmd: '>om:fix',        slash: '/om:fix',          role: 'Debugger',    desc: 'Reproduce → root cause → surgical fix → verify (không shotgun-fix)' },
            { cmd: '>om:doc',        slash: '/om:doc',          role: 'Writer',      desc: 'Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt' },
        ];
```

- [ ] **Step 2: Update the display format to include slash column**

Find the display logic (lines 768-774):

```javascript
        const maxCmd  = Math.max(...commands.map(c => c.cmd.length));
        const maxRole = Math.max(...commands.map(c => c.role.length));

        commands.forEach(({ cmd, role, desc }) => {
            const paddedCmd  = cmd.padEnd(maxCmd);
            const paddedRole = role.padEnd(maxRole);
            console.log(`  ${chalk.yellow.bold(paddedCmd)}  ${chalk.gray('│')} ${chalk.green(paddedRole)}  ${chalk.gray('│')} ${chalk.white(desc)}`);
        });
```

Replace with:

```javascript
        const maxCmd   = Math.max(...commands.map(c => c.cmd.length));
        const maxSlash = Math.max(...commands.map(c => c.slash.length));
        const maxRole  = Math.max(...commands.map(c => c.role.length));

        commands.forEach(({ cmd, slash, role, desc }) => {
            const paddedCmd   = cmd.padEnd(maxCmd);
            const paddedSlash = slash.padEnd(maxSlash);
            const paddedRole  = role.padEnd(maxRole);
            console.log(`  ${chalk.yellow.bold(paddedCmd)}  ${chalk.cyan(paddedSlash)}  ${chalk.gray('│')} ${chalk.green(paddedRole)}  ${chalk.gray('│')} ${chalk.white(desc)}`);
        });
```

- [ ] **Step 3: Update the footer note**

Find the footer (lines 777-781):

```javascript
        console.log(chalk.gray('\n  ─────────────────────────────────────────────────────'));
        console.log(chalk.white('  Workflow: ') + chalk.cyan('brainstorm → equip → plan → cook → check → fix → doc'));
        console.log(chalk.gray('\n  Lưu ý: Các lệnh >om: được gõ trực tiếp trong chat AI (Claude, Codex, Cursor...),'));
        console.log(chalk.gray('  không phải lệnh terminal. Chạy ') + chalk.yellow('omni init') + chalk.gray(' trước để tạo file luật cho AI.\n'));
```

Replace with:

```javascript
        console.log(chalk.gray('\n  ─────────────────────────────────────────────────────'));
        console.log(chalk.white('  Workflow: ') + chalk.cyan('brainstorm → equip → plan → cook → check → fix → doc'));
        console.log(chalk.gray('\n  Lưu ý: Các lệnh >om: được gõ trực tiếp trong chat AI (Claude, Codex, Cursor...),'));
        console.log(chalk.gray('  không phải lệnh terminal. Claude Code users: dùng /om:* (auto-complete).'));
        console.log(chalk.gray('  Chạy ') + chalk.yellow('omni init') + chalk.gray(' trước để tạo file luật cho AI.\n'));
```

- [ ] **Step 4: Verify syntax is correct**

```bash
node -c bin/omni.js
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add bin/omni.js
git commit -m "cập nhật omni commands: hiển thị /om:* slash commands bên cạnh >om:*"
```

---

## Task 8: Update version and test full flow

**Files:**
- Modify: `package.json:3` (version field)

- [ ] **Step 1: Bump version to 2.1.0**

In `package.json`, change:

```json
  "version": "2.0.6",
```

to:

```json
  "version": "2.1.0",
```

- [ ] **Step 2: Run syntax check**

```bash
node -c bin/omni.js
```

Expected: no errors

- [ ] **Step 3: Verify overlay directory structure**

```bash
find templates/overlays -type f | sort
```

Expected output:
```
templates/overlays/claude-code/commands/om:brainstorm.md
templates/overlays/claude-code/commands/om:check.md
templates/overlays/claude-code/commands/om:cook.md
templates/overlays/claude-code/commands/om:doc.md
templates/overlays/claude-code/commands/om:equip.md
templates/overlays/claude-code/commands/om:fix.md
templates/overlays/claude-code/commands/om:plan.md
templates/overlays/claude-code/settings.template.json
templates/overlays/claude-code/workflows/coder-execution.md
templates/overlays/claude-code/workflows/superpower-sdlc.md
```

- [ ] **Step 4: Test `omni init` with Claude Code selection**

```bash
cd /tmp && mkdir test-omni-cc && cd test-omni-cc && git init && node /path/to/omni-coder-kit/bin/omni.js init
```

Select "Claude Code" → any discipline → skip personal rules → test with both "yes" and "no" for advanced setup.

Verify:
- `CLAUDE.md` exists and contains enhanced adapter section
- `.claude/commands/` contains 7 `om:*.md` files
- `.omni/workflows/coder-execution.md` contains "Sub-Agent" content (overlay, not base)
- `.omni/workflows/requirement-analysis.md` contains base content (no overlay)
- `.omni-manifest.json` has `overlay: true` field
- If advanced=yes: `.claude/settings.json` exists with permissions + hooks

- [ ] **Step 5: Test `omni commands` shows slash column**

```bash
node /path/to/omni-coder-kit/bin/omni.js commands
```

Verify: each row shows both `>om:*` and `/om:*` columns.

- [ ] **Step 6: Test backward compat — Codex CLI selection**

```bash
cd /tmp && mkdir test-omni-codex && cd test-omni-codex && git init && node /path/to/omni-coder-kit/bin/omni.js init
```

Select "Codex CLI" → verify:
- `AGENTS.md` exists with base adapter (no Claude Code content)
- `.claude/` directory does NOT exist
- `.omni/workflows/coder-execution.md` contains base content (sequential, not parallel)

- [ ] **Step 7: Clean up test directories**

```bash
rm -rf /tmp/test-omni-cc /tmp/test-omni-codex
```

- [ ] **Step 8: Commit version bump**

```bash
git add package.json
git commit -m "bump version lên 2.1.0: Claude Code overlay system"
```

---

## Task 9: Update `package.json` files array to include overlays

**Files:**
- Modify: `package.json:8-12` (files array)

- [ ] **Step 1: Verify current files array**

Current `package.json` has:

```json
  "files": [
    "bin/",
    "templates/",
    "README.md",
    "LICENSE"
  ],
```

The `templates/` glob already includes `templates/overlays/`, so no change is needed here. Verify:

```bash
node -e "const pkg = require('./package.json'); console.log(pkg.files);"
```

Expected: `[ 'bin/', 'templates/', 'README.md', 'LICENSE' ]` — this covers `templates/overlays/` implicitly.

- [ ] **Step 2: Verify npm pack includes overlay files**

```bash
npm pack --dry-run 2>&1 | grep overlays
```

Expected: overlay files appear in the list.

- [ ] **Step 3: Commit (only if changes were needed)**

If no changes needed, skip this commit.

---

## Self-Review Checklist

- [x] **Spec coverage:** All 8 scope items from the spec are covered:
  1. Overlay system → Tasks 1-4 (directory + templates)
  2. 7 slash commands → Task 1
  3. Overlay coder-execution.md → Task 4
  4. Overlay superpower-sdlc.md → Task 3
  5. Progressive setup → Task 6 Step 4
  6. Enhanced CLAUDE.md adapter → Task 6 Step 2
  7. omni.js updates → Tasks 5-7
  8. Backward compat → Task 8 Step 6

- [x] **No placeholders:** All steps contain actual code or exact commands.

- [x] **Type consistency:** Function names (`buildWorkflows`, `buildCommands`, `buildSettings`, `getOverlayDir`) are consistent across Tasks 5 and 6. Manifest fields (`overlay`, `advanced`, `commands`) match the spec.

- [x] **Task order:** Dependencies respected: Tasks 1-4 (templates) → Task 5 (helpers) → Task 6 (wiring) → Task 7 (commands display) → Task 8 (version + test) → Task 9 (packaging).
