"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { StockTicker } from "@/components/app/StockTicker";
import { Logo } from "@/components/Logo";
import { useDcaToken, useDirectory, useVaults } from "@/hooks/useProtocol";
import { USDG_DECIMALS, isZero } from "@/lib/config";
import { SHOW_DCA_MARKET_CAP } from "./config";
import { LiveRegion, RollingNumber, useInView, useMounted } from "./motion";
import { TileMark, sumProduction, useBuyableStocks, useContractsLive, useProtocolTvl, type ProtocolTvl } from "./shared";
import "./proof-trust-boost.css";

/*
 * The proof strip under the hero: the Stock Token tape, then four tiles read straight from the chain: the $DCA market
 * cap (router price × total supply), the value locked in the vaults (split into USDG waiting to buy, USDG boosted and
 * stock not yet claimed), the stock bought for plans all time, and how many stocks a plan can buy. Each tile shows
 * from its first dollar, but it never prints a zero: a figure that loads as 0 (or not at all) drops out, and the row
 * goes when fewer than two are left. Every value waits for mount, so a restored query can never
 * make the server and client renders disagree.
 */

/** A figure that has not answered this long after mount counts as missing, so a dead RPC never leaves a row of dashes. */
const GIVE_UP_MS = 12_000;

/** lg column count per number of tiles left (static class names, so Tailwind sees them). */
const COLS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" };

/** Logos in the "Stocks available" stack before the "+N more". */
const STACK = 5;

/** Three significant figures, compact: "$84.1K", "$1.24M", "$950"; `units` the same without the "$" ("1B"). */
const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumSignificantDigits: 3 });
const compactUnits = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const usd = (v: bigint) => compactUsd.format(Number(formatUnits(v, USDG_DECIMALS)));
const units = (v: bigint, decimals: number) => compactUnits.format(Number(formatUnits(v, decimals)));

/** Still loading (the dash placeholder), a figure to show, or nothing (the tile drops out). */
type Slot = "wait" | { value: ReactNode; foot?: ReactNode } | null;
type Tile = {
  key: string;
  label: ReactNode;
  slot: Slot;
  /** Takes a whole row on phones (its foot needs the width). */
  wide?: boolean;
};

/** The dash placeholder, identical to ClientCountdown's, so nothing jumps when a figure lands. */
const Dash = () => <span className="num text-ink-3">—</span>;

/**
 * RollingNumber rolls up from zero on first sight, so until then its digits read 0: fine for the length of a roll, but a
 * "$00" parked below the fold is exactly the zero-state this strip must never show. Hold the dash until the figure is in
 * view (same margin as the odometer's own observer), then mount the odometer, which starts rolling straight away.
 */
function RollIn({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  return <span ref={ref}>{inView ? <RollingNumber text={text} /> : <Dash />}</span>;
}

/** The TVL split as a bar and its legend (the legend carries the values, so the bar is decoration). Zero parts drop out. */
function TvlBreakdown({ tvl }: { tvl: ProtocolTvl }) {
  const [hot, setHot] = useState<string>();
  const parts = [
    { key: "idle", label: "Waiting to buy", value: tvl.idle },
    { key: "boosted", label: "Boosted", value: tvl.boosted },
    { key: "stock", label: "Stock in plans", value: tvl.stock },
  ].filter((p) => p.value > 0n);
  // Pointing at a segment or a legend row lights up the pair and dims the rest.
  const hover = (key: string) => ({ onPointerEnter: () => setHot(key), onPointerLeave: () => setHot(undefined) });
  const dim = (key: string) => (hot !== undefined && hot !== key ? "" : undefined);
  return (
    <div className="v3-tvl">
      <div className="v3-tvl-bar" aria-hidden>
        {parts.map((p) => (
          <span
            key={p.key}
            className="v3-tvl-seg"
            data-part={p.key}
            data-dim={dim(p.key)}
            style={{ flexGrow: Number((p.value * 10_000n) / tvl.total) }}
            {...hover(p.key)}
          />
        ))}
      </div>
      <ul className="mt-3 space-y-1">
        {parts.map((p) => (
          <li key={p.key} className="v3-tvl-row" data-dim={dim(p.key)} {...hover(p.key)}>
            <span className="v3-tvl-swatch" data-part={p.key} aria-hidden />
            <span className="truncate">{p.label}</span>
            <span className="num ml-auto pl-3 text-ink-2">{usd(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The first few buyable stocks' logos, overlapped, then "+N more": links down to the stock grid. */
function StockStack({ symbols, count }: { symbols: string[]; count: number }) {
  const shown = symbols.slice(0, STACK);
  return (
    <a href="#stocks" className="group flex items-center gap-2.5 text-[12.5px] text-ink-3">
      <span className="flex" aria-hidden>
        {shown.map((s) => (
          <span key={s} className="v3-stack-mark">
            <TileMark symbol={s} size={22} />
          </span>
        ))}
      </span>
      <span className="sr-only">Including {shown.join(", ")}.</span>
      {count > shown.length && (
        <span aria-hidden className="whitespace-nowrap">
          +{count - shown.length} more
        </span>
      )}
      <span className="ml-auto whitespace-nowrap transition-colors group-hover:text-ink">See all ↓</span>
    </a>
  );
}

/** Proof of life under the fold: the tape, the "Live from the contracts" pill and the gated tiles. */
export function Proof() {
  const mounted = useMounted();
  const { dir, vaults, configured } = useDirectory();
  // The vault reads refresh on the app's 15 s poll (components/Providers.tsx).
  const { infos, isLoading } = useVaults(vaults);
  const tvl = useProtocolTvl();
  const token = useDcaToken(SHOW_DCA_MARKET_CAP ? dir : undefined);
  const { symbols, count } = useBuyableStocks();
  const verify = useContractsLive();

  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGaveUp(true), GIVE_UP_MS);
    return () => clearTimeout(t);
  }, []);

  // Each tile shows the dash until its reads have answered (or GIVE_UP_MS passes), then a figure or nothing.
  const vaultsIn = !!vaults && !isLoading && infos.length > 0;
  const wait = (answered: boolean) => !mounted || (!answered && !gaveUp);
  const bought = mounted ? sumProduction(infos, (v) => v.totalNotionalUsdg) : undefined;
  const noDca = !!dir && isZero(dir.dca);
  const cap = mounted ? token.marketCap : undefined;

  const tiles: Tile[] = [
    ...(SHOW_DCA_MARKET_CAP
      ? [
          {
            key: "cap",
            label: (
              <>
                {/* off on phones, where the half-width tile would wrap the label and drop its figure below its neighbour's */}
                <span className="hidden sm:inline-flex">
                  <Logo size={16} />
                </span>
                $DCA market cap
              </>
            ),
            slot: noDca
              ? null
              : wait(cap !== undefined)
                ? "wait"
                : cap
                  ? {
                      value: <RollIn text={usd(cap)} />,
                      foot: token.totalSupply !== undefined && (
                        <p className="text-[12.5px] text-ink-3">
                          {units(token.totalSupply, 18)} $DCA supply
                        </p>
                      ),
                    }
                  : null,
          } satisfies Tile,
        ]
      : []),
    {
      key: "tvl",
      label: "Total value locked",
      wide: true,
      slot: wait(tvl !== undefined) ? "wait" : tvl && tvl.total > 0n ? { value: <RollIn text={usd(tvl.total)} />, foot: <TvlBreakdown tvl={tvl} /> } : null,
    },
    {
      key: "bought",
      label: "Stock bought",
      slot: wait(vaultsIn) ? "wait" : bought ? { value: <RollIn text={usd(bought)} />, foot: <p className="text-[12.5px] text-ink-3">For plans, all time</p> } : null,
    },
    {
      key: "stocks",
      label: "Stocks available",
      wide: true,
      slot: wait(count !== undefined) ? "wait" : count ? { value: <RollIn text={String(count)} />, foot: <StockStack symbols={symbols} count={count} /> } : null,
    },
  ];
  const shown = tiles.filter((t) => t.slot !== null);
  const figures = configured && shown.length >= 2;

  // Phones: two columns, a `wide` tile takes a whole row, and the narrow ones pair up (dense flow lets a narrow tile
  // fill the gap beside the one before a wide tile); an odd one out takes its row too. sm to lg: two columns, an odd
  // last tile spans both. lg: one row.
  const narrow = shown.filter((t) => !t.wide);
  const lone = narrow.length % 2 === 1 ? narrow[narrow.length - 1] : undefined;

  return (
    // No bottom border of its own: the section below (either Three steps) opens with a hairline, and two would read as one thick rule.
    <LiveRegion as="section" className="v3-proof bg-surface-0" aria-label="Live protocol data">
      <StockTicker count={24} speed={45} className="border-y border-line" />
      {figures && (
        <div className="container-x pt-5 pb-8 md:pb-10">
          <div className="flex flex-wrap items-center gap-y-2">
            <span className="inline-flex h-7 items-center gap-2 rounded-full border border-line px-3 text-[12px] text-ink-2">
              <span className="v3-live-dot" aria-hidden />
              Live from the contracts
            </span>
            {mounted && verify && (
              <a href="#contracts" className="w-full text-[12px] text-ink-3 transition-colors hover:text-ink sm:ml-3 sm:w-auto">
                Verify the contracts ↗
              </a>
            )}
          </div>
          <dl className={`mt-4 grid grid-cols-2 gap-2.5 max-sm:grid-flow-row-dense sm:gap-3 ${COLS[shown.length] ?? ""}`}>
            {shown.map((t, i) => {
              const slot = t.slot === "wait" || t.slot === null ? undefined : t.slot;
              const phoneRow = t.wide || t === lone;
              const smRow = i === shown.length - 1 && shown.length % 2 === 1;
              return (
                <div
                  key={t.key}
                  className={`v3-stat ${phoneRow ? "col-span-2" : "col-span-1"} ${smRow ? "sm:col-span-2" : "sm:col-span-1"} lg:col-span-1`}
                >
                  <dt className="flex items-center gap-1.5 text-[12.5px] text-ink-2 sm:gap-2 sm:text-[13px]">{t.label}</dt>
                  <dd className="mt-2.5 text-[28px] leading-none font-semibold tracking-tight whitespace-nowrap text-ink sm:text-[32px]">
                    {slot ? slot.value : <Dash />}
                  </dd>
                  {slot?.foot && <dd className="mt-auto pt-5">{slot.foot}</dd>}
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </LiveRegion>
  );
}
