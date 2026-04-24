import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { Accordion } from "@/components/ui/Accordion";
import { faqData } from "@/data/faq";

export function FAQ() {
  return (
    <SectionWrapper id="faq">
      <div className="mx-auto max-w-3xl">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Câu hỏi <span className="gradient-text">thường gặp</span>
          </h2>
          <p className="mt-4 text-lg text-gray-400">Mọi thứ bạn cần biết về Omni-Coder Kit.</p>
        </div>
        <div className="mt-12">
          {faqData.map((item, i) => (
            <Accordion key={i} question={item.question} answer={item.answer} />
          ))}
        </div>
      </div>
    </SectionWrapper>
  );
}
