# F01 Phase 2 — Protocol benchmark cố định trước đo

Protocol: `f01-phase2-v1`. Tài liệu được viết trước khi có measurement của harness này. Không thay đổi rubric, mẫu hay ngưỡng sau khi thấy kết quả. Mục tiêu là quyết định lật mặc định discussion ở đường daemon bằng bằng chứng theo Q05 của [requirements.md](requirements.md); không suy diễn từ offline tests.

## Fixture và task

Harness sinh cùng byte nội dung cho mỗi bản sao repo Node: `entry.js` gọi `activeIds` từ `lib/util.js`; `README.md` mô tả API; `lib/util.js` lọc record active; `lib/parse.js` parse JSON array; `test/smoke.test.js` kiểm tra hai API bằng node:test. Nội dung cụ thể được cố định trong hằng `FIXTURE` của script. Không cần dependency, Git init hay Git commit. Mỗi run có thư mục tạm riêng và initial snapshot riêng, chụp trước khi tạo artifacts của orchestrator.

| Task | Công việc ở cả OLD và NEW |
| --- | --- |
| T1 | Scout trên fixture gốc, đọc API, assumptions, tests và risks; không sửa file. |
| T2 | Scout sau khi thêm đúng `lib/format.js`, `lib/stats.js`, `lib/validate.js` theo hằng `EXTRA_MODULES`; cây có 8 file. |
| T3 | Scout fixture gốc, sau đó review patch cố định của `lib/util.js`: thêm guard `Array.isArray`, throw TypeError nếu input không phải array. |

T3 không benchmark implementation: harness chuẩn bị `spec.json`, `evidence.json`, các transition hợp lệ đến `SCOPE_VALID` và áp patch bằng code cố định. Evidence phân biệt rõ patch do harness chuẩn bị, không giả vờ worker đã implement hoặc đã chạy test. Cùng request chứa nguyên unified diff ở cả hai mode; NEW còn nhận snapshot diff do sản phẩm cung cấp. Review phải read-only. Thời gian chuẩn bị này nằm trong wall time toàn run và phase `prepareReview`.

## Thiết kế cặp và môi trường

- Mỗi task có n = 3 cặp; mỗi cặp gồm OLD và NEW, tổng 18 run, 9 run/mode. Chạy tuần tự T1 → T2 → T3; trong mỗi task chạy cặp 1 → 2 → 3. Cặp lẻ OLD → NEW, cặp chẵn NEW → OLD; `order` là vị trí 1 hoặc 2 trong cặp.
- OLD: không truyền discussion option, không thay processRunner; dùng AGY thật qua runner mặc định của sản phẩm, cold-start cho từng phase.
- NEW: `createDiscussionHost`, host resolver, daemon facade + authority/lease fixtures giống acceptance; live Codex/AGY adapters và seeds thật. Capability fixtures là controller scaffolding, không chứng minh preflight production đã PASS.
- Models cố định: Codex `gpt-6.1-sol` effort `medium`; AGY `gemini-3.8-flash-high` effort `high`. Adapter/seed timeout 110s; orchestrator timeout 110s; hard deadline toàn run 240s. NEW tính cả seed và seed brief, không warm-up ngoài mẫu. PATH child prepend `~/.local/bin`; không đổi auth/config.
- Wall time toàn run tính từ trước spawn worker đến worker trả kết quả (gồm startup, fixture, baseline, preflight, seeds, phase và close host). Mỗi worker chạy orchestrator in-process. Parent giữ deadline và dừng process group khi hết hạn, ghi TIMEOUT rồi sang run kế. Cleanup/evidence extraction ở parent không tính vào wall time. Snapshot id, task id, session id và conversation ids khác nhau giữa run là correlation, không phải khác task.

## Metrics và rubric Q05

Mỗi run ghi ngay vào JSON output bằng atomic rename: `task`, `pair`, `order`, `mode`, `startedAt`, `wallMs`, `phases` (wallMs, ok, errorCode), `ok`, `errorCode`, `payloadValid`, `nudges`, `repairs`, `conversationIds`, `tokens`. Phase chưa chạy có `wallMs: null`, `ok: false`, `errorCode: NOT_RUN`; lỗi setup không bị gán thành phase thành công. Lỗi sandbox ghi code và stage thực tế, không skip mẫu.

Payload phải qua ContextSchema/ReviewSchema của orchestrator, khớp task_id và initial snapshot. T3 cần cả hai payload hợp lệ. Completion nghĩa là tất cả phase bắt buộc trả về state dự kiến; verdict NEEDS_FIX/REJECT hợp schema vẫn là review hoàn thành. NEW kiểm tra journal đã validate hash-chain: đếm `+nudge` trong observation evidence, ghi loại `payload-repair=...`, conversation ids từ seed/session. Journal chưa có là chưa dispatch; journal không đọc được là evidence unavailable và không đủ điều kiện khuyến nghị. Không mặc định evidence thiếu thành 0 outcome_unknown.

Continuity rubric: cùng task/baseline cho mỗi payload, T3 scout và review dùng cùng session/conversation; ghi continuity riêng. Duplicate dispatch: số dispatch_intent vượt số received message, không đếm nudge nội bộ như duplicate dispatch. Manual recovery = 0 do harness không can thiệp; không thực hiện retry ngoài chính sách có sẵn của sản phẩm. Báo unresolvedInvocations từ journal, kể cả invocation đang dở khi TIMEOUT.

Tokens chỉ lấy trường số usage/token CLI thực sự phơi ra, có source; không ước lượng. Nếu chỉ quan sát được một phần thì ghi coverage partial; thiếu ghi `unavailable`. Cost luôn `unavailable` nếu CLI không phơi ra. Không cộng token cumulative như per-call; không suy diễn token từ độ dài text. Không lưu stdout, stderr, prompt hay env vào output; không in secret. Raw evidence ở thư mục tạm được đọc trước cleanup.

Summary báo completion count/rate, payload validity, p50 và p95 wall time cho từng mode trên toàn bộ 9 run/mode, gồm cả run lỗi và TIMEOUT; không loại outlier. p50 là median (trung bình hai giá trị giữa nếu số mẫu chẵn); p95 nearest-rank `ceil(0.95*n)`. Summary đang chạy là provisional và không ra khuyến nghị lật trước đủ 18 run.

## Ngưỡng chốt trước — không sửa sau đo

1. Tỉ lệ hoàn thành NEW ≥ OLD.
2. 100% run NEW hoàn thành có payload hợp lệ sau repair/nudge.
3. Trung vị wall time NEW ≤ 1.30 × trung vị OLD, gộp toàn bộ task.
4. NEW có 0 outcome_unknown không khôi phục được.

Đủ mẫu và đủ evidence, đạt cả bốn → khuyến nghị lật mặc định ở đường daemon. Đường CLI giữ opt-in vì không có resolver factory. Trượt bất kỳ → giữ opt-in, nêu từng nguyên nhân. Evidence bị chặn/thiếu → giữ opt-in, kết luận chưa đủ bằng chứng; không coi như PASS rỗng.

## Kỷ luật trung thực và cách chạy

Không chạy lại run lỗi để lấy số đẹp. Run lỗi vẫn nằm trong mẫu với code; sandbox chặn ở đâu ghi ở đó. Retry/nudge tự động có sẵn của sản phẩm nằm trong cùng run, không phải mẫu mới. Parent crash có thể để lại run đang dở chưa có record; output giữ mọi run đã xong, summary incomplete, không tự resume hay bù mẫu. Dùng output path mới cho một experiment mới; script từ chối ghi đè kết quả có sẵn.

```sh
OMNI_DUAL_LIVE=1 node test/dual-phase2-benchmark.js /tmp/dual-phase2-results.json
```

Không có env gate: chỉ in hướng dẫn, exit 0, không tạo fixture/output hay gọi provider. Package này chỉ tạo protocol và harness, chưa phải kết quả benchmark hoặc bằng chứng để lật default.
