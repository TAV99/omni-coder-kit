import type { Metadata } from "next";
import Link from "next/link";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { DocsContent } from "@/components/docs/DocsContent";
import { ThemeToggle } from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Documentation — Omni-Coder Kit",
  description: "Hướng dẫn sử dụng Omni-Coder Kit — CLI inject mindset, SDLC workflow và skills vào AI coding agents.",
};

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-outline-subtle bg-[var(--nav-bg)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-xl font-bold gradient-text">Omni-Coder Kit</Link>
            <span className="hidden text-sm text-content-faint sm:inline">/</span>
            <span className="hidden text-sm text-content-secondary sm:inline">Docs</span>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <Link href="/" className="text-sm text-content-muted hover:text-content transition-colors">Home</Link>
            <a
              href="https://github.com/TAV99/omni-coder-kit"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-content-muted hover:text-content transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </header>

      {/* Layout: sidebar + content */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex gap-8 py-8 lg:py-12">
          <DocsSidebar />
          <DocsContent />
        </div>
      </div>
    </div>
  );
}
