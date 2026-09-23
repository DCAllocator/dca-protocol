import type { Metadata } from "next";
import "@/components/site/v2/v2.css";
import { V2Nav, V2Hero, V2Manifesto, V2Constants, V2Burn, V2Hold, V2Protocol, V2Stocks, V2Trust, V2Faq, V2Cta, V2Footer } from "@/components/site/v2/Sections";

export const metadata: Metadata = {
  title: "DCA — Every fee burns $DCA. Wall Street, bought on a clock.",
  description:
    "Recurring on-chain buys of Robinhood Stock Tokens on Robinhood Chain. 30% of every fee is swapped into $DCA and burned in the same transaction. Fixed supply. Public counter.",
};

/**
 * /v2 — the token-first, verification-below-the-fold landing (marketing pass, Sept 2026). The current landing stays
 * at / and the product-first original at /legacy so the three can be compared side by side.
 */
export default function LandingV2() {
  return (
    <main className="bg-surface-0">
      <V2Nav />
      <V2Hero />
      <V2Manifesto />
      <V2Constants />
      <V2Burn />
      <V2Hold />
      <V2Protocol />
      <V2Stocks />
      <V2Trust />
      <V2Faq />
      <V2Cta />
      <V2Footer />
    </main>
  );
}
