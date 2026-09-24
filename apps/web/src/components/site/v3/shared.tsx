"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBuyable, useDirectory, useKindsBuying, usePerkThresholds, useRankedStocks, useVaults } from "@/hooks/useProtocol";
import { useFeeReceiver } from "@/hooks/useFeeReceiver";
import { PRODUCTION_VAULT_KINDS, VAULT_META, isZero, type ProductionVaultKind } from "@/lib/config";
import { fmtUnits, fmtUnitsCompact } from "@/lib/format";
import { tickerIconUrl } from "@/lib/tickers";
import { useTheme } from "@/lib/theme";
import { CaChip } from "./Chips";
import { CHART_URL, EXPLORER, SHOW_CHART_LINK, explorerAddress } from "./config";

/*
 * Shared data hooks and tiny components for the landing, so every section reads the same numbers the same way. Everything
 * wraps the app's own hooks (hooks/useProtocol, hooks/useFeeReceiver) and existing components; nothing here reads a
 * buyback amount, a reserve or a $DCA price. Hooks answer `undefined` until the chain has, and sections hide a value
 * rather than print a zero.
 */

/* ------------------------------------------------------------------ page */

/**
 * The landing never plays the first-load splash: v3.css hides it before hydration (`html:has(main[data-v3-page])[data-splash]`),
 * and this drops the attribute once mounted so nothing else keys off it. lib/splash.ts stays untouched.
 */
export function SplashSkip() {
  useEffect(() => {
    const html = document.documentElement;
    if (html.dataset.splash === "on") delete html.dataset.splash;
  }, []);
  return null;
}

/* ------------------------------------------------------------------ holder perks */

export type Perk = "autoDistribute" | "feeHalve" | "max";

/**
 * The $DCA balances that switch the holder perks on (raw 18-dp units), live from the vaults with the deploy defaults
 * until they answer. `split` is true when the two thresholds differ (every "thresholds differ" copy variant keys off
 * it); `max` is the larger one, i.e. the balance that turns both perks on.
 */
export function usePerks(): { autoDistribute: bigint; feeHalve: bigint; split: boolean; max: bigint } {
  const { autoDistribute, feeHalve } = usePerkThresholds();
  return { autoDistribute, feeHalve, split: autoDistribute !== feeHalve, max: autoDistribute > feeHalve ? autoDistribute : feeHalve };
}

/**
 * A perk threshold as copy: "100,000 $DCA", or "100k $DCA" when `compact`. Same output as `PerkThreshold`
 * (components/site/Live.tsx) plus `perk="max"`. A client island, so server components can drop it into copy.
 */
export function Threshold({ perk = "autoDistribute", compact = false }: { perk?: Perk; compact?: boolean }) {
  const v = usePerks()[perk];
  return <>{compact ? fmtUnitsCompact(v, 18) : fmtUnits(v, 18, 0)} $DCA</>;
}

/** Picks the copy variant: `split` when the two perk thresholds differ, else `same`. */
export function PerksSplit({ same, split }: { same: ReactNode; split: ReactNode }) {
  return <>{usePerks().split ? split : same}</>;
}

/* ------------------------------------------------------------------ vault reads */

/**
 * A frequency's purchase fee in bps (live `fees.purchaseFeeBps`, else the deploy default) and the holder's, halved and
 * floored exactly as FeeMath does. For computing demo quantities only: the landing never prints a fee.
 */
export function useFeeBps(kind: ProductionVaultKind): { standard: number; holder: number } {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  const standard = byKind[kind]?.fees?.purchaseFeeBps ?? VAULT_META[kind].defaultFeeBps;
  return { standard, holder: Math.floor(standard / 2) };
}

/**
 * The next scheduled buy anywhere: the earliest `nextEpochStart` among production vaults that are known to be
 * unpaused, with its frequency. Undefined when the app is not configured or no vault has answered yet.
 */
export function useSoonestBuy(): { kind: ProductionVaultKind; target: bigint } | undefined {
  const { vaults, configured } = useDirectory();
  const { byKind } = useVaults(vaults);
  return useMemo(() => {
    if (!configured) return undefined;
    let soonest: { kind: ProductionVaultKind; target: bigint } | undefined;
    for (const kind of PRODUCTION_VAULT_KINDS) {
      const v = byKind[kind];
      if (!v || v.paused !== false || v.nextEpochStart === undefined) continue;
      if (!soonest || v.nextEpochStart < soonest.target) soonest = { kind, target: v.nextEpochStart };
    }
    return soonest;
  }, [configured, byKind]);
}

/** The smallest amount per buy any production vault accepts (USDG, 6 dp); undefined until a vault answers. */
export function useMinPerBuy(): bigint | undefined {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  return useMemo(() => {
    let min: bigint | undefined;
    for (const kind of PRODUCTION_VAULT_KINDS) {
      const m = byKind[kind]?.minAmountPerEpoch;
      if (m !== undefined && (min === undefined || m < min)) min = m;
    }
    return min;
  }, [byKind]);
}

/* ------------------------------------------------------------------ stocks */

export type BuyableStocks = {
  /** Buyable Stock Tokens in market-cap order ($DCA excluded): some production vault runs a buy job for each. */
  symbols: string[];
  /** `symbols.length` once the keeper's pairs are fresh (past the background refetch of a restored copy); undefined before. */
  count: number | undefined;
  /** True once `symbols` is the real, non-empty list; until then show STOCK_FALLBACK (config.ts). */
  ready: boolean;
  /** The production frequencies that buy `symbol`, fastest first; undefined until known or for an unknown ticker. */
  kindsOf: (symbol: string) => ProductionVaultKind[] | undefined;
};

/**
 * The Stock Tokens a visitor can actually start a plan on: the registry ranked by market cap (`useRankedStocks`, $DCA
 * left out) kept only where `useKindsBuying` finds a vault buying it. Persisted reads restore after mount, so the
 * server render and the first client render agree (both not ready).
 */
export function useBuyableStocks(): BuyableStocks {
  const { dir, vaults, configured } = useDirectory();
  const { ranked, ready: rankedReady } = useRankedStocks(dir);
  const { kindsBuying, fresh } = useKindsBuying();
  const { ready: pairsReady } = useBuyable();
  return useMemo(() => {
    const known = configured && rankedReady && !!vaults && pairsReady;
    const list = known ? ranked.filter((s) => (kindsBuying(s.address)?.length ?? 0) > 0) : [];
    const bySymbol = new Map(ranked.map((s) => [s.symbol.toUpperCase(), s]));
    const symbols = list.map((s) => s.symbol);
    return {
      symbols,
      count: known && fresh ? symbols.length : undefined,
      ready: known && symbols.length > 0,
      kindsOf: (symbol: string) => {
        const s = bySymbol.get(symbol.toUpperCase());
        return s ? kindsBuying(s.address) : undefined;
      },
    };
  }, [configured, rankedReady, vaults, pairsReady, ranked, kindsBuying, fresh]);
}

/* ------------------------------------------------------------------ fee receiver + contracts */

/**
 * The fee receiver's explorer page, only once it is live (a real FeeReceiver answering) and the chain has an
 * explorer. Reads the address only: never its totals, reserves or pending balances.
 */
export function useFeeReceiverHref(): string | undefined {
  const { dir } = useDirectory();
  const fr = useFeeReceiver(dir);
  return fr.live ? explorerAddress(fr.address) : undefined;
}

/** Links its children to the fee receiver on the explorer (new tab) when live; plain text otherwise. */
export function BuybackLink({ children }: { children: ReactNode }) {
  const href = useFeeReceiverHref();
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-lime-text hover:underline">
      {children}
    </a>
  );
}

/**
 * Whether the contracts are worth pointing at: the app is configured, $DCA is deployed and the chain has an explorer.
 * Gates "Verify the contracts ↗" and the footer's Core contracts list.
 */
export function useContractsLive(): boolean {
  const { dir, configured } = useDirectory();
  return configured && !!dir && !isZero(dir.dca) && !!EXPLORER;
}

/* ------------------------------------------------------------------ marks + chips */

/**
 * Tickers whose /public/tickers art is a wide wordmark (inner mark 2.5:1 or wider inside the square 100x100 viewBox,
 * measured 2026-09-24): it shrinks to an unreadable strip in a 26-36px square ("STATE STREET" for SPY and GLD), so
 * these get the monogram disc. An onLoad aspect check cannot catch this: naturalWidth / naturalHeight is always 1.
 */
const WORDMARK = new Set([
  "ADBE", "AEIS", "AMAT", "AMC", "AMD", "ANET", "APP", "ASML", "AXON", "BA", "BABA", "BB", "BE", "CEG", "CELH", "COHR", "COIN", "COST",
  "CRWD", "CRWV", "CTSH", "DJT", "EWT", "EWY", "F", "FICO", "FIX", "FTNT", "GE", "GEV", "GLD", "GLW", "GME", "HIMS", "HPE", "HWM", "IBM",
  "INDA", "INTC", "INTU", "IONQ", "JBL", "JNJ", "KLAC", "KSS", "LHX", "LITE", "LMT", "LRCX", "LUNR", "MDB", "MOD", "MPWR", "MRNA", "MRVL",
  "MSTR", "MTSI", "MU", "NAVN", "NET", "NOW", "ON", "ONTO", "ORCL", "PANW", "PATH", "PLTR", "QBTS", "QCOM", "RDDT", "RDW", "RGTI", "RIVN",
  "RKLB", "RUN", "SATS", "SGOV", "SHOP", "SHY", "SIMO", "SLV", "SMH", "SNAP", "SNDK", "SNOW", "SOFI", "SOXX", "SPCX", "SPY", "TEAM", "TEM",
  "TER", "TSM", "TTD", "UMC", "UNH", "VRT", "VSAT", "VST", "WDC", "XLK", "ZM",
]);
export const isWordmark = (symbol: string) => WORDMARK.has(symbol.toUpperCase());

/** Logo URLs that already failed this session, so a re-mounted tile skips straight to its monogram. */
const missingMarks = new Set<string>();

/**
 * A stock's logo from /public/tickers (the whitened twin on dark), or a monogram disc (up to 4 letters) when the file
 * is missing (QQQ, XOM, HOOD today) or is a wide wordmark (`isWordmark`). Unlike StockAvatar's lime disc, the
 * monogram is neutral so tiles stay calm.
 * Decorative (`alt=""`): the tile around it carries the name.
 */
export function TileMark({ symbol, size = 36 }: { symbol: string; size?: number }) {
  const theme = useTheme();
  const src = tickerIconUrl(symbol, theme);
  const img = useRef<HTMLImageElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const failed = failedSrc === src || missingMarks.has(src);
  const fail = () => {
    missingMarks.add(src);
    setFailedSrc(src);
  };
  // A server-rendered <img> can fail before hydration attaches onError: catch that case once mounted.
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) fail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  if (failed || !symbol || isWordmark(symbol)) {
    return (
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-4 font-mono font-semibold text-ink"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.28) }}
      >
        {symbol.slice(0, 4).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={img}
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className="shrink-0"
      style={{ width: size, height: size }}
      onError={fail}
    />
  );
}

/** The CA chip (./Chips) restyled for the lime closing band via `.v3-onlime`. */
export function CaChipOnLime() {
  return (
    <span className="v3-onlime inline-flex">
      <CaChip />
    </span>
  );
}

/** "Chart ↗" to NEXT_PUBLIC_CHART_URL in a new tab; renders nothing unless SHOW_CHART_LINK is on and the URL is set. */
export function ChartLink({ className = "" }: { className?: string }) {
  if (!SHOW_CHART_LINK || !CHART_URL) return null;
  return (
    <a href={CHART_URL} target="_blank" rel="noreferrer" className={className}>
      Chart ↗
    </a>
  );
}
