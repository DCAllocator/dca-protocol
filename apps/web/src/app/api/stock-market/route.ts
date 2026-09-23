import { NextResponse } from "next/server";

/**
 * GET /api/stock-market — live price, 24 h change and market cap of every Robinhood Chain Stock Token, keyed by
 * ticker. Feeds the stock ticker tape and the create page's stock picker.
 *
 * Source: CoinGecko's "Robinhood Chain Stocks Ecosystem" category (the same list scripts/snapshot-market-caps.mjs
 * snapshots for the ranking), one call for all ~190 tokens. Market cap there is circulating (on-chain) supply ×
 * price aggregated across venues. Proxied rather than called from the browser so every visitor shares one cached
 * upstream request a minute instead of each spending CoinGecko's per-IP rate limit, and so the 170 KB upstream
 * payload is cut to the three numbers the app uses. `COINGECKO_API_KEY` (a free "demo" key) is optional and only
 * raises that limit.
 *
 * Display only: nothing that is sent on chain is computed from these numbers (buys are USDG amounts; the router
 * quotes the swap at execution).
 */

const CATEGORY = "robinhood-chain-stocks-ecosystem";
const PER_PAGE = 250;
const MAX_PAGES = 4;
/** Seconds a response is reused before CoinGecko is asked again. */
const TTL = 60;

export type StockQuote = {
  /** Company / fund name, CoinGecko's "NVIDIA • Robinhood Token" without the suffix. */
  name: string;
  /** USD per token. */
  price: number;
  /** Percent change over the last 24 h (1.23 = +1.23 %); null when CoinGecko has no history yet. */
  change24h: number | null;
  /** USD; falls back to fully diluted valuation for freshly listed tokens (same supply, same price). */
  marketCap: number | null;
};

export type StockMarketResponse = {
  updatedAt: string;
  source: string;
  quotes: Record<string, StockQuote>;
};

type CoinGeckoMarket = {
  symbol: string;
  name: string;
  current_price: number | null;
  price_change_percentage_24h: number | null;
  market_cap: number | null;
  fully_diluted_valuation: number | null;
};

/**
 * Deliberately no route-level `revalidate`: that would prerender this at build time (and could bake a CoinGecko
 * outage into the build). The handler stays dynamic; the upstream fetch is cached for TTL by Next's data cache and
 * the response for TTL by the CDN.
 */
export async function GET() {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;

  const quotes: Record<string, StockQuote> = {};
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${CATEGORY}&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}&price_change_percentage=24h`;
      const res = await fetch(url, { headers, next: { revalidate: TTL } });
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const coins = (await res.json()) as CoinGeckoMarket[];
      for (const c of coins) {
        if (typeof c.current_price !== "number") continue;
        quotes[c.symbol.toUpperCase()] = {
          name: c.name.replace(/\s*•\s*Robinhood Token\s*$/i, "").trim(),
          price: c.current_price,
          change24h: typeof c.price_change_percentage_24h === "number" ? c.price_change_percentage_24h : null,
          marketCap: c.market_cap || c.fully_diluted_valuation || null,
        };
      }
      if (coins.length < PER_PAGE) break;
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "upstream error" }, { status: 502, headers: { "cache-control": "no-store" } });
  }

  const body: StockMarketResponse = { updatedAt: new Date().toISOString(), source: `coingecko:${CATEGORY}`, quotes };
  return NextResponse.json(body, { headers: { "cache-control": `public, s-maxage=${TTL}, stale-while-revalidate=${TTL * 5}` } });
}
