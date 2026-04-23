# Omni-Coder Kit 🚀

**Omni-Coder Kit** là một công cụ CLI mạnh mẽ được thiết kế để quản lý và "bơm" hệ tư tưởng (tư duy + quy trình + kỹ năng chuyên biệt) vào các môi trường lập trình hỗ trợ bởi AI. Công cụ này đảm bảo các AI agent của bạn (Claude Code, Cursor, Windsurf, Antigravity, v.v.) hoạt động với kỷ luật của một kỹ sư cấp cao (Senior), tuân thủ quy trình SDLC nghiêm ngặt và sử dụng các mẫu thiết kế tối ưu nhất.

## 🌟 Tính năng chính

- **Hỗ trợ đa IDE:** Tạo file cấu hình tùy chỉnh cho `Claude Code` (`CLAUDE.md`), `Cursor` (`.cursorrules`), `Windsurf` (`.windsurfrules`), `Antigravity` (`.antigravityrules`), và nhiều công cụ khác.
- **Tư duy cốt lõi (Phong cách Karpathy):** Áp dụng các nguyên tắc First Principles: Suy nghĩ trước khi code, Ưu tiên sự đơn giản, Thay đổi kiểu ngoại khoa (Surgical Changes), và Thực thi dựa trên mục tiêu.
- **Quy trình SDLC cấu trúc:** Điều phối quá trình phát triển thông qua các lệnh chuyên biệt như `[>om:brainstorm]`, `[>om:plan]`, và `[>om:cook]`.
- **Tech Stacks theo mô-đun:** Nhanh chóng thêm các quy tắc chuyên biệt cho React/Next.js, Hono/PostgreSQL, Tự động hóa (Bot), và Cổng thanh toán.
- **Tích hợp Kỹ năng ngoài:** Kết nối mượt mà với hệ sinh thái `skills.sh` để tải các kỹ năng chuyên gia từ các kho lưu trữ toàn cầu.
- **Hệ thống Manifest:** Theo dõi các kỹ năng đã cài đặt và ngăn ngừa xung đột trong dự án.

---

## 🛠️ Cài đặt

Đảm bảo bạn đã cài đặt [Node.js](https://nodejs.org/) (>=16.0.0).

```bash
# Clone repository
git clone https://github.com/TAV99/omni-coder-kit.git
cd omni-coder-kit

# Cài đặt các phụ thuộc
npm install

# Liên kết CLI toàn cục (tùy chọn)
npm link
```

---

## 🚀 Bắt đầu nhanh

### 1. Khởi tạo dự án
Chạy `omni init` tại thư mục gốc của dự án để thiết lập nền tảng.
```bash
omni init
```
- Chọn AI IDE bạn đang dùng (Claude Code, Cursor, v.v.).
- Chọn mức độ kỷ luật (Hardcore hoặc Flexible).
- Chọn các tech stack ban đầu.

### 2. Xem danh sách kỹ năng
Kiểm tra thư viện các stack chuyên biệt có sẵn trong kho.
```bash
omni list
```

### 3. Thêm quy tắc chuyên biệt
Bơm thêm các quy tắc kỹ thuật cụ thể vào cấu hình hiện tại.
```bash
omni add react-next
```

### 4. Trang bị kỹ năng từ bên ngoài
Tải các kỹ năng nâng cao từ registry `skills.sh` hoặc bất kỳ repository GitHub nào.
```bash
omni equip vercel-labs/agent-skills
```

### 5. Kiểm tra trạng thái
Xem các kỹ năng nào đang hoạt động trong dự án của bạn.
```bash
omni status
```

---

## 🧠 Quy trình làm việc Omni (SDLC)

Sau khi khởi tạo, hãy tương tác với AI của bạn bằng các lệnh có cấu trúc sau:

| Lệnh | Vai trò | Mô tả |
| :--- | :--- | :--- |
| `[>om:brainstorm]` | **Architect** | Phỏng vấn chuyên sâu, chọn tech stack và tạo `design-spec.md`. |
| `[>om:equip]` | **Manager** | Tự động tải các kỹ năng chuyên gia cần thiết qua `skills.sh`. |
| `[>om:plan]` | **PM** | Chia nhỏ spec thành các nhiệm vụ chi tiết trong `todo.md`. |
| `[>om:cook]` | **Coder** | Thực thi nhiệm vụ với độ chính xác cao và code tối giản nhất. |
| `[>om:check]` | **QA** | Xác minh tính năng và tạo báo cáo `test-report.md`. |
| `[>om:fix]` | **QA Agent** | Debug có hệ thống dựa trên phân tích log lỗi nghiêm ngặt. |
| `[>om:doc]` | **Writer** | Hoàn thiện tài liệu hướng dẫn và README. |

---

## 📂 Cấu trúc dự án

- `bin/omni.js`: Logic cốt lõi của CLI và định nghĩa các lệnh.
- `templates/core/`: Các quy tắc tư duy nền tảng và vệ sinh mã nguồn.
- `templates/stacks/`: Các bộ hướng dẫn chuyên biệt cho từng công nghệ.
- `templates/workflows/`: Các mẫu tự động hóa quy trình SDLC.
- `.omni-manifest.json`: Theo dõi các kỹ năng đã cài đặt và metadata của dự án.

---

## 📜 Giấy phép

Dự án này được cấp phép theo Giấy phép ISC.

Được phát triển với ❤️ bởi [TAV](mailto:tav99.dev@gmail.com).
