import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Splash } from "@/components/Splash";
import { SPLASH_BOOTSTRAP } from "@/lib/splash";
import { THEME_BOOTSTRAP } from "@/lib/theme-bootstrap";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

/** Canonical origin for absolute share-card URLs on every route (the card is app/opengraph-image.tsx); http(s) only. */
const SITE_URL = /^https?:\/\//.test(process.env.NEXT_PUBLIC_SITE_URL ?? "") ? process.env.NEXT_PUBLIC_SITE_URL : undefined;

export const metadata: Metadata = {
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
  title: "DCA — Wall Street stocks. On a clock. On-chain.",
  description:
    "Recurring on-chain buys of Robinhood Stock Tokens on Robinhood Chain. $DCA is the protocol's token, and a share of every purchase fee buys it on-chain.",
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
