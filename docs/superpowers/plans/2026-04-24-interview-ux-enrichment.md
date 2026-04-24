# Interview UX Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm mô tả, hướng dẫn, và ví dụ theo scenario vào tất cả câu hỏi phỏng vấn trong CLI (`omni init`, `omni rules edit`) và workflow templates (`requirement-analysis.md`, `karpathy-mindset.md`).

**Architecture:** Thay đổi thuần text/UI — không thay đổi logic. CLI prompts được enrich bằng `console.log` blocks (init) và inline hints (rules edit). Workflow templates được bổ sung Question Format Rules + mẫu câu hỏi cho AI học theo.

**Tech Stack:** Node.js CLI (prompts, chalk), Markdown templates

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `bin/omni.js` | Modify (lines 281-309) | Thêm console.log blocks trước mỗi câu hỏi Personal Rules trong `omni init` |
| `bin/omni.js` | Modify (lines 979-984) | Thêm inline hints vào message của `omni rules edit` |
| `templates/workflows/requirement-analysis.md` | Modify (lines 38-44) | Thêm Question Format Rule + mẫu câu hỏi cho 5 slots |
| `templates/core/karpathy-mindset.md` | Modify (lines 5-6) | Thêm format rule + mẫu cho 3 loại Socratic Gate |

---

### Task 1: `omni init` — Thêm block mô tả trước mỗi câu hỏi Personal Rules

**Files:**
- Modify: `bin/omni.js:281-309`

Hiện tại 4 câu hỏi nằm trong 1 `prompts()` call duy nhất. Cần tách thành 4 `prompts()` riêng biệt, mỗi cái có `console.log` block phía trước.

- [ ] **Step 1: Tách prompts array thành 4 prompts riêng lẻ với console.log blocks**

Thay thế block code từ dòng 281 đến 309:

```javascript
        // Personal Rules (guided + free-text)
        console.log(chalk.cyan(`\n${q(3, 3, 'Personal Rules')} ${chalk.gray('(Enter để bỏ qua từng mục)')}\n`));

        const rulesPrompt = await prompts([
            {
                type: 'text',
                name: 'language',
                message: 'Ngôn ngữ giao tiếp (AI trả lời bằng ngôn ngữ nào)?',
                initial: '',
            },
            {
                type: 'text',
                name: 'codingStyle',
                message: 'Coding style / conventions?',
                initial: '',
            },
            {
                type: 'text',
                name: 'forbidden',
                message: 'Forbidden patterns (những gì KHÔNG được làm)?',
                initial: '',
            },
            {
                type: 'text',
                name: 'custom',
                message: 'Custom rules (tùy ý, phân cách bằng dấu ;)?',
                initial: '',
            },
        ]);
```

Thay bằng:

```javascript
        // Personal Rules (guided + free-text)
        console.log(chalk.cyan(`\n${q(3, 3, 'Personal Rules')} ${chalk.gray('(Enter để bỏ qua từng mục)')}\n`));

        console.log(chalk.gray('📝 Ngôn ngữ AI dùng để trả lời bạn. Có thể ghi nhiều ngôn ngữ.'));
        console.log(chalk.dim('   VD React dev: "Tiếng Việt, technical terms giữ English"'));
        console.log(chalk.dim('   VD Python team: "English only"'));
        const rl = await prompts({ type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp (AI trả lời bằng ngôn ngữ nào)?', initial: '' });

        console.log(chalk.gray('\n📝 Quy tắc viết code mà AI phải tuân theo trong dự án.'));
        console.log(chalk.gray('   Bao gồm: naming convention, indent, format, patterns ưa thích.'));
        console.log(chalk.dim('   VD React frontend: "camelCase, 2-space indent, prefer FC + hooks, no class components"'));
        console.log(chalk.dim('   VD Node.js backend: "snake_case cho DB fields, camelCase cho JS, ESM imports, async/await"'));
        console.log(chalk.dim('   VD Python ML: "PEP8, type hints bắt buộc, docstring Google style"'));
        const rc = await prompts({ type: 'text', name: 'codingStyle', message: 'Coding style / conventions?', initial: '' });

        console.log(chalk.gray('\n📝 Những patterns/thói quen mà AI KHÔNG ĐƯỢC sử dụng.'));
        console.log(chalk.gray('   Ghi rõ cái gì bị cấm — AI sẽ tránh hoàn toàn.'));
        console.log(chalk.dim('   VD React: "không dùng any, không dùng class component, không inline styles"'));
        console.log(chalk.dim('   VD Backend: "không console.log trong production code, không dùng var, không SQL thô"'));
        console.log(chalk.dim('   VD Chung: "không tự ý refactor code ngoài scope, không thêm comments thừa"'));
        const rf = await prompts({ type: 'text', name: 'forbidden', message: 'Forbidden patterns (những gì KHÔNG được làm)?', initial: '' });

        console.log(chalk.gray('\n📝 Các quy tắc riêng khác không thuộc mục trên. Phân cách bằng dấu ;'));
        console.log(chalk.dim('   VD: "commit message bằng tiếng Việt; mỗi PR tối đa 300 dòng thay đổi"'));
        console.log(chalk.dim('   VD: "luôn viết unit test trước khi code; dùng pnpm thay npm"'));
        console.log(chalk.dim('   VD: "giải thích bằng ví dụ cụ thể; không dùng emoji trong code"'));
        const ru = await prompts({ type: 'text', name: 'custom', message: 'Custom rules (tùy ý, phân cách bằng dấu ;)?', initial: '' });

        const rulesPrompt = {
            language: rl.language,
            codingStyle: rc.codingStyle,
            forbidden: rf.forbidden,
            custom: ru.custom,
        };
```

- [ ] **Step 2: Chạy `omni init` để kiểm tra hiển thị**

Run: `cd /tmp && mkdir test-interview-ux && cd test-interview-ux && git init && node /home/tav/Documents/omni-coder-kit/bin/omni.js init`

Expected: Mỗi câu hỏi Personal Rules hiển thị block mô tả (màu gray) + ví dụ (màu dim) phía trên, flow hoạt động bình thường, Enter để bỏ qua vẫn hoạt động.

- [ ] **Step 3: Commit**

```bash
git add bin/omni.js
git commit -m "feat(init): thêm mô tả và ví dụ cho câu hỏi Personal Rules trong omni init"
```

---

### Task 2: `omni rules edit` — Thêm inline hints

**Files:**
- Modify: `bin/omni.js:979-984`

- [ ] **Step 1: Thêm inline hint vào message của mỗi prompt**

Thay thế dòng 979-984:

```javascript
            const rp = await prompts([
                { type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp?', initial: existing.language },
                { type: 'text', name: 'codingStyle', message: 'Coding style / conventions?', initial: existing.codingStyle },
                { type: 'text', name: 'forbidden', message: 'Forbidden patterns?', initial: existing.forbidden },
                { type: 'text', name: 'custom', message: 'Custom rules (phân cách bằng ;)?', initial: existing.custom },
            ]);
```

Thay bằng:

```javascript
            const rp = await prompts([
                { type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp? (VD: "Tiếng Việt", "English only")', initial: existing.language },
                { type: 'text', name: 'codingStyle', message: 'Coding style / conventions? (VD: "camelCase, 2-space indent, prefer const")', initial: existing.codingStyle },
                { type: 'text', name: 'forbidden', message: 'Forbidden patterns? (VD: "không dùng any, không inline styles")', initial: existing.forbidden },
                { type: 'text', name: 'custom', message: 'Custom rules (phân cách bằng ;)? (VD: "commit message tiếng Việt; luôn viết test")', initial: existing.custom },
            ]);
```

- [ ] **Step 2: Chạy `omni rules edit` để kiểm tra hiển thị**

Run: `cd /tmp/test-interview-ux && node /home/tav/Documents/omni-coder-kit/bin/omni.js rules edit`

Expected: Mỗi câu hỏi hiện inline hint `(VD: "...")` trong message, giá trị cũ vẫn pre-fill đúng.

- [ ] **Step 3: Commit**

```bash
git add bin/omni.js
git commit -m "feat(rules): thêm inline hint ví dụ cho omni rules edit"
```

---

### Task 3: `requirement-analysis.md` — Thêm Question Format Rule + mẫu câu hỏi

**Files:**
- Modify: `templates/workflows/requirement-analysis.md:38-44`

- [ ] **Step 1: Thêm Question Format Rule và mẫu câu hỏi sau dòng 44**

Giữ nguyên nội dung hiện tại của Step 2 (dòng 38-44). Thêm nội dung mới **sau dòng 44** (sau dòng `- After each answer, re-evaluate...`):

```markdown
- **Question Format Rule:** Mỗi câu hỏi AI đặt ra cho user PHẢI có đủ 3 phần:
  1. **Mô tả ngắn** — giải thích tại sao cần thông tin này (1 câu)
  2. **Gợi ý trả lời** — hướng dẫn user nên trả lời ở dạng nào
  3. **Ví dụ cụ thể** — 2-3 mẫu trả lời theo scenario khác nhau

- **Mẫu câu hỏi cho từng slot (AI điều chỉnh theo ngữ cảnh, không copy nguyên văn):**

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
```

- [ ] **Step 2: Review toàn bộ file để đảm bảo markdown format đúng**

Run: `cat -n templates/workflows/requirement-analysis.md | head -80`

Expected: Step 2 section mở rộng thêm ~35 dòng, không break cấu trúc Step 3 phía dưới.

- [ ] **Step 3: Commit**

```bash
git add templates/workflows/requirement-analysis.md
git commit -m "feat(workflow): thêm Question Format Rule và mẫu câu hỏi cho requirement-analysis"
```

---

### Task 4: `karpathy-mindset.md` — Thêm Socratic Gate Format Rule

**Files:**
- Modify: `templates/core/karpathy-mindset.md:5-6`

- [ ] **Step 1: Thêm format rule và mẫu câu hỏi sau dòng 6**

Giữ nguyên dòng 6 (`The 3 questions MUST cover...`). Thêm nội dung mới **sau dòng 6**:

```markdown
   - **Question Format:** Mỗi câu hỏi Socratic Gate PHẢI có: mô tả ngắn tại sao hỏi + ví dụ cụ thể hoặc lựa chọn rõ ràng để user dễ trả lời.
   - **Mẫu cho từng loại (AI điều chỉnh theo ngữ cảnh, không copy nguyên văn):**
     - **(a) Scope confirmation — xác nhận phạm vi:**
       Mô tả ngắn feature rồi hỏi ranh giới.
       VD thêm auth: "Xác nhận scope: chỉ email/password login, hay cần cả OAuth (Google, GitHub)? Cần forgot password flow không?"
       VD thêm search: "Search chỉ theo title, hay cần full-text search nội dung? Cần filter/sort kết hợp không?"
     - **(b) Edge case — trường hợp user chưa nghĩ tới:**
       Nêu tình huống cụ thể + đề xuất cách xử lý để user chọn.
       VD file upload: "Nếu user upload file 500MB thì xử lý sao? (a) Reject > 50MB (b) Chunk upload (c) Chưa cần limit, xử lý sau"
       VD form: "Nếu user đang điền form rồi mất mạng thì sao? (a) Auto-save draft (b) Cảnh báo trước khi mất dữ liệu (c) Không cần xử lý"
     - **(c) Implementation tradeoff — đánh đổi kỹ thuật:**
       Đưa ra 2-3 lựa chọn với ưu/nhược rõ ràng.
       VD state management: "State cho feature này: (a) useState local — đơn giản nhưng khó share (b) Zustand — nhẹ, share dễ (c) Context — built-in nhưng re-render nhiều. Khuyến nghị (b) vì scope vừa phải. Bạn thấy sao?"
       VD API design: "API trả về nested data hay flat + ID references? Nested đơn giản cho frontend nhưng payload lớn. Flat cần thêm logic nhưng cache tốt hơn."
```

- [ ] **Step 2: Review toàn bộ file để đảm bảo indent nhất quán**

Run: `cat -n templates/core/karpathy-mindset.md | head -30`

Expected: Nội dung mới nằm trong cùng indent level (3 spaces) với các bullet points hiện tại của mục 1, không break cấu trúc mục 2 (Simplicity First) phía dưới.

- [ ] **Step 3: Commit**

```bash
git add templates/core/karpathy-mindset.md
git commit -m "feat(mindset): thêm format rule và mẫu cho Socratic Gate questions"
```

---

### Task 5: Smoke test toàn bộ flow

**Files:**
- Không tạo/sửa file, chỉ test

- [ ] **Step 1: Test `omni init` end-to-end**

Run: `cd /tmp && rm -rf test-interview-ux && mkdir test-interview-ux && cd test-interview-ux && git init && node /home/tav/Documents/omni-coder-kit/bin/omni.js init`

Kiểm tra:
- Block mô tả + ví dụ hiện trước mỗi câu hỏi Personal Rules
- Màu gray cho mô tả, dim cho ví dụ
- Enter để bỏ qua vẫn hoạt động
- File config được tạo đúng

- [ ] **Step 2: Test `omni rules edit`**

Run: `cd /tmp/test-interview-ux && node /home/tav/Documents/omni-coder-kit/bin/omni.js rules edit`

Kiểm tra:
- Inline hint `(VD: "...")` hiện trong message
- Giá trị cũ pre-fill đúng (nếu có)

- [ ] **Step 3: Verify template files are valid markdown**

Run: `cat templates/workflows/requirement-analysis.md | head -80 && echo "---" && cat templates/core/karpathy-mindset.md | head -30`

Kiểm tra: Markdown structure intact, không có dòng bị lệch indent, Step/section headers đúng vị trí.

- [ ] **Step 4: Final commit nếu cần fix**

Nếu có issue phát hiện ở Step 1-3, fix rồi commit:
```bash
git add -A
git commit -m "fix: điều chỉnh sau smoke test interview UX enrichment"
```
