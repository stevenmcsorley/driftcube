import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AppChrome } from "../components/AppChrome";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "DriftCube",
  description: "AI code observability for semantic drift, complexity creep, and architecture decay.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable}`}>
        <div className="app-frame">
          <AppChrome />
          <div className="app-content">{children}</div>
        </div>
      </body>
    </html>
  );
}
