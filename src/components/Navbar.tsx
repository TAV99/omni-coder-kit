"use client";

import { useState, useEffect } from "react";
import { motion, useScroll, useMotionValueEvent, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { Button } from "./ui/Button";
import { ThemeToggle } from "./ThemeToggle";
import { LangToggle } from "./LangToggle";
import { useLang } from "./LangProvider";

const navLinks = [
  { label: { vi: "Giới thiệu", en: "About" }, href: "#about" },
  { label: { vi: "Tính năng", en: "Features" }, href: "#features" },
  { label: { vi: "Nhận xét", en: "Testimonials" }, href: "#testimonials" },
  { label: { vi: "Cài đặt", en: "Installation" }, href: "#installation" },
  { label: { vi: "FAQ", en: "FAQ" }, href: "#faq" },
  { label: { vi: "Liên hệ", en: "Contact" }, href: "#contact" },
  { label: { vi: "Docs", en: "Docs" }, href: "/docs" },
];

export function Navbar() {
  const [hidden, setHidden] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { scrollY } = useScroll();
  const { lang } = useLang();

  useMotionValueEvent(scrollY, "change", (latest) => {
    const previous = scrollY.getPrevious() ?? 0;
    if (latest > previous && latest > 150) {
      setHidden(true);
    } else {
      setHidden(false);
    }
  });

  /* Khoá scroll khi menu mobile mở */
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  return (
    <motion.nav
      role="navigation"
      aria-label="Main navigation"
      variants={{ visible: { y: 0 }, hidden: { y: "-100%" } }}
      animate={hidden && !mobileOpen ? "hidden" : "visible"}
      transition={{ duration: 0.35, ease: "easeInOut" }}
      className="fixed top-0 left-0 right-0 z-50 border-b border-outline-subtle bg-[var(--nav-bg)] backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <a href="#" className="text-xl font-bold gradient-text">Omni-Coder Kit</a>

        {/* Desktop nav links */}
        <div className="hidden items-center gap-6 md:flex">
          {navLinks.map((link) =>
            link.href.startsWith("/") ? (
              <Link key={link.href} href={link.href} className="text-sm text-content-muted transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 rounded">
                {link.label[lang]}
              </Link>
            ) : (
              <a key={link.href} href={link.href} className="text-sm text-content-muted transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 rounded">
                {link.label[lang]}
              </a>
            )
          )}
        </div>

        <div className="flex items-center gap-3">
          <LangToggle />
          <ThemeToggle />
          <Button variant="primary" href="#installation" className="hidden md:inline-flex text-sm px-4 py-2">
            {lang === "vi" ? "Bắt đầu ngay" : "Get Started"}
          </Button>

          {/* Nút hamburger cho mobile */}
          <button
            type="button"
            onClick={() => setMobileOpen((prev) => !prev)}
            className="inline-flex items-center justify-center rounded-lg p-2 text-content-muted hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 md:hidden"
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
            aria-label={mobileOpen ? "Đóng menu" : "Mở menu"}
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              {mobileOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Menu mobile slide-down */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            id="mobile-menu"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden border-t border-outline-subtle md:hidden"
          >
            <div className="space-y-1 px-4 pb-4 pt-2">
              {navLinks.map((link) =>
                link.href.startsWith("/") ? (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-lg px-3 py-2.5 text-base text-content-secondary transition-colors hover:bg-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                  >
                    {link.label[lang]}
                  </Link>
                ) : (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-lg px-3 py-2.5 text-base text-content-secondary transition-colors hover:bg-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                  >
                    {link.label[lang]}
                  </a>
                )
              )}
              <div className="pt-2">
                <Button variant="primary" href="#installation" className="w-full text-sm" onClick={() => setMobileOpen(false)}>
                  {lang === "vi" ? "Bắt đầu ngay" : "Get Started"}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
