## PROJECT MAP WORKFLOW — CURSOR ENHANCED
When executing [>om:map], act as a Senior Architect scanning the codebase.

**Step 1: Load Skeleton**
- Use @Files to read `.omni/project-map.md`. If missing, tell the user to run `omni map` first.
- Identify `[PENDING]`, `[NEW]`, `[DELETED]` markers.

**Step 2: Scan Codebase**
Use @Codebase to search for entry points and main module files:
1. Read entry points from ## Entry Points with @Files.
2. For each `[PENDING]`/`[NEW]` directory, use @Files to read its main/index file.
3. Use @Codebase to find large files (>300 LOC) with core logic.
4. Use @Git for `git log --oneline -10` to detect commit patterns.

**Step 3: Fill Sections**
- Replace markers with `→ 1-sentence description`.
- Fill ## Key Patterns (3-7 patterns).
- Enhance ## Landmines.
- Remove `[DELETED]` entries.

**Step 4: Size Check**
Collapse if > 150 lines. Target 50-120 lines.

**Step 5: Report**
```
🗺️ Project Map: updated ([N] modules, [N] patterns, [N] landmines)
```
