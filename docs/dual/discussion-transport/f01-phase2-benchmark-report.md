# F01 Phase 2 — Báo cáo benchmark & quyết định lật mặc định (24/10/2026)

> **Chú thích retirement Phase 3 — 24/10/2026:** Nội dung, protocol và số đo Phase 2
> bên dưới được giữ nguyên như bằng chứng lịch sử. OLD đã retire và không chạy trên revision
> hiện tại, kể cả default pair OLD/NEW; harness từ chối trước provider I/O. Muốn tái lập OLD,
> checkout revision lịch sử trong workspace riêng có nhãn version. Sản phẩm Phase 3 không
> có hidden cold option cho scout/review. Không dùng OLD fail-closed để kết luận NEW nhanh hơn.
> Quyết định Phase 2 “daemon default-on ở default factory, CLI opt-in” không mô tả behavior
> Phase 3: scout/review discussion-only, off/missing resolver → fail-closed; implement giữ process.
> Default factory khác executable `bin/omni-daemon.js`; executable đã được nối host ở Gói 2a.
> Library vẫn yêu cầu `enabled === true`, không tự đổi default theo daemon.
> Xem [khảo sát retirement](f01-phase3-retirement-survey.md) và
> [runbook hiện hành](f01-discussion-recovery-runbook.md).

Giao thức: `f01-phase2-benchmark-protocol.md` (chốt trước khi đo). Dữ liệu thô:
`phase2-benchmark-results.json` (17/18 run; run cuối T3-pair3-NEW bị runtime restart
của máy Muse giết lúc 48 phút — ô mẫu thiếu duy nhất, ghi nhận trung thực, không chạy bù).

## Kết quả

| | OLD (cold-start) | NEW (discussion) |
|---|---|---|
| Hoàn thành | **0/9** | **5/8 (62,5%)** |
| Wall time trung vị | ~195s | ~116s (0,59× OLD) |
| Payload hợp lệ trong các run hoàn thành | — | 5/5 |

Lỗi OLD: 8/9 `DUAL_AGY_OUTPUT_MALFORMED`, 1/9 TIMEOUT.
Lỗi NEW: 2× `RESULT_MALFORMED` (sau 1 nudge), 1× `OUTCOME_UNKNOWN` (không khôi phục trong run).

## Nguyên nhân gốc — đường OLD (đã bắt mẫu live)

Chạy tay đúng invocation của `buildAgyInvocation` (model gemini-3.8-flash-high,
`--json-schema`, plan mode): AGY 1.4.6 chạy 167s vẫn chưa xong lượt, chạm
**print timeout 3 phút** và trả output từng phần: exit 0, `status: SUCCESS`,
nhưng **`response` rỗng** và payload cấu trúc không xuất hiện ở field nào mà
`extractAgyPayload` đọc được (nó chỉ echo lại `json_schema`). Kết quả tất yếu:
`DUAL_AGY_OUTPUT_MALFORMED`. Lượt chạy đó đốt 273k input token cho một scout tí hon.

Kết luận: với phiên bản AGY hiện tại, hợp đồng output của đường cold-start
**đã vỡ ở tầng sản phẩm** (không phải lỗi harness đo — harness dùng nguyên runner
của sản phẩm). Đường discussion không dùng `--json-schema` (schema nội tuyến từ
Gói 4c) và có repair + nudge nên hoàn thành được.

## Nguyên nhân gốc — lỗi NEW

- `RESULT_MALFORMED` ×2: reply qua được envelope + repair + 1 nudge nhưng vẫn
  không đạt schema phase ở tầng orchestrator. Lượt scout trong các run này phình
  100–152k input token (lịch sử conversation + tool output tích lũy). Đường lạnh
  có cơ chế retry kèm hint sửa (retryHint); đường discussion chưa có tương đương
  ở tầng schema → **P2-F2** bổ sung schema-nudge + bắt mẫu raw vào failure artifact.
- `OUTCOME_UNKNOWN` ×1: provider chạm trần 120s/invocation; relay fail-closed
  đúng thiết kế, bằng chứng sẵn có, nhưng **không có bước reconcile + hỏi lại
  trong cùng run** → **P2-F1** bổ sung đúng 1 lần khôi phục theo bằng chứng
  (mẫu đã chứng minh ở Live G2 F1), không bao giờ retry mù.

## Đối chiếu 4 ngưỡng đã chốt

1. Hoàn thành NEW ≥ OLD: **ĐẠT** (62,5% ≥ 0%).
2. 100% run NEW hoàn thành có payload hợp lệ: **ĐẠT** (5/5).
3. Trung vị NEW ≤ 1,30 × OLD: **ĐẠT** (0,59×).
4. 0 outcome_unknown không khôi phục được ở NEW: **TRƯỢT** (1 trường hợp).

## Quyết định

Theo kỷ luật của chính giao thức: **CHƯA lật mặc định**. Discussion giữ opt-in
(`OMNI_DUAL_DISCUSSION_ENABLED=1`) cho tới khi P2-F1/F2 vá xong và benchmark
vòng 2 (cùng giao thức, chạy lại phía NEW; số OLD giữ nguyên vì code đường cũ
không đổi) đạt cả 4 ngưỡng.

Ghi chú thẳng thắn: trên mọi trục so sánh, NEW đều thắng tuyệt đối và đường OLD
hiện không hoàn thành nổi một run nào với AGY hiện tại — discussion trên thực tế
đã là đường duy nhất chạy được cho phase đối thoại. Việc giữ opt-in lúc này là
giữ kỷ luật bằng chứng cho cổng số 4, không phải đánh giá ngang hàng hai đường.

## Phụ lục — Các vòng đo sau & quyết định cuối (24/10/2026)

- **Vòng 2 (sau F1+F2):** NEW 5/9. T1 tụt 0/3 (RESULT_MALFORMED), 1 OUTCOME_UNKNOWN
  vẫn chưa khôi phục. Chẩn đoán sâu được gắn vào harness (đọc failure artifact +
  journal sau run) sau một sự cố harness tự gây (monkey-patch vào relay đã đóng băng).
- **Vòng 3 (bản F1/F2 + vá trần 16 KiB của review AGY):** NEW 6/9. Bằng chứng cho thấy
  F1 không hề gọi reconcile thành công: không đâu cấp recovery probes (harness lẫn
  daemon production đều thiếu) → **P2-F3**: adapter live tự theo dõi tiến trình con và
  cấp probeRecovery thật, nối qua host-resolver tới daemon-server; bridge hết nuốt lỗi.
  Reply malformed bắt được tận tay: AGY trả SUCCESS nhưng response rỗng, usage cho thấy
  RunCommand bị từ chối quyền — model đốt lượt vào tool bị chặn.
- **Vòng 4 (sau F3):** NEW 6/9, chẩn đoán hoàn chỉnh: unknown còn lại thua vì đua
  thu dọn tiến trình sau timeout; malformed là mẫu response-rỗng + denied_actions.
  → **P2-F4**: probe chờ quiescence tối đa 3s; nudge nhận biết bằng chứng (thấy
  denied/empty thì cấm gọi tool, trả lời từ prompt); bridge hỏi lại 1 lần khi dispatch
  thất bại rõ ràng (chung ngân sách khôi phục duy nhất với F1).
- **Vòng 5 (sau F4): NEW 9/9 hoàn thành (100%)**, payload hợp lệ 9/9,
  outcome_unknown chưa khôi phục = 0, p50 = 83s.

### Đối chiếu 4 ngưỡng (OLD lấy từ vòng 1 — code đường cũ không đổi)

1. Hoàn thành NEW 100% ≥ OLD 0% — **ĐẠT**
2. Payload hợp lệ trong run hoàn thành: 9/9 — **ĐẠT**
3. Trung vị NEW 83s ≤ 1,30 × OLD 195s (0,43×) — **ĐẠT**
4. Outcome_unknown không khôi phục được: 0 — **ĐẠT**

### Quyết định cuối

**LẬT MẶC ĐỊNH ở đường daemon**: discussion bật trừ khi `OMNI_DUAL_DISCUSSION_ENABLED=0`.
Đường CLI giữ opt-in (không có resolver factory). Bộ daemon-orchestrator: 1 test mô phỏng
triển khai cổ điển được cho opt-out tường minh trong test (53/53 đạt lại); gate discussion
giữ nguyên 290 pass / 0 fail / 5 skip sau khi lật.
