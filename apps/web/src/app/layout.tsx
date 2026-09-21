import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { THEME_BOOTSTRAP } from "@/lib/theme-bootstrap";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "DCA — Buy stocks on a clock",
  description:
    "Scheduled on-chain purchases of Robinhood Stock Tokens on Robinhood Chain. Daily, weekly or monthly vaults. Deposit USDG or ETH, get stock every epoch.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is written by the bootstrap script before paint (see lib/theme-bootstrap.ts), so the server's
    // <html> and the hydrated one legitimately differ by that one attribute.
    <html lang="en" data-scroll-behavior="smooth" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
