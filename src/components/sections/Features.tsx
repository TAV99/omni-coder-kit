"use client";

import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { Card } from "@/components/ui/Card";
import { featuresData } from "@/data/features";
import { useLang } from "@/components/LangProvider";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.2 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 300, damping: 24 } },
};

export function Features() {
  const { lang } = useLang();
  const features = featuresData[lang];

  return (
    <SectionWrapper id="features">
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          {lang === "vi" ? (
            <>Workflow <span className="gradient-text">hoàn chỉnh</span></>
          ) : (
            <>A <span className="gradient-text">complete</span> workflow</>
          )}
        </h2>
        <p className="mt-4 text-lg text-content-muted">
          {lang === "vi" ? "9 commands. Từ ý tưởng đến production." : "9 commands. From idea to production."}
        </p>
      </div>
      <motion.div
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-100px" }}
        className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
      >
        {features.map((feature: { id: string; icon: string; title: string; description: string; badge?: string }) => (
          <motion.div key={feature.id} variants={itemVariants} className="h-full">
            <Card className={`h-full ${feature.badge ? "ring-1 ring-accent-border" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-3xl">{feature.icon}</span>
                {feature.badge && (
                  <span className="rounded-full bg-gradient-to-r from-orange-400 to-yellow-400 px-2 py-0.5 text-[10px] font-bold uppercase text-white tracking-wider">
                    {feature.badge}
                  </span>
                )}
              </div>
              <h3 className="mt-3 font-mono text-lg font-semibold text-accent">{feature.title}</h3>
              <p className="mt-2 text-sm text-content-muted leading-relaxed">{feature.description}</p>
            </Card>
          </motion.div>
        ))}
      </motion.div>
    </SectionWrapper>
  );
}
