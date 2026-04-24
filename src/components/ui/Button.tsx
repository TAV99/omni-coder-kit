"use client";

import { motion } from "framer-motion";

interface ButtonProps {
  variant?: "primary" | "secondary";
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function Button({ variant = "primary", href, onClick, children, className = "" }: ButtonProps) {
  const base = "inline-flex items-center justify-center rounded-xl px-6 py-3 font-medium transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]";
  const styles = {
    primary: `${base} bg-gradient-to-r from-cyan-500 to-violet-500 text-white hover:shadow-[0_0_30px_rgba(6,182,212,0.4)] ${className}`,
    secondary: `${base} border border-white/20 text-white hover:border-white/40 ${className}`,
  };

  const motionProps = {
    whileHover: { scale: 1.02 },
    whileTap: { scale: 0.98 },
    transition: { type: "spring" as const, stiffness: 400, damping: 17 },
  };

  if (href) {
    return (
      <motion.a href={href} onClick={onClick} className={styles[variant]} {...motionProps}>
        {children}
      </motion.a>
    );
  }

  return (
    <motion.button onClick={onClick} className={styles[variant]} {...motionProps}>
      {children}
    </motion.button>
  );
}
