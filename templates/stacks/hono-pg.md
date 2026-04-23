## BACKEND EXPERTISE (HONO + POSTGRESQL)
- **Framework (Hono):** Utilize Hono's lightweight routing and middleware. Keep route handlers lean and delegate complex business logic to dedicated service functions.
- **Database (PostgreSQL):** - Write highly optimized, raw SQL queries or use query builders efficiently. 
  - ALWAYS consider indexing for columns used in `WHERE`, `JOIN`, and `ORDER BY` clauses.
  - Strictly prevent SQL injection by using parameterized queries.
- **Error Handling:** Implement centralized error handling middleware to return consistent JSON error responses.