## VALIDATION SCRIPTS (AUTOMATED QUALITY GATES)
When running `>om:check`, BEFORE feature verification, execute this pipeline in strict priority order. If a blocking check fails, STOP — do not run lower checks.

```
P0: Security ──→ P1: Lint & Types ──→ P2: Build ──→ P3: Tests ──→ P4: Bundle (advisory)
```

### P0: Security Scan (BLOCKING)
```bash
npm audit --audit-level=moderate 2>/dev/null || yarn audit 2>/dev/null
grep -rn --include="*.{js,ts,jsx,tsx,py,json,yaml,yml}" \
  -E "(PRIVATE_KEY|SECRET|PASSWORD|API_KEY|TOKEN|Bearer)\s*[:=]\s*['\"][^'\"]{8,}" src/ lib/ app/ 2>/dev/null
find . -maxdepth 3 -name ".env*" | while read f; do git ls-files --error-unmatch "$f" 2>/dev/null && echo "COMMITTED: $f"; done
grep -rn --include="*.{js,ts,jsx,tsx}" -E "(eval\(|innerHTML\s*=|dangerouslySetInnerHTML|exec\()" src/ lib/ app/ 2>/dev/null
grep -rn --include="*.{js,ts}" -E "(\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|WHERE)|query\s*\(\s*['\`].*\+)" src/ lib/ app/ 2>/dev/null
```
Check: dependency vulns, leaked secrets, committed .env, dangerous patterns (eval/innerHTML), SQL injection risk.
If critical/high vuln or leaked secret found → STOP, report, advise immediate rotation.

### P1: Lint & Typecheck (BLOCKING)
```bash
npx eslint . --max-warnings=0 2>/dev/null || npx biome check . 2>/dev/null
npx tsc --noEmit 2>/dev/null
ruff check . 2>/dev/null || python -m flake8 . 2>/dev/null  # Python projects
```
If lint errors > 0 or type errors > 0 → STOP.

### P2: Build (BLOCKING)
```bash
npm run build 2>/dev/null || npx next build 2>/dev/null || npx vite build 2>/dev/null
```
If build fails → STOP.

### P3: Automated Tests (BLOCKING)
```bash
npx vitest run 2>/dev/null || npx jest --passWithNoTests 2>/dev/null || npm test 2>/dev/null || npx pytest 2>/dev/null
```
If any test fails → STOP.

### P4: Bundle Analysis (ADVISORY — frontend only)
```bash
npx depcheck 2>/dev/null | head -20
```
Informational only. Report unused deps and large bundles.

### Rules
- Adapt commands to actual toolchain (detect from package.json / pyproject.toml).
- Tool not installed → mark SKIP, not FAIL. Do NOT install without asking.
- If P0-P3 fails: mark test-report as FAIL, recommend `>om:fix`, skip feature verification.