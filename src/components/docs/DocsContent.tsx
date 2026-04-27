"use client";

import { DocsAccordion } from "./DocsAccordion";
import {
  ClaudeIcon, GeminiIcon, OpenAIIcon, CursorIcon,
  WindsurfIcon, AntigravityIcon, CrossToolIcon, GenericIcon,
} from "./IdeIcons";
import { useLang } from "@/components/LangProvider";

type Lang = "vi" | "en";

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="my-4 rounded-lg border border-outline bg-surface-code overflow-hidden">
      {title && (
        <div className="border-b border-outline px-4 py-2 text-xs text-content-faint">{title}</div>
      )}
      <pre className="overflow-x-auto p-4 text-sm text-content-secondary font-mono leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 pb-12 border-b border-outline-subtle last:border-0">
      <h2 className="text-2xl font-bold tracking-tight mb-4">
        <span className="gradient-text">{title}</span>
      </h2>
      <div className="prose-docs space-y-4 text-content-secondary leading-relaxed">{children}</div>
    </section>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-outline">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-outline bg-highlight">
            {headers.map((h) => (
              <th key={h} className="px-4 py-2.5 text-left font-semibold text-content-secondary">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-outline-subtle last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-content-muted">
                  <code className="text-xs bg-highlight px-1.5 py-0.5 rounded">{cell}</code>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tag({ children }: { children: string }) {
  return <code className="text-accent bg-accent-bg px-1.5 py-0.5 rounded text-sm">{children}</code>;
}

const t = {
  vi: {
    introTitle: "Giới thiệu",
    introP1: "là công cụ CLI inject mindset, SDLC workflow và skills vào các AI coding agent. Đảm bảo AI hoạt động với kỷ luật Senior Engineer, tuân thủ SDLC nghiêm ngặt và sử dụng mẫu thiết kế tối ưu.",
    introStats: [
      { num: "8+", label: "IDE hỗ trợ" },
      { num: "9", label: "SDLC Workflows" },
      { num: "6", label: "Universal Skills" },
    ],
    introP2: "Hỗ trợ Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, Antigravity, Cross-tool và Generic. Dual-agent mode cho phép tạo config cho nhiều AI tool đồng thời.",
    installTitle: "Cài đặt",
    installReq: "Yêu cầu",
    installInit: "Khởi tạo dự án:",
    installUpdate: "Cập nhật lên phiên bản mới nhất:",
    installNote: "CLI tự phát hiện project có sẵn (package.json, go.mod...) → đề xuất tạo Project Map. Sau đó hỏi 3 bước:",
    installStep1: "chọn IDE",
    installStep2: "mức kỷ luật",
    installStep3: "personal rules",
    installStep3Detail: "(ngôn ngữ, coding style, forbidden patterns, custom rules). Rules lưu tại .omni/rules.md.",
    karpathyP: "4 nguyên tắc cốt lõi được inject vào mọi AI agent:",
    karpathyItems: [
      { title: "Think Before Coding", desc: "Không assume. Không che giấu confusion. Surface tradeoffs. Hỏi trước khi code." },
      { title: "Simplicity First", desc: "Minimum code giải quyết vấn đề. Không feature thừa, không abstraction cho single-use code." },
      { title: "Surgical Changes", desc: "Chỉ sửa những gì cần thiết. Không 'improve' code xung quanh. Match existing style." },
      { title: "Goal-Driven Execution", desc: "Biến task mơ hồ thành mục tiêu có thể verify. Loop cho đến khi đạt success criteria." },
    ],
    socraticP1: "Bắt buộc AI hỏi tối thiểu 3 câu trước khi viết code —",
    socraticNoException: "không ngoại lệ",
    socraticExcept: "(trừ bug fix có reproduction steps rõ ràng).",
    socraticP2: "3 câu hỏi bắt buộc:",
    socraticQ: [
      { label: "(a) Scope confirmation", desc: "— xác nhận phạm vi feature" },
      { label: "(b) Edge case", desc: "— tình huống user chưa nghĩ tới" },
      { label: "(c) Implementation tradeoff", desc: "— 2-3 lựa chọn kỹ thuật với ưu/nhược" },
    ],
    socraticAuto: "Số câu hỏi tự động theo độ phức tạp:",
    skillsP: "tích hợp hệ sinh thái",
    skillsIntro: "với 3 cơ chế:",
    skillsUniversal: "6 skills mặc định cho mọi dự án: find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees.",
    skillsDiscovery: "dùng find-skills search skills.sh theo tech stack — không giới hạn framework. IDE-aware: chỉ cài skill cho IDE/CLI đã chọn.",
    skillsConditional: "3 nhóm skill động theo Project DNA: Best Practices (luôn có), UI/UX (khi hasUI), Backend/Infrastructure (khi backendComplexity >= moderate).",
    skillsInstall: "Cài skill từ skills.sh:",
    dnaP: "AI tự động phân tích prompt để xác định DNA của dự án:",
    dnaImpact: "DNA ảnh hưởng đến toàn bộ quy trình:",
    dnaDetail: "thêm backend complexity probe, kích hoạt nhóm Backend/Infrastructure skill, sắp xếp tasks theo backend-aware ordering.",
    kbTitle: "Knowledge Base (om:learn)",
    kbP: "Hệ thống tự tích lũy bài học — AI không lặp lại cùng một lỗi.",
    kbP2: "tự động ghi lại vào",
    kbHow: "Cách hoạt động",
    kbItems: [
      "sửa bug thành công →  auto-trigger",
      "Ghi lại: file đã thay đổi, root cause, fix pattern, ngày",
      "trước khi sửa file → check knowledge base cho bài học liên quan",
      "Tối đa 20 entries — auto-prune entry cũ nhất khi vượt limit",
    ],
    scbP: "spawn nhiều sub-agents chạy parallel (worktree isolation), mỗi agent cần hiểu context dự án. Thay vì mỗi agent re-read toàn bộ .omni/sdlc/design-spec.md + shared files, main session extract ~500 tokens thành một context brief gọn.",
    scbIncludes: "Brief bao gồm",
    scbItems: [
      "Project summary — goal, tech stack, DNA profile",
      "Architecture decisions — patterns đã chọn, constraints",
      "Shared interfaces — types/contracts các agents cần biết",
      "Knowledge base entries — bài học liên quan đến files agent sẽ sửa",
    ],
    scbBenefit: "Tiết kiệm token (mỗi agent không cần đọc full context), đồng bộ quyết định kiến trúc giữa các agents, giảm conflict khi merge.",
    csP: "phát hiện dự án có UI, tự động sinh",
    csP2: "— nguồn sự thật duy nhất cho mọi nội dung hiển thị trên UI.",
    csValidation: "trong om:check đối chiếu mọi text trên UI với .omni/sdlc/content-source.md — đảm bảo nội dung chính xác, nhất quán, không sai lệch.",
    pmTitle: "Project Map — Codebase Intelligence",
    pmP: "Khi tham gia dự án lớn đã có code, AI cần hiểu codebase mà không phải scan hàng trăm file mỗi session.",
    pmHow: "Cách hoạt động",
    pmItems: [
      "omni map quét codebase → sinh .omni/knowledge/project-map.md skeleton (0 token, instant)",
      "om:map trong chat AI → điền mô tả semantic cho từng module",
      "omni map --refresh → diff cấu trúc, đánh dấu [NEW]/[DELETED], giữ nguyên mô tả AI",
      "Workflows tự động cảnh báo khi map > 7 ngày",
    ],
    pmLangs: "Multi-language: Node.js/TypeScript, Python, Go, Rust, Java/Kotlin, Ruby, PHP",
    pmDeep: "Deep scan bao gồm: Tech stack, directory tree (max depth 4), entry points, CI/CD configs, conventions (linter, formatter), landmines (TODO/FIXME/HACK). Zero dependencies, zero network calls.",
    mapTitle: "om:map — Project Map",
    mapP: "AI đóng vai Architect. Điền mô tả semantic vào .omni/knowledge/project-map.md đã được omni map sinh sẵn.",
    mapItems: [
      "Đọc skeleton từ .omni/knowledge/project-map.md",
      "Phân tích từng module/directory → điền mô tả chức năng, patterns, dependencies",
      "Điền Key Patterns: auth strategy, error handling, DB patterns...",
      "Đánh dấu [NEW] modules cần mô tả, bỏ qua [DELETED]",
    ],
    wfTitle: "9 SDLC Workflows",
    wfHeaders: ["Lệnh", "Agent", "Mô tả"],
    wfRows: [
      ["om:brainstorm", "Architect", "Phỏng vấn adaptive + DNA detection → .omni/sdlc/design-spec.md"],
      ["om:equip", "Skill Manager", "Search skills.sh + conditional groups theo DNA"],
      ["om:plan", "PM", "Spec → micro-tasks .omni/sdlc/todo.md, @skill:name tags"],
      ["om:cook", "Coder", "Thực thi tasks, Shared Context Brief, quality gate mỗi 1/3"],
      ["om:check", "QA Tester", "Validation pipeline P0–P5 → .omni/sdlc/test-report.md"],
      ["om:fix", "Debugger", "Reproduce → root cause → surgical fix → verify"],
      ["om:map", "Architect", "Quét codebase → .omni/knowledge/project-map.md"],
      ["om:learn", "Knowledge", "Auto-record lessons sau fix → .omni/knowledge/knowledge-base.md"],
      ["om:doc", "Writer", "Đọc code thực tế → sinh README + API docs"],
    ],
    wfNote: "Quality pipeline bắt buộc: 3 quality cycles — cook → check → fix loop tự động sau mỗi 1/3 tasks.",
    brainstormTitle: "om:brainstorm — Phân tích yêu cầu",
    brainstormP: "AI đóng vai Chief Solutions Architect. Quy trình 2 phase:",
    brainstormPhase1: "Phase 1: Extract, Classify & Interview",
    brainstormPhase1Items: [
      "Parse prompt → extract 6 slots: goal, users, features, constraints, edge_cases, ui_hint",
      "Classify complexity: Small (≤2 features) / Medium (3-5) / Large (6+)",
      "Adaptive questions — chỉ hỏi slots thiếu, prefer multiple-choice",
      "Auto-detect Project DNA (hasUI, hasBackend, backendComplexity)",
    ],
    brainstormPhase2: "Phase 2: Generate .omni/sdlc/design-spec.md",
    brainstormPhase2Items: [
      "Summary table: Goal, Users, Tech Stack, UI Style, Constraints",
      "Tagged requirements: [func], [auth], [data], [api], [nfr], [edge], [ui]",
      "Large projects: auto-decompose thành sub-projects",
    ],
    equipTitle: "om:equip — Cài đặt Skills",
    equipP: "AI đóng vai Skill Manager. Phân tích tech stack từ .omni/sdlc/design-spec.md, search skills.sh và cài skills phù hợp.",
    equipGroups: "3 nhóm skill động:",
    equipGroupItems: [
      "Best Practices — luôn có (karpathy, debugging, TDD, code review)",
      "UI/UX — khi hasUI (React best practices, Tailwind, Framer Motion...)",
      "Backend/Infrastructure — khi backendComplexity >= moderate (DB, API, Docker...)",
    ],
    planTitle: "om:plan — Lập kế hoạch",
    planP: "AI đóng vai Senior PM. Transform .omni/sdlc/design-spec.md → micro-tasks trong .omni/sdlc/todo.md.",
    planItems: [
      "Mỗi task atomic, estimable (<20 phút), ordered theo dependency",
      "Backend-aware ordering: DB → Cache → Queue → API → Realtime → UI",
    ],
    cookTitle: "om:cook — Thực thi Code",
    cookP: "AI đóng vai Senior Developer. Thực thi từng task từ .omni/sdlc/todo.md.",
    cookItems: [
      "Dependency graph: phân tích tasks, nhóm thành batches chạy parallel",
      "Shared Context Brief: extract ~500 tokens từ .omni/sdlc/design-spec.md + shared files, gửi cho mỗi parallel agent thay vì re-read toàn bộ",
      "Knowledge Base lookup: trước khi sửa file, check .omni/knowledge/knowledge-base.md cho bài học liên quan",
      "Auto-continue: tự động chạy task tiếp, chỉ dừng khi lỗi nghiêm trọng",
      "Surgical context: file >200 dòng → grep trước, chỉ đọc ±20 dòng xung quanh",
      "Dev server preflight: tự khởi động dev server trước task đầu tiên (nếu có UI)",
    ],
    cookQuality: "Quality gate tự động:",
    checkTitle: "om:check — QA Testing",
    checkP: "AI đóng vai QA Tester. Chạy validation pipeline theo thứ tự:",
    checkNote: "P0–P3 fail → dừng ngay, auto-trigger om:fix. P5 Content Validation blocking khi dự án có UI — đảm bảo mọi text trên UI khớp với .omni/sdlc/content-source.md. Loop tối đa 3 lần/cycle.",
    fixTitle: "om:fix — Debug & Fix",
    fixP: "AI đóng vai Debugger. Quy trình có cấu trúc:",
    fixItems: [
      { label: "Reproduce", desc: "— tái tạo lỗi với test case cụ thể" },
      { label: "Root cause", desc: "— trace ngược từ symptom → nguyên nhân gốc" },
      { label: "Surgical fix", desc: "— sửa đúng chỗ, không shotgun-fix" },
      { label: "Verify", desc: "— chạy test ban đầu lại để confirm fix" },
    ],
    fixNote: 'Không bao giờ "thử đại" — AI phải hiểu root cause trước khi sửa.',
    learnTitle: "om:learn — Knowledge Base",
    learnP: "AI đóng vai Knowledge Engineer. Tự động ghi lại bài học sau mỗi fix thành công.",
    learnItems: [
      "Auto-trigger: chạy tự động sau om:fix thành công trong quality cycle",
      "Manual: gõ om:learn để ghi bài học thủ công",
      "Storage: .omni/knowledge/knowledge-base.md — max 20 entries, FIFO prune",
      "Lookup: om:cook check knowledge base trước khi sửa mỗi file",
    ],
    learnFormat: "Entry format:",
    learnNote: "Knowledge base giúp AI không lặp lại lỗi cũ — đặc biệt hiệu quả cho dự án dài hạn với nhiều quality cycles.",
    docTitle: "om:doc — Documentation",
    docP: "AI đóng vai Technical Writer. Đọc code thực tế rồi sinh documentation.",
    docItems: [
      "README.md — tổng quan, cài đặt, sử dụng, API reference",
      "API docs — từ route definitions thực tế trong code",
      "Inline comments — chỉ khi logic phức tạp, non-obvious",
    ],
    ideTitle: "IDE & CLI Guides",
    ideP: "Hướng dẫn chi tiết cho từng IDE/CLI được hỗ trợ. Chọn công cụ bạn đang dùng:",
    cliTitle: "CLI Commands",
    cliHeaders: ["Lệnh", "Mô tả"],
    cliRows: [
      ["omni init", "Khởi tạo DNA và workflow cho dự án mới (auto-detect existing project)"],
      ["omni map", "Quét codebase → sinh Project Map cho AI navigation"],
      ["omni map --refresh", "Cập nhật cấu trúc map (đánh dấu [NEW]/[DELETED])"],
      ["omni equip <source>", "Tải kỹ năng ngoài từ skills.sh"],
      ["omni auto-equip", "Cài 6 universal skills mặc định"],
      ["omni rules [action]", "Quản lý personal rules (view/edit/sync/reset)"],
      ["omni status", "Xem trạng thái skills đã cài đặt"],
      ["omni commands", "Hiển thị danh sách lệnh >om:"],
      ["omni update", "Kiểm tra và cập nhật lên phiên bản mới"],
    ],
    cliRules: "— quản lý personal rules:",
    ideSupportTitle: "IDE Support",
    ideSupportHeaders: ["IDE/Tool", "File tạo ra", "Gợi ý khởi động"],
  },
  en: {
    introTitle: "Introduction",
    introP1: "is a CLI tool that injects mindset, SDLC workflows, and skills into AI coding agents. Ensures AI operates with Senior Engineer discipline, follows strict SDLC, and uses optimal design patterns.",
    introStats: [
      { num: "8+", label: "IDEs supported" },
      { num: "9", label: "SDLC Workflows" },
      { num: "6", label: "Universal Skills" },
    ],
    introP2: "Supports Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, Antigravity, Cross-tool, and Generic. Dual-agent mode allows generating configs for multiple AI tools simultaneously.",
    installTitle: "Installation",
    installReq: "Requires",
    installInit: "Initialize project:",
    installUpdate: "Update to latest version:",
    installNote: "CLI auto-detects existing projects (package.json, go.mod...) → offers to create Project Map. Then asks 3 steps:",
    installStep1: "choose IDE",
    installStep2: "discipline level",
    installStep3: "personal rules",
    installStep3Detail: "(language, coding style, forbidden patterns, custom rules). Rules stored at .omni/rules.md.",
    karpathyP: "4 core principles injected into every AI agent:",
    karpathyItems: [
      { title: "Think Before Coding", desc: "Don't assume. Don't hide confusion. Surface tradeoffs. Ask before coding." },
      { title: "Simplicity First", desc: "Minimum code to solve the problem. No extra features, no abstractions for single-use code." },
      { title: "Surgical Changes", desc: "Only change what's necessary. Don't 'improve' surrounding code. Match existing style." },
      { title: "Goal-Driven Execution", desc: "Turn vague tasks into verifiable goals. Loop until success criteria are met." },
    ],
    socraticP1: "Forces AI to ask at least 3 questions before writing code —",
    socraticNoException: "no exceptions",
    socraticExcept: "(except bug fixes with clear reproduction steps).",
    socraticP2: "3 mandatory questions:",
    socraticQ: [
      { label: "(a) Scope confirmation", desc: "— confirm feature scope" },
      { label: "(b) Edge case", desc: "— scenarios the user hasn't considered" },
      { label: "(c) Implementation tradeoff", desc: "— 2-3 technical options with pros/cons" },
    ],
    socraticAuto: "Question count adapts to complexity:",
    skillsP: "integrates the",
    skillsIntro: "ecosystem with 3 mechanisms:",
    skillsUniversal: "6 default skills for every project: find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees.",
    skillsDiscovery: "uses find-skills to search skills.sh by tech stack — no framework limits. IDE-aware: only installs skills for the selected IDE/CLI.",
    skillsConditional: "3 dynamic skill groups based on Project DNA: Best Practices (always), UI/UX (when hasUI), Backend/Infrastructure (when backendComplexity >= moderate).",
    skillsInstall: "Install skill from skills.sh:",
    dnaP: "When running om:brainstorm, AI auto-analyzes the prompt to determine project DNA:",
    dnaImpact: "DNA affects the entire workflow:",
    dnaDetail: "adds backend complexity probes, activates Backend/Infrastructure skill group, orders tasks with backend-aware ordering.",
    kbTitle: "Knowledge Base (om:learn)",
    kbP: "Self-accumulating lesson system — AI doesn't repeat the same mistakes.",
    kbP2: "automatically records into",
    kbHow: "How it works",
    kbItems: [
      "successful fix → auto-trigger",
      "Records: changed files, root cause, fix pattern, date",
      "before modifying files → checks knowledge base for related lessons",
      "Max 20 entries — auto-prunes oldest when exceeding limit",
    ],
    scbP: "spawns multiple sub-agents running in parallel (worktree isolation), each agent needs project context. Instead of each agent re-reading all of .omni/sdlc/design-spec.md + shared files, the main session extracts ~500 tokens into a compact context brief.",
    scbIncludes: "Brief includes",
    scbItems: [
      "Project summary — goal, tech stack, DNA profile",
      "Architecture decisions — chosen patterns, constraints",
      "Shared interfaces — types/contracts agents need to know",
      "Knowledge base entries — lessons related to files the agent will modify",
    ],
    scbBenefit: "Saves tokens (each agent doesn't need full context), syncs architecture decisions across agents, reduces merge conflicts.",
    csP: "detects a UI project, auto-generates",
    csP2: "— the single source of truth for all UI content.",
    csValidation: "in om:check cross-references all UI text against .omni/sdlc/content-source.md — ensuring accurate, consistent content.",
    pmTitle: "Project Map — Codebase Intelligence",
    pmP: "When joining a large existing project, AI needs to understand the codebase without scanning hundreds of files every session.",
    pmHow: "How it works",
    pmItems: [
      "omni map scans codebase → generates .omni/knowledge/project-map.md skeleton (0 tokens, instant)",
      "om:map in AI chat → fills semantic descriptions for each module",
      "omni map --refresh → diffs structure, marks [NEW]/[DELETED], preserves AI descriptions",
      "Workflows auto-warn when map is > 7 days old",
    ],
    pmLangs: "Multi-language: Node.js/TypeScript, Python, Go, Rust, Java/Kotlin, Ruby, PHP",
    pmDeep: "Deep scan includes: Tech stack, directory tree (max depth 4), entry points, CI/CD configs, conventions (linter, formatter), landmines (TODO/FIXME/HACK). Zero dependencies, zero network calls.",
    mapTitle: "om:map — Project Map",
    mapP: "AI acts as Architect. Fills semantic descriptions into .omni/knowledge/project-map.md generated by omni map.",
    mapItems: [
      "Reads skeleton from .omni/knowledge/project-map.md",
      "Analyzes each module/directory → fills functional descriptions, patterns, dependencies",
      "Fills Key Patterns: auth strategy, error handling, DB patterns...",
      "Marks [NEW] modules needing descriptions, skips [DELETED]",
    ],
    wfTitle: "9 SDLC Workflows",
    wfHeaders: ["Command", "Agent", "Description"],
    wfRows: [
      ["om:brainstorm", "Architect", "Adaptive interview + DNA detection → .omni/sdlc/design-spec.md"],
      ["om:equip", "Skill Manager", "Search skills.sh + conditional groups by DNA"],
      ["om:plan", "PM", "Spec → micro-tasks .omni/sdlc/todo.md, @skill:name tags"],
      ["om:cook", "Coder", "Execute tasks, Shared Context Brief, quality gate every 1/3"],
      ["om:check", "QA Tester", "Validation pipeline P0–P5 → .omni/sdlc/test-report.md"],
      ["om:fix", "Debugger", "Reproduce → root cause → surgical fix → verify"],
      ["om:map", "Architect", "Scan codebase → .omni/knowledge/project-map.md"],
      ["om:learn", "Knowledge", "Auto-record lessons after fix → .omni/knowledge/knowledge-base.md"],
      ["om:doc", "Writer", "Read actual code → generate README + API docs"],
    ],
    wfNote: "Mandatory quality pipeline: 3 quality cycles — automatic cook → check → fix loop after every 1/3 of tasks.",
    brainstormTitle: "om:brainstorm — Requirement Analysis",
    brainstormP: "AI acts as Chief Solutions Architect. 2-phase process:",
    brainstormPhase1: "Phase 1: Extract, Classify & Interview",
    brainstormPhase1Items: [
      "Parse prompt → extract 6 slots: goal, users, features, constraints, edge_cases, ui_hint",
      "Classify complexity: Small (≤2 features) / Medium (3-5) / Large (6+)",
      "Adaptive questions — only ask for missing slots, prefer multiple-choice",
      "Auto-detect Project DNA (hasUI, hasBackend, backendComplexity)",
    ],
    brainstormPhase2: "Phase 2: Generate .omni/sdlc/design-spec.md",
    brainstormPhase2Items: [
      "Summary table: Goal, Users, Tech Stack, UI Style, Constraints",
      "Tagged requirements: [func], [auth], [data], [api], [nfr], [edge], [ui]",
      "Large projects: auto-decompose into sub-projects",
    ],
    equipTitle: "om:equip — Install Skills",
    equipP: "AI acts as Skill Manager. Analyzes tech stack from .omni/sdlc/design-spec.md, searches skills.sh and installs matching skills.",
    equipGroups: "3 dynamic skill groups:",
    equipGroupItems: [
      "Best Practices — always included (karpathy, debugging, TDD, code review)",
      "UI/UX — when hasUI (React best practices, Tailwind, Framer Motion...)",
      "Backend/Infrastructure — when backendComplexity >= moderate (DB, API, Docker...)",
    ],
    planTitle: "om:plan — Task Planning",
    planP: "AI acts as Senior PM. Transforms .omni/sdlc/design-spec.md → micro-tasks in .omni/sdlc/todo.md.",
    planItems: [
      "Each task is atomic, estimable (<20 min), ordered by dependency",
      "Backend-aware ordering: DB → Cache → Queue → API → Realtime → UI",
    ],
    cookTitle: "om:cook — Code Execution",
    cookP: "AI acts as Senior Developer. Executes tasks from .omni/sdlc/todo.md.",
    cookItems: [
      "Dependency graph: analyzes tasks, groups into parallel batches",
      "Shared Context Brief: extracts ~500 tokens from .omni/sdlc/design-spec.md + shared files, sends to each parallel agent instead of re-reading everything",
      "Knowledge Base lookup: checks .omni/knowledge/knowledge-base.md before modifying each file",
      "Auto-continue: automatically proceeds to next task, only stops on critical errors",
      "Surgical context: files >200 lines → grep first, only read ±20 lines around match",
      "Dev server preflight: auto-starts dev server before first task (if hasUI)",
    ],
    cookQuality: "Automatic quality gate:",
    checkTitle: "om:check — QA Testing",
    checkP: "AI acts as QA Tester. Runs validation pipeline in order:",
    checkNote: "P0–P3 fail → stop immediately, auto-trigger om:fix. P5 Content Validation is blocking for UI projects — ensures all UI text matches .omni/sdlc/content-source.md. Max 3 loops per cycle.",
    fixTitle: "om:fix — Debug & Fix",
    fixP: "AI acts as Debugger. Structured process:",
    fixItems: [
      { label: "Reproduce", desc: "— recreate the bug with a specific test case" },
      { label: "Root cause", desc: "— trace back from symptom → root cause" },
      { label: "Surgical fix", desc: "— fix the exact spot, no shotgun fixes" },
      { label: "Verify", desc: "— re-run the original test to confirm the fix" },
    ],
    fixNote: 'Never "try random things" — AI must understand root cause before fixing.',
    learnTitle: "om:learn — Knowledge Base",
    learnP: "AI acts as Knowledge Engineer. Automatically records lessons after each successful fix.",
    learnItems: [
      "Auto-trigger: runs automatically after successful om:fix in quality cycle",
      "Manual: type om:learn to record lessons manually",
      "Storage: .omni/knowledge/knowledge-base.md — max 20 entries, FIFO prune",
      "Lookup: om:cook checks knowledge base before modifying each file",
    ],
    learnFormat: "Entry format:",
    learnNote: "Knowledge base helps AI avoid repeating past mistakes — especially effective for long-term projects with many quality cycles.",
    docTitle: "om:doc — Documentation",
    docP: "AI acts as Technical Writer. Reads actual code then generates documentation.",
    docItems: [
      "README.md — overview, installation, usage, API reference",
      "API docs — from actual route definitions in code",
      "Inline comments — only for complex, non-obvious logic",
    ],
    ideTitle: "IDE & CLI Guides",
    ideP: "Detailed guides for each supported IDE/CLI. Choose the tool you're using:",
    cliTitle: "CLI Commands",
    cliHeaders: ["Command", "Description"],
    cliRows: [
      ["omni init", "Initialize DNA and workflows for a new project (auto-detects existing projects)"],
      ["omni map", "Scan codebase → generate Project Map for AI navigation"],
      ["omni map --refresh", "Update map structure (marks [NEW]/[DELETED])"],
      ["omni equip <source>", "Install external skills from skills.sh"],
      ["omni auto-equip", "Install 6 default universal skills"],
      ["omni rules [action]", "Manage personal rules (view/edit/sync/reset)"],
      ["omni status", "View installed skills status"],
      ["omni commands", "Show list of >om: commands"],
      ["omni update", "Check and update to latest version"],
    ],
    cliRules: "— manage personal rules:",
    ideSupportTitle: "IDE Support",
    ideSupportHeaders: ["IDE/Tool", "Generated File", "Start Command"],
  },
};

const ideSupportRows = [
  ["Claude Code / OpenCode", "CLAUDE.md", "claude"],
  ["Gemini CLI", "GEMINI.md", "gemini --yolo"],
  ["Codex CLI", "AGENTS.md + .codex/", "codex --profile omni_safe"],
  ["Claude Code + Codex (dual)", "CLAUDE.md + AGENTS.md", "—"],
  ["Antigravity", "AGENTS.md", "antigravity"],
  ["Cursor", ".cursorrules", "—"],
  ["Windsurf", ".windsurfrules", "—"],
  ["Cross-tool", "AGENTS.md", "Tool-agnostic"],
  ["Generic", "SYSTEM_PROMPT.md", "—"],
];

const checkHeaders = { vi: ["Priority", "Check", "Blocking?"], en: ["Priority", "Check", "Blocking?"] };
const checkRows = [
  ["P0", "Security: dependency audit, secrets leak, eval/innerHTML, SQL injection", "Yes"],
  ["P1", "Lint & Types: ESLint/Biome, TypeScript", "Yes"],
  ["P2", "Build: compile/bundle project", "Yes"],
  ["P3", "Tests: vitest/jest/pytest", "Yes"],
  ["P4", "Bundle: unused deps, bundle size", "No (advisory)"],
  ["P5", "Content: UI text vs .omni/sdlc/content-source.md", "Yes (hasUI)"],
];

function IdeGuides({ lang }: { lang: Lang }) {
  const vi = lang === "vi";
  return (
    <div className="space-y-3 my-4">
      <DocsAccordion title="Claude Code" icon={<ClaudeIcon />} defaultOpen>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>CLAUDE.md</Tag></p>
        <p><strong>{vi ? "Khởi tạo:" : "Initialize:"}</strong></p>
        <CodeBlock title="Terminal">{`cd your-project
omni init              # ${vi ? 'Chọn "Claude Code"' : 'Choose "Claude Code"'}
omni auto-equip        # ${vi ? "Cài 6 universal skills" : "Install 6 universal skills"}`}</CodeBlock>
        <p><strong>Advanced setup (Overlay):</strong></p>
        <p>{vi ? 'Khi được hỏi "Cài đặt Claude Code nâng cao?", chọn' : 'When asked "Advanced Claude Code setup?", choose'} <strong>Yes</strong> {vi ? "để kích hoạt:" : "to enable:"}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>Slash commands</strong> — 9 {vi ? "lệnh" : "commands"} <Tag>/om:*</Tag></li>
          <li><strong>Permissions allowlist</strong> — <Tag>.claude/settings.json</Tag></li>
          <li><strong>Quality gate hooks</strong></li>
          <li><strong>Shared Context Brief</strong></li>
          <li><strong>Knowledge Base integration</strong></li>
        </ul>
        <p><strong>{vi ? "Sử dụng workflows:" : "Using workflows:"}</strong></p>
        <CodeBlock title={vi ? "Trong Claude Code" : "In Claude Code"}>{`# ${vi ? "Dùng slash commands (auto-complete)" : "Use slash commands (auto-complete)"}
/om:brainstorm ${vi ? "Làm app quản lý task" : "Build a task management app"}

# ${vi ? "Hoặc gõ trực tiếp trong chat" : "Or type directly in chat"}
> om:plan
> om:cook
> om:learn`}</CodeBlock>
      </DocsAccordion>

      <DocsAccordion title="Gemini CLI" icon={<GeminiIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>GEMINI.md</Tag></p>
        <CodeBlock title="Terminal">{`cd your-project
omni init              # ${vi ? 'Chọn "Gemini CLI"' : 'Choose "Gemini CLI"'}
omni auto-equip`}</CodeBlock>
        <p><strong>{vi ? "Sử dụng workflows:" : "Using workflows:"}</strong></p>
        <CodeBlock title={vi ? "Trong Gemini CLI" : "In Gemini CLI"}>{`> om:brainstorm ${vi ? "Làm landing page cho SaaS" : "Build a SaaS landing page"}
> om:equip
> om:plan
> om:cook`}</CodeBlock>
      </DocsAccordion>

      <DocsAccordion title="Codex CLI (OpenAI)" icon={<OpenAIIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>AGENTS.md</Tag> + <Tag>.codex/</Tag></p>
        <CodeBlock title="Terminal">{`cd your-project
omni init              # ${vi ? 'Chọn "Codex CLI"' : 'Choose "Codex CLI"'}
omni auto-equip`}</CodeBlock>
        <p><strong>Advanced setup (Overlay):</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><Tag>.codex/config.toml</Tag> — 3 profiles: <Tag>omni_safe</Tag>, <Tag>omni_yolo</Tag>, <Tag>omni_review</Tag></li>
          <li><Tag>.codex/hooks.json</Tag> — Hook reminders</li>
        </ul>
      </DocsAccordion>

      <DocsAccordion title="Cursor" icon={<CursorIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>.cursorrules</Tag> + <Tag>.cursor/rules/*.mdc</Tag></p>
        <CodeBlock title="Terminal">{`cd your-project
omni init              # ${vi ? 'Chọn "Cursor"' : 'Choose "Cursor"'}
omni auto-equip`}</CodeBlock>
        <p><strong>Cursor Overlay (v2.3.0+):</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>7 MDC rules</strong> {vi ? "trong" : "in"} <Tag>.cursor/rules/</Tag></li>
          <li><strong>DNA-based MCP config</strong></li>
          <li><strong>YOLO guardrails</strong> — 3 tiers (safe/balanced/yolo)</li>
        </ul>
      </DocsAccordion>

      <DocsAccordion title="Windsurf" icon={<WindsurfIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>.windsurfrules</Tag></p>
        <CodeBlock title="Terminal">{`cd your-project
omni init              # ${vi ? 'Chọn "Windsurf"' : 'Choose "Windsurf"'}
omni auto-equip`}</CodeBlock>
      </DocsAccordion>

      <DocsAccordion title="Antigravity" icon={<AntigravityIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>AGENTS.md</Tag></p>
        <CodeBlock title="Terminal">{`cd your-project
omni init              # ${vi ? 'Chọn "Antigravity"' : 'Choose "Antigravity"'}
omni auto-equip`}</CodeBlock>
      </DocsAccordion>

      <DocsAccordion title="Cross-tool" icon={<CrossToolIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>AGENTS.md</Tag></p>
        <p>{vi ? "Dùng cho dự án có nhiều người dùng các AI tool khác nhau." : "For projects where team members use different AI tools."}</p>
      </DocsAccordion>

      <DocsAccordion title="Generic" icon={<GenericIcon />}>
        <p><strong>{vi ? "File config:" : "Config file:"}</strong> <Tag>SYSTEM_PROMPT.md</Tag></p>
        <p>{vi ? "Cho AI tool chưa có trong danh sách hỗ trợ chính thức. Copy nội dung vào system prompt." : "For AI tools not yet officially supported. Copy contents into your tool's system prompt."}</p>
      </DocsAccordion>
    </div>
  );
}

export function DocsContent() {
  const { lang } = useLang();
  const l = t[lang];

  return (
    <div className="min-w-0 flex-1 space-y-12">
      <Section id="introduction" title={l.introTitle}>
        <p><strong>Omni-Coder Kit</strong> {l.introP1}</p>
        <div className="grid gap-4 sm:grid-cols-3 my-6">
          {l.introStats.map((s) => (
            <div key={s.label} className="rounded-xl border border-outline bg-highlight p-4 text-center">
              <div className="text-3xl font-bold gradient-text">{s.num}</div>
              <div className="mt-1 text-sm text-content-muted">{s.label}</div>
            </div>
          ))}
        </div>
        <p>{l.introP2}</p>
      </Section>

      <Section id="installation" title={l.installTitle}>
        <p>{l.installReq} <strong>Node.js &gt;= 16.0.0</strong>.</p>
        <CodeBlock title="Terminal">{`npm install -g omni-coder-kit`}</CodeBlock>
        <p>{l.installInit}</p>
        <CodeBlock title="Terminal">{`cd your-project
omni init          # ${lang === "vi" ? "Chọn IDE, mức kỷ luật, personal rules (auto-detect project có sẵn)" : "Choose IDE, discipline level, personal rules (auto-detects existing projects)"}
omni map           # ${lang === "vi" ? "Quét codebase → Project Map (nếu chưa tạo khi init)" : "Scan codebase → Project Map (if not created during init)"}
omni auto-equip    # ${lang === "vi" ? "Cài 6 universal skills mặc định" : "Install 6 default universal skills"}
omni status        # ${lang === "vi" ? "Kiểm tra trạng thái" : "Check status"}`}</CodeBlock>
        <p>{l.installUpdate}</p>
        <CodeBlock title="Terminal">{`omni update`}</CodeBlock>
        <p>
          {lang === "vi" ? "Khi" : "When running"} <Tag>omni init</Tag>, {l.installNote} <strong>{l.installStep1}</strong> → <strong>{l.installStep2}</strong> (Hardcore / Flexible) → <strong>{l.installStep3}</strong> {l.installStep3Detail}
        </p>
      </Section>

      <Section id="karpathy-mindset" title="Karpathy Mindset">
        <p>{l.karpathyP}</p>
        <div className="space-y-3 my-4">
          {l.karpathyItems.map((p) => (
            <div key={p.title} className="rounded-lg border border-outline bg-highlight p-4">
              <h4 className="font-semibold text-content">{p.title}</h4>
              <p className="mt-1 text-sm text-content-muted">{p.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="socratic-gate" title="Socratic Gate">
        <p>{l.socraticP1} <strong>{l.socraticNoException}</strong> {l.socraticExcept}</p>
        <p>{l.socraticP2}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.socraticQ.map((q) => (
            <li key={q.label}><strong>{q.label}</strong> {q.desc}</li>
          ))}
        </ul>
        <p>{l.socraticAuto} <strong>1</strong> (Small), <strong>3</strong> (Medium), <strong>5</strong> (Large).</p>
      </Section>

      <Section id="skills-system" title="Skills System">
        <p>Omni-Coder Kit {l.skillsP} <strong>skills.sh</strong> {l.skillsIntro}</p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-outline bg-highlight p-4">
            <h4 className="font-semibold text-content">Universal Skills</h4>
            <p className="mt-1 text-sm text-content-muted">{l.skillsUniversal} {lang === "vi" ? "Cài bằng" : "Install with"} <Tag>omni auto-equip</Tag>.</p>
          </div>
          <div className="rounded-lg border border-outline bg-highlight p-4">
            <h4 className="font-semibold text-content">Dynamic Skill Discovery</h4>
            <p className="mt-1 text-sm text-content-muted"><Tag>om:equip</Tag> {l.skillsDiscovery}</p>
          </div>
          <div className="rounded-lg border border-outline bg-highlight p-4">
            <h4 className="font-semibold text-content">Conditional Skill Groups</h4>
            <p className="mt-1 text-sm text-content-muted">{l.skillsConditional}</p>
          </div>
        </div>
        <p>{l.skillsInstall}</p>
        <CodeBlock title="Terminal">{`omni equip vercel-labs/agent-skills`}</CodeBlock>
      </Section>

      <Section id="dna-detection" title="Project DNA Detection">
        <p>{lang === "vi" ? "Khi chạy" : "When running"} <Tag>om:brainstorm</Tag>, {l.dnaP}</p>
        <CodeBlock>{`DNA Profile:
  hasUI              = true/false
  hasBackend         = true/false
  hasAPI             = true/false
  backendComplexity  = simple | moderate | complex`}</CodeBlock>
        <Table
          headers={["backendComplexity", "Signals"]}
          rows={[
            ["simple", "CRUD, basic REST, single DB"],
            ["moderate", "Complex auth, file processing, 3rd-party integrations"],
            ["complex", "Realtime/WebSocket, queue/worker, caching, microservices"],
          ]}
        />
        <p>{l.dnaImpact} <Tag>om:brainstorm</Tag> {l.dnaDetail}</p>
      </Section>

      <Section id="knowledge-base" title={l.kbTitle}>
        <p>{l.kbP} {lang === "vi" ? "Sau mỗi" : "After each successful"} <Tag>om:fix</Tag> {lang === "vi" ? "thành công," : ","} <Tag>om:learn</Tag> {l.kbP2} <Tag>.omni/knowledge/knowledge-base.md</Tag>.</p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-accent-border bg-orange-400/5 p-4">
            <h4 className="font-semibold text-accent">{l.kbHow}</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-content-muted">
              <li><Tag>om:fix</Tag> {l.kbItems[0]} <Tag>om:learn</Tag></li>
              <li>{l.kbItems[1]}</li>
              <li><Tag>om:cook</Tag> {l.kbItems[2]}</li>
              <li>{l.kbItems[3]}</li>
            </ul>
          </div>
        </div>
        <CodeBlock title=".omni/knowledge/knowledge-base.md">{`## Lesson #1 — 2025-01-15
**Files:** src/api/auth.ts, src/middleware/jwt.ts
**Root cause:** JWT token refresh race condition
**Fix pattern:** Mutex lock on refresh endpoint, queue pending requests
**Tags:** auth, jwt, race-condition`}</CodeBlock>
      </Section>

      <Section id="shared-context-brief" title="Shared Context Brief">
        <p>{lang === "vi" ? "Khi" : "When"} <Tag>om:cook</Tag> {l.scbP}</p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-4">
            <h4 className="font-semibold text-accent-alt">{l.scbIncludes}</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-content-muted">
              {l.scbItems.map((item) => <li key={item}><strong>{item.split(" — ")[0]}</strong> — {item.split(" — ")[1]}</li>)}
            </ul>
          </div>
        </div>
        <p><strong>{lang === "vi" ? "Lợi ích:" : "Benefits:"}</strong> {l.scbBenefit}</p>
      </Section>

      <Section id="content-source" title="Content Source-of-Truth">
        <p>{lang === "vi" ? "Khi" : "When"} <Tag>om:brainstorm</Tag> {l.csP} <Tag>.omni/sdlc/content-source.md</Tag> {l.csP2}</p>
        <CodeBlock title=".omni/sdlc/content-source.md">{`## Facts
- Product name: "Omni-Coder Kit"
- Price: Free forever (ISC License)
- IDEs supported: 8+

## Tone
- Professional but friendly
- Technically accurate, no over-marketing

## Forbidden Content
- Don't claim "AI replaces developers"
- No direct competitor comparisons`}</CodeBlock>
        <p><strong>P5 Content Validation</strong> {l.csValidation}</p>
      </Section>

      <Section id="project-map" title={l.pmTitle}>
        <p>{l.pmP}</p>
        <CodeBlock title="Terminal">{`# CLI scans codebase (0 tokens, instant)
omni map

# Or auto-triggered during init for existing projects
omni init    # → "Existing project detected. Create Project Map?"

# Refresh structure (0 tokens)
omni map --refresh`}</CodeBlock>
        <p><strong>Output:</strong> <Tag>.omni/knowledge/project-map.md</Tag></p>
        <CodeBlock title=".omni/knowledge/project-map.md">{`# Project Map — my-app
> Generated by omni map | 2026-04-27 | 98 files, 12 dirs, ~5400 LOC

## Tech Stack
Runtime: Node.js | Lang: TypeScript | Framework: Express | DB: Prisma | Test: Jest

## Structure
- \`src/modules/auth/\`      (12 files) [PENDING]
- \`src/modules/orders/\`    (18 files) [PENDING]
- \`src/utils/\`             (5 files)  [PENDING]

## Key Patterns
[PENDING — AI fills this when running >om:map]`}</CodeBlock>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-accent-border bg-orange-400/5 p-4">
            <h4 className="font-semibold text-accent">{l.pmHow}</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-content-muted">
              {l.pmItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </div>
        <p><strong>{l.pmLangs}</strong></p>
        <p className="text-sm text-content-muted">{l.pmDeep}</p>
        <p>{lang === "vi" ? "Sau khi chạy" : "After running"} <Tag>om:map</Tag> {lang === "vi" ? "trong chat AI:" : "in AI chat:"}</p>
        <CodeBlock title=".omni/knowledge/project-map.md">{`## Structure
- \`src/modules/auth/\`      (12 files) → JWT login, OAuth2, 2FA, refresh rotation
- \`src/modules/orders/\`    (18 files) → Order state machine: draft→paid→shipped→done
- \`src/utils/\`             (5 files)  → Logger (pino), date/currency formatters

## Key Patterns
- Auth: JWT access (15m) + refresh (7d) rotation, Passport guards
- Error: Global exception filter → { code, message, details }
- DB: Prisma service with soft-delete middleware, repository pattern`}</CodeBlock>
      </Section>

      <Section id="workflows-overview" title={l.wfTitle}>
        <Table headers={l.wfHeaders} rows={l.wfRows} />
        <p><strong>{l.wfNote}</strong></p>
      </Section>

      <Section id="om-brainstorm" title={l.brainstormTitle}>
        <p>{l.brainstormP}</p>
        <p><strong>{l.brainstormPhase1}</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.brainstormPhase1Items.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <p><strong>{l.brainstormPhase2}</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.brainstormPhase2Items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </Section>

      <Section id="om-equip" title={l.equipTitle}>
        <p>{l.equipP}</p>
        <p><strong>{l.equipGroups}</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.equipGroupItems.map((item) => <li key={item}><strong>{item.split(" — ")[0]}</strong> — {item.split(" — ")[1]}</li>)}
        </ul>
        <CodeBlock title="Terminal">{`# ${lang === "vi" ? "Cài universal skills" : "Install universal skills"}
omni auto-equip

# ${lang === "vi" ? "Cài thêm skill pack" : "Install additional skill pack"}
omni equip vercel-labs/agent-skills

# ${lang === "vi" ? "Trong chat AI" : "In AI chat"}
> om:equip`}</CodeBlock>
      </Section>

      <Section id="om-plan" title={l.planTitle}>
        <p>{l.planP}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.planItems.map((item) => <li key={item}>{item}</li>)}
          <li>Skill-tagged: <Tag>@skill:skill-name</Tag></li>
          <li>{lang === "vi" ? "Infra tasks tách vào" : "Infra tasks separated into"} <Tag>setup.sh</Tag>, code tasks → .omni/sdlc/todo.md</li>
        </ul>
        <CodeBlock title=".omni/sdlc/todo.md">{`## 1. Database
- [ ] Create users table migration @skill:supabase-postgres
- [ ] Seed sample data @skill:supabase-postgres

## 2. Frontend
- [ ] Create login page @skill:vercel-react-best-practices
- [ ] Form validation @skill:vercel-react-best-practices`}</CodeBlock>
      </Section>

      <Section id="om-cook" title={l.cookTitle}>
        <p>{l.cookP}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.cookItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <p><strong>{l.cookQuality}</strong></p>
        <CodeBlock>{`om:cook (1/3 tasks)
  → om:check
    → [om:fix ↔ om:check loop, max 3]
    → om:learn
  → om:cook (1/3 tasks)
    → om:check → [fix loop] → om:learn
  → om:cook (1/3 tasks)
    → om:check → [fix loop] → om:learn
  → om:doc`}</CodeBlock>
      </Section>

      <Section id="om-check" title={l.checkTitle}>
        <p>{l.checkP}</p>
        <Table headers={checkHeaders[lang]} rows={checkRows} />
        <p>{l.checkNote}</p>
      </Section>

      <Section id="om-fix" title={l.fixTitle}>
        <p>{l.fixP}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.fixItems.map((item) => <li key={item.label}><strong>{item.label}</strong> {item.desc}</li>)}
        </ul>
        <p>{l.fixNote}</p>
      </Section>

      <Section id="om-map" title={l.mapTitle}>
        <p>{l.mapP}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.mapItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <CodeBlock title={lang === "vi" ? "Trong chat AI" : "In AI chat"}>{`> om:map

🗺️ ${lang === "vi" ? "Đang phân tích codebase từ Project Map..." : "Analyzing codebase from Project Map..."}
  ✓ src/modules/auth/ → JWT login, OAuth2, 2FA, refresh rotation
  ✓ src/modules/orders/ → Order state machine: draft→paid→shipped→done
  ✓ Key Patterns: 3 patterns ${lang === "vi" ? "đã nhận diện" : "identified"}

✅ Project Map ${lang === "vi" ? "đã cập nhật" : "updated"} (.omni/knowledge/project-map.md)`}</CodeBlock>
      </Section>

      <Section id="om-learn" title={l.learnTitle}>
        <p>{l.learnP}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.learnItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <p><strong>{l.learnFormat}</strong></p>
        <CodeBlock>{`## Lesson #N — YYYY-MM-DD
**Files:** list of fixed files
**Root cause:** root cause description
**Fix pattern:** applied fix pattern
**Tags:** keywords for lookup`}</CodeBlock>
        <p>{l.learnNote}</p>
      </Section>

      <Section id="om-doc" title={l.docTitle}>
        <p>{l.docP}</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          {l.docItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </Section>

      <Section id="ide-cli-guides" title={l.ideTitle}>
        <p>{l.ideP}</p>
        <IdeGuides lang={lang} />
      </Section>

      <Section id="cli-commands" title={l.cliTitle}>
        <Table headers={l.cliHeaders} rows={l.cliRows} />
        <p><strong>omni rules</strong> {l.cliRules}</p>
        <CodeBlock title="Terminal">{`omni rules          # ${lang === "vi" ? "Menu tương tác" : "Interactive menu"}
omni rules view     # ${lang === "vi" ? "Xem rules hiện tại" : "View current rules"}
omni rules edit     # ${lang === "vi" ? "Sửa rules" : "Edit rules"}
omni rules sync     # ${lang === "vi" ? "Sync vào config file" : "Sync to config file"}
omni rules reset    # ${lang === "vi" ? "Xóa rules" : "Reset rules"}`}</CodeBlock>
      </Section>

      <Section id="ide-support" title={l.ideSupportTitle}>
        <Table headers={l.ideSupportHeaders} rows={ideSupportRows} />
      </Section>
    </div>
  );
}
