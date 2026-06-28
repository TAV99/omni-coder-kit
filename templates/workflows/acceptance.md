## ACCEPTANCE WORKFLOW (>om:accept) — Đối chiếu sản phẩm vs requirements.md, lặp tới 100%

> Phase-4. Đầu vào: `.omni/sdlc/requirements.md` (do `>om:intake` hoặc `omni run --spec` sinh). Mục tiêu: chứng minh **từng yêu cầu** đã đạt, hoặc xác định cái chưa đạt + nguyên nhân + việc cần làm tiếp.

### Khi nào kích hoạt
- Tự động: harness sau khi state `CHECK` pass và còn tồn tại `requirements.md` → chuyển vào state `ACCEPTANCE`.
- Thủ công: user gõ `>om:accept` (chấm trên build hiện tại) hoặc `omni run accept` (CI-friendly).
- Nếu không có `requirements.md` → BỎ QUA acceptance, chuyển thẳng DOC (giữ tương thích dự án cũ).

### Bước thực hiện (cho từng requirement R<id>)
1. **Đọc lại** `.omni/sdlc/requirements.md` + `customer-spec.md` + `design-spec.md` — KHÔNG paraphrase, chỉ trích nguyên văn vào claim cho debate.
2. **Chấm lai** (hybrid):
   - `test:` là **lệnh shell/test cụ thể** → chạy thật. Exit 0 + không timeout = met (lưu output làm bằng chứng).
   - `test: agent` → khởi tạo debate cross-model:
     - participants ≥ 2 (khác host model nếu được, vd `host-cli:claudecode` × `host-cli:antigravity`).
     - claim = `Sản phẩm hiện tại có thoả "<R.text>" không?` + artifact paths (requirements/customer-spec/design-spec).
     - Adjudicator (vòng lặp) đọc kết quả: `consensus=agree` + `verdict=pass` = met; bất kỳ split/fail/inconclusive = NOT met (không blind-fix).
3. **Cập nhật trạng thái** trong `requirements.md` (chỉ đổi `[ ]` → `[x]` / `[!]`, KHÔNG sửa nội dung dòng).
4. **Ghi `conformance.md`** mỗi vòng acceptance (id → met + method + evidence + round).

### Khi chưa 100%
- Với mỗi R<id> chưa đạt → thêm task vào `.omni/sdlc/todo.md` dạng:
  `- [ ] [ACCEPT] R3: <text gốc của requirement>`
- Quay lại COOK (lặp `cook → check → ACCEPTANCE`).
- Giới hạn `--max-accept-rounds` (mặc định 3). Vượt → BLOCKED escalate, in danh sách R<id> chưa đạt + nguyên nhân ngắn.

### Khi 100% met
- Reset `acceptanceRounds`, chuyển sang `DOC`. Chỉ khi đó mới được DOC → SHIP.

### Quy tắc bất biến
- **Artifact = hand-off**: agent debate đọc `requirements.md`/`customer-spec.md` từ disk, KHÔNG nhận paraphrase từ orchestrator.
- **Depth = 1**: chỉ loop là moderator của debate; provider không tự gọi provider khác.
- **Không tự deploy / không blind-fix**: split/inconclusive → escalate, không cook để "fix" bừa.
- Cấu trúc dòng `R<id>` là contract bất biến — không xoá/đổi id giữa các vòng.

### Output bắt buộc mỗi vòng
- `.omni/sdlc/conformance.md` (round N): bảng id × met × method × evidence.
- `requirements.md` cập nhật trạng thái từng dòng.
- Tóm tắt 1 dòng: `acceptance round N: X/Y met · unmet: R3,R5`.
