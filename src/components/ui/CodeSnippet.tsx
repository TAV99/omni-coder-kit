"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";

const codeLines = [
  { text: "$ npm install -g omni-coder-kit", color: "text-cyan-400" },
  { text: "✓ Installed omni-coder-kit@2.1.0", color: "text-green-400" },
  { text: "", color: "" },
  { text: "$ omni init", color: "text-cyan-400" },
  { text: "? Chọn IDE: Claude Code", color: "text-violet-400" },
  { text: "? Discipline level: Senior Engineer", color: "text-violet-400" },
  { text: "✓ Created CLAUDE.md (5.2KB)", color: "text-green-400" },
  { text: "✓ Created .omni/workflows/ (7 files)", color: "text-green-400" },
  { text: "✓ Installed /om:* slash commands", color: "text-green-400" },
  { text: "", color: "" },
  { text: "$ omni auto-equip", color: "text-cyan-400" },
  { text: "✓ Installed 6 universal skills", color: "text-green-400" },
  { text: "", color: "" },
  { text: "🚀 Ready! Type >om:brainstorm to start", color: "text-yellow-400" },
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
    <div className="relative rounded-xl border border-white/10 bg-[#0d0d0e] p-1">
      {/* Thanh điều khiển cửa sổ terminal */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <div className="h-3 w-3 rounded-full bg-red-500/60" />
        <div className="h-3 w-3 rounded-full bg-yellow-500/60" />
        <div className="h-3 w-3 rounded-full bg-green-500/60" />
        <span className="ml-2 text-xs text-gray-500 font-mono">omni-coder-kit</span>
      </div>
      {/* Nội dung code với hiệu ứng typing */}
      <div className="p-4 font-mono text-sm leading-7 min-h-[280px]">
        {codeLines.slice(0, visibleLines).map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
            className={line.color || "text-gray-500"}
          >
            {line.text || " "}
          </motion.div>
        ))}
        {visibleLines < codeLines.length && (
          <span className="inline-block w-2 h-5 bg-cyan-400 animate-pulse" />
        )}
      </div>
      {/* Hiệu ứng phát sáng viền */}
      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-cyan-500/10 to-violet-500/10 -z-10 blur-xl" />
    </div>
  );
}
