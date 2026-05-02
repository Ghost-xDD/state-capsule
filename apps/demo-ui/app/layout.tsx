import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "State Capsule — MaintainerSwarm",
  description: "AI agents collaborating on your GitHub repo using 0G Storage",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen font-mono antialiased">
        {children}
      </body>
    </html>
  );
}
