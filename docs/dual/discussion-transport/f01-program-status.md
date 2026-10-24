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

## Phase 3 — Gỡ đường đối thoại cũ (khởi động 24/10/2026 theo lệnh chủ repo)

Chủ repo ra lệnh "thực hiện phase 3" lúc 08:13 ngày 24/10/2026. Điều kiện thiết kế "Phase 2
ổn định qua ≥ 1 chu kỳ phát hành" được thay bằng bằng chứng Phase 2 đã có (benchmark 5 vòng,
nghiệm thu live 2 tầng) theo quyết định trực tiếp của chủ repo — ghi rõ để không ai hiểu lầm
đã có chu kỳ phát hành thật.

Phạm vi đã chốt theo thiết kế mục 3 (Phase 3) + khảo sát mã nguồn của Muse ngày 24/10:
- Sự thật mã nguồn: `buildAgyInvocation` chỉ còn MỘT điểm gọi sản xuất —
  `orchestrator.js` trong vòng lặp lạnh của `executeAgyWithRetry`. Nhánh discussion
  (scout/review, sau `options.discussion.enabled`) chạy TRƯỚC vòng lặp đó; vòng lặp lạnh
  hiện phục vụ (a) implement — GIỮ theo thiết kế, và (b) scout/review khi discussion
  chưa bật (đường daemon khi opt-out, đường CLI, test).
- Gói 0 — Khảo sát bản đồ gỡ bỏ (Codex, chỉ ghi 1 file khảo sát mới): mọi điểm chạm lạnh
  theo phase; test/harness phụ thuộc đường lạnh (gồm benchmark mode OLD, suite daemon);
  keo truyền tin trong daemon liên quan đối thoại; tài liệu/runbook nhắc đường lạnh.
  AGY review đối kháng bản khảo sát trước khi chốt phạm vi triển khai.
- Gói 1 — Orchestrator: scout/review thành discussion-only; thiếu discussion/resolver →
  lỗi fail-closed có mã rõ, KHÔNG rơi xuống vòng lặp lạnh. Vòng lặp lạnh chỉ còn cho
  implement và các phase không đối thoại khác (nếu còn đi qua hàm này).
- Gói 2 — Daemon/CLI/harness/tài liệu: hệ quả của Gói 1 ở daemon (opt-out không còn nghĩa
  "về đường lạnh" — đối thoại fail-closed), CLI (không có resolver factory: scout/review
  fail-closed có thông điệp rõ; xây host cho CLI là tính năng riêng, NGOÀI phạm vi F01),
  harness benchmark mode OLD, runbook khôi phục theo journal cho phần hội thoại.
- `agy-runner.js` KHÔNG bị xóa: `runProcess` (isolated-runner dùng) và `buildAgyInvocation`
  cho implement vẫn là đường thi hành. Phần chết thật sự chỉ là nhánh đối thoại lạnh.
- Nghiệm thu Phase 3: cổng test discussion + daemon-orchestrator xanh; delta gate rộng so
  baseline bằng phương pháp git-archive như các phase trước; chạy live lại (acceptance
  discussion + scout qua daemon) chứng minh đối thoại chỉ còn một đường.

### Gói 0 — ĐÃ DUYỆT (24/10/2026)
- Bản khảo sát: `f01-phase3-retirement-survey.md` (Codex; 224 dòng, 153 dẫn chứng).
  Hai phát hiện P0: (1) executable `bin/omni-daemon.js` tự inject adapter nên KHÔNG BAO
  GIỜ dựng discussion host — "mặc định discussion" của Phase 2 chỉ đúng ở default
  factory của daemon-server, KHÔNG đúng ở binary sản xuất (đính chính phạm vi bằng
  chứng Phase 2); (2) chuỗi isolated làm rơi discussion ở cả isolated-authority và
  isolated-runner — orchestrator private chạy scout + review lạnh, và host-resolver
  ghim cwd seed = daemon.workspaceRoot (rò rỉ workspace nếu chuyển tiếp ngây thơ).
- AGY review đối kháng: **ACCEPT WITH FIXES** (`f01-phase3-survey-review-agy.md`);
  H1–H4, H6 ĐÚNG; H5 phần đúng (cờ opt-out ở test daemon là cấp module — di trú phải
  xử lý cả suite 53 scenario, không chỉ 7/17). Muse đã tự xác minh cơ chế
  findTerminalPhaseFailure (runPhase khóa vĩnh viễn task có phase.failed non-retryable).
- **Quyết định D1 — CHỐT kèm điều kiện AGY:** thêm mã `DUAL_DISCUSSION_REQUIRED` cho
  scout/review khi discussion chưa bật/thiếu, ném dạng **Precondition Error TRƯỚC
  `phase.started`, KHÔNG ghi `phase.failed`** (tránh độc hóa task — Finding P1 của
  AGY). Các mã RESOLVER_REQUIRED / SESSION_DISABLED / BINDINGS_REQUIRED giữ nguyên
  ngữ nghĩa terminal hiện tại. Bổ sung từ điển `DUAL_ERROR_MESSAGES` tiếng Việt cho
  toàn bộ mã DUAL_DISCUSSION_* ở Gói 2 (CLI).
- **Quyết định D2 — BÁC BỎ theo review AGY (Muse chấp nhận):** KHÔNG siết
  `buildAgyInvocation` chỉ nhận implement. Căn cứ: H2 chứng minh orchestrator là
  caller sản xuất duy nhất — khóa tại seam là đủ 100% cho sản xuất; builder là tầng
  hạ tầng, giữ generic; test biên schema cấp thấp giữ nguyên. Chốt chặn nằm ở
  orchestrator + test hành vi "không gọi processRunner cho đối thoại ở mọi trạng thái
  discussion".
- Gói 2 chốt thêm: (2a) quyền sở hữu wiring host thống nhất tại module daemon-server —
  export helper tạo host dùng chung cho default factory và `bin/omni-daemon.js`
  (binary truyền discussion vào adapter của nó, giữ agyProjectId/trusted runners;
  seam inject orchestrator của startDaemonServer không đổi); (2b) isolated cần thiết
  kế riêng trước khi sửa: resolver nhận diện workspaceRoot private + khóa cache theo
  định danh execution, guard parity cho lượt discussion — Codex viết bản thiết kế,
  AGY review, Muse duyệt rồi mới triển khai.

### Gói 1 — ĐẠT (24/10/2026, Muse kiểm chứng độc lập)
- `orchestrator.js`: scout/review điều hướng discussion-only; thiếu discussion →
  `DUAL_DISCUSSION_REQUIRED` dạng precondition (ném trước `phase.started`, không ghi
  sự kiện, không failure evidence); vòng lạnh chỉ còn cho implement; reviewDiff dựng
  vô điều kiện. Dev nhỏ ngoài brief (Muse duyệt giữ): scout/review hoãn ghi
  input/schema artifact tới khi discussion đã xác nhận (prepareInputArtifacts) —
  tránh đốt attempt + file immutable khi ném precondition; artifact của lượt thành
  công giữ nguyên đường dẫn/nội dung.
- Lộ ra và đã sửa một bug tiềm ẩn từ Phase 1: khối dựng reviewDiff tham chiếu
  `gitRunner` không thuộc scope `createDualOrchestrator` (nhánh baseline git chưa
  test nào chạm tới trước đây) — đã bổ sung khai báo đúng scope.
- Một test di trú phải đổi vector giữa chừng (Muse chẩn đoán): xóa spec.json làm
  nổ chuỗi artifact-hash của state-store trước khi vòng retry chạy; vector cuối dùng
  controller-context.json (không bị ghi hash) → vẫn đạt `DUAL_SPEC_CORRELATION`,
  workerCalls = 1.
- Cổng của Muse (shell cấp cao nhất): 6 file gate **130/130 pass**; toàn bộ suite
  discussion **276 pass / 0 fail / 5 skip** (281 tests). Số liệu sandbox lồng nhau của
  Codex (EPERM) không dùng làm kết luận, như kỷ luật các phase trước.

### Gói 2a — ĐẠT (24/10/2026, Muse kiểm chứng độc lập)
- `daemon-server.js` export `createDaemonDiscussionHost` (tách nguyên văn khối dựng
  host khỏi `startDaemonServer`, giữ từng chi tiết wiring: adapters live mặc định,
  stateDir `.omni/runs/dual-discussion`, daemon getters, khôi phục hash envelope) +
  export `discussionEnabledFromEnv`. Đường default factory dùng chính helper này.
- `bin/omni-daemon.js`: `createExecutableOrchestrator` (export, test được) dựng host
  qua helper khi env on/unset và truyền `discussion` vào adapter (giữ `agyProjectId`);
  `closeAll` nối đúng vòng đời executable (khi startDaemonServer lỗi + finally sau khi
  daemon dừng). Env off/invalid → không host, không discussion (fail-closed tại seam).
  → P0 "executable chưa từng có discussion" ĐÃ BỊT ở tầng wiring; bằng chứng chạy live
  qua executable thuộc vòng nghiệm thu cuối Phase 3.
- Test mới `test/dual-daemon-host-wiring.test.js`. Cổng của Muse: focused **43/43**;
  suite discussion **276 pass / 0 fail / 5 skip** (giữ nguyên).
- Suite `dual-daemon-orchestrator`: **20 pass / 33 fail** — đối chứng worktree tại HEAD
  (trước Gói 2a) cho ĐÚNG 20/33 với tập tên case fail trùng khít → 33 fail là nợ di trú
  của chính Gói 1 (suite còn đặt env '0' ở tầm module, scout nay fail-closed), thuộc
  phạm vi Gói 2c (fixture discussion stub), KHÔNG phải hồi quy của 2a.

### Gói 2b — thiết kế isolated: ĐÃ SOẠN + REVIEW, chờ bản sửa theo review (24/10/2026)
- Codex soạn `f01-phase3-isolated-design.md` (321 dòng): CHỌN phương án A —
  daemon-side factory cấp child discussion host theo execution, dùng lease/authority
  của daemon; tách 3 identity W/B/D; NEEDS_CONTEXT đóng execution, generation mới theo
  operationId; stateDir `.omni/runs/dual-discussion/isolated/<executionKey>`.
- AGY review (`f01-phase3-isolated-design-review-agy.md`): **ACCEPT WITH FIXES** —
  2 P0, 3 P1, 2 P2. H2/H5/H6 TRUE; H1/H3/H4/H7 PARTLY; H8 đồng ý có điều kiện cả 5
  câu hỏi mở.
- **Muse CHẤP THUẬN TOÀN BỘ findings và CHỐT 5 câu hỏi mở như sau:**
  (1) Duyệt phương án A KÈM mở rộng hooks spawn/env/signal ở 4 module (live-agy-invoke,
  live-codex-invoke, daemon-ports, capability-preflight) — đặc tả chữ ký là phần của
  thiết kế, không phải chi tiết phụ; thiếu hooks thì isolated giữ BLOCKED.
  (2) Duyệt generation theo operationId cho NEEDS_CONTEXT; không hydrate conversation
  cross-process trong gói này.
  (3) stateDir như trên, daemon sở hữu, giữ evidence — retention/GC ghi nợ kỹ thuật
  sau Phase 3, không tự GC trong gói này.
  (4) Hai mã lỗi mới: `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED` = precondition error
  trước `phase.started` (đúng D1); `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID` =
  terminal security error.
  (5) Helper test `test/helpers/dual-discussion-stub.js` do 2b sở hữu (bản
  execution-aware), 2c tái dùng; live acceptance isolated phải chứng minh cwd/env
  bằng process audit thật, không chỉ metadata.
- Điều kiện phụ chốt thêm từ findings: mô hình guard 3 chốt (Seed Guard Wrapper ở
  runner + Prespawn Guard Callback ở adapter bắt cả nudge nội bộ + Relay Facade);
  child host tự unregister khi close, `closeAll` lũy đẳng không throw vì child đã
  đóng; authority của child bind exact leaseId/operationId qua closure authorize của
  isolated-authority; capability probe dùng trustedExecutionContext đã đối chiếu
  ledger (`task.workspace.prepared`) + `fs.realpathSync.native`; chữ ký shared
  `sessionResolver` GIỮ NGUYÊN (isolated chỉ qua factory); mọi so sánh root qua
  realpath native. Codex sửa bản thiết kế theo 5 điều kiện tối thiểu của review →
  Muse duyệt → mới viết brief triển khai.
- **DUYỆT TRIỂN KHAI (Muse, 24/10/2026):** bản thiết kế đã sửa đủ 8 điểm theo review
  (413 dòng; Muse kiểm điểm các mục then chốt: đặc tả spawnImpl/env/signal, guard 3
  chốt, trustedExecutionContext, unregister/closeAll lũy đẳng, authority exact, 2 mã
  lỗi, mục 8 ĐÃ CHỐT). Triển khai tách 2 gói con: **2b-i** = nền hooks (live invokers +
  capability-preflight + daemon-ports context — additive, giữ nguyên hành vi shared);
  **2b-ii** = child factory + wiring isolated + guard 3 chốt + helper test và di trú
  suite isolated.
- **2b-i — ĐẠT (24/10/2026, Muse kiểm chứng):** nền hooks `{ spawnImpl, env, signal,
  prespawnGuard }` cho live-agy-invoke, live-codex-invoke (prespawnGuard await trước
  MỌI spawn kể cả nudge nội bộ; comment phân quyền tracking tại điểm spawn),
  capability-preflight (chuyển env/signal/spawnImpl xuống spawnBoundedProcess),
  daemon-ports (trustedExecutionContext optional — có context thì probe dùng
  workerRoot, không có thì giữ derived root). Additive, defaults giữ hành vi shared.
  Cổng của Muse: suite discussion **299 tests — 294 pass / 0 fail / 5 skip** (+18
  case mới); capability-preflight 14/16 — 1 case fail ("injected version/models…
  exact durable details") **có sẵn tại HEAD trước 2b-i** (đối chứng worktree HEAD:
  cùng case fail) → nợ môi trường có sẵn, không phải hồi quy; để lại kiểm ở cổng cuối
  Phase 3.
- **2c-i — ĐẠT (24/10/2026, Muse kiểm chứng):** `DUAL_ERROR_MESSAGES` trong
  lib/commands/dual.js đã phủ MỌI mã DUAL_DISCUSSION_*/DUAL_ISOLATED_DISCUSSION_*
  trong lib/ (đối chiếu grep 2 chiều, không thiếu mã nào); thông điệp đúng ngữ nghĩa
  Phase 3 (đối thoại chỉ qua daemon, tắt env không khôi phục đường lạnh). Suite
  dual-cli + dual-e2e đã di trú sang kỳ vọng fail-closed/stub; cổng của Muse:
  **68/68 pass** (kèm discussion-orchestrator) — gồm cả các luồng E2E đã di trú chạy
  thật, điều sandbox của Codex không chứng minh được.
- **2c-ii — ĐẠT (24/10/2026, Muse kiểm chứng):** Codex chạm HẠN MỨC 5H giữa lượt chạy
  (báo thử lại 6:19 AM) — theo lệnh thường trực của chủ repo: chờ hồi phục, không
  dồn thử lại; hạn mức hồi lúc ~13:21, lượt nối tiếp chạy tiếp phần còn lại. Phần 1
  (đã commit): 73→108 pass, 35 case được sửa, 0 hồi quy. Phần còn lại: 3 suite
  (acceptance-policy, incident-routing, incident-dependencies) baseline đã 11/0, 7/0,
  7/0 — không phụ thuộc discussion transport nên giữ nguyên kỳ vọng, không di trú.
  Test âm "daemon không discussion" được sửa ở fixture (nguyên nhân gốc: /tmp/.git
  rác làm Git auto-detection fail trước assertion; bản sửa truyền snapshot identity
  tường minh + assertion scout chưa có phase.started). Cổng shell cấp cao nhất
  11 suite: **171/172 pass** — test âm đạt toàn bộ assertion fail-closed
  (DUAL_DISCUSSION_REQUIRED, không chạy worker, không phase.failed/artifact scout);
  fail duy nhất là E10 (trust-e2e, timeout waitUntil 10s) — đối chứng fail cả ở HEAD,
  lỗi có sẵn, không phải hồi quy. Đã commit phần này (không push).
- **2d — ĐẠT (24/10/2026, Muse kiểm chứng):** Codex retire mode OLD trong
  `test/dual-phase2-benchmark.js` (fail `BENCHMARK_OLD_RETIRED` trước mọi provider I/O,
  kể cả default pair và worker trực tiếp; NEW giữ nguyên) + test mới
  `test/dual-phase2-benchmark-retirement.test.js` (10 test offline, spy chặn filesystem/
  child process/imports). Tài liệu theo khảo sát §5: README tách transport theo phase +
  flag semantics + link runbook; integration-design và seam-survey gắn trạng thái Phase 3
  (không sửa lịch sử); protocol/report Phase 2 thêm chú thích retirement (giữ nguyên số đo);
  runbook discussion mới `f01-discussion-recovery-runbook.md` (evidence/inspection/reconcile
  + giới hạn viết rõ: chưa có workflow restart → reclaim owner → tiếp tục terminal phase);
  safe-recovery chỉ thêm pointer, không sửa ngữ nghĩa validator; daemon-server chỉ sửa
  comment. Cổng của Muse ở shell cấp cao nhất: OLD check exit 1 sau 0.28s;
  diagnostics + retirement **11/11**; discussion gate **317 test — 312 pass, 0 fail,
  5 skip** (14 fail trong chạy sandbox của Codex đều là EPERM git subprocess, về shell
  cấp cao nhất đều pass — đúng quy tắc top-level là chuẩn). Đã commit phần này
  (không push; runbook bị gitignore `docs/` nên add bằng `git add -f`).
- **Fix round sau AGY review toàn Phase 3 — ĐẠT (24/10/2026, Muse kiểm chứng):**
  AGY review `f01-phase3-full-review-agy.md`: verdict ACCEPT WITH FIXES, 0 P0, 2 P1, 2 P2;
  H1–H7 TRUE, H8 PARTLY. P1-01 (nợ 20/33 ở `test/dual-daemon-orchestrator.test.js`) ĐÃ BỊ
  BÁC BẰNG ĐO THỰC TẾ: suite chạy ở shell cấp cao nhất cho **54 pass / 0 fail / 0 skip** —
  con số 20/33 trong các bản ghi cũ (kể cả mục 2b-ii dưới đây) là trạng thái tại thời điểm
  đó, KHÔNG còn đúng với source hiện tại; bản ghi này thay thế các bản ghi nợ đó.
  Codex sửa F1 (P1-02: turn handler của `withDiscussion` dùng `attempt` thực tế, mặc định
  `1`, thay cho hardcode `.1.`) và F2 (P2-01: proxy `localFs` tổng quát hoá cho mọi hàm fs
  lấy đường dẫn + `fs.promises`, chỉ rewrite string tương đối, giữ nguyên tuyệt đối/
  Buffer/URL/fd) trong `test/helpers/dual-discussion-stub.js` (+11/−8) + test hồi quy mới
  `test/dual-discussion-stub.test.js` (+66, 10 test). Cổng của Muse ở shell cấp cao nhất:
  3 suite bắt buộc + suite mới **167 pass / 0 fail**; discussion glob **323 pass / 0 fail /
  5 skip** (14 fail trong chạy sandbox của Codex đều là EPERM listen 127.0.0.1, về shell
  cấp cao nhất đều pass). P2-02 (orphan `.execution.json` khi crash sớm) giữ làm nợ kỹ
  thuật retention/GC sau Phase 3, không sửa production trong vòng này. Đã commit phần này
  (không push; review doc bị gitignore `docs/` nên add bằng `git add -f`).
- **Nghiệm thu Phase 3 — ĐẠT CÓ GIỚI HẠN GHI RÕ (24/10/2026, Muse kiểm chứng):**
  Cổng rộng cuối: **1432 test — 1422 pass / 1 fail / 9 skip**; fail duy nhất là
  observer-preflight case-collision, đã xác nhận fail sẵn ở baseline cuối Phase 2
  (`4125c1b`) và không thuộc diff Phase 3. Live acceptance
  `test/dual-discussion-live-acceptance.test.js` với `OMNI_DUAL_LIVE=1`: **PASS**
  (2 scout thật qua discussion host tới orchestrator, 181s; lần chạy đầu vấp
  `spawn agy ENOENT` chỉ vì shell thiếu PATH tới `~/.local/bin/agy`).
  Daemon qua executable thật `bin/omni-daemon.js` với `OMNI_DUAL_DISCUSSION_ENABLED`
  UNSET: session + capability preflight thật đều PASSED tại main root, isolated
  discussion được tạo đủ 2 conversation (manifest/identity đúng) — chứng minh
  default-on discussion ở executable. GIỚI HẠN (không thuộc phạm vi Phase 3, có từ
  Phase 1): task isolated live chưa đi tới handoff qua executable thật vì relay kiểm
  chứng capability trong worker root, mà snapshot worker loại trừ file control-plane
  theo thiết kế (`CANONICAL_CONTROL_PLANE_EXCLUDES` gồm `.codex`, `.omni/manifest.json`)
  nên worker không bao giờ có `.codex/config.toml` + hooks.json mà preflight đòi hỏi
  (lượt 2: `CAPABILITY_BLOCKED` ở scout; lượt 3/4: đưa config vào context_files thì
  preparation từ chối `DUAL_TASK_CONTEXT_UNAVAILABLE` đúng luật snapshot). Sửa triệt để
  cần quyết định thiết kế (verify theo session evidence trong worker, hoặc nới lỏng
  snapshot, hoặc preflight worker theo main root) — KHÔNG tự ý đổi trong Phase 3 vì
  chạm ranh giới fail-closed/bảo mật; ghi làm việc tiếp theo sau Phase 3. Nợ kỹ thuật
  còn lại: retention/GC stateDir discussion (P2-02), observer-preflight có sẵn.
  Đã commit phần nghiệm thu (không push).
- **Đợt trả hết nợ kỹ thuật — ĐẠT (24/10/2026, Muse kiểm chứng, theo lệnh "xử lý hết nợ
  kể cả các phase trước"):**
  Codex sửa 3 mục trong một brief (không commit/push; Muse kiểm chứng ở shell cấp cao
  nhất, số liệu sandbox của Codex dính EPERM nên không dùng):
  (D1) Daemon isolated live: `runCapabilityPreflight` thêm option `configRoot` (mặc định =
  workspaceRoot); chỉ 2 check đọc config project (project_configuration, MCP) đánh giá
  tại configRoot, mọi check còn lại vẫn ở worker root; `verifyCapability` của daemon
  truyền configRoot = main root của session khi có trusted context. Không copy file
  control-plane vào worker, không nới lỏng check nào — giới hạn ghi ở nghiệm thu Phase 3
  nay ĐÃ ĐÓNG.
  (D2) Orphan marker + GC: marker `.execution.json` có vòng đời seeding (kèm pid +
  createdAt) → complete sau manifest; creation gặp conflict chỉ reclaim khi marker chưa
  complete, mtime quá 5 phút và pid vắng/chết; host creation prune đúng orphan, không đụng
  marker complete/manifest/journal (journal giữ vô thời hạn làm evidence) — P2-02 ĐÃ ĐÓNG.
  (D3) Observer-preflight case-collision: 2 vòng kiểm trong `prepareTaskWorkspace` so
  sánh không phân biệt hoa/thường, không đổi `repoPathKey` toàn cục — fail có sẵn từ
  baseline Phase 2 nay ĐÃ ĐÓNG.
  Cổng kiểm chứng: 7 suite liên quan **224/224**, discussion glob **332 pass / 0 fail /
  5 skip** (tăng 9 test mới). Daemon live qua executable thật (env discussion UNSET,
  context_files chỉ README): handoff ĐẠT, scout/review/implement đều có raw output,
  implement SUCCESS (`node --check` exit 0), worker entry có sumIds, journal đủ 2
  conversation, marker `status: complete` — đường isolated live qua daemon nay đi tới
  handoff thật, không còn `CAPABILITY_BLOCKED`. Lưu ý kiểm chứng: tiêu chí verdict cũ
  của driver live (đòi `phase.completed` trong authority log) là sai với đường isolated
  (đường này không emit phase event vào authority log; handoff là tín hiệu kết thúc) —
  driver đã sửa tiêu chí theo evidence thực chất, chạy lại logic verdict trên artifact
  của lượt live này cho PASS 9/9 kiểm tra.
  Hai mục còn lại CHỐT BẰNG QUYẾT ĐỊNH, không sửa code: (a) default model 3.7 giữ nguyên
  — chỉ là fallback cuối cùng sau task.model > manifest workerModel > env, mọi đường thật
  đều pin 3.8 theo mandate; đường fallback chạm model không có sẵn sẽ fail-closed ở
  preflight thay vì chạy nhầm model; đổi default toàn cục là migration ảnh hưởng
  preflight/init/daemon nên cần duyệt riêng. (b) Workflow restart → reclaim owner →
  resume terminal phase: nửa orphan marker đã đóng nhờ D2; nửa tái tạo owner/adapters
  từ journal sau restart vẫn là tính năng phase tương lai, cần thiết kế và duyệt riêng
  (runbook recovery đã cập nhật thu hẹp giới hạn này); hành vi hiện tại fail-closed
  (từ chối thay vì dispatch trùng) là đúng mặc định an toàn.
- **Đính chính E10 trust-e2e trong nghiệm thu (24/10/2026, Muse kiểm chứng):**
  Cổng rộng sau fix round còn 2 fail; observer-preflight đã xác nhận fail sẵn ở baseline
  cuối Phase 2 (`4125c1b`, worktree đối chứng). E10 thì ngược lại: pass ở `4125c1b` nhưng
  fail ở mọi commit Phase 3 từ Gói 1 (bisect qua 5677b48, 47cc046, 64ea7f9, 62087e8,
  15ba88e) — phân loại "fail có sẵn" ở Gói 2c-ii là sai vì HEAD đối chứng lúc đó đã gãy.
  Nguyên nhân thật: E10 chờ `>= 2 task.process.started`, nhưng từ Phase 3 scout/review
  chạy qua discussion transport nên không spawn process — chỉ còn implement spawn 1
  process, điều kiện chờ không bao giờ thỏa (task vẫn đi tới handoff bình thường, fencing
  không hề hỏng). Đây là test chưa di trú theo transport mới, không phải hồi quy
  production. Sửa: điều kiện chờ đổi thành "implement child đang active trong lúc delay"
  (bỏ yêu cầu mutation trong lúc chờ — mutation chỉ xuất hiện khi delay hết, và vẫn được
  assert ở phần sau của test). Kết quả: E10 pass, toàn suite trust-e2e **32/32**; cổng
  rộng **1432 test — 1422 pass / 1 fail (observer có sẵn) / 9 skip**. Đã commit cùng
  mục nghiệm thu (không push).
- **Đính chính fix round (24/10/2026, Muse kiểm chứng — thay thế phần F1 ở mục trên):**
  F1 như Codex làm (stub đọc input theo task attempt) LÀ SAI và đã bị revert: cổng rộng
  cho thấy 2 test handoff-rejection đổ ENOENT `raw/scout.2.input.md`, và đo bằng debug
  chứng minh nguyên nhân — orchestrator đặt tên file theo PER-PHASE attempt
  (`prepareInputArtifacts` viết `raw/scout.1.input.md` cho cả lần chạy attempt-2, vì run
  mới có phase attempt = 1), trong khi turn của stub mang TASK attempt (= 2). Hai khái
  niệm attempt này khác nhau; hardcode `.1.` của stub cũ là ĐÚNG với mọi lần dispatch
  discussion của run mới (discussion fail là non-retryable nên không có dispatch lần 2
  trong cùng run). Kết luận: P1-02 của AGY là false positive dưới dạng đã nêu; stub giữ
  `.1.` kèm comment giải thích, test hồi quy mới sửa thành "task attempt = 2 vẫn đọc
  input phase-1". F2 (proxy fs tổng quát) giữ nguyên, không hồi quy. Cổng sau đính chính:
  stub + 2 handoff + observer **44/45** (chỉ còn observer-preflight case-collision, đã
  xác nhận fail sẵn ở baseline c6dbd96 và không thuộc diff Phase 3); discussion glob
  **323 pass / 0 fail / 5 skip**. Đã commit phần đính chính này (không push).
- **2b-ii — ĐẠT (24/10/2026, Muse kiểm chứng):** child factory `createIsolatedDiscussion`
  trong host-resolver (executionKey cấu trúc theo thiết kế, stateDir namespace
  `isolated/<key>`, registry/reader riêng, close lũy đẳng + tự unregister);
  daemon-server/bin cấp factory kèm adapters riêng theo execution +
  trustedExecutionContext đối chiếu ledger; isolated-authority bind exact
  lease/operation + closure authorize; isolated-runner có guard 3 chốt, 2 mã lỗi đúng
  phân loại (FACTORY_REQUIRED = PRECONDITION, IDENTITY_INVALID = TERMINAL), finally
  close child. Helper mới `test/helpers/dual-discussion-stub.js`; suite isolated đã
  di trú (scout/review qua stub, processRunner chỉ còn implement). Thích ứng trong
  phạm vi: manifest/evidence đặt cạnh journal (`isolated/<key>.manifest.json`) để
  tuân thủ allowlist của journal. Cổng của Muse: focused **169/169** (gồm 4 case
  isolated cần listen 127.0.0.1 mà sandbox của Codex chặn); discussion + capability
  **316 pass**, chỉ còn case preflight có sẵn tại HEAD; daemon-orchestrator giữ
  nguyên 20/33 (delta 0).
