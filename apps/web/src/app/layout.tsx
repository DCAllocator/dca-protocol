import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Splash } from "@/components/Splash";
import { SPLASH_BOOTSTRAP } from "@/lib/splash";
import { THEME_BOOTSTRAP } from "@/lib/theme-bootstrap";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "DCA — Wall Street stocks. On a clock. On-chain.",
  description:
    "Recurring on-chain buys of Robinhood Stock Tokens on Robinhood Chain, delivered to your wallet. $DCA is the protocol's token — and what the protocol's fees buy back.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme and data-splash are written by the bootstrap scripts before paint (lib/theme-bootstrap.ts,
    // lib/splash.ts), so the server's <html> and the hydrated one legitimately differ by those attributes.
    <html lang="en" data-scroll-behavior="smooth" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <script dangerouslySetInnerHTML={{ __html: SPLASH_BOOTSTRAP }} />
      </head>
      <body>
        <Splash />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
