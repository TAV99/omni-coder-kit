"use client";

import { useState, useEffect } from "react";
import { docGroups } from "@/data/docs";

export function DocsSidebar() {
  const [activeId, setActiveId] = useState("introduction");
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((e) => e.isIntersecting);
        if (visible) setActiveId(visible.target.id);
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0.1 }
    );

    docGroups.forEach((g) =>
      g.sections.forEach((s) => {
        const el = document.getElementById(s.id);
        if (el) observer.observe(el);
      })
    );
    return () => observer.disconnect();
  }, []);

  const handleClick = (id: string) => {
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const nav = (
    <nav className="space-y-6">
      {docGroups.map((group) => (
        <div key={group.name}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            {group.name}
          </h4>
          <ul className="space-y-1">
            {group.sections.map((section) => (
              <li key={section.id}>
                <button
                  onClick={() => handleClick(section.id)}
                  className={`block w-full text-left rounded-md px-3 py-1.5 text-sm transition-colors ${
                    activeId === section.id
                      ? "bg-cyan-500/10 text-cyan-400 font-medium"
                      : "text-gray-400 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Mobile toggle */}
      <div className="sticky top-16 z-30 border-b border-white/5 bg-[#0a0a0b]/95 backdrop-blur-xl p-3 lg:hidden">
        <button
          onClick={() => setMobileOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/5"
        >
          <span>Menu</span>
          <svg className={`h-4 w-4 transition-transform ${mobileOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {mobileOpen && <div className="mt-2 max-h-[60vh] overflow-y-auto scrollbar-thin">{nav}</div>}
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden lg:block sticky top-20 h-[calc(100vh-5rem)] w-64 shrink-0 overflow-y-auto scrollbar-thin pr-6 pb-8">
        {nav}
      </aside>
    </>
  );
}
