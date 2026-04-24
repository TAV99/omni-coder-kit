"use client";

import { motion } from "framer-motion";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CodeSnippet } from "@/components/ui/CodeSnippet";
import { heroData } from "@/data/hero";

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
      {/* Hiệu ứng gradient orb trang trí */}
      <div className="absolute top-1/4 -left-32 h-64 w-64 rounded-full bg-cyan-500/20 blur-[128px]" aria-hidden="true" />
      <div className="absolute bottom-1/4 -right-32 h-64 w-64 rounded-full bg-violet-500/20 blur-[128px]" aria-hidden="true" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <Badge variant="highlighted">{heroData.badge}</Badge>
            <h1 className="mt-4 text-5xl font-bold tracking-tight md:text-7xl">
              <span className="gradient-text">{heroData.headline}</span>
            </h1>
            <p className="mt-6 max-w-lg text-xl text-gray-400 leading-relaxed">
              {heroData.tagline}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button variant="primary" href={heroData.cta.primary.href}>
                {heroData.cta.primary.label}
              </Button>
              <Button variant="secondary" href={heroData.cta.secondary.href}>
                {heroData.cta.secondary.label}
              </Button>
            </div>
            <div className="mt-6 inline-flex items-center gap-3 rounded-lg border border-white/10 bg-[#141415] px-4 py-2.5 font-mono text-sm text-gray-300">
              <span>$</span>
              <code>{heroData.install}</code>
            </div>
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
