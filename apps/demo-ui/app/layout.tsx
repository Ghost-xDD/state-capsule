import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "State Capsule — Maintainer Swarm",
  description: "AI agents collaborating on your GitHub repo, anchored to 0G",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-canvas text-zinc-100 min-h-screen font-sans antialiased selection:bg-indigo-500/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}
