## INTERVIEW QUESTION TEMPLATES (REFERENCE — read only when needed)
Mẫu câu hỏi cho từng slot trong `>om:brainstorm`. AI điều chỉnh theo ngữ cảnh, không copy nguyên văn.

**goal (mục tiêu):**
> Tôi cần hiểu rõ mục tiêu chính để thiết kế đúng scope.
> Mô tả ngắn gọn: dự án này giải quyết vấn đề gì, cho ai?
> VD e-commerce: "Cho phép chủ shop nhỏ bán hàng online không cần code"
> VD internal tool: "Dashboard theo dõi KPI cho team marketing, 5 người dùng"
> VD SaaS: "Nền tảng quản lý dự án cho freelancer, monetize bằng subscription"

**users (người dùng):**
> Ai sẽ dùng sản phẩm này? Mỗi role có quyền khác nhau không?
> Liệt kê các role và mô tả ngắn quyền hạn của từng role.
> VD blog: "admin (CRUD bài viết, quản lý user), reader (đọc, comment)"
> VD SaaS: "owner (billing, team settings), member (dùng features), guest (view only)"

**features (tính năng):**
> Tính năng cốt lõi nào bắt buộc phải có ở phiên bản đầu tiên?
> Liệt kê theo dạng: hành động → kết quả mong muốn.
> VD task app: "tạo task với deadline → hiện trên calendar; kéo thả để đổi trạng thái"
> VD API: "POST /upload nhận file CSV → parse và lưu DB; GET /report trả JSON tổng hợp"
>
> **Nếu `backendComplexity ≥ moderate`, probe thêm:**
> - Luồng dữ liệu nào cần realtime? (push notification, live update, chat)
> - Có tác vụ nào chạy nền không? (gửi email, xử lý file, sync data)
> - Các service có cần giao tiếp với nhau không? (API-to-API, event bus)
> VD: "Order service tạo event → Payment service xử lý → Notification service gửi email"
> VD: "Upload ảnh → background worker resize 3 sizes → lưu S3"

**constraints (ràng buộc):**
> Có ràng buộc kỹ thuật nào cần biết trước không?
> Bao gồm: tech stack bắt buộc, hosting, budget, deadline, team size.
> VD: "phải dùng Next.js + Supabase, deploy Vercel, budget $0, solo dev"
> VD: "Python FastAPI, cần chạy trên server nội bộ, không được dùng cloud"
> Nếu không có ràng buộc, ghi "AI tự chọn" — tôi sẽ đề xuất stack phù hợp nhất.
>
> **Nếu `backendComplexity ≥ moderate`, probe thêm:**
> - Yêu cầu về data consistency? (eventual vs strong)
> - Cần xử lý bao nhiêu concurrent connections?
> - Có cần offline/retry mechanism không?
> VD: "eventual consistency OK cho notifications, strong consistency cho payments"
> VD: "peak 500 concurrent websocket connections"

**edge_cases (trường hợp biên):**
> Có tình huống lỗi hoặc giới hạn nào cần xử lý đặc biệt?
> Nghĩ về: dữ liệu sai, số lượng lớn, mất kết nối, concurrent access.
> VD: "file upload > 100MB thì reject; 2 user edit cùng lúc thì last-write-wins"
> VD: "offline mode cho mobile; API rate limit 100 req/phút"
>
> **Nếu `backendComplexity ≥ moderate`, probe thêm:**
> - Khi service/worker fail thì xử lý thế nào? (retry, dead letter queue, alert)
> - Data migration strategy? (zero-downtime, maintenance window)
> VD: "failed jobs retry 3 lần, sau đó vào dead letter queue + alert Slack"
