"use client";

import type { CSSProperties } from "react";
import "./BoostCelebration.css";
import type { TxHero } from "@/components/app/TxFlowDialog";
import { BOOST } from "@/lib/config";
import { fmtPct } from "@/lib/format";

/*
 * The Boost dialog's header ("Power surge"), drawn by TxFlowDialog's `hero` slot in every state, so the card keeps its
 * height from the first frame to the last. While the transaction is in the wallet or on the network, the mark sits
 * armed: a dim disc and grey bolt in an unlit gauge, with one lime comet chasing round the track. When it confirms, the
 * gauge charges (it fills clockwise on an ease-in while twelve ticks light faster and faster, motes are drawn in, the
 * bolt flickers warm and the mark strains), then squats and discharges: a flash, a lens flare across the header, two
 * shockwaves and a spark burst. It lands as the lime disc. The running title is blown away as a slanted BOOSTED plate
 * slams in, leaves an echo and catches a sheen, and the line rises with its APY rolling up like an odometer. From
 * about 1.6 s it idles: the glow breathes and a bright arc circles the charged ring (the balance is earning).
 *
 * Timings live in BoostCelebration.css (its header comment has the timeline). This file mirrors only what depends on them: CHARGE_MS and DISCHARGE_AT
 * (the tick, mote, spark and ember delays) and the odometer's per-digit durations. Motion is transform and opacity
 * only (plus the gauge's stroke-dashoffset for 560 ms). Every resting style is the end state, so with reduced motion
 * the done header simply cross-fades to "charged". The heading is the dialog's h2 (`titleId`): visible while running,
 * visually hidden once the plate carries the word. Everything decorative is aria-hidden, and the dialog's own status
 * region announces the outcome.
 */

/** The gauge fills over CHARGE_MS on an ease-in (≈ t²); tick i lights as the fill passes it. */
const CHARGE_MS = 560;
/** When the charge lets go (flash, flare, waves, sparks, the lime disc). Keep in step with BoostCelebration.css. */
const DISCHARGE_AT = 620;

const TICKS = Array.from({ length: 12 }, (_, i) => ({
  angle: 15 + i * 30,
  delay: Math.round(CHARGE_MS * Math.sqrt((i + 0.5) / 12)),
}));
/** Motes drawn into the ring during the charge: [angle°, delay ms]. Each lasts 260 ms, so the last lands at 600. */
const MOTES: [number, number][] = [
  [20, 20],
  [140, 80],
  [260, 150],
  [80, 220],
  [200, 290],
  [320, 340],
];
/** Discharge streaks: [angle°, travel px, delay after the discharge ms]. Shorter near 12 o'clock, so they fade inside the card. */
const SPARKS: [number, number, number][] = [
  [8, 42, 0],
  [52, 50, 20],
  [96, 54, 5],
  [141, 48, 25],
  [187, 46, 10],
  [229, 52, 30],
  [274, 54, 15],
  [318, 48, 35],
];
/** Slower embers that drift further out: [angle°, travel px, delay after the discharge ms]. */
const EMBERS: [number, number, number][] = [
  [62, 58, 30],
  [146, 54, 60],
  [214, 56, 40],
  [298, 58, 70],
];

type Vars = CSSProperties & Record<`--${string}`, string>;

/** The app's bolt (Icon "bolt"), drawn here so each layer can size and colour it on its own. */
function Bolt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden focusable="false">
      <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor" />
    </svg>
  );
}

/** A head over a faint tail on the gauge's track: the running chase and the idle orbit. */
function Comet({ className }: { className: string }) {
  return (
    <span className={className}>
      <svg viewBox="0 0 76 76" focusable="false">
        <circle cx="38" cy="38" r="29" pathLength={100} transform="rotate(-90 38 38)" />
        <circle cx="38" cy="38" r="29" pathLength={100} transform="rotate(-90 38 38)" />
      </svg>
    </span>
  );
}

/**
 * "~4.12%" with each digit on an odometer strip that rolls up from 0 when the line rises: the last digit makes two
 * extra turns and the one before it one, so they settle left to right. At rest (and with reduced motion) each strip is
 * parked on its digit.
 */
function Odometer({ text }: { text: string }) {
  const chars = [...text];
  const digits = chars.filter((c) => c >= "0" && c <= "9").length;
  let k = 0;
  return (
    <span className="boost-apy">
      {chars.map((c, i) => {
        if (c < "0" || c > "9") return <span key={i}>{c}</span>;
        const turns = Math.max(0, k++ - (digits - 3));
        const n = turns * 10 + Number(c);
        return (
          <span key={i} className="boost-odo">
            <span className="boost-roll" style={{ "--boost-n": String(n), animationDuration: `${480 + 120 * turns}ms` } as Vars}>
              {Array.from({ length: n + 1 }, (_, j) => (
                <span key={j}>{j % 10}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function BoostCelebration({
  status,
  titleId,
  titles,
  line,
  amount,
  apy,
  label = BOOST.chip,
}: TxHero & {
  /** The balance now lent, formatted ("$500.00"): the mined figure once the receipt is read, else the order's. Omitted when nothing was idle. */
  amount?: string;
  /** Morpho Blue supply APY as a fraction (0.0412); omitted while it loads. */
  apy?: number;
  /** The plate's word; BOOST.chip ("Boosted") by default. */
  label?: string;
}) {
  const done = status === "done";
  return (
    <div className="boost-hero" data-status={status}>
      {done && <span className="boost-flare" aria-hidden />}
      <div className="boost-cluster" aria-hidden>
        {done && (
          <>
            <span className="boost-glow" />
            <span className="boost-wave" />
            <span className="boost-wave boost-wave-2" />
          </>
        )}
        <svg className="boost-gauge" viewBox="0 0 76 76" focusable="false">
          <circle cx="38" cy="38" r="29" className="boost-track" />
          {done && <circle cx="38" cy="38" r="29" pathLength={100} transform="rotate(-90 38 38)" className="boost-meter" />}
        </svg>
        {/* twelve ticks: unlit while armed; once done each lights as the gauge passes it, then they fire outward */}
        <svg className="boost-ticks" viewBox="0 0 76 76" focusable="false">
          {TICKS.map((t) => (
            <g key={t.angle} transform={`rotate(${t.angle} 38 38)`}>
              <line x1="38" y1="2.5" x2="38" y2="5" className="boost-tick-track" />
              {done && <line x1="38" y1="2.5" x2="38" y2="5" className="boost-tick" style={{ animationDelay: `${t.delay}ms` }} />}
            </g>
          ))}
        </svg>
        <Comet className="boost-chase" />
        {done && (
          <>
            <Comet className="boost-orbit" />
            {MOTES.map(([a, d]) => (
              <span key={a} className="boost-mote" style={{ rotate: `${a}deg`, animationDelay: `${d}ms` }} />
            ))}
            {SPARKS.map(([a, r, d]) => (
              <span key={a} className="boost-spark" style={{ rotate: `${a}deg`, "--boost-d": `${r}px`, animationDelay: `${DISCHARGE_AT + d}ms` } as Vars} />
            ))}
            {EMBERS.map(([a, r, d]) => (
              <span key={a} className="boost-ember" style={{ rotate: `${a}deg`, "--boost-d": `${r}px`, animationDelay: `${DISCHARGE_AT + d}ms` } as Vars} />
            ))}
          </>
        )}
        <span className="boost-pre">
          <Bolt />
          {done && <Bolt className="boost-warm" />}
        </span>
        {done && (
          <>
            <span className="boost-disc">
              <Bolt />
            </span>
            <span className="boost-flash" />
          </>
        )}
      </div>

      <div className="boost-word">
        <h2 id={titleId} className={done ? "sr-only" : "boost-title"}>
          {done ? titles.done : status === "error" ? titles.error : titles.running}
        </h2>
        {done && (
          <>
            <span className="boost-title boost-title-out" aria-hidden>
              {titles.running}
            </span>
            <span className="boost-stamp" aria-hidden>
              <span className="boost-echo" />
              <span className="boost-plate">
                <span className="boost-plate-text">
                  <Bolt />
                  {label}
                </span>
                <span className="boost-sheen" />
              </span>
            </span>
          </>
        )}
      </div>

      <div className="boost-note">
        {done ? (
          // One line, sized for a 375px phone ("$500.00 earning ~4.12% APY"); it ellipsises rather than wraps. The
          // dialog's status region reads the outcome, so this visual copy (and its rolling digits) stays hidden.
          <p className="boost-line" aria-hidden>
            {amount ? (
              <>
                <span className="num text-ink">{amount}</span> earning{" "}
              </>
            ) : (
              "Deposits earn "
            )}
            {apy !== undefined ? (
              <span className="num font-medium text-good">
                <Odometer text={fmtPct(apy, true)} /> APY
              </span>
            ) : (
              "on Morpho Blue"
            )}
            {amount ? "" : " as they land"}
          </p>
        ) : (
          <p className="boost-status">{line}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Done mark for Unboost: the same 40px footprint as the dialog's check disc, but powered down. The lime charge drains
 * back round the rim to 12 o'clock and the bolt cools to grey; no glow, no burst. With reduced motion it is simply the
 * grey disc.
 */
export function BoostPowerDown() {
  return (
    <span className="boost-off" aria-hidden>
      <svg className="boost-off-ring" viewBox="0 0 40 40" focusable="false">
        <circle cx="20" cy="20" r="19" pathLength={100} transform="rotate(-90 20 20)" />
      </svg>
      <Bolt className="boost-off-bolt" />
      <Bolt className="boost-off-bolt boost-warm" />
    </span>
  );
}
