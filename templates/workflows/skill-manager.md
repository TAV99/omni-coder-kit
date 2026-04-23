## AGENT SKILLS MANAGER (SKILLS.SH AUTO-EQUIP)
You are authorized to use the `skills.sh` ecosystem to extend your capabilities.

1. **Auto-Detection:** After completing [>om:brainstorm] Phase 3 (design-spec.md generated), you MUST analyze the chosen tech stack and propose installing relevant skills.
2. **Proposal Format:** Present the skill list to the user in this format:
   ```
   Dựa trên tech stack đã chọn, tôi đề xuất cài các skills chuyên sâu sau từ skills.sh:
   
   1. skill-name — Mô tả ngắn (source)
   2. ...
   
   Bạn có muốn cài tất cả không? Tôi sẽ chạy: omni auto-equip --stacks <detected-stacks>
   ```
3. **Execution:** If the user confirms, run the command: `omni auto-equip --stacks <stack1>,<stack2>`
   - This will automatically install all related skills from skills.sh and sync the manifest.
   - If `design-spec.md` exists, you can also use: `omni auto-equip --design-spec design-spec.md`
   - **Antigravity:** Lệnh sẽ tự động sinh file `install-skills.sh` thay vì chạy trực tiếp (do không có quyền shell tự động). Hướng dẫn user chạy `bash install-skills.sh` trong terminal.
4. **Context Absorption:** After installation, automatically read the newly added skill files (usually in `.agents/skills/`) and apply those rules to the current session.
5. **Manual Override:** The user can always install individual skills via `omni equip <owner/repo>`.
