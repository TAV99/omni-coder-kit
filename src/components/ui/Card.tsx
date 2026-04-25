"use client";

import { motion } from "framer-motion";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}

export function Card({ children, className = "", hover = true }: CardProps) {
  return (
    <motion.div
      className={`relative rounded-2xl p-[1px] ${className.includes("h-full") ? "h-full" : ""}`}
      style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.3), rgba(139,92,246,0.3))" }}
      whileHover={hover ? { scale: 1.02 } : undefined}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
    >
      <div className={`rounded-2xl bg-[#141415] p-6 backdrop-blur-xl ${className}`}>
        {children}
      </div>
    </motion.div>
  );
}
