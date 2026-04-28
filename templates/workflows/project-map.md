## PROJECT MAP WORKFLOW — CODEX CLI
When executing `>om:map`, act as a Senior Architect scanning the codebase.

### Step 1: Load Skeleton
- Read `.omni/knowledge/project-map.md`. If missing, tell the user to run `omni map` first.
- Identify `[PENDING]`, `[NEW]`, `[DELETED]` markers.

### Step 2: Read Key Files
Read in order (stop when sufficient context):
1. Entry points from ## Entry Points.
2. Main/index file of each `[PENDING]`/`[NEW]` directory.
3. Large files (>300 LOC) in core directories.

Keep reads minimal — Codex has sandbox constraints. Do not attempt network calls.

### Step 3: Fill Sections
- Replace markers with `→ 1-sentence description`.
- Fill ## Key Patterns (3-7 patterns).
- Enhance ## Landmines.
- Remove `[DELETED]` entries.

### Step 4: Size Check
Collapse if > 150 lines. Keep under 120 lines.

### Step 5: Report
```
🗺️ Project Map: updated ([N] modules, [N] patterns, [N] landmines)
```
