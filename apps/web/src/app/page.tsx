import type { Metadata } from "next";
import { PlanDraftProvider } from "@/components/site/landing/PlanDraft";
import { MotionBoot } from "@/components/site/landing/motion";
import { SplashSkip } from "@/components/site/landing/shared";
import { Nav } from "@/components/site/landing/Nav";
import { Hero } from "@/components/site/landing/Hero";
import { Proof } from "@/components/site/landing/Proof";
import { Steps } from "@/components/site/landing/Steps";
import { Stocks } from "@/components/site/landing/Stocks";
import { DcaSection } from "@/components/site/landing/DcaSection";
import { BoostBand } from "@/components/site/landing/BoostBand";
import { Trust } from "@/components/site/landing/Trust";
import { Faq } from "@/components/site/landing/Faq";
import { FinalCta } from "@/components/site/landing/FinalCta";
import { Footer } from "@/components/site/landing/Footer";
import { StickyCta } from "@/components/site/landing/StickyCta";

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
 * The landing: short and product-first. The hero shows a working copy of My plans, the plan builder in the steps
 * personalises the stock tiles, the closing band and the sticky mobile bar, and the $DCA section comes after the
 * stocks. Sections live in components/site/landing.
 */
export default function Landing() {
  return (
    <PlanDraftProvider>
      <MotionBoot />
      <SplashSkip />
      <Nav />
      <main id="top" data-lp-page="" className="bg-surface-0">
        <Hero />
        <Proof />
        <div id="how">
          <Steps />
        </div>
        <Stocks />
        <DcaSection />
        <BoostBand />
        <Trust />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
      <StickyCta />
    </PlanDraftProvider>
  );
}
