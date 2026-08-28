## PM AGENT WORKFLOW (TASK DECOMPOSITION & PLANNING)
When executing the [>om-plan] command, you MUST act as a Senior Project Manager. Transform `.omni/sdlc/design-spec.md` into the human checklist `.omni/sdlc/todo.md` and the authoritative typed execution graph `.omni/sdlc/dual-plan.json`.

- **Load planning skill:** You MUST read the `writing-plans` skill file (found in `.agents/skills/writing-plans/SKILL.md` or `.claude/skills/writing-plans/SKILL.md` or equivalent IDE path) and strictly apply its checklists, principles, and guidelines to structure and design your task breakdown.

**Step 1: Read & Validate Design Spec**
Read `.omni/sdlc/design-spec.md` fully. It uses a hybrid format:
- **Summary table** (top): Goal, Users, Tech Stack, UI Style, Constraints — read this first for context.
- **Tagged requirement list** (body): Each requirement has a category tag (`[func]`, `[auth]`, `[data]`, `[api]`, `[nfr]`, `[edge]`, `[ui]`, `[infra]`).

Verify it has at minimum:
- A filled Summary table (Goal + Tech Stack)
- At least 1 `[func]` requirement
- At least 1 `[data]` or `[api]` requirement
*Note: If `.omni/sdlc/design-spec.md` is missing or incomplete, recommend `>om-think` for larger work — but it's optional. You may build the plan directly from the user's description.*

**Step 2: Identify Components/Modules**
Use the requirement tags to auto-group into components:
- `[data]` → Database layer (migrations, schemas, seeds)
- `[api]` → API/Backend routes and services
- `[func]` + `[ui]` → Frontend pages/components
- `[auth]` → Auth & middleware
- `[nfr]` → Configuration, performance, infrastructure
- `[infra]` → Infrastructure layer (services, workers, queues, cache config)
- `[edge]` → Error handling (distribute into relevant components)

If the spec uses the old prose format (no tags), fall back to manual grouping:
- Database layer, API/Backend, Frontend, Integration points, Configuration

**Step 3: Inventory Installed Skills**
Before decomposing tasks, scan available skills:
- Read `.omni/manifest.json` → `skills.external[]` for installed skill names.
- Read skill files in `.agents/skills/` or `.claude/skills/` to understand each skill's capability.
- Build a **skill map**: which skill applies to which type of work (e.g., `supabase-postgres-best-practices` → DB tasks, `vercel-react-best-practices` → React components, `systematic-debugging` → complex logic). Specifically, scan for local visual design skills: `minimalist-ui`, `industrial-brutalist-ui`, `high-end-visual-design`, or `design-taste-frontend`.

**Step 4: Decompose into Micro-Tasks**
For EACH component, create tasks that are:
- **Atomic:** One task = one clear logical deliverable (e.g., a cohesive set of files representing a single module or service class).
- **Task Grouping (Layer/Component):** Group tightly coupled tasks together by layer or component to avoid context switching. For example, instead of creating separate tiny tasks for creating a mock data file and writing its access service class, group them into a single cohesive task like "Setup Mock Data Layer".
- **Estimable:** Each task should take 10-20 minutes of active coding. Merge trivial tasks (e.g., small styling tweaks, renaming variables, adding comments, minor copy edits) into single, larger logical tasks to avoid loop execution overhead.
- **Strictly Ordered (Dependency-First):** Order tasks by dependencies. Perform base and foundational tasks first, then business logic, then UI components, and finally responsiveness/effects. Follow this extended ordering chain: DB → Cache → Queue/Worker → API → Realtime → UI.
  - **Foundational Layer first:** Mock database/DB, schemas, migrations, service API configurations. Specifically: cache layer before API endpoints (API may use cache), queue/worker before features that send async tasks, realtime setup before UI components that consume realtime data.
  - **Business Logic Layer next:** Service layers, controllers, API routes.
  - **UI/UX Layer next:** HTML structure, core UI components, view states.
  - **Transitions, Responsive & Polish last:** Responsive styling, animations, view transitions, dark mode toggle.
  This strict progression prevents the Coder agent from refactoring already written files due to foundational changes later in the run.
- **Testable:** Each task has an implicit verification (compiles, returns expected data, renders)
- **Skill-tagged:** Each task MUST specify which installed skill(s) the agent should apply during execution. Any frontend UI/UX task **must** be tagged with the selected local design skill name (e.g., `@skill:minimalist-ui`, `@skill:industrial-brutalist-ui`, `@skill:high-end-visual-design`, or `@skill:design-taste-frontend` as default) to guarantee visual design guidelines are enforced during execution.

**Step 5: Classify Tasks — Setup vs Code**
For each task, determine if it is **setup/infra** (run-once typed action) or **code** (needs implementation):
- **Setup/Infra:** Dependency installation, tool code generation, configuration generation — anything representable as a typed setup action (`kind`, `program`, `args`, `cwd`).
- **Code:** Create files, write functions, implement endpoints, build components, write tests — anything that requires writing or modifying source code.
- **Unsafe / Unrepresentable Infrastructure:** Destructive database resets, deployments, credential mutations, shell-only constructions (pipes, redirections, aliases), Git mutations, or machine/system-level services MUST NOT be generated as shell actions. Instead, classify them as clearly bounded Codex-owned/manual blockers or explicit code tasks in `.omni/sdlc/todo.md` with appropriate `@skill:` tags.

> [!CAUTION]
> **CRITICAL INFRA SAFETY GUARD (Platform-Neutral Typed Actions):**
> NEVER generate shell scripts or shell wrappers, shell command strings, `eval`, redirection (`>`, `<`), pipelines (`|`), or shell operators (`&&`, `||`, `;`). Setup actions execute with direct process invocation (`shell: false`). Never embed a full shell command into `program`.

If setup actions exist, generate `.omni/sdlc/setup.json` with the exact versioned envelope:
```json
{
  "schema_version": 1,
  "actions": [
    {
      "kind": "package-manager",
      "program": "auto",
      "args": ["install"],
      "cwd": "."
    }
  ]
}
```

**Setup Action Rules:**
- Each action MUST contain exactly `{ "kind", "program", "args", "cwd" }`.
- `args` MUST be a JSON array of strings (e.g. `["install"]` or `["run", "build"]`).
- `cwd` MUST be a repository-relative path (default `"."`).
- Action kinds:
  - `kind: "package-manager"`: Use `program: "auto"` for dependency installation when a supported lockfile exists (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb`). Use explicit `"npm"`, `"pnpm"`, `"yarn"`, or `"bun"` only when fixed by the approved specification.
  - `kind: "native"`: Single executable identifier (e.g. `"node"`, `"python"`, `"git"`) plus argv array. Never place `npm`, `pnpm`, `yarn`, or `bun` under `native`; those identifiers require `package-manager`.
  - `kind: "node-cli"`: Resolved trusted JavaScript CLI entrypoint plus argv array.
- If no setup actions are needed, omit `.omni/sdlc/setup.json` or write an empty typed manifest (`{ "schema_version": 1, "actions": [] }`) and continue.

**AUTO Behavior:**
- Generate all planning artifacts first. Planning artifacts are outside the execution ledger and never become a temporary Codex/AGY task.
- Call exactly `omni dual bootstrap --json`. The controller validates `dual-plan.json`, executes/reuses the same typed runner as `omni dual setup run`, requires the matching `SUCCESS receipt`, creates authority only after setup, registers the full graph once, and resumes eligible AGY work.
- On controller success, continue automatically into execution without asking the user between setup, registration, and resume.
- The runner self-heals one exact legacy semantic error: `kind: "native"` with `program: "npm"`, `"pnpm"`, `"yarn"`, or `"bun"`. It atomically repairs the action to `kind: "package-manager"`, validates it again, and continues. Never perform a shell fallback.
- On ambiguous executable names, security violations, unrepresentable actions, or any failure that remains after the bounded repair, record the exact failing action and error and stop safely for real user input (fail-closed).
- Do not call `omni_dual_begin` or `omni_dual_register_plan` directly from `$om-think`/`$om-plan`, and never invent `bootstrap-plan-artifacts`. Those low-level MCP operations are owned by the controller.

**Typed Full Graph — `.omni/sdlc/dual-plan.json`:**
```json
{
  "schema_version": 1,
  "plan_revision": 1,
  "tasks": [{
    "task_id": "TASK-1",
    "title": "Bounded deliverable",
    "owner": "agy",
    "goal": "Concrete implementation outcome",
    "category": "frontend",
    "complexity": "medium",
    "risk": "low",
    "allowed_files": ["src/component.tsx"],
    "context_files": [".omni/sdlc/design-spec.md"],
    "deny_patterns": ["package.json"],
    "validation_commands": [{ "program": "npm", "args": ["test"], "cwd": "." }]
  }]
}
```
- Every source implementation deliverable in `todo.md` must have exactly one corresponding typed task. Setup/planning actions and final QC/review/verification checkboxes do not enter the graph; the bootstrap controller and completion/quality/UI gates own them.
- All fields shown above are required. The full graph may contain at most one AGY-owned implementation slice because a session has one immutable baseline; make that slice cohesive and high-value. It requires 1-10 exact `allowed_files` and at least one typed validation command. Remaining setup, architecture, integration, broader-file, and QC work stays Codex-owned.
- **Tối Ưu Hóa Token Cho Codex:** Để chuyển giao tối đa khối lượng code sang AGY, hãy gom toàn bộ các file UI / Components / Tests vào slice thực thi có `owner: "agy"` và `risk: "low"`. Codex chỉ giữ vai trò Kiến Trúc Sư / Phê Duyệt và dùng lệnh `omni dual qc --json` để nghiệm thu nhanh chóng.
- Architecture, security, migrations, ambiguous work, high risk, broad file scopes, and final QC remain Codex-owned.

Sau khi hoàn tất tạo plan và setup:
```
📋 Đã tạo:
   • .omni/sdlc/setup.json — manifest setup (đã tự động thực thi và nghiệm thu qua omni dual bootstrap)
   • .omni/sdlc/todo.md — danh sách code tasks cho >om-cook (M tasks)
   • .omni/sdlc/dual-plan.json — full typed graph đã đăng ký một lần bởi omni dual bootstrap

👉 Setup đã tự động hoàn tất. Tiếp tục >om-cook để bắt đầu code.
```

**Step 6: Generate `.omni/sdlc/todo.md`**
Output code tasks using this exact format:
```
# Todo — [Project Name]
> Generated from .omni/sdlc/design-spec.md | [date]
> Skills: [list all installed skills used in this plan]

## Setup (đã thực hiện qua .omni/sdlc/setup.json)
- [x] Install dependencies
- [x] Configuration & code generation
> Đã tự động thực hiện qua `omni dual bootstrap`.

## 1. [Component/Module Name]
- [ ] Task description (specific file or function) `@skill:skill-name`
- [ ] Build visual layouts for page/widget `@skill:minimalist-ui` (or chosen style)
- [ ] Task with multiple skills `@skill:skill-a` `@skill:skill-b`
...

## 2. [Next Component]
- [ ] ...

## Verification
- [ ] Build passes (`npm run build` or equivalent)
- [ ] Lint passes (`npm run lint` or equivalent)
- [ ] All tests pass (`npm test` or equivalent)
```
The `@skill:` tag tells the coder agent which skill rules to load and follow for that specific task. If no installed skill applies, omit the tag.
If no setup actions exist, omit the `## Setup` section entirely.

**Rules:**
- Every task MUST use `- [ ]` checkbox format.
- Group by component, order by dependency within each group.
- Setup actions go to `.omni/sdlc/setup.json` (executed by `omni dual bootstrap`, with `omni dual setup run` retained for manual diagnostics), NOT into `.omni/sdlc/todo.md` or `.omni/sdlc/dual-plan.json` as tasks.
- Do NOT include vague tasks like "implement feature X". Be specific: "Create POST /api/users endpoint with validation for email and password fields".
- If a task is too large (>20 min estimate), split it further.
- Add a final `## Verification` section with build/lint/test tasks.
