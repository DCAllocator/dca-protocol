"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Logo } from "@/components/Logo";
import { LiveRegion } from "./motion";
import { usePerks } from "./shared";
import "./dca.css";

/*
 * The $DCA loop: plans buy stock, every buy pays a purchase fee, a share of it buys $DCA, holders pay less. One 8s
 * clock drives everything: a lime dot laps the track (`.v3-travel`) while each node lights as the dot reaches it
 * (`.v3-node`, --n = 0..3, 2s apart). Both are CSS animations created in the same commit and paused together until the
 * LiveRegion is on screen, so they cannot drift apart. From `sm` up the nodes sit on a rounded-rect track; on phones
 * they stack on a dotted rail with the dot dropping down it (`.v3-rail-dot`). Under reduced motion there is no dot
 * and only the lime node stays lit (v3.css). The whole figure is one image to assistive tech.
 */

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/*
 * Track geometry: inset as a fraction of the box (x, y) and a px corner radius. The x inset is wider than the y one
 * so the side nodes (36% of the box wide, centred on the track) stay inside the box.
 */
const INSET_X = 0.2;
const INSET_Y = 0.12;
const RADIUS = 28;

/** Where each node sits: the track's edge midpoints, clockwise from the top (same fractions as INSET_X / INSET_Y). */
const SPOTS = ["left-1/2 top-[12%]", "left-[80%] top-1/2", "left-1/2 top-[88%]", "left-[20%] top-1/2"] as const;

/** The midpoint of each corner arc (r·(1 − cos 45°) in from the corner) and the clockwise heading there, in degrees. */
const CORNER_IN = +(RADIUS * (1 - Math.SQRT1_2)).toFixed(2);
const CORNERS: [string, string, number][] = [
  [`calc(${100 - INSET_X * 100}% - ${CORNER_IN}px)`, `calc(${INSET_Y * 100}% + ${CORNER_IN}px)`, 45],
  [`calc(${100 - INSET_X * 100}% - ${CORNER_IN}px)`, `calc(${100 - INSET_Y * 100}% - ${CORNER_IN}px)`, 135],
  [`calc(${INSET_X * 100}% + ${CORNER_IN}px)`, `calc(${100 - INSET_Y * 100}% - ${CORNER_IN}px)`, 225],
  [`calc(${INSET_X * 100}% + ${CORNER_IN}px)`, `calc(${INSET_Y * 100}% + ${CORNER_IN}px)`, 315],
];

/** The lime node: "A share buys $DCA". */
const LIME = 2;

/**
 * The track as a px `offset-path`: a rounded rect from the top-centre, clockwise. By symmetry the four edge midpoints
 * sit at exactly 0 / 25 / 50 / 75% of its length, so a linear 8s lap reaches node n at n × 2s.
 */
function trackPath(w: number, h: number): string {
  const x1 = w * INSET_X;
  const x2 = w - x1;
  const y1 = h * INSET_Y;
  const y2 = h - y1;
  const r = Math.min(RADIUS, (x2 - x1) / 2, (y2 - y1) / 2);
  const f = (n: number) => n.toFixed(2);
  return [
    `M ${f(w / 2)} ${f(y1)}`,
    `H ${f(x2 - r)} A ${r} ${r} 0 0 1 ${f(x2)} ${f(y1 + r)}`,
    `V ${f(y2 - r)} A ${r} ${r} 0 0 1 ${f(x2 - r)} ${f(y2)}`,
    `H ${f(x1 + r)} A ${r} ${r} 0 0 1 ${f(x1)} ${f(y2 - r)}`,
    `V ${f(y1 + r)} A ${r} ${r} 0 0 1 ${f(x1 + r)} ${f(y1)}`,
    "Z",
  ].join(" ");
}

export function FeeLoop() {
  const { split } = usePerks();
  const nodes = [
    { title: "Plans buy stock", sub: "on your schedule" },
    { title: "A purchase fee is paid", sub: "on every buy" },
    { title: "A share buys $DCA", sub: "on-chain" },
    { title: split ? "Holders pay less" : "Holders pay half the fee", sub: "and get stock sent to their wallet" },
  ];
  const label = `Plans buy stock. Every buy pays a purchase fee. A share of it buys $DCA on-chain. ${
    split ? "Holders pay less" : "Holders pay half the fee"
  } and get their stock sent to their wallet.`;

  const loop = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<string>();

  // One observer for both layouts; whichever is hidden (display: none) measures 0 and is skipped.
  useEffect(() => {
    const box = loop.current;
    const chain = rail.current;
    const measure = () => {
      if (box && box.clientWidth > 0) setPath(trackPath(box.clientWidth, box.clientHeight));
      if (chain && chain.clientHeight > 0) {
        const cards = chain.querySelectorAll<HTMLElement>("[data-node]");
        const first = cards[0];
        const last = cards[cards.length - 1];
        if (!first || !last) return;
        // The rail dot starts centred on node 1 and v3-drop moves it (--rail-h - 10px) down: node 1 → node 4.
        const c1 = first.offsetTop + first.offsetHeight / 2;
        const c4 = last.offsetTop + last.offsetHeight / 2;
        chain.style.setProperty("--rail-h", `${Math.round(c4 - c1 + 10)}px`);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box) ro.observe(box);
    if (chain) ro.observe(chain);
    return () => ro.disconnect();
  }, []);

  return (
    <LiveRegion role="img" aria-label={label} className="mx-auto w-full max-w-[520px]">
      {/* sm and up: the rounded-rect loop */}
      <div ref={loop} className="relative hidden aspect-[4/3] w-full rounded-xl border border-line bg-surface-1 sm:block">
        <span aria-hidden className="v3-glow absolute top-1/2 left-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" fill="none">
          <rect
            x={`${INSET_X * 100}%`}
            y={`${INSET_Y * 100}%`}
            width={`${(1 - 2 * INSET_X) * 100}%`}
            height={`${(1 - 2 * INSET_Y) * 100}%`}
            rx={RADIUS}
            stroke="var(--color-line-strong)"
            strokeWidth="1.5"
            strokeDasharray="2 6"
            strokeLinecap="round"
          />
        </svg>
        {/* clockwise chevrons on the corner arcs, so the direction reads without the dot (reduced motion) */}
        {CORNERS.map(([left, top, turn]) => (
          <svg
            key={turn}
            aria-hidden
            viewBox="0 0 10 10"
            className="absolute h-2.5 w-2.5 text-ink-3"
            style={{ left, top, transform: `translate(-50%, -50%) rotate(${turn}deg)` }}
          >
            <path d="M2 1.2 L9.2 5 L2 8.8 Z" fill="currentColor" />
          </svg>
        ))}
        {/* Rendered from the start (so its clock matches the nodes'), hidden until the path is measured. */}
        <span
          aria-hidden
          className="v3-travel v3-dca-dot absolute top-0 left-0"
          style={path ? { offsetPath: `path("${path}")` } : { visibility: "hidden" }}
        />
        <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5">
          <Logo size={44} />
          <span className="text-[13px] font-semibold text-ink">$DCA</span>
        </div>
        {nodes.map((n, i) => (
          <div
            key={i}
            className={`v3-node absolute w-[36%] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-3 text-center ${SPOTS[i]} ${
              i === LIME ? "v3-node-lime border-lime bg-lime text-lime-ink" : "v3-dca-node border-line bg-surface-3 text-ink"
            }`}
            style={{ "--n": i } as Vars}
          >
            <div className="text-[13.5px] leading-tight font-semibold">{n.title}</div>
            <div className={`mt-1 text-[12px] leading-snug ${i === LIME ? "text-lime-ink/75" : "text-ink-2"}`}>{n.sub}</div>
          </div>
        ))}
      </div>

      {/* phones: the same four nodes on a dotted rail; rows share one height so the dot meets each at n × 2s */}
      <div ref={rail} className="relative sm:hidden">
        <span aria-hidden className="v3-dca-rail absolute left-[13px] top-[calc((100%-36px)/8)] bottom-[calc((100%-36px)/8)]" />
        <span aria-hidden className="v3-rail-dot v3-dca-rail-dot left-[9px] top-[calc((100%-36px)/8-5px)]" />
        <div className="grid auto-rows-fr gap-3 pl-9">
          {nodes.map((n, i) => (
            <div
              key={i}
              data-node=""
              className={`v3-node relative flex flex-col justify-center rounded-lg border px-4 py-3 ${
                i === LIME ? "v3-node-lime border-lime bg-lime text-lime-ink" : "v3-dca-node border-line bg-surface-3 text-ink"
              }`}
              style={{ "--n": i } as Vars}
            >
              <span
                aria-hidden
                className={`absolute top-1/2 -left-[28px] h-2.5 w-2.5 -translate-y-1/2 rounded-full border ${
                  i === LIME ? "border-lime-text bg-surface-2" : "border-line-strong bg-surface-2"
                }`}
              />
              <div className="text-[14px] leading-tight font-semibold">{n.title}</div>
              <div className={`mt-1 text-[12.5px] leading-snug ${i === LIME ? "text-lime-ink/75" : "text-ink-2"}`}>{n.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </LiveRegion>
  );
}
