export const aboutData = {
  title: "Không chỉ gợi ý code — AI chạy cả SDLC pipeline",
  points: [
    {
      title: "Karpathy Mindset",
      description: "4 nguyên tắc cốt lõi: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution. AI phải tuân thủ — không code bừa.",
    },
    {
      title: "Socratic Gate",
      description: "Bắt buộc AI hỏi tối thiểu 3 câu trước khi viết code: xác nhận scope, edge case chưa nghĩ tới, và trade-off kỹ thuật. Không ngoại lệ.",
    },
    {
      title: "8 SDLC Workflows + DNA Detection",
      description: "Từ brainstorm → equip → plan → cook → check → fix → learn → doc. AI tự nhận diện Project DNA (hasUI, hasBackend, backendComplexity) để điều chỉnh quy trình. Knowledge Base tự tích lũy bài học. Skill-tagged tasks và automated quality pipeline với 3 quality cycles.",
    },
  ],
  workflow: [
    { command: "om:brainstorm", label: "Phân tích yêu cầu", agent: "Architect" },
    { command: "om:equip", label: "Cài skills", agent: "Skill Manager" },
    { command: "om:plan", label: "Lập kế hoạch", agent: "PM" },
    { command: "om:cook", label: "Thực thi code", agent: "Coder" },
    { command: "om:check", label: "QA Testing", agent: "QA Tester" },
    { command: "om:fix", label: "Debug & Fix", agent: "Debugger" },
    { command: "om:learn", label: "Knowledge Base", agent: "Knowledge" },
    { command: "om:doc", label: "Documentation", agent: "Writer" },
  ],
};
