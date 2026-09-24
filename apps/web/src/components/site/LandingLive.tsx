"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { useDirectory, useVaults, useStocks, useRankedStocks, useBoostApys, usePositions, useKindsBuying, boostAvailable, isDcaToken, findStock } from "@/hooks/useProtocol";
import { Countdown, StockAvatar } from "@/components/ui";
import { BoostShowcase } from "@/components/site/BoostShowcase";
import { fmtUsd } from "@/lib/format";
import { VAULT_META } from "@/lib/config";
import { tickerName } from "@/lib/tickers";

/** How long a click waits for the wallet / positions before giving up and going to Create plan. */
const LAUNCH_WAIT_MS = 3_000;

/** Create plan with `symbol` preselected (see `useStockParam`); the landing pages link it through `useStockHref`. */
export const createPlanHref = (symbol: string) => `/app/create?stock=${encodeURIComponent(symbol)}`;

/**
 * Where a landing-page ticker links: Create plan on that stock (`createPlanHref`) when some production vault buys it
 * (`useKindsBuying`), else plain Create plan, since a deep link to a stock nothing buys would only open on a notice.
 * Plain until the stock list and the keeper's pairs are in.
 */
export function useStockHref() {
  const { dir } = useDirectory();
  const { stocks } = useStocks(dir?.registry);
  const { kindsBuying } = useKindsBuying();
  return useCallback(
    (symbol: string) => {
      const s = findStock(stocks, symbol);
      return s && kindsBuying(s.address)?.length ? createPlanHref(symbol) : "/app/create";
    },
    [stocks, kindsBuying],
  );
}

/**
 * "Launch app" lands where the visitor should start: My plans when the connected wallet already has plans,
 * Create plan otherwise (including with no wallet connected). The wallet reconnects and positions load on the
 * landing page itself, so the answer is usually known before the click; a click that arrives while either is
 * still pending waits for the answer instead of guessing, capped at LAUNCH_WAIT_MS.
 */
export function LaunchAppLink({ className, children }: { className?: string; children: ReactNode }) {
  const router = useRouter();
  const { address, isReconnecting } = useAccount();
  const { vaults, configured } = useDirectory();
  const { positions, isLoading } = usePositions(vaults);
  const pending = isReconnecting || (!!address && configured && (!vaults || isLoading));
  const href = address && positions.length > 0 ? "/app/plans" : "/app/create";
  const [clicked, setClicked] = useState(false);

  useEffect(() => {
    if (!clicked) return;
    if (!pending) {
      router.push(href);
      return;
    }
    const t = setTimeout(() => router.push("/app/create"), LAUNCH_WAIT_MS);
    return () => clearTimeout(t);
  }, [clicked, pending, href, router]);

  return (
    <Link
      href={href}
      className={className}
      aria-busy={clicked && pending ? true : undefined}
      onClick={(e) => {
        if (!pending) return;
        e.preventDefault();
        setClicked(true);
      }}
    >
      {children}
    </Link>
  );
}

/**
 * Stats strip under the hero. Every figure is read from the vault contracts; nothing here is a marketing
 * number. Degrades to dashes when the app is not configured.
 */
export function LandingStats() {
  const { dir, vaults, configured } = useDirectory();
  const { infos } = useVaults(vaults);
  const { stocks } = useStocks(dir?.registry);
  // $DCA can be listed in the registry too; it is not a stock token.
  const stockTokens = stocks.filter((s) => !isDcaToken(dir, s.address)).length;
  // Vaults hold USDG only (ETH is converted on deposit), so "waiting to buy" is exactly the idle USDG.
  const usdgIdle = infos.reduce((a, v) => a + (v.totalUsdgIdle ?? 0n), 0n);
  const notional = infos.reduce((a, v) => a + (v.totalNotionalUsdg ?? 0n), 0n);
  const epochs = infos.reduce((a, v) => a + (v.epochsCompleted ?? 0n), 0n);
  const ready = configured && infos.length > 0;
  const items: [string, string][] = [
    ["Stock bought through DCA", ready ? fmtUsd(notional) : "—"],
    ["Capital waiting to buy", ready ? fmtUsd(usdgIdle) : "—"],
    ["Buys executed", ready ? epochs.toString() : "—"],
    ["Stock tokens listed", ready ? String(stockTokens) : "—"],
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

/**
 * The Boost section beside the Vaults panel, with the live Morpho supply APY of the first vault that has a boost
 * strategy (they lend into the same USDG market). Drawn by BoostShowcase in the Boost dialog's celebration style.
 */
export function BoostTeaser() {
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);
  const { apyOf } = useBoostApys(infos);
  const withBoost = infos.find(boostAvailable);
  return <BoostShowcase apy={apyOf(withBoost?.boostStrategy)} />;
}

const GRID_SIZE = 17;

/**
 * Registry stocks ranked by market cap, top tiles (each opens Create plan, on that stock where a vault buys it: see
 * `useStockHref`) + a "more" tile with the real remainder.
 */
export function StockGrid() {
  const { dir, configured } = useDirectory();
  const { ranked, ready } = useRankedStocks(dir);
  const stockHref = useStockHref();
  // Before the registry answers, a handful of well-known tickers keep the layout from jumping.
  const placeholder = ["SPY", "NVDA", "GLD", "GOOGL", "AAPL", "META", "TSLA", "AMZN", "MSTR", "MSFT", "PLTR", "COIN"];
  const symbols = ready && configured ? ranked.map((s) => s.symbol) : placeholder;
  const shown = symbols.slice(0, GRID_SIZE);
  const more = symbols.length - shown.length;
  return (
    <div className="mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-6">
      {shown.map((sym) => (
        <Link key={sym} href={stockHref(sym)} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-surface-3 p-3.5 transition-colors hover:border-ink">
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
