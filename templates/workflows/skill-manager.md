## AGENT SKILLS MANAGER (SKILLS.SH DYNAMIC EQUIP)
You are authorized to use the `skills.sh` ecosystem to extend your capabilities. Universal skills are auto-installed, project-specific skills are discovered dynamically via `find-skills`.

### Step 1: Ensure Universal Skills
Run `omni auto-equip -y` to install the 6 universal skills (find-skills, karpathy-guidelines, systematic-debugging, test-driven-development, requesting-code-review, using-git-worktrees). These apply to ALL projects regardless of tech stack.

**Sandbox fallback:** If the shell command fails (sandbox/network restriction — common in Gemini CLI `--yolo`, Codex sandbox), do NOT retry. Instead output the commands for the user to run manually in their terminal:
```
⚠️ Không cài được skills (sandbox/mạng). Chạy trong terminal:
   omni auto-equip
```
Then skip to Step 2 — proceed with whatever skills are already installed. Do NOT block the workflow.

### Step 2: Analyze Tech Stack, DNA & Assess Project Scale
Read `.omni/sdlc/design-spec.md` and extract:
- **Technologies:** Languages, frameworks, databases, services, patterns
- **DNA Profile:** Read the `Backend DNA` row from Summary table. Extract `hasUI`, `backendComplexity`, and detected patterns. If the spec lacks a Backend DNA row (older format), infer from tech stack and requirements.
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

### Step 4: Conditional Mandatory Skill Groups + Filtering

Mandatory groups are determined by project DNA — not all groups apply to every project:

| Group | Mandatory when | Search keywords |
|-------|---------------|----------------|
| **Best Practices** | Always | `best-practices`, `conventions`, `optimization`, `patterns`, `performance` + tech-stack-specific keywords |
| **UI/UX/Frontend** | `hasUI = true` | `design`, `ui`, `ux`, `frontend`, `css`, `component`, `accessibility` |
| **Backend/Infrastructure** | `backendComplexity ≥ moderate` | AI generates from detected patterns in DNA (see below) |

**Backend keyword generation:** When `backendComplexity ≥ moderate`, AI reads detected patterns from DNA and maps to search keywords. This is open-ended — no hardcoded keyword list. Examples:
- DNA detects `realtime` → search: `websocket`, `realtime`, `socket`, `pubsub`
- DNA detects `scheduler` → search: `cron`, `scheduler`, `background-jobs`, `worker`
- DNA detects `caching` → search: `redis`, `caching`, `cache`

**Priority order:** Fill mandatory groups first → then add project-specific skills with remaining slots.

**Filtering (3 steps):**

**Filter 1 — Relevance:**
- Compare skill name + description against the tech stack in `.omni/sdlc/design-spec.md`
- REJECT skills for a different framework/language than the project uses
- REJECT skills that duplicate the 6 universal skills already installed
- REJECT skills with no clear description

**Filter 2 — Dedup by domain:**
- If multiple skills cover the same domain (e.g., 3 React skills), keep ONLY the one with **highest downloads + rating**
- Tiebreaker when popularity is equal: prefer trusted sources (vercel-labs, supabase, anthropics, obra, shadcn, wshobson)

**Filter 3 — Allocate by group then cap:**
1. From filtered results, assign each skill to active mandatory groups or `Project-specific`
2. Ensure at least 1 skill per active mandatory group (if available on skills.sh for the project's stack)
3. Fill remaining slots with project-specific skills, sorted by downloads (descending)
4. Total cap by project scale from Step 2 (3 / 5 / 8)

### Step 5: Present Proposal (Accept All + Exclude)
```
🔍 Dựa trên .omni/sdlc/design-spec.md (quy mô: [small/medium/large], DNA: [profile], max [N] skills):

⚡ Best Practices:
  1. ✅ skill-name — Mô tả (⬇ 12.3k ⭐ 4.8) [source]

🎨 UI/UX/Frontend:                    ← chỉ hiện nếu hasUI
  2. ✅ skill-name — Mô tả (⬇ 8.1k ⭐ 4.7) [source]

🔧 Backend/Infrastructure:            ← chỉ hiện nếu backendComplexity ≥ moderate
  3. ✅ skill-name — Mô tả (⬇ 5.2k ⭐ 4.5) [source]

🛠️ Project-specific:
  4. ✅ skill-name — Mô tả (⬇ 5.2k ⭐ 4.5) [source]

Cài tất cả? Gõ số để loại bỏ (vd: "loại 3"), hoặc gõ y để cài hết.
```

- **"y" / "cài hết"** → install all
- **"loại 2, 3"** → exclude specific skills, install the rest
- **"không"** → skip all

### Step 6: Install
- **Universal skills:** `omni auto-equip -y`
- **Discovered skills:** `omni equip <source> --name <short-name>` for each approved skill
- **Antigravity:** Dùng `AGENTS.md` + `.agents/` directory — cài skills bình thường qua `omni equip`

**Sandbox fallback:** If ANY install command fails due to sandbox/network restrictions, collect ALL failed commands and output them as a single copy-paste block:
```
⚠️ Không cài được [N] skills (sandbox/mạng). Chạy trong terminal:

omni auto-equip
omni equip <source1> --name <name1>
omni equip <source2> --name <name2>
```
Mark the skills as "pending install" and continue to Step 7 with whatever skills ARE available.

### Step 7: Context Absorption
After installation, read the newly added skill files (in `.agents/skills/` or `.claude/skills/`) and apply those rules to the current session immediately.

### Manual Override
The user can always install individual skills via `omni equip <owner/repo>` or search manually with find-skills.
