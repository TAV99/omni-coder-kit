#!/usr/bin/env bash
# =============================================================================
# omni-coder-kit — Harness E2E acceptance test
#
# Chạy TỪ THƯ MỤC GỐC repo omni-coder-kit, trong môi trường Claude Code CLI
# (có `claude` trên PATH) hoặc có ANTHROPIC_API_KEY cho provider claude-sdk.
#
#   bash scripts/e2e-acceptance.sh
#
# Gồm 2 lớp kiểm thử:
#   [DET]  Deterministic — KHÔNG cần LLM (provider dry-run + gate chạy lệnh thật).
#          Luôn chạy. Chứng minh: state machine, loop, gate P0–P5, BLOCKED, resume.
#   [LLM]  Real provider — cần `claude` CLI (host-cli) hoặc API key (claude-sdk).
#          Tự SKIP nếu không có. Chứng minh: loop lái LLM thật, stats token > 0.
#
# Exit 0 nếu mọi assert (đã chạy) PASS; 1 nếu có FAIL. Các mục SKIP không tính FAIL.
# KHÔNG bao giờ push/deploy. Mọi thứ chạy trong thư mục tạm, dọn khi xong.
# =============================================================================
set -uo pipefail

# --- locate omni ------------------------------------------------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMNI="node $REPO/bin/omni.js"
WORK="$(mktemp -d)/demo-app"
PASS=0; FAIL=0; SKIP=0

c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
ok()   { PASS=$((PASS+1)); echo "  $(c '32' '✓ PASS') $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  $(c '31' '✗ FAIL') $1"; [ -n "${2:-}" ] && echo "        ↳ $2"; }
skip() { SKIP=$((SKIP+1)); echo "  $(c '33' '– SKIP') $1"; }
sect() { echo; echo "$(c '36;1' "── $1 ──")"; }

# assert: mô tả | điều kiện (0=pass) | chi tiết khi fail
assert() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1" "${3:-}"; fi; }

cleanup() { rm -rf "$(dirname "$WORK")"; }
trap cleanup EXIT

# =============================================================================
sect "0. PREFLIGHT"
echo "  repo : $REPO"
echo "  work : $WORK"
PROVIDER=""
if command -v claude >/dev/null 2>&1; then
    PROVIDER="host-cli"; echo "  LLM  : $(c '32' 'host-cli') (claude CLI tìm thấy)"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    PROVIDER="claude-sdk"; echo "  LLM  : $(c '32' 'claude-sdk') (ANTHROPIC_API_KEY có)"
else
    echo "  LLM  : $(c '33' 'KHÔNG có') — phần [LLM] sẽ SKIP. Đặt claude CLI hoặc ANTHROPIC_API_KEY để chạy thật."
fi

# --- scaffold a real demo repo ----------------------------------------------
mkdir -p "$WORK/src" "$WORK/test" "$WORK/.omni/sdlc"
cd "$WORK"
git init -q; git config user.email t@e2e; git config user.name e2e
cat > package.json <<'JSON'
{ "name":"demo-app","version":"0.1.0","scripts":{
  "lint":"node --check src/index.js && echo lint-ok",
  "build":"echo build-ok",
  "test":"node --test"
}}
JSON
cat > src/index.js <<'JS'
function add(a,b){return a+b;}
module.exports={add};
JS
cat > test/basic.test.js <<'JS'
const {test}=require('node:test'); const assert=require('node:assert');
const {add}=require('../src/index.js');
test('add',()=>{assert.strictEqual(add(2,3),5);});
JS
echo "# CLAUDE.md (demo)" > CLAUDE.md
# seed manifest (bỏ qua omni init tương tác)
cat > .omni/manifest.json <<'JSON'
{ "version":"e2e","configFile":"CLAUDE.md","ide":"claudecode","skills":{"external":[]} }
JSON
cat > .omni/sdlc/design-spec.md <<'MD'
# demo-app — design-spec
Type: open-source Node util. Tính năng: hàm add(a,b) + test.
MD
# content-source: forbidden dùng TỪ KHÓA (đúng cơ chế P5 literal-match)
cat > .omni/sdlc/content-source.md <<'MD'
## Facts
- Project name: demo-app
- Project type: open-source
## Forbidden Content
- pricing
- premium tier
MD
printf '## 1. Core\n- [x] add()\n- [x] export\n## 2. Test\n- [x] unit\n- [x] ci\n' > .omni/sdlc/todo.md
git add -A; git commit -qm "demo init"

# =============================================================================
sect "1. [DET] Gate P0–P5 chạy lệnh THẬT (happy path)"
GATE_OUT="$($OMNI gate 2>&1)"
echo "$GATE_OUT" | grep -qE "P1 lint.*PASS"  && ok "P1 lint PASS"  || bad "P1 lint" "$GATE_OUT"
echo "$GATE_OUT" | grep -qE "P2 build.*PASS" && ok "P2 build PASS" || bad "P2 build"
echo "$GATE_OUT" | grep -qE "P3 test.*PASS"  && ok "P3 test PASS"  || bad "P3 test"
echo "$GATE_OUT" | grep -qE "Gate PASS"      && ok "Gate tổng PASS (exit 0)" || bad "Gate tổng"

# =============================================================================
sect "2. [DET] P0 security BẮT secret + .env committed → block"
echo 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEsecretKEY1234567890ab' > .env
SEC_OUT="$($OMNI gate --only P0 2>&1)"
echo "$SEC_OUT" | grep -qE "P0 security.*FAIL" && ok "P0 phát hiện secret → FAIL" || bad "P0 security" "$SEC_OUT"
rm -f .env

# =============================================================================
sect "3. [DET] Loop dry-run: vòng đời → PAUSE trước SHIP"
RUN_OUT="$($OMNI run --provider dry-run 2>&1)"
echo "$RUN_OUT" | grep -qE "PLAN → COOK|COOK → CHECK"  && ok "đi qua COOK/CHECK" || bad "loop transitions" "$RUN_OUT"
echo "$RUN_OUT" | grep -qE "PAUSE|⏸"                   && ok "PAUSE trước SHIP (không tự ship)" || bad "pause-before-ship"
test -f .omni/run/state.json                           && ok "ghi .omni/run/state.json" || bad "state.json"
test -f .omni/run/events.ndjson                        && ok "ghi events.ndjson"        || bad "events.ndjson"

sect "4. [DET] Resume + --yes-ship → DONE"
RES_OUT="$($OMNI run --resume --provider dry-run --yes-ship 2>&1)"
echo "$RES_OUT" | grep -qE "SHIP → DONE|DONE"          && ok "resume → SHIP → DONE" || bad "resume/ship" "$RES_OUT"
# không có lệnh push nào được phát ra
! git log --oneline | grep -qiE "deploy|publish"       && ok "không auto-deploy/publish" || bad "auto-deploy?"

sect "5. [DET] observability: omni stats + trace"
$OMNI stats 2>&1 | grep -qiE "TOTAL"                   && ok "omni stats có bảng tổng" || bad "stats"
$OMNI trace --limit 5 2>&1 | grep -qiE "transition|gate|done" && ok "omni trace đọc event" || bad "trace"

# =============================================================================
sect "6. [DET] Failure path: test fail → FIX×3 → BLOCKED"
WORK2="$(dirname "$WORK")/demo-fail"; cp -r "$WORK" "$WORK2"; cd "$WORK2"
rm -rf .omni/run
cat > test/basic.test.js <<'JS'
const {test}=require('node:test'); const assert=require('node:assert');
test('fail-on-purpose',()=>{assert.strictEqual(1,2);});
JS
FAIL_OUT="$($OMNI run --provider dry-run --max-iterations 30 2>&1)"
echo "$FAIL_OUT" | grep -qE "gate FAIL|FAIL P3"         && ok "gate bắt P3 fail" || bad "gate fail detect" "$FAIL_OUT"
echo "$FAIL_OUT" | grep -qE "BLOCKED|⛔"                && ok "escalate BLOCKED sau khi cạn fix" || bad "BLOCKED escalation"
cd "$WORK"

# =============================================================================
sect "7. [LLM] Loop lái LLM THẬT (provider: ${PROVIDER:-none})"
if [ -z "$PROVIDER" ]; then
    skip "host-cli/claude-sdk — không có claude CLI / API key"
    skip "stats token > 0 (cần LLM)"
else
    rm -rf .omni/run
    # todo có 1 task CHƯA làm để agent thực sự cook; bound chi phí.
    printf '## 1. Core\n- [x] add()\n- [ ] thêm hàm sub(a,b) + test\n' > .omni/sdlc/todo.md
    echo "  ▶ chạy: omni run --provider $PROVIDER --from COOK --max-iterations 12 ${MAXCOST:+--max-cost $MAXCOST}"
    LLM_OUT="$(timeout 600 $OMNI run --provider "$PROVIDER" --from COOK --max-iterations 12 ${MAXCOST:+--max-cost $MAXCOST} 2>&1)"
    echo "$LLM_OUT" | tail -6 | sed 's/^/      /'
    # không crash + tiến được state
    echo "$LLM_OUT" | grep -qiE "→|PAUSE|DONE|BLOCKED"  && ok "loop chạy, tiến state (không crash)" || bad "LLM loop" "$(echo "$LLM_OUT" | tail -3)"
    # bằng chứng gọi LLM thật: stats token > 0 HOẶC trace có provider exit
    STATS="$($OMNI stats 2>&1)"
    if echo "$STATS" | grep -qE "TOTAL +[0-9]+ +[1-9][0-9]*"; then
        ok "stats: token > 0 (LLM thật đã chạy)"
    elif $OMNI trace 2>&1 | grep -qE "provider .*exit"; then
        ok "trace: có provider step (LLM được gọi)"; skip "token>0 (provider không trả usage?)"
    else
        bad "không thấy bằng chứng gọi LLM" "$STATS"
    fi
    # vẫn pause trước ship (an toàn) trừ khi --yes-ship
    echo "$LLM_OUT" | grep -qiE "auto-deploy|git push" && bad "phát hiện auto-deploy!" || ok "không auto-deploy"
fi

# =============================================================================
sect "KẾT QUẢ"
echo "  $(c '32' "PASS=$PASS")  $(c '31' "FAIL=$FAIL")  $(c '33' "SKIP=$SKIP")"
[ "$FAIL" -eq 0 ] && { echo "  $(c '32;1' '✅ E2E ACCEPTANCE: ĐẠT')"; exit 0; } \
                  || { echo "  $(c '31;1' '❌ E2E ACCEPTANCE: CÓ LỖI')"; exit 1; }
