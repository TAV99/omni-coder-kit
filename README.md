# Omni-Coder Kit

**Omni-Coder Kit** là công cụ CLI inject mindset, SDLC workflow và skills vào các AI coding agent. Đảm bảo AI hoạt động với kỷ luật Senior Engineer, tuân thủ SDLC nghiêm ngặt và sử dụng mẫu thiết kế tối ưu.

## Tính năng chính

- **Đa IDE:** Claude Code, Codex CLI, Cursor, Windsurf, Antigravity, Cross-tool, Generic — mỗi IDE sinh file cấu hình riêng
- **Dual-Agent:** Tạo cả `CLAUDE.md` + `AGENTS.md` cùng lúc cho dự án dùng nhiều AI tool
- **Karpathy Mindset:** 4 nguyên tắc — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution
- **Socratic Gate:** Bắt buộc AI hỏi tối thiểu 3 câu trước khi code (kèm ví dụ mẫu cho từng loại câu hỏi) — không có ngoại lệ
- **Personal Rules:** Phỏng vấn có hướng dẫn khi `omni init` — ngôn ngữ giao tiếp, coding style, forbidden patterns, custom rules — kèm ví dụ theo scenario (React, Node.js, Python)
- **Phỏng vấn kiến trúc:** `>om:brainstorm` phỏng vấn 6 dimensions (Goal, Users, Features, Constraints, Edge Cases, UI) — mỗi câu hỏi AI đặt ra đều có mô tả, gợi ý, và ví dụ cụ thể
- **Universal Skills:** 6 skills mặc định (find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees)
- **Dynamic Skill Discovery:** `>om:equip` dùng `find-skills` search skills.sh theo tech stack — không giới hạn framework
- **IDE-Aware Skills:** `auto-equip` chỉ cài skill cho IDE/CLI đã chọn (không cài tất cả), dùng `--agent` flag của skills.sh
- **Skill-Tagged Tasks:** `>om:plan` gắn `@skill:name` cho từng task trong `todo.md`, `>om:cook` tự động load skill tương ứng khi thực thi
- **Automated Quality Pipeline:** 3 quality cycles bắt buộc — `cook → check → fix` loop tự động sau mỗi 1/3 tasks
- **Lazy Loading & Token Optimization:** Config file chỉ ~5KB (core rules + registry table), workflows lazy-loaded khi cần — tiết kiệm ~85% token so với inline
- **Anti-Hallucination (Paranoid Mode):** Grounding rules, self-verification checklist, no phantom imports/APIs
- **Antigravity:** Dùng `AGENTS.md` + `.agents/` directory (rules, skills, workflows)
- **Claude Code Overlay:** Slash commands `/om:*`, permissions allowlist, quality gate hooks — cài tự động khi chọn Claude Code
- **Validation Pipeline:** Security → Lint → Build → Tests → Bundle analysis — blocking tự động
- **Skills.sh:** Tích hợp skills.sh ecosystem — conflict detection, manifest tracking

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
omni init

# 2. Cài universal skills (6 skills mặc định)
omni auto-equip

# 3. Cài thêm skill từ skills.sh (chỉ cho IDE đã chọn)
omni equip vercel-labs/agent-skills

# 4. Xem trạng thái
omni status

# 5. Xem danh sách lệnh >om:
omni commands

# 6. Cập nhật lên phiên bản mới nhất
omni update
```

---

## Lệnh CLI

| Lệnh | Mô tả |
|-------|-------|
| `omni init` | Khởi tạo DNA và workflow cho dự án mới |
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
| Codex CLI (OpenAI) | `AGENTS.md` | `codex --full-auto` |
| Claude Code + Codex (dual) | `CLAUDE.md` + `AGENTS.md` | Cả 2 lệnh trên |
| Antigravity | `AGENTS.md` | Dùng `.agents/` directory cho rules, skills, workflows |
| Cursor | `.cursorrules` | Mở Cursor trong thư mục dự án |
| Windsurf | `.windsurfrules` | Mở Windsurf trong thư mục dự án |
| Cross-tool | `AGENTS.md` | Tool-agnostic |
| Generic | `SYSTEM_PROMPT.md` | — |

### Claude Code Overlay (tính năng nâng cao)

Khi chọn **Claude Code**, `omni init` tự động cài thêm:

- **Slash commands `/om:*`** — 7 lệnh tương ứng với `>om:*`, gõ trực tiếp trong Claude Code
- **Permissions allowlist** — `.claude/settings.json` với các lệnh build/test/git được allow sẵn, deny các lệnh nguy hiểm (`rm -rf`, `git push --force`, `git reset --hard`)
- **Quality gate hooks** — Tự động nhắc AI kiểm tra chất lượng khi file thay đổi

Khi được hỏi `"🔧 Cài đặt Claude Code nâng cao?"`, chọn **Yes** để kích hoạt permissions + hooks.

---

## Hướng dẫn sử dụng chi tiết

### 1. Khởi tạo dự án

```bash
cd your-project
omni init
```

CLI sẽ hỏi 3 bước:

**Bước 1 — Chọn IDE/Tool:**
Chọn AI IDE bạn đang dùng (Claude Code, Cursor, Windsurf, ...). Mỗi IDE sẽ sinh file cấu hình riêng phù hợp.

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
   ...
   ❓ Ai sẽ dùng sản phẩm này? Mỗi role có quyền khác nhau không?
      VD blog: "admin (CRUD bài viết), reader (đọc, comment)"
      VD SaaS: "owner (billing), member (dùng features), guest (view only)"

Bạn: admin (CRUD tasks, quản lý team), member (tạo/sửa task, comment)

AI: ... [tiếp tục phỏng vấn cho đến khi đủ thông tin] ...
   ✅ Đã tạo design-spec.md

Bạn: >om:equip
AI: [Cài skills phù hợp cho tech stack đã chọn]

Bạn: >om:plan
AI: [Tạo todo.md với micro-tasks, mỗi task gắn @skill:name]

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

Rules được lưu tại `.omni-rules.md` và tự động sync vào file config của IDE.

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
| `>om:brainstorm` | Architect | Phỏng vấn 2 vòng (6 dimensions + design), đề xuất tech stack, xuất `design-spec.md` |
| `>om:equip` | Skill Manager | Dùng find-skills search skills.sh dynamic + cài universal skills |
| `>om:plan` | PM | Phân tích spec → micro-tasks trong `todo.md`, gắn `@skill:name` cho từng task |
| `>om:cook` | Coder | Thực thi từng task, load skill theo `@skill:` tag, auto-continue, quality gate mỗi 1/3 |
| `>om:check` | QA Tester | Validation pipeline (P0–P3 blocking) + feature verification → `test-report.md` |
| `>om:fix` | Debugger | Reproduce → root cause → surgical fix → verify. Không shotgun-fix |
| `>om:doc` | Writer | Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt |

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
- **Fix loop** tối đa 3 lần/cycle — nếu vẫn lỗi, escalate cho user
- **Auto-continue**: `>om:cook` tự động chạy task tiếp, chỉ dừng khi lỗi nghiêm trọng (build fail, breaking changes, security)

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

P0–P3 fail → dừng ngay, auto-trigger `>om:fix`, loop cho đến khi pass.

---

## Cấu trúc dự án

```
omni-coder-kit/                  # Package (npm)
├── bin/omni.js                  # CLI chính (8 commands)
├── templates/
│   ├── core/                    # Karpathy mindset + anti-hallucination (Paranoid)
│   ├── workflows/               # SDLC workflows (10 files)
│   └── overlays/
│       └── claude-code/         # Claude Code overlay
│           ├── commands/        # 7 slash commands (/om:*)
│           ├── workflows/       # Enhanced workflows
│           └── settings.template.json  # Permissions + hooks
├── package.json
└── .omni-manifest.json          # Tracking: IDE, skills, config file
```

### Sau khi `omni init` — cấu trúc dự án người dùng

```
your-project/
├── CLAUDE.md (hoặc AGENTS.md, .cursorrules, ...)  # Config nhẹ (~5KB)
│   ├── Core rules (inline): Karpathy mindset + Anti-hallucination
│   ├── Command registry table: >om: → workflow file mapping
│   ├── IDE adapters
│   └── Personal rules
├── .omni/
│   └── workflows/               # Lazy-loaded bởi AI khi cần
│       ├── requirement-analysis.md   # >om:brainstorm
│       ├── skill-manager.md          # >om:equip
│       ├── task-planning.md          # >om:plan
│       ├── coder-execution.md        # >om:cook
│       ├── qa-testing.md             # >om:check
│       ├── debugger-workflow.md      # >om:fix
│       ├── documentation-writer.md   # >om:doc
│       └── ... (supporting files)
├── .omni-manifest.json          # Tracking: IDE, skills
└── .omni-rules.md               # Personal rules (nếu có)
```

**Token optimization:** Config file chỉ chứa core rules + bảng registry (~5KB thay vì ~36KB). AI chỉ đọc workflow file khi lệnh `>om:` tương ứng được gọi, tiết kiệm token đáng kể. Fallback: nếu `.omni/workflows/` không tồn tại → đọc từ `node_modules/omni-coder-kit/templates/workflows/`.

---

## Nguồn cảm hứng

Dự án được tham khảo và lấy ý tưởng từ nhiều nguồn:
- [antigravity-kit](https://github.com/vudovn/antigravity-kit)
- [karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)
- Claudekit (dù chưa được xài :D)

---

## Giấy phép

ISC — Phát triển bởi [TAV](mailto:tav99.dev@gmail.com).
