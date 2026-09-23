"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDirectory, useRankedStocks } from "@/hooks/useProtocol";
import { useStockMarket, fmtPrice, type StockQuote } from "@/hooks/useStockMarket";
import { StockAvatar } from "@/components/ui";

/**
 * Trading-terminal ticker tape: the largest Stock Tokens by on-chain market cap, each with its price and 24 h change,
 * scrolling right to left in a loop. It is exactly as wide as its parent (`w-full`, clipped), so it drops into a page
 * header, a card or a full-bleed strip unchanged; the scroll speed is constant in px/s whatever the width. It is square
 * and borderless: the caller adds whatever edge the placement needs (`className`).
 *
 * - The list is the registry's approved stocks (what a plan can actually buy) that have a quote, ranked by live
 *   market cap. With no VaultDirectory configured it falls back to every quoted Stock Token.
 * - The loop is two identical copies of the strip translated by −50 %. A copy is repeated until it is at least as
 *   wide as the viewport, so a short list on a wide screen never leaves a gap.
 * - Hover pauses it. Under `prefers-reduced-motion` it stops and becomes a horizontally scrollable strip.
 * - Renders a same-height placeholder while loading and nothing at all if the price source is down.
 */
export function StockTicker({ count = 20, speed = 45, className = "" }: { count?: number; speed?: number; className?: string }) {
  const { dir, configured } = useDirectory();
  const { ranked, ready: rankReady } = useRankedStocks(dir);
  const { quotes, ready, failed } = useStockMarket();

  const items = useMemo(() => {
    const universe = configured ? (rankReady ? ranked.map((s) => s.symbol.toUpperCase()) : []) : Object.keys(quotes);
    return universe
      .filter((s) => quotes[s])
      .sort((a, b) => (quotes[b].marketCap ?? 0) - (quotes[a].marketCap ?? 0))
      .slice(0, count)
      .map((symbol) => ({ symbol, ...quotes[symbol] }));
  }, [configured, rankReady, ranked, quotes, count]);

  const viewport = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLUListElement>(null);
  const [reps, setReps] = useState(1);
  const [duration, setDuration] = useState(40);

  useLayoutEffect(() => {
    const vp = viewport.current;
    const st = strip.current;
    if (!vp || !st || items.length === 0) return;
    const measure = () => {
      const unit = st.scrollWidth / reps;
      if (unit <= 0) return;
      const need = Math.max(1, Math.ceil(vp.clientWidth / unit));
      if (need !== reps) setReps(need);
      setDuration((unit * need) / speed);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [items, reps, speed]);

  if (failed || (ready && items.length === 0 && (!configured || rankReady))) return null;

  const frame = `flex h-8 w-full min-w-0 shrink-0 items-stretch overflow-hidden bg-surface-0 font-mono text-[12px] ${className}`;
  if (!ready || items.length === 0) return <div className={`${frame} animate-pulse`} aria-hidden />;

  const row = Array.from({ length: reps }, (_, r) => items.map((q) => <Quote key={`${r}-${q.symbol}`} {...q} />));
  return (
    <div className={`ticker group ${frame}`} role="marquee" aria-label="Stock Token prices, 24 hour change">
      <span className="flex shrink-0 items-center gap-1.5 border-r border-line px-3 text-[10.5px] tracking-[0.1em] text-ink-3 uppercase">
        <span className="ticker-live inline-block h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
        24h
      </span>
      <div ref={viewport} className="ticker-viewport relative min-w-0 flex-1 overflow-hidden">
        <div className="ticker-track flex h-full w-max" style={{ animationDuration: `${duration}s` }}>
          <ul ref={strip} className="flex h-full shrink-0 items-center">
            {row}
          </ul>
          <ul className="flex h-full shrink-0 items-center" aria-hidden>
            {row}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Quote({ symbol, price, change24h }: { symbol: string } & StockQuote) {
  const up = change24h !== null && change24h >= 0;
  const tone = change24h === null ? "text-ink-3" : up ? "text-good" : "text-bad";
  return (
    <li className="flex h-full items-center gap-2 px-3.5 whitespace-nowrap">
      <StockAvatar symbol={symbol} size={14} />
      <span className="font-semibold tracking-wide text-ink">{symbol}</span>
      <span className="text-ink-2 tabular-nums">{fmtPrice(price)}</span>
      <span className={`tabular-nums ${tone}`}>{change24h === null ? "—" : `${up ? "▲" : "▼"}${Math.abs(change24h).toFixed(2)}%`}</span>
    </li>
  );
}
