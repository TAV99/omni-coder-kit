"use client";

import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { Accordion } from "@/components/ui/Accordion";
import { faqData } from "@/data/faq";
import { useLang } from "@/components/LangProvider";

export function FAQ() {
  const { lang } = useLang();
  const faqs = faqData[lang];

  return (
    <SectionWrapper id="faq">
      <div className="mx-auto max-w-3xl">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            {lang === "vi" ? (
              <>Câu hỏi <span className="gradient-text">thường gặp</span></>
            ) : (
              <>Frequently <span className="gradient-text">asked questions</span></>
            )}
          </h2>
          <p className="mt-4 text-lg text-content-muted">
            {lang === "vi" ? "Mọi thứ bạn cần biết về Omni-Coder Kit." : "Everything you need to know about Omni-Coder Kit."}
          </p>
        </div>
        <div className="mt-12">
          {faqs.map((item, i) => (
            <Accordion key={i} question={item.question} answer={item.answer} />
          ))}
        </div>
      </div>
    </SectionWrapper>
  );
}
