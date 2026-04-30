<!-- augment -->
### Gemini CLI: Task Registration (CRITICAL)
For every task identified in Step 4, you MUST use the `tracker_create_task` tool:
- **Title:** Brief, active voice (e.g., "Create Login API")
- **Description:** Detail what needs to be done + `@skill` tags
- **Metadata:** Include `estimated_minutes: 20` (default)
- **Dependency:** If a task depends on a previous one, link them using the `dependencies` parameter.

### Gemini CLI: Enhanced `.omni/sdlc/todo.md`
Add Gemini tracking markers to the standard todo.md format:
```markdown
# Todo — [Project Name]
> Gemini CLI Native Tracking: Active

## 1. Component
- [ ] Task description `@skill:name` [Gemini Task ID: tracker-X]
```

**Gemini Rules:**
- NEVER write code during the planning phase.
- Ensure all tasks are visible in the Gemini Task Tracker.
- Use `save_memory` (project scope) to store the total task count for the Quality Pipeline.
