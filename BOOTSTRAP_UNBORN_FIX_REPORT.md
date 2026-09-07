# Báo cáo bootstrap/unborn và interview — 2026-09-08

## Kết quả

Đã triển khai bản sửa theo plan `docs/superpowers/plans/2026-09-07-bootstrap-unborn-interview-fix.md`. Coding subagent: `bootstrap_luna`, model `gpt-5.6-luna`, reasoning `xhigh`, đúng yêu cầu người dùng. Primary Codex review và chạy kiểm tra độc lập; reviewer fresh-context kết luận spec PASS, quality PASS, không có Critical/Important trong diff.

## Nguyên nhân và bản sửa

- Repo mới `git init` có top-level nhưng chưa có HEAD. Detector cũ chọn Git chỉ dựa membership, khiến capture thất bại. Detector mới chỉ chọn snapshot sau khi xác minh symbolic HEAD hợp lệ và ref nhánh thực sự vắng mặt; repo lỗi/không xác minh được báo DUAL_GIT_PROBE_FAILED. Explicit Git capture/pinned Git vẫn giữ kiểm tra nghiêm ngặt.
- Stop hook cũ suy ra design sẵn sàng chỉ từ file spec không rỗng, rồi ép bootstrap dù interview đang chờ người dùng. Stop pre-authority nay trả thông báo trung lập, không ép continuation, không tuyên bố đã duyệt/hoàn tất. Source/build/browser mutation guards giữ nguyên.
- Status allowlist cũ chỉ nhận TASK-N/UUID. Nay `omni dual status VIBE-LANDING-001` và TaskID đúng contract được chấp nhận; help/version đúng cú pháp được cho phép, flags thừa/operator/redirection vẫn bị chặn.
- Wrapper của phiên lỗi chỉ xuất `r.output`, làm mất `session_id`/`exit_code`. Workflow nay yêu cầu giữ full result bằng `text(r)`, poll handle thay vì retry bootstrap khi output trống, không dump discovery token. Đây là sửa hướng dẫn wrapper, không phải tự khôi phục handle của process lịch sử.

## Kiểm định

- Baseline trước sửa: 26/26 pass.
- Báo cáo Luna có RED/GREEN cho unborn detection và hook; primary phát hiện/sửa qua phản biện các regression về bootstrap allowance, branch slash, task ID và fixture preflight/cleanup.
- Full suite: `node --test --test-concurrency=1 --test-reporter=dot --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=.omni/runs/bootstrap-unborn-review/full-suite.tap test/*.test.js test/**/*.test.js`.
- Full TAP kết thúc: **1.750 pass, 0 fail, 2 skipped**, 1.752 tests, 223 suites; 442.997 ms. Khi resume, process handle cũ không còn tồn tại; số liệu lấy từ TAP hoàn chỉnh, không suy ra exit status từ handle mất.
- Primary rerun sau resume: `node --test --test-concurrency=1 test/dual-baseline-git.test.js test/dual-hook-bridge.test.js test/dual-bootstrap.test.js` => **67/67 pass**, 0 fail/skip, exit 0.
- Syntax baseline/hook và `git diff --check`: PASS.
- Fixture dùng daemon/store/client thật và mock capability, không gọi model. `ensureDaemonSession` vẫn được thay bằng helper của test nên chưa chứng minh live spawn/discovery; không suy rộng thành live/release-qualified.

## Biên bàn giao

- Lượt agent/reviewer từng gặp 429; Luna có code và report trước lỗi cuối. Reviewer retry sau đó đã hoàn tất; primary không lấy thông báo agent lỗi làm bằng chứng thành công.
- Không sửa E:\LdPage, không xóa index.lock, không commit/start/restart/resume daemon hay AGY trong project khách hàng. Quan sát lock/daemon cũ không chứng minh trạng thái hiện tại hoặc ownership.
- Hai file version bump package.json/package-lock.json giữ nguyên từ yêu cầu trước.
- Chưa commit/push bản sửa này, chưa publish, chưa live rerun E:\LdPage.
- Bước tiếp theo tách riêng: xác minh trạng thái runtime/lock hiện tại rồi xin phép recovery/restart và thử lại đúng một bootstrap với full process handle; không tự xóa lock hoặc commit để né lỗi.

Artifacts: `.omni/runs/bootstrap-unborn-review/luna-report.md`, `review.diff`, `full-suite.tap`, `controller-notes.md`, `progress.md`.
