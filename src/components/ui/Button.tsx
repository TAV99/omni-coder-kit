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
  const base = "inline-flex items-center justify-center rounded-xl px-6 py-3 font-medium transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
  const styles = {
    primary: `${base} bg-gradient-to-r from-orange-400 to-yellow-400 text-white hover:shadow-[0_0_30px_rgba(251,146,60,0.4)] ${className}`,
    secondary: `${base} border border-outline-strong text-content hover:border-outline-strong ${className}`,
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
