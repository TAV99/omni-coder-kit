# Omni-Coder Kit

**Omni-Coder Kit** là công cụ CLI quản lý hệ tư tưởng (mindset + workflow + skills) cho các AI coding agent. Đảm bảo AI hoạt động với kỷ luật Senior Engineer, tuân thủ SDLC nghiêm ngặt và sử dụng mẫu thiết kế tối ưu.

## Tính năng chính

- **Đa IDE:** Claude Code (`CLAUDE.md`), Codex CLI (`AGENTS.md`), Cursor (`.cursorrules`), Windsurf (`.windsurfrules`), Antigravity (`.antigravityrules`), Generic (`SYSTEM_PROMPT.md`)
- **Dual-Agent:** Tạo cả `CLAUDE.md` + `AGENTS.md` cùng lúc cho dự án dùng nhiều AI tool
- **Karpathy Mindset:** 4 nguyên tắc First Principles — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution
- **Socratic Gate:** Bắt buộc AI hỏi tối thiểu 3 câu trước khi code — không có ngoại lệ cho feature mới
- **Phỏng vấn 6 dimensions:** Business Goal, User Persona, Functional, Non-Functional, Edge Cases, Tech Stack — kèm phỏng vấn thiết kế cho dự án có UI
- **Validation Pipeline:** Security scan → Lint → Build → Tests → Bundle analysis — chạy tự động khi QA check
- **Tech Stacks:** React/Next.js, Hono/PostgreSQL, Automation Bot, Payment Gateway
- **Skills.sh:** Tích hợp skills.sh ecosystem — auto-equip theo tech stack, conflict detection, manifest tracking

---

## Cài đặt

Yêu cầu [Node.js](https://nodejs.org/) >= 16.0.0.

```bash
git clone https://github.com/TAV99/omni-coder-kit.git
cd omni-coder-kit
npm install
npm link  # tùy chọn — liên kết CLI toàn cục
```

---

## Bắt đầu nhanh

```bash
# 1. Khởi tạo — chọn IDE, mức kỷ luật, tech stack
omni init

# 2. Xem kỹ năng có sẵn
omni list

# 3. Thêm tech stack
omni add react-next

# 4. Cài skill từ skills.sh
omni equip vercel-labs/agent-skills

# 5. Auto-equip theo design-spec
omni auto-equip --design-spec design-spec.md

# 6. Xem trạng thái
omni status
```

### IDE hỗ trợ khi `omni init`

| Lựa chọn | File tạo ra | Ghi chú |
|-----------|------------|---------|
| Claude Code / OpenCode | `CLAUDE.md` | |
| Codex CLI (OpenAI) | `AGENTS.md` | Sandbox awareness, 32 KiB limit |
| Claude Code + Codex (dual) | `CLAUDE.md` + `AGENTS.md` | Tạo cả 2 file |
| Cursor | `.cursorrules` | |
| Windsurf | `.windsurfrules` | |
| Antigravity | `.antigravityrules` | Knowledge Items, Multi-Agent |
| Cross-tool | `AGENTS.md` | Tool-agnostic |
| Generic | `SYSTEM_PROMPT.md` | |

---

## Quy trình SDLC

Sau khi khởi tạo, dùng các lệnh workflow trong chat với AI:

| Lệnh | Agent | Mô tả |
|-------|-------|-------|
| `>om:brainstorm` | Architect | Phỏng vấn 2 vòng (6 dimensions + design interview cho UI), đề xuất tech stack, xuất `design-spec.md` |
| `>om:equip` | Skill Manager | Đề xuất và cài skills chuyên sâu từ skills.sh theo stack đã chọn |
| `>om:plan` | PM | Phân tích spec → micro-tasks trong `todo.md` (mỗi task < 20 phút) |
| `>om:cook` | Coder | Thực thi từng task, surgical changes, đánh dấu done, gợi ý check mỗi 5 tasks |
| `>om:check` | QA Tester | Validation pipeline (P0 Security → P1 Lint → P2 Build → P3 Tests) + feature verification → `test-report.md` |
| `>om:fix` | Debugger | Reproduce → Root cause → Surgical fix → Verify. Không shotgun-fix |
| `>om:doc` | Writer | Đọc code thực tế → README.md + API docs bằng tiếng Việt |

### Luồng đề xuất

```
>om:brainstorm → >om:equip → >om:plan → >om:cook → >om:check → >om:fix (nếu cần) → >om:doc
```

---

## Validation Pipeline

Khi chạy `>om:check`, AI tự động thực thi pipeline theo thứ tự ưu tiên:

| Priority | Check | Blocking? |
|----------|-------|-----------|
| P0 | **Security:** dependency audit, secrets leak, .env committed, eval/innerHTML, SQL injection | Yes |
| P1 | **Lint & Types:** ESLint/Biome, TypeScript, Python lint | Yes |
| P2 | **Build:** compile/bundle project | Yes |
| P3 | **Tests:** vitest/jest/pytest | Yes |
| P4 | **Bundle:** unused deps, bundle size | No (advisory) |

Nếu P0-P3 fail → dừng ngay, không verify feature, đề xuất `>om:fix`.

---

## Cấu trúc dự án

```
omni-coder-kit/
├── bin/omni.js              # CLI chính (6 commands)
├── templates/
│   ├── core/                # Karpathy mindset + context hygiene
│   ├── stacks/              # Tech stack rules (react-next, hono-pg, ...)
│   └── workflows/           # SDLC workflows (10 files)
│       ├── superpower-sdlc.md        # Định nghĩa workflow commands
│       ├── requirement-analysis.md   # >om:brainstorm (6 dimensions + design)
│       ├── skill-manager.md          # >om:equip
│       ├── task-planning.md          # >om:plan
│       ├── coder-execution.md        # >om:cook
│       ├── qa-testing.md             # >om:check
│       ├── validation-scripts.md     # Security/lint/build/test pipeline
│       ├── debugger-workflow.md      # >om:fix
│       ├── documentation-writer.md   # >om:doc
│       └── pm-templates.md           # Output format standards
├── package.json
└── .omni-manifest.json      # Tracking skills đã cài
```

---

## Giấy phép

ISC — Phát triển bởi [TAV](mailto:tav99.dev@gmail.com).
