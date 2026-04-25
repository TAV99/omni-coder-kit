"use client";

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="my-4 rounded-lg border border-white/10 bg-[#111112] overflow-hidden">
      {title && (
        <div className="border-b border-white/10 px-4 py-2 text-xs text-gray-500">{title}</div>
      )}
      <pre className="overflow-x-auto p-4 text-sm text-gray-300 font-mono leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 pb-12 border-b border-white/5 last:border-0">
      <h2 className="text-2xl font-bold tracking-tight mb-4">
        <span className="gradient-text">{title}</span>
      </h2>
      <div className="prose-docs space-y-4 text-gray-300 leading-relaxed">{children}</div>
    </section>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/10 bg-white/5">
            {headers.map((h) => (
              <th key={h} className="px-4 py-2.5 text-left font-semibold text-gray-200">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 text-gray-400">
                  <code className="text-xs bg-white/5 px-1.5 py-0.5 rounded">{cell}</code>
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
  return <code className="text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded text-sm">{children}</code>;
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
            { num: "7", label: "SDLC Workflows" },
            { num: "6", label: "Universal Skills" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
              <div className="text-3xl font-bold gradient-text">{s.num}</div>
              <div className="mt-1 text-sm text-gray-400">{s.label}</div>
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
            <div key={p.title} className="rounded-lg border border-white/10 bg-white/5 p-4">
              <h4 className="font-semibold text-white">{p.title}</h4>
              <p className="mt-1 text-sm text-gray-400">{p.desc}</p>
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
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h4 className="font-semibold text-white">Universal Skills</h4>
            <p className="mt-1 text-sm text-gray-400">
              6 skills mặc định cho mọi dự án: find-skills, karpathy-guidelines, systematic-debugging,
              test-driven-development, requesting-code-review, using-git-worktrees. Cài bằng <Tag>omni auto-equip</Tag>.
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h4 className="font-semibold text-white">Dynamic Skill Discovery</h4>
            <p className="mt-1 text-sm text-gray-400">
              <Tag>om:equip</Tag> dùng find-skills search skills.sh theo tech stack — không giới hạn framework.
              IDE-aware: chỉ cài skill cho IDE/CLI đã chọn.
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h4 className="font-semibold text-white">Conditional Skill Groups</h4>
            <p className="mt-1 text-sm text-gray-400">
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

      <Section id="workflows-overview" title="7 SDLC Workflows">
        <Table
          headers={["Lệnh", "Agent", "Mô tả"]}
          rows={[
            ["om:brainstorm", "Architect", "Phỏng vấn adaptive + DNA detection → design-spec.md"],
            ["om:equip", "Skill Manager", "Search skills.sh + conditional groups theo DNA"],
            ["om:plan", "PM", "Spec → micro-tasks todo.md, @skill:name tags"],
            ["om:cook", "Coder", "Thực thi tasks, auto-continue, quality gate mỗi 1/3"],
            ["om:check", "QA Tester", "Validation pipeline P0–P3 → test-report.md"],
            ["om:fix", "Debugger", "Reproduce → root cause → surgical fix → verify"],
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
          <li><strong>Auto-continue:</strong> tự động chạy task tiếp, chỉ dừng khi lỗi nghiêm trọng</li>
          <li><strong>Surgical context:</strong> file &gt;200 dòng → grep trước, chỉ đọc ±20 dòng xung quanh</li>
          <li><strong>Dev server preflight:</strong> tự khởi động dev server trước task đầu tiên (nếu có UI)</li>
        </ul>
        <p><strong>Quality gate tự động:</strong></p>
        <CodeBlock>{`om:cook (1/3 tasks)
  → om:check
    → [om:fix ↔ om:check loop, tối đa 3 lần]
  → om:cook (1/3 tasks)
    → om:check → [fix loop]
  → om:cook (1/3 tasks)
    → om:check → [fix loop]
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
          ]}
        />
        <p>
          P0–P3 fail → dừng ngay, auto-trigger <Tag>om:fix</Tag>. Loop cho đến khi pass (tối đa 3 lần/cycle).
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

      <Section id="overlays" title="Overlays (Advanced Setup)">
        <p>
          Khi <Tag>omni init</Tag> cho Claude Code, Codex CLI hoặc Gemini CLI, bạn có thể bật <strong>advanced setup</strong>:
        </p>
        <div className="space-y-3 my-4">
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h4 className="font-semibold text-white">Claude Code Overlay</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-gray-400">
              <li>Slash commands <Tag>/om:*</Tag> — 7 lệnh tương ứng với &gt;om:*</li>
              <li>Permissions allowlist — cho phép build/test/git, deny rm -rf, force push</li>
              <li>Quality gate hooks — tự nhắc kiểm tra chất lượng khi file thay đổi</li>
            </ul>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h4 className="font-semibold text-white">Codex CLI Overlay</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-gray-400">
              <li><Tag>.codex/config.toml</Tag> — profiles: omni_safe, omni_yolo, omni_review</li>
              <li><Tag>.codex/hooks.json</Tag> — hook reminders cho file changes</li>
            </ul>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <h4 className="font-semibold text-white">Gemini CLI Overlay</h4>
            <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-gray-400">
              <li>Workflows tối ưu riêng cho Gemini tools</li>
              <li>GEMINI.md config với DNA detection + surgical context</li>
            </ul>
          </div>
        </div>
      </Section>
    </div>
  );
}
