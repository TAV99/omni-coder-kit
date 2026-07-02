#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# fetch-bundled-skills.sh
# Tải toàn bộ SKILL.md mới nhất từ GitHub → templates/bundled-skills/
# Chạy trước mỗi release: ./scripts/fetch-bundled-skills.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUNDLED_DIR="${PROJECT_DIR}/templates/bundled-skills"

echo "📦 Fetching bundled skills → ${BUNDLED_DIR}"
echo ""

# Danh sách: "source|skill-name"
SKILLS=(
  "obra/superpowers|brainstorming"
  "obra/superpowers|writing-plans"
  "obra/superpowers|executing-plans"
  "obra/superpowers|systematic-debugging"
  "obra/superpowers|test-driven-development"
  "obra/superpowers|requesting-code-review"
  "obra/superpowers|receiving-code-review"
  "obra/superpowers|using-git-worktrees"
  "obra/superpowers|finishing-a-development-branch"
  "obra/superpowers|dispatching-parallel-agents"
  "obra/superpowers|subagent-driven-development"
  "obra/superpowers|verification-before-completion"
  "obra/superpowers|using-superpowers"
  "obra/superpowers|writing-skills"
  "vercel-labs/skills|find-skills"
  "multica-ai/andrej-karpathy-skills|karpathy-guidelines"
  "Leonxlnx/taste-skill/skills/gpt-tasteskill|design-taste-frontend"
  "Leonxlnx/taste-skill/skills/minimalist-skill|minimalist-ui"
  "Leonxlnx/taste-skill/skills/brutalist-skill|industrial-brutalist-ui"
  "Leonxlnx/taste-skill/skills/soft-skill|high-end-visual-design"
)

OK=0
FAIL=0

for entry in "${SKILLS[@]}"; do
  IFS='|' read -r source name <<< "$entry"
  slug="${source//\//-}"
  
  # Robust parsing of owner/repo/path
  IFS='/' read -ra PARTS <<< "$source"
  owner="${PARTS[0]}"
  repo="${PARTS[1]}"
  
  if [ "${#PARTS[@]}" -gt 2 ]; then
    subpath=""
    for ((i=2; i<${#PARTS[@]}; i++)); do
      subpath="${subpath}/${PARTS[i]}"
    done
    subpath="${subpath#/}"
    url="https://raw.githubusercontent.com/${owner}/${repo}/main/${subpath}/SKILL.md"
  else
    url="https://raw.githubusercontent.com/${owner}/${repo}/main/skills/${name}/SKILL.md"
  fi
  
  dest="${BUNDLED_DIR}/${slug}/${name}/SKILL.md"

  mkdir -p "$(dirname "$dest")"
  if curl -fsSL "$url" -o "$dest" 2>/dev/null; then
    # Validate: phải có YAML frontmatter
    if head -1 "$dest" | grep -q '^---'; then
      echo "  ✓ ${source} → ${name}"
      OK=$((OK + 1))
    else
      echo "  ✗ ${source} → ${name} — thiếu frontmatter"
      rm -f "$dest"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  ✗ ${source} → ${name} — download thất bại (URL: $url)"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "Kết quả: ${OK} thành công, ${FAIL} thất bại"
[ "$FAIL" -eq 0 ] && echo "✅ Tất cả skills đã được tải thành công!" || echo "⚠  Có ${FAIL} skill thất bại — kiểm tra URL"
exit "$FAIL"
