# Design Spec — Adaptive Interview Flow for `>om:brainstorm`

> Date: 2026-04-24 | Scope: `templates/workflows/requirement-analysis.md` + `templates/workflows/pm-templates.md`

## Problem

The current `>om:brainstorm` workflow has 4 phases (Deep Interview, Design Interview, Tech Stack Proposal, Spec Generation) requiring 7-12 questions minimum. This is too long for simple projects, too rigid for complex ones, and outputs prose that `>om:plan` struggles to parse into tasks.

## Design Summary

| Field | Value |
|-------|-------|
| Approach | A+C: Extract-then-Ask + Smart Interview |
| Phases | 2 (down from 4) |
| Min questions | 1 (simple project) |
| Max questions | 5 + decompose (complex project) |
| Output format | Hybrid: structured summary table + tagged requirement list |
| Scope detection | Auto-decompose for large projects |
| Socratic Gate | Soft — always >=1 question, no fixed quota |
| UI/Design interview | Merged into adaptive flow (0-1 extra question) |
| Tech stack selection | Inline or auto-selected, no dedicated phase |
| Skills auto-equip | Non-blocking suggestion after spec generation |

## Phase 1: Extract, Classify & Interview

### Step 1: Extract & Classify (AI-internal, no questions asked)

AI parses the user's prompt and extracts info into 6 slots:

| Slot | Description | Example |
|------|-------------|---------|
| `goal` | Business objective | "app quản lý học viên" |
| `users` | Roles/personas | "admin, giáo viên, học viên" |
| `features` | Core functionality | "CRUD, điểm danh, báo cáo" |
| `constraints` | Tech stack, budget, timeline | "dùng Supabase, deploy Vercel" |
| `edge_cases` | Error scenarios, limits | Usually empty at this stage |
| `ui_hint` | UI presence indicator | "dashboard", "landing page", "API only" |

Complexity classification based on extracted info:

| Complexity | Indicators | Max questions |
|------------|-----------|---------------|
| **Small** | <=2 features, <=2 roles, no integrations | 1 |
| **Medium** | 3-5 features, DB + API + UI | 3 |
| **Large** | 6+ features or multi-service | 5 + auto-decompose |

AI displays extraction result to user:
```
📋 Tôi đã hiểu:
   • Mục tiêu: [goal]
   • Người dùng: [users]
   • Tính năng: [features]
   • Ràng buộc: [constraints]
   • Quy mô: [small/medium/large]

❓ Còn thiếu: [list empty/ambiguous slots]
```

### Step 2: Adaptive Questions (only ask what's missing)

Rules:
- Each question targets 1 empty or ambiguous slot
- Prefer multiple-choice format when possible
- If project has UI and `ui_hint` detected, merge 1 visual direction question into this flow (no separate design phase)
- **Soft gate**: always ask at least 1 question, even if all slots are filled — that question is an edge case probe or scope confirmation
- After each answer, AI re-evaluates: enough info? If yes, proceed to Phase 2

### Step 3: Auto-decompose (Large projects only)

If complexity = Large:
```
⚠️ Dự án này có [N] tính năng lớn. Đề xuất tách:
   1. [Sub-project A] — [short description]
   2. [Sub-project B] — [short description]
   3. [Sub-project C] — [short description]

Bắt đầu từ đâu? (1/2/3)
```
Each sub-project runs through Steps 1-2 independently and generates its own `design-spec.md` (named `design-spec-[subproject].md`). The first sub-project uses `design-spec.md` as filename.

### Tech Stack Handling (merged, no dedicated phase)

- **User specified stack**: Use it. No alternatives.
- **User says "AI chọn" or doesn't mention**: AI picks best fit, writes 1-line justification in Summary table.
- **Clear trade-off exists**: AI asks 1 multiple-choice question merged into adaptive flow.

## Phase 2: Generate `design-spec.md`

### Part A: Structured Summary (machine-readable)

```markdown
# Design Spec — [Project Name]
> Generated: [date] | Complexity: [small/medium/large]

## Summary
| Field | Value |
|-------|-------|
| Goal | [1 sentence] |
| Users | [role1, role2, ...] |
| Tech Stack | [frontend], [backend], [db], [deploy] ([1-line justification]) |
| UI Style | [style] or "API only" |
| Constraints | [list] |
```

### Part B: Tagged Requirement List (pre-task format)

Each requirement is a bullet with a **category tag**:

```markdown
## Requirements

### Core
- [func] Feature description
- [func] Another feature

### Auth & Permissions
- [auth] Role: permissions description

### Non-Functional
- [nfr] Performance/security/scaling requirement

### Edge Cases
- [edge] Error scenario → expected behavior

### Visual (UI projects only)
- [ui] Style/color/typography decision

### Data
- [data] Schema/table/relationship description

### API
- [api] METHOD /path — description
```

Available tags: `[func]`, `[auth]`, `[nfr]`, `[edge]`, `[ui]`, `[data]`, `[api]`

**Why this format works for `>om:plan`:**
- Each bullet is nearly a task — PM agent only splits if too large
- Tags enable automatic grouping into components (func → features, auth → middleware, data → migrations)
- No prose to interpret

### After spec generation

Non-blocking next-step suggestion:
```
✅ Đã tạo design-spec.md ([complexity], [N] requirements)

💡 Bước tiếp theo:
   1. >om:equip — cài skills chuyên sâu cho [detected stack]
   2. >om:plan — tạo task list từ spec
```

User chooses which to run. Neither is forced.

## Comparison: Old vs New

| Metric | Old | New |
|--------|-----|-----|
| Min questions (simple) | 7 | 1 |
| Max questions (complex) | 12+ | 5 + decompose |
| Tech stack round-trips | 1 dedicated | 0 or merged |
| Design interview | Separate (3-5 questions) | Merged (0-1 question) |
| Output format | Prose sections | Summary table + tagged list |
| `>om:plan` parse effort | High (interpret prose) | Low (read tags + bullets) |
| Phases | 4 | 2 |

## Files to Change

1. `templates/workflows/requirement-analysis.md` — full rewrite (new adaptive flow)
2. `templates/workflows/pm-templates.md` — update `>om:brainstorm` output format to match hybrid format
3. `templates/workflows/task-planning.md` — update to leverage tagged requirements (read tags for grouping)
