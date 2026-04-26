"use client";

import { useState, useId } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface AccordionProps {
  question: string;
  answer: string;
  defaultOpen?: boolean;
}

export function Accordion({ question, answer, defaultOpen = false }: AccordionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const id = useId();
  const panelId = `${id}-panel`;
  const triggerId = `${id}-trigger`;

  return (
    <div className="border-b border-outline">
      <button
        id={triggerId}
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between py-4 text-left text-lg font-medium text-content transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 rounded"
        aria-expanded={isOpen}
        aria-controls={panelId}
      >
        {question}
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.3 }}
          className="ml-4 flex-shrink-0"
          aria-hidden="true"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={triggerId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <p className="pb-4 text-content-muted leading-relaxed">{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
