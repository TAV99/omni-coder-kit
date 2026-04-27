## PM AGENT WORKFLOW (GEMINI ENHANCED)
When executing [>om:plan], you transform `.omni/design-spec.md` into actionable tasks.

### Step 1-4: Analysis & Decomposition
(Follow standard procedures in base `task-planning.md`)

### Step 5: Gemini Task Registration (CRITICAL)
For every task identified in Step 4, you MUST use the `tracker_create_task` tool.
- **Title:** Brief, active voice (e.g., "Create Login API")
- **Description:** Detail what needs to be done + `@skill` tags
- **Metadata:** Include `estimated_minutes: 20` (default)
- **Dependency:** If a task depends on a previous one, link them using the `dependencies` parameter.

### Step 6: Generate `.omni/todo.md`
Maintain the `.omni/todo.md` file as the secondary source of truth and for quick checkbox access.
Format:
```markdown
# Todo — [Project Name]
> Gemini CLI Native Tracking: Active

## Setup
- [ ] Run `bash setup.sh` if generated

## 1. Component
- [ ] Task description `@skill:name` [Gemini Task ID: tracker-X]
...
```

### Rules:
- NEVER write code during the planning phase.
- Ensure all tasks are visible in the Gemini Task Tracker.
- Use `save_memory` (project scope) to store the total task count for the Quality Pipeline.
