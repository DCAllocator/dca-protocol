import { activeChain } from "@/lib/chain";
import type { ProductionVaultKind } from "@/lib/config";

/*
 * Landing constants. Plain values only (no hooks, no "use client"), so server components (HeroCopy, Trust, FaqV3)
 * and client sections read the same switches. Every flag that changes what the page claims sits here, off by default
 * until the founder approves it. Outbound links are env-driven and hidden when unset (never a dead link).
 */

/** An http(s) URL from the environment, else undefined. */
const env = (v: string | undefined) => (v && /^https?:\/\//.test(v) ? v : undefined);

/** Where the landing lives (the nav logo and the share link use it). */
export const LANDING_PATH = "/";

/** Robinhood Chain mainnet (4663): the footer's chain line only shows there, never on a local stack. */
export const IS_RH_MAINNET = activeChain.id === 4663;

/** The proof strip switches from its launch cells to volume cells past this much stock bought (USDG, 6 dp). */
export const PROOF_MIN_NOTIONAL = 25_000n * 10n ** 6n;

/** Create plan reads `?amount=` (needs the small useAmountParam change in useCreatePlan.ts). Off: the builder's
 *  microcopy then promises only the stock and the buy interval. */
export const AMOUNT_PARAM_SUPPORTED = false;

/** Live CoinGecko price + 24h change on the stock tiles. Built, off until approved (price language). */
export const SHOW_TILE_PRICES = false;

/** "Chart ↗" beside the CA chip (NEXT_PUBLIC_CHART_URL). Built, off until approved: it points at the $DCA price. */
export const SHOW_CHART_LINK = false;

/** A bridge to Robinhood Chain for the onboarding FAQ; only an http(s) URL counts, anything else hides the link. */
export const BRIDGE_URL = env(process.env.NEXT_PUBLIC_BRIDGE_URL);

/** Canonical site origin for share links and metadata (NEXT_PUBLIC_SITE_URL); undefined falls back to `location.origin`. */
export const SITE_URL = env(process.env.NEXT_PUBLIC_SITE_URL);

/** The $DCA page on Pons, shown by the CA chip until the token is deployed (NEXT_PUBLIC_PONS_URL, else the Buy $DCA URL). */
export const PONS_URL = env(process.env.NEXT_PUBLIC_PONS_URL) ?? env(process.env.NEXT_PUBLIC_BUY_DCA_URL);

/** The $DCA chart (NEXT_PUBLIC_CHART_URL), linked only when SHOW_CHART_LINK is on. */
export const CHART_URL = env(process.env.NEXT_PUBLIC_CHART_URL);

/** The active chain's block explorer; undefined on a local stack, which hides every explorer link. */
export const EXPLORER: string | undefined = activeChain.blockExplorers?.default.url;

/** Explorer page of an address, when the chain has an explorer and the address is known. */
export const explorerAddress = (a?: string) => (EXPLORER && a ? `${EXPLORER}/address/${a}` : undefined);

/** Fallback USD prices for the hero replica's quantities when the market feed is missing (SSR and first paint too);
 *  near the tape's levels on 2026-09-24, so the resting frame stays plausible beside it. */
export const DEMO_PRICES: Readonly<Record<"NVDA" | "AAPL" | "SPY", number>> = { NVDA: 220, AAPL: 335, SPY: 765 };

/** Amount-per-buy choices in the plan builder (USD); options under the live minimum per buy are dropped. */
export const BUILDER_AMOUNTS: readonly number[] = [10, 25, 50, 100, 250, 500, 1000];

/** The plan sentence every visitor starts from: "Buy $50 of NVDA every week." */
export const DEFAULT_DRAFT: Readonly<{ symbol: string; amount: number; kind: ProductionVaultKind }> = { symbol: "NVDA", amount: 50, kind: "weekly" };

/** The noun after "every" in the plan sentence. */
export const INTERVAL_WORD: Readonly<Record<ProductionVaultKind, string>> = { hourly: "hour", daily: "day", weekly: "week", monthly: "month" };

/** Stock tiles before the registry and the keeper's pairs answer (and when the app is not configured). */
export const STOCK_FALLBACK: readonly string[] = ["SPY", "NVDA", "GLD", "GOOGL", "AAPL", "META", "TSLA", "AMZN", "MSTR", "MSFT", "PLTR", "COIN"];

/** The builder's stock options when the app is not configured. */
export const BUILDER_FALLBACK: readonly string[] = ["NVDA", "TSLA", "AAPL", "SPY", "GLD", "GOOGL", "META", "AMZN", "MSFT", "PLTR"];

/** The Stocks heading's rotating ticker before the real list is in. */
export const CYCLE_FALLBACK: readonly string[] = ["NVDA", "TSLA", "SPY", "GLD", "AAPL", "GOOGL"];

/** "Share on X" text; the footer appends the page URL. */
export const SHARE_TEXT = "DCA: Robinhood Stock Tokens bought for you on a schedule, on Robinhood Chain.";
