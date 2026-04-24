# Design Spec — Claude Code Optimization (Layered Templates)

> Generated: 2026-04-24 | Complexity: Large
> Approach: Layered Templates (base workflows + Claude Code overlay)

## Summary

| Field | Value |
|-------|-------|
| Goal | Tối ưu omni-coder-kit cho Claude Code — tận dụng native features (slash commands, sub-agents, hooks, settings) |
| Target Users | Community npm users (primary), TAV power-user (secondary) |
| Approach | Overlay system: giữ base workflows generic, thêm Claude Code overlay cho phần khác biệt |
| Key Feature | Sub-agent parallel execution trong `/om:cook` với dependency graph analysis + worktree isolation |
| Version | 2.1.0 |
| Backward Compat | 100% — `>om:` text commands + các IDE khác không bị ảnh hưởng |

---

## 1. Kiến trúc Overlay System

### Nguyên tắc

Base workflows (generic) giữ nguyên — mọi IDE đọc được. Overlay chỉ chứa phần **extend/replace** cho Claude Code. `omni init` khi chọn Claude Code sẽ merge base + overlay.

### Cấu trúc thư mục mới trong kit

```
templates/
├── core/                         # Giữ nguyên (karpathy, hygiene)
├── workflows/                    # Base layer — generic, mọi IDE
│   ├── requirement-analysis.md
│   ├── skill-manager.md
│   ├── task-planning.md
│   ├── coder-execution.md        # Base: tuần tự, 1 task/lần
│   ├── qa-testing.md
│   ├── debugger-workflow.md
│   ├── documentation-writer.md
│   ├── superpower-sdlc.md
│   └── ...
└── overlays/
    └── claude-code/
        ├── commands/              # Native slash commands (.claude/commands/)
        │   ├── om:brainstorm.md
        │   ├── om:equip.md
        │   ├── om:plan.md
        │   ├── om:cook.md
        │   ├── om:check.md
        │   ├── om:fix.md
        │   └── om:doc.md
        ├── settings.template.json # Permissions, allowlists, hooks
        └── workflows/             # Override cụ thể
            ├── coder-execution.md # Replace: +dependency graph +sub-agent parallel
            └── superpower-sdlc.md # Replace: +native command table +agent routing
```

### Merge logic

1. Đọc base workflow files từ `templates/workflows/`
2. Nếu user chọn Claude Code:
   - Check `overlays/claude-code/workflows/` — file trùng tên → **replace** base
   - File không có overlay → giữ base nguyên
   - Sinh `.claude/commands/` từ `overlays/claude-code/commands/`
   - Nếu progressive = yes → sinh `.claude/settings.json` từ `settings.template.json`
3. Output: `CLAUDE.md` (merged) + `.omni/workflows/` + `.claude/` structure

### Output khi chạy `omni init` chọn Claude Code

```
your-project/
├── CLAUDE.md                      # Core rules + Claude Code adapter (enhanced)
├── .omni/
│   └── workflows/                 # Merged workflows (base hoặc overlay)
│       ├── coder-execution.md     # ← overlay version (sub-agent parallel)
│       ├── superpower-sdlc.md     # ← overlay version (enhanced registry)
│       ├── requirement-analysis.md # ← base (không cần override)
│       └── ...
├── .claude/
│   ├── commands/                  # Native slash commands
│   │   ├── om:brainstorm.md
│   │   ├── om:cook.md
│   │   └── ...
│   └── settings.json              # (progressive only)
└── .omni-manifest.json
```

---

## 2. Native Slash Commands

### Mapping `>om:` → `/om:` commands

| Text command | Slash command | File path |
|---|---|---|
| `>om:brainstorm` | `/om:brainstorm` | `.claude/commands/om:brainstorm.md` |
| `>om:equip` | `/om:equip` | `.claude/commands/om:equip.md` |
| `>om:plan` | `/om:plan` | `.claude/commands/om:plan.md` |
| `>om:cook` | `/om:cook` | `.claude/commands/om:cook.md` |
| `>om:check` | `/om:check` | `.claude/commands/om:check.md` |
| `>om:fix` | `/om:fix` | `.claude/commands/om:fix.md` |
| `>om:doc` | `/om:doc` | `.claude/commands/om:doc.md` |

Namespace `om:` giữ brand identity, tránh conflict với Claude Code native commands (`/review`, `/init`, `/help`...).

### Slash command = thin launcher

Mỗi file chỉ trỏ về workflow file thực tế:

```markdown
# .claude/commands/om:cook.md
Read the workflow file `.omni/workflows/coder-execution.md` and execute it.
This project uses Omni-Coder Kit SDLC workflow.
If `todo.md` does not exist, tell the user to run /om:plan first.
```

Lý do thin launcher:
- **Single source of truth:** Logic nằm ở workflow file, không duplicate
- **`>om:` vẫn hoạt động:** CLAUDE.md command registry trỏ về cùng workflow files
- **Dễ update:** `omni update` chỉ cần update workflow files, không cần regenerate commands

### Backward compatibility trong CLAUDE.md

CLAUDE.md giữ command registry table với cả hai cột:

```markdown
## WORKFLOW COMMANDS
> Claude Code: dùng `/om:*` slash commands hoặc `>om:*` trong chat.

| Command | Slash | Agent Strategy | Workflow |
|---------|-------|---------------|----------|
| >om:brainstorm | /om:brainstorm | Main session | requirement-analysis.md |
| >om:equip | /om:equip | Main session | skill-manager.md |
| >om:plan | /om:plan | Main session | task-planning.md |
| >om:cook | /om:cook | Main → sub-agents (parallel) | coder-execution.md |
| >om:check | /om:check | Main session | qa-testing.md |
| >om:fix | /om:fix | Main session | debugger-workflow.md |
| >om:doc | /om:doc | Main session | documentation-writer.md |
```

---

## 3. Sub-Agent Parallel Execution trong `/om:cook`

### 3.1 Dependency Graph Analysis

Khi `/om:cook` chạy, trước khi code, AI sẽ:

1. **Parse `todo.md`** — đọc tất cả tasks, nhóm theo component
2. **Build dependency graph** — xác định task nào phụ thuộc task nào:
   - **Thứ tự component:** DB → API → Frontend (component trước block component sau)
   - **Cùng file:** 2 tasks cùng sửa 1 file → tuần tự (tránh merge conflict)
   - **Import chain:** Task tạo module A, task khác import A → tuần tự
   - **Độc lập:** 2 tasks khác component, khác file, không import lẫn nhau → song song
3. **Output execution plan** trước khi bắt đầu:

```
📊 Dependency Analysis — 12 tasks total

Batch 1 (parallel, 3 agents):
  ├─ Agent A: [DB] Create users migration
  ├─ Agent B: [DB] Create products migration
  └─ Agent C: [Config] Setup environment variables

Batch 2 (parallel, 2 agents) — blocked by Batch 1:
  ├─ Agent D: [API] POST /api/users endpoint
  └─ Agent E: [API] GET /api/products endpoint

Batch 3 (sequential) — blocked by Batch 2:
  └─ [Frontend] Login page (depends on /api/users)

Batch 4 (sequential):
  └─ [Frontend] Product list (depends on /api/products)

Tiến hành? (y/n)
```

### 3.2 Sub-Agent Dispatch

Mỗi batch spawn **General sub-agents với worktree isolation**:

- **Max parallel agents:** Tối đa 4 agents/batch — giữ resource usage hợp lý, tránh overwhelm hệ thống
- **Worktree isolation:** Mỗi agent làm việc trên git worktree riêng → không conflict khi sửa song song
- **Agent prompt:** Mỗi agent nhận đầy đủ context — task description, relevant design-spec excerpt, skill files cần load, file paths cần sửa
- **Merge back:** Sau khi batch xong, main session merge worktrees về branch chính
- **Fallback:** Nếu merge conflict → main session resolve, hoặc escalate cho user

### 3.3 Khi nào KHÔNG dùng sub-agents

| Điều kiện | Strategy |
|---|---|
| ≤ 3 tasks tổng | Tuần tự — overhead spawn agents không đáng |
| Tất cả tasks cùng 1 file | Tuần tự — conflict chắc chắn |
| Tasks độc lập, khác file | Song song (worktree) |
| User nói "tuần tự" | Tuần tự — respect user choice |

### 3.4 Quality Gate integration

Quality gate vẫn trigger mỗi 1/3 tasks. Đếm theo **tasks hoàn thành** bất kể batch nào. Sau mỗi batch xong → check progress → nếu đạt checkpoint → trigger `/om:check`.

### 3.5 Base workflow không thay đổi

Base `coder-execution.md` giữ nguyên tuần tự. Chỉ overlay Claude Code mới có sub-agent logic.

---

## 4. Progressive Setup — Advanced Config

### Trigger

Sau khi sinh CLAUDE.md + `.claude/commands/` + `.omni/workflows/`, kit hỏi:

```
🔧 Bạn muốn cài đặt Claude Code nâng cao?
   Bao gồm: permissions allowlist, quality gate hooks, safety rules
   (y/n)
```

**No** → xong, minimal setup đủ dùng.
**Yes** → sinh thêm `.claude/settings.json`.

### `.claude/settings.json` — Permissions & Hooks

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run build)",
      "Bash(npm run lint)",
      "Bash(npm test)",
      "Bash(npx vitest*)",
      "Bash(npx jest*)",
      "Bash(git status)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git add*)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(find *)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(git push --force*)",
      "Bash(git reset --hard*)"
    ]
  },
  "hooks": {
    "postToolCall": [
      {
        "matcher": "Write|Edit",
        "command": "echo '[omni] File changed — remember quality gate at checkpoint'"
      }
    ]
  }
}
```

**Nguyên tắc permissions:** Allow read-only + build/test. Deny destructive. User tự thêm/bớt.

**Nguyên tắc hooks:** Chỉ lightweight reminder/notification — không block workflow. Quality gate logic nặng vẫn nằm trong workflow file (AI tự đếm tasks, tự trigger check).

---

## 5. Enhanced CLAUDE.md Adapter

### Claude Code adapter section mới

```markdown
## IDE SPECIFIC ADAPTERS

### Claude Code Integration
- **Native Commands:** Dùng `/om:brainstorm`, `/om:cook`, ... (auto-complete)
  hoặc gõ `>om:brainstorm`, `>om:cook` trong chat — cả hai đều hoạt động.
- **Sub-Agent Execution:** Khi `/om:cook` chạy, phân tích dependency graph
  trong `todo.md` và spawn parallel agents (worktree isolation) cho tasks độc lập.
  Xem chi tiết: `.omni/workflows/coder-execution.md`
- **Task Tracking:** Dùng TaskCreate/TaskUpdate để track progress khi thực thi tasks,
  thay vì chỉ dựa vào `todo.md` checkboxes.
- **Safety:** KHÔNG thực thi destructive commands (rm -rf, git push --force,
  git reset --hard) mà không có permission user.
- **Workflow Files:** Tất cả logic nằm trong `.omni/workflows/`.
  Khi nhận lệnh `>om:*` hoặc `/om:*`, đọc file tương ứng rồi thực thi.
```

### Token budget

| Component | Size |
|---|---|
| Core rules (karpathy + hygiene) | ~3KB (giữ nguyên) |
| Command registry table | ~1KB (thêm 2 cột) |
| Claude Code adapter | ~0.5KB (từ 1 dòng → 6 dòng) |
| Personal rules | ~0.5KB (tùy user) |
| **Tổng** | **~5KB** (không tăng đáng kể) |

Logic nặng vẫn lazy-load từ `.omni/workflows/`.

---

## 6. Thay đổi trong `bin/omni.js`

### Init flow mới cho Claude Code

```
omni init
  → Chọn IDE: "Claude Code"
  → Chọn discipline level (giữ nguyên)
  → Personal rules (giữ nguyên)
  → [MỚI] "Bạn muốn cài đặt Claude Code nâng cao? (y/n)"

  Output (minimal):
    ✅ Đã tạo: CLAUDE.md
    ✅ Đã tạo: .claude/commands/ (7 slash commands)
    ✅ Đã tạo: .omni/workflows/ (overlay merged)

  Output (advanced):
    ✅ Đã tạo: CLAUDE.md
    ✅ Đã tạo: .claude/commands/ (7 slash commands)
    ✅ Đã tạo: .claude/settings.json (permissions + hooks)
    ✅ Đã tạo: .omni/workflows/ (overlay merged)
```

### Hàm mới cần thêm

```
buildWorkflows(ide)
  1. Copy tất cả files từ templates/workflows/ → output list
  2. Nếu overlays/{ide}/workflows/ tồn tại:
     - File trùng tên → replace bằng overlay version
     - File mới trong overlay → thêm vào
  3. Return merged file list

buildCommands(ide)
  1. Nếu overlays/{ide}/commands/ tồn tại:
     - Copy tất cả command files
  2. Return command file list

buildSettings(ide, advanced)
  1. Nếu advanced = false → skip
  2. Đọc overlays/{ide}/settings.template.json
  3. Return settings content
```

### Manifest update

`.omni-manifest.json` thêm fields:

```json
{
  "ide": "claudecode",
  "version": "2.1.0",
  "overlay": true,
  "advanced": true,
  "commands": ["om:brainstorm", "om:equip", "om:plan", "om:cook", "om:check", "om:fix", "om:doc"],
  "skills": { "universal": [], "external": [] }
}
```

Thêm `overlay` và `advanced` flags — giúp `omni update` biết cần regenerate gì.

### Các IDE khác — không ảnh hưởng

Nếu user chọn Codex, Cursor, Windsurf, Antigravity → flow hiện tại giữ nguyên 100%. Overlay chỉ apply khi `overlays/{ide}/` tồn tại.

---

## 7. Scope

### Trong scope (v2.1.0)

1. Overlay system — `templates/overlays/claude-code/` với merge logic
2. 7 slash commands — `.claude/commands/om:*.md` (thin launchers)
3. Overlay workflow: `coder-execution.md` — dependency graph + sub-agent parallel dispatch
4. Overlay workflow: `superpower-sdlc.md` — enhanced command registry + agent strategy column
5. Progressive setup — 1 câu hỏi yes/no → sinh settings.json + hooks
6. Enhanced CLAUDE.md adapter — 6 dòng thay vì 1
7. `omni.js` updates — `buildWorkflows()`, `buildCommands()`, `buildSettings()`, merge logic, manifest update
8. Backward compat — `>om:` text commands vẫn hoạt động, các IDE khác không bị ảnh hưởng

### Ngoài scope (tương lai)

- Overlay cho Antigravity, Cursor, Windsurf (dùng cùng pattern)
- `omni update` tự detect overlay changes và regenerate
- MCP server integration
- Hook-based auto-lint on save
- Sub-agent trong `/om:check` (parallel test suites)

### Không làm (YAGNI)

- GUI/TUI cho dependency graph visualization
- Custom agent model selection trong config
- Plugin system cho overlays
