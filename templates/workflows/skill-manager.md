## AGENT SKILLS MANAGER (SKILLS.SH DYNAMIC EQUIP)
You are authorized to use the `skills.sh` ecosystem to extend your capabilities. Universal skills are auto-installed, project-specific skills are discovered dynamically via `find-skills`.

### Step 1: Ensure Universal Skills
Run `omni auto-equip -y` to install the 6 universal skills (find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees). These apply to ALL projects regardless of tech stack.

### Step 2: Analyze Tech Stack
Read `design-spec.md` and extract ALL technologies:
- Languages: TypeScript, Python, Go, Rust, etc.
- Frameworks: Next.js, Hono, Django, Express, SvelteKit, etc.
- Databases: PostgreSQL, MongoDB, Redis, SQLite, etc.
- Services: Supabase, Vercel, AWS, Stripe, Firebase, etc.
- Patterns: API, CLI tool, bot, automation, real-time, monorepo, etc.

### Step 3: Dynamic Discovery (find-skills)
Check if `find-skills` is installed (look in `.agents/skills/` or `.claude/skills/`). If available:

1. For each technology from Step 2, use find-skills to search skills.sh for specialized skills.
2. Evaluate each discovered skill against the **Selection Criteria** below.
3. Collect qualified skills into a proposal list.

If `find-skills` is NOT installed, inform the user:
```
⚠️ find-skills chưa được cài. Chạy: omni auto-equip
```

### Step 4: Present Proposal
```
Dựa trên tech stack trong design-spec.md:

✅ Universal skills (đã cài / sẽ cài qua auto-equip):
   find-skills, karpathy-guidelines, systematic-debugging,
   test-driven-development, requesting-code-review, using-git-worktrees

🔍 Skill chuyên sâu tìm từ skills.sh (find-skills):
1. skill-name — Mô tả (source) — Lý do đề xuất
2. ...

Tổng: N skills mới. Cài tất cả? (y/n)
```

### Step 5: Install
- **Universal skills:** `omni auto-equip -y`
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
