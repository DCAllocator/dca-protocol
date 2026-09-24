import type { Metadata } from "next";
import { PlanDraftProvider } from "@/components/site/v3/PlanDraft";
import { MotionBoot } from "@/components/site/v3/motion";
import { SplashSkip } from "@/components/site/v3/shared";
import { NavV3 } from "@/components/site/v3/NavV3";
import { HeroV3 } from "@/components/site/v3/HeroV3";
import { Proof } from "@/components/site/v3/Proof";
import { StepsV3 } from "@/components/site/v3/StepsV3";
import { StocksV3 } from "@/components/site/v3/StocksV3";
import { DcaSection } from "@/components/site/v3/DcaSection";
import { BoostBand } from "@/components/site/v3/BoostBand";
import { Trust } from "@/components/site/v3/Trust";
import { FaqV3 } from "@/components/site/v3/FaqV3";
import { FinalCta } from "@/components/site/v3/FinalCta";
import { FooterV3 } from "@/components/site/v3/FooterV3";
import { StickyCta } from "@/components/site/v3/StickyCta";

const title = "The token that DCAs itself | DCA";
const description =
  "Pick a Robinhood Stock Token, an amount from $10 and a buy interval, and DCA buys it for you on Robinhood Chain. Hold at least the perk threshold in $DCA for half the purchase fee and every buy sent straight to your wallet.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary_large_image", title, description },
};

/**
 * The landing (v3): short and product-first. The hero shows a working copy of My plans, the plan builder in the steps
 * personalises the stock tiles, the closing band and the sticky mobile bar, and the $DCA section comes after the
 * stocks. Sections live in components/site/v3; the earlier product-first page is kept at /legacy.
 */
export default function Landing() {
  return (
    <PlanDraftProvider>
      <MotionBoot />
      <SplashSkip />
      <NavV3 />
      <main id="top" data-v3-page="" className="bg-surface-0">
        <HeroV3 />
        <Proof />
        <div id="how">
          <StepsV3 />
        </div>
        <StocksV3 />
        <DcaSection />
        <BoostBand />
        <Trust />
        <FaqV3 />
        <FinalCta />
      </main>
      <FooterV3 />
      <StickyCta />
    </PlanDraftProvider>
  );
}
