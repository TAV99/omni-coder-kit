"use client";

import { useLang } from "./LangProvider";

export function LangToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLang();

  return (
    <button
      onClick={() => setLang(lang === "vi" ? "en" : "vi")}
      className={`rounded-lg px-2 py-1.5 text-xs font-bold text-content-muted hover:text-content transition-colors ${className}`}
      aria-label={lang === "vi" ? "Switch to English" : "Chuyển sang Tiếng Việt"}
    >
      {lang === "vi" ? "EN" : "VI"}
    </button>
  );
}
