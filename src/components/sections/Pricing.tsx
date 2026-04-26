"use client";

import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { Card } from "@/components/ui/Card";
import { ideSupportData, installSteps } from "@/data/pricing";
import {
  ClaudeIcon, GeminiIcon, OpenAIIcon, CursorIcon,
  WindsurfIcon, AntigravityIcon, CrossToolIcon, GenericIcon,
} from "@/components/docs/IdeIcons";

const ideIconMap: Record<string, React.ReactNode> = {
  "Claude Code": <ClaudeIcon />,
  "Gemini CLI": <GeminiIcon />,
  "Codex CLI": <OpenAIIcon />,
  "Cursor": <CursorIcon />,
  "Windsurf": <WindsurfIcon />,
  "Antigravity": <AntigravityIcon />,
  "Cross-tool": <CrossToolIcon />,
  "Generic": <GenericIcon />,
};

export function Pricing() {
  return (
    <SectionWrapper id="installation">
      {/* IDE Support */}
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          Hoạt động với <span className="gradient-text">mọi AI agent</span>
        </h2>
        <p className="mt-4 text-lg text-content-muted">Chọn IDE khi omni init — config tự động phù hợp.</p>
      </div>
      <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {ideSupportData.map((ide, i) => (
          <motion.div
            key={ide.name}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.05 }}
          >
            <Card className="text-center" hover={false}>
              <span className="flex h-8 w-8 items-center justify-center">{ideIconMap[ide.name] ?? ide.icon}</span>
              <h3 className="mt-2 text-sm font-semibold text-content">{ide.name}</h3>
              <p className="mt-1 font-mono text-xs text-content-faint">{ide.configFile}</p>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Getting Started */}
      <div className="mt-20 text-center">
        <h3 className="text-2xl font-bold tracking-tight md:text-3xl">
          Bắt đầu trong <span className="gradient-text">30 giây</span>
        </h3>
        <p className="mt-4 text-lg text-content-muted">Open source, miễn phí mãi mãi. ISC License.</p>
      </div>
      <div className="mx-auto mt-12 max-w-2xl space-y-4">
        {installSteps.map((item, i) => (
          <motion.div
            key={item.step}
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.1 }}
            className="flex items-start gap-4"
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-400/20 to-yellow-400/20 border border-outline text-sm font-bold text-accent">
              {item.step}
            </div>
            <div className="flex-1">
              <code className="rounded-md bg-surface-elevated border border-outline px-3 py-1.5 font-mono text-sm text-accent">{item.command}</code>
              <p className="mt-1.5 text-sm text-content-muted">{item.description}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </SectionWrapper>
  );
}
