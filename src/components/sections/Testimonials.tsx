"use client";

import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { Card } from "@/components/ui/Card";
import { testimonialsData } from "@/data/testimonials";

export function Testimonials() {
  return (
    <SectionWrapper id="testimonials">
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          Developers <span className="gradient-text">yêu thích</span>
        </h2>
        <p className="mt-4 text-lg text-content-muted">Những người đã thay đổi cách làm việc với AI.</p>
      </div>
      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        {testimonialsData.map((testimonial, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
          >
            <Card className="h-full">
              <svg className="h-8 w-8 text-orange-400/30" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
              </svg>
              <p className="mt-4 text-content-secondary leading-relaxed">{testimonial.quote}</p>
              <div className="mt-6 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-orange-400/20 to-yellow-400/20 text-sm font-bold text-content">
                  {testimonial.name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-content">{testimonial.name}</p>
                  <p className="text-xs text-content-faint">{testimonial.role}</p>
                </div>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </SectionWrapper>
  );
}
