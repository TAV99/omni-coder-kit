# Legacy Project Onboarding — `omni onboard` + `>om:onboard`

**Date:** 2026-05-19
**Approach:** A — Reverse Brainstorm (Terminal scan + Chat AI interview)

---

## Problem

Omni-coder-kit hiện phục vụ tốt dự án mới (brainstorm → plan → cook), nhưng dự án cũ (legacy) — đã có codebase, conventions, tech debt — thiếu flow chuyên biệt. Người dùng phải tự viết rules, tự chọn skills, hoặc chạy brainstorm (được thiết kế cho ý tưởng mới, không phải reverse-engineer code có sẵn).

**Gap cụ thể:**
- `omni init` tạo config nhưng không phân tích code patterns
- `>om:brainstorm` hỏi "bạn muốn build gì?" — sai context cho dự án đã có
- Không có cơ chế sinh rules từ conventions đã tồn tại trong code
- Không có project-specific skills dựa trên architecture thực tế

---

## Solution Overview

Two-layer approach giống `omni map` + `>om:map`:

```
omni onboard (terminal)     →  Deep scan, sinh onboard-report.json
>om:onboard  (chat AI)      →  Interview + sinh full package
```

### Flow

```
omni onboard
  ├── Auto-init (nếu chưa có .omni/)
  ├── Deep scan (extended scanner)
  │   ├── Tech stack detection (có sẵn)
  │   ├── Conventions detection (có sẵn)
  │   ├── Code patterns analysis (MỚI)
  │   ├── Structure + entry points (có sẵn)
  │   ├── Landmines (có sẵn)
  │   └── Dependency analysis (MỚI)
  ├── Sinh project-map.md (có sẵn)
  ├── Sinh .omni/onboard-report.json (MỚI)
  ├── Track vào manifest
  └── Print: "Chạy >om:onboard để tiếp tục"

>om:onboard
  ├── Phase 1: Read onboard-report.json → display summary
  ├── Phase 2: AI interview (5-8 câu adaptive)
  └── Phase 3: Generate outputs
      ├── .omni/rules.md
      ├── .claude/skills/project-*.md (hoặc IDE tương ứng)
      ├── .omni/sdlc/design-spec.md
      ├── .omni/sdlc/todo.md
      └── Update manifest
```

---

## Design

### 1. `omni onboard` — Terminal Command

**File:** `lib/commands/onboard.js`
**Entry:** `bin/omni.js` — new `onboard` command

```
omni onboard [--skip-init] [--refresh]
```

- `--skip-init`: Bỏ qua auto-init (assume đã init)
- `--refresh`: Chạy lại scan, ghi đè onboard-report.json cũ

#### 1a. Auto-Init Gate

```js
if (!fs.existsSync('.omni-manifest.json') && !options.skipInit) {
    console.log('Chưa init — đang chạy omni init...');
    await handleInit({ /* default options */ });
}
```

Nếu đã init → skip, giữ nguyên config hiện tại.

#### 1b. Deep Scan

Gọi `scanProject(dir)` hiện tại + mở rộng thêm `analyzeCodePatterns(dir, allFiles)`:

**`analyzeCodePatterns(dir, allFiles)`** — MỚI trong `lib/scanner/patterns.js`:

Sampling strategy: đọc tối đa 20 source files (chọn đại diện từ mỗi key directory), phân tích:

| Pattern | Cách detect | Output |
|---------|------------|--------|
| **File naming** | Regex trên filenames: kebab-case, camelCase, PascalCase, snake_case | `naming.files: "kebab-case"` |
| **Component naming** | Parse React/Vue component exports | `naming.components: "PascalCase"` |
| **Function naming** | Regex trên function declarations | `naming.functions: "camelCase"` |
| **Import style** | Detect `import` vs `require`, alias patterns | `imports.style: "esm"`, `imports.aliasPrefix: "@/"` |
| **Barrel exports** | Check for `index.ts` that re-exports | `imports.barrelExports: true` |
| **Error handling** | Detect try-catch, custom Error classes, global handlers | `errorHandling.pattern: "try-catch"` |
| **Test location** | Colocated (`*.test.ts` next to source) vs separate (`test/` dir) | `testPatterns.location: "colocated"` |
| **Test naming** | `*.test.ts`, `*.spec.ts`, `test_*.py` | `testPatterns.naming: "*.test.ts"` |

**Sampling rules:**
- Max 20 files, max 1MB per file (skip larger)
- Prioritize files in `src/`, `lib/`, `app/` — skip `node_modules`, `dist`, vendor
- Use majority-vote: nếu 15/20 files dùng camelCase → output camelCase
- Nếu mixed → output "mixed" with breakdown

#### 1c. Dependency Analysis

**`analyzeDeps(dir)`** — MỚI trong `lib/scanner/patterns.js`:

Parse package.json (hoặc tương đương) → extract:
- Production dep count, dev dep count
- Notable deps (framework, ORM, UI lib, test runner + versions)
- Outdated signals (major version behind — chỉ check cho deps có trong notable list)

#### 1d. `onboard-report.json` Output

**File:** `.omni/onboard-report.json`

```json
{
  "version": 1,
  "scannedAt": "ISO-8601",
  "project": { "name": "string", "root": "absolute-path" },
  "techStack": { "runtime", "language", "framework", "ui", "db", "test", "queue", "deploy" },
  "stats": { "files": "number", "dirs": "number", "loc": "number" },
  "conventions": { "linter", "formatter", "tsconfig", "editorconfig", "commitConvention" },
  "codePatterns": {
    "naming": { "files", "components", "functions", "constants" },
    "imports": { "style", "aliasPrefix", "barrelExports" },
    "errorHandling": { "pattern", "customErrorClass", "globalHandler" },
    "testPatterns": { "location", "naming", "coverage", "e2eDir" }
  },
  "structure": {
    "type": "feature-based | layer-based | flat | monorepo",
    "keyDirs": ["string"],
    "entryPoints": [{ "file", "type", "hint" }]
  },
  "ci": [{ "file", "type" }],
  "docs": [{ "file", "lines?" , "type?", "count?" }],
  "landmines": { "count": "number", "topIssues": ["string"] },
  "deps": {
    "production": "number",
    "dev": "number",
    "notable": ["name@version"]
  }
}
```

#### 1e. Terminal Output

```
🔍 Scanning project...

📊 Onboard Report
   Language   : TypeScript
   Framework  : Next.js 14 (App Router)
   UI         : React 18
   DB         : Prisma + PostgreSQL
   Test       : Jest + Playwright
   LOC        : 28,500 (342 files)
   Conventions: eslint + prettier + conventional commits
   Landmines  : 12 issues (3 HACK, 5 TODO, 4 deprecated)

✅ Saved .omni/onboard-report.json
✅ Updated project-map.md

💡 Tiếp theo: gõ >om:onboard trong chat AI để sinh rules & skills
```

---

### 2. `>om:onboard` — Chat AI Workflow

**File:** `templates/workflows/onboard-workflow.md`
**Trigger:** `>om:onboard` hoặc `/om:onboard` (Claude Code)

#### 2a. Phase 1: Read & Display

AI đọc `.omni/onboard-report.json`, hiển thị summary:

```
📋 Tôi đã scan dự án của bạn:
   • Stack: TypeScript + Next.js 14 + React 18 + Prisma
   • Quy mô: 28,500 LOC, 342 files
   • Conventions: eslint, prettier, conventional commits
   • Code style: kebab-case files, PascalCase components, ESM imports
   • Tests: Jest (colocated) + Playwright (e2e/)
   • Issues: 12 landmines (3 HACK, 5 TODO, 4 deprecated)

Tôi sẽ hỏi vài câu để hiểu thêm những gì không thấy trong code.
```

**Gate:** Nếu `.omni/onboard-report.json` không tồn tại → "Chạy `omni onboard` trong terminal trước."

#### 2b. Phase 2: AI Interview (5-8 câu adaptive)

Câu hỏi chia 3 nhóm:

**Nhóm 1: Context (luôn hỏi, 2-3 câu)**

| # | Target | Câu hỏi mẫu |
|---|--------|-------------|
| 1 | Business context | "Dự án này phục vụ ai? Mục tiêu chính là gì? (a) SaaS product (b) Internal tool (c) Open-source (d) Client project" |
| 2 | Team size & process | "Mấy người làm việc trên repo này? Quy trình: (a) Solo dev (b) Small team, PR review (c) Large team, CI gate (d) Open-source, external PRs" |
| 3 | Current state | "Dự án đang ở giai đoạn nào? (a) Active development (b) Maintenance mode (c) Đang refactor/migrate (d) Legacy, ít thay đổi" |

**Nhóm 2: Conventions (adaptive, 1-3 câu)**

Chỉ hỏi khi scan phát hiện ambiguity:
- Mixed naming → "Tôi thấy file naming hỗn hợp (kebab + camelCase). Quy chuẩn nào đúng?"
- No tests → "Dự án chưa có tests. Bạn muốn AI: (a) Viết tests cho code mới (b) Bổ sung tests cho code cũ + mới (c) Không cần tests"
- Many landmines → "Có 12 TODO/HACK trong code. Xử lý thế nào? (a) Fix dần (b) Ignore (c) Ưu tiên fix trước khi thêm feature"

**Nhóm 3: Preferences (1-2 câu)**

| # | Target | Câu hỏi mẫu |
|---|--------|-------------|
| 6 | Coding style | "Khi AI viết code mới, style nên: (a) Match existing code exactly (b) Existing + improvements (c) Best practices, dù khác code cũ" |
| 7 | Forbidden patterns | "Có pattern/library nào team muốn TRÁNH? (Gõ tự do hoặc 'không có')" |
| 8 | Priority | "Phần nào cần chú ý nhất? (a) Performance (b) Security (c) Code quality (d) Feature velocity" |

**Adaptive logic:**
- Skip nhóm 2 nếu conventions rõ ràng (scan không có ambiguity)
- Thêm câu nếu scan phát hiện monorepo, multiple runtimes, hoặc complex CI
- Tổng tối đa 8 câu, tối thiểu 5 câu

#### 2c. Phase 3: Generate Outputs

**Output 1: `.omni/rules.md`**

Template:
```markdown
# Project Rules — [project-name]
> Auto-generated by omni onboard | [date]
> Source: code analysis + developer interview

## Ngôn ngữ
- [language] [strict mode if applicable]

## Coding Style
- [From codePatterns.naming — file naming, component naming, function naming]
- [From codePatterns.imports — import style, alias, barrel exports]
- [From conventions — linter, formatter]
- [From interview — additional style preferences]

## Error Handling
- [From codePatterns.errorHandling]

## Testing
- [From codePatterns.testPatterns]
- [From interview — test policy]

## Forbidden Patterns
- [From interview — explicit forbidden patterns]
- [From landmines — detected anti-patterns]

## Architecture
- [From structure.type — directory organization]
- [From interview — component boundaries, data flow rules]

## Custom Rules
- [From interview — team-specific conventions not covered above]
```

Sau khi sinh → `syncRulesToConfig()` inject vào IDE config files.

**Output 2: `.claude/skills/project-[name].md`** (hoặc IDE tương ứng)

Template:
```markdown
# [Project Name] — Architecture & Patterns Guide
> Auto-generated by omni onboard | [date]

## Overview
[From interview: business context, 2-3 sentences]

## Tech Stack
[From techStack — formatted table]

## Architecture
[From structure: type, keyDirs, description]

## Key Files
[From entryPoints + important config files]

## Patterns
### Data Flow
[Inferred from framework + ORM + UI: e.g., "Server Components → Prisma → PostgreSQL"]

### Authentication
[From scan: detected auth library/pattern or "Not detected"]

### State Management
[From deps: detected state lib or "Not detected"]

## Known Issues
[From landmines.topIssues — formatted as actionable list]

## Team Conventions
[From interview: team process, PR flow, deploy process]
```

**Output 3: `.omni/sdlc/design-spec.md`**

Reverse-engineered từ code, format giống brainstorm output:

```markdown
# Design Spec — [Project Name] (Reverse-Engineered)
> Generated: [date] | Source: code analysis + onboard interview

## Summary
| Field | Value |
|-------|-------|
| Goal | [From interview] |
| Users | [From interview] |
| Tech Stack | [From techStack] |
| Project State | [From interview: active/maintenance/refactor/legacy] |
| Backend DNA | [Inferred from framework + queue + deploy] |
| LOC | [From stats] |

## Existing Features
[AI extracts from code structure — each key directory/module → 1 [func] requirement]
- [func] Auth module — src/features/auth/ (login, register, password reset)
- [func] Dashboard — src/features/dashboard/ (overview, analytics, settings)
...

## Data Model
[From Prisma schema / models / migrations — if detectable]
- [data] User — id, email, name, role, createdAt

## API Surface
[From route files / controllers — if detectable]
- [api] GET /api/users — list users, auth required

## Infrastructure
[From CI, deploy config, queue]
- [infra] GitHub Actions CI — lint + test + build
- [infra] Vercel deployment — auto-deploy on push to main

## Known Technical Debt
[From landmines, formatted with severity]
- [edge] HACK in src/lib/auth.ts:42 — temp fix for token refresh
```

**Output 4: `.omni/sdlc/todo.md`**

AI-suggested improvements:

```markdown
# Improvement Tasks — [Project Name]
> Generated by omni onboard | [date]

## Priority: High
- [ ] Fix HACK in src/lib/auth.ts:42 — replace temp token refresh
- [ ] Add missing tests for src/features/payment/

## Priority: Medium
- [ ] Migrate deprecated API calls (4 instances)
- [ ] Add error boundary to dashboard components

## Priority: Low
- [ ] Remove unused TODO comments (5 instances)
- [ ] Add missing TypeScript strict checks
```

---

### 3. Manifest Tracking

Thêm `onboard` key vào `.omni-manifest.json`:

```json
{
  "onboard": {
    "status": "completed",
    "onboardedAt": "2026-05-19T10:35:00Z",
    "scanVersion": 1,
    "generated": {
      "rules": ".omni/rules.md",
      "skills": [".claude/skills/project-my-app.md"],
      "designSpec": ".omni/sdlc/design-spec.md",
      "todo": ".omni/sdlc/todo.md",
      "projectMap": ".omni/knowledge/project-map.md",
      "onboardReport": ".omni/onboard-report.json"
    }
  }
}
```

`omni status` hiển thị thêm dòng Onboard status.

---

### 4. New Files Summary

| File | Type | Description |
|------|------|-------------|
| `lib/commands/onboard.js` | Command handler | `handleOnboard()` — auto-init, scan, report |
| `lib/scanner/patterns.js` | Scanner module | `analyzeCodePatterns()`, `analyzeDeps()` |
| `templates/workflows/onboard-workflow.md` | Workflow | `>om:onboard` AI workflow |
| `templates/overlays/claude-code/commands/om:onboard.md` | Overlay | Claude Code slash command |
| `templates/overlays/cursor/commands/om:onboard.md` | Overlay | Cursor trigger |
| `templates/overlays/codex/commands/om:onboard.md` | Overlay | Codex trigger |
| `test/onboard.test.js` | Tests | Unit tests for onboard command |
| `test/patterns.test.js` | Tests | Unit tests for code pattern analysis |

**Modified files:**
- `bin/omni.js` — add `onboard` command
- `lib/scanner/index.js` — re-export new modules
- `lib/commands/status.js` — display onboard status
- `lib/commands/helpers.js` — manifest schema update (onboard key)

---

### 5. Edge Cases

- **Monorepo**: Nếu detect nhiều package.json → hỏi user chọn sub-project hoặc scan root
- **Empty project** (init nhưng chưa code): Skip code patterns analysis, focus interview
- **Re-onboard**: `omni onboard --refresh` ghi đè report cũ, `>om:onboard` cảnh báo và hỏi merge vs overwrite
- **No manifest files**: Hiển thị "Không phát hiện project (thiếu package.json...)" — giống behavior hiện tại
- **Mixed languages**: Report all detected stacks, hỏi user đâu là primary
- **Đã có rules.md**: `>om:onboard` merge rules mới vào existing, không ghi đè custom rules

---

### 6. Cost Estimation

- `omni onboard` (terminal): **0 tokens** — pure filesystem scan
- `>om:onboard` (chat): ~**3,000-8,000 tokens** — đọc report + interview 5-8 câu + sinh 4 files
- So sánh: `>om:brainstorm` hiện tại ~5,000-12,000 tokens
