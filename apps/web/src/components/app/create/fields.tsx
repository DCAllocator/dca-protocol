"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseEther, parseUnits, type Address } from "viem";
import { TOP_STOCKS, type Stock } from "@/hooks/useProtocol";
import { useStockMarket, fmtPrice, fmtCap, fmtChange } from "@/hooks/useStockMarket";
import { StockAvatar, Icon, Tip, Modal } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { fmtUsd } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { BOOST, VAULT_META, type VaultKind } from "@/lib/config";
import type { Order, Pay } from "./useCreatePlan";

/*
 * The create card's field-level pieces, shared by /app/create and /app/create/2 (and, one day, by anything
 * else that picks a stock). Nothing here knows about the plan model: every piece is driven by props.
 */

/**
 * One field box of the card: label top-left (with an optional ⓘ beside it), an optional `aside` at the top right
 * (a mode switch, an ⓘ that belongs to a right-hand control), whatever the field needs beneath, an optional error line.
 */
export function Box({
  label,
  tip,
  aside,
  children,
  className = "",
  error,
}: {
  label: string;
  tip?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  error?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-surface-3 px-3.5 py-3.5 transition-colors focus-within:border-line-strong sm:px-4 ${className}`}>
      <div className="mb-2 flex min-h-[18px] items-center gap-1 text-[12.5px] text-ink-3">
        {label}
        {tip && <Tip text={tip} />}
        {aside && <span className="ml-auto flex items-center">{aside}</span>}
      </div>
      {children}
      {error && <div className="mt-2 text-[12.5px] text-bad">{error}</div>}
    </div>
  );
}

export function Detail({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-3">{k}</span>
      <span className="num text-right text-ink">{children}</span>
    </div>
  );
}

/** $DCA as the pickers show it (see `choiceLabel`). */
const DCA_CHOICE = { dca: true, symbol: "$DCA", name: "DCA Token" } as const;

/**
 * How a picker shows a choice: $DCA — the registry entry `useRankedStocks` matched to the directory's token by address,
 * passed in as `dca` — as "$DCA" / "DCA Token"; a Stock Token by its ticker and company name. Never decided by ticker.
 */
export function choiceLabel(s: { address: Address; symbol: string }, dca?: Address): { dca: boolean; symbol: string; name: string } {
  return dca && s.address.toLowerCase() === dca.toLowerCase() ? DCA_CHOICE : { dca: false, symbol: s.symbol, name: tickerName(s.symbol) };
}

/** A choice's mark: our own for $DCA, the company's logo for a Stock Token. */
export function ChoiceAvatar({ symbol, dca = false, size = 24 }: { symbol: string; dca?: boolean; size?: number }) {
  return dca ? <Logo size={size} /> : <StockAvatar symbol={symbol} size={size} />;
}

/** The plan being started, recalled at the top of the transaction dialog. */
export function OrderSummary({ order }: { order: Order }) {
  const { symbol, name } = order.dca ? DCA_CHOICE : { symbol: order.symbol, name: tickerName(order.symbol) };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-3 px-3.5 py-3">
      <ChoiceAvatar symbol={order.symbol} dca={order.dca} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[14px] font-medium text-ink">
          {symbol}
          {name !== symbol && <span className="truncate text-[12.5px] font-normal text-ink-3">{name}</span>}
        </div>
        <div className="text-[12.5px] text-ink-3">
          <span className="num text-ink-2">{fmtUsd(order.perBuy)}</span> every {everyLabel(order.kind)} · funded with <span className="num text-ink-2">{order.funded}</span>
        </div>
      </div>
      {order.boost && (
        <span className="chip-lime gap-1">
          <Icon name="bolt" size={12} />
          {BOOST.chip}
        </span>
      )}
    </div>
  );
}

/** USDG / ETH mark for the funding pill: a lime "$" for USDG, Ethereum's blue mark for ETH. */
export function Coin({ unit }: { unit: Pay }) {
  if (unit === "ETH") return <EthMark />;
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-lime text-[11px] font-bold text-lime-ink" aria-hidden>
      $
    </span>
  );
}

/** Ethereum's mark, white on its blue (#627EEA) disc, the way wallets and exchanges show ETH. Same box as `Coin`. */
function EthMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6 shrink-0" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#FFF">
        <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4 9 16.22l7.498-3.35z" />
        <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity=".2" d="m16.498 20.573 7.497-4.353-7.497-3.348z" />
        <path fillOpacity=".602" d="m9 16.22 7.498 4.353v-7.701z" />
      </g>
    </svg>
  );
}

/**
 * Trigger + menu; closes on outside click, Escape or `close()` from the content. The default trigger is a
 * token pill hanging its menu from the right edge; `plain` is bare text on the box's own background, as
 * tall as the amount line it sits beside, with the menu hanging from the left. `align` overrides the side
 * the menu hangs from (a plain trigger near the right edge must hang its menu from the right).
 */
export function Dropdown({
  trigger,
  children,
  width = "w-72",
  plain = false,
  align,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  width?: string;
  plain?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          plain
            ? "inline-flex h-[24px] items-center gap-1.5 text-[18px] font-medium text-ink transition-colors hover:text-ink-2 sm:h-[30px] sm:text-[20px]"
            : "inline-flex h-9 items-center gap-2 rounded-full border border-line-strong bg-surface-4 pr-2.5 pl-1.5 text-[14px] font-semibold text-ink transition-colors hover:border-ink"
        }
      >
        {trigger}
        <Icon name="chevron" size={14} className={`text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className={`menu absolute top-[calc(100%+6px)] max-h-80 overflow-y-auto ${(align ?? (plain ? "left" : "right")) === "left" ? "left-0" : "right-0"} ${width}`} role="listbox">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * The stock picker as a dialog (both create cards' stock row opens it, see `StockRow`): a search box, the largest
 * stocks as pills, then every approved stock as a row with its ticker, name, price, 24 h change and market cap. Ordered by live on-chain
 * market cap (/api/stock-market); until that answers — or if it is down — the snapshot order `stocks` arrives in
 * stands and the numbers show dashes, so picking never waits on prices. Enter picks the first match.
 *
 * $DCA (`dca`, see `choiceLabel`) is not on that feed: it stays pinned first, is never one of the market-cap pills, and
 * its row shows `dcaQuote` (the protocol router's price, as on the token page) or dashes.
 */
export function StockPickerDialog({
  open,
  onClose,
  stocks,
  value,
  onSelect,
  dca,
  dcaQuote,
  pillCount = TOP_STOCKS,
}: {
  open: boolean;
  onClose: () => void;
  stocks: Stock[];
  value: string;
  onSelect: (address: string) => void;
  dca?: Address;
  dcaQuote?: { price?: number; marketCap?: number };
  pillCount?: number;
}) {
  const { quoteOf, ready } = useStockMarket();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Fresh search every time it opens; focus it only with a mouse / trackpad (on a phone the keyboard would cover the list).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (window.matchMedia("(pointer: fine)").matches) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const isDca = (s: Stock) => choiceLabel(s, dca).dca;
  const ranked = useMemo(() => {
    const pin = (s: Stock) => (choiceLabel(s, dca).dca ? 1 : 0);
    const cap = (s: Stock) => quoteOf(s.symbol)?.marketCap ?? -1;
    return stocks
      .map((s, i) => ({ s, i }))
      .sort((a, b) => pin(b.s) - pin(a.s) || cap(b.s) - cap(a.s) || a.i - b.i)
      .map((x) => x.s);
  }, [stocks, quoteOf, dca]);
  const quoteFor = (s: Stock): { price?: number; change24h?: number | null; marketCap?: number | null } | undefined =>
    isDca(s) ? dcaQuote : quoteOf(s.symbol);
  const symbolOf = (s: Stock) => choiceLabel(s, dca).symbol;
  const nameOf = (s: Stock) => {
    const { name } = choiceLabel(s, dca);
    return isDca(s) || name !== s.symbol ? name : (quoteOf(s.symbol)?.name ?? s.symbol);
  };
  const pills = (ready ? ranked.filter((s) => (quoteOf(s.symbol)?.marketCap ?? 0) > 0) : ranked).filter((s) => !isDca(s)).slice(0, pillCount);
  const q = query.trim().toLowerCase();
  // The registry ticker or the shown one: "dca" and "$dca" are both exact for $DCA.
  const exact = (s: Stock) => s.symbol.toLowerCase() === q || symbolOf(s).toLowerCase() === q;
  const filtered = q
    ? ranked
        .filter((s) => symbolOf(s).toLowerCase().includes(q) || nameOf(s).toLowerCase().includes(q))
        // An exact ticker ("F", "ON", "NOW") beats every name that merely contains the letters.
        .sort((a, b) => Number(exact(b)) - Number(exact(a)))
    : ranked;
  const pick = (address: string) => {
    onSelect(address);
    onClose();
  };
  const cols = "grid-cols-[minmax(0,1fr)_84px_60px] sm:grid-cols-[minmax(0,1fr)_92px_68px]";

  return (
    <Modal open={open} onClose={onClose} title="Select a stock" width="max-w-[440px]">
      <label className="relative -mt-1 block">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute top-1/2 left-3 h-[15px] w-[15px] -translate-y-1/2 text-ink-3" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={input}
          className="input h-11 pl-9"
          placeholder="Search name or ticker"
          aria-label="Search stocks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) pick(filtered[0].address);
          }}
        />
      </label>

      {!q && pills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Largest by market cap">
          {pills.map((s) => {
            const active = s.address === value;
            return (
              <button
                key={s.address}
                type="button"
                onClick={() => pick(s.address)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border pr-2.5 pl-1 text-[12px] font-medium transition-colors ${
                  active ? "border-lime bg-lime/10 text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
                }`}
              >
                <StockAvatar symbol={s.symbol} size={20} />
                {s.symbol}
              </button>
            );
          })}
        </div>
      )}

      <div className={`mt-4 grid ${cols} gap-3 px-2 text-[10.5px] font-medium tracking-[0.08em] text-ink-3 uppercase`} aria-hidden>
        <span>Stock</span>
        <span className="text-right">Price · 24h</span>
        <span className="text-right">Mkt cap</span>
      </div>
      {/* Fixed height, not max-height: the dialog must not jump around while the results shrink under the search. */}
      <div role="listbox" aria-label="Stocks" className="-mx-5 mt-2 h-[min(52vh,440px)] overflow-y-auto border-t border-line px-3 py-1.5">
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">No stocks match &ldquo;{query}&rdquo;.</div>
        ) : (
          filtered.map((s) => {
            const quote = quoteFor(s);
            const selected = s.address === value;
            const change = quote?.change24h;
            return (
              <button
                key={s.address}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => pick(s.address)}
                className={`grid w-full ${cols} items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-3 ${selected ? "bg-surface-3" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <ChoiceAvatar symbol={s.symbol} dca={isDca(s)} size={32} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
                      {symbolOf(s)}
                      {selected && <Icon name="check" size={13} className="text-lime-text" />}
                    </span>
                    <span className="block truncate text-[12px] text-ink-3">{nameOf(s)}</span>
                  </span>
                </span>
                <span className="text-right">
                  <span className="num block text-[13px] text-ink">{fmtPrice(quote?.price)}</span>
                  <span className={`num block text-[11px] ${change === undefined || change === null ? "text-ink-3" : change >= 0 ? "text-good" : "text-bad"}`}>
                    {fmtChange(change)}
                  </span>
                </span>
                <span className="num text-right text-[13px] text-ink-2">{fmtCap(quote?.marketCap)}</span>
              </button>
            );
          })
        )}
      </div>
      <p className="mt-3 text-[11px] leading-normal text-ink-3">
        {ready
          ? `Prices and on-chain market caps via CoinGecko${dca ? " ($DCA: the protocol's router)" : ""}, refreshed every minute. Plans buy at the on-chain price when each buy runs.`
          : "Loading prices…"}
      </p>
    </Modal>
  );
}

/** Keep only digits and one decimal point. */
export const clean = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
/** The noun after "Every": day / week / month, or "test" for the local dev vault. */
export const everyLabel = (k: VaultKind) => (k === "test" ? "test" : VAULT_META[k].per);
/** "0.123456789012345678" → "0.1234": four decimals is plenty for a funding amount. */
export const trimEth = (v: string) => {
  const [i, f = ""] = v.split(".");
  const frac = f.slice(0, 4).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
};

export function safeParse(v: string, d: number): bigint | undefined {
  try {
    if (!v.trim()) return undefined;
    return parseUnits(v.trim(), d);
  } catch {
    return undefined;
  }
}
export function safeParseEth(v: string): bigint | undefined {
  try {
    if (!v.trim()) return undefined;
    return parseEther(v.trim());
  } catch {
    return undefined;
  }
}
