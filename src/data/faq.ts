export const faqData = [
  {
    question: "Omni-Coder Kit hoạt động với AI coding agent nào?",
    answer: "Hỗ trợ Claude Code, Gemini CLI, Codex CLI (OpenAI), Cursor, Windsurf, Antigravity, Cross-tool và Generic. Dual-agent mode cho phép tạo CLAUDE.md + AGENTS.md đồng thời.",
  },
  {
    question: "Khác gì so với chỉ dùng AI coding trực tiếp?",
    answer: "AI thường code bừa — không hỏi, không plan, không test. Omni-Coder Kit inject Karpathy mindset (4 nguyên tắc Senior Engineer), Socratic Gate (3 câu hỏi bắt buộc), và SDLC pipeline 8 bước tự động. Knowledge Base tích lũy bài học qua mỗi fix.",
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
    question: "Knowledge Base (om:learn) hoạt động thế nào?",
    answer: "Sau mỗi om:fix thành công, om:learn tự ghi bài học vào .omni/knowledge-base.md (file đã thay đổi, root cause, fix pattern). Khi om:cook gặp file tương tự, tự đọc lại knowledge base để tránh lặp lỗi. Tối đa 20 entries, auto-prune cũ nhất.",
  },
  {
    question: "Shared Context Brief cho parallel agents là gì?",
    answer: "Khi om:cook spawn nhiều sub-agents chạy song song, main session extract ~500 tokens từ design-spec.md + shared files thành context brief. Mỗi agent nhận brief thay vì re-read toàn bộ — tiết kiệm token và đồng bộ context giữa các agents.",
  },
  {
    question: "Có hỗ trợ dự án đang có sẵn không?",
    answer: "Có. Chạy omni init trên dự án hiện tại, sau đó om:brainstorm để phân tích. om:plan sẽ phân tích codebase và tạo todo.md phù hợp với code hiện tại.",
  },
  {
    question: "Content Source-of-Truth (content-source.md) là gì?",
    answer: "Khi om:brainstorm phát hiện dự án có UI, tự sinh content-source.md chứa Facts, Tone, Forbidden Content. P5 Content Validation trong om:check đối chiếu mọi text trên UI với file này — đảm bảo nội dung chính xác, nhất quán.",
  },
  {
    question: "Personal rules là gì?",
    answer: "Quy tắc riêng của bạn: ngôn ngữ giao tiếp, coding conventions, forbidden patterns, custom rules. Thiết lập khi omni init hoặc sửa sau bằng omni rules edit. Tự đồng bộ vào config file.",
  },
];
