import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Nav } from "@/components/Nav";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Replaces the remote @import that used to sit at the top of base.css. next/font
// downloads Inter at build time and self-hosts it, so there is no render-blocking
// request to fonts.googleapis.com.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Full-stack agentic chatbot",
  description: "Human-in-the-loop, orchestration, and time travel over LangGraph.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      {/*
        h-dvh flex column: the nav takes its natural height and <main> gets the
        rest. Every page then passes `embedded` to ChatContainer so it uses
        min-h-0 flex-1 instead of h-screen — otherwise the chat would claim the
        whole viewport and push the nav off the top.
      */}
      <body className="h-dvh flex flex-col overflow-hidden">
        <Nav />
        <main className="flex-1 min-h-0 flex flex-col">{children}</main>
        <Analytics />
      </body>
    </html>
  );
}
