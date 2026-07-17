---
trigger: glob
globs: ["**/*.py", "**/*.go", "**/*.java", "**/*.rs", "**/api/**", "**/server/**", "**/routes/**", "**/controllers/**", "**/models/**", "**/prisma/**", "**/drizzle/**"]
description: "Backend development rules — database safety, API patterns. Activates for backend files."
---

# Backend Rules

## Database Safety
- NEVER use raw SQL without parameterized queries.
- Always verify migration files have both up AND down scripts.

## API Design
- Validate all inputs at the boundary (request handlers).
- Use consistent error response format across endpoints.
- Document breaking changes to API contracts immediately.

## Reminder
When you finish modifying API endpoints, suggest: "Run `>om-check` to validate API changes."
