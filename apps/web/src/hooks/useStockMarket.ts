"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StockMarketResponse, StockQuote } from "@/app/api/stock-market/route";

export type { StockQuote };

/**
 * Live price / 24 h change / market cap per Stock Token ticker, from /api/stock-market (CoinGecko, cached a minute
 * server-side). Display only — see the route for why nothing on chain depends on it. `quotes` is empty until the
 * first answer and stays empty if the upstream is down, so every caller must render without it.
 */
export function useStockMarket() {
  const q = useQuery({
    queryKey: ["stock-market"],
    queryFn: async (): Promise<StockMarketResponse> => {
      const res = await fetch("/api/stock-market");
      if (!res.ok) throw new Error(`stock-market ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
  return useMemo(() => {
    const quotes = q.data?.quotes ?? {};
    return {
      quotes,
      quoteOf: (symbol: string): StockQuote | undefined => quotes[symbol.toUpperCase()],
      ready: q.data !== undefined,
      failed: q.isError && q.data === undefined,
      updatedAt: q.data?.updatedAt,
    };
  }, [q.data, q.isError]);
}

/** "$227.78", "$0.4312" under a dollar, "$1,204.10". */
export const fmtPrice = (usd: number | undefined | null): string => {
  if (usd === undefined || usd === null || !isFinite(usd)) return "—";
  const digits = usd < 1 ? 4 : 2;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

/** "$24.5M", "$812K", "$3.1B". */
export const fmtCap = (usd: number | undefined | null): string => {
  if (usd === undefined || usd === null || !isFinite(usd) || usd <= 0) return "—";
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${Math.round(usd / 1e3)}K`;
  return `$${Math.round(usd)}`;
};

/** "+0.56%" / "−1.20%" (a real minus sign, so the column lines up in a monospace face). */
export const fmtChange = (pct: number | null | undefined): string => {
  if (pct === undefined || pct === null || !isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
};
