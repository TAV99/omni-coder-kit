# Lib Refactor — Scanner, Rules, Workflows, Landmines

**Date:** 2026-04-27
**Branch:** `feat/lib-refactor`
**Approach:** C — Monorepo sub-modules with proper parsing, severity landmines, hybrid workflow resolution

---

## Problem

4 issues identified in the current codebase:

1. **Scanner naive string matching (#4):** Python detection uses `content.includes('django')` on raw requirements.txt — false positives from comments. Go/Rust/PHP/Ruby only check file existence, no framework detection.
2. **Bloated .omni/ workflows (#5):** `omni init` copies 13 markdown files (~65KB) into `.omni/workflows/`. No update mechanism — workflows go stale when package updates.
3. **Rules logic redundancy (#6):** `buildRulesContent()` and `extractRulesForInject()` duplicate the semicolon-split-trim-filter pattern. `syncRulesToConfig()` lives in `bin/omni.js` instead of a module.
4. **Landmines detection superficial (#7):** `grepLandmines()` finds TODO/FIXME/HACK/XXX but no severity classification, no context, no integration with `>om:plan`.

---

## Target Structure

```
lib/
├── scanner/
│   ├── index.js          # Re-export public API
│   ├── constants.js      # IGNORE_DIRS, SOURCE_EXTENSIONS, MAX_LANDMINES, MANIFEST_FILES
│   ├── parsers.js        # Parse manifest files per language
│   ├── detect.js         # detectExistingProject(), detectTechStack()
│   ├── scan.js           # scanProject(), walkDir(), detectEntryPoints()
│   ├── landmines.js      # grepLandmines() v2 with severity
│   └── map.js            # generateMapSkeleton(), refreshMap()
├── rules/
│   ├── index.js          # Re-export
│   ├── parse.js          # parseRules(rp) — shared semicolon parser
│   ├── format.js         # formatMarkdown(parsed), formatInject(parsed)
│   └── sync.js           # syncRulesToConfig()
├── workflows/
│   ├── index.js          # Re-export
│   ├── resolve.js        # resolveWorkflow(name, projectDir) — hybrid lookup
│   └── build.js          # buildWorkflows(ide, target) — for init overlay
├── helpers.js            # Reduced — shared utilities only
├── skills.js             # Unchanged (already refactored)
```

---

## Design

### 1. `lib/scanner/parsers.js` — Proper Manifest Parsing

Replace naive `content.includes()` with line-by-line parsers. Each parser returns `string[]` of normalized dependency names.

**`parseRequirementsTxt(filePath)`:**
- Read line by line
- Skip blank lines, comments (`#`), flags (`-r`, `-e`, `--`)
- Extract package name: split on `[=<>!~\[;@\s]`, take first part, lowercase
- Return `string[]` of package names

**`parsePyprojectToml(filePath)`:**
- Read line by line
- Find `[project]` section, parse `dependencies = [...]` array
- Find `[project.optional-dependencies]` section for dev/test deps
- Extract package names from each entry (strip version specifiers)
- Return `string[]`

**`parseGoMod(filePath)`:**
- Read line by line
- Find `require (` block, extract module paths
- Return `string[]` of module paths (e.g., `github.com/gin-gonic/gin`)

**`parseCargoToml(filePath)`:**
- Read line by line
- Find `[dependencies]` and `[dev-dependencies]` sections
- Extract crate names from `name = "version"` or `name = { ... }` patterns
- Return `string[]`

**`parseComposerJson(filePath)`:**
- `JSON.parse()`, read `require` + `require-dev` keys
- Return `string[]` of package names

**`parseGemfile(filePath)`:**
- Read line by line
- Match `gem ['"]name['"]` pattern
- Skip comments
- Return `string[]`

All parsers: try/catch returns `[]` on error (file missing, parse failure). Never throws.

### 2. `lib/scanner/detect.js` — Use Parsers

`detectTechStack()` refactored to use parsers:

```
Node.js (package.json):     JSON.parse → has() check (unchanged, already proper)
Python (requirements.txt):  parseRequirementsTxt() → has() check
Python (pyproject.toml):    parsePyprojectToml() → has() check
Go (go.mod):                parseGoMod() → module path matching
Rust (Cargo.toml):          parseCargoToml() → crate name matching
PHP (composer.json):        parseComposerJson() → has() check
Ruby (Gemfile):             parseGemfile() → has() check
Java (pom.xml/build.gradle): file existence only (XML/Gradle parsing too complex, low ROI)
```

Python detection now immune to false positives from comments — `# django tutorial` no longer triggers Django.

Go/Rust/PHP/Ruby gain framework detection:
- Go: `gin-gonic/gin` → Gin, `gofiber/fiber` → Fiber
- Rust: `actix-web` → Actix, `tokio` → async runtime detection
- PHP: `laravel/framework` → Laravel, `symfony/...` → Symfony
- Ruby: `rails` → Rails, `sinatra` → Sinatra

### 3. `lib/scanner/landmines.js` — Severity + Context

**Severity map:**

| Keyword | Severity | Rationale |
|---------|----------|-----------|
| FIXME | critical | Known broken, needs fix |
| XXX | critical | Dangerous/wrong, needs attention |
| HACK | warning | Workaround, technical debt |
| TODO | info | Enhancement, not urgent |

**Output shape:**

```js
{
    file: string,       // relative path
    line: number,       // 1-indexed
    type: string,       // 'TODO' | 'FIXME' | 'HACK' | 'XXX'
    severity: string,   // 'critical' | 'warning' | 'info'
    text: string,       // description (max 120 chars)
    context: string     // line before + line after (for quick understanding)
}
```

**Helpers:**

- `groupBySeverity(landmines)` → `{ critical: [], warning: [], info: [] }`
- `formatLandminesForPlan(landmines)` → markdown checklist grouped by severity, compatible with `>om:plan` todo.md format
- `formatLandminesForMap(landmines, maxPerGroup)` → grouped display for project-map.md

**`grepLandmines()` still caps at MAX_LANDMINES (50)** — but now sorts critical first.

### 4. `lib/rules/` — Consolidated Rules Module

**`parse.js` — shared core:**

```js
function parseRules(rp) {
    const split = (str) => str ? str.split(';').map(r => r.trim()).filter(Boolean) : [];
    return {
        language: rp.language || null,
        codingStyle: split(rp.codingStyle),
        forbidden: split(rp.forbidden),
        custom: split(rp.custom),
    };
}
```

Single parser, returns structured object. Both formatters consume this.

**`format.js` — two formatters, same input:**

- `formatMarkdown(parsed)` → output for `.omni/rules.md` (section headers, bullet lists)
- `formatInject(parsed)` → output for config file injection (inline, forbidden prefixed with `**KHONG:**`)

No duplicate semicolon-splitting logic.

**`sync.js` — moved from bin/omni.js:**

`syncRulesToConfig()` moved verbatim. Imports `findConfigFile` from `lib/helpers.js`. Same HTML comment marker logic (`<!-- omni:rules -->` / `<!-- /omni:rules -->`).

### 5. `lib/workflows/` — Hybrid Resolution

**`resolve.js` — runtime lookup chain:**

```
resolveWorkflow(name, projectDir):
  1. Check .omni/workflows/{name} → return if exists (user customization)
  2. Check node_modules/omni-coder-kit/templates/workflows/{name} → return if exists
  3. Return null

resolveAllWorkflows(projectDir):
  - List all workflows from package
  - Overlay with custom files from .omni/workflows/
  - Return merged { name: resolvedPath } map
```

**Changes to `omni init`:**
- No longer copies 13 workflow files into `.omni/workflows/`
- Still creates `.omni/sdlc/` and `.omni/knowledge/` (artifacts)
- Config file references workflows by name, resolved at runtime

**New `omni customize <name>` command:**
- Copies single workflow from package to `.omni/workflows/{name}`
- User edits the local copy
- `resolveWorkflow()` picks up the custom version automatically

**Backward compatibility:** Projects with existing `.omni/workflows/` from old `omni init` continue to work — `resolveWorkflow()` finds custom path first.

### 6. Cleanup `lib/helpers.js`

**Remove (extracted):**
- `buildRulesContent()` → `lib/rules/format.js`
- `extractRulesForInject()` → `lib/rules/format.js`
- `buildWorkflows()` → `lib/workflows/build.js`
- `getOverlayDir()` → `lib/workflows/build.js`

**Keep:**
- `createManifest()`, `getAgentFlags()`, `detectDNA()`, `getOverlayNameForTarget()`
- `writeFileSafe()`, `readTemplate()`, `findConfigFile()`

### 7. Test Strategy

```
test/
├── skills.test.js                 # Unchanged (43 cases)
├── scanner/
│   ├── parsers.test.js            # ~20 cases: each parser + edge cases
│   ├── detect.test.js             # ~10 cases: proper detection per language
│   ├── landmines.test.js          # ~12 cases: severity, context, grouping, format
│   └── scan.test.js               # Existing scan tests (moved)
├── rules.test.js                  # ~10 cases: parse, formatMarkdown, formatInject, sync
├── workflows.test.js              # ~6 cases: resolve chain, custom override, null
└── *.test.js                      # Other existing tests (unchanged)
```

**npm test glob update:**

```json
"test": "node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js"
```

Total estimated: ~58 new test cases + 420 existing.

---

## Files Changed Summary

| Action | Count | Files |
|--------|-------|-------|
| Create | 15 | `lib/scanner/{index,constants,parsers,detect,scan,landmines,map}.js`, `lib/rules/{index,parse,format,sync}.js`, `lib/workflows/{index,resolve,build}.js` |
| Create | 4 | `test/scanner/{parsers,detect,landmines,scan}.test.js`, `test/rules.test.js`, `test/workflows.test.js` |
| Delete | 1 | `lib/scanner.js` (replaced by `lib/scanner/` folder) |
| Modify | 3 | `bin/omni.js` (imports + omni init + omni rules + new omni customize), `lib/helpers.js` (remove extracted functions), `package.json` (test glob) |

---

## Out of Scope

- Java/Kotlin pom.xml/build.gradle parsing (XML/Gradle too complex, low ROI)
- Remote workflow fetch from GitHub
- Landmines historical tracking / diff between scans
- Rules validation (schema check on rules.md content)
