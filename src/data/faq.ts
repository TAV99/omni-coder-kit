export const faqData = {
  vi: [
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
      answer: "Sau mỗi om:fix thành công, om:learn tự ghi bài học vào .omni/knowledge/knowledge-base.md (file đã thay đổi, root cause, fix pattern). Khi om:cook gặp file tương tự, tự đọc lại knowledge base để tránh lặp lỗi. Tối đa 20 entries, auto-prune cũ nhất.",
    },
    {
      question: "Shared Context Brief cho parallel agents là gì?",
      answer: "Khi om:cook spawn nhiều sub-agents chạy song song, main session extract ~500 tokens từ .omni/sdlc/design-spec.md + shared files thành context brief. Mỗi agent nhận brief thay vì re-read toàn bộ — tiết kiệm token và đồng bộ context giữa các agents.",
    },
    {
      question: "Có hỗ trợ dự án đang có sẵn không?",
      answer: "Có. Chạy omni init trên dự án hiện tại (tự phát hiện project có sẵn → đề xuất tạo Project Map), sau đó om:brainstorm để phân tích. om:plan sẽ phân tích codebase và tạo .omni/sdlc/todo.md phù hợp với code hiện tại.",
    },
    {
      question: "Content Source-of-Truth là gì?",
      answer: "Khi om:brainstorm phát hiện dự án có UI, tự sinh .omni/sdlc/content-source.md chứa Facts, Tone, Forbidden Content. P5 Content Validation trong om:check đối chiếu mọi text trên UI với file này — đảm bảo nội dung chính xác, nhất quán.",
    },
    {
      question: "Personal rules là gì?",
      answer: "Quy tắc riêng của bạn: ngôn ngữ giao tiếp, coding conventions, forbidden patterns, custom rules. Thiết lập khi omni init hoặc sửa sau bằng omni rules edit. Tự đồng bộ vào config file.",
    },
  ],
  en: [
    {
      question: "Which AI coding agents does Omni-Coder Kit work with?",
      answer: "Supports Claude Code, Gemini CLI, Codex CLI (OpenAI), Cursor, Windsurf, Antigravity, Cross-tool, and Generic. Dual-agent mode lets you generate CLAUDE.md + AGENTS.md simultaneously.",
    },
    {
      question: "How is this different from using AI coding directly?",
      answer: "AI typically codes recklessly — no questions, no planning, no tests. Omni-Coder Kit injects Karpathy mindset (4 Senior Engineer principles), Socratic Gate (3 mandatory questions), and an automated 8-step SDLC pipeline. Knowledge Base accumulates lessons from each fix.",
    },
    {
      question: "How do I install it?",
      answer: "Run npm install -g omni-coder-kit, then omni init in your project directory. Choose IDE, discipline level, personal rules. Then omni auto-equip to install 6 universal skills. Total time ~30 seconds.",
    },
    {
      question: "Are config files heavy? Do they waste tokens?",
      answer: "Config is only ~5KB (core rules + registry table). Workflows and examples are lazy-loaded on demand. Surgical context rule: AI greps first, only reads ±20 lines around the match — saves ~85% tokens vs. inline embedding.",
    },
    {
      question: "What is Project DNA Detection?",
      answer: "When running >om:brainstorm, AI auto-analyzes the prompt to determine project DNA: hasUI, hasBackend, hasAPI, backendComplexity (simple/moderate/complex). DNA affects the entire workflow — from interview questions, skill groups, to task ordering.",
    },
    {
      question: "How does Knowledge Base (om:learn) work?",
      answer: "After each successful om:fix, om:learn records lessons in .omni/knowledge/knowledge-base.md (changed files, root cause, fix pattern). When om:cook encounters similar files, it reads the knowledge base to avoid repeating mistakes. Max 20 entries, auto-prunes oldest.",
    },
    {
      question: "What is Shared Context Brief for parallel agents?",
      answer: "When om:cook spawns multiple sub-agents running in parallel, the main session extracts ~500 tokens from .omni/sdlc/design-spec.md + shared files into a context brief. Each agent receives the brief instead of re-reading everything — saves tokens and syncs context across agents.",
    },
    {
      question: "Does it support existing projects?",
      answer: "Yes. Run omni init on your existing project (auto-detects existing projects → offers to create Project Map), then om:brainstorm to analyze. om:plan will analyze the codebase and create .omni/sdlc/todo.md tailored to your current code.",
    },
    {
      question: "What is Content Source-of-Truth?",
      answer: "When om:brainstorm detects a UI project, it auto-generates .omni/sdlc/content-source.md containing Facts, Tone, Forbidden Content. P5 Content Validation in om:check cross-references all UI text against this file — ensuring accurate, consistent content.",
    },
    {
      question: "What are personal rules?",
      answer: "Your own rules: communication language, coding conventions, forbidden patterns, custom rules. Set during omni init or edit later with omni rules edit. Auto-syncs into the config file.",
    },
  ],
};
