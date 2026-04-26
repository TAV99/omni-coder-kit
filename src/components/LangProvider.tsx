"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Lang = "vi" | "en";

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: "vi",
  setLang: () => {},
});

export const useLang = () => useContext(LangContext);

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem("lang");
    if (stored === "vi" || stored === "en") return stored;
    if (navigator.language.startsWith("vi")) return "vi";
  } catch {}
  return "en";
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("vi");

  useEffect(() => {
    setLangState(detectLang());
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-lang", lang);
    localStorage.setItem("lang", lang);
  }, [lang]);

  const setLang = (l: Lang) => {
    if (l === "vi" || l === "en") setLangState(l);
  };

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      {children}
    </LangContext.Provider>
  );
}
