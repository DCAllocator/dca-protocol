"use client";

import Link from "next/link";
import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { useAccount } from "wagmi";
import { useDirectory, useUser } from "@/hooks/useProtocol";
import { BuyDcaLink } from "@/components/BuyDcaLink";
import { Logo } from "@/components/Logo";
import { Dot } from "@/components/ui";
import { CaChip } from "./Chips";
import { DOCS_PATH, isZero } from "@/lib/config";
import { FeeLoop } from "./FeeLoop";
import { Reveal, useInView, useMounted, usePointerTilt, useReducedMotion } from "./motion";
import { ChartLink, PerksSplit, Threshold, useFeeReceiverHref, usePerks } from "./shared";
import "./dca.css";

/*
 * The $DCA section. Row A sells the holder perks as an automatic unlock and puts Buy $DCA next to them; Row B decodes
 * the H1 with one mechanism sentence, the explorer link and the loop. Nothing here reads a buyback amount, a reserve
 * or a price: the only live values are the perk thresholds, the connected wallet's own $DCA balance (status line) and
 * the fee receiver's address (explorer link). On phones the columns interleave (cards straight after the sub, the
 * footnote after the loop) through `display: contents` and `order`, so there is one DOM for every width.
 */

type Vars = CSSProperties & Record<`--${string}`, string | number>;

export function DcaSection() {
  const buybacks = useFeeReceiverHref();
  return (
    <section id="dca" className="overflow-hidden border-y border-line bg-surface-2">
      <div className="container-x py-20">
        {/* Row A: the perks */}
        <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[5fr_7fr] lg:items-center lg:gap-10">
          <div className="contents lg:block">
            <Reveal stagger className="order-1">
              <p className="eyebrow">$DCA</p>
              <h2 className="h-section mt-3">Hold $DCA. Pay less.</h2>
              <p className="lede mt-3 max-w-md">
                <PerksSplit
                  same={
                    <>
                      Hold at least <Threshold /> in the wallet that owns your plans, and two perks switch on for every plan.
                    </>
                  }
                  split={
                    <>
                      Hold at least <Threshold perk="feeHalve" /> for half the purchase fee, and <Threshold /> for stock sent straight to your
                      wallet.
                    </>
                  }
                />
              </p>
            </Reveal>
            <Actions />
          </div>
          <PerkCards />
        </div>

        {/* Row B: the mechanism */}
        <div className="mt-16 flex flex-col gap-10 border-t border-line pt-14 lg:grid lg:grid-cols-[5fr_7fr] lg:items-center">
          <div className="contents lg:block">
            <Reveal className="order-1">
              <h3 className="text-2xl font-semibold tracking-tight text-balance text-ink md:text-3xl">You DCA stocks. $DCA DCAs itself.</h3>
              {/* "on-chain." kept whole: a break at its hyphen ("on- / chain.") read as a typo at some widths */}
              <p className="lede mt-3 max-w-md">
                A share of every purchase fee buys $DCA <span className="whitespace-nowrap">on-chain.</span> As the protocol is used, $DCA is bought back
                over time.
              </p>
              {buybacks && (
                <a href={buybacks} target="_blank" rel="noreferrer" className="mt-4 inline-block text-[13px] text-lime-text hover:underline">
                  See every buyback on the explorer ↗
                </a>
              )}
            </Reveal>
            <p className="order-3 text-[12px] leading-relaxed text-ink-3 lg:mt-6">
              $DCA is a protocol utility token. It is not equity, a security, or a promise of returns.
            </p>
          </div>
          <Reveal className="order-2">
            <FeeLoop />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/**
 * Buy $DCA, the CA chip, the connected wallet's status and the fees link. Desktop order: CTA row, status, fees link;
 * on phones the fees link moves up under the cards it explains.
 */
function Actions() {
  return (
    <div className="order-3 flex flex-col items-start">
      <div className="flex w-full flex-wrap items-center gap-3 max-sm:justify-center lg:mt-8">
        <BuyDcaLink className="btn-primary btn-lg max-sm:w-full" />
        <CaChip />
        <ChartLink className="text-[13px] text-ink-2 hover:text-ink" />
      </div>
      <p className="mt-3 text-[13px] text-balance text-ink-2 max-sm:self-stretch max-sm:text-center sm:-indent-3.5 sm:pl-3.5 lg:min-h-[1.25em]">
        <PerkStatus />
      </p>
      <Link href={`${DOCS_PATH}#fees`} className="text-[13px] text-lime-text hover:underline max-lg:order-first max-lg:mb-5 lg:mt-4 lg:inline-block">
        How fees work →
      </Link>
    </div>
  );
}

/**
 * "Your wallet holds at least 100,000 $DCA. Perks are on." for the connected wallet, compared with the auto-distribute
 * threshold. Hidden with no wallet, before $DCA is deployed, while the balance loads, and when the two thresholds
 * differ (one line cannot describe both perks then). Mount-gated so the server and first client render agree.
 */
function PerkStatus() {
  const mounted = useMounted();
  const { address } = useAccount();
  const { dir } = useDirectory();
  const { dca } = useUser(dir);
  const { autoDistribute, split } = usePerks();
  if (!mounted || !address || !dir || isZero(dir.dca) || dca === undefined || split) return null;
  const on = dca >= autoDistribute;
  // The dot flows inline with the text, so a wrapped (or centred, on phones) line keeps it beside the first word.
  return (
    <>
      <span className="relative -top-px mr-2 inline-flex align-middle">
        <Dot tone={on ? "good" : "muted"} />
      </span>
      {on ? <>Your wallet holds at least <Threshold />. Perks are on.</> : <>Your wallet is on Standard. Hold <Threshold /> to switch the perks on.</>}
    </>
  );
}

/**
 * Standard beside Holder (Holder first on phones). The pair rises in a 70ms stagger once half of it is on screen, and
 * the same `data-in` plays the Holder card's single sheen (`.v3-sheen-once`), so the sweep lands on a card in view.
 */
function PerkCards() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, threshold: 0.45 });
  return (
    <div
      ref={ref}
      data-in={inView ? "" : undefined}
      className="v3-reveal v3-reveal-stagger order-2 grid gap-4 sm:grid-cols-[1fr_1.25fr] sm:items-stretch"
    >
      <div className="v3-reveal-item flex" style={{ "--i": 0 } as Vars}>
        <StandardCard />
      </div>
      <div className="v3-reveal-item flex max-sm:order-first" style={{ "--i": 1 } as Vars}>
        <HolderCard />
      </div>
    </div>
  );
}

function StandardCard() {
  return (
    <div className="flex w-full flex-col rounded-2xl border border-line bg-surface-1 p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase sm:text-[11px]">Standard</span>
        <span className="chip num ml-auto max-sm:text-[12px]">
          Below <Threshold compact />
        </span>
      </div>
      <p className="mt-5 text-[18px] leading-tight font-semibold tracking-tight text-balance text-ink-2 sm:mt-8 sm:text-[22px]">
        <span className="block">
          {/* the tag is the auto-distribute threshold; with a lower fee-halve threshold the fee halves before it */}
          <PerksSplit
            same="Full purchase fee."
            split={
              <>
                Full purchase fee below <Threshold perk="feeHalve" compact />.
              </>
            }
          />
        </span>
        <span className="block">Stock waits in your plan.</span>
      </p>
      <p className="mt-auto pt-4 text-[12.5px] text-ink-3 sm:pt-6">Claim it any time, for a small fee.</p>
    </div>
  );
}

/**
 * The screenshot card: fixed dark in both themes (`.v3-pass`), lime edge and glow, a hairline grid, pointer tilt up to
 * 4° and a soft light under the pointer (fine pointers, motion allowed).
 */
function HolderCard() {
  const ref = useRef<HTMLDivElement>(null);
  usePointerTilt(ref, 4);
  usePointerGlare(ref);
  return (
    <div ref={ref} className="v3-pass v3-sheen-once v3-dca-holder @container flex w-full flex-col p-6">
      <span aria-hidden className="v3-dca-glare" />
      <div className="relative flex items-center gap-2.5">
        <Logo size={22} />
        <span className="font-mono text-[12px] tracking-[0.14em] uppercase sm:text-[11px]">Holder</span>
        <span className="num ml-auto rounded-full bg-lime px-2.5 py-1 text-[12px] font-semibold text-lime-ink">
          ≥ <Threshold compact />
        </span>
      </div>
      {/* Sized to the card (9.4cqi keeps "Half the purchase fee." on one line at any width), 22px to 30px. */}
      <p className="relative mt-8 text-[clamp(22px,9.4cqi,30px)] leading-[1.1] font-semibold tracking-tight">
        <span className="block">
          <PerksSplit
            same="Half the purchase fee."
            split={
              <>
                Half the purchase fee from <Threshold perk="feeHalve" compact />.
              </>
            }
          />
        </span>
        <span className="mt-1.5 block text-balance">
          Stock <span className="v3-pass-lime v3-dca-glow">straight to your wallet</span>.
        </span>
      </p>
      <div className="relative mt-auto flex items-end justify-between gap-4 pt-8">
        <p className="v3-pass-ink-2 text-[12px] leading-relaxed">
          <span className="block">Every plan, every buy.</span>
          <span className="block">Nothing to claim.</span>
        </p>
        {/* the mark shrinks with the card (40px at full size) so the foot keeps one line per sentence */}
        <span aria-hidden className="v3-pass-mark shrink-0 text-[clamp(30px,13cqi,40px)] font-bold">
          $DCA
        </span>
      </div>
    </div>
  );
}

/** Sets --gx / --gy (percent) on `ref` from the pointer, for `.v3-dca-glare`. Fine pointers only, off under reduced motion. */
function usePointerGlare<T extends HTMLElement>(ref: RefObject<T | null>) {
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--gx", `${x.toFixed(1)}%`);
        el.style.setProperty("--gy", `${y.toFixed(1)}%`);
      });
    };
    el.addEventListener("pointermove", move);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", move);
    };
  }, [ref, reduced]);
}
