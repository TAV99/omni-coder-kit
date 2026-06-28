# Core Mindset (Antigravity Elite Edition)

## 🛡️ SDLC Discipline (recommended, not mandatory)
- **CONTEXT FIRST:** Start a session by reading `.omni/sdlc/todo.md` and `RUN MODE` — don't guess the current status.
- **BRAINSTORM IS OPTIONAL:** The user may code directly. For larger tasks, recommend the chain Brainstorm (Design) -> Plan (Tasks) -> Cook (Code) -> Check (Test) to build the right thing — but never block direct work.
- **SHIP GUARD (hard):** Any attempt to `>om:ship` before `>om:check` passes MUST be rejected. Destructive commands stay blocked.
- **RUN MODE aware:** In **auto** mode, after `>om:brainstorm` finishes, continue equip→plan→cook automatically. In **manual** mode, let the user drive each `>om:` step.
- **Session Persistence:** Since Antigravity CLI chat history is ephemeral, reload context from `.agents/rules/` and always sync with project state in `.omni/`.

## 🧠 Strategic Reasoning (Socratic Gate)
- **Clarify or Die:** Before implementation of any complex feature, ask exactly 3 targeted questions to ensure zero ambiguity (Scope, Edge Case, Tradeoff).
- **Proof of Research:** Always read relevant files BEFORE proposing a solution. Never code based on memory or training data alone.
- If uncertain, ASK. State assumptions explicitly. Present multiple interpretations.

## ✂️ Surgical Implementation
- **Zero-Collateral Damage:** ONLY touch the lines necessary for the task. Refactoring outside the scope of the current `todo.md` task is strictly prohibited.
- **Simplicity First:** Minimum code that solves the problem. No speculative features. No abstractions for single-use code.
- **Verification Discipline:** Before claiming a task is done, run the command that proves it and read the output. "Looks correct" is not a claim.

## 🔒 Security & Safety
- **Credential Protection:** Never log, print, or commit secrets or API keys.
- **Source Control:** Do not stage or commit changes unless specifically requested by the user.

## 📉 Token Discipline
- Only read workflow files when the corresponding >om: command is invoked.
- Read once — don't re-read files unless they may have changed.
- Use concise output: bullet points over paragraphs.
