"use client";

import { useEffect, useRef, useState } from "react";

/*
 * First-load splash. The markup is server-rendered and hidden by default; the <head> bootstrap (lib/splash.ts)
 * opts a load in with <html data-splash="on"> before first paint, so the intro plays from the first frame.
 * Everything that moves is a CSS transform/opacity animation (globals.css, "first-load splash"), which keeps it
 * smooth while the main thread parses and hydrates. Once hydrated, this waits for the page to finish loading,
 * lets the coin row settle between ticks, then sets data-splash="out" for the iris reveal and unmounts.
 */

/** Past this (ms since navigation start) the splash leaves even if the page is still loading. */
const MAX_WAIT_MS = 5000;
/** Fallback in case the exit's animationend never fires (e.g. a background tab). */
const EXIT_FALLBACK_MS = 1500;

const TICKERS = ["NVDA", "SPY", "TSLA", "AAPL", "GLD", "COST"];

/**
 * ms until the coin row is at rest with the intro and at least one tick played, read off the running
 * splash-tick animation so the timings live only in the CSS. The move takes the first 55% of each tick.
 */
function untilSettled(root: HTMLElement | null): number {
  const anim = root?.querySelector(".splash-strip")?.getAnimations()[0];
  const now = anim?.currentTime;
  const { delay = 0, duration } = anim?.effect?.getTiming() ?? {};
  if (typeof now !== "number" || typeof duration !== "number") return 0;
  const settled = duration * 0.6;
  let target = Math.max(now, delay + settled);
  const phase = (target - delay) % duration;
  if (phase < settled) target += settled - phase;
  return target - now;
}

export function Splash() {
  const ref = useRef<HTMLDivElement>(null);
  const leave = useRef(() => {});
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    if (html.dataset.splash !== "on") {
      setGone(true);
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>((r) => timers.push(window.setTimeout(r, Math.max(0, ms))));
    const finish = () => {
      delete html.dataset.splash;
      setGone(true);
    };
    leave.current = () => {
      if (html.dataset.splash !== "on") return;
      html.dataset.splash = "out";
      ref.current?.addEventListener("animationend", (e) => e.target === e.currentTarget && finish());
      timers.push(window.setTimeout(finish, EXIT_FALLBACK_MS));
    };

    const loaded =
      document.readyState === "complete" ? Promise.resolve() : new Promise<void>((r) => window.addEventListener("load", () => r(), { once: true }));
    Promise.race([Promise.all([loaded, document.fonts.ready]), wait(MAX_WAIT_MS - performance.now())])
      .then(() => wait(untilSettled(ref.current)))
      .then(() => !cancelled && leave.current());

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  if (gone) return null;
  return (
    // Decorative, and gone within a couple of seconds; a tap skips it once the app has hydrated.
    <div ref={ref} className="splash" aria-hidden onPointerDown={() => leave.current()}>
      <div className="splash-stage">
        <div className="splash-glow" />
        <div className="splash-badge">
          <div className="splash-coins">
            <div className="splash-strip">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="splash-coin" />
              ))}
            </div>
          </div>
        </div>
        <div className="splash-meta">
          <div className="splash-ticker">
            <ul className="splash-tape">
              {[...TICKERS, TICKERS[0]].map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="splash-track">
            <div className="splash-bar" />
          </div>
        </div>
      </div>
    </div>
  );
}
