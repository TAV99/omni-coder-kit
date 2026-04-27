# Hardening — File Size Guard, Rules Sync Fix, Init Strategies, Dry Run

**Date:** 2026-04-27
**Branch:** `feat/skill-search-optimize`
**Scope:** 4 targeted fixes addressing performance, correctness, maintainability, and UX

---

## Fix 1: MAX_FILE_SIZE Guard for countLOC + grepLandmines

### Problem

`countLOC` and `grepLandmines` use `fs.readFileSync` on every source file. Large generated/bundled files (>1MB) waste time and memory.

### Design

Add `MAX_FILE_SIZE = 1 * 1024 * 1024` (1MB) to `lib/scanner/constants.js`.

Both `countLOC` (scan.js) and `grepLandmines` (landmines.js) check file size before reading:

```js
try {
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) continue;
} catch { continue; }
```

Files exceeding the limit are silently skipped. `statSync` failure (permission denied, deleted mid-scan) also skips.

### Files Changed

| File | Change |
|------|--------|
| `lib/scanner/constants.js` | Add `MAX_FILE_SIZE` export |
| `lib/scanner/scan.js` | Size guard in `countLOC()` |
| `lib/scanner/landmines.js` | Size guard in `grepLandmines()` |
| `test/scanner/landmines.test.js` | 1 test: 2MB .js file with TODO → skipped |

---

## Fix 2: Rules Sync Duplicate Bug + Validation

### Problem

`syncRulesToConfig` uses `<!-- omni:rules -->` / `<!-- /omni:rules -->` markers. If the user accidentally deletes one marker, the code falls through to the `else` branch and appends a duplicate rules block instead of detecting the broken state.

### Design

Add marker integrity check before writing:

```js
const hasStart = config.includes(startMarker);
const hasEnd = config.includes(endMarker);
if (hasStart !== hasEnd) return 'corrupt';  // only 1 of 2 markers present
```

Return value semantics:

| State | Return | Behavior |
|-------|--------|----------|
| No config/rules file | `false` | No action (unchanged) |
| Both markers present | `true` | Replace between markers (unchanged) |
| No markers | `true` | Append with markers (unchanged) |
| Only 1 marker (broken) | `'corrupt'` | **No write**, caller shows warning |

Call sites in `bin/omni.js` (`omni rules edit` line ~1380, `omni rules sync` line ~1397) updated to handle `'corrupt'` with a user-facing warning message.

### Files Changed

| File | Change |
|------|--------|
| `lib/rules/sync.js` | Add marker integrity check, return `'corrupt'` on mismatch |
| `bin/omni.js` | Handle `'corrupt'` return at 2 call sites |
| `test/rules.test.js` | 2 tests: start-only → corrupt, end-only → corrupt, file unchanged |

---

## Fix 3: omni init — IDE Strategies

### Problem

`omni init` action handler is ~486 lines mixing prompts, config generation, and file I/O for 7+ IDE paths. Adding a new IDE requires navigating hundreds of lines of interleaved logic.

### Design

Extract config generation into `lib/init/strategies.js`. Prompts and file I/O stay in `bin/omni.js`.

**New module: `lib/init/`**

```
lib/init/
├── index.js          — re-export buildInitConfig
└── strategies.js     — buildInitConfig + per-IDE builder functions
```

**`buildInitConfig(ide, opts)` API:**

```js
buildInitConfig(ide, {
    strictness,      // 'hardcore' | 'flexible'
    parsedRules,     // from parseRules()
    rulesContent,    // from formatMarkdown() or null
    projectDir,      // process.cwd()
    dnaProfile,      // from detectDNA()
}) → {
    files: [
        { path: string, content: string, overwritePrompt: boolean },
        ...
    ],
    dirs: string[],
    manifest: object,
}
```

- `files[].path` — relative to projectDir
- `files[].overwritePrompt` — true for main config files (CLAUDE.md, .cursorrules, etc.), false for workflow copies and internal files
- `dirs` — directories to create with `{ recursive: true }`
- `manifest` — the manifest object to save

**Internal structure of strategies.js:**

```js
function buildInitConfig(ide, opts) {
    switch (ide) {
        case 'claudecode': return buildClaudeCode(opts);
        case 'cursor':     return buildCursor(opts);
        case 'codex':      return buildCodex(opts);
        case 'dual':       return buildDual(opts);
        case 'gemini':     return buildGemini(opts);
        case 'windsurf':   return buildWindsurf(opts);
        case 'agents':     return buildAgents(opts);
        default:           return buildGeneric(opts);
    }
}
```

**Shared internal helpers** (not exported):
- `buildBaseContent(opts)` → string containing mindset + hygiene + command registry + strictness block + personal rules injection
- `buildRulesInjection(parsedRules, rulesContent)` → string with `<!-- omni:rules -->` markers, or empty string if no rules
- `collectWorkflowFiles(ide, target)` → array of `{ path, content }` for workflow copies

**Refactored init handler in bin/omni.js** (~120 lines):

```
1. Prompts (IDE, strictness, personal rules) — ~90 lines, unchanged
2. buildInitConfig(ide, opts) — 1 call
3. Create dirs from config.dirs
4. Write files from config.files (with overwrite prompt where overwritePrompt=true)
5. Save manifest
6. Print summary
7. Project Map generation — unchanged
8. Phase 2 test skills — unchanged
```

**Functions that move from bin/omni.js to lib/init/strategies.js:**
- `buildCommandRegistry(ide)` — called by strategies to generate command tables
- `buildCursorBootstrapRules(...)` — called by buildCursor strategy
- `buildCursorRules(dnaProfile)` — called by buildCursor strategy
- `buildCursorMcp(projectDir)` — called by buildCursor strategy

**All config-generation functions move to `lib/init/strategies.js`:**

Functions moving from `bin/omni.js`:
- `buildCommandRegistry(ide)`
- `buildCommands(ide)`
- `buildSettings(ide, advanced)`
- `buildCodexConfig(ide, advanced)`
- `buildCodexHooks(ide, advanced)`
- `buildCursorMcp(projectDir)`
- `buildCursorRules(dnaProfile)`
- `buildCursorBootstrapRules(fullRules, strictnessBlock, personalRulesBlock)`

These become internal helpers within strategies.js, not exported.

### Files Changed

| File | Change |
|------|--------|
| Create `lib/init/strategies.js` | buildInitConfig + 8 per-IDE builders + 8 helper functions |
| Create `lib/init/index.js` | Re-export buildInitConfig |
| Modify `bin/omni.js` | Init handler reduced to ~120 lines (prompts + delegate + write loop). Remove 8 config-generation functions. |
| Create `test/init.test.js` | ~8 tests: each IDE returns correct file set, rules injection presence/absence |

---

## Fix 4: --dry-run for omni init and omni rules sync

### Problem

`omni init` and `omni rules sync` write files immediately with no preview option.

### Design

**`omni init --dry-run`:**

Depends on Fix 3 (strategy returns file list). After `buildInitConfig()`, instead of writing:

```
📋 Dry run — files that would be created:

  CREATE    CLAUDE.md
  CREATE    .omni/workflows/coder-execution.md
  CREATE    .omni/workflows/task-planning.md
  ...
  OVERWRITE .cursorrules    (already exists)

  Dirs: .omni/workflows, .omni/sdlc, .omni/knowledge
  No files were changed.
```

Labels: `CREATE` (green) for new files, `OVERWRITE` (yellow) for existing.

**`omni rules sync --dry-run`:**

`syncRulesToConfig` gains an options parameter:

```js
syncRulesToConfig(findConfigFileFn, projectDir, { dryRun = false } = {})
```

When `dryRun === true`:
- Runs all validation logic (marker check, rules extraction)
- Does NOT write to disk
- Returns an object instead of `true`/`false`/`'corrupt'`:

```js
{ action: 'replace' | 'append' | 'corrupt' | 'skip', preview: string }
```

- `action: 'replace'` — both markers found, preview shows the injection block
- `action: 'append'` — no markers, preview shows what would be appended
- `action: 'corrupt'` — 1 marker, preview is warning message
- `action: 'skip'` — no config or no rules file

When `dryRun === false` (default): behavior unchanged — returns `true`/`false`/`'corrupt'` as in Fix 2.

Caller:
```
📋 Dry run — would replace rules in CLAUDE.md:

<!-- omni:rules -->
## PERSONAL RULES
- **Ngôn ngữ:** Tiếng Việt
- camelCase
- **KHÔNG:** any
<!-- /omni:rules -->

No files were changed.
```

### Files Changed

| File | Change |
|------|--------|
| `bin/omni.js` | Add `--dry-run` option to `init` and `rules` commands. Init: print file list instead of writing. Rules sync: print preview. |
| `lib/rules/sync.js` | Add `{ dryRun }` param. Return `{ action, preview }` when dryRun=true. |
| `test/rules.test.js` | 2 tests: dryRun returns preview without writing, dryRun + corrupt returns action:'corrupt' |

---

## Execution Order

Fixes have dependencies:

```
Fix 1 (file size guard)     — independent
Fix 2 (rules sync)          — independent
Fix 3 (init strategies)     — independent
Fix 4 (dry-run)             — depends on Fix 2 (sync return value) and Fix 3 (strategy file list)
```

Recommended order: Fix 1 → Fix 2 → Fix 3 → Fix 4.

---

## Test Summary

| Fix | New Tests |
|-----|-----------|
| 1. File size guard | 1 case |
| 2. Rules sync | 2 cases |
| 3. Init strategies | ~8 cases |
| 4. Dry-run | 2 cases |
| **Total** | **~13 new test cases** |

---

## Out of Scope

- Stream-based file reading (overkill — size guard is sufficient)
- .gitignore parsing for scanner (separate concern)
- ESM migration (no technical need)
- Dry-run for `omni map` (low risk — creates new file, doesn't overwrite config)
