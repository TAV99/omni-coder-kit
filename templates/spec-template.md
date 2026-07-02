# Omni-Coder Spec Template (AI-Optimized)
> Version: 1.0.0 | Compatible with Omni-Coder Kit Phase-4 (Acceptance Loop)
> Filename Suggestion: `customer-spec.md` or `omni-spec.md`

Use this template to design software specifications that AI coding agents (specifically `omni run`) can parse with 100% precision. This template aligns with the Omni SDLC states: `BRAINSTORM` ➔ `INTAKE` ➔ `PLAN` ➔ `COOK` ➔ `CHECK` ➔ `ACCEPTANCE`.

---

## 1. Metadata Block (AI Slots & DNA Profile)
*This section matches the slots extracted during `>om:brainstorm` (Phase 1) and guides DNA classification.*

| Field | Value | Description / Instructions |
| :--- | :--- | :--- |
| **Goal** | [Describe business objective in 1 sentence] | e.g., "A web application that allows freelancers to manage client tasks and track invoice statuses." |
| **Target Users** | [List roles/personas and short description] | e.g., "Freelancer (full CRUD), Client (read-only invoices, task view)." |
| **Tech Stack** | [Frontend], [Backend], [Database], [Hosting] | e.g., "React (Vite), Express.js, PostgreSQL (Prisma), Vercel + Render." |
| **UI Style** | [minimalist-ui \| industrial-brutalist-ui \| high-end-visual-design \| design-taste-frontend] | Select exactly one to map to Omni's local visual skills. Use `design-taste-frontend` as the default modern SaaS style. |
| **Project DNA** | hasUI = [true/false]<br>hasBackend = [true/false]<br>hasAPI = [true/false]<br>backendComplexity = [simple \| moderate \| complex] | **simple**: basic CRUD, single DB.<br>**moderate**: auth, file upload, third-party integrations.<br>**complex**: queues, websockets, cache, cron jobs. |
| **Constraints** | [List any budget, time, or technical restrictions] | e.g., "Zero-cost database, deployment on free tiers only." |

---

## 2. Content Source Seed (P5 Content Gate)
*This section is used to populate `.omni/sdlc/content-source.md`. It prevents the AI from generating placeholder content and satisfies the P5 quality gate.*

### Verified Facts
*List exact facts that MUST be present in the final product. Minimum 3 facts.*
- **Project Name**: `[Exact casing of the project name]`
- **Project Type**: `[e.g., open-source under MIT / commercial SaaS / internal tool]`
- **Fact 1**: `[e.g., Author is John Doe, GitHub link is https://github.com/.../...]`
- **Fact 2**: `[e.g., Free tier supports up to 3 projects and 500MB storage]`
- **Fact 3**: `[e.g., Integrates with Resend API for email notifications]`

### Forbidden Content
*List phrases, terms, or elements that MUST NOT appear.*
- No placeholder text (e.g., no `Lorem Ipsum`, no `TBD`, no `TODO` in user-facing UI).
- No fake pricing tiers or testimonials (if open-source or internal).
- No stock photos (use icons, SVG illustrations, or code screenshots instead).

---

## 3. Atomic Requirements Checklist
*This is the core contract. The intake engine (`>om:intake`) parses this section directly into `.omni/sdlc/requirements.md`. Keep each requirement atomic (one statement per bullet) and specify how the AI can verify it.*

### Core & Business Logic
- [ ] R1 | **User Auth**: Users can register and sign in using email and password. | test: npm test -- tests/auth.test.js
- [ ] R2 | **Task Creation**: Freelancer can create a task with title, description, and due date. | test: npm test -- tests/tasks.test.js::create
- [ ] R3 | **Task Listing**: Client can view tasks assigned to them but cannot edit or delete. | test: agent

### API Contract (Endpoint Verification)
- [ ] R4 | **POST /api/auth/register** accepts `{ email, password }` and returns `201 Created` with JWT. | test: curl -X POST -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"password123"}' http://localhost:3000/api/auth/register
- [ ] R5 | **GET /api/tasks** requires Bearer token, returns `200 OK` with JSON array of tasks. | test: curl -i -H "Authorization: Bearer mock_token" http://localhost:3000/api/tasks

### Data Validation & Schema
- [ ] R6 | **Task Schema**: The `Task` table must contain fields `id` (UUID), `title` (VARCHAR(100), not null), `description` (TEXT), `due_date` (TIMESTAMP), `status` (ENUM: 'pending', 'in_progress', 'completed'), and `user_id` (foreign key). | test: npx prisma db push --force-reset && npm test -- tests/schema.test.js

### Edge Cases
- [ ] R7 | **Duplicate Email**: Registering with an already registered email must return `400 Bad Request` with message "Email already exists". | test: npm test -- tests/auth.test.js::duplicate
- [ ] R8 | **File Size Limit**: Uploading a task attachment greater than 5MB must return `413 Payload Too Large`. | test: curl -F "file=@large_file.zip" -w "%{http_code}" -o /dev/null http://localhost:3000/api/tasks/1/upload | grep 413

### UI & UX (Visual Design)
*Must map to the selected UI Style in Section 1.*
- [ ] R9 | **Theme & Layout**: Dashboard UI is built using `minimalist-ui` style with a light/dark mode switch, using a flat bento grid and avoiding heavy shadows. | test: agent
- [ ] R10 | **Responsive Navigation**: Sidebar navigation collapses into a bottom navigation bar on screens under 768px. | test: agent

### Infrastructure & Operations
*Required when project DNA is moderate or complex.*
- [ ] R11 | **Email Worker**: Email notification is queued via BullMQ and processed asynchronously. | test: npm test -- tests/worker.test.js
- [ ] R12 | **Cache Strategy**: Task list endpoint is cached in Redis for 60 seconds. | test: npm test -- tests/cache.test.js

---

## 4. Detailed Technical Blueprints (Optional, for complex projects)
*Provides deep technical specifications that the AI references during the `COOK` state to avoid architectural alignment drift.*

### Data Schema
```sql
-- Example Schema definition (SQL or Prisma Schema)
-- Ensure precise field names, types, relationships, constraints, and indexes.

Table User {
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email     VARCHAR(255) UNIQUE NOT NULL,
  password  VARCHAR(255) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
}

Table Task {
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(100) NOT NULL,
  description TEXT,
  due_date    TIMESTAMP,
  status      TASK_STATUS DEFAULT 'pending',
  user_id     UUID REFERENCES User(id) ON DELETE CASCADE
}
```

### Infrastructure Specifications
- **Queue System**:
  - Technology: BullMQ + Redis.
  - Failure policy: Retry 3 times, exponential backoff (1000ms base delay), then move to Dead Letter Queue (DLQ) named `task-email-dlq`.
- **Cache Configuration**:
  - Cache store: Redis.
  - TTL (Time-To-Live): 60 seconds for list endpoints; 1 hour for static site settings.
- **WebSocket Protocol**:
  - Endpoint: `ws://localhost:3000/realtime`
  - Auth: JWT token sent in query param `?token=...` or handshaked.
  - Heartbeat: ping/pong interval every 25 seconds.
