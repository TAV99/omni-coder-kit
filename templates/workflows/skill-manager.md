## AGENT SKILLS MANAGER (SKILLS.SH DYNAMIC EQUIP)
You are authorized to use the `skills.sh` ecosystem to extend your capabilities. Use a **two-tier strategy**: built-in registry for known stacks + dynamic discovery via `find-skills` for everything else.

### Step 1: Analyze Tech Stack
Read `design-spec.md` and extract ALL technologies:
- Languages: TypeScript, Python, Go, Rust, etc.
- Frameworks: Next.js, Hono, Django, Express, SvelteKit, etc.
- Databases: PostgreSQL, MongoDB, Redis, SQLite, etc.
- Services: Supabase, Vercel, AWS, Stripe, Firebase, etc.
- Patterns: API, CLI tool, bot, automation, real-time, monorepo, etc.

### Step 2: Tier 1 — Built-in Registry
Run `omni auto-equip --design-spec design-spec.md` to install skills matching the hardcoded registry (react-next, hono-pg, automation-bot, payment-gateway, _common). This handles known stacks instantly.

### Step 3: Tier 2 — Dynamic Discovery (find-skills)
Check if `find-skills` is installed (look in `.agents/skills/` or `.claude/skills/`). If available:

1. For each technology from Step 1 that is NOT already covered by Tier 1, use find-skills to search skills.sh.
2. Evaluate each discovered skill against the **Selection Criteria** below.
3. Collect qualified skills into a proposal list.

If `find-skills` is NOT installed, skip this step and inform the user:
```
⚠️ find-skills chưa được cài. Chỉ dùng registry mặc định.
   Cài thêm: npx skills add vercel-labs/skills --skill find-skills -y
```

### Step 4: Present Combined Proposal
```
Dựa trên tech stack trong design-spec.md:

📦 Registry (đã cài / sẽ cài qua auto-equip):
1. skill-name — Mô tả (source)
...

🔍 Tìm thêm từ skills.sh (find-skills):
N. skill-name — Mô tả (source) — Lý do đề xuất
...

Tổng: X skills. Cài tất cả? (y/n)
```

### Step 5: Install
- **Registry skills:** `omni auto-equip --stacks <stack1>,<stack2> -y`
- **Discovered skills:** `omni equip <source> --name <short-name>` for each
- **Antigravity:** Commands sẽ sinh `install-skills.sh` — hướng dẫn user chạy `bash install-skills.sh`

### Step 6: Context Absorption
After installation, read the newly added skill files (in `.agents/skills/` or `.claude/skills/`) and apply those rules to the current session immediately.

### Selection Criteria
When evaluating whether to recommend a skill:
| Criteria | Rule |
|----------|------|
| **Relevance** | Skill MUST directly relate to a technology in the project's stack |
| **Non-overlap** | SKIP if an installed skill already covers the same domain |
| **Trusted source** | Prefer skills from: vercel-labs, supabase, anthropics, obra, shadcn, wshobson |
| **Specificity** | Prefer targeted skills (e.g., `supabase-postgres-best-practices`) over vague generic ones |
| **Maintained** | Prefer skills with recent activity — avoid abandoned repos |

**Do NOT recommend** skills that:
- Duplicate rules already in the config file (Karpathy mindset, anti-hallucination, etc.)
- Are for a different framework/language than what the project uses
- Have no clear description or purpose
- Come from unknown/unverified sources without user confirmation

### Manual Override
The user can always install individual skills via `omni equip <owner/repo>` or search manually with find-skills.
