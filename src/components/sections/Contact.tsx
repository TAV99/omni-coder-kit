"use client";

import { useState, FormEvent } from "react";
import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";
import { useLang } from "@/components/LangProvider";

interface FormState {
  name: string;
  email: string;
  message: string;
  honeypot: string;
}

interface FormErrors {
  name?: string;
  email?: string;
  message?: string;
}

const texts = {
  vi: {
    title: "Liên hệ",
    titleHighlight: "với chúng tôi",
    subtitle: "Có câu hỏi? Gửi tin nhắn, chúng tôi sẽ phản hồi sớm nhất.",
    nameLabel: "Tên",
    namePlaceholder: "Tên của bạn",
    nameError: "Vui lòng nhập tên",
    emailLabel: "Email",
    emailError: "Vui lòng nhập email",
    emailInvalid: "Email không hợp lệ",
    messageLabel: "Tin nhắn",
    messagePlaceholder: "Bạn cần hỗ trợ gì?",
    messageError: "Vui lòng nhập tin nhắn",
    submit: "Gửi tin nhắn",
    submitting: "Đang gửi...",
    successMsg: "Cảm ơn bạn! Tin nhắn đã được gửi.",
    sendAnother: "Gửi tin nhắn khác",
  },
  en: {
    title: "Contact",
    titleHighlight: "us",
    subtitle: "Have a question? Send us a message and we'll respond soon.",
    nameLabel: "Name",
    namePlaceholder: "Your name",
    nameError: "Please enter your name",
    emailLabel: "Email",
    emailError: "Please enter your email",
    emailInvalid: "Invalid email address",
    messageLabel: "Message",
    messagePlaceholder: "How can we help?",
    messageError: "Please enter a message",
    submit: "Send message",
    submitting: "Sending...",
    successMsg: "Thank you! Your message has been sent.",
    sendAnother: "Send another message",
  },
};

export function Contact() {
  const { lang } = useLang();
  const t = texts[lang];
  const [form, setForm] = useState<FormState>({ name: "", email: "", message: "", honeypot: "" });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitError, setSubmitError] = useState("");

  function validate(): FormErrors {
    const errs: FormErrors = {};
    if (!form.name.trim()) errs.name = t.nameError;
    if (!form.email.trim()) {
      errs.email = t.emailError;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = t.emailInvalid;
    }
    if (!form.message.trim()) errs.message = t.messageError;
    return errs;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError("");

    if (form.honeypot) return;

    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const to = "tav99.dev@gmail.com.vn";
    const subject = encodeURIComponent(`[Omni-Coder Kit] ${lang === "vi" ? "Liên hệ từ" : "Contact from"} ${form.name}`);
    const body = encodeURIComponent(`${lang === "vi" ? "Từ" : "From"}: ${form.name} <${form.email}>\n\n${form.message}`);
    window.open(`https://mail.google.com/mail/?view=cm&to=${to}&su=${subject}&body=${body}`, "_blank");
    setSuccess(true);
    setForm({ name: "", email: "", message: "", honeypot: "" });
  }

  function handleChange(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }

  return (
    <SectionWrapper id="contact">
      <div className="mx-auto max-w-2xl">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            {t.title} <span className="gradient-text">{t.titleHighlight}</span>
          </h2>
          <p className="mt-4 text-lg text-content-muted">{t.subtitle}</p>
        </div>

        {success ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-12 rounded-xl border border-green-500/20 bg-green-500/10 p-8 text-center"
          >
            <p className="text-lg font-medium text-green-400">{t.successMsg}</p>
            <button onClick={() => setSuccess(false)} className="mt-4 text-sm text-content-muted underline hover:text-content">
              {t.sendAnother}
            </button>
          </motion.div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-12 space-y-6" noValidate>
            <input
              type="text"
              name="_gotcha"
              value={form.honeypot}
              onChange={(e) => handleChange("honeypot", e.target.value)}
              className="hidden"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
            />

            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-content-secondary">{t.nameLabel}</label>
                <input
                  id="name"
                  type="text"
                  value={form.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  className="mt-2 w-full rounded-lg border border-outline bg-surface-elevated px-4 py-3 text-content placeholder-gray-500 outline-none transition-colors focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-400"
                  placeholder={t.namePlaceholder}
                  aria-invalid={errors.name ? "true" : undefined}
                  aria-describedby={errors.name ? "name-error" : undefined}
                />
                {errors.name && <p id="name-error" className="mt-1 text-sm text-red-400" role="alert">{errors.name}</p>}
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-content-secondary">{t.emailLabel}</label>
                <input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                  className="mt-2 w-full rounded-lg border border-outline bg-surface-elevated px-4 py-3 text-content placeholder-gray-500 outline-none transition-colors focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-400"
                  placeholder="you@example.com"
                  aria-invalid={errors.email ? "true" : undefined}
                  aria-describedby={errors.email ? "email-error" : undefined}
                />
                {errors.email && <p id="email-error" className="mt-1 text-sm text-red-400" role="alert">{errors.email}</p>}
              </div>
            </div>

            <div>
              <label htmlFor="message" className="block text-sm font-medium text-content-secondary">{t.messageLabel}</label>
              <textarea
                id="message"
                rows={5}
                value={form.message}
                onChange={(e) => handleChange("message", e.target.value)}
                className="mt-2 w-full rounded-lg border border-outline bg-surface-elevated px-4 py-3 text-content placeholder-gray-500 outline-none transition-colors focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-400 resize-none"
                placeholder={t.messagePlaceholder}
                aria-invalid={errors.message ? "true" : undefined}
                aria-describedby={errors.message ? "message-error" : undefined}
              />
              {errors.message && <p id="message-error" className="mt-1 text-sm text-red-400" role="alert">{errors.message}</p>}
            </div>

            {submitError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
                {submitError}
              </div>
            )}

            <motion.button
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
              className="w-full inline-flex items-center justify-center rounded-xl px-6 py-3 font-medium bg-gradient-to-r from-orange-400 to-yellow-400 text-white hover:shadow-[0_0_30px_rgba(251,146,60,0.4)] transition-shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {submitting ? t.submitting : t.submit}
            </motion.button>
          </form>
        )}
      </div>
    </SectionWrapper>
  );
}
