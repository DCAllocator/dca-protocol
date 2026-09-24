import Link from "next/link";
import { BuyDcaLink as BuyDca } from "@/components/BuyDcaLink";
import { PerkThreshold } from "@/components/site/Live";
import { PerksSplit } from "./shared";

/*
 * The hero's left column, a server component so the headline paints without JavaScript and never animates. It keeps
 * `#hero-h1` (the section's label) and `#hero-ctas` (the sticky mobile bar watches it).
 */
export function HeroCopy() {
  const threshold = <PerkThreshold perk="autoDistribute" compact />;
  return (
    <>
      <p className="eyebrow">$DCA · Robinhood Chain</p>
      {/* 44px under 380px keeps "The token that" on one line of a 360px phone; balanced so "itself." never sits alone */}
      <Headline size="text-[44px] text-balance min-[380px]:text-5xl" />
      <p className="mt-5 text-[22px] font-semibold tracking-tight text-balance text-ink">
        Wall Street stocks, automatically bought <span className="whitespace-nowrap">on-chain</span>.
      </p>
      <p className="lede mt-3 max-w-lg">
        DCA is an execution protocol for Robinhood Stock Tokens. Pick a stock and a frequency; it buys for you{" "}
        <span className="whitespace-nowrap">on-chain</span> and collects the stock within your plan. Hold $DCA to automatically collect the stock
        from the plan into your wallet.
      </p>
      {/* A line of microcopy under each button says what the click gets you. The holder line names the auto-distribute
          threshold, and drops "half the purchase fee" when the two perk thresholds differ (that balance alone would not
          halve it). */}
      <div id="hero-ctas" className="mt-8 grid w-max max-w-full grid-cols-[auto_auto] gap-x-3 gap-y-1.5">
        <BuyDca className="btn-primary btn-lg" />
        <Link href="/app/create" className="btn-secondary btn-lg">
          Start a plan
        </Link>
        <p className="max-w-[30ch] text-[12px] leading-snug text-ink-3">
          <PerksSplit
            same={<>Hold {threshold}: half the purchase fee, stock straight to your wallet</>}
            split={<>Hold {threshold}: stock straight to your wallet</>}
          />
        </p>
        <p className="max-w-[30ch] text-[12px] leading-snug text-ink-3">From $10 a buy · pay in USDG or ETH</p>
      </div>
      {/* The third badge answers the headline: it is the stem of the page's one buyback sentence ($DCA section, FAQ). */}
      <Badges items={["Non-custodial", "No lock-ups", "A share of every purchase fee buys $DCA"]} className="mt-7" />
    </>
  );
}

/** The H1: only "$DCA's" is lime, and it never breaks across lines. `size` is the phone size (and any wrap rule); md and up is text-6xl. */
function Headline({ size }: { size: string }) {
  return (
    <h1 id="hero-h1" className={`mt-4 ${size} font-semibold leading-[1.02] tracking-tight text-ink md:text-6xl`}>
      The token that <span className="whitespace-nowrap text-lime">$DCA's</span> itself.
      <br />
    </h1>
  );
}

function Badges({ items, className }: { items: string[]; className: string }) {
  return (
    <ul className={`flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-3 ${className}`}>
      {items.map((t) => (
        <li key={t} className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-lime" />
          {t}
        </li>
      ))}
    </ul>
  );
}
