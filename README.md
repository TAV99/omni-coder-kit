# Omni-Coder Kit 🚀

**Omni-Coder Kit** is a powerful CLI tool designed to manage and inject "ideologies" (mindset + workflows + specialized skills) into AI-powered coding environments. It ensures that your AI agents (Claude Code, Cursor, Windsurf, Antigravity, etc.) operate with senior-level discipline, follow strict SDLC processes, and utilize best-practice design patterns.

## 🌟 Key Features

- **Multi-IDE Support:** Generates tailored configuration files for `Claude Code` (`CLAUDE.md`), `Cursor` (`.cursorrules`), `Windsurf` (`.windsurfrules`), `Antigravity` (`.antigravityrules`), and more.
- **Core Mindset (Karpathy Style):** Enforces First Principles: Think before coding, Simplicity First, Surgical Changes, and Goal-Driven Execution.
- **Structured SDLC Workflow:** Orchestrates the development process through specialized commands like `[>om:brainstorm]`, `[>om:plan]`, and `[>om:cook]`.
- **Modular Stacks:** Quickly add domain-specific rules for React/Next.js, Hono/PostgreSQL, Automation, and Payment Gateways.
- **External Skill Integration:** Seamlessly integrates with the `skills.sh` ecosystem to fetch expert skills from global repositories.
- **Manifest System:** Tracks installed skills and prevents conflicts within your project.

---

## 🛠️ Installation

Ensure you have [Node.js](https://nodejs.org/) (>=16.0.0) installed.

```bash
# Clone the repository
git clone https://github.com/TAV99/omni-coder-kit.git
cd omni-coder-kit

# Install dependencies
npm install

# Link the CLI globally (optional)
npm link
```

---

## 🚀 Getting Started

### 1. Initialize your project
Run `omni init` in your project root to set up the foundation.
```bash
omni init
```
- Select your AI IDE (Claude Code, Cursor, etc.).
- Choose your discipline level (Hardcore or Flexible).
- Select your initial tech stacks.

### 2. List available skills
Check the built-in library of specialized stacks.
```bash
omni list
```

### 3. Add specialized rules
Inject specific technical rules into your existing configuration.
```bash
omni add react-next
```

### 4. Equip external skills
Fetch advanced skills from the `skills.sh` registry or any GitHub repository.
```bash
omni equip vercel-labs/agent-skills
```

### 5. Check status
Review which skills are currently active in your project.
```bash
omni status
```

---

## 🧠 The Omni Workflow (SDLC)

Once initialized, interact with your AI using these structured commands:

| Command | Role | Description |
| :--- | :--- | :--- |
| `[>om:brainstorm]` | **Architect** | Deep interview, tech stack selection, and `design-spec.md` creation. |
| `[>om:equip]` | **Manager** | Automatically fetches necessary expert skills via `skills.sh`. |
| `[>om:plan]` | **PM** | Breaks the spec into granular tasks in `todo.md`. |
| `[>om:cook]` | **Coder** | Executes tasks with surgical precision and minimal code. |
| `[>om:check]` | **QA** | Verifies functionality and generates `test-report.md`. |
| `[>om:fix]` | **QA Agent** | Systematic debugging based on strict error logs. |
| `[>om:doc]` | **Writer** | Finalizes documentation and READMEs. |

---

## 📂 Project Structure

- `bin/omni.js`: Core CLI logic and command definitions.
- `templates/core/`: Foundation mindset and hygiene rules.
- `templates/stacks/`: Technology-specific instruction sets.
- `templates/workflows/`: SDLC process automation templates.
- `.omni-manifest.json`: Tracks installed skills and project metadata.

---

## 📜 License

This project is licensed under the ISC License.

Developed with ❤️ by [TAV](mailto:tav99.dev@gmail.com).
