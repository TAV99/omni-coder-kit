# Harness Benchmark — QuickTip · Cách chạy & Thang điểm

Fixture nhẹ để đo hiệu quả harness omni qua trọn vòng đời mà không tốn 20+ phút/bước như dự án Large. Input: [`spec.md`](./spec.md).

## Cách chạy (mỗi lần đo = thư mục sạch)
```bash
# 1. Thư mục đo sạch (ngoài repo omni)
rm -rf ~/bench-quicktip && mkdir ~/bench-quicktip && cd ~/bench-quicktip

# 2. Gắn omni (chọn IDE đang muốn đo: antigravity / claudecode)
omni init            # chọn Antigravity (hoặc Claude Code), chế độ Auto

# 3. Dọn scratch agy để biết chắc file ghi đúng dự án
rm -rf ~/.gemini/antigravity-cli/scratch/*

# 4. Chạy trọn vòng đời từ spec
omni run --spec <ĐƯỜNG_DẪN>/omni-coder-kit/bench/landing-tip/spec.md --accept
#   (chưa đặt --step-timeout: đo luôn bảng timeout per-step mặc định)
```
Theo dõi event: `omni run log --follow` (cửa sổ khác).

## Thu thập số liệu mỗi lần đo
Ghi lại vào một dòng bảng (xem template cuối file):

1. **Phase reach** — pipeline tới state xa nhất nào? (BRAINSTORM→…→DONE / dừng ở đâu).
2. **Artifact thật** — mỗi file có được sinh & có nội dung thật không:
   - `.omni/sdlc/requirements.md` (≥7 R, KHÔNG có dòng `#`/`>`/`---`)
   - `.omni/sdlc/design-spec.md`, `todo.md` (≥4 task checkbox)
   - Code: `package.json`, `src/lib/tip.js`, test file, `index.html` — **trong dự án** (không phải scratch)
3. **Gate có răng** — `npm run lint`/`test`/`build` chạy THẬT (P0–P5 không phải GREEN-giả). Ghi số test pass/fail CHECK đọc được.
4. **Vòng CHECK/FIX** — số lần fix, có hội tụ (gate xanh) hay BLOCKED? BLOCKED có đúng lý do & dừng gọn không?
5. **ACCEPTANCE** — bao nhiêu / tổng R "met"? có lặp COOK đúng cách không?
6. **Thời gian** — phút mỗi bước (từ event `step-end.sec`); tổng tới khi dừng.
7. **stderr sạch** — không còn `/bin/sh … Permission denied` hay lỗi launch.
8. **Sản phẩm chạy được** — sau khi xong, `npm install && npm test && npm run build` ở thư mục đo có sạch không; mở `index.html`/`npm run dev` thấy calculator hoạt động, nhập sai không ra `NaN`.

## Thang điểm hiệu quả harness (0–100)
| Hạng mục | Điểm | Đạt khi |
|---|---|---|
| Pipeline tiến | 15 | Chạy hết INIT→DOC không kẹt vì bug harness (timeout/launch/state) |
| Artifact đầy đủ & thật | 15 | requirements/design/todo + code đều có nội dung thật, đúng chỗ |
| COOK đẻ code thật | 20 | `src/lib/tip.js` + test + UI nằm trong dự án, không scratch |
| Gate có tín hiệu | 15 | lint/build/test chạy thật; CHECK phản ánh đúng pass/fail |
| CHECK/FIX hội tụ | 15 | Lỗi test/lint được FIX tới xanh, hoặc BLOCKED đúng & gọn (không lặp tới hết phiên) |
| ACCEPTANCE đúng | 10 | Chấm vào R thật; ≥80% R met khi sản phẩm đạt DoD |
| Sản phẩm chạy được | 10 | `npm test && npm run build` xanh ở thư mục đo; calculator hoạt động |

**Cách dùng**: chạy benchmark sau MỖI thay đổi harness → so điểm/thời gian giữa các lần để biết đang tiến hay lùi. Mục tiêu "harness hoàn thành" ≈ đạt ≥85/100 ổn định 2 lần liên tiếp, không cần thao tác tay giữa chừng.

## Template ghi kết quả
```
| Ngày | Commit harness | IDE | Phase reach | COOK code? | Gate signal | FIX rounds | ACCEPT met | Thời gian | Điểm | Ghi chú/bug mới |
|------|----------------|-----|-------------|-----------|-------------|-----------|-----------|----------|------|-----------------|
| 2026-06-30 | 6137f28 | antigravity | … | … | … | … | … | … | … | … |
```

## Lưu ý
- Đây là benchmark cho **harness**, không phải sản phẩm giao khách. Giữ spec ổn định để các lần đo so sánh được; nếu sửa spec → reset baseline.
- Muốn đo riêng phần build (bỏ qua intake/brainstorm): tạo todo sẵn rồi `omni run --from COOK`. Muốn đo trọn vòng: `--spec … --accept` từ đầu như trên.
- Đo "agy chậm tới đâu" cũng là một số đo — đừng vội tăng `--step-timeout`; để bảng per-step mặc định làm việc và ghi lại thời gian thực.
