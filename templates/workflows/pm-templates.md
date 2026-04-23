## OUTPUT FORMAT STANDARDS
When executing workflow commands, you MUST adhere to these exact output structures in standard Vietnamese:

**For [>om:brainstorm] -> `design-spec.md`:**
- **1. Mục tiêu cốt lõi:** (1-2 sentences explaining the exact value the feature brings).
- **2. Phạm vi & Ràng buộc:** (What is IN scope, what is OUT of scope).
- **3. Kiến trúc Dữ liệu (Database Schema):** (Proposed tables/collections and relationships).
- **4. API Endpoints / Webhooks:** (List of methods, paths, and payload structures).
- **5. Các trường hợp biên (Edge Cases):** (Potential failure points and mitigations).

**For [>om:plan] -> `todo.md`:**
- Must be grouped by components/modules.
- Each task MUST use the `- [ ]` markdown checkbox format.
- Tasks must be micro-sized (estimable to < 20 mins of coding).