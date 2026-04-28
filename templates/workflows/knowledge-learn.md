## KNOWLEDGE CAPTURE WORKFLOW (LEARN FROM FIXES)
When executing the [>om:learn] command (or auto-triggered after a successful fix), capture the lesson learned.

**Step 1: Analyze Recent Fix**
- Read `git diff HEAD~1` (or the most recent fix diff if multiple commits).
- Read `.omni/sdlc/test-report.md` if it exists — look for the FAIL that was fixed.
- Identify: what broke, why it broke, and what fixed it.

**Step 2: Evaluate — Is This Worth Recording?**
Skip recording if the fix was trivial:
- Typo or spelling fix
- Missing import that's obvious from the error message
- Simple syntax error

Record if:
- Root cause was non-obvious (e.g., CORS, race condition, env config)
- Fix required tracing through multiple files
- The same mistake could happen again in this project

If not worth recording, output: `📝 Learn: skipped — trivial fix.` and stop.

**Step 3: Write Entry**
Read `.omni/knowledge/knowledge-base.md` if it exists. Append a new entry in this format:

```markdown
## [YYYY-MM-DD] [Short title]
**Scope:** [file path(s) affected]
**Pattern:** [What went wrong — 1 sentence]
**Fix:** [What solved it — 1 sentence]
```

If `.omni/knowledge/knowledge-base.md` does not exist, create it with header:
```markdown
# Knowledge Base — Project Lessons
> Auto-captured by >om:learn. Max 20 entries — oldest removed when full.
```

**Step 4: Enforce Max 20 Entries**
Count `##` entries in the file. If more than 20, remove the oldest entry (first `##` block after the header).

**Step 5: Report**
```
📝 Learned: [short title]
   Scope: [files]
   KB: .omni/knowledge/knowledge-base.md ([N]/20 entries)
```
