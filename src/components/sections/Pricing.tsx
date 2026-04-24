"use client";

import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { Card } from "@/components/ui/Card";
import { ideSupportData, installSteps } from "@/data/pricing";

export function Pricing() {
  return (
    <SectionWrapper id="pricing">
      {/* IDE Support */}
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          Hoạt động với <span className="gradient-text">mọi AI agent</span>
        </h2>
        <p className="mt-4 text-lg text-gray-400">Chọn IDE khi omni init — config tự động phù hợp.</p>
      </div>
      <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {ideSupportData.map((ide, i) => (
          <motion.div
            key={ide.name}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.05 }}
          >
            <Card className="text-center" hover={false}>
              <span className="text-2xl">{ide.icon}</span>
              <h3 className="mt-2 text-sm font-semibold text-white">{ide.name}</h3>
              <p className="mt-1 font-mono text-xs text-gray-500">{ide.configFile}</p>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Getting Started */}
      <div className="mt-20 text-center">
        <h3 className="text-2xl font-bold tracking-tight md:text-3xl">
          Bắt đầu trong <span className="gradient-text">30 giây</span>
        </h3>
        <p className="mt-4 text-lg text-gray-400">Open source, miễn phí mãi mãi. ISC License.</p>
      </div>
      <div className="mx-auto mt-12 max-w-2xl space-y-4">
        {installSteps.map((item, i) => (
          <motion.div
            key={item.step}
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.1 }}
            className="flex items-start gap-4"
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-white/10 text-sm font-bold text-cyan-400">
              {item.step}
            </div>
            <div className="flex-1">
              <code className="rounded-md bg-[#141415] border border-white/10 px-3 py-1.5 font-mono text-sm text-cyan-400">{item.command}</code>
              <p className="mt-1.5 text-sm text-gray-400">{item.description}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </SectionWrapper>
  );
}
