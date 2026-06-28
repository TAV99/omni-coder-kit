## INTAKE WORKFLOW (>om:intake) — Spec → requirements.md

> Phase-4. Mục tiêu: biến **spec / Q&A khách hàng** thành **hợp đồng yêu cầu nguyên tử** (kiểm chứng được), để vòng đời SDLC chấm điểm sản phẩm dựa trên nó tới khi đạt 100%.

### Khi nào kích hoạt
- User gõ `>om:intake <dán spec/Q&A>` hoặc CLI chạy `omni run --spec <file>`.
- Nếu `.omni/sdlc/requirements.md` đã tồn tại → KHÔNG ghi đè. Báo "đã có requirements" và dừng.

### Bước thực hiện (BẮT BUỘC, không paraphrase)
1. **Lưu nguyên văn** spec/Q&A vào `.omni/sdlc/customer-spec.md` (không tóm tắt, không sửa từ). Đây là artifact "chân lý" cho debate/acceptance đọc lại.
2. **Đặt câu hỏi nếu thiếu** (ngắn, đa lựa chọn). Hỏi tối đa 3 câu cho project medium, 5 cho large. KHÔNG hỏi nếu spec đã đủ rõ.
3. **Sinh requirements.md** theo định dạng dưới đây. Mỗi yêu cầu PHẢI:
   - Có id duy nhất `R<n>` (tăng dần).
   - Là **mệnh đề kiểm chứng được** (ai cũng nhìn thấy đạt/chưa).
   - Gắn `test:` chỉ rõ cách chấm — ưu tiên **lệnh/test cụ thể** (hard evidence) trước; nếu định tính → `test: agent` (sẽ chấm bằng agent+debate cross-model).

### Định dạng file `.omni/sdlc/requirements.md`
```markdown
# Requirements — <project> (nguồn: customer Q&A / spec)

- [ ] R1 | <yêu cầu nguyên tử có tiêu chí chấp nhận> | test: <cmd | path::name | "agent">
- [ ] R2 | ...
```
- Trạng thái: `- [ ]` pending · `- [x]` met · `- [!]` failed (loop chỉ flip dấu, không sửa nội dung).
- `test:` ví dụ:
  - `test: npm test -- auth` (lệnh shell — exit 0 = pass)
  - `test: tests/login.spec.js::should redirect` (test cụ thể)
  - `test: agent` (chấm định tính qua acceptance debate)

### Quy tắc
- Atomic: 1 yêu cầu = 1 ý. KHÔNG gộp nhiều mệnh đề OR/AND vào một dòng.
- Đo được: "load trang < 1s" thay vì "load nhanh"; "lưu vào bảng X cột Y" thay vì "lưu DB".
- Không phỏng đoán: không thêm yêu cầu mà spec không nói.
- KHÔNG ghi đè requirements.md đã có (idempotent). Nếu user muốn thay → user xóa file trước.

### Output bắt buộc
- `.omni/sdlc/customer-spec.md` (verbatim copy).
- `.omni/sdlc/requirements.md` (checklist nguyên tử).
- Tóm tắt 1 dòng: `intake: tạo N requirements (M có hard test, K agent-judged)`.
