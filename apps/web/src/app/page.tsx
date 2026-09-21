import { LandingNav, Hero, Pillars, Flywheel, HoldPerk, Protocol, Stocks, LandingFaq, LandingCta, LandingFooter } from "@/components/site/Landing";
import { LandingStats } from "@/components/site/LandingLive";

/** Token-first landing. The previous product-first landing is kept at /legacy for comparison. */
export default function Landing() {
  return (
    <main className="bg-surface-0">
      <LandingNav />
      <Hero />
      <div className="container-x">
        <LandingStats />
      </div>
      <Pillars />
      <Flywheel />
      <HoldPerk />
      <Protocol />
      <Stocks />
      <LandingFaq />
      <LandingCta />
      <LandingFooter />
    </main>
  );
}
