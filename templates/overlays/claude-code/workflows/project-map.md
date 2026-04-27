## PROJECT MAP WORKFLOW — CLAUDE CODE ENHANCED
When executing the [>om:map] command (or `/om:map` slash command), act as a Senior Architect performing codebase reconnaissance.

**Step 1: Load Skeleton**
- Read `.omni/knowledge/project-map.md`. If it does not exist, run `omni map` via Bash tool to generate the skeleton, then re-read.
- Identify all `[PENDING]`, `[NEW]`, `[DELETED]` markers.
- If no markers found and ## Key Patterns already has content, report "🗺️ Map is up to date" and stop.

**Step 2: Prioritized Reading**
For large projects (>100 directories), spawn an Explore sub-agent:
- Agent prompt: "Read entry points and key modules listed in .omni/knowledge/project-map.md. For each [PENDING] directory, read its main/index file and return a 1-sentence description."
- For smaller projects, read directly using Read tool.

Priority order:
1. Entry points from ## Entry Points.
2. `[PENDING]`/`[NEW]` directories — read main/index file.
3. Files > 300 LOC (use `find . -name '*.ts' -o -name '*.js' | xargs wc -l | sort -rn | head -20`).
4. Scan conventions: `git log --oneline -10`, sample 3 source files for naming patterns.

**Step 3: Fill Semantic Sections**
Replace `[PENDING]`/`[NEW]` markers with `→ 1-sentence description`.
Fill ## Key Patterns with 3-7 architectural patterns.
Enhance ## Landmines with severity notes.
Remove `[DELETED]` entries.

**Step 4: Size Gate**
If map > 150 lines, collapse depth 3+ entries. Target: 50-120 lines.

**Step 5: Report**
```
🗺️ Project Map: updated
   Modules described: [N]
   Patterns identified: [N]
   Landmines flagged: [N]
   Map size: [lines] lines
```
