"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BoostMark, BoostStamp, Odometer } from "@/components/app/BoostCelebration";
import "./BoostShowcase.css";
import { Icon } from "@/components/ui";
import { BOOST, DOCS_PATH } from "@/lib/config";
import { fmtPct } from "@/lib/format";

/*
 * The landing page's Boost section, drawn in the Boost dialog's register (components/app/BoostCelebration.tsx): the
 * same mark, plate, odometer, tokens and keyframes, so the moment a visitor sees here is the one they get when they
 * boost a plan. The card is server-rendered in the celebration's done state with every animation paused on its first
 * frame (the armed mark). When the stage is on screen the timeline runs once: the gauge charges and discharges, the
 * BOOST plate slams in over the plain title, the live APY rises and rolls up like an odometer, and the lime edge of a
 * boosted plan row ignites with the discharge. Then it idles as the dialog does, and pauses whenever it is scrolled
 * away. It also waits out the first-load splash, and its idle is finite: after about 20 s of screen time the mark rests
 * charged. With reduced motion it is the charged card from the first paint. BoostShowcase.css has the details.
 *
 * Everything drawn is aria-hidden. The heading, the rate and the copy are plain text for screen readers.
 */

/** Share of the stage on screen before the charge plays (and the idle resumes after the stage was scrolled away). */
const PLAY_AT = 0.75;
/** When the hero's line rises, in ms after the charge starts (`.boost-line` in BoostCelebration.css). */
const LINE_AT = 900;
/** A roll delay far enough in the past that the strip is already parked on its digit (the longest roll is 720 ms). */
const PARKED = -1000;

/**
 * When a digit strip that mounts now should start its roll, in ms from its mount. The line's rise is the clock: it
 * only advances while the stage plays (it is paused off-screen and under the splash, like everything else here), so a
 * strip keyed to it rolls exactly as the line rises however long the visitor was away. Once the line has risen its
 * animation is gone: a strip that lands in view rolls at once, one that lands while the stage is paused arrives parked,
 * so the visitor never scrolls back to a "0.00%".
 */
function rollDelay(line: HTMLElement | null, live: boolean): number {
  const rise =
    line && typeof line.getAnimations === "function"
      ? line.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "boost-rise")
      : undefined;
  if (!rise) return live ? 0 : PARKED;
  const t = typeof rise.currentTime === "number" ? rise.currentTime : 0;
  // Playing, a strip that missed its cue rolls in full from now; paused, it keeps step with the line so both resume together.
  return live ? Math.max(0, Math.round(LINE_AT - t)) : Math.round(LINE_AT - t);
}

/** `apy`: the live Morpho Blue USDG supply APY as a fraction (0.0412), undefined while it loads or with no strategy. */
export function BoostShowcase({ apy }: { apy?: number }) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const play = () => setLive(true);
    if (typeof IntersectionObserver === "undefined") {
      play();
      return;
    }
    // Two thresholds give it hysteresis: it plays (or resumes) once most of the stage is in view, and pauses only
    // when none of it is. The ratio can land a hair under a threshold as it crosses, hence the 2% slack.
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (e.intersectionRatio >= PLAY_AT * 0.98) play();
        else if (!e.isIntersecting) setLive(false);
      },
      { threshold: [0, PLAY_AT] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const known = apy !== undefined && isFinite(apy);
  /** The exact figure for screen readers; the odometer shows the celebration's "~4.12%" (the rate is variable). */
  const rate = known ? fmtPct(apy) : undefined;
  // The rate usually loads before the section is reached, so its digits wait, paused, and roll with the line at
  // LINE_AT. A strip that mounts later (the rate loaded after the charge began, or a refresh added a digit) would
  // otherwise sit on "0" for a full LINE_AT from its own mount, so each new strip gets its own delay from
  // `rollDelay`. It is set on the strip, not the card, so strips already running keep their timing. Before paint, so
  // the first frame is right.
  useLayoutEffect(() => {
    const el = root.current;
    if (!rate || !el) return;
    const fresh = [...el.querySelectorAll<HTMLElement>(".boost-roll")].filter((s) => !s.style.getPropertyValue("--boost-show-roll"));
    if (!fresh.length) return;
    const delay = `${rollDelay(line.current, el.hasAttribute("data-live"))}ms`;
    for (const s of fresh) s.style.setProperty("--boost-show-roll", delay);
  }, [rate]);

  return (
    <div ref={root} className="boost-show flex flex-col overflow-hidden rounded-xl border border-line bg-surface-1" data-live={live ? "" : undefined}>
      {/* the stage carries the boosted wash (`boost-summary`), as a boosted row's Plan cell does; the copy stays plain */}
      <div ref={stage} className="boost-hero boost-show-stage boost-summary" data-status="done">
        <span className="boost-flare" aria-hidden />
        <BoostMark charged />
        <div className="boost-show-copy">
          <div className="boost-show-head">
            <h3 className="boost-show-word">
              <span className="sr-only">{BOOST.name}</span>
              <span className="boost-title boost-title-out" aria-hidden>
                {BOOST.name}
              </span>
              <BoostStamp label={BOOST.name} />
            </h3>
            <span className="chip">optional · per plan</span>
          </div>
          <p ref={line} className="boost-show-line">
            <span className="sr-only">Live USDG supply APY on Morpho Blue: {rate ?? "not available yet"}. The rate is variable.</span>
            <span className="boost-show-rate" aria-hidden>
              {rate ? (
                <span className="boost-show-apy num text-good">
                  <Odometer text={fmtPct(apy, true)} />
                </span>
              ) : (
                <span className="boost-show-apy num text-ink-3">—</span>
              )}
              APY
            </span>
            <span className="boost-show-label" aria-hidden>
              <i />
              USDG supply on Morpho Blue · live, variable
            </span>
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 border-t border-line p-5">
        <p className="text-[14px] leading-relaxed text-ink-2">
          Between buys, a plan&apos;s USDG sits idle. Boost lends it on Morpho Blue in the meantime and pulls it back automatically at every buy and
          withdrawal. No fee on the yield.
        </p>
        <p className="text-[12.5px] leading-normal text-ink-3">
          <strong className="font-semibold text-ink-2">Disclaimer:</strong> boosted balances are a Morpho supply position and carry that market&apos;s
          risk, including withdrawals waiting on liquidity and shared bad debt. They are not insured.{" "}
          <Link href={`${DOCS_PATH}#boost`} className="text-lime hover:underline">
            Read the risks
          </Link>
        </p>
        {/* Boost is off by default on the create form, where its switch is titled BOOST.title, so the link promises a
            plan and the hint names the switch rather than claiming the plan arrives boosted. */}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1.5">
          <Link href="/app/create" className="btn-secondary btn-xs">
            <Icon name="bolt" size={13} className="text-lime" />
            Start a plan
          </Link>
          <span className="text-[12px] leading-normal text-ink-3">Boost is the &ldquo;{BOOST.title}&rdquo; switch on the plan form.</span>
        </div>
      </div>
    </div>
  );
}
