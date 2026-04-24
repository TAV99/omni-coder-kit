# Design Spec — Interview UX Enrichment

> Generated: 2026-04-24 | Complexity: medium

## Summary

| Field | Value |
|-------|-------|
| Goal | Cải thiện UX cho câu hỏi phỏng vấn — thêm mô tả, hướng dẫn, ví dụ theo scenario |
| Scope | CLI prompts (`bin/omni.js`) + workflow templates (`requirement-analysis.md`, `karpathy-mindset.md`) |
| Approach | Inline Enrichment + Template Format Rules (Approach C) |
| Files thay đổi | 4 files |
| Nguyên tắc ngôn ngữ | Tiếng Việt hoàn toàn, thuật ngữ technical giữ tiếng Anh |

## Vấn đề hiện tại

Các câu hỏi trong quá trình phỏng vấn (cả CLI lẫn AI workflow) thiếu mô tả, hướng dẫn, và ví dụ:
- User không hiểu nên viết gì cho "Coding style / conventions?"
- Các tham số như "Forbidden patterns", "Custom rules" không có ví dụ mẫu
- AI trong workflow templates không có hướng dẫn cụ thể cách đặt câu hỏi tốt

## Thay đổi chi tiết

### 1. `bin/omni.js` — `omni init` Personal Rules (block mô tả)

Thêm `console.log` block trước MỖI câu hỏi Personal Rules. Mỗi block gồm:
- 1 dòng mô tả ngắn (giải thích ý nghĩa câu hỏi)
- 2-3 ví dụ theo scenario (React, Node.js, Python...)

Màu sắc: mô tả dùng `chalk.gray`, ví dụ dùng `chalk.dim`.

**Câu hỏi "Ngôn ngữ giao tiếp":**
```
📝 Ngôn ngữ AI dùng để trả lời bạn. Có thể ghi nhiều ngôn ngữ.
   VD React dev: "Tiếng Việt, technical terms giữ English"
   VD Python team: "English only"
```

**Câu hỏi "Coding style / conventions":**
```
📝 Quy tắc viết code mà AI phải tuân theo trong dự án.
   Bao gồm: naming convention, indent, format, patterns ưa thích.
   VD React frontend: "camelCase, 2-space indent, prefer FC + hooks, no class components"
   VD Node.js backend: "snake_case cho DB fields, camelCase cho JS, ESM imports, async/await"
   VD Python ML: "PEP8, type hints bắt buộc, docstring Google style"
```

**Câu hỏi "Forbidden patterns":**
```
📝 Những patterns/thói quen mà AI KHÔNG ĐƯỢC sử dụng.
   Ghi rõ cái gì bị cấm — AI sẽ tránh hoàn toàn.
   VD React: "không dùng any, không dùng class component, không inline styles"
   VD Backend: "không console.log trong production code, không dùng var, không SQL thô"
   VD Chung: "không tự ý refactor code ngoài scope, không thêm comments thừa"
```

**Câu hỏi "Custom rules":**
```
📝 Các quy tắc riêng khác không thuộc mục trên. Phân cách bằng dấu ;
   VD: "commit message bằng tiếng Việt; mỗi PR tối đa 300 dòng thay đổi"
   VD: "luôn viết unit test trước khi code; dùng pnpm thay npm"
   VD: "giải thích bằng ví dụ cụ thể; không dùng emoji trong code"
```

### 2. `bin/omni.js` — `omni rules edit` (inline hint)

Thêm hint ngắn 1 dòng vào `message` của mỗi prompt. User đã quen flow nên chỉ cần gợi ý nhẹ.

| Câu hỏi hiện tại | Sau khi cải thiện |
|---|---|
| `Ngôn ngữ giao tiếp?` | `Ngôn ngữ giao tiếp? (VD: "Tiếng Việt", "English only")` |
| `Coding style / conventions?` | `Coding style / conventions? (VD: "camelCase, 2-space indent, prefer const")` |
| `Forbidden patterns?` | `Forbidden patterns? (VD: "không dùng any, không inline styles")` |
| `Custom rules (phân cách bằng ;)?` | `Custom rules (phân cách bằng ;)? (VD: "commit message tiếng Việt; luôn viết test")` |

### 3. `templates/workflows/requirement-analysis.md` — Question Format Rule

Thêm vào Step 2 (Adaptive Questions) sau dòng "Prefer multiple-choice format when possible":

**Question Format Rule:** Mỗi câu hỏi AI đặt ra cho user PHẢI có đủ 3 phần:
1. **Mô tả ngắn** — giải thích tại sao cần thông tin này (1 câu)
2. **Gợi ý trả lời** — hướng dẫn user nên trả lời ở dạng nào
3. **Ví dụ cụ thể** — 2-3 mẫu trả lời theo scenario khác nhau

**Mẫu câu hỏi cho từng slot:**

**goal (mục tiêu):**
> Tôi cần hiểu rõ mục tiêu chính để thiết kế đúng scope.
> Mô tả ngắn gọn: dự án này giải quyết vấn đề gì, cho ai?
> VD e-commerce: "Cho phép chủ shop nhỏ bán hàng online không cần code"
> VD internal tool: "Dashboard theo dõi KPI cho team marketing, 5 người dùng"
> VD SaaS: "Nền tảng quản lý dự án cho freelancer, monetize bằng subscription"

**users (người dùng):**
> Ai sẽ dùng sản phẩm này? Mỗi role có quyền khác nhau không?
> Liệt kê các role và mô tả ngắn quyền hạn của từng role.
> VD blog: "admin (CRUD bài viết, quản lý user), reader (đọc, comment)"
> VD SaaS: "owner (billing, team settings), member (dùng features), guest (view only)"

**features (tính năng):**
> Tính năng cốt lõi nào bắt buộc phải có ở phiên bản đầu tiên?
> Liệt kê theo dạng: hành động → kết quả mong muốn.
> VD task app: "tạo task với deadline → hiện trên calendar; kéo thả để đổi trạng thái"
> VD API: "POST /upload nhận file CSV → parse và lưu DB; GET /report trả JSON tổng hợp"

**constraints (ràng buộc):**
> Có ràng buộc kỹ thuật nào cần biết trước không?
> Bao gồm: tech stack bắt buộc, hosting, budget, deadline, team size.
> VD: "phải dùng Next.js + Supabase, deploy Vercel, budget $0, solo dev"
> VD: "Python FastAPI, cần chạy trên server nội bộ, không được dùng cloud"
> Nếu không có ràng buộc, ghi "AI tự chọn" — tôi sẽ đề xuất stack phù hợp nhất.

**edge_cases (trường hợp biên):**
> Có tình huống lỗi hoặc giới hạn nào cần xử lý đặc biệt?
> Nghĩ về: dữ liệu sai, số lượng lớn, mất kết nối, concurrent access.
> VD: "file upload > 100MB thì reject; 2 user edit cùng lúc thì last-write-wins"
> VD: "offline mode cho mobile; API rate limit 100 req/phút"

Lưu ý: AI đọc mẫu này và áp dụng format khi hỏi — không copy nguyên văn mà điều chỉnh theo ngữ cảnh dự án. Slot `ui_hint` giữ nguyên câu hỏi multiple-choice hiện tại.

### 4. `templates/core/karpathy-mindset.md` — Socratic Gate Format Rule

Thêm vào sau dòng "The 3 questions MUST cover: (a) scope confirmation, (b) edge case..., (c) implementation tradeoff...":

**Question Format:** Mỗi câu hỏi Socratic Gate PHẢI có: mô tả ngắn tại sao hỏi + ví dụ cụ thể hoặc lựa chọn rõ ràng để user dễ trả lời.

**Mẫu cho từng loại:**

**(a) Scope confirmation — xác nhận phạm vi:**
> Mô tả ngắn feature rồi hỏi ranh giới.
> VD thêm auth: "Xác nhận scope: chỉ email/password login, hay cần cả OAuth (Google, GitHub)? Cần forgot password flow không?"
> VD thêm search: "Search chỉ theo title, hay cần full-text search nội dung? Cần filter/sort kết hợp không?"

**(b) Edge case — trường hợp user chưa nghĩ tới:**
> Nêu tình huống cụ thể + đề xuất cách xử lý để user chọn.
> VD file upload: "Nếu user upload file 500MB thì xử lý sao? (a) Reject > 50MB (b) Chunk upload (c) Chưa cần limit, xử lý sau"
> VD form: "Nếu user đang điền form rồi mất mạng thì sao? (a) Auto-save draft (b) Cảnh báo trước khi mất dữ liệu (c) Không cần xử lý"

**(c) Implementation tradeoff — đánh đổi kỹ thuật:**
> Đưa ra 2-3 lựa chọn với ưu/nhược rõ ràng.
> VD state management: "State cho feature này: (a) useState local — đơn giản nhưng khó share (b) Zustand — nhẹ, share dễ (c) Context — built-in nhưng re-render nhiều. Khuyến nghị (b) vì scope vừa phải. Bạn thấy sao?"
> VD API design: "API trả về nested data hay flat + ID references? Nested đơn giản cho frontend nhưng payload lớn. Flat cần thêm logic nhưng cache tốt hơn."

Giữ nguyên Exception rule hiện tại (bug fix, typo fix được skip Socratic Gate).

## Không thay đổi

- Logic code, flow phỏng vấn, số lượng câu hỏi
- Các câu hỏi select (IDE, strictness) — đã đủ rõ
- Slot `ui_hint` trong requirement-analysis.md
- Exception rules trong karpathy-mindset.md
- Các file workflow khác (skill-manager.md, debugger-workflow.md, qa-testing.md, task-planning.md)
