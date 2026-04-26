import type { Metadata } from "next";
import { geistSans, geistMono, jetbrainsMono } from "@/lib/fonts";
import { ThemeProvider } from "@/components/ThemeProvider";
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

const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light'||(!t&&!window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`dark ${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-surface text-content font-sans antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
