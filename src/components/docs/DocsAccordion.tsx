"use client";

import { useState, useId } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface DocsAccordionProps {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function DocsAccordion({ title, icon, defaultOpen = false, children }: DocsAccordionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className="rounded-lg border border-outline bg-highlight overflow-hidden">
      <button
        id={`${id}-trigger`}
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
        aria-expanded={isOpen}
        aria-controls={`${id}-panel`}
      >
        {icon && <span className="flex h-6 w-6 items-center justify-center shrink-0">{icon}</span>}
        <span className="flex-1 font-medium text-content">{title}</span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-content-faint"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={`${id}-panel`}
            role="region"
            aria-labelledby={`${id}-trigger`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="border-t border-outline-subtle px-4 py-4 space-y-3 text-sm text-content-secondary leading-relaxed">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
