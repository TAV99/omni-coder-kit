"use client";

import { useState, FormEvent } from "react";
import { motion } from "framer-motion";
import { SectionWrapper } from "@/components/ui/SectionWrapper";

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

export function Contact() {
  const [form, setForm] = useState<FormState>({ name: "", email: "", message: "", honeypot: "" });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitError, setSubmitError] = useState("");

  function validate(): FormErrors {
    const errs: FormErrors = {};
    if (!form.name.trim()) errs.name = "Vui lòng nhập tên";
    if (!form.email.trim()) {
      errs.email = "Vui lòng nhập email";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = "Email không hợp lệ";
    }
    if (!form.message.trim()) errs.message = "Vui lòng nhập tin nhắn";
    return errs;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError("");

    // Honeypot check — bot đã điền field ẩn
    if (form.honeypot) return;

    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      const formspreeId = process.env.NEXT_PUBLIC_FORMSPREE_ID;
      const res = await fetch(`https://formspree.io/f/${formspreeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, email: form.email, message: form.message }),
      });
      if (res.ok) {
        setSuccess(true);
        setForm({ name: "", email: "", message: "", honeypot: "" });
      } else {
        setSubmitError("Gửi thất bại, vui lòng thử lại.");
      }
    } catch {
      setSubmitError("Gửi thất bại, vui lòng thử lại.");
    } finally {
      setSubmitting(false);
    }
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
            Liên hệ <span className="gradient-text">với chúng tôi</span>
          </h2>
          <p className="mt-4 text-lg text-gray-400">Có câu hỏi? Gửi tin nhắn, chúng tôi sẽ phản hồi sớm nhất.</p>
        </div>

        {success ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-12 rounded-xl border border-green-500/20 bg-green-500/10 p-8 text-center"
          >
            <p className="text-lg font-medium text-green-400">Cảm ơn bạn! Tin nhắn đã được gửi.</p>
            <button onClick={() => setSuccess(false)} className="mt-4 text-sm text-gray-400 underline hover:text-white">
              Gửi tin nhắn khác
            </button>
          </motion.div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-12 space-y-6" noValidate>
            {/* Honeypot — ẩn khỏi người dùng thật, chỉ bot mới điền */}
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
                <label htmlFor="name" className="block text-sm font-medium text-gray-300">Tên</label>
                <input
                  id="name"
                  type="text"
                  value={form.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  className="mt-2 w-full rounded-lg border border-white/10 bg-[#141415] px-4 py-3 text-white placeholder-gray-500 outline-none transition-colors focus:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500"
                  placeholder="Tên của bạn"
                  aria-invalid={errors.name ? "true" : undefined}
                  aria-describedby={errors.name ? "name-error" : undefined}
                />
                {errors.name && <p id="name-error" className="mt-1 text-sm text-red-400" role="alert">{errors.name}</p>}
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-300">Email</label>
                <input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                  className="mt-2 w-full rounded-lg border border-white/10 bg-[#141415] px-4 py-3 text-white placeholder-gray-500 outline-none transition-colors focus:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500"
                  placeholder="you@example.com"
                  aria-invalid={errors.email ? "true" : undefined}
                  aria-describedby={errors.email ? "email-error" : undefined}
                />
                {errors.email && <p id="email-error" className="mt-1 text-sm text-red-400" role="alert">{errors.email}</p>}
              </div>
            </div>

            <div>
              <label htmlFor="message" className="block text-sm font-medium text-gray-300">Tin nhắn</label>
              <textarea
                id="message"
                rows={5}
                value={form.message}
                onChange={(e) => handleChange("message", e.target.value)}
                className="mt-2 w-full rounded-lg border border-white/10 bg-[#141415] px-4 py-3 text-white placeholder-gray-500 outline-none transition-colors focus:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500 resize-none"
                placeholder="Bạn cần hỗ trợ gì?"
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
              className="w-full inline-flex items-center justify-center rounded-xl px-6 py-3 font-medium bg-gradient-to-r from-cyan-500 to-violet-500 text-white hover:shadow-[0_0_30px_rgba(6,182,212,0.4)] transition-shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b]"
            >
              {submitting ? "Đang gửi..." : "Gửi tin nhắn"}
            </motion.button>
          </form>
        )}
      </div>
    </SectionWrapper>
  );
}
