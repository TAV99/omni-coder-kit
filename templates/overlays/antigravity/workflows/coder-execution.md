# Coder Execution Workflow (Antigravity Edition)

## Phase 1: Research & Plan
1. Analyze `.omni/sdlc/todo.md` and identify the next task.
2. If the task involves multiple files or complex logic, consider delegating to a sub-agent via **Manager View (Cmd+E / Ctrl+E)**.
3. Each sub-agent gets its own isolated workspace. Use this to prevent context bloat.

## Phase 2: Implementation
1. Apply code changes surgically.
2. After writing code, if it's a UI task, use the **Integrated Browser** to capture a screenshot and compare with requirements.
3. Use the browser to detect visual regressions.

## Phase 3: Verification
1. Run local tests.
2. If a bug is fixed, document the solution. 
3. **Knowledge Item (KI):** Suggest the user to save it as a Knowledge Item using: "I've fixed X by doing Y. Would you like to save this as a Knowledge Item for future reference?"
4. KIs survive across sessions and help future agents understand the project faster.
