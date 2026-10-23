# Thiết kế tích hợp F01 — Discussion Transport vào luồng Dual chính

Ngày: 2026-10-23. Trạng thái: **BẢN THIẾT KẾ CHỜ CHỦ REPO DUYỆT** — chưa triển khai.
Cơ sở bằng chứng: `live-experiment-2026-10-23.md` (G1/G2/Q05 đều PASS WITH CAVEATS).
Quyết định kiến trúc đã chốt bởi chủ repo (23/10/2026): **thay thế theo lớp, theo phase** —
loại bỏ cơ chế đối thoại của dual hiện tại, giữ khung an toàn thi hành; không thay toàn bộ một lần.

## 1. Hiện trạng — dual đang chạy bằng gì (đã khảo sát mã nguồn)

| Thành phần | File | Vai trò |
|---|---|---|
| Driver surface | `lib/dual/mcp-server.mjs` (~1.422 dòng) | Codex lái qua MCP: `omni_dual_begin`, `register_plan`, `status`, `quality`, `completion`, `reject_handoff`, `resume` |
| Điều phối phase | `lib/dual/orchestrator.js` (~1.814 dòng) | Nạp prompt template theo phase (`templates/codex-gemini/prompts/<phase>.md`), theo dõi `phase.started/completed/failed` |
| **Cơ chế đối thoại (sẽ thay)** | `lib/dual/agy-runner.js` (~214 dòng) | Mỗi phase spawn một lần `agy -p "Read <input file> and complete only the <phase> phase. Return the required JSON contract."` kèm `--mode plan\|accept-edits` và `--dangerously-skip-permissions`. **Cold-start, không phiên bền** |
| Authority daemon | `lib/dual/daemon-server.js` (~4.308 dòng) + `authority-store.js` (~2.932 dòng) | RPC, ledger băm chuỗi, lease, validator lifecycle; trạng thái UNRESOLVED khóa mọi mutation (fail-closed) |
| Thi hành + QC (giữ nguyên) | `isolated-runner.js`, `quality-runner.js`, `isolated-qc.js`, `baseline-snapshot.js`, `scope-guard.js` | Cách ly workspace, cổng chất lượng, neo baseline/artifact |

Điểm đau đã biết của đường hiện tại: cold-start từng phase + hợp đồng JSON cứng → lệch nhịp là
vòng sửa lỗi → blocked; độ phức tạp nằm ở keo quản lý tiến trình của daemon (lịch sử git nhiều
lần sửa deadlock/lease hết hạn/event-loop starvation).

## 2. Kiến trúc đích — thay theo lớp

**Nguyên tắc:** Discussion Transport thay *lớp đối thoại*; daemon *hạ vai* từ "chủ sở hữu mọi
trạng thái" xuống "host cấp cổng"; lớp thi hành không đổi.

### 2.1 Lớp đối thoại (MỚI — thay agy-runner trong vai trò hội thoại)
- Mỗi dual session có **một cặp binding bền**: Codex (astra) + AGY (argon), conversation được
  seed tại `omni_dual_begin` và sống suốt session; `session_id` = dual session, `task_id` +
  `plan_revision` lấy từ `register_plan` (bump revision → binding mới, không xóa session cũ —
  đúng quy tắc thiết kế transport).
- Envelope snapshot mang **hợp đồng phase hiện tại** (nội dung file input + template phase) —
  tri thức nằm ở snapshot trên đĩa, không nằm ở trí nhớ hội thoại; hội thoại chỉ mang ngữ cảnh
  tích lũy (quyết định, phản biện) vốn là thứ cold-start đang vứt bỏ mỗi phase.
- Choreography dùng hợp đồng đã nới (23/10): sau mỗi reply, một trong hai bên được mở câu hỏi
  tiếp theo — khớp nhịp scout → plan → review tự nhiên.

### 2.2 Phân loại phase — phase nào đi qua transport
| Phase | Tính chất | Đường đi |
|---|---|---|
| `scout` | Đọc, phân tích, trả JSON | **Discussion transport** (adapter read-only) |
| `plan` | Lập kế hoạch, phản biện qua lại | **Discussion transport** |
| `review` | Đối thoại phản biện, chốt/không chốt | **Discussion transport** |
| `implement` | **Ghi workspace thật** | **KHÔNG qua payload thảo luận.** Giữ đường thi hành hiện tại (orchestrator + isolated-runner dưới lease). Phần *trao đổi quanh* implement (brief, báo cáo kết quả, vòng sửa lỗi) đi qua transport |

Lý do: transport hiện chỉ chứng minh được payload hỏi/đáp read-only. Đẩy mutation qua nó là
vượt bằng chứng — đúng ranh giới F01 trong customer-spec (bảo toàn lease, baseline, QC gates).

### 2.3 Daemon hạ vai thành host-port provider
Relay đã được thiết kế để nhận hai cổng từ host — daemon hiện tại chính là nơi cấp chúng:

| Cổng của relay | Nguồn cấp trong kiến trúc đích |
|---|---|
| `authority.check` (binding/session còn hiệu lực?) | `authority-store.js`: lease còn hạn + plan_revision khớp + snapshot sha khớp |
| `capabilityVerifier.verify` | `capability-preflight.js` (đã tồn tại) + profile adapter live |
| `capabilityVerifier.verifyRecovery` | Bằng chứng tiến trình/provider phía daemon (tiến trình CLI đã quiescent, provider terminal) — thay stub của harness bằng chứng cứ thật |

Daemon **giữ**: lease, validator lifecycle, quality ledger, cổng completion. Daemon **buông**:
vai trò trung gian truyền tin giữa hai agent cho các phase hội thoại.

### 2.4 Quyền và an toàn
- Adapter hội thoại chạy **read-only, không `--dangerously-skip-permissions`** (đã chứng minh
  live). Cờ bypass chỉ còn tồn tại ở đường implement hiện tại — phạm vi riêng, không mở rộng.
- Mọi dispatch vẫn fail-closed: outcome unknown → khóa → reconcile bằng evidence (đã chứng
  minh ở G2 F1). Điểm khác so với daemon hiện tại: khóa nằm ở *từng turn trong journal*,
  khôi phục theo turn, không brick toàn session vô thời hạn.
- Bài học vận hành bắt buộc mang theo: `codex exec resume` không nhận `-s`; resume AGY bằng
  `--conversation`; không truyền cờ của `exec` sang `resume`.

## 3. Lộ trình theo phase

### Phase 1 — Nối song song sau flag (opt-in)
- Thêm cấu hình `dual.discussion.enabled` (mặc định **false**). Bật: scout/plan/review đi qua
  transport; tắt: đường cũ nguyên vẹn (rollback = tắt flag + reconcile các turn đang dở,
  đúng nguyên tắc trong customer-spec mục 9).
- Host ports nối vào daemon thật (mục 2.3) — thay toàn bộ stub của harness thử nghiệm.
- Chạy trên **task code thật ở phạm vi hẹp** (1 repo thử nghiệm của chủ repo), Muse điều phối
  và kiểm chứng như vòng thử nghiệm live.
- **Nghiệm thu Phase 1:** ≥ 3 task thật hoàn tất qua đường mới; 0 lần brick không khôi phục
  được; QC outcome tương đương đường cũ trên cùng task mẫu; nhật ký journal đối chiếu được
  với ledger của daemon.

### Phase 2 — Lật mặc định
- Điều kiện: đạt nghiệm thu Phase 1 + benchmark lại trên task thật (protocol chốt trước:
  wall-time theo phase, số vòng correction, tỉ lệ blocked) cho thấy không tệ hơn đường cũ.
- `enabled` mặc định **true**; đường cũ giữ ở chế độ fallback có khai báo.
- Đánh giá riêng (ngoài phạm vi bản này): implement-phase có chuyển sang phiên bền AGY
  (`--conversation` + accept-edits) hay không — quyết định bằng bằng chứng Phase 1–2, không giả định.

### Phase 3 — Gỡ đường đối thoại cũ
- Xóa việc dùng `agy-runner.js` cho các phase hội thoại (runner chỉ còn phục vụ implement nếu
  còn cần), gỡ phần keo truyền tin tương ứng trong daemon.
- Điều kiện: Phase 2 chạy ổn định qua ≥ 1 chu kỳ phát hành; bộ test dual đầy đủ xanh;
  tài liệu vận hành cập nhật (gồm runbook khôi phục theo journal thay cho runbook daemon cũ
  ở phần hội thoại).

## 4. Rủi ro chính và cách chặn

| Rủi ro | Chặn bằng |
|---|---|
| Hội thoại dài làm loãng ngữ cảnh agent (context rot) | Snapshot envelope mang hợp đồng phase — nguồn sự thật là đĩa, không phải trí nhớ phiên; bump plan_revision là chốt lại ngữ cảnh |
| Mất session phía provider giữa task | Pattern G2 F3: seed phiên mới + reconcile theo journal; journal là nguồn khôi phục |
| Hai nguồn trạng thái (journal vs ledger daemon) lệch nhau | Một quy tắc sở hữu: journal sở hữu *hội thoại*, ledger sở hữu *thi hành*; completion gate chỉ đọc ledger + trạng thái turn cuối trong journal, không suy diễn chéo |
| Regression ở choreography đã nới | Bộ test offline 22/22 + test mirrored-follow-up giữ trong CI; nới thêm phải có quyết định chủ repo |
| Số liệu Phase 1 quá đẹp do task dễ | Task mẫu gồm ít nhất 1 task từng làm đường cũ blocked (đối chứng trực tiếp) |

## 5. Ngoài phạm vi bản thiết kế này
- F01 chỉ đến hết Phase 3 ở trên. Không gồm: đổi MCP tool surface (giữ nguyên để Codex không
  phải học lại), đổi validator/QC, đa agent (>2 participant — trần thiết kế transport là 2),
  và mọi thay đổi ở bản npm 3.1.0 đã phát hành (việc này nằm trên nhánh phát triển).

## 6. Quyết định cần chủ repo duyệt để bắt đầu Phase 1
1. Duyệt kiến trúc đích mục 2 (đặc biệt: bảng phân loại phase 2.2 và việc daemon hạ vai 2.3).
2. Chọn repo/task mẫu cho Phase 1.
3. Cho phép nối host ports vào daemon trên nhánh phát triển (đụng tới `daemon-server.js` /
   `authority-store.js` — khác với thử nghiệm live vốn chỉ thêm file mới).
