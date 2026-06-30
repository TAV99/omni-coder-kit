# Customer Spec — QuickTip Landing + Tip Calculator (HARNESS BENCHMARK)

> **Mục đích**: Fixture NHẸ để đo hiệu quả harness omni qua trọn vòng đời (intake → brainstorm → plan → cook → check → acceptance → doc). Đủ nhỏ để mỗi bước agent xong trong ~1–3 phút, nhưng CÓ răng gate thật (lint + build + unit test) nên CHECK/FIX/ACCEPTANCE được đo thực chất — tránh "GREEN giả".
> **Không** dùng backend, API key, hay dịch vụ ngoài. Chạy 100% local.

---

## 1. Tổng quan
| Mục | Giá trị |
|---|---|
| Tên | **QuickTip** — landing page + máy tính chia tiền boa |
| Người dùng | Khách truy cập web (1 trang) |
| Tech stack | HTML5 + CSS3 + Vanilla ES6 JS, **Vite** (build), **Vitest** (unit test), **ESLint** (lint) |
| Thiết bị | Mobile-first, responsive tới desktop |
| Phạm vi | Một trang tĩnh + một widget tính tiền boa nhúng sẵn; KHÔNG đăng nhập, KHÔNG backend |

## 2. Yêu cầu chức năng (atomic, kiểm chứng được)

### Core logic (hàm thuần — bắt buộc có unit test)
- [func] Hàm `calculateTip(bill, tipPercent, people)` trả về object `{ tipTotal, grandTotal, perPerson }`: `tipTotal = bill * tipPercent/100`, `grandTotal = bill + tipTotal`, `perPerson = grandTotal / people`. Làm tròn 2 chữ số thập phân.
- [func] `calculateTip` xử lý biên: `people < 1` → ném `Error` "people must be >= 1"; `bill < 0` hoặc `tipPercent < 0` → ném `Error`. Không trả về `NaN`/`Infinity`.
- [func] Hàm `formatCurrency(n)` trả chuỗi dạng `"$1,234.50"` (dấu phẩy ngăn nghìn, luôn 2 số lẻ).

### UI
- [ux] Hero section: tiêu đề "Split the bill in seconds", một dòng mô tả, và nút CTA cuộn xuống widget calculator.
- [ux] Widget calculator có 3 input (Bill amount, Tip %, Số người) và hiển thị `Tip total`, `Grand total`, `Per person` (dùng `formatCurrency`), cập nhật realtime khi nhập.
- [ux] Validation: nhập rỗng/âm/không phải số → hiện thông báo lỗi inline, KHÔNG crash, không hiện `NaN`.
- [ux] Mobile-first, responsive; cỡ chữ input ≥ 16px (tránh auto-zoom trên mobile).

### Quality gates (để đo CHECK/FIX/ACCEPTANCE)
- [test] Có unit test (Vitest) cho `calculateTip` và `formatCurrency` — tối thiểu 5 case gồm: tính đúng cơ bản, làm tròn, chia nhiều người, biên `people<1` ném lỗi, biên giá trị âm ném lỗi. Tất cả PHẢI xanh.
- [nfr] `npm run lint` (ESLint) sạch (0 error). `npm run build` (Vite) thành công. `npm test` (Vitest) xanh.
- [doc] `README.md`: mô tả ngắn, cách `npm install` / `npm run dev` / `npm test` / `npm run build`.

## 3. Ràng buộc
- Hàm logic (`calculateTip`, `formatCurrency`) tách riêng ở module thuần (vd `src/lib/tip.js`) — KHÔNG lẫn DOM — để test được offline không cần jsdom.
- Không phụ thuộc package nặng ngoài vite/vitest/eslint.
- Toàn bộ file nằm trong thư mục dự án (không dùng scratch).

## 4. Tiêu chí nghiệm thu (Definition of Done)
Sản phẩm đạt khi: `npm install && npm run lint && npm test && npm run build` chạy sạch; mở trang thấy hero + calculator hoạt động realtime; nhập sai bị chặn (không NaN); tất cả [func]/[ux]/[test]/[nfr]/[doc] ở trên thoả.
