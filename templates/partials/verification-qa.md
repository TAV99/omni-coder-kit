**Verification Discipline — Evidence Before Claims:**

| Claim | Requires | NOT Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | "Linter passed" |
| Bug fixed | Reproduce original symptom: fixed | "Code changed, assumed fixed" |

Reject rationalizations: "Should work now" → RUN it. "I'm confident" → confidence ≠ evidence. "Partial check is enough" → partial proves nothing.