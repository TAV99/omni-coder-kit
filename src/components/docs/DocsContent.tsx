"use client";

import { DocsAccordion } from "./DocsAccordion";
import {
  ClaudeIcon, GeminiIcon, OpenAIIcon, CursorIcon,
  WindsurfIcon, AntigravityIcon, CrossToolIcon, GenericIcon,
} from "./IdeIcons";

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

export function DocsContent() {
  return (
    <div className="min-w-0 flex-1 space-y-12">
      {/* ── GETTING STARTED ── */}
      <Section id="introduction" title="Giới thiệu">
        <p>
          <strong>Omni-Coder Kit</strong> là công cụ CLI inject mindset, SDLC workflow và skills vào các AI coding agent.
          Đảm bảo AI hoạt động với kỷ luật Senior Engineer, tuân thủ SDLC nghiêm ngặt và sử dụng mẫu thiết kế tối ưu.
        </p>
        <div className="grid gap-4 sm:grid-cols-3 my-6">
          {[
            { num: "8+", label: "IDE hỗ trợ" },
            { num: "8", label: "SDLC Workflows" },
            { num: "6", label: "Universal Skills" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-outline bg-highlight p-4 text-center">
              <div className="text-3xl font-bold gradient-text">{s.num}</div>
              <div className="mt-1 text-sm text-content-muted">{s.label}</div>
            </div>
          ))}
        </div>
        <p>
          Hỗ trợ Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, Antigravity, Cross-tool và Generic.
          Dual-agent mode cho phép tạo config cho nhiều AI tool đồng thời.
        </p>
      </Section>

      <Section id="installation" title="Cài đặt">
        <p>Yêu cầu <strong>Node.js &gt;= 16.0.0</strong>.</p>
        <CodeBlock title="Terminal">{`npm install -g omni-coder-kit`}</CodeBlock>
        <p>Khởi tạo dự án:</p>
        <CodeBlock title="Terminal">{`cd your-project
omni init          # Chọn IDE, mức kỷ luật, personal rules
omni auto-equip    # Cài 6 universal skills mặc định
omni status        # Kiểm tra trạng thái`}</CodeBlock>
        <p>Cập nhật lên phiên bản mới nhất:</p>
        <CodeBlock title="Terminal">{`omni update`}</CodeBlock>
        <p>
          Khi <Tag>omni init</Tag>, CLI hỏi 3 bước: <strong>chọn IDE</strong> → <strong>mức kỷ luật</strong> (Hardcore / Flexible) → <strong>personal rules</strong> (ngôn ngữ, coding style, forbidden patterns, custom rules).
        </p>
      </Section>

      {/* ── CORE CONCEPTS ── */}
      <Section id="karpathy-mindset" title="Karpathy Mindset">
        <p>4 nguyên tắc cốt lõi được inject vào mọi AI agent:</p>
        <div className="space-y-3 my-4">
          {[
            { title: "Think Before Coding", desc: "Không assume. Không che giấu confusion. Surface tradeoffs. Hỏi trước khi code." },
            { title: "Simplicity First", desc: "Minimum code giải quyết vấn đề. Không feature thừa, không abstraction cho single-use code." },
            { title: "Surgical Changes", desc: "Chỉ sửa những gì cần thiết. Không 'improve' code xung quanh. Match existing style." },
            { title: "Goal-Driven Execution", desc: "Biến task mơ hồ thành mục tiêu có thể verify. Loop cho đến khi đạt success criteria." },
          ].map((p) => (
            <div key={p.title} className="rounded-lg border border-outline bg-highlight p-4">
              <h4 className="font-semibold text-content">{p.title}</h4>
              <p className="mt-1 text-sm text-content-muted">{p.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="socratic-gate" title="Socratic Gate">
        <p>
          Bắt buộc AI hỏi tối thiểu 3 câu trước khi viết code — <strong>không ngoại lệ</strong> (trừ bug fix có reproduction steps rõ ràng).
        </p>
        <p>3 câu hỏi bắt buộc:</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>(a) Scope confirmation</strong> — xác nhận phạm vi feature</li>
          <li><strong>(b) Edge case</strong> — tình huống user chưa nghĩ tới</li>
          <li><strong>(c) Implementation tradeoff</strong> — 2-3 lựa chọn kỹ thuật với ưu/nhược</li>
        </ul>
        <p>
          Số câu hỏi tự động theo độ phức tạp: <strong>1 câu</strong> cho Small, <strong>3 câu</strong> cho Medium, <strong>5 câu</strong> cho Large.
        </p>
      </Section>

      <Section id="skills-system" title="Skills System">
        <p>Omni-Coder Kit tích hợp hệ sinh thái <strong>skills.sh</strong> với 3 cơ chế:</p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-outline bg-highlight p-4">
            <h4 className="font-semibold text-content">Universal Skills</h4>
            <p className="mt-1 text-sm text-content-muted">
              6 skills mặc định cho mọi dự án: find-skills, karpathy-guidelines, systematic-debugging,
              test-driven-development, requesting-code-review, using-git-worktrees. Cài bằng <Tag>omni auto-equip</Tag>.
            </p>
          </div>
          <div className="rounded-lg border border-outline bg-highlight p-4">
            <h4 className="font-semibold text-content">Dynamic Skill Discovery</h4>
            <p className="mt-1 text-sm text-content-muted">
              <Tag>om:equip</Tag> dùng find-skills search skills.sh theo tech stack — không giới hạn framework.
              IDE-aware: chỉ cài skill cho IDE/CLI đã chọn.
            </p>
          </div>
          <div className="rounded-lg border border-outline bg-highlight p-4">
            <h4 className="font-semibold text-content">Conditional Skill Groups</h4>
            <p className="mt-1 text-sm text-content-muted">
              3 nhóm skill động theo Project DNA: Best Practices (luôn có), UI/UX (khi hasUI),
              Backend/Infrastructure (khi backendComplexity &gt;= moderate).
            </p>
          </div>
        </div>
        <p>Cài skill từ skills.sh:</p>
        <CodeBlock title="Terminal">{`omni equip vercel-labs/agent-skills`}</CodeBlock>
      </Section>

      <Section id="dna-detection" title="Project DNA Detection">
        <p>
          Khi chạy <Tag>om:brainstorm</Tag>, AI tự động phân tích prompt để xác định DNA của dự án:
        </p>
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
        <p>
          DNA ảnh hưởng đến toàn bộ quy trình: <Tag>om:brainstorm</Tag> thêm backend complexity probe,
          <Tag>om:equip</Tag> kích hoạt nhóm Backend/Infrastructure skill, <Tag>om:plan</Tag> sắp xếp tasks theo backend-aware ordering.
        </p>
      </Section>

      <Section id="knowledge-base" title="Knowledge Base (om:learn)">
        <p>
          Hệ thống tự tích lũy bài học — AI không lặp lại cùng một lỗi. Sau mỗi <Tag>om:fix</Tag> thành công,
          <Tag>om:learn</Tag> tự động ghi lại vào <Tag>.omni/knowledge-base.md</Tag>.
        </p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-accent-border bg-orange-400/5 p-4">
            <h4 className="font-semibold text-accent">Cách hoạt động</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-content-muted">
              <li><Tag>om:fix</Tag> sửa bug thành công → <Tag>om:learn</Tag> auto-trigger</li>
              <li>Ghi lại: file đã thay đổi, root cause, fix pattern, ngày</li>
              <li><Tag>om:cook</Tag> trước khi sửa file → check knowledge base cho bài học liên quan</li>
              <li>Tối đa 20 entries — auto-prune entry cũ nhất khi vượt limit</li>
            </ul>
          </div>
        </div>
        <CodeBlock title=".omni/knowledge-base.md">{`## Lesson #1 — 2025-01-15
**Files:** src/api/auth.ts, src/middleware/jwt.ts
**Root cause:** JWT token refresh race condition khi 2 request đồng thời
**Fix pattern:** Mutex lock trên refresh endpoint, queue pending requests
**Tags:** auth, jwt, race-condition`}</CodeBlock>
      </Section>

      <Section id="shared-context-brief" title="Shared Context Brief">
        <p>
          Khi <Tag>om:cook</Tag> spawn nhiều sub-agents chạy <strong>parallel</strong> (worktree isolation),
          mỗi agent cần hiểu context dự án. Thay vì mỗi agent re-read toàn bộ design-spec.md + shared files,
          main session extract <strong>~500 tokens</strong> thành một context brief gọn.
        </p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-4">
            <h4 className="font-semibold text-accent-alt">Brief bao gồm</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-content-muted">
              <li><strong>Project summary</strong> — goal, tech stack, DNA profile</li>
              <li><strong>Architecture decisions</strong> — patterns đã chọn, constraints</li>
              <li><strong>Shared interfaces</strong> — types/contracts các agents cần biết</li>
              <li><strong>Knowledge base entries</strong> — bài học liên quan đến files agent sẽ sửa</li>
            </ul>
          </div>
        </div>
        <p>
          <strong>Lợi ích:</strong> Tiết kiệm token (mỗi agent không cần đọc full context),
          đồng bộ quyết định kiến trúc giữa các agents, giảm conflict khi merge.
        </p>
      </Section>

      <Section id="content-source" title="Content Source-of-Truth">
        <p>
          Khi <Tag>om:brainstorm</Tag> phát hiện dự án có UI (<strong>hasUI = true</strong>),
          tự động sinh file <Tag>content-source.md</Tag> — nguồn sự thật duy nhất cho mọi nội dung hiển thị trên UI.
        </p>
        <CodeBlock title="content-source.md">{`## Facts
- Tên sản phẩm: "Omni-Coder Kit" (không viết tắt)
- Giá: Miễn phí mãi mãi (ISC License)
- IDE hỗ trợ: 8+ (liệt kê đầy đủ)

## Tone
- Chuyên nghiệp nhưng thân thiện
- Kỹ thuật chính xác, không marketing quá mức

## Forbidden Content
- Không claim "AI thay thế developer"
- Không so sánh trực tiếp với competitor`}</CodeBlock>
        <p>
          <strong>P5 Content Validation</strong> trong <Tag>om:check</Tag> đối chiếu mọi text trên UI
          với content-source.md — đảm bảo nội dung chính xác, nhất quán, không sai lệch.
        </p>
      </Section>

      <Section id="workflows-overview" title="8 SDLC Workflows">
        <Table
          headers={["Lệnh", "Agent", "Mô tả"]}
          rows={[
            ["om:brainstorm", "Architect", "Phỏng vấn adaptive + DNA detection → design-spec.md"],
            ["om:equip", "Skill Manager", "Search skills.sh + conditional groups theo DNA"],
            ["om:plan", "PM", "Spec → micro-tasks todo.md, @skill:name tags"],
            ["om:cook", "Coder", "Thực thi tasks, Shared Context Brief, quality gate mỗi 1/3"],
            ["om:check", "QA Tester", "Validation pipeline P0–P5 → test-report.md"],
            ["om:fix", "Debugger", "Reproduce → root cause → surgical fix → verify"],
            ["om:learn", "Knowledge", "Auto-record lessons sau fix → knowledge-base.md"],
            ["om:doc", "Writer", "Đọc code thực tế → sinh README + API docs"],
          ]}
        />
        <p>
          Quality pipeline bắt buộc: <strong>3 quality cycles</strong> — cook → check → fix loop tự động sau mỗi 1/3 tasks.
        </p>
      </Section>

      {/* ── GUIDE ── */}
      <Section id="om-brainstorm" title="om:brainstorm — Phân tích yêu cầu">
        <p>
          AI đóng vai <strong>Chief Solutions Architect</strong>. Quy trình 2 phase:
        </p>
        <p><strong>Phase 1: Extract, Classify &amp; Interview</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li>Parse prompt → extract 6 slots: goal, users, features, constraints, edge_cases, ui_hint</li>
          <li>Classify complexity: Small (≤2 features) / Medium (3-5) / Large (6+)</li>
          <li>Adaptive questions — chỉ hỏi slots thiếu, prefer multiple-choice</li>
          <li>Auto-detect Project DNA (hasUI, hasBackend, backendComplexity)</li>
        </ul>
        <p><strong>Phase 2: Generate design-spec.md</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li>Summary table: Goal, Users, Tech Stack, UI Style, Constraints</li>
          <li>Tagged requirements: [func], [auth], [data], [api], [nfr], [edge], [ui]</li>
          <li>Large projects: auto-decompose thành sub-projects</li>
        </ul>
        <CodeBlock title="Ví dụ">{`> om:brainstorm Làm app quản lý task cho team

📋 Tôi đã hiểu:
   • Mục tiêu: App quản lý task
   • DNA: [hasUI] + [Backend simple]

❓ Ai sẽ dùng sản phẩm này?
   VD: "admin (CRUD tasks), member (tạo task, comment)"`}</CodeBlock>
      </Section>

      <Section id="om-equip" title="om:equip — Cài đặt Skills">
        <p>
          AI đóng vai <strong>Skill Manager</strong>. Phân tích tech stack từ design-spec.md,
          search skills.sh và cài skills phù hợp.
        </p>
        <p><strong>3 nhóm skill động:</strong></p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>Best Practices</strong> — luôn có (karpathy, debugging, TDD, code review)</li>
          <li><strong>UI/UX</strong> — khi hasUI (React best practices, Tailwind, Framer Motion...)</li>
          <li><strong>Backend/Infrastructure</strong> — khi backendComplexity &gt;= moderate (DB, API, Docker...)</li>
        </ul>
        <CodeBlock title="Terminal">{`# Cài universal skills
omni auto-equip

# Cài thêm skill pack
omni equip vercel-labs/agent-skills

# Trong chat AI
> om:equip`}</CodeBlock>
      </Section>

      <Section id="om-plan" title="om:plan — Lập kế hoạch">
        <p>
          AI đóng vai <strong>Senior PM</strong>. Transform design-spec.md → micro-tasks trong todo.md.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li>Mỗi task atomic, estimable (&lt;20 phút), ordered theo dependency</li>
          <li>Skill-tagged: <Tag>@skill:skill-name</Tag> cho từng task</li>
          <li>Backend-aware ordering: DB → Cache → Queue → API → Realtime → UI</li>
          <li>Infra tasks tách vào <Tag>setup.sh</Tag>, code tasks vào todo.md</li>
        </ul>
        <CodeBlock title="todo.md">{`## 1. Database
- [ ] Tạo migration users table @skill:supabase-postgres
- [ ] Seed data mẫu @skill:supabase-postgres

## 2. Frontend
- [ ] Tạo trang login @skill:vercel-react-best-practices
- [ ] Form validation @skill:vercel-react-best-practices`}</CodeBlock>
      </Section>

      <Section id="om-cook" title="om:cook — Thực thi Code">
        <p>
          AI đóng vai <strong>Senior Developer</strong>. Thực thi từng task từ todo.md.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>Dependency graph:</strong> phân tích tasks, nhóm thành batches chạy parallel</li>
          <li><strong>Shared Context Brief:</strong> extract ~500 tokens từ design-spec.md + shared files, gửi cho mỗi parallel agent thay vì re-read toàn bộ</li>
          <li><strong>Knowledge Base lookup:</strong> trước khi sửa file, check .omni/knowledge-base.md cho bài học liên quan</li>
          <li><strong>Auto-continue:</strong> tự động chạy task tiếp, chỉ dừng khi lỗi nghiêm trọng</li>
          <li><strong>Surgical context:</strong> file &gt;200 dòng → grep trước, chỉ đọc ±20 dòng xung quanh</li>
          <li><strong>Dev server preflight:</strong> tự khởi động dev server trước task đầu tiên (nếu có UI)</li>
        </ul>
        <p><strong>Quality gate tự động:</strong></p>
        <CodeBlock>{`om:cook (1/3 tasks)
  → om:check
    → [om:fix ↔ om:check loop, tối đa 3 lần]
    → om:learn (ghi bài học nếu có fix)
  → om:cook (1/3 tasks)
    → om:check → [fix loop] → om:learn
  → om:cook (1/3 tasks)
    → om:check → [fix loop] → om:learn
  → om:doc`}</CodeBlock>
      </Section>

      <Section id="om-check" title="om:check — QA Testing">
        <p>
          AI đóng vai <strong>QA Tester</strong>. Chạy validation pipeline theo thứ tự:
        </p>
        <Table
          headers={["Priority", "Check", "Blocking?"]}
          rows={[
            ["P0", "Security: dependency audit, secrets leak, eval/innerHTML, SQL injection", "Yes"],
            ["P1", "Lint & Types: ESLint/Biome, TypeScript", "Yes"],
            ["P2", "Build: compile/bundle project", "Yes"],
            ["P3", "Tests: vitest/jest/pytest", "Yes"],
            ["P4", "Bundle: unused deps, bundle size", "No (advisory)"],
            ["P5", "Content: đối chiếu UI text với content-source.md", "Yes (khi hasUI)"],
          ]}
        />
        <p>
          P0–P3 fail → dừng ngay, auto-trigger <Tag>om:fix</Tag>. P5 Content Validation blocking khi dự án có UI —
          đảm bảo mọi text trên UI khớp với content-source.md. Loop tối đa 3 lần/cycle.
        </p>
      </Section>

      <Section id="om-fix" title="om:fix — Debug & Fix">
        <p>
          AI đóng vai <strong>Debugger</strong>. Quy trình có cấu trúc:
        </p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>Reproduce</strong> — tái tạo lỗi với test case cụ thể</li>
          <li><strong>Root cause</strong> — trace ngược từ symptom → nguyên nhân gốc</li>
          <li><strong>Surgical fix</strong> — sửa đúng chỗ, không shotgun-fix</li>
          <li><strong>Verify</strong> — chạy test ban đầu lại để confirm fix</li>
        </ul>
        <p>
          Không bao giờ &quot;thử đại&quot; — AI phải hiểu root cause trước khi sửa.
        </p>
      </Section>

      <Section id="om-learn" title="om:learn — Knowledge Base">
        <p>
          AI đóng vai <strong>Knowledge Engineer</strong>. Tự động ghi lại bài học sau mỗi fix thành công.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li><strong>Auto-trigger:</strong> chạy tự động sau <Tag>om:fix</Tag> thành công trong quality cycle</li>
          <li><strong>Manual:</strong> gõ <Tag>om:learn</Tag> để ghi bài học thủ công</li>
          <li><strong>Storage:</strong> <Tag>.omni/knowledge-base.md</Tag> — max 20 entries, FIFO prune</li>
          <li><strong>Lookup:</strong> <Tag>om:cook</Tag> check knowledge base trước khi sửa mỗi file</li>
        </ul>
        <p><strong>Entry format:</strong></p>
        <CodeBlock>{`## Lesson #N — YYYY-MM-DD
**Files:** danh sách files đã fix
**Root cause:** mô tả nguyên nhân gốc
**Fix pattern:** cách fix đã áp dụng
**Tags:** keywords để lookup sau này`}</CodeBlock>
        <p>
          Knowledge base giúp AI không lặp lại lỗi cũ — đặc biệt hiệu quả cho dự án dài hạn
          với nhiều quality cycles.
        </p>
      </Section>

      <Section id="om-doc" title="om:doc — Documentation">
        <p>
          AI đóng vai <strong>Technical Writer</strong>. Đọc code thực tế rồi sinh documentation.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li>README.md — tổng quan, cài đặt, sử dụng, API reference</li>
          <li>API docs — từ route definitions thực tế trong code</li>
          <li>Inline comments — chỉ khi logic phức tạp, non-obvious</li>
        </ul>
      </Section>

      <Section id="ide-cli-guides" title="IDE & CLI Guides">
        <p>
          Hướng dẫn chi tiết cho từng IDE/CLI được hỗ trợ. Chọn công cụ bạn đang dùng:
        </p>
        <div className="space-y-3 my-4">

          <DocsAccordion title="Claude Code" icon={<ClaudeIcon />} defaultOpen>
            <p><strong>File config:</strong> <Tag>CLAUDE.md</Tag></p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Claude Code"
omni auto-equip        # Cài 6 universal skills`}</CodeBlock>
            <p><strong>Advanced setup (Overlay):</strong></p>
            <p>Khi được hỏi &quot;Cài đặt Claude Code nâng cao?&quot;, chọn <strong>Yes</strong> để kích hoạt:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>Slash commands</strong> — 8 lệnh <Tag>/om:*</Tag> gõ trực tiếp trong Claude Code (auto-complete), bao gồm <Tag>/om:learn</Tag> mới</li>
              <li><strong>Permissions allowlist</strong> — <Tag>.claude/settings.json</Tag> cho phép build/test/git, deny rm -rf, force push</li>
              <li><strong>Quality gate hooks</strong> — tự động nhắc kiểm tra chất lượng khi file thay đổi</li>
              <li><strong>Shared Context Brief</strong> — extract ~500 tokens từ design-spec.md, gửi cho parallel sub-agents thay vì re-read toàn bộ</li>
              <li><strong>Knowledge Base integration</strong> — <Tag>om:cook</Tag> tự check .omni/knowledge-base.md trước khi sửa file</li>
            </ul>
            <p><strong>Sử dụng workflows:</strong></p>
            <CodeBlock title="Trong Claude Code">{`# Dùng slash commands (auto-complete)
/om:brainstorm Làm app quản lý task

# Hoặc gõ trực tiếp trong chat
> om:plan
> om:cook
> om:learn    # Ghi bài học thủ công`}</CodeBlock>
            <p><strong>Gợi ý khởi động:</strong></p>
            <CodeBlock title="Terminal">{`claude                               # Chế độ bình thường
claude --dangerously-skip-permissions  # Bỏ qua permission prompts (cẩn thận)`}</CodeBlock>
          </DocsAccordion>

          <DocsAccordion title="Gemini CLI" icon={<GeminiIcon />}>
            <p><strong>File config:</strong> <Tag>GEMINI.md</Tag></p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Gemini CLI"
omni auto-equip        # Cài 6 universal skills`}</CodeBlock>
            <p><strong>Advanced setup (Overlay):</strong></p>
            <p>Gemini overlay tạo workflows tối ưu riêng cho Gemini tools:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>requirement-analysis.md</strong> — Phỏng vấn Socratic với DNA detection</li>
              <li><strong>task-planning.md</strong> — Backend-aware ordering</li>
              <li><strong>coder-execution.md</strong> — Surgical context rule cho Gemini tools</li>
              <li><strong>qa-testing.md</strong> — QA pipeline</li>
            </ul>
            <p><strong>Sử dụng workflows:</strong></p>
            <CodeBlock title="Trong Gemini CLI">{`> om:brainstorm Làm landing page cho SaaS
> om:equip
> om:plan
> om:cook`}</CodeBlock>
            <p><strong>Gợi ý khởi động:</strong></p>
            <CodeBlock title="Terminal">{`gemini          # Chế độ bình thường
gemini --yolo   # Tự động approve mọi thao tác (cẩn thận)`}</CodeBlock>
          </DocsAccordion>

          <DocsAccordion title="Codex CLI (OpenAI)" icon={<OpenAIIcon />}>
            <p><strong>File config:</strong> <Tag>AGENTS.md</Tag> + <Tag>.codex/</Tag> (optional)</p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Codex CLI"
omni auto-equip        # Cài 6 universal skills`}</CodeBlock>
            <p><strong>Advanced setup (Overlay):</strong></p>
            <p>Codex overlay tạo thêm config profiles và hooks:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>.codex/config.toml</strong> — 3 profiles: <Tag>omni_safe</Tag> (sandbox strict), <Tag>omni_yolo</Tag> (auto-approve), <Tag>omni_review</Tag> (review mode)</li>
              <li><strong>.codex/hooks.json</strong> — Hook reminders cho file changes và quality-cycle checks</li>
            </ul>
            <p><strong>Sử dụng workflows:</strong></p>
            <CodeBlock title="Trong Codex CLI">{`> om:brainstorm
> om:plan
> om:cook
> om:check`}</CodeBlock>
            <p><strong>Gợi ý khởi động:</strong></p>
            <CodeBlock title="Terminal">{`codex                          # Chế độ mặc định
codex --profile omni_safe      # Sandbox strict
codex --profile omni_yolo      # Auto-approve (cẩn thận)
codex exec "Read AGENTS.md, then run >om:check"  # One-shot command`}</CodeBlock>
          </DocsAccordion>

          <DocsAccordion title="Cursor" icon={<CursorIcon />}>
            <p><strong>File config:</strong> <Tag>.cursorrules</Tag> + <Tag>.cursor/rules/*.mdc</Tag> (v2.3.0+)</p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Cursor"
omni auto-equip        # Cài 6 universal skills`}</CodeBlock>
            <p><strong>Cách hoạt động:</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Omni-Coder Kit sinh file <Tag>.cursorrules</Tag> chứa Karpathy mindset + Socratic Gate + SDLC workflows</li>
              <li>Cursor tự động đọc file này khi mở dự án</li>
              <li>Workflows <Tag>.omni/workflows/</Tag> được lazy-load khi AI cần</li>
            </ul>
            <p><strong>Cursor Overlay (v2.3.0+):</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>7 MDC rules</strong> trong <Tag>.cursor/rules/</Tag> — modular, Cursor Rules format</li>
              <li><strong>DNA-based MCP config</strong> — auto-detect tools cần thiết</li>
              <li><strong>YOLO guardrails</strong> — 3 tiers (safe/balanced/yolo) cho Agent Mode</li>
              <li><strong>Agent Mode protocol</strong> — structured execution cho Cursor Agent</li>
            </ul>
            <p><strong>Sử dụng workflows:</strong></p>
            <CodeBlock title="Trong Cursor Chat">{`> om:brainstorm Thêm feature authentication
> om:plan
> om:cook`}</CodeBlock>
            <p><strong>Gợi ý:</strong> Mở Cursor trong thư mục dự án sau khi <Tag>omni init</Tag>. Cursor sẽ tự đọc <Tag>.cursorrules</Tag> và <Tag>.cursor/rules/*.mdc</Tag>.</p>
          </DocsAccordion>

          <DocsAccordion title="Windsurf" icon={<WindsurfIcon />}>
            <p><strong>File config:</strong> <Tag>.windsurfrules</Tag></p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Windsurf"
omni auto-equip        # Cài 6 universal skills`}</CodeBlock>
            <p><strong>Cách hoạt động:</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Sinh file <Tag>.windsurfrules</Tag> chứa toàn bộ core rules + command registry</li>
              <li>Windsurf tự động đọc file này khi mở dự án</li>
              <li>Workflows lazy-loaded từ <Tag>.omni/workflows/</Tag></li>
            </ul>
            <p><strong>Sử dụng workflows:</strong></p>
            <CodeBlock title="Trong Windsurf Chat">{`> om:brainstorm
> om:plan
> om:cook`}</CodeBlock>
            <p><strong>Gợi ý:</strong> Mở Windsurf trong thư mục dự án. Cascade AI sẽ tuân thủ rules từ <Tag>.windsurfrules</Tag>.</p>
          </DocsAccordion>

          <DocsAccordion title="Antigravity" icon={<AntigravityIcon />}>
            <p><strong>File config:</strong> <Tag>AGENTS.md</Tag></p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Antigravity"
omni auto-equip        # Cài 6 universal skills`}</CodeBlock>
            <p><strong>Cách hoạt động:</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Sinh <Tag>AGENTS.md</Tag> với core rules + command registry</li>
              <li>Dùng <Tag>.agents/</Tag> directory cho rules, skills, workflows</li>
              <li>Tương thích với antigravity-kit ecosystem</li>
            </ul>
            <p><strong>Sử dụng workflows:</strong></p>
            <CodeBlock title="Trong Antigravity">{`> om:brainstorm Xây dựng API backend
> om:equip
> om:plan
> om:cook`}</CodeBlock>
          </DocsAccordion>

          <DocsAccordion title="Cross-tool" icon={<CrossToolIcon />}>
            <p><strong>File config:</strong> <Tag>AGENTS.md</Tag></p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Cross-tool"
omni auto-equip`}</CodeBlock>
            <p><strong>Khi nào dùng:</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Dự án có nhiều người dùng các AI tool khác nhau</li>
              <li><Tag>AGENTS.md</Tag> là format tool-agnostic, được hầu hết AI agents đọc</li>
              <li>Phù hợp cho team có cả Codex, Antigravity, và các tool khác</li>
            </ul>
          </DocsAccordion>

          <DocsAccordion title="Generic" icon={<GenericIcon />}>
            <p><strong>File config:</strong> <Tag>SYSTEM_PROMPT.md</Tag></p>
            <p><strong>Khởi tạo:</strong></p>
            <CodeBlock title="Terminal">{`cd your-project
omni init              # Chọn "Generic"
omni auto-equip`}</CodeBlock>
            <p><strong>Khi nào dùng:</strong></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>AI tool chưa có trong danh sách hỗ trợ chính thức</li>
              <li>Copy nội dung <Tag>SYSTEM_PROMPT.md</Tag> vào system prompt của tool bạn dùng</li>
              <li>Mọi workflow <Tag>&gt;om:*</Tag> vẫn hoạt động — AI đọc từ <Tag>.omni/workflows/</Tag></li>
            </ul>
          </DocsAccordion>

        </div>
      </Section>

      {/* ── CLI REFERENCE ── */}
      <Section id="cli-commands" title="CLI Commands">
        <Table
          headers={["Lệnh", "Mô tả"]}
          rows={[
            ["omni init", "Khởi tạo DNA và workflow cho dự án mới"],
            ["omni equip <source>", "Tải kỹ năng ngoài từ skills.sh"],
            ["omni auto-equip", "Cài 6 universal skills mặc định"],
            ["omni rules [action]", "Quản lý personal rules (view/edit/sync/reset)"],
            ["omni status", "Xem trạng thái skills đã cài đặt"],
            ["omni commands", "Hiển thị danh sách lệnh >om:"],
            ["omni update", "Kiểm tra và cập nhật lên phiên bản mới"],
          ]}
        />
        <p><strong>omni rules</strong> — quản lý personal rules:</p>
        <CodeBlock title="Terminal">{`omni rules          # Menu tương tác
omni rules view     # Xem rules hiện tại
omni rules edit     # Sửa rules
omni rules sync     # Sync vào config file
omni rules reset    # Xóa rules`}</CodeBlock>
      </Section>

      <Section id="ide-support" title="IDE Support">
        <Table
          headers={["IDE/Tool", "File tạo ra", "Gợi ý khởi động"]}
          rows={[
            ["Claude Code / OpenCode", "CLAUDE.md", "claude"],
            ["Gemini CLI", "GEMINI.md", "gemini --yolo"],
            ["Codex CLI", "AGENTS.md + .codex/", "codex --profile omni_safe"],
            ["Claude Code + Codex (dual)", "CLAUDE.md + AGENTS.md", "Cả 2 lệnh trên"],
            ["Antigravity", "AGENTS.md", "antigravity"],
            ["Cursor", ".cursorrules", "Mở Cursor trong thư mục dự án"],
            ["Windsurf", ".windsurfrules", "Mở Windsurf trong thư mục dự án"],
            ["Cross-tool", "AGENTS.md", "Tool-agnostic"],
            ["Generic", "SYSTEM_PROMPT.md", "—"],
          ]}
        />
      </Section>

    </div>
  );
}
