"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CodeSnippet } from "@/components/ui/CodeSnippet";
import { heroData } from "@/data/hero";
import { useLang } from "@/components/LangProvider";

function CopyInstall({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="mt-6 inline-flex items-center gap-3 rounded-lg border border-outline bg-surface-elevated px-4 py-2.5 font-mono text-sm text-content-secondary transition-colors hover:border-orange-400/50 hover:text-content cursor-pointer group"
      title="Click để copy"
    >
      <span className="text-content-faint">$</span>
      <code>{command}</code>
      <span className="ml-2 text-content-faint group-hover:text-accent transition-colors">
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        )}
      </span>
    </button>
  );
}

export function Hero() {
  const { lang } = useLang();
  const d = heroData[lang];

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
      {/* Hiệu ứng gradient orb trang trí */}
      <div className="absolute top-1/4 -left-32 h-64 w-64 rounded-full blur-[128px]" style={{ background: "var(--orb-orange)" }} aria-hidden="true" />
      <div className="absolute bottom-1/4 -right-32 h-64 w-64 rounded-full blur-[128px]" style={{ background: "var(--orb-yellow)" }} aria-hidden="true" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <Badge variant="highlighted">{d.badge}</Badge>
            <h1 className="mt-4 text-5xl font-bold tracking-tight md:text-7xl">
              <span className="gradient-text">{d.headline}</span>
            </h1>
            <p className="mt-6 max-w-lg text-xl text-content-muted leading-relaxed">
              {d.tagline}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button variant="primary" href={d.cta.primary.href}>
                {d.cta.primary.label}
              </Button>
              <Button variant="secondary" href={d.cta.secondary.href}>
                {d.cta.secondary.label}
              </Button>
            </div>
            <CopyInstall command={d.install} />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
          >
            <CodeSnippet />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
