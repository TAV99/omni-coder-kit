"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";

const codeLines = [
  { text: "$ npm install -g omni-coder-kit", color: "text-accent" },
  { text: "✓ Installed omni-coder-kit@2.1.0", color: "text-green-400" },
  { text: "", color: "" },
  { text: "$ omni init", color: "text-accent" },
  { text: "? Chọn IDE: Claude Code", color: "text-accent-alt" },
  { text: "? Discipline level: Senior Engineer", color: "text-accent-alt" },
  { text: "✓ Created CLAUDE.md (5.2KB)", color: "text-green-400" },
  { text: "✓ Created .omni/workflows/ (7 files)", color: "text-green-400" },
  { text: "✓ Installed /om:* slash commands", color: "text-green-400" },
  { text: "", color: "" },
  { text: "$ omni auto-equip", color: "text-accent" },
  { text: "✓ Installed 6 universal skills", color: "text-green-400" },
  { text: "", color: "" },
  { text: "🚀 Ready! Type >om:brainstorm to start", color: "text-accent-alt" },
];

export function CodeSnippet() {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    if (visibleLines < codeLines.length) {
      const timer = setTimeout(() => setVisibleLines((v) => v + 1), 300);
      return () => clearTimeout(timer);
    }
  }, [visibleLines]);

  return (
    <div className="relative rounded-xl border border-outline bg-surface-code p-1">
      {/* Thanh điều khiển cửa sổ terminal */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-subtle">
        <div className="h-3 w-3 rounded-full bg-red-500/60" />
        <div className="h-3 w-3 rounded-full bg-yellow-400/60" />
        <div className="h-3 w-3 rounded-full bg-green-500/60" />
        <span className="ml-2 text-xs text-content-faint font-mono">omni-coder-kit</span>
      </div>
      {/* Nội dung code với hiệu ứng typing */}
      <div className="p-4 font-mono text-sm leading-7 min-h-[280px]">
        {codeLines.slice(0, visibleLines).map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
            className={line.color || "text-content-faint"}
          >
            {line.text || " "}
          </motion.div>
        ))}
        {visibleLines < codeLines.length && (
          <span className="inline-block w-2 h-5 bg-accent animate-pulse" />
        )}
      </div>
      {/* Hiệu ứng phát sáng viền */}
      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-orange-400/10 to-yellow-400/10 -z-10 blur-xl" />
    </div>
  );
}
