# Omni-Coder Kit

**Omni-Coder Kit** là công cụ CLI inject mindset, SDLC workflow và skills vào các AI coding agent. Đảm bảo AI hoạt động với kỷ luật Senior Engineer, tuân thủ SDLC nghiêm ngặt và sử dụng mẫu thiết kế tối ưu.

## Tính năng chính

- **Đa IDE:** Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, Antigravity, Cross-tool, Generic — mỗi IDE sinh file cấu hình riêng
- **Dual-Agent:** Tạo cả `CLAUDE.md` + `AGENTS.md` cùng lúc cho dự án dùng nhiều AI tool
- **Karpathy Mindset:** 4 nguyên tắc — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution
- **Socratic Gate:** Bắt buộc AI phỏng vấn trước khi code — số lượng câu hỏi tự động theo độ phức tạp (1 câu cho Small, 3 cho Medium, 5 cho Large) — không có ngoại lệ
- **Project DNA Detection:** AI tự động nhận diện `hasUI`, `hasBackend`, `hasAPI`, `backendComplexity` (simple/moderate/complex) từ prompt của user — điều chỉnh quy trình theo độ phức tạp thật sự
- **Conditional Skill Groups:** 3 nhóm skill động: Best Practices (luôn có), UI/UX (khi hasUI), Backend/Infrastructure (khi backendComplexity >= moderate)
- **Personal Rules:** Phỏng vấn có hướng dẫn khi `omni init` — ngôn ngữ giao tiếp, coding style, forbidden patterns, custom rules — kèm ví dụ theo scenario
- **Universal Skills:** 6 skills mặc định (find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees)
- **Dynamic Skill Discovery:** `>om:equip` dùng `find-skills` search skills.sh theo tech stack — không giới hạn framework
- **IDE-Aware Skills:** `auto-equip` chỉ cài skill cho IDE/CLI đã chọn, dùng `--agent` flag của skills.sh
- **Skill-Tagged Tasks:** `>om:plan` gắn `@skill:name` cho từng task trong `.omni/todo.md`, `>om:cook` tự động load skill tương ứng khi thực thi
- **Content Source-of-Truth:** `>om:brainstorm` tự động sinh `.omni/content-source.md` (Facts, Tone, Forbidden Content) cho UI project — `>om:cook` dùng làm ground truth, `>om:check` validate nội dung (P5)
- **Automated Quality Pipeline:** 3 quality cycles bắt buộc — `cook → check → fix` loop tự động sau mỗi 1/3 tasks, P5 Content Validation blocks khi HIGH severity
- **Knowledge Base:** `>om:learn` tự động ghi bài học sau mỗi fix thành công vào `.omni/knowledge-base.md` — `>om:cook` đọc lại khi gặp file tương tự
- **Project Map (v2.4.5):** `omni map` quét codebase → sinh `.omni/project-map.md` skeleton (0 token). `>om:map` điền mô tả semantic. `--refresh` diff cấu trúc, đánh dấu `[NEW]`/`[DELETED]`, giữ nguyên mô tả AI. Multi-language: Node.js, Python, Go, Rust, Java, Ruby, PHP
- **Existing Project Detection (v2.4.5):** `omni init` tự động phát hiện project có sẵn (package.json, pyproject.toml, go.mod...) và đề xuất tạo Project Map
- **Parallel Sub-Agent Execution (Claude Code):** Dependency graph analysis, batch parallel agents với worktree isolation, Shared Context Brief (~500 tokens) giảm token duplication
- **Token Optimization:** Config file chỉ ~5KB, workflows lazy-loaded khi cần, examples lazy-loaded khi cần, surgical context rule (grep trước khi đọc file lớn), context-aware verbosity theo lệnh >om:, Shared Context Brief cho sub-agents
- **Anti-Hallucination (Paranoid Mode):** Grounding rules, self-verification checklist, no phantom imports/APIs
- **Validation Pipeline:** Security → Lint → Build → Tests → Bundle → Content — blocking tự động

---

## Cài đặt

Yêu cầu [Node.js](https://nodejs.org/) >= 16.0.0.

```bash
npm install -g omni-coder-kit
```

Cập nhật:

```bash
omni update
```

---

## Bắt đầu nhanh

```bash
# 1. Khởi tạo — chọn IDE, mức kỷ luật, personal rules
#    (tự động phát hiện project có sẵn → đề xuất tạo Project Map)
omni init

# 2. Quét codebase (nếu chưa tạo map khi init)
omni map

# 3. Cài universal skills (6 skills mặc định)
omni auto-equip

# 4. Cài thêm skill từ skills.sh (chỉ cho IDE đã chọn)
omni equip vercel-labs/agent-skills

# 5. Xem trạng thái
omni status

# 6. Xem danh sách lệnh >om:
omni commands

# 7. Cập nhật lên phiên bản mới nhất
omni update
```

---

## Lệnh CLI

| Lệnh | Mô tả |
|-------|-------|
| `omni init` | Khởi tạo DNA và workflow cho dự án mới (auto-detect existing project) |
| `omni map` | Quét codebase → sinh Project Map cho AI navigation |
| `omni map --refresh` | Cập nhật cấu trúc map (0 token, đánh dấu `[NEW]`/`[DELETED]`) |
| `omni equip <source>` | Tải kỹ năng ngoài từ skills.sh (cài cho IDE đã chọn) |
| `omni auto-equip` | Cài universal skills (6 skills mặc định cho mọi dự án) |
| `omni rules [action]` | Quản lý personal rules (xem/sửa/sync/reset) |
| `omni status` | Xem trạng thái skills đã cài đặt |
| `omni commands` | Hiển thị danh sách lệnh `>om:` dùng trong chat AI |
| `omni update` | Kiểm tra và cập nhật lên phiên bản mới nhất |

### IDE hỗ trợ khi `omni init`

| Lựa chọn | File tạo ra | Gợi ý khởi động |
|-----------|------------|-----------------|
| Claude Code / OpenCode | `CLAUDE.md` | `claude --dangerously-skip-permissions` |
| Gemini CLI (Google) | `GEMINI.md` | `gemini --yolo` |
| Codex CLI (OpenAI) | `AGENTS.md` + optional `.codex/` | `codex` hoặc `codex --profile omni_safe` |
| Claude Code + Codex (dual) | `CLAUDE.md` + `AGENTS.md` | Cả 2 lệnh trên |
| Antigravity | `AGENTS.md` | Dùng `.agents/` directory cho rules, skills, workflows |
| Cursor | `.cursorrules` + optional `.cursor/rules/*.mdc` | Mở Cursor trong thư mục dự án |
| Windsurf | `.windsurfrules` | Mở Windsurf trong thư mục dự án |
| Cross-tool | `AGENTS.md` | Tool-agnostic |
| Generic | `SYSTEM_PROMPT.md` | — |

### Claude Code Overlay (tính năng nâng cao)

Khi chọn **Claude Code**, `omni init` tự động cài thêm:

- **Slash commands `/om:*`** — 8 lệnh tương ứng với `>om:*`, gõ trực tiếp trong Claude Code
- **Permissions allowlist** — `.claude/settings.json` với các lệnh build/test/git được allow sẵn, deny các lệnh nguy hiểm (`rm -rf`, `git push --force`, `git reset --hard`)
- **Quality gate hooks** — Tự động nhắc AI kiểm tra chất lượng khi file thay đổi
- **Enhanced coder-execution** — Parallel sub-agent execution với dependency graph, worktree isolation, Shared Context Brief (~500 tokens)

Khi được hỏi `"🔧 Cài đặt Claude Code nâng cao?"`, chọn **Yes** để kích hoạt permissions + hooks.

### Cursor Overlay (tính năng nâng cao — v2.3.0)

Khi chọn **Cursor**, `omni init` tạo `.cursorrules` cơ bản và hỏi có muốn cài advanced setup:

**Basic (mặc định):**
- `.cursorrules` — chứa core mindset, command registry, IDE adapters

**Advanced (khi chọn Yes):**
- **7 MDC rules** (`.cursor/rules/*.mdc`):
  - 4 always-on: `core-mindset.mdc`, `workflow-commands.mdc`, `yolo-guardrails.mdc`, `agent-mode.mdc`
  - 3 conditional (by globs): `backend.mdc`, `frontend.mdc`, `testing.mdc`
- **DNA-based MCP config** (`.cursor/mcp.json`) — tự động detect tech stack và cấu hình MCP servers phù hợp
- **Bootstrap `.cursorrules`** — nhẹ hơn, trỏ đến `.cursor/rules/` cho chi tiết
- **YOLO guardrails** — 3 tiers: auto-run (lint/test), warn first (commit/install), always ask (push/reset/rm -rf)
- **Agent Mode protocol** — multi-file edit confirmation, scope lock, quality loop

### Codex CLI Overlay (tính năng nâng cao)

Khi chọn **Codex CLI**, `omni init` tạo `AGENTS.md` và `.omni/workflows/`. Nếu bật advanced setup, kit tạo thêm:

- **`.codex/config.toml`** — profile `omni_safe`, `omni_yolo`, `omni_review`, sandbox/approval defaults, `project_doc_max_bytes`
- **`.codex/hooks.json`** — hook reminders cho file changes và quality-cycle checks

Khởi động gợi ý:

```bash
codex
codex --profile omni_safe
codex --profile omni_yolo
codex exec "Read AGENTS.md, then run >om:check against the current repository state."
```

### Gemini CLI Overlay (tính năng nâng cao)

Khi chọn **Gemini CLI**, `omni init` tạo `GEMINI.md` và `.omni/workflows/` với các workflow được tối ưu cho Gemini:

- **requirement-analysis.md** — Phỏng vấn Socratic với DNA detection
- **task-planning.md** — Backend-aware ordering
- **coder-execution.md** — Surgical context rule cho Gemini tools
- **qa-testing.md** — QA pipeline
- **superpower-sdlc.md** — SDLC orchestration

Khởi động gợi ý:

```bash
gemini --yolo
```

---

## Hướng dẫn sử dụng chi tiết

### 1. Khởi tạo dự án

```bash
cd your-project
omni init
```

CLI sẽ hỏi 3-4 bước:

**Bước 0 (auto) — Phát hiện project có sẵn:**
Nếu phát hiện `package.json`, `pyproject.toml`, `go.mod`... → hỏi `"Tạo Project Map?"`. Nếu Yes, scan codebase và sinh `.omni/project-map.md` sau khi init hoàn tất.

**Bước 1 — Chọn IDE/Tool:**
Chọn AI IDE bạn đang dùng (Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, ...). Mỗi IDE sẽ sinh file cấu hình riêng phù hợp.

**Bước 2 — Mức kỷ luật:**
- **Hardcore** — Ép 100% SDLC, AI phải tuân thủ mọi quy trình
- **Flexible** — Cho phép bỏ qua lỗi vặt, phù hợp khi prototyping

**Bước 3 — Personal Rules:**
4 câu hỏi cá nhân hóa, mỗi câu kèm mô tả và ví dụ theo scenario:

| Câu hỏi | Ví dụ trả lời |
|----------|---------------|
| Ngôn ngữ giao tiếp | `"Tiếng Việt, technical terms giữ English"` |
| Coding style / conventions | `"camelCase, 2-space indent, prefer FC + hooks, no class components"` |
| Forbidden patterns | `"không dùng any, không console.log trong production, không SQL thô"` |
| Custom rules | `"commit message tiếng Việt; mỗi PR tối đa 300 dòng; luôn viết test trước"` |

Nhấn **Enter** để bỏ qua bất kỳ câu nào. Sửa lại sau bằng `omni rules edit`.

### 2. Cài đặt skills

```bash
# Cài 6 universal skills (mặc định cho mọi dự án)
omni auto-equip

# Cài thêm skill từ skills.sh (chỉ cho IDE đã chọn)
omni equip vercel-labs/agent-skills
```

### 3. Sử dụng workflow trong chat AI

Sau khi init xong, mở IDE và gõ các lệnh `>om:` (hoặc `/om:` nếu dùng Claude Code):

```
Bạn: >om:brainstorm Làm app quản lý task cho team

AI: 📋 Tôi đã hiểu:
   • Mục tiêu: App quản lý task
   • Người dùng: [chưa rõ]
   • Tính năng: [chưa rõ]
   • DNA: [hasUI] + [Backend simple]
   ...
   ❓ Ai sẽ dùng sản phẩm này? Mỗi role có quyền khác nhau không?
      VD blog: "admin (CRUD bài viết), reader (đọc, comment)"
      VD SaaS: "owner (billing), member (dùng features), guest (view only)"

Bạn: admin (CRUD tasks, quản lý team), member (tạo/sửa task, comment)

AI: ... [tiếp tục phỏng vấn cho đến khi đủ thông tin] ...
   ✅ Đã tạo .omni/design-spec.md + .omni/content-source.md

Bạn: >om:equip
AI: [Cài skills phù hợp cho tech stack đã chọn]

Bạn: >om:plan
AI: [Tạo .omni/todo.md với micro-tasks, mỗi task gắn @skill:name]

Bạn: >om:cook
AI: [Bắt đầu code, tự động quality gate mỗi 1/3 tasks]
```

### 4. Quản lý Personal Rules

```bash
# Menu tương tác — xem, sửa, sync, reset
omni rules

# Hoặc dùng trực tiếp
omni rules view     # Xem rules hiện tại
omni rules edit     # Sửa rules (kèm inline hint ví dụ)
omni rules sync     # Sync rules vào file config (CLAUDE.md, .cursorrules, ...)
omni rules reset    # Xóa rules
```

Rules được lưu tại `.omni/rules.md` và tự động sync vào file config của IDE.

### 5. Kiểm tra trạng thái

```bash
omni status     # IDE, skills đã cài, config file
omni commands   # Danh sách lệnh >om: có sẵn
```

---

## Quy trình SDLC

Sau khi khởi tạo, gõ các lệnh `>om:` trong chat với AI:

| Lệnh | Agent | Mô tả |
|-------|-------|-------|
| `>om:brainstorm` | Architect | Phỏng vấn adaptive (1–5 câu theo độ phức tạp) + DNA detection, đề xuất tech stack, xuất `.omni/design-spec.md` + `.omni/content-source.md` |
| `>om:equip` | Skill Manager | Dùng find-skills search skills.sh dynamic + conditional skill groups theo DNA |
| `>om:plan` | PM | Phân tích spec → micro-tasks trong `.omni/todo.md`, gắn `@skill:name`, backend-aware ordering với `[infra]` tag |
| `>om:cook` | Coder | Thực thi từng task, dev server preflight, surgical context, auto-continue, quality gate mỗi 1/3 |
| `>om:check` | QA Tester | Validation pipeline (P0–P3 blocking, P5 Content Validation) + feature verification → `.omni/test-report.md` |
| `>om:fix` | Debugger | Reproduce → root cause → surgical fix → verify. Không shotgun-fix |
| `>om:map` | Architect | Quét codebase → điền mô tả semantic vào `.omni/project-map.md` |
| `>om:learn` | Knowledge | Auto-ghi bài học sau fix thành công vào `.omni/knowledge-base.md` |
| `>om:doc` | Writer | Đọc code thực tế → sinh README.md + API docs |

### Project DNA Detection

Khi chạy `>om:brainstorm`, AI tự động phân tích prompt để xác định DNA của dự án:

```
DNA Profile:
  hasUI              = true/false
  hasBackend         = true/false
  hasAPI             = true/false
  backendComplexity  = simple | moderate | complex
```

| backendComplexity | Signals |
|-------------------|---------|
| **simple** | CRUD, basic REST, single DB |
| **moderate** | Complex auth, file processing, 3rd-party integrations, full-text search |
| **complex** | Realtime/WebSocket, queue/worker, caching layer, microservices, event-driven |

DNA ảnh hưởng đến toàn bộ quy trình:
- **`>om:brainstorm`:** Thêm backend complexity probe nếu cần, thêm `[infra]` tag và Infrastructure section trong spec
- **`>om:equip`:** Kích hoạt nhóm Backend/Infrastructure skill khi `backendComplexity >= moderate`
- **`>om:plan`:** Backend-aware ordering (`DB → Cache → Queue/Worker → API → Realtime → UI`), `[infra]` task classification

### Content Source-of-Truth (v2.4.0)

Khi dự án có UI, `>om:brainstorm` tự động sinh `.omni/content-source.md` bên cạnh `.omni/design-spec.md`:

```markdown
# Content Source-of-Truth — [Project Name]

## Facts
- Project name: [tên chính xác]
- Project type: [open-source / commercial / SaaS / internal tool]
- [Key fact từ user input]

## Tone
- Voice: [e.g., "Technical but approachable"]
- Language: [e.g., "Vietnamese UI labels, English code"]

## Forbidden Content
- [e.g., "No pricing tiers — this is open-source"]
- [e.g., "No fake testimonials"]
- [e.g., "No placeholder lorem ipsum text"]
```

**Quality gate:**
- `## Facts` bắt buộc tối thiểu 3 verified facts (project name + project type + ít nhất 1 domain-specific fact). Nếu thiếu, AI hỏi thêm trước khi sinh file
- `>om:cook` dùng `.omni/content-source.md` làm ground truth khi tạo nội dung UI
- `>om:check` P5 validate: HIGH severity (mâu thuẫn Facts hoặc vi phạm Forbidden Content) → **BLOCKING**, LOW/MEDIUM → advisory

### Project Map — Codebase Intelligence (v2.4.5)

Khi tham gia dự án lớn đã có code, AI cần hiểu codebase mà không phải scan hàng trăm file mỗi session:

```bash
# CLI quét codebase (0 token, instant)
omni map

# Hoặc tự động khi init project có sẵn
omni init    # → "Phát hiện project có sẵn. Tạo Project Map?"
```

**Output:** `.omni/project-map.md` — skeleton với `[PENDING]` markers:

```markdown
# Project Map — my-app
> Generated by omni map | 2026-04-26 | 98 files, 12 dirs, ~5400 LOC

## Tech Stack
Runtime: Node.js | Lang: TypeScript | Framework: Express | DB: Prisma | Test: Jest

## Structure
- `src/modules/auth/`      (12 files) [PENDING]
- `src/modules/orders/`    (18 files) [PENDING]
- `src/utils/`             (5 files)  [PENDING]

## Key Patterns
[PENDING — AI fills this when running >om:map]
```

**Sau khi chạy `>om:map` trong chat AI:**

```markdown
## Structure
- `src/modules/auth/`      (12 files) → JWT login, OAuth2, 2FA, refresh rotation
- `src/modules/orders/`    (18 files) → Order state machine: draft→paid→shipped→done
- `src/utils/`             (5 files)  → Logger (pino), date/currency formatters

## Key Patterns
- Auth: JWT access (15m) + refresh (7d) rotation, Passport guards
- Error: Global exception filter → { code, message, details }
- DB: Prisma service with soft-delete middleware, repository pattern
```

**Staleness management:**

```bash
# Re-scan cấu trúc, đánh dấu thay đổi (0 token)
omni map --refresh
# → [NEW] cho thư mục mới, [DELETED] cho thư mục đã xóa
# → Giữ nguyên mô tả AI đã viết

# Workflows tự động cảnh báo khi map > 7 ngày
# >om:cook: "⚠️ Project Map cũ 12 ngày. Chạy omni map --refresh"
```

**Multi-language detection:** Node.js/TypeScript, Python, Go, Rust, Java/Kotlin, Ruby, PHP — phát hiện qua package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle, Gemfile, composer.json.

**Deep scan bao gồm:** Tech stack, directory tree (max depth 4), entry points, CI/CD configs, conventions (linter, formatter, tsconfig), landmines (TODO/FIXME/HACK), existing docs. Zero dependencies, zero network calls.

### Token Optimization

- **Lazy-loaded examples:** Interview question templates tách riêng thành `interview-examples.md`, chỉ đọc khi AI cần tham khảo
- **Surgical context rule:** Với file > 200 dòng, AI dùng grep/search trước để tìm code cần thiết, chỉ đọc ±20 dòng xung quanh — không đọc toàn bộ file
- **Context-aware verbosity:** `>om:cook` terse (chỉ báo task done, files changed), `>om:check` terse on PASS / verbose on FAIL, `>om:brainstorm`/`>om:plan` verbose
- **Shared Context Brief (Claude Code):** Main session extract ~500 tokens từ `.omni/design-spec.md` + shared files trước khi spawn parallel sub-agents — mỗi agent nhận brief thay vì tự đọc lại, tiết kiệm token đáng kể

### Automated Quality Pipeline

Khi `>om:cook` chạy, hệ thống tự động chia dự án thành **3 quality cycles**:

```
om:cook (1/3 tasks)
  → om:check
    → [om:fix ↔ om:check loop, tối đa 3 lần]
  → om:cook (1/3 tasks)
    → om:check
      → [om:fix ↔ om:check loop]
    → om:cook (1/3 tasks)
      → om:check
        → [om:fix ↔ om:check loop]
      → om:doc
```

- **Checkpoint** = `ceil(total_tasks / 3)` — quality gate trigger tự động
- **Fix loop** tối đa 3 lần/cycle — nếu vẫn lỗi, đánh dấu `[BLOCKED]` và escalate cho user
- **Auto-continue**: `>om:cook` tự động chạy task tiếp, chỉ dừng khi lỗi nghiêm trọng (build fail, breaking changes, security)
- **Dev Server Preflight**: `>om:cook` tự động khởi động dev server trước khi code task đầu tiên (nếu dự án có UI)
- **Knowledge Base**: Sau mỗi fix thành công, `>om:learn` auto-ghi bài học → `>om:cook` đọc lại khi gặp file tương tự

### Skill-Tagged Tasks

`>om:plan` tự động gắn `@skill:` tag cho mỗi task dựa trên skills đã cài:

```markdown
## 1. Database
- [ ] Tạo migration users table `@skill:supabase-postgres-best-practices`
- [ ] Seed data mẫu `@skill:supabase-postgres-best-practices`

## 2. Frontend
- [ ] Tạo trang login `@skill:vercel-react-best-practices` `@skill:tailwind-design-system`
- [ ] Thêm form validation `@skill:vercel-react-best-practices`
```

`>om:cook` đọc tag → load skill file tương ứng → áp dụng rules khi code.

---

## Validation Pipeline

Khi chạy `>om:check`, AI thực thi pipeline theo thứ tự:

| Priority | Check | Blocking? |
|----------|-------|-----------|
| P0 | **Security:** dependency audit, secrets leak, .env committed, eval/innerHTML, SQL injection | Yes |
| P1 | **Lint & Types:** ESLint/Biome, TypeScript, Python lint | Yes |
| P2 | **Build:** compile/bundle project | Yes |
| P3 | **Tests:** vitest/jest/pytest | Yes |
| P4 | **Bundle:** unused deps, bundle size | No (advisory) |
| P5 | **Content:** cross-check UI text vs `.omni/content-source.md` | HIGH = Yes, LOW/MEDIUM = No |

- P0–P3 fail → dừng ngay, auto-trigger `>om:fix`, loop cho đến khi pass
- P5 HIGH (mâu thuẫn Facts, vi phạm Forbidden Content) → dừng ngay, khuyến nghị `>om:fix`
- P5 LOW/MEDIUM (placeholder, fake data) → flag nhưng không block

---

## Cấu trúc dự án

```
omni-coder-kit/                    # Package (npm)
├── bin/omni.js                    # CLI chính (9 commands)
├── lib/
│   ├── helpers.js                 # Shared utilities (IDE maps, parsing, DNA detection)
│   └── scanner.js                 # Project scanner (detectExistingProject, scanProject, generateMapSkeleton, refreshMap)
├── templates/
│   ├── core/                      # Karpathy mindset + anti-hallucination (Paranoid)
│   ├── workflows/                 # SDLC workflows (13 files)
│   │   ├── requirement-analysis.md    # Brainstorm + DNA detection + .omni/content-source.md
│   │   ├── interview-examples.md      # Lazy-loaded question templates
│   │   ├── skill-manager.md           # Conditional skill groups
│   │   ├── task-planning.md           # Backend-aware ordering + [infra]
│   │   ├── coder-execution.md         # Surgical context rule + content validation
│   │   ├── qa-testing.md              # P0-P5 pipeline
│   │   ├── debugger-workflow.md       # + auto-trigger >om:learn
│   │   ├── documentation-writer.md
│   │   ├── knowledge-learn.md         # >om:learn — knowledge capture
│   │   ├── project-map.md            # >om:map — codebase intelligence
│   │   ├── superpower-sdlc.md
│   │   ├── pm-templates.md
│   │   └── validation-scripts.md
│   └── overlays/
│       ├── claude-code/           # Claude Code overlay
│       │   ├── commands/          # 9 slash commands (/om:*)
│       │   ├── workflows/         # Enhanced: parallel sub-agents + context brief + project map
│       │   └── settings.template.json
│       ├── codex/                 # Codex CLI overlay
│       │   ├── config.template.toml   # Profiles: omni_safe, omni_yolo, omni_review
│       │   ├── hooks.template.json
│       │   ├── docs/
│       │   └── workflows/
│       ├── cursor/                # Cursor overlay (v2.3.0)
│       │   ├── rules/            # 7 MDC files (.mdc)
│       │   └── workflows/        # Cursor-enhanced: YOLO, Agent Mode, @-mentions
│       └── gemini/                # Gemini CLI overlay
│           └── workflows/         # Gemini-optimized workflows
├── test/                          # 377 tests (node:test)
└── package.json
```

### Sau khi `omni init` — cấu trúc dự án người dùng

```
your-project/
├── CLAUDE.md (hoặc GEMINI.md, AGENTS.md, .cursorrules, ...)  # Config nhẹ (~5KB)
│   ├── Core rules (inline): Karpathy mindset + Anti-hallucination
│   ├── Command registry table: >om: → workflow file mapping
│   ├── IDE adapters
│   └── Personal rules
├── .omni/
│   ├── workflows/               # Lazy-loaded bởi AI khi cần
│   │   ├── requirement-analysis.md   # >om:brainstorm (DNA detection)
│   │   ├── interview-examples.md     # Lazy-loaded question templates
│   │   ├── skill-manager.md          # >om:equip (conditional groups)
│   │   ├── task-planning.md          # >om:plan ([infra] tag)
│   │   ├── coder-execution.md        # >om:cook (surgical context)
│   │   ├── qa-testing.md             # >om:check (P0-P5)
│   │   ├── debugger-workflow.md      # >om:fix
│   │   ├── knowledge-learn.md        # >om:learn
│   │   ├── project-map.md           # >om:map (codebase intelligence)
│   │   ├── documentation-writer.md   # >om:doc
│   │   └── ... (supporting files)
│   ├── project-map.md              # Bản đồ dự án (CLI skeleton + AI semantic)
│   ├── knowledge-base.md           # Bài học từ >om:learn (tối đa 20 entries)
│   ├── manifest.json               # Tracking: IDE, skills
│   ├── rules.md                    # Personal rules (nếu có)
│   ├── design-spec.md              # Output của >om:brainstorm
│   ├── content-source.md           # Content source-of-truth (UI projects)
│   ├── todo.md                     # Output của >om:plan
│   └── test-report.md              # Output của >om:check
```

**Token optimization:** Config file chỉ chứa core rules + bảng registry (~5KB thay vì ~36KB). AI chỉ đọc workflow file khi lệnh `>om:` tương ứng được gọi, và chỉ đọc example files khi cần tham khảo. Fallback: nếu `.omni/workflows/` không tồn tại → đọc từ `node_modules/omni-coder-kit/templates/workflows/`.

---

## Nguồn cảm hứng

Dự án được tham khảo và lấy ý tưởng từ nhiều nguồn:
- [antigravity-kit](https://github.com/vudovn/antigravity-kit)
- [karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)
- Claudekit

---

## Giấy phép

ISC — Phát triển bởi [TAV](mailto:tav99.dev@gmail.com).
