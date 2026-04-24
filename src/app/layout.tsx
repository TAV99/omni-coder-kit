import type { Metadata } from "next";
import { geistSans, geistMono, jetbrainsMono } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Omni-Coder Kit — Vibe Coding, Perfected",
  description: "Bộ kit hỗ trợ AI trong vibe coding. Từ brainstorm đến deploy — mọi bước đều có quy trình.",
  keywords: ["vibe coding", "AI coding", "SDLC", "Claude Code", "developer tools"],
  openGraph: {
    title: "Omni-Coder Kit — Vibe Coding, Perfected",
    description: "Bộ kit hỗ trợ AI trong vibe coding. Từ brainstorm đến deploy — mọi bước đều có quy trình.",
    url: "https://omni-coder.dev",
    siteName: "Omni-Coder Kit",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Omni-Coder Kit — Vibe Coding, Perfected",
    description: "Bộ kit hỗ trợ AI trong vibe coding.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-[#0a0a0b] text-[#f5f5f5] font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
