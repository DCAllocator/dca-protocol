"use client";

import { BoostTeaser } from "@/components/site/LandingLive";
import { BOOST } from "@/lib/config";
import { Reveal } from "./motion";

/*
 * Boost as a short secondary band: the heading beside the landing's existing Boost card (BoostTeaser, i.e.
 * BoostShowcase with the live Morpho APY), whose own timeline, risk disclaimer and CTA come with it. No new Boost copy:
 * the heading is BOOST.title.
 */

/** Eyebrow + "Earn while you wait." beside the Boost card; `#boost` (v3.css wraps the card's head on the narrowest phones). */
export function BoostBand() {
  return (
    <section id="boost" className="container-x grid gap-8 py-16 lg:grid-cols-[5fr_7fr] lg:items-center">
      <Reveal>
        <p className="eyebrow">Boost</p>
        <h2 className="h-section mt-3">{BOOST.title}.</h2>
      </Reveal>
      <div className="max-w-[640px] min-w-0">
        <BoostTeaser />
      </div>
    </section>
  );
}
