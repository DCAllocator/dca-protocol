"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseEther, parseUnits } from "viem";
import type { Stock } from "@/hooks/useProtocol";
import { StockAvatar, Icon, Tip } from "@/components/ui";
import { fmtUsd } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { BOOST, VAULT_META, type VaultKind } from "@/lib/config";
import type { Order, Pay } from "./useCreatePlan";

/*
 * The create card's field-level pieces, shared by /app/create and /app/create/2 (and, one day, by anything
 * else that picks a stock). Nothing here knows about the plan model: every piece is driven by props.
 */

/** One field box of the card: label top-left, whatever the field needs beneath, an optional error line. */
export function Box({ label, tip, children, className = "", error }: { label: string; tip?: string; children: ReactNode; className?: string; error?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-surface-3 px-3.5 py-3.5 transition-colors focus-within:border-line-strong sm:px-4 ${className}`}>
      <div className="mb-2 flex items-center gap-1 text-[12.5px] text-ink-3">
        {label}
        {tip && <Tip text={tip} />}
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

/** The plan being started, recalled at the top of the transaction dialog. */
export function OrderSummary({ order }: { order: Order }) {
  const name = tickerName(order.symbol);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-3 px-3.5 py-3">
      <StockAvatar symbol={order.symbol} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[14px] font-medium text-ink">
          {order.symbol}
          {name !== order.symbol && <span className="truncate text-[12.5px] font-normal text-ink-3">{name}</span>}
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

/** USDG / ETH mark for the funding pill. */
export function Coin({ unit }: { unit: Pay }) {
  return (
    <span
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
        unit === "USDG" ? "bg-lime text-lime-ink" : "bg-surface-4 text-ink"
      }`}
      aria-hidden
    >
      {unit === "USDG" ? "$" : "Ξ"}
    </span>
  );
}

/**
 * Trigger + menu; closes on outside click, Escape or `close()` from the content. The default trigger is a
 * token pill hanging its menu from the right edge; `plain` is bare text on the box's own background, as
 * tall as the amount line it sits beside, with the menu hanging from the left.
 */
export function Dropdown({ trigger, children, width = "w-72", plain = false }: { trigger: ReactNode; children: (close: () => void) => ReactNode; width?: string; plain?: boolean }) {
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
        <div className={`menu absolute top-[calc(100%+6px)] max-h-80 overflow-y-auto ${plain ? "left-0" : "right-0"} ${width}`} role="listbox">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * Token-selector pill for the stock, with the ranked, searchable list beneath. No prices on purpose: the
 * picker does not need one to choose a stock, and quoting every registry stock cost one eth_call each.
 */
export function StockPicker({ stocks, value, onSelect }: { stocks: Stock[]; value: string; onSelect: (address: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? stocks.filter((s) => s.symbol.toLowerCase().includes(q) || tickerName(s.symbol).toLowerCase().includes(q)) : stocks;
  const selected = stocks.find((s) => s.address === value);
  return (
    <Dropdown
      width="w-[min(20rem,calc(100vw-3rem))]"
      trigger={
        selected ? (
          <>
            <StockAvatar symbol={selected.symbol} size={24} />
            {selected.symbol}
          </>
        ) : (
          <span className="pl-1.5 font-medium text-ink-2">Select stock</span>
        )
      }
    >
      {(close) => (
        <>
          <div className="sticky top-0 border-b border-line bg-surface-3 p-1.5">
            <input autoFocus className="input h-9" placeholder="Search a stock (e.g. NVDA, Apple)" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">No stocks match &ldquo;{query}&rdquo;.</div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.address}
                type="button"
                role="option"
                aria-selected={s.address === value}
                onClick={() => {
                  onSelect(s.address);
                  setQuery("");
                  close();
                }}
                className={`menu-item gap-2.5 ${s.address === value ? "bg-surface-4 text-ink" : ""}`}
              >
                <StockAvatar symbol={s.symbol} size={22} />
                <span className="min-w-0 flex-1 truncate text-left">
                  <span className="text-[13px] font-medium text-ink">{s.symbol}</span>
                  {tickerName(s.symbol) !== s.symbol && <span className="ml-1.5 text-[12px] text-ink-3">{tickerName(s.symbol)}</span>}
                </span>
              </button>
            ))
          )}
        </>
      )}
    </Dropdown>
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
