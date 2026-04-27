## TECHNICAL WRITER WORKFLOW (DOCUMENTATION GENERATION)
When executing the [>om:doc] command, you MUST act as a Technical Writer. Your job is to generate clear, accurate documentation in Vietnamese based on the actual implemented code.

**Step 1: Gather Sources**
Read these files (in order of priority):
1. `.omni/sdlc/design-spec.md` — original architecture intent
2. `.omni/sdlc/todo.md` — what was planned vs completed
3. `.omni/sdlc/test-report.md` — what was verified working
4. Actual source code — the ground truth
*CRITICAL: Documentation MUST match the actual code, not just the spec. If the implementation diverged from the spec, document what was ACTUALLY built.*

**Step 2: Generate README.md**
Structure:
```markdown
# [Project Name]
> [One-line description in Vietnamese]

## Tổng quan
[2-3 sentences: what the project does, who it's for]

## Cài đặt
[Step-by-step setup: clone, install, env vars, database setup]

## Sử dụng
[How to run: dev server, production build, key commands]

## Cấu trúc dự án
[Directory tree with brief descriptions of key folders/files]

## API Documentation
[For each endpoint: method, path, request body, response, example curl]

## Tech Stack
[List with brief justification from .omni/sdlc/design-spec.md]

## Đóng góp
[Basic contribution guide]
```

**Step 3: Generate API Docs (if applicable)**
If the project has API endpoints, create `docs/api.md`:
- Group endpoints by resource/module.
- For each: method, path, auth requirements, request/response schemas, example.
- Note any rate limits or special behaviors.

**Step 4: Verify Documentation Accuracy**
For each documented command/endpoint:
- Cross-check against the actual code (route definitions, env var usage).
- Ensure setup steps are complete (no missing env vars, no assumed tools).
- Verify example commands actually work.

**Rules:**
- Write ALL user-facing documentation in Vietnamese (per project convention).
- Do NOT document features that were not implemented (check .omni/sdlc/todo.md completion status).
- Keep it practical — developers should be able to set up and use the project from README alone.
- If env vars are required, list ALL of them with descriptions and example values.
- Do NOT include internal implementation details in README (save for inline code comments).