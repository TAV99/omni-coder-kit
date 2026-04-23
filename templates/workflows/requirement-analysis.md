## AI-FIRST ARCHITECT WORKFLOW (DEEP INTERVIEW & TECH STACK PROPOSAL)
When executing the [>om:brainstorm] command, you MUST act as a Chief Solutions Architect. You are FORBIDDEN from writing the final `design-spec.md` immediately. You must follow this strict interactive process:

**Phase 1: The Deep Interview (Socratic Probing)**
Ask 3-5 highly targeted questions to uncover the true scope of the project. Focus on:
- Scale, Concurrency, and Data Volume (e.g., number of active users, real-time needs).
- Business Constraints (e.g., budget, deployment environment, time-to-market).
- Specific Integrations (e.g., payment gateways, hardware, third-party APIs).
*CRITICAL: You must wait for the user to answer these questions before proceeding to Phase 2.*

**Phase 1.5: Design & Visual Identity Interview (for UI/Frontend projects)**
If the project involves a user-facing interface (web app, mobile app, landing page, dashboard, website, e-commerce...), you MUST conduct a dedicated design interview BEFORE proposing tech stacks. Ask 3-5 questions covering:

- **Phong cách tổng thể (Design Style):** Minimalist, glassmorphism, neomorphism, brutalist, editorial, skeuomorphic, flat, material design? Show 2-3 style options with brief descriptions.
- **Vibe / Cảm xúc (Mood & Tone):** Professional & corporate, playful & creative, luxury & premium, friendly & approachable, techy & futuristic, warm & organic? Ask the user to pick adjectives that describe the desired feel.
- **Bảng màu (Color Palette):** Primary brand color? Preferred color family (earth tones, pastels, vibrant, monochrome, dark mode)? Any colors to AVOID? Ask for reference links or screenshots if available.
- **Typography & Layout:** Serif vs sans-serif preference? Dense information layout vs spacious/airy? Card-based vs list-based? Fixed sidebar vs top navigation?
- **Tham khảo (References & Inspiration):** Ask for 2-3 websites/apps the user admires visually. What specifically do they like about each? (colors, layout, animations, typography).
- **Đối tượng người dùng (Target Audience):** Age range, tech savviness, device preference (mobile-first vs desktop-first). This directly impacts design decisions.
- **Animation & Interaction:** Static/minimal vs rich animations? Micro-interactions (hover effects, transitions)? Scroll-triggered animations? Loading states style?

*If the user is unsure, propose 2-3 visual direction options (e.g., "Modern Minimal" vs "Bold Creative" vs "Corporate Clean") with brief descriptions of each, and let them pick or mix.*
*CRITICAL: Record all design decisions in Phase 3's design-spec.md under a dedicated "Visual Identity" section.*

**Phase 2: Tech Stack Proposal**
Based on the user's answers, propose 2 to 3 distinct Tech Stack combinations. For each option, provide:
- Name of the Option (e.g., Option A: "The Scalable Enterprise", Option B: "The Lean MVP").
- Specific recommendations for Frontend, Backend, Database, and Deployment/DevOps.
- For UI projects: recommend UI framework/component library that matches the chosen design style (e.g., shadcn/ui for minimal, Chakra UI for playful, Ant Design for corporate).
- Pros and Cons specific to the user's business context.
*CRITICAL: Ask the user to select one option (A, B, or C) and wait for their decision.*

**Phase 3: Design Spec Generation**
ONLY AFTER the user explicitly selects a tech stack, generate the final `design-spec.md` incorporating the chosen stack and the gathered requirements, following the defined Output Format Standards.

For UI/Frontend projects, the design-spec MUST include an additional section:
```
## 6. Visual Identity & Design System
- **Design Style:** [chosen style]
- **Mood & Tone:** [adjectives describing the vibe]
- **Color Palette:** Primary: [hex], Secondary: [hex], Accent: [hex], Background: [hex], Text: [hex]
- **Typography:** Headings: [font], Body: [font], Mono: [font]
- **Layout Pattern:** [description — e.g., responsive grid, sidebar + content, full-width sections]
- **Component Style:** [rounded corners, shadows, borders, glassmorphism, etc.]
- **Animation Level:** [none / subtle / moderate / rich]
- **References:** [links the user provided]
```

**Phase 4: Skills Auto-Equip**
IMMEDIATELY after generating `design-spec.md`, propose installing expert skills from skills.sh that match the chosen tech stack. Ask the user: "Bạn có muốn tôi tự động cài đặt các skills chuyên sâu cho stack này không?" If confirmed, execute: `omni auto-equip --stacks <detected-stacks>` or `omni auto-equip --design-spec design-spec.md`.