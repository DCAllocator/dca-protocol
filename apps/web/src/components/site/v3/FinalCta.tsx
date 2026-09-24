"use client";

import Link from "next/link";
import { useRef } from "react";
import { BuyDcaLink } from "@/components/BuyDcaLink";
import { Icon } from "@/components/ui";
import { usePlanDraft } from "./PlanDraft";
import { CaChipOnLime, PerksSplit, Threshold } from "./shared";
import { Reveal, useScrollProgress } from "./motion";
import "./faq-final.css";

/*
 * The lime closing band (#start): restates the promise and closes with two real buttons. When the visitor built a plan
 * in the Three steps builder, the band says it back ("Your plan: $50 of NVDA every week.") and the filled button opens
 * Create plan on it. Lime and lime-ink are fixed colours (never `text-lime`, which turns olive on light), so the band
 * looks the same in both themes; a faint outlined "$DCA" drifts behind it as the band crosses the viewport.
 */

/** Filled on lime. `text-[color:…]` rather than `text-lime`, which the light theme remaps to the darker accent. */
const PRIMARY = "btn btn-lg w-full bg-lime-ink text-[color:var(--color-lime)] hover:opacity-90 sm:w-auto lg:min-w-60";
/**
 * Outlined on lime, full size (never demoted to a text link). Opaque lime fill (and an opaque hover tint), so the ghost
 * wordmark's outline never runs through the label.
 */
const SECONDARY =
  "btn btn-lg w-full border border-lime-ink/40 bg-lime text-lime-ink hover:bg-[color-mix(in_srgb,var(--color-lime-ink)_10%,var(--color-lime))] sm:w-auto lg:min-w-60";

export function FinalCta() {
  const band = useRef<HTMLElement>(null);
  useScrollProgress(band);
  const { draft, href, sentence } = usePlanDraft();
  const touched = draft.touched;

  const ticks = [
    "Stocks bought for you on schedule, from $10 a buy",
    "A share of every purchase fee buys $DCA on-chain",
    <PerksSplit
      key="perks"
      same={
        <>
          Hold <Threshold perk="autoDistribute" compact />: half the purchase fee, and stock sent straight to your wallet
        </>
      }
      split={
        <>
          Hold <Threshold perk="autoDistribute" compact />: stock sent straight to your wallet
        </>
      }
    />,
  ];

  return (
    <section ref={band} id="start" className="v3-final v3-onlime-focus relative overflow-hidden bg-lime text-lime-ink">
      <div
        aria-hidden
        className="v3-final-ghost v3-ghost-onlime pointer-events-none absolute right-0 -bottom-[0.18em] text-[34vw] leading-none font-bold whitespace-nowrap lg:text-[22vw]"
      >
        $DCA
      </div>

      <div className="container-x relative grid gap-10 py-20 lg:grid-cols-[1.2fr_1fr] lg:items-end">
        <div>
          <h2 className="text-[34px] leading-[1.05] font-semibold tracking-tight text-balance sm:text-4xl md:text-5xl">Your first buy is one deposit away.</h2>
          {touched && <p className="mt-3 text-[18px] font-medium">Your plan: {sentence}.</p>}
          <Reveal stagger className="v3-final-ticks mt-6 grid gap-2.5 text-[15px]">
            {ticks.map((t, i) => (
              <p key={i} className="flex items-start gap-2.5">
                <Icon name="check" size={16} className="mt-[3px] shrink-0" />
                <span>{t}</span>
              </p>
            ))}
          </Reveal>
        </div>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:flex-col lg:items-end">
          <Link href={touched ? href : "/app/create"} className={PRIMARY}>
            {touched ? "Start this plan" : "Start a plan"}
          </Link>
          <BuyDcaLink className={SECONDARY} />
          {/* Opaque lime behind the (transparent) chip, so the ghost's outline never runs through the address. */}
          <div className="mt-1 inline-flex self-start rounded-md bg-lime sm:mt-0 sm:self-auto lg:mt-1">
            <CaChipOnLime />
          </div>
        </div>
      </div>
    </section>
  );
}
