"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent } from "react";
import { createPlanHref, useStockHref } from "@/components/site/LandingLive";
import { Icon } from "@/components/ui";
import { fmtChange, fmtPrice, useStockMarket } from "@/hooks/useStockMarket";
import { FREQUENCY_PARAM, frequencyHref } from "@/lib/createLinks";
import { tickerName } from "@/lib/tickers";
import { CYCLE_FALLBACK, SHOW_TILE_PRICES, STOCK_FALLBACK } from "./config";
import { CycleWord, useCycleIndex, useInView } from "./motion";
import { usePlanDraft } from "./PlanDraft";
import { TileMark, useBuyableStocks } from "./shared";

/*
 * Stocks: "DCA into {TICKER}." with the ticker flipping through the first six tiles and a lime ring on the tile
 * that matches it, so the motion points at something you can tap. Every tile opens Create plan on its stock (and on the
 * visitor's buy interval once the plan builder was touched); the dashed tile counts the real buyable remainder.
 * Only stocks a vault actually buys are listed; until that list answers, a fixed set of well-known tickers holds the
 * layout. No prices unless SHOW_TILE_PRICES is approved.
 */

/** Stock tiles from `sm` up (plus the "more" tile: 12 cells, two rows of six on desktop). */
const TILES_WIDE = 11;
/** Stock tiles on a phone (plus the "more" tile: four rows of two). */
const TILES_NARROW = 7;
/** The heading's rotating ticker walks the first few tiles. */
const CYCLE_COUNT = 6;

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/** Friendlier names for tickers lib/tickers.ts does not name yet (kept here so the shared list stays untouched). */
const NAME_OVERRIDES: Record<string, string> = { CRCL: "Circle", USO: "United States Oil Fund" };

export function StocksV3() {
  const { symbols, count, ready, kindsOf } = useBuyableStocks();
  const { draft } = usePlanDraft();
  const stockHref = useStockHref();

  const list = ready ? symbols : STOCK_FALLBACK;
  const shown = list.slice(0, TILES_WIDE);
  const words = useMemo<readonly string[]>(() => (ready ? symbols.slice(0, CYCLE_COUNT) : CYCLE_FALLBACK), [ready, symbols]);

  // One observer for the section: the ring's pulse ([data-live]) and the ticker rotation both stop off-screen.
  const section = useRef<HTMLElement>(null);
  const live = useInView(section, { rootMargin: "0px" });
  const grid = useRef<HTMLDivElement>(null);
  const revealed = useInView(grid, { once: true });

  // Rotation holds while the visitor is reading the grid: a mouse over it, or keyboard focus on a tile.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const step = useCycleIndex(words.length, { interval: 1800, active: live && !hovered && !focused });
  const hot = words[step];

  // The builder's interval rides along only where a vault buys this stock at that interval; else the plain deep link.
  const tileHref = (sym: string) =>
    draft.touched && kindsOf(sym)?.includes(draft.kind) ? `${createPlanHref(sym)}&${FREQUENCY_PARAM}=${draft.kind}` : stockHref(sym);
  const ctaHref = draft.touched ? frequencyHref(draft.kind) : "/app/create";

  // "+ n more" is what is really left to buy beyond the tiles on screen, so a phone (7 tiles) counts more than a desktop.
  const remainder = (tiles: number) => (count === undefined ? 0 : count - Math.min(tiles, shown.length));

  const onPointer = (on: boolean) => (e: PointerEvent) => {
    if (e.pointerType !== "touch") setHovered(on);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };

  return (
    <section ref={section} id="stocks" className="container-x py-20" data-live={live ? "" : undefined}>
      <p className="eyebrow">Stocks</p>
      <h2 className="h-section mt-3">
        <span aria-hidden>
          DCA into <CycleWord words={words} index={step} className="text-lime-text" />.
        </span>
        <span className="sr-only">DCA into NVDA, TSLA, SPY, GLD and more.</span>
      </h2>
      <p className="lede mt-3 max-w-2xl">Robinhood Stock Tokens, from single stocks to ETFs. New ones are added as price feeds and liquidity go live.</p>

      {/* Staggered like <Reveal stagger>, but the cells are ours: tiles past the seventh drop out on a phone. */}
      <div
        ref={grid}
        className="v3-reveal v3-reveal-stagger mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
        data-in={revealed ? "" : undefined}
        onPointerEnter={onPointer(true)}
        onPointerLeave={onPointer(false)}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
      >
        {shown.map((sym, i) => (
          <div key={sym} className={`v3-reveal-item min-w-0 ${i >= TILES_NARROW ? "hidden sm:block" : ""}`} style={{ "--i": i } as Vars}>
            {/* The ring clears while the grid is in use, so the tile under the pointer never looks less picked than another. */}
            <StockTile symbol={sym} href={tileHref(sym)} hot={sym === hot && !hovered && !focused} />
          </div>
        ))}
        <div className="v3-reveal-item min-w-0" style={{ "--i": shown.length } as Vars}>
          <MoreTile narrow={remainder(TILES_NARROW)} wide={remainder(TILES_WIDE)} />
        </div>
      </div>
      {SHOW_TILE_PRICES && <PriceFootnote />}

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link href={ctaHref} className="btn-primary h-11 w-full sm:h-9 sm:w-auto">
          Start a plan
        </Link>
        <p className="max-w-xl text-[12.5px] leading-relaxed text-ink-3">
          Each Stock Token tracks the price of a listed stock or ETF: economic exposure, not shares, voting rights or dividends.
        </p>
      </div>
    </section>
  );
}

/**
 * One stock: logo, ticker and name. From `sm` up, hover or keyboard focus rolls the name over to "DCA this →"; on a
 * phone the name stays and a lime arrow marks the tile as a link. `hot` is the lime ring that follows the heading.
 */
function StockTile({ symbol, href, hot }: { symbol: string; href: string; hot: boolean }) {
  const name = NAME_OVERRIDES[symbol.toUpperCase()] ?? tickerName(symbol);
  // A ticker missing from TICKER_NAMES comes back as itself: don't print or announce it twice.
  const named = name.toUpperCase() !== symbol.toUpperCase();
  return (
    <Link
      href={href}
      aria-label={named ? `Start a plan for ${symbol}, ${name}` : `Start a plan for ${symbol}`}
      data-hot={hot ? "" : undefined}
      className="v3-hot group relative flex h-full min-w-0 items-center gap-2.5 rounded-lg border border-line bg-surface-3 p-3 transition-[border-color,box-shadow] duration-200 hover:border-lime-text/60 focus-visible:border-lime-text/60 sm:gap-3 sm:p-3.5 lg:gap-2.5 lg:p-3 xl:gap-3 xl:p-3.5"
    >
      <TileMark symbol={symbol} size={36} />
      <span className="min-w-0 flex-1">
        <span className="v3-tile-flip block">
          <span className="block">
            <span className="flex h-[34px] flex-col justify-center">
              <span className="pr-4 text-[15px] font-semibold leading-[18px] text-ink sm:pr-0">{symbol}</span>
              <span className="truncate text-[12px] leading-4 text-ink-3">{named ? name : "Stock Token"}</span>
            </span>
            <span className="hidden h-[34px] flex-col justify-center sm:flex">
              <span className="text-[15px] font-semibold leading-[18px] text-ink">{symbol}</span>
              <span className="text-[12px] leading-4 whitespace-nowrap text-lime-text">DCA this →</span>
            </span>
          </span>
        </span>
        {SHOW_TILE_PRICES && <TilePrice symbol={symbol} />}
      </span>
      {/* phone: the arrow shares the ticker's line, so the name below can run the full width before it truncates */}
      <span aria-hidden className="absolute top-3 right-3 text-[15px] leading-[18px] text-lime-text sm:hidden">
        →
      </span>
    </Link>
  );
}

/** The dashed last cell: what is left beyond the tiles (per breakpoint), or "See all stocks" when nothing or unknown. */
function MoreTile({ narrow, wide }: { narrow: number; wide: number }) {
  const title = (n: number) => (n > 0 ? `+ ${n} more` : "See all stocks");
  return (
    <Link
      href="/app/create"
      className="flex h-full min-w-0 items-center gap-2 rounded-lg border border-dashed border-line bg-surface-3 p-3 text-[13.5px] text-ink-2 transition-colors hover:border-ink hover:text-ink sm:gap-3 sm:p-3.5 lg:gap-2 lg:p-3 xl:gap-3 xl:p-3.5"
    >
      {/* Under 380px the ring gives its room to "More on the way" (it would otherwise run into the tile's padding). */}
      <span className="v3-ring max-[379px]:hidden sm:mx-1 lg:mx-0 lg:size-6 xl:mx-1 xl:size-7" aria-hidden>
        <Icon name="plus" size={14} />
      </span>
      {/* 18 + 16 px lines: the same 34px as a stock tile's text, so this cell never makes its row taller. Never truncated:
          the narrowest tiles (6 columns at ~1024px) tighten the padding and the ring instead. */}
      <span className="min-w-0">
        <span className="block leading-[18px] font-semibold whitespace-nowrap text-ink">
          <span className="sm:hidden">{title(narrow)}</span>
          <span className="hidden sm:inline">{title(wide)}</span>
        </span>
        <span className="block text-[12px] leading-4 whitespace-nowrap text-ink-3">More on the way</span>
      </span>
    </Link>
  );
}

/**
 * Price + 24h change under the name (SHOW_TILE_PRICES only). The row keeps its height while quotes load so tiles do
 * not jump; a missing quote leaves it blank, and a failed source removes it from every tile.
 */
function TilePrice({ symbol }: { symbol: string }) {
  const { quoteOf, failed } = useStockMarket();
  if (failed) return null;
  const q = quoteOf(symbol);
  return (
    <span className="num mt-0.5 flex h-4 items-center gap-1.5 overflow-hidden text-[11.5px] leading-4 whitespace-nowrap">
      {q && Number.isFinite(q.price) && (
        <>
          <span className="text-ink-2">{fmtPrice(q.price)}</span>
          {q.change24h !== null && Number.isFinite(q.change24h) && (
            <span className={q.change24h >= 0 ? "text-good" : "text-bad"}>{fmtChange(q.change24h)}</span>
          )}
        </>
      )}
    </span>
  );
}

/** Source line for the tile prices, gone with them when the source fails. */
function PriceFootnote() {
  const { failed } = useStockMarket();
  if (failed) return null;
  return <p className="mt-2.5 text-[11.5px] text-ink-3">Prices from CoinGecko, 24h change, for display only.</p>;
}
