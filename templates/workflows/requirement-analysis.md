## ADAPTIVE ARCHITECT WORKFLOW (EXTRACT → INTERVIEW → SPEC)
When executing the [>om:brainstorm] command, you MUST act as a Chief Solutions Architect. Follow this 2-phase process strictly.

**Phase 1: Extract, Classify & Interview**

### Step 1: Extract & Classify (AI-internal — no questions yet)
Parse the user's prompt and extract info into 6 slots:

| Slot | What to extract |
|------|----------------|
| `goal` | Business objective, what the project does |
| `users` | Roles/personas and their permissions |
| `features` | Core functionality, main flows |
| `constraints` | Tech stack, budget, timeline, hosting, team skills |
| `edge_cases` | Error scenarios, limits, concurrency issues |
| `ui_hint` | "dashboard", "landing page", "mobile app", "API only", etc. |

Classify complexity based on extracted info:

| Complexity | Indicators | Max questions |
|------------|-----------|---------------|
| **Small** | <=2 features, <=2 roles, no integrations | 1 |
| **Medium** | 3-5 features, DB + API + UI | 3 |
| **Large** | 6+ features or multi-service | 5 + auto-decompose |

Classify project DNA (AI-internal — use extracted slots, no user prompt):

```
DNA Profile:
  hasUI              = ui_hint ≠ "API only" AND features mention UI
  hasBackend         = features mention DB/API/server/processing
  hasAPI             = endpoint descriptions or API mentions present
  backendComplexity  = "simple" | "moderate" | "complex"
```

| backendComplexity | Signals |
|-------------------|---------|
| **simple** | CRUD, basic REST, single DB, no special patterns |
| **moderate** | Complex auth, file processing, 3rd-party integrations, full-text search, multi-table joins |
| **complex** | Any of: realtime/websocket, queue/worker, cron/scheduler, microservices, caching layer, rate limiting, DB replication/sharding, event-driven, streaming |

AI reads `goal`, `features`, `constraints`, and `edge_cases` to detect signals. The pattern list is open-ended — use judgment to classify any backend pattern, not just those listed above.

Display extraction result to user:
```
📋 Tôi đã hiểu:
   • Mục tiêu: [goal]
   • Người dùng: [users]
   • Tính năng: [features]
   • Ràng buộc: [constraints]
   • Quy mô: [small/medium/large]
   • DNA: [hasUI?] + [Backend simple/moderate/complex]

❓ Còn thiếu: [list empty/ambiguous slots]
```

### Step 2: Adaptive Questions (only ask what's missing)
- Each question targets 1 empty or ambiguous slot.
- Prefer multiple-choice format when possible.
- If project has UI (`ui_hint` is not "API only"), merge 1 visual direction question into this flow:
  "Style hướng nào? (a) Modern minimal (b) Bold/creative (c) Corporate/clean (d) Để tôi chọn theo context"
- **Soft gate:** Always ask at least 1 question, even if all slots are filled — use it for edge case probing or scope confirmation.
- **Backend complexity probe:** If `backendComplexity` from DNA is ambiguous (some signals but unclear severity), use 1 question slot:
  > "Tôi thấy dự án có [detected signals]. Backend cần xử lý phức tạp đến mức nào?"
  > (a) CRUD cơ bản — đọc/ghi DB, REST API
  > (b) Trung bình — auth phức tạp, file processing, integrations
  > (c) Phức tạp — realtime, queues, caching, multiple services
  If already clear (landing page → simple, or user said "realtime chat" → complex), skip this probe.
  This probe counts toward the existing max questions budget (1/3/5) — no extra budget.
- After each answer, re-evaluate: enough info to write spec? If yes → proceed to Phase 2.
- **Question Format Rule:** Mỗi câu hỏi AI đặt ra cho user PHẢI có đủ 3 phần:
  1. **Mô tả ngắn** — giải thích tại sao cần thông tin này (1 câu)
  2. **Gợi ý trả lời** — hướng dẫn user nên trả lời ở dạng nào
  3. **Ví dụ cụ thể** — 2-3 mẫu trả lời theo scenario khác nhau

- **Mẫu câu hỏi:** Đọc `.omni/workflows/interview-examples.md` khi cần tham khảo mẫu câu hỏi cho từng slot. AI điều chỉnh theo ngữ cảnh, không copy nguyên văn.

**Tech stack handling (merged — no dedicated phase):**
- **User specified stack:** Use it. No alternatives proposed.
- **User says "AI chọn" or doesn't mention:** Pick the best fit, write 1-line justification in Summary table. Do not ask.
- **Clear trade-off exists** (e.g., realtime vs ecosystem): Ask 1 multiple-choice question merged into adaptive flow.

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

### Self-check before Phase 2
Before generating spec, verify you can fill ALL of these:
- [ ] Goal rõ ràng (1 câu mô tả được)?
- [ ] Biết ai dùng (ít nhất 1 role)?
- [ ] Hiểu ít nhất 1 core feature flow?
- [ ] Biết tech stack (user chọn hoặc AI chọn)?
If any is unchecked → ask 1 more targeted question. Do NOT proceed.

### Step 4: Propose Approaches (before writing spec)
Present 2-3 architectural approaches with trade-offs. For each approach:
1. **Name** — a short label (e.g., "Monolith + SSR", "API-first + SPA", "Serverless")
2. **How it works** — 2-3 sentences describing the architecture
3. **Pros** — 2-3 bullet points
4. **Cons** — 2-3 bullet points

Lead with your recommended approach and explain why. Format:
```
🏗️ Đề xuất kiến trúc:

**A. [Recommended] — [Name]**
   [How it works]
   ✅ [Pro 1]  ✅ [Pro 2]
   ⚠️ [Con 1]  ⚠️ [Con 2]

**B. [Name]**
   [How it works]
   ✅ [Pro 1]  ✅ [Pro 2]
   ⚠️ [Con 1]  ⚠️ [Con 2]

Tôi khuyên chọn A vì [1-line justification]. Bạn chọn hướng nào?
```
Wait for user to pick an approach before proceeding to Phase 2. If user agrees with your recommendation, proceed. If user picks another, adapt the spec accordingly.

**Skip rule:** For **Small** complexity projects with an obvious single approach (e.g., a CLI tool, a static site), briefly state the approach in 1-2 sentences and ask for confirmation instead of proposing alternatives.

**Phase 2: Generate `design-spec.md`**

### Part A: Structured Summary
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
| Backend DNA | [simple/moderate/complex] — [detected patterns] (omit if simple) |
| Constraints | [list] |
```

### Part B: Tagged Requirement List
Each requirement is a bullet with a category tag. Available tags: `[func]`, `[auth]`, `[nfr]`, `[edge]`, `[ui]`, `[data]`, `[api]`, `[infra]`

```markdown
## Requirements

### Core
- [func] Feature description (specific: input → process → output)
- [func] Another feature

### Auth & Permissions
- [auth] Role: permissions description

### Data
- [data] Table/collection name — fields, relationships, indexes

### API
- [api] METHOD /path — description, auth requirement

### Non-Functional
- [nfr] Performance/security/scaling requirement (with concrete numbers)

### Edge Cases
- [edge] Error scenario → expected behavior

### Infrastructure (when backendComplexity ≥ moderate)
- [infra] Backend pattern — technology, configuration, scaling behavior
  Examples:
  - [infra] WebSocket server for live chat — Socket.IO, fallback long-polling, max 500 connections
  - [infra] Job queue for email — BullMQ + Redis, retry 3x exponential backoff, dead letter queue
  - [infra] Cache layer — Redis for session + API response, TTL 5min listings, TTL 1hr static config

### Visual (UI projects only)
- [ui] Design style, color palette, typography, layout pattern
```

**Rules for requirements:**
- Each bullet should be specific enough to become 1-3 tasks in `todo.md`.
- Use "input → process → output" format for `[func]` items when possible.
- Include concrete numbers for `[nfr]` items (e.g., "<2s response time", "support 1000 concurrent users").
- `[data]` items should list actual field names, not just "user table".
- `[api]` items should include method, path, and auth level.
- `[infra]` items should specify the pattern, technology choice, and concrete scaling/failure behavior.

### Part C: Generate `content-source.md` (UI projects only)
If the project has UI (`ui_hint` is not "API only"), generate `content-source.md` alongside `design-spec.md`:

```markdown
# Content Source-of-Truth — [Project Name]
> Generated by >om:brainstorm | [date]
> Referenced by >om:cook (content guidance) and >om:check (content validation)

## Facts
Verified facts that MUST appear accurately in the final product:
- Project name: [exact name]
- Project type: [open-source / commercial / SaaS / internal tool]
- [Key fact from user input — e.g., "Free and open-source, no pricing tiers"]
- [Key fact — e.g., "Supports 8 IDEs: Claude Code, Cursor, Codex, ..."]
- [Key fact — e.g., "Author: [name], GitHub: [url]"]

## Tone
- Voice: [e.g., "Technical but approachable, developer-focused"]
- Language: [e.g., "Vietnamese UI labels, English code"]
- Audience: [e.g., "Developers using AI coding assistants"]

## Forbidden Content
Content that MUST NOT appear in the final product:
- [e.g., "No pricing tiers — this is open-source"]
- [e.g., "No fake testimonials — use real GitHub stars/forks data or omit"]
- [e.g., "No placeholder lorem ipsum text"]
- [e.g., "No stock photos — use code screenshots or diagrams"]
```

**Rules for content-source.md:**
- Populate `## Facts` from the user's input during Phase 1 and the chosen approach. Every fact MUST be traceable to something the user said or confirmed.
- Populate `## Forbidden Content` from edge cases, constraints, and the project type. If the project is open-source, automatically add "No pricing tiers" and "No fake testimonials".
- Keep it short — aim for 15-30 lines total. This file is read by cook and check, so brevity saves tokens.
- If the project is "API only" (no UI), skip this file entirely — content validation is not applicable.

### Spec Self-Review (AI-internal — no user prompt needed)
After writing `design-spec.md`, review it with fresh eyes before presenting to the user:
1. **Placeholder scan:** Any "TBD", "TODO", empty sections, or vague requirements like "handle errors appropriately"? Fix them with concrete content.
2. **Internal consistency:** Does the tech stack match the requirements? Do API endpoints match the data model? Do auth roles match the permissions described in features?
3. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick the most likely interpretation and make it explicit.
4. **Completeness:** Does every `[func]` requirement have a clear input → process → output? Does every `[data]` item have actual field names?
5. **Backend coherence** (when `backendComplexity ≥ moderate`): Do `[infra]` requirements match the tech stack in Summary? Do patterns conflict? (e.g., "serverless" but needs persistent WebSocket)

Fix any issues inline in the spec file. Do not ask the user — just fix and move on.

### After spec generation
Display non-blocking next steps:
```
✅ Đã tạo design-spec.md ([complexity], [N] requirements)

💡 Bước tiếp theo:
   1. >om:equip — cài skills chuyên sâu cho [detected stack]
   2. >om:plan — tạo task list từ spec
```

**Rules:**
- Do NOT write code. Your only output is `design-spec.md`.
- Do NOT skip Phase 1 even if the user says "code luôn". Respond: "Trả lời 1 câu này trước để tôi hiểu đúng yêu cầu."
- If the user's prompt is a single vague sentence ("làm app quản lý"), probe deeper: "Quản lý cái gì? Cho ai? Quy mô bao nhiêu người dùng?"
- Keep total interview under 5 questions for medium projects, 1 for simple.
