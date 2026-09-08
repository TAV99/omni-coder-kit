# Isolated finalization repair — 2026-09-08

## Phạm vi và nguyên nhân

Plan: docs/superpowers/plans/2026-09-08-isolated-finalization-repair.md. Coding do Luna/xhigh thực hiện, primary kiểm tra độc lập và reviewer fresh-context phản biện.

Trong incident E:\LdPage, private phase đã CODEX_QC/evidence SUCCESS/review APPROVE, child processes exit0, nhưng outer authority không có handoff/outcome/release. Điều này chứng minh khoảng trống quan sát ở bước finalization, không chứng minh chính xác exception lịch sử hoặc controller death.

Fixture fake-clock tái hiện lỗi code: khi lease hết hạn, catch active-only không ghi outcome; releaseLease ném DUAL_LEASE_EXPIRED và che lỗi gốc. Bản sửa không nới TTL, không bỏ QC hoặc giới hạn attempt.

## Bản sửa

- Thêm event failure-only task.execution.finalization_failed; stage/code/recovery có giới hạn, không ghi raw worker output/credentials.
- Failure được ghi sau expiry với owner/session/revision/attempt/lease/controller execution đúng lineage. Không cho execution cũ ghi vào task đã đổi owner/revision hoặc bị execution/lease mới thay thế.
- Settlement sau expiry cần bằng chứng normal close của mọi tracked child; pending/running/null/unknown/zero-child giữ recovery-needed. Không thay guard releaseLease thông thường hoặc suy ra process-tree chết từ PID.
- Delayed close được nâng unsettled lên settled đúng một lần; helper/replay từ chối duplicate/conflict, giữ history cho correction/context resume hợp lệ.
- Cleanup diagnostic không thay lỗi gốc. Stage unknown được giữ nếu chưa có bằng chứng collection.
- Unmanaged node_modules bị chặn trước khi quét sâu; npm-ci vẫn cần receipt hợp lệ; dist vẫn chịu scope, không ignore toàn cục.
- Workflow hướng dẫn typed setup và immutable package/lock, phân biệt task-level recovery với archive --if-pristine.

## Phản biện và kiểm định

- Baseline process/workspace:17/17 pass.
- Parent independent regression ban đầu54/54 pass; reviewer phát hiện missing current owner/revision/superseding-lease guards và stage fallback sai. Bốn RED tests tái hiện; đã sửa.
- Reviewer v2 phát hiện guard quá rộng chặn cả execution history cũ đã released. Thêm tests correction2/context-resume positive và superseded released/no-start negative, đã sửa bằng event-sequence ordering.
- Parent finalization regression cuối:15/15 pass, exit0.
- Luna impacted suite cuối:88 pass/0fail (báo cáo worker, không thay thế full gate).
- Reviewer v3: APPROVED, spec/quality không còn blocker trong scope. Không đồng nghĩa live/release-qualified.
- Syntax7 files và git diff --check: PASS.
- Full lượt đầu:1758pass/4fail/2skip, exit1; gồm các RED regressions thêm khi lượt chạy đang hoạt động. Giữ log full.tap; không dùng làm acceptance.
- Full source chốt: **1.766 pass, 0 fail, 2 skipped**, 1.768 tests/223 suites, exit0, 709,5 giây; .omni/runs/finalization-repair/full-final.tap.

## Biên bàn giao

Kết luận: bản sửa local đã hoàn tất implementation, review v3 và full-suite gate. Các failure RED/review trước đã được giữ lại làm evidence, không thay thế kết quả cuối.

Không sửa source/private workspace/ledger của E:\LdPage; không copy code, xóa lock, restart/resume/recover hoặc kill daemon/worker khách hàng. Chưa live rerun, commit/push/tag/publish. Hai file version bump từ trước giữ nguyên.

Sửa này ngăn/mô tả failure mới đúng cách; không tự hồi tố sửa ledger đang treo. Recovery phiên cũ phải là bước riêng sau khi xác minh runtime hiện tại và quyền người dùng.

Artifact chi tiết: .omni/runs/finalization-repair/luna-report.md, focused.tap, full.tap, full-final.tap, review-v2.diff và progress.md.
