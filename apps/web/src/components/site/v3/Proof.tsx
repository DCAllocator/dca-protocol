"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { StockTicker } from "@/components/app/StockTicker";
import { useDirectory, useVaults, type VaultInfo } from "@/hooks/useProtocol";
import { PRODUCTION_VAULT_KINDS, VAULT_META } from "@/lib/config";
import { fmtUsd } from "@/lib/format";
import { PROOF_MIN_NOTIONAL } from "./config";
import { ClientCountdown, LiveRegion, RollingNumber, useInView, useMounted } from "./motion";
import { useBuyableStocks, useContractsLive, useMinPerBuy, useSoonestBuy } from "./shared";
import "./proof-trust-boost.css";

/*
 * The proof strip under the hero: the Stock Token tape, then a few figures read straight from the vault contracts.
 * Before real volume it shows only what is always true (the next scheduled buy, how many stocks a plan can buy, the
 * minimum per buy); past PROOF_MIN_NOTIONAL of stock bought it leads with the volume instead. It never prints a zero:
 * a figure that loads as 0 (or not at all) drops out, and the row goes when fewer than two are left. Every value waits
 * for mount, so a restored query can never make the server and client renders disagree.
 */

/** A figure that has not answered this long after mount counts as missing, so a dead RPC never leaves a row of dashes. */
const GIVE_UP_MS = 12_000;

const PRODUCTION = new Set<string>(PRODUCTION_VAULT_KINDS);

/** md column count per number of cells left (static class names, so Tailwind sees them). */
const COLS: Record<number, string> = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" };

/** A sum over the production vaults, only once every one of them has answered: a partial sum would undercount. */
function sumProduction(infos: VaultInfo[], pick: (v: VaultInfo) => bigint | undefined): bigint | undefined {
  const prod = infos.filter((v) => PRODUCTION.has(v.kind));
  if (prod.length === 0) return undefined;
  let total = 0n;
  for (const v of prod) {
    const x = pick(v);
    if (x === undefined) return undefined;
    total += x;
  }
  return total;
}

/** Whole dollars: "$84,061" (cents would only make two near-identical figures look busier). */
const dollars = (v: bigint) => fmtUsd(v).replace(/\.\d\d$/, "");

/** Still loading (the dash placeholder), a figure to show, or nothing (the cell drops out). */
type Slot = "wait" | { value: ReactNode; sub?: ReactNode } | null;
type Cell = { key: string; label: string; slot: Slot; sub?: ReactNode };

/** The dash placeholder, identical to ClientCountdown's, so nothing jumps when one hands over to the other. */
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

/** Proof of life under the fold: the tape, the "Live from the contracts" pill and the gated figures. */
export function Proof() {
  const mounted = useMounted();
  const { vaults, configured } = useDirectory();
  // The vault reads refresh on the app's 15 s poll (components/Providers.tsx), which also moves "Next scheduled buy" on
  // once the keeper's buy lands.
  const { infos, isLoading } = useVaults(vaults);
  const soonest = useSoonestBuy();
  const { count } = useBuyableStocks();
  const minPerBuy = useMinPerBuy();
  const verify = useContractsLive();

  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGaveUp(true), GIVE_UP_MS);
    return () => clearTimeout(t);
  }, []);

  // The vault reads have answered (or failed) once the multicall has run; until then their cells show the dash.
  const vaultsIn = !!vaults && !isLoading && infos.length > 0;
  const waitVaults = !mounted || (!vaultsIn && !gaveUp);
  const waitStocks = !mounted || (count === undefined && !gaveUp);

  const notional = mounted ? sumProduction(infos, (v) => v.totalNotionalUsdg) : undefined;
  // Idle USDG plus what boosted plans have lent out on Morpho (`boostAssets` is not in `totalUsdgIdle`).
  const ready = mounted ? sumProduction(infos, (v) => (v.totalUsdgIdle === undefined ? undefined : v.totalUsdgIdle + (v.boostAssets ?? 0n))) : undefined;

  const next: Cell = {
    key: "next",
    label: "Next scheduled buy",
    slot: waitVaults ? "wait" : soonest ? { value: <ClientCountdown target={soonest.target} className="text-ink" />, sub: `${VAULT_META[soonest.kind].label} plans` } : null,
  };
  const stocks: Cell = {
    key: "stocks",
    label: "Stocks available",
    slot: waitStocks ? "wait" : count ? { value: <RollIn text={String(count)} /> } : null,
    sub: "More on the way",
  };
  // The gate: the volume cells lead once enough stock has been bought for them to mean something.
  const cells: Cell[] =
    notional !== undefined && notional >= PROOF_MIN_NOTIONAL
      ? [
          { key: "bought", label: "Stock bought for plans", slot: { value: <RollIn text={dollars(notional)} /> } },
          { key: "ready", label: "Deposited, ready to buy", slot: ready ? { value: <RollIn text={dollars(ready)} /> } : null },
          next,
          stocks,
        ]
      : [
          next,
          stocks,
          {
            key: "minimum",
            label: "Minimum buy",
            slot: waitVaults ? "wait" : minPerBuy ? { value: <RollIn text={fmtUsd(minPerBuy).replace(/\.00$/, "")} /> } : null,
            sub: "per buy · fund with USDG or ETH",
          },
        ];
  const shown = cells.filter((c) => c.slot !== null);
  const figures = configured && shown.length >= 2;

  return (
    // No bottom border of its own: the section below (either Three steps) opens with a hairline, and two would read as one thick rule.
    <LiveRegion as="section" className="v3-proof bg-surface-0" aria-label="Live protocol data">
      <StockTicker count={24} speed={45} className="border-y border-line" />
      {figures && (
        <div className="container-x pt-5 pb-6">
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
          <dl className={`mt-4 grid grid-cols-2 border-y border-line ${COLS[shown.length] ?? ""}`}>
            {shown.map((c, i) => {
              const slot = c.slot === "wait" || c.slot === null ? undefined : c.slot;
              const sub = slot?.sub ?? c.sub;
              // Two to a row on phones (an odd last cell takes the whole row), one row from md; hairlines between.
              const right = i % 2 === 1;
              const span = i === shown.length - 1 && shown.length % 2 === 1;
              return (
                <div
                  key={c.key}
                  className={`min-w-0 border-line px-4 py-4 sm:px-6 sm:py-5 ${right ? "border-l" : i > 0 ? "md:border-l" : ""} ${i >= 2 ? "border-t md:border-t-0" : ""} ${span ? "col-span-2 md:col-span-1" : ""}`}
                >
                  <dt className="text-[12px] text-ink-3">{c.label}</dt>
                  <dd className="num mt-1 text-xl font-semibold tracking-tight whitespace-nowrap text-ink md:text-2xl">{slot ? slot.value : <Dash />}</dd>
                  {/* "Next scheduled buy" learns its sub-line with its value; hold the line so the row does not grow. */}
                  {sub !== undefined ? <dd className="mt-0.5 text-[12px] text-ink-3">{sub}</dd> : c.key === "next" && <dd className="mt-0.5 text-[12px] text-ink-3">&nbsp;</dd>}
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </LiveRegion>
  );
}
