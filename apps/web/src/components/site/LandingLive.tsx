"use client";

import Link from "next/link";
import { useDirectory, useVaults, useStocks, useRankedStocks, useBoostApys, boostAvailable } from "@/hooks/useProtocol";
import { Countdown, StockAvatar } from "@/components/ui";
import { fmtUsd, fmtPct } from "@/lib/format";
import { VAULT_META } from "@/lib/config";
import { tickerName } from "@/lib/tickers";

/**
 * Stats strip under the hero. Every figure is read from the vault contracts; nothing here is a marketing
 * number. Degrades to dashes when the app is not configured.
 */
export function LandingStats() {
  const { dir, vaults, configured } = useDirectory();
  const { infos } = useVaults(vaults);
  const { stocks } = useStocks(dir?.registry);
  // Vaults hold USDG only (ETH is converted on deposit), so "waiting to buy" is exactly the idle USDG.
  const usdgIdle = infos.reduce((a, v) => a + (v.totalUsdgIdle ?? 0n), 0n);
  const notional = infos.reduce((a, v) => a + (v.totalNotionalUsdg ?? 0n), 0n);
  const epochs = infos.reduce((a, v) => a + (v.epochsCompleted ?? 0n), 0n);
  const ready = configured && infos.length > 0;
  const items: [string, string][] = [
    ["Stock bought through DCA", ready ? fmtUsd(notional) : "—"],
    ["Capital waiting to buy", ready ? fmtUsd(usdgIdle) : "—"],
    ["Buys executed", ready ? epochs.toString() : "—"],
    ["Stock tokens listed", ready ? String(stocks.length) : "—"],
  ];
  return (
    <div className="grid grid-cols-2 divide-line border-y border-line md:grid-cols-4 md:divide-x">
      {items.map(([k, v]) => (
        <div key={k} className="px-6 py-5">
          <div className="text-[12px] text-ink-3">{k}</div>
          <div className="num mt-1 text-2xl font-semibold tracking-tight text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Hero preview: a slice of the plans table with live countdowns to each vault's next buy. The rows are
 * illustrative (marked "preview"); the delivery column shows what a $DCA holder sees.
 */
export function PlansPreview() {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  const rows = [
    { sym: "NVDA", vault: "weekly" as const, per: "$100.00", acc: "0.397324" },
    { sym: "AAPL", vault: "daily" as const, per: "$50.00", acc: "0.261397" },
    { sym: "SPY", vault: "monthly" as const, per: "$250.00", acc: "1.108210" },
  ];
  const fallback = (v: (typeof rows)[number]["vault"]) => Math.floor(Date.now() / 1000) + 86_400 * (v === "daily" ? 1 : v === "weekly" ? 4 : 19);
  return (
    <div className="panel min-w-0 shadow-[0_24px_80px_-24px_rgba(198,255,0,0.25)]">
      <div className="flex h-9 items-center gap-3 border-b border-line bg-surface-0 px-3 text-[12px]">
        <span className="flex gap-1">
          <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
          <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
          <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
        </span>
        <span className="font-semibold text-ink">My plans</span>
        <span className="text-ink-3">·</span>
        <span className="text-ink-3">3 active</span>
        <span className="chip-lime ml-auto">preview</span>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Stock</th>
              <th>Vault</th>
              <th className="text-right">Per buy</th>
              <th className="text-right">Bought</th>
              <th>Next buy</th>
              <th>Delivery</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sym}>
                <td>
                  <span className="flex items-center gap-2 font-semibold text-ink">
                    <StockAvatar symbol={r.sym} size={26} />
                    {r.sym}
                  </span>
                </td>
                <td>{VAULT_META[r.vault].label}</td>
                <td className="num text-right">{r.per}</td>
                <td className="num text-right">{r.acc}</td>
                <td>
                  <Countdown target={byKind[r.vault]?.nextEpochStart ?? fallback(r.vault)} className="text-ink" />
                </td>
                <td>
                  <span className="chip-lime">auto · wallet</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-4 border-t border-line bg-surface-0 px-3 py-1.5 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <i className="h-1.5 w-1.5 rounded-full bg-good" /> Robinhood Chain
        </span>
        <span>best route: Uniswap V3</span>
        <span className="ml-auto">non-custodial</span>
      </div>
    </div>
  );
}

/** Boost teaser with the live Morpho supply APY of the weekly vault's strategy (any vault with one, really). */
export function BoostTeaser() {
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);
  const { apyOf } = useBoostApys(infos);
  const withBoost = infos.find(boostAvailable);
  const apy = apyOf(withBoost?.boostStrategy);
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface-3 p-5">
      <h3 className="flex flex-wrap items-center gap-2.5 text-[18px] font-semibold text-ink">
        Boost <span className="chip">optional · per plan</span>
      </h3>
      <p className="text-[14px] leading-relaxed text-ink-2">
        Your USDG normally waits days or weeks between buys. Boost lends it on Morpho Blue in the meantime and pulls it back automatically at every buy and
        withdrawal. No fee on the yield.
      </p>
      <p className="text-[12.5px] text-ink-3">Boosted balances are a Morpho supply position and carry that market&apos;s risk.</p>
      <div className="mt-auto flex items-baseline justify-between gap-3 border-t border-line pt-3.5">
        <span className="text-[13.5px] text-ink-2">USDG supply APY, live</span>
        <span className="num text-[22px] font-semibold text-good">{apy === undefined ? "—" : fmtPct(apy)}</span>
      </div>
    </div>
  );
}

const GRID_SIZE = 17;

/** Registry stocks ranked by market cap, top tiles + a "more" tile with the real remainder. */
export function StockGrid() {
  const { dir, configured } = useDirectory();
  const { ranked, ready } = useRankedStocks(dir);
  // Before the registry answers, a handful of well-known tickers keep the layout from jumping.
  const placeholder = ["SPY", "NVDA", "GLD", "GOOGL", "AAPL", "META", "TSLA", "AMZN", "MSTR", "MSFT", "PLTR", "COIN"];
  const symbols = ready && configured ? ranked.map((s) => s.symbol) : placeholder;
  const shown = symbols.slice(0, GRID_SIZE);
  const more = symbols.length - shown.length;
  return (
    <div className="mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-6">
      {shown.map((sym) => (
        <Link key={sym} href="/app/create" className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface-3 p-3.5 transition-colors hover:border-ink">
          <StockAvatar symbol={sym} size={34} />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold text-ink">{sym}</span>
            <span className="block truncate text-[11.5px] text-ink-3">{tickerName(sym)}</span>
          </span>
        </Link>
      ))}
      <Link href="/app/create" className="flex items-center justify-center rounded-lg border border-dashed border-line bg-surface-3 p-3.5 text-[13.5px] text-ink-2 transition-colors hover:border-ink hover:text-ink">
        {more > 0 ? `+ ${more} more →` : "See all →"}
      </Link>
    </div>
  );
}
