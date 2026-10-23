# Chương trình F01 — Trạng thái & kỷ luật vận hành

Mandate của chủ repo (23/10/2026, ~22:32): Muse là **người thực hiện chính** nhánh chức năng
dual, liên tục thay thế/bóc tách/thử nghiệm cho đến khi chức năng hoạt động hoàn hảo.
Codex và AGY do Muse điều phối và cho trao đổi với nhau. Thiết kế chuẩn:
`f01-integration-design.md` (thay thế theo lớp, theo phase).

## Kỷ luật bắt buộc
1. **Không đè code của nhau:** mỗi file có đúng một chủ sở hữu tại một thời điểm (bảng dưới).
   Muse là người duy nhất sửa file tích hợp sau khi đã đối chiếu.
2. **Không sửa file của engine khi chưa tới gói việc của nó.** Gói nền = file MỚI + test MỚI.
3. **Hạn mức Codex:** `codex exec` lỗi usage/rate limit (chu kỳ 5H) → KHÔNG thử lại dồn dập;
   ghi nhận vào file này, chuyển lane AGY/Muse làm phần không phụ thuộc, quay lại khi hồi phục.
4. Muse kiểm chứng độc lập mọi giao hàng (chạy test + đọc diff) trước khi nhận.
5. Commit theo đợt vào nhánh `codex/dual-live-experiment`; push chờ chủ repo xử lý quyền
   GitHub (đã chốt 23/10) — không tự ý đổi cách xác thực.

## Bảng sở hữu file (Phase 1)
| Phạm vi | Chủ sở hữu |
|---|---|
| `lib/dual/discussion/host-ports.js`, `lib/dual/discussion/session.js` (MỚI) | Codex |
| `test/dual-discussion-host-*.test.js` (MỚI) | Codex |
| Review đối kháng toàn bộ gói | AGY (chỉ đọc ở vòng review; sửa file của chính AGY nếu được giao) |
| `lib/dual/discussion/live-*.js`, contracts/relay/journal | Đã chốt — chỉ sửa khi có gói việc riêng |
| `orchestrator.js`, `daemon-server.js`, `authority-store.js`, `mcp-server.mjs` | CHƯA AI — mở ở Gói 3 sau khi Gói 1–2 đạt |

## Các gói việc Phase 1
- [x] **Gói 1 — Nền phiên thảo luận (file mới):** `session.js` (seed 2 conversation → dựng cặp
  binding → tạo relay với host ports được tiêm vào; flag `enabled` tắt = không seed, không tạo
  relay) + `host-ports.js` (hợp đồng cổng host dạng tiêm phụ thuộc: authority.check,
  capabilityVerifier.verify/verifyRecovery bọc các callback do daemon cấp) + test offline.
- [x] **Gói 2 — Host ports thật:** nối authority-store (lease/revision/snapshot) và
  capability-preflight vào host-ports; test tích hợp offline bằng store thật trên thư mục tạm.
- [x] **Gói 3 — Định tuyến orchestrator sau flag:** scout/plan/review qua relay khi
  `dual.discussion.enabled=true`; implement giữ nguyên. Test hồi quy toàn bộ suite dual.
- [x] **Gói 4 — Chạy task thật phạm vi hẹp + nghiệm thu Phase 1** (tiêu chí trong bản thiết kế).

## Kênh tra cứu
- Phần chưa biết/cần tài liệu: được phép hỏi Gemini bản web (Pro, "Argon") theo nguyên tắc song song — chỉ là manh mối, phải đối chiếu nguồn gốc trước khi dùng.

## Nhật ký
- 23/10 22:32 — Nhận mandate. Codex bị runtime restart xóa bản cài global, đã cài lại 0.164.0
  (đăng nhập ChatGPT còn nguyên). Bắt đầu Gói 1.

- 23/10 22:46 — Gói 1 ĐẠT: bộ test 40/40 (host-session 18 sau vòng sửa theo review AGY: P0 authority ép Boolean → strict === true; validate trước seed; lỗi seed mang theo conversationIds; forward models/clock/syncHook/execution; thêm test phủ định). Muse tự chạy kiểm chứng + đọc diff. Mở Gói 2.
- 23/10 23:05 — Gói 2 ĐẠT sau vòng sửa theo review AGY (liveProfileVerified cho codex phải qua probe CLI thật; cross-check định danh bindingRef/snapshot trong evidence; probe recovery dừng sớm khi tiến trình chưa quiescent; thêm case truncation + codex): **78 pass, 0 fail, 4 skip (live)** trên toàn bộ 9 suite discussion — Muse tự chạy kiểm chứng. Lưu ý môi trường: worktree cần `npm install` chuẩn (zod là dependency đã khai báo) trước khi chạy test. Mở Gói 3a (khảo sát seam + phase-bridge, chưa sửa engine).
- 23/10 23:41 — Gói 3 ĐẠT (3a seam survey + phase-bridge; 3b nhánh discussion trong executeAgyWithRetry sau flag opt-in, chỉ scout/review; 3c sửa theo review AGY: adapter chuyển tiếp option discussion, context resolver chỉ gồm trường sự thật — host giữ định danh phiên daemon qua closure, ghi failure evidence, parity extraction khi recovery, prompt review qua discussion được nối git diff, AttemptMetaSchema thêm trường transport). Finding 8 (đổi chiều review) bị bác: ngữ nghĩa gốc là AGY lập payload review, Codex QC là cổng độc lập. Toàn bộ suite discussion + contracts: **159 pass, 0 fail, 4 skip** (Muse tự kiểm chứng); gate dual rộng: tập fail trùng baseline sandbox (EPERM), delta rỗng. Commit gộp Phase 1 (Gói 1–3) vào nhánh local.
- 24/10 00:37 — **PHASE 1 ĐẠT NGHIỆM THU LIVE.** test/dual-discussion-live-acceptance.test.js PASS (173s, chạy bởi Muse): 2 task thật qua trọn ngăn xếp sản xuất trong tiến trình (orchestrator thật → nhánh discussion → host resolver → daemon ports → adapter live → conversation AGY thật), payload qua ContextSchema, meta transport=discussion, journal khớp artifact, cache phiên đúng (task mới = phiên mới, resolve lại = cache, seeds 2+2).
- Hành trình tới nghiệm thu (bằng chứng độ tin cậy): (i) prompt discussion thiếu JSON Schema của phase → đã nội tuyến schema vào promptBody (Gói 4c); (ii) model trả JSON trần/object-body → repair xác định trong adapter (evidenceRef ghi loại repair); (iii) prompt dài → AGY thỉnh thoảng trả response RỖNG dù SUCCESS (tỉ lệ lỗi ~2/2 ở payload thực tế, 1/3 ở payload nhỏ) → cơ chế nudge: tối đa 1 câu nhắc sửa trong cùng conversation, nằm trong ngân sách timeout, marker +nudge; sau nudge diag payload thực tế đạt ổn định.
- Giới hạn còn lại (ghi rõ): đường daemon socket/MCP chưa chạy live được trong sandbox này (EPERM với process/socket — tập fail trùng baseline ở cả hai cây); nghiệm thu dùng đường orchestrator trong tiến trình mà daemon điều khiển qua adapter. Phase 2 (chưa bắt đầu): benchmark lật mặc định trên task thật + chạy live qua daemon ở môi trường không bị sandbox chặn + đánh giá đưa implement vào conversation bền.
- Toàn bộ Phase 1 đã commit local trên codex/dual-live-experiment; push vẫn chờ người dùng xử lý truy cập GitHub (quyết định 23/10 20:49).

## Phase 2 — benchmark, vá lỗi theo bằng chứng, lật mặc định (24/10/2026)

- [x] Giao thức benchmark chốt trước (f01-phase2-benchmark-protocol.md) + harness đo cặp OLD/NEW.
- [x] Vòng 1: OLD 0/9 (hợp đồng --json-schema của đường lạnh vỡ với AGY hiện tại — print timeout trả response rỗng), NEW 5/8.
- [x] P2-F1/F2: khôi phục outcome_unknown 1 lần theo bằng chứng; schema-nudge ngang hàng retryHint; failure artifact giữ excerpt/issues.
- [x] Review AGY F1/F2: ACCEPT WITH FIXES — vá trần 16 KiB (trùng schema trong correction body) + messageId sau recovery.
- [x] P2-F3: recovery probes thật từ bookkeeping tiến trình con của adapter, nối host-resolver → daemon production; bridge không nuốt lỗi reconcile.
- [x] P2-F4: probe chờ quiescence ≤3s; nudge nhận biết denied_actions/response rỗng; re-ask 1 lần khi settled-failed (chung ngân sách khôi phục với F1).
- [x] Vòng 5: **NEW 9/9 (100%)**, p50 83s so với OLD 195s, 0 unknown chưa khôi phục → đạt cả 4 ngưỡng.
- [x] **Lật mặc định đường daemon** (opt-out OMNI_DUAL_DISCUSSION_ENABLED=0; CLI giữ opt-in). Gate discussion 290 pass/0 fail; daemon-orchestrator 53/53 (1 test mô phỏng triển khai cổ điển được opt-out tường minh).
- [x] P2-Gói 3: đánh giá implement qua conversation bền — **REJECT ở thời điểm này** (xem f01-phase2-implement-evaluation.md mục 6): đường lạnh 2/2 đạt (~100–125s, scope sạch); conversation brief lỏng sập tại RunCommand bị từ chối (response rỗng, 0 thay đổi) ở cả 2 lần chạy, brief ghim công cụ thì 1 lượt đạt 115s — khả thi nhưng mong manh + thiếu lease/binding/scope-guard/evidence contract. Ngưỡng đánh giá lại đã ghi trong tài liệu.
- [x] P2-Gói 4: **chạy live qua daemon socket ĐẠT ở tầng discussion** (24/10, script test/dual-phase2-daemon-live.js chạy từ shell Muse — các sandbox lồng nhau của test/Codex vẫn bị EPERM): daemon con nghe 127.0.0.1:40859, session + plan OK, scout hoàn thành 78s qua discussion (env unset — mặc định mới), journal 1 cặp question/reply, meta transport='discussion'; preflight/spec/route cũng hoàn thành. Phần chưa chứng minh: trọn vòng task qua implement+QC trong daemon (implement vượt ngân sách stage 240s của script trên fixture tí hon — chậm hay kẹt chưa phân định; gộp vào đánh giá Gói 3).
- Báo cáo đầy đủ: docs/dual/discussion-transport/f01-phase2-benchmark-report.md (+ phụ lục các vòng 2–5).
