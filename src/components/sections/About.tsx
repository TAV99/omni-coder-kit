"use client";

import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { aboutData } from "@/data/about";

export function About() {
  return (
    <SectionWrapper id="about">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-start">
        {/* Phần nội dung chữ */}
        <div>
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            {aboutData.title}
          </h2>
          <div className="mt-8 space-y-6">
            {aboutData.points.map((point, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.15 }}
              >
                <h3 className="text-lg font-semibold text-cyan-400">{point.title}</h3>
                <p className="mt-2 text-gray-400 leading-relaxed">{point.description}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Phần minh hoạ workflow diagram */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="flex items-center justify-center"
        >
          <div className="relative w-full max-w-sm">
            {aboutData.workflow.map((item, i) => (
              <motion.div
                key={item.command}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.3 + i * 0.1 }}
                className="flex items-center gap-3 mb-3"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-white/10 text-sm font-mono text-cyan-400">
                  {i + 1}
                </div>
                <div className="flex-1 rounded-lg border border-white/10 bg-[#141415] px-4 py-2.5">
                  <span className="font-mono text-sm text-violet-400">{item.command}</span>
                  <span className="ml-2 text-xs text-gray-500">{item.agent}</span>
                </div>
                {i < aboutData.workflow.length - 1 && (
                  <div className="absolute left-5 mt-12 h-3 w-px bg-white/10" />
                )}
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </SectionWrapper>
  );
}
