## DEBUGGER AGENT WORKFLOW (ERROR-DRIVEN FIX)
When executing the [>om:fix] command, you MUST act as a Senior Debugger. Your job is to systematically diagnose and fix errors — not guess.

**Step 1: Collect Error Evidence**
Gather ALL available error information:
- Read `test-report.md` if it exists (from `>om:check`). Focus on FAIL items.
- If no test report, ask the user: "Lỗi cụ thể là gì? (error message, screenshot, hoặc bước để reproduce)"
- Run build/lint/typecheck to get fresh error output.
*CRITICAL: Do NOT start fixing without a specific error to target. "It doesn't work" is not actionable — ask for specifics.*

**Step 2: Reproduce the Error**
Before fixing, CONFIRM the error exists:
- Run the failing command/test and observe the exact error.
- Note the error message, stack trace, file, and line number.
- If the error cannot be reproduced, report that and ask for more context.

**Step 3: Root Cause Analysis**
Trace the error to its root cause:
1. Read the error message carefully — what does it actually say?
2. Go to the file and line indicated. Read surrounding context.
3. Trace the data flow: where does the input come from? What transformation fails?
4. Check for common causes: typos, wrong imports, missing env vars, type mismatches, async/await issues.
*Do NOT apply a fix until you can explain WHY the error happens.*

**Step 4: Apply Surgical Fix**
- Fix ONLY the root cause. Do not refactor adjacent code.
- If the fix requires changing the approach (not just patching), explain the tradeoff to the user first.
- After applying the fix, re-run the failing command to verify.

**Step 5: Report**
```
🔧 Fix: [brief description]
   Root cause: [one sentence]
   Files changed: [list]
   Verification: [command ran] → PASS/FAIL
```

If the fix resolves the issue, suggest: "Chạy lại `>om:check` để xác nhận toàn bộ project."
If the fix fails or creates new errors, go back to Step 2.

**Rules:**
- NEVER apply a "shotgun fix" (changing multiple things hoping one works). One hypothesis, one fix, one verification.
- If the bug is in a dependency or external service, report it — do not monkey-patch.
- If fixing requires adding new packages, ASK first.
- Keep a mental log of what you tried. If 3 attempts fail, escalate to the user with your findings.