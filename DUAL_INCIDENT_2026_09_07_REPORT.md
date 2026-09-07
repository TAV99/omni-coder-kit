# Báo cáo sửa lỗi Dual — 2026-09-07

## Phạm vi và cách phối hợp

Yêu cầu: lập plan, giao AGY implementation, Codex kiểm tra độc lập, hai bên phản biện và sửa. Plan chi tiết: `docs/superpowers/plans/2026-09-07-dual-incident-root-fixes.md` (file cụ thể được đưa vào commit theo yêu cầu bàn giao, không thay đổi ignore rules của repo).

AGY/Gemini 3.7 Flash High đã viết patch tests/implementation cho routing, dependency fingerprint, external-operation helper, readiness và đưa phản biện. Do AGY headless không có quyền đọc file, Codex gửi các đoạn source và yêu cầu có giới hạn; AGY trả patch. Codex áp dụng, tích hợp và chạy tests. Không dùng bypass permissions; không tuyên bố AGY tự chạy filesystem/tests. Một Codex reviewer riêng kiểm tra read-only các điểm security/integration.

Không sửa E:\LdPage, ledger của phiên lỗi, package/lock hoặc project bindings. Không restart daemon của phiên lỗi, gửi attempt 3, commit/push, bump version, publish hay deploy. Giữ nguyên nhánh `codex/v3.1.2` và các thay đổi có sẵn.

## Plan và kết quả triển khai

| Nhóm | Bản sửa | Bằng chứng |
|---|---|---|
| Source binding | Daemon truyền `agyProjectId` riêng; shared adapter mới thêm `--project`. Isolated giữ nguyên việc từ chối flags không an toàn. Không xóa mapping người dùng. | Helper + real adapter/fake-worker argv tests; isolated authority integration |
| Dependency fingerprint | Hash theo chunk tối đa 1 MiB; 256 MiB/file, 1 GiB tổng, 50.000 files, depth 64. Giữ encoding fingerprint cũ; kiểm tra identity/metadata trước/sau read; đóng fd khi lỗi. | Binary 74.882.048 bytes: RED trên code cũ, GREEN trên code mới; boundary 256 MiB, drift giữa read, fd close, receipt drift |
| Readiness | Kiểm tra immutable inputs và dependency tree đang có sau setup, trước ensureSession/resume. Không dùng kết quả này thay private install receipt. | Escaping dependency và oversized file bị chặn trước session; chưa cài dependencies không sinh receipt |
| Stitch authority | Grant chính xác theo tool/input/evidence scope; schema ở plan/ledger/daemon/MCP. Reserve durable trước Pre, không tự retry một grant đã reserve; Post chỉ ghi observed. | Daemon registration/replay, sai arguments/owner, path smuggling, duplicate Pre, unreserved Post, expired worker lease |
| Recovery | Nếu mọi task chưa xong đều thất bại hoặc phụ thuộc lỗi và không còn lease active/expired, Stop báo correction thay vì lặp continuation. Không coi session hoàn thành. | Test failed preparation + unrelated runnable task; process recovery suite |
| Workflow | Giải thích mixed graph restriction, grant chính xác, private readiness và cách giữ ledger khi correction. | Controller/planning templates, generated workflow tests trong full suite |

## Các phản biện đã xử lý

- AGY đề xuất ban đầu dùng size/mtime để phát hiện thay file: Codex bổ sung dev/ino/ctime và đối chiếu fd/path; test growth giữa read kiểm tra fail-closed.
- Helper routing ban đầu biến non-array args thành `[]`: Codex giữ input sai để runner từ chối, không âm thầm bỏ validation.
- External helper ban đầu cho phép thiếu allowed_files, fallback `task.grants`, và dùng regex thay glob: đã sửa theo contract và thêm test.
- Reviewer bắt `release_requested` rơi nhầm switch branch khi Codex tích hợp: tái hiện 2 failing process tests, sửa và 8/8 tests qua.
- Reviewer bắt expired AGY lease chưa được xem là unsafe: thêm guard + fake-clock regression, không reserve khi bị chặn.
- AGY bắt external call sai input có thể rơi xuống local-path authorization: test `path: a.js` tái hiện, đã hard-deny mutation không có exact grant.
- Không chấp nhận đề nghị tự chọn giữa hai grant giống nhau: ambiguity vẫn deny vì native tool input không chứng minh task nào được chọn.
- Post observation không cần thêm một Codex lease không tồn tại trong interactive mode; sử dụng authority Codex/ROUTED sẵn có, không đồng nhất observation với remote success.

## Quality evidence

- Baseline focused: 34/34 pass trước thay đổi production.
- Cycle 1/2 focused: 44/44 pass sau routing/fingerprint.
- Cycle 3 focused: 148 pass, 0 fail, log `.omni/runs/incident-cycle3-focused.tap`; các sửa sau đó có targeted regression riêng.
- Lượt full đầu: 1.742 pass, 0 fail, 2 skipped, 1.744 tests / 223 suites; `.omni/runs/incident-full-suite.tap`. Source còn được chỉnh trong lượt này nên không dùng riêng lượt đó để chứng nhận bản cuối.
- Lượt full cuối trên source đã đóng băng: **1.743 pass, 0 fail, 2 skipped**, 1.745 tests / 223 suites, exit 0, 893,1 giây; `.omni/runs/incident-final-suite.tap`.
- Regression cuối trên source đã đóng băng: **156/156 pass**, 0 fail/skip, exit 0; `.omni/runs/incident-final-targeted.tap` (129,8 giây).
- Syntax: 12/12 production JS/MJS được sửa qua `node --check`; `git diff --check` qua; `node bin/omni.js dual --help` qua.
- `npm audit --audit-level=high`: exit 0; còn 1 Moderate vulnerability ở `qs`. Không chạy audit fix hoặc tự đổi dependency.
- Fingerprint read-only trên dependency tree bảo toàn từ E:\LdPage: `ff8478695656657be8319ed850672b3b8ea8fa45af7727b9dec6294108aaf571`. Không install, không model invocation, không ghi receipt vào phiên đó.
- Clean temporary `npm ci --ignore-scripts --no-audit --no-fund`: exit 0, 104 packages; `C:\Users\TAV\AppData\Local\Temp\omni-incident-clean-6e2d7733f687489e8276e7cc44dc38e5`. Đây là clean dependency install, không phải packaged-release qualification.
- Reviewer độc lập cuối: không còn material finding trong scope review; focused 36/36 pass. AGY cũng xác nhận không còn material concern trong các ràng buộc đã nêu, dựa trên excerpts/test evidence được cung cấp.

## Giới hạn và bàn giao

**Kết luận:** Các bản sửa trong phạm vi source Omni đã triển khai, qua regression và full suite, được AGY/Codex phản biện và reviewer độc lập kiểm tra. Bàn giao nguyên checkout để người dùng review; không thực hiện bước release hoặc tiếp tục phiên khách hàng.

- Không tuyên bố phiên E:\LdPage đã hoàn thành hoặc landing page đã hoạt động. Phiên đó vẫn giữ evidence thất bại attempt 2 và cần một bước resume/correction được phê duyệt riêng.
- Grant hỗ trợ exact preknown Stitch arguments, không wildcard. Nếu operation sau cần ID chỉ có sau operation trước, phải chuẩn bị design/context trước khi freeze graph, hoặc xin authority follow-up rõ ràng; không tự sửa graph đang active.
- IAM/OAuth/Supabase/Stitch permissions là điều kiện bên ngoài, chưa sửa hay live-verify trong lượt này.
- 256 MiB/file là policy finite được kiểm thử, không hứa hỗ trợ dependency mọi kích thước hoặc mọi native lifecycle. Các giới hạn count/tổng giữ nguyên; không tuyên bố đã live-qualify mọi platform/toolchain.
- Global `omni` là junction tới checkout development; chưa có release mới. Không dùng số version `3.1.1` để suy ra đây là package phát hành nguyên trạng.
- Không tạo feature tự đổi global binding hay tắt hook để recovery. Cách sửa tận gốc là tránh truyền binding sai, preflight sớm và giữ fail-closed cho side effect chưa xác minh.
