## AGENT SKILLS MANAGER (SKILLS.SH DYNAMIC EQUIP)
You are authorized to use the `skills.sh` ecosystem to extend your capabilities. Universal skills are auto-installed, project-specific skills are discovered dynamically via `find-skills`.

### Step 1: Ensure Universal Skills
Run `omni auto-equip -y` to install the 6 universal skills (find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees). These apply to ALL projects regardless of tech stack.

### Step 2: Analyze Tech Stack & Assess Project Scale
Read `design-spec.md` and extract:
- **Technologies:** Languages, frameworks, databases, services, patterns
- **Project scale:** Determine from design-spec complexity:

| Scale | Indicators | Max specialized skills |
|-------|-----------|----------------------|
| Small | 1-2 technologies, few endpoints, no DB | 3 |
| Medium | 3-4 technologies, DB + API + UI | 5 |
| Large | 5+ technologies, microservices, many integrations | 8 |

### Step 3: Dynamic Discovery (find-skills)
Check if `find-skills` is installed (look in `.agents/skills/` or `.claude/skills/`). If NOT installed:
```
⚠️ find-skills chưa được cài. Chạy: omni auto-equip
```

If available, search skills.sh for each technology from Step 2. For each result, collect: **name, description, downloads, rating, source**.

### Step 4: Three-Step Filtering

**Filter 1 — Relevance:**
- Compare skill name + description against the tech stack in `design-spec.md`
- REJECT skills for a different framework/language than the project uses
- REJECT skills that duplicate the 6 universal skills already installed
- REJECT skills with no clear description

**Filter 2 — Dedup by domain:**
- If multiple skills cover the same domain (e.g., 3 React skills), keep ONLY the one with **highest downloads + rating**
- Tiebreaker when popularity is equal: prefer trusted sources (vercel-labs, supabase, anthropics, obra, shadcn, wshobson)

**Filter 3 — Cap by project scale:**
- Sort remaining skills by downloads (descending)
- Keep only top N skills based on project scale from Step 2 (3 / 5 / 8)

### Step 5: Present Proposal (Accept All + Exclude)
```
🔍 Dựa trên design-spec.md (quy mô: [small/medium/large], max [N] skills):

  1. ✅ skill-name — Mô tả (⬇ 12.3k ⭐ 4.8) [source]
  2. ✅ skill-name — Mô tả (⬇ 8.1k ⭐ 4.7) [source]
  3. ✅ skill-name — Mô tả (⬇ 5.2k ⭐ 4.5) [source]

Cài tất cả? Gõ số để loại bỏ (vd: "loại 3"), hoặc Enter để cài hết.
```

- **Enter / "cài hết"** → install all (default)
- **"loại 2, 3"** → exclude specific skills, install the rest
- **"không"** → skip all

### Step 6: Install
- **Universal skills:** `omni auto-equip -y`
- **Discovered skills:** `omni equip <source> --name <short-name>` for each approved skill
- **Antigravity:** Commands sẽ sinh `install-skills.sh` — hướng dẫn user chạy `bash install-skills.sh`

### Step 7: Context Absorption
After installation, read the newly added skill files (in `.agents/skills/` or `.claude/skills/`) and apply those rules to the current session immediately.

### Manual Override
The user can always install individual skills via `omni equip <owner/repo>` or search manually with find-skills.
