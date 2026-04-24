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
  { name: "Cursor", icon: "⚡", configFile: ".cursor/rules/", command: "cursor" },
  { name: "Windsurf", icon: "🏄", configFile: ".windsurfrules", command: "windsurf" },
  { name: "Copilot (VS Code)", icon: "🧑‍✈️", configFile: ".github/copilot-instructions.md", command: "copilot" },
  { name: "Roo Code", icon: "🦘", configFile: ".roo/rules/", command: "roo" },
  { name: "Cline", icon: "🔧", configFile: ".clinerules", command: "cline" },
  { name: "Gemini CLI", icon: "♊", configFile: "GEMINI.md", command: "gemini" },
];

export const installSteps: InstallStep[] = [
  { step: 1, command: "npm install -g omni-coder-kit", description: "Cài đặt CLI toàn cục từ npm" },
  { step: 2, command: "omni init", description: "Chọn IDE, sinh config tự động" },
  { step: 3, command: "omni equip", description: "Tải skill packs cho AI agent" },
  { step: 4, command: ">om:brainstorm", description: "Bắt đầu brainstorm tính năng đầu tiên" },
];
