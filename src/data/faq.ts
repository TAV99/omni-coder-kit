export const faqData = [
  {
    question: "Omni-Coder Kit hoạt động với AI coding agent nào?",
    answer: "Hỗ trợ Claude Code, Codex CLI (OpenAI), Cursor, Windsurf, Antigravity, và bất kỳ agent tương thích AGENTS.md. Dual-agent mode cho phép tạo CLAUDE.md + AGENTS.md đồng thời.",
  },
  {
    question: "Khác gì so với chỉ dùng AI coding trực tiếp?",
    answer: "AI thường code bừa — không hỏi, không plan, không test. Omni-Coder Kit inject Karpathy mindset (4 nguyên tắc Senior Engineer), Socratic Gate (3 câu hỏi bắt buộc), và SDLC pipeline 7 bước tự động.",
  },
  {
    question: "Làm sao để cài đặt?",
    answer: "Chạy npm install -g omni-coder-kit, sau đó omni init trong thư mục dự án. Chọn IDE, discipline level, personal rules. Tổng thời gian ~30 giây.",
  },
  {
    question: "Config file có nặng không? Tốn token?",
    answer: "Config chỉ ~5KB (core rules + registry table). Workflows được lazy-load khi cần — tiết kiệm ~85% tokens so với nhúng inline. AI chỉ đọc workflow file khi bạn gọi lệnh >om: tương ứng.",
  },
  {
    question: "Có hỗ trợ dự án đang có sẵn không?",
    answer: "Có. Chạy omni init trên dự án hiện tại, sau đó om:brainstorm để phân tích. om:plan sẽ phân tích codebase và tạo todo.md phù hợp với code hiện tại.",
  },
  {
    question: "Personal rules là gì?",
    answer: "Quy tắc riêng của bạn: ngôn ngữ giao tiếp, coding conventions, forbidden patterns, custom rules. Thiết lập khi omni init hoặc sửa sau bằng omni rules edit. Tự đồng bộ vào config file.",
  },
];
