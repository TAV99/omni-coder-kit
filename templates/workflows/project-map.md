## PROJECT MAP WORKFLOW (CODEBASE INTELLIGENCE)
When executing the [>om:map] command, you MUST act as a Senior Architect performing codebase reconnaissance.

**Step 1: Load Skeleton**
- Read `.omni/knowledge/project-map.md`. If it does not exist, STOP — tell the user to run `omni map` first to generate the skeleton.
- Identify all `[PENDING]`, `[NEW]`, `[DELETED]` markers.
- If no markers found and ## Key Patterns already has content, report "🗺️ Map is up to date — no pending items." and stop.

**Step 2: Prioritized Reading**
Read files in this priority order (stop when you have enough context):
1. Entry points listed in ## Entry Points — read each to understand the app's main flows.
2. Directories marked `[PENDING]` or `[NEW]` — read the main/index file of each module.
3. Files > 300 LOC in key directories (likely contain core logic).
4. Config files listed in ## Conventions — scan for patterns.
Do NOT read every file in the project. Target: understand enough to write 1-sentence descriptions per module.

**Step 3: Fill Semantic Sections**
For each `[PENDING]` or `[NEW]` directory in ## Structure:
- Replace the marker with: `→ 1-sentence description of purpose`
- If a file inside is notably complex (>300 LOC, state machine, core algorithm), add an indented sub-entry.

Fill ## Key Patterns (if still `[PENDING]`):
- Identify 3-7 architectural patterns (auth, error handling, DB access, caching, queue, validation, API style).
- Format: `- PatternName: 1-sentence explanation`

Enhance ## Landmines:
- For each TODO/FIXME/HACK already listed, add a brief severity note if the impact is non-obvious.
- Add any implicit landmines found during reading (race conditions, missing error handling, hardcoded credentials).

Remove any `[DELETED]` entries entirely.

**Step 4: Conventions Detection**
If ## Conventions has gaps:
- Check `git log --oneline -10` → detect commit message convention.
- Sample 3 source files → detect naming convention (camelCase, snake_case, kebab-case for files).
- Check test files → detect test framework and patterns.
Append findings to ## Conventions.

**Step 5: Size Check**
Count lines in the map. If > 150 lines:
- Collapse verbose structure sections (combine small dirs).
- Remove depth 3+ entries that aren't critical.
- Target: 50-120 lines.

**Step 6: Report**
```
🗺️ Project Map: updated
   Modules described: [N]
   Patterns identified: [N]
   Landmines flagged: [N]
   Map size: [lines] lines
```

**Rules:**
- Do NOT rewrite sections that already have valid descriptions (no `[PENDING]`/`[NEW]` marker).
- Only touch markers + ## Key Patterns + ## Landmines.
- 1 sentence per module. No paragraphs or multi-line descriptions.
- If unsure about a module's purpose, write `→ [UNCLEAR — needs review]` instead of guessing.
