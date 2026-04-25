export const faqData = [
  {
    question: "Omni-Coder Kit hoạt động với AI coding agent nào?",
    answer: "Hỗ trợ Claude Code, Gemini CLI, Codex CLI (OpenAI), Cursor, Windsurf, Antigravity, Cross-tool và Generic. Dual-agent mode cho phép tạo CLAUDE.md + AGENTS.md đồng thời.",
  },
  {
    question: "Khác gì so với chỉ dùng AI coding trực tiếp?",
    answer: "AI thường code bừa — không hỏi, không plan, không test. Omni-Coder Kit inject Karpathy mindset (4 nguyên tắc Senior Engineer), Socratic Gate (3 câu hỏi bắt buộc), và SDLC pipeline 7 bước tự động.",
  },
  {
    question: "Làm sao để cài đặt?",
    answer: "Chạy npm install -g omni-coder-kit, sau đó omni init trong thư mục dự án. Chọn IDE, discipline level, personal rules. Tiếp theo omni auto-equip để cài 6 universal skills. Tổng thời gian ~30 giây.",
  },
  {
    question: "Config file có nặng không? Tốn token?",
    answer: "Config chỉ ~5KB (core rules + registry table). Workflows và examples được lazy-load khi cần. Surgical context rule: AI grep trước, chỉ đọc ±20 dòng xung quanh — tiết kiệm ~85% tokens so với nhúng inline.",
  },
  {
    question: "Project DNA Detection là gì?",
    answer: "Khi chạy >om:brainstorm, AI tự phân tích prompt để xác định DNA dự án: hasUI, hasBackend, hasAPI, backendComplexity (simple/moderate/complex). DNA ảnh hưởng đến toàn bộ quy trình — từ câu hỏi phỏng vấn, skill groups, đến thứ tự tasks.",
  },
  {
    question: "Overlay / Advanced setup là gì?",
    answer: "Khi omni init cho Claude Code, Codex CLI hoặc Gemini CLI, bạn có thể bật advanced setup. Claude Code: slash commands /om:*, permissions allowlist, quality gate hooks. Codex CLI: profiles (omni_safe, omni_yolo). Gemini CLI: workflows tối ưu riêng.",
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
