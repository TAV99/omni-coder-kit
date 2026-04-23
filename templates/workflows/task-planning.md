## PM AGENT WORKFLOW (TASK DECOMPOSITION & PLANNING)
When executing the [>om:plan] command, you MUST act as a Senior Project Manager. Your job is to transform `design-spec.md` into an actionable, micro-task checklist in `todo.md`.

**Step 1: Read & Validate Design Spec**
Read `design-spec.md` fully. Verify it has:
- Clear objectives (Mục tiêu cốt lõi)
- Defined scope (Phạm vi & Ràng buộc)
- Data architecture (Database Schema)
- API/endpoint definitions
*CRITICAL: If `design-spec.md` is missing or incomplete, STOP. Tell the user to run `>om:brainstorm` first.*

**Step 2: Identify Components/Modules**
Break the project into logical groups based on the spec:
- Database layer (migrations, schemas, seeds)
- API/Backend routes and services
- Frontend pages/components
- Integration points (external APIs, webhooks)
- Configuration & environment setup

**Step 3: Inventory Installed Skills**
Before decomposing tasks, scan available skills:
- Read `.omni-manifest.json` → `skills.external[]` for installed skill names.
- Read skill files in `.agents/skills/` or `.claude/skills/` to understand each skill's capability.
- Build a **skill map**: which skill applies to which type of work (e.g., `supabase-postgres-best-practices` → DB tasks, `vercel-react-best-practices` → React components, `systematic-debugging` → complex logic).

**Step 4: Decompose into Micro-Tasks**
For EACH component, create tasks that are:
- **Atomic:** One task = one clear deliverable (a file, a function, a migration)
- **Estimable:** Each task should take < 20 minutes of coding
- **Ordered:** Dependencies first (DB before API, API before UI)
- **Testable:** Each task has an implicit verification (compiles, returns expected data, renders)
- **Skill-tagged:** Each task MUST specify which installed skill(s) the agent should apply during execution

**Step 5: Generate `todo.md`**
Output using this exact format:
```
# Todo — [Project Name]
> Generated from design-spec.md | [date]
> Skills: [list all installed skills used in this plan]

## 1. [Component/Module Name]
- [ ] Task description (specific file or function) `@skill:skill-name`
- [ ] Task description `@skill:skill-name`
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

**Rules:**
- Every task MUST use `- [ ]` checkbox format.
- Group by component, order by dependency within each group.
- Include setup tasks first (env config, package init, DB migration).
- Do NOT include vague tasks like "implement feature X". Be specific: "Create POST /api/users endpoint with validation for email and password fields".
- If a task is too large (>20 min estimate), split it further.
- Add a final `## Verification` section with build/lint/test tasks.