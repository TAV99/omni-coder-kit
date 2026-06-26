**Doubt Gate — Adversarial Verification (high-stakes only):**
A confident answer is not a correct one. For NON-TRIVIAL decisions, cross-examine the result *before* it stands — while course-correction is still cheap. Adapted from `doubt-driven-development` (addyosmani/agent-skills, MIT).

Trigger ONLY when a decision is non-trivial — at least one is true:
- Introduces/modifies branching logic, or crosses a module/service boundary
- Asserts a property the compiler can't verify (thread-safety, idempotence, ordering, invariants)
- Correctness depends on context a future reader can't see
- Blast radius is irreversible (prod deploy, data migration, public API/schema change, security logic)

SKIP for trivial work (rename/format/file-move, one-line obvious changes, reading code, following an unambiguous instruction, or when the user asked for speed). If you doubt every keystroke you ship nothing.

Doubt cycle (copy the checklist):
- [ ] **CLAIM** — state the decision + why it matters, in 2–3 lines. Can't state it compactly? It's a vibe, not a decision.
- [ ] **EXTRACT** — isolate the smallest reviewable unit: the diff/function + the contract it must satisfy. Strip your reasoning — hand over conclusions and you get back validation of conclusions.
- [ ] **DOUBT** — review the ARTIFACT + CONTRACT *adversarially* ("find what is wrong; assume the author is overconfident; look for unstated assumptions, unhandled edge cases, hidden shared state, contract violations, broken conventions"). Do NOT pass the CLAIM — it biases toward agreement.
- [ ] **RECONCILE** — classify every finding against the artifact text: real bug / false positive / needs-evidence. Fix real ones before proceeding.
- [ ] **STOP** — exit when findings are trivial, after 3 cycles, or on user override.

**Orchestration constraint (depth = 1 — see docs/orchestration-patterns.md).** A persona MUST NOT spawn another persona to do the DOUBT step (anti-pattern: persona-calls-persona).
- Inside a persona (CODER/QA): use the **degraded self-review fallback** — re-pose ARTIFACT + CONTRACT as a *fresh self-prompt* with a hard separator from your prior reasoning, then walk the cycle. Flag the result as self-review, not fresh-context.
- For irreversible / security-sensitive decisions: do NOT rely on self-review — **escalate to the user** ("⚠️ Quyết định high-stakes: [claim]. Đề xuất review fresh-context hoặc cross-model trước khi tiếp tục.").
- Only the **harness/main session** (`omni run`) may spawn a real fresh-context reviewer (Pattern 3 fan-out, merged at the main loop).

Reject rationalizations: "Tôi tự tin" → confidence ≠ evidence. "Quá hiển nhiên" → then CLAIM takes 30 seconds. "Review sau" → review after = debug in prod.
