"use client";

import { BoostShowcase } from "@/components/site/BoostShowcase";
import { useBoostApys, useDirectory, useVaults, boostAvailable } from "@/hooks/useProtocol";
import { BOOST } from "@/lib/config";
import { Reveal } from "./motion";

/*
 * Boost as a short secondary band: the heading beside the landing's existing Boost card (BoostTeaser, i.e.
 * BoostShowcase with the live Morpho APY), whose own timeline, risk disclaimer and CTA come with it. No new Boost copy:
 * the heading is BOOST.title.
 */

/** Eyebrow + "Earn while you wait." beside the Boost card; `#boost` (landing.css wraps the card's head on the narrowest phones). */
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

/**
 * The landing's Boost card, with the live Morpho supply APY of the first vault that has a boost strategy (they lend
 * into the same USDG market). Drawn by BoostShowcase in the Boost dialog's celebration style.
 */
function BoostTeaser() {
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);
  const { apyOf } = useBoostApys(infos);
  const withBoost = infos.find(boostAvailable);
  return <BoostShowcase apy={apyOf(withBoost?.boostStrategy)} />;
}
