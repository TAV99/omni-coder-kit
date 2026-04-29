# Codex `$om:*` Alias Implementation Plan


**Goal:** Enable Codex users to invoke every Omni workflow via `$om:<command>` anywhere in chat text (except backtick/code blocks), mapped consistently to existing `>om:<command>` routing.

**Architecture:** Keep implementation instruction-layer based (no runtime chat parser in CLI). Update Codex command guidance at generation time (`bin/omni.js`), runtime workflow guidance (`templates/overlays/codex/workflows/superpower-sdlc.md`), and public docs (`README.md` + Codex usage doc). Ensure command inventory is consistent by shipping `knowledge-learn.md` and `project-map.md` as base workflows.

**Tech Stack:** Node.js (CommonJS), Commander CLI, Markdown template files, ripgrep-based smoke validation.

---

## File Structure and Responsibilities

- `bin/omni.js`
  - Source of generated AGENTS/CLAUDE command-registry content.
  - Contains command catalog shown by `omni commands`.
  - Must advertise Codex `$om:*` alias rules and include full command set.
- `templates/workflows/knowledge-learn.md` (new)
  - Base workflow definition for `>om:learn` so command mapping is backed by shipped file.
- `templates/workflows/project-map.md` (new)
  - Base workflow definition for `>om:map` so command mapping is backed by shipped file.
- `templates/overlays/codex/workflows/superpower-sdlc.md`
  - Codex runtime SDLC overview; must document `$om:*` alias semantics and full command matrix.
- `templates/overlays/codex/docs/codex-usage.md`
  - Codex usage reference; must teach `$om:*` usage and escape behavior.
- `README.md`
  - User-facing docs for init output and SDLC command set.

### Task 1: Ship Missing Workflow Templates for Full Command Coverage

**Files:**
- Create: `templates/workflows/knowledge-learn.md`
- Create: `templates/workflows/project-map.md`
- Test: command-only checks (no new test file)

- [ ] **Step 1: Write the failing check (prove missing workflow assets)**

```bash
ls templates/workflows/knowledge-learn.md templates/workflows/project-map.md
```

Expected: `No such file or directory` for both files.

- [ ] **Step 2: Add `knowledge-learn` base workflow template**

```md
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
```

- [ ] **Step 3: Add `project-map` base workflow template**

```md
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
```

- [ ] **Step 4: Run check to verify assets now exist**

```bash
ls templates/workflows/knowledge-learn.md templates/workflows/project-map.md
```

Expected: both file paths printed, exit code `0`.

- [ ] **Step 5: Commit**

```bash
git add templates/workflows/knowledge-learn.md templates/workflows/project-map.md
git commit -m "feat(workflows): add learn and map workflow templates"
```

### Task 2: Add Codex `$om:*` Alias Rules to Generated Guidance

**Files:**
- Modify: `bin/omni.js`
- Test: command-only checks (no new test file)

- [ ] **Step 1: Write failing checks for missing alias guidance and incomplete command set**

```bash
rg -n "\$om:" bin/omni.js
rg -n ">om:learn|>om:map" bin/omni.js
```

Expected: no or incomplete hits in Codex command-registry/adapters and `omni commands` list.

- [ ] **Step 2: Update `buildCommandRegistry(ide === 'codex')` block**

Replace the Codex intro and dispatch lines to include alias normalization rules:

```js
'> Codex CLI: type `>om:*` or `$om:*` as normal chat text. Codex custom project `/om:*` slash commands are not assumed in this setup.',
'',
'When the user invokes a `>om:` command or `$om:` alias, read the corresponding workflow file and follow its instructions.',
'Normalize `$om:<cmd>` to `>om:<cmd>` for workflow routing.',
'Ignore `$om:*` tokens inside inline backticks or fenced code blocks.',
'If multiple valid commands appear, execute only the first valid command in non-code text order.',
```

Add command rows for learn/map in the same table:

```js
'| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner |',
'| `>om:map` | `.omni/workflows/project-map.md` | Architect |',
```

- [ ] **Step 3: Update Codex adapter strings in `case \'codex\'` and dual `agentsRules` block**

Append explicit alias rule lines:

```js
finalRules += `- **Alias Commands:** You may type \`$om:brainstorm\`, \`$om:plan\`, \`$om:cook\`, etc. anywhere in normal text; treat them as \`>om:*\` commands.\n`;
finalRules += `- **Alias Escape:** Ignore \`$om:*\` tokens inside inline backticks and fenced code blocks.\n`;
```

And mirror the same two lines in the dual-mode `agentsRules += ...` Codex adapter section.

- [ ] **Step 4: Expand `omni commands` catalog to include `>om:learn` and `>om:map`**

Add two entries to `const commands = [...]`:

```js
{ cmd: '>om:learn', slash: '/om:learn', role: 'Learner', desc: 'Tổng hợp bài học từ fix gần nhất vào knowledge base của dự án' },
{ cmd: '>om:map',   slash: '/om:map',   role: 'Architect', desc: 'Quét codebase và cập nhật project-map.md theo trạng thái hiện tại' },
```

Also update footer workflow chain text:

```js
console.log(chalk.white('  Workflow: ') + chalk.cyan('brainstorm → equip → plan → cook → check → fix → learn → doc (map on demand)'));
```

- [ ] **Step 5: Run syntax check**

Run:

```bash
npm test
```

Expected: command exits `0` with `node -c bin/omni.js` success.

- [ ] **Step 6: Commit**

```bash
git add bin/omni.js
git commit -m "feat(codex): support $om alias guidance and full command registry"
```

### Task 3: Align Codex Workflow + Docs With Alias Behavior

**Files:**
- Modify: `templates/overlays/codex/workflows/superpower-sdlc.md`
- Modify: `templates/overlays/codex/docs/codex-usage.md`
- Modify: `README.md`
- Test: command-only checks (no new test file)

- [ ] **Step 1: Update Codex SDLC workflow template command section**

In `templates/overlays/codex/workflows/superpower-sdlc.md`:
- Change intro sentence from `>om:*` only to `>om:*` + `$om:*`.
- Add alias normalization/escape/first-command rule bullets.
- Add rows for `>om:learn` and `>om:map`.

Use this exact rule text:

```md
Alias rules for Codex:
- Treat `$om:<cmd>` as `>om:<cmd>` in normal chat text.
- Ignore `$om:*` inside inline backticks and fenced code blocks.
- If multiple valid commands appear, execute only the first valid command in non-code text order.
```

- [ ] **Step 2: Update Codex usage doc template**

In `templates/overlays/codex/docs/codex-usage.md`:
- Change “Stable Omni Commands” heading text to mention `$om:*` alias.
- Add `learn` and `map` rows to command table.
- Add a short example block:

```text
$om:brainstorm
$om:plan
$om:cook
$om:check
```

- Add explicit escape note:

```md
Use inline backticks or fenced code blocks when you want to mention `$om:*` literally (for example: `` `$om:plan` ``) without triggering command routing.
```

- [ ] **Step 3: Update README Codex and SDLC sections**

In `README.md`:
- In “Codex CLI Overlay” section, show both syntaxes (`>om:*` and `$om:*`) for Codex chat.
- Add a one-line note about backtick escaping.
- In SDLC command table, append `>om:learn` and `>om:map` rows with short Vietnamese descriptions.

- [ ] **Step 4: Validate docs include required markers**

Run:

```bash
rg -n "\$om:brainstorm|Alias rules for Codex|>om:learn|>om:map|`\$om:plan`" README.md templates/overlays/codex/workflows/superpower-sdlc.md templates/overlays/codex/docs/codex-usage.md
```

Expected: matches in all three files with no missing marker.

- [ ] **Step 5: Commit**

```bash
git add README.md templates/overlays/codex/workflows/superpower-sdlc.md templates/overlays/codex/docs/codex-usage.md
git commit -m "docs(codex): document $om alias rules and full command set"
```

### Task 4: End-to-End Smoke Verification for Generated Output

**Files:**
- Modify: none
- Test: generated temp workspace files

- [ ] **Step 1: Prepare dependencies for local CLI execution**

Run:

```bash
npm ci
```

Expected: installs `chalk`, `commander`, `prompts` with exit code `0`.

- [ ] **Step 2: Verify `omni commands` output includes learn/map**

Run:

```bash
node bin/omni.js commands | rg -n ">om:learn|>om:map|Workflow: .*learn"
```

Expected: all three patterns matched.

- [ ] **Step 3: Generate Codex init output in temp project and check alias lines**

Run (non-destructive temp workspace):

```bash
tmpdir=$(mktemp -d)
mkdir -p "$tmpdir/app"
cp -R templates bin package.json package-lock.json "$tmpdir/app/"
cd "$tmpdir/app"
npm ci
printf 'n\n6\n\n\n\n\n\nn\n' | node bin/omni.js init || true
rg -n "Stable Omni Commands|Alias Commands|Alias Escape|\$om:" AGENTS.md
rg -n ">om:learn|>om:map" AGENTS.md
```

Expected:
- `AGENTS.md` exists.
- Alias lines and `$om:*` guidance are present.
- `>om:learn` and `>om:map` rows exist in generated command registry.

- [ ] **Step 4: Final sanity check on changed source files**

Run:

```bash
git status --short
rg -n "\$om:|>om:learn|>om:map" bin/omni.js README.md templates/overlays/codex/workflows/superpower-sdlc.md templates/overlays/codex/docs/codex-usage.md
```

Expected: only intended files changed and required markers present.

- [ ] **Step 5: Final commit (optional squash by maintainer preference)**

```bash
git add bin/omni.js README.md templates/workflows/knowledge-learn.md templates/workflows/project-map.md templates/overlays/codex/workflows/superpower-sdlc.md templates/overlays/codex/docs/codex-usage.md
git commit -m "feat(codex): add $om alias guidance across init workflows and docs"
```
