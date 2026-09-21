// Snapshots stock-token market caps from CoinGecko's "Robinhood Chain Stocks Ecosystem" category
// (each Robinhood Chain Stock Token is listed there as its own coin, market cap = circulating supply ×
// price aggregated across venues). Writes src/data/market-caps.json, which the app imports statically —
// see useRankedStocks in src/hooks/useProtocol.ts. Re-run whenever you want fresher rankings:
//
//   node scripts/snapshot-market-caps.mjs
//
// No API key needed for this endpoint. Rerun via the "Snapshot stock market caps" GitHub Action for
// automatic periodic refreshes.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CATEGORY = "robinhood-chain-stocks-ecosystem";
const OUT_PATH = fileURLToPath(new URL("../src/data/market-caps.json", import.meta.url));
const PER_PAGE = 250;

async function fetchPage(page) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${CATEGORY}&order=market_cap_desc&per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

const marketCaps = {};
for (let page = 1; ; page++) {
  const coins = await fetchPage(page);
  for (const c of coins) {
    // A handful of freshly-minted tokens report market_cap: 0/null before CoinGecko back-fills volume;
    // fall back to fully_diluted_valuation (same circulating supply, same price) rather than dropping them.
    const cap = c.market_cap || c.fully_diluted_valuation;
    if (cap) marketCaps[c.symbol.toUpperCase()] = cap;
  }
  if (coins.length < PER_PAGE) break;
}

const snapshot = {
  updatedAt: new Date().toISOString(),
  source: `coingecko:/coins/markets?category=${CATEGORY}`,
  marketCaps,
};

await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`Wrote ${Object.keys(marketCaps).length} market caps to ${OUT_PATH}`);
