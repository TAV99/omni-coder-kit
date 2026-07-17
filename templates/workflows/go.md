## >om-go — One-shot full pipeline (requirements-aware)

> Chạy toàn bộ SDLC chỉ với MỘT lệnh chat. Là cách nhanh nhất cho vibe coder: 1 prompt → sản phẩm.
> BẤT KỂ run mode đã cấu hình (auto/manual), `>om-go` luôn tự động đi qua các bước dưới đây.

### Bước
1. **Brainstorm/Intake** (tự chọn):
   - Nếu user cung cấp **spec/Q&A khách hàng** (file hoặc dán): chạy `>om-spec` đầy đủ → sinh `.omni/sdlc/requirements.md` + `customer-spec.md`.
   - Nếu không: chạy `>om-think` (DNA detection + adaptive interview). Hỏi đúng số câu thiếu, KHÔNG hỏi nếu spec đã đủ rõ.
2. **Equip + Plan + Cook**:
   - Ngay khi đã có `.omni/sdlc/design-spec.md` (hoặc `requirements.md`), TỰ ĐỘNG tiếp (không hỏi giữa bước):
     `>om-skill` → `>om-plan` → `>om-cook` (đã bao gồm auto check→fix theo 3 quality cycle).
3. **Quality gate**:
   - Sau mỗi checkpoint cook, chạy `>om-check`. FAIL → `>om-fix` ↔ `>om-check` (≤3 lần) → escalate.
4. **Acceptance (NẾU có requirements.md)** — bắt buộc:
   - Sau khi `>om-check` PASS và còn tồn tại `.omni/sdlc/requirements.md`, chạy workflow `acceptance.md`:
     - Chấm lai từng requirement (test cmd / agent+debate).
     - Cập nhật `requirements.md` (chỉ flip status, KHÔNG sửa nội dung).
     - Ghi `.omni/sdlc/conformance.md`.
   - **Chưa 100% met** → thêm task `[ACCEPT] R<id>` vào `todo.md` → lặp cook→check→acceptance.
   - **Quá `--max-accept-rounds` vòng** (mặc định 3) → dừng và escalate kèm danh sách R<id> chưa đạt.
   - **Không có `requirements.md`** → bỏ qua acceptance (giữ tương thích).
5. **Doc + Ship**:
   - **Chỉ DOC khi acceptance 100% met** (hoặc dự án không có requirements). Sau đó `>om-doc`.
   - Pause trước SHIP để user duyệt — KHÔNG tự deploy.

### Dừng & escalate
Dừng ngay nếu: gate fail không tự fix được, acceptance không đạt sau N vòng, debate split ở high-stakes (check/ship), quyết định lớn cần user duyệt. Đừng "blind-fix" để pass bằng mọi giá.

### Quy tắc bất biến
- **Artifact = hand-off**: workflow trên đọc/ghi đúng các file `.omni/sdlc/*` đã quy định; không paraphrase giữa agent.
- **Depth = 1**: `>om-go` là orchestrator; mỗi sub-workflow tự chạy, không gọi sub-workflow khác.
- **Tham chiếu acceptance**: bước 4 KHÔNG viết lại logic — đọc và tuân `.omni/workflows/acceptance.md`.
