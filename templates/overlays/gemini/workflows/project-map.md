## PROJECT MAP WORKFLOW — GEMINI ENHANCED
When executing [>om:map], act as a Senior Architect scanning the codebase.

### Step 1: Load Skeleton
- Read `.omni/project-map.md`. If missing, tell the user to run `omni map` first.
- Use `enter_plan_mode` for the analysis phase.

### Step 2: Read Key Files
1. Entry points from ## Entry Points.
2. Main/index file of each `[PENDING]`/`[NEW]` directory.
3. Use `google_web_search` for unfamiliar frameworks/libraries to understand their role.

### Step 3: Fill Sections
- Replace markers with `→ 1-sentence description`.
- Fill ## Key Patterns (3-7 patterns).
- Enhance ## Landmines.
- Remove `[DELETED]` entries.
- Use `save_memory` (project scope) to store key architectural patterns for future sessions.

### Step 4: Size Check
Use `exit_plan_mode` before writing. Collapse if > 150 lines.

### Step 5: Report
```
🗺️ Project Map: updated ([N] modules, [N] patterns, [N] landmines)
```
