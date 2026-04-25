export interface IDESupport {
  name: string;
  icon: string;
  configFile: string;
  command: string;
}

export interface InstallStep {
  step: number;
  command: string;
  description: string;
}

export const ideSupportData: IDESupport[] = [
  { name: "Claude Code", icon: "🤖", configFile: "CLAUDE.md", command: "claude" },
  { name: "Gemini CLI", icon: "♊", configFile: "GEMINI.md", command: "gemini" },
  { name: "Codex CLI", icon: "📟", configFile: "AGENTS.md", command: "codex" },
  { name: "Cursor", icon: "⚡", configFile: ".cursorrules", command: "cursor" },
  { name: "Windsurf", icon: "🏄", configFile: ".windsurfrules", command: "windsurf" },
  { name: "Antigravity", icon: "🚀", configFile: "AGENTS.md", command: "antigravity" },
  { name: "Cross-tool", icon: "🔀", configFile: "AGENTS.md", command: "cross-tool" },
  { name: "Generic", icon: "📄", configFile: "SYSTEM_PROMPT.md", command: "generic" },
];

export const installSteps: InstallStep[] = [
  { step: 1, command: "npm install -g omni-coder-kit", description: "Cài đặt CLI toàn cục từ npm" },
  { step: 2, command: "omni init", description: "Chọn IDE, mức kỷ luật, personal rules" },
  { step: 3, command: "omni auto-equip", description: "Cài 6 universal skills mặc định" },
  { step: 4, command: ">om:brainstorm", description: "Bắt đầu brainstorm tính năng đầu tiên" },
];
