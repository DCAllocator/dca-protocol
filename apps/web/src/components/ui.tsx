"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { countdown } from "@/lib/format";
import { tickerIconUrl } from "@/lib/tickers";

/* ------------------------------------------------------------------ */
/* Layout                                                               */
/* ------------------------------------------------------------------ */

/** Page heading with optional description and a right-hand slot (summary numbers, a CTA). */
export function PageHeader({
  title,
  description,
  right,
  rightMobile = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  /** Hide the right slot below md when it only repeats what the page shows anyway. */
  rightMobile?: boolean;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-sub">{description}</p>}
      </div>
      {right && <div className={`${rightMobile ? "flex" : "hidden md:flex"} shrink-0 items-center gap-6`}>{right}</div>}
    </div>
  );
}

/**
 * Quiet card. `title` renders a normal-case header row; `flush` drops the padding (tables) and clips
 * content to the rounded corners. Padded cards are left unclipped so popovers (stock dropdown) can overflow.
 */
export function Card({
  title,
  actions,
  children,
  flush = false,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card min-w-0 ${flush ? "overflow-hidden" : ""} ${className}`}>
      {(title || actions) && (
        <header className={`flex items-center justify-between gap-2 ${flush ? "px-5 pt-4 pb-3" : "px-5 pt-4"}`}>
          <h2 className="text-[16px] font-medium text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "overflow-x-auto" : "card-pad"}>{children}</div>
    </section>
  );
}

/** Hero number card (Aave "Total deposits" style). */
export function StatCard({ label, value, delta, hint, children }: { label: ReactNode; value: ReactNode; delta?: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card card-pad flex min-w-0 flex-col">
      <div className="card-title">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <div className="stat-value">{value}</div>
        {delta && <div className="text-[14px] font-medium text-good">{delta}</div>}
      </div>
      {hint && <div className="mt-2 text-[12px] text-ink-3">{hint}</div>}
      {children && <div className="mt-5 flex-1">{children}</div>}
    </div>
  );
}

/** Small summary number for page headers ("Total deposits $32.84B"). */
export function HeaderStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="text-right">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="text-[22px] font-medium tracking-[-0.01em] text-ink tabular-nums">{value}</div>
    </div>
  );
}

/** Stat tile — kept for the landing page. */
export function Stat({ label, value, hint, hero = false }: { label: string; value: ReactNode; hint?: ReactNode; hero?: boolean }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={`mt-0.5 font-semibold tracking-tight text-ink ${hero ? "text-[40px] leading-none" : "text-[22px] leading-tight"}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

/** Range slider with a lime fill. `value` is clamped for display only; callers own the state. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const span = max - min;
  const pct = span <= 0 ? 0 : Math.min(100, Math.max(0, ((value - min) / span) * 100));
  return (
    <input
      type="range"
      className="range"
      style={{ ["--fill" as string]: `${pct}%` }}
      min={min}
      max={max}
      step={step}
      value={Math.min(max, Math.max(min, isFinite(value) ? value : min))}
      disabled={disabled || span <= 0}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={ariaLabel}
    />
  );
}

/** Amount field with a unit suffix and an optional "Max" action. */
export function AmountInput({
  value,
  onChange,
  unit,
  placeholder = "0.00",
  onMax,
  large = false,
}: {
  value: string;
  onChange: (v: string) => void;
  unit: string;
  placeholder?: string;
  onMax?: () => void;
  large?: boolean;
}) {
  return (
    <div className="relative">
      <input
        className={`input ${large ? "h-12 pr-24 text-[20px] font-semibold" : "pr-20"}`}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder={placeholder}
      />
      <div className="absolute inset-y-0 right-2.5 flex items-center gap-2 text-[12px] text-ink-3">
        {onMax && (
          <button type="button" onClick={onMax} className="rounded-sm px-1 text-[11px] font-semibold text-lime hover:bg-lime/10">
            MAX
          </button>
        )}
        <span>{unit}</span>
      </div>
    </div>
  );
}

/** Two-to-four option pill switch. */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-line bg-surface-3 p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-[30px] rounded-[7px] px-3 text-[13px] font-medium transition-colors ${
            value === o.value ? "bg-ink text-surface-0" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On/off switch (iOS style). Lime when on; the whole control is the button. */
export function Toggle({ checked, onChange, disabled = false, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "border-lime bg-lime" : "border-line-strong bg-surface-4"
      }`}
    >
      <span
        className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full shadow transition-[left] ${checked ? "left-[calc(100%-1.4rem)] bg-lime-ink" : "left-[3px] bg-ink"}`}
      />
    </button>
  );
}

/** Small ⓘ that reveals `text` on hover / focus. */
export function Tip({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span className={`group relative inline-flex ${className}`}>
      <button type="button" tabIndex={0} aria-label={text} className="inline-flex text-ink-3 hover:text-ink focus:text-ink">
        <Icon name="info" size={15} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-20 w-64 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-3 px-3 py-2 text-left text-[12px] leading-relaxed font-normal text-ink-2 opacity-0 shadow-[0_12px_32px_rgba(0,0,0,0.5)] transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Overlays                                                             */
/* ------------------------------------------------------------------ */

/** Centered dialog (bottom sheet on phones). Closes on Escape and backdrop click. */
export function Modal({ open, onClose, title, children, width = "max-w-md" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={`card w-full ${width} rounded-b-none sm:rounded-b-xl`}>
        <header className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-[16px] font-medium text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="btn-ghost h-8 w-8 px-0 text-ink-3">
            <Icon name="x" />
          </button>
        </header>
        <div className="card-pad">{children}</div>
      </div>
    </div>
  );
}

/**
 * Kebab / overflow menu. Rendered in a portal (fixed, anchored to the trigger) so it is never clipped by a
 * scrolling table or an overflow-hidden card. Closes on any click, outside click, Escape, scroll or resize.
 */
export function Menu({ label, items }: { label?: ReactNode; items: { label: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="btn-ghost h-8 w-8 px-0">
        {label ?? <Icon name="dots" />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={pop} role="menu" className="menu fixed" style={{ top: pos.top, right: pos.right }}>
            {items.map((it, i) => (
              <button
                key={i}
                role="menuitem"
                disabled={it.disabled}
                className={`menu-item ${it.danger ? "text-bad hover:text-bad" : ""}`}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Data display                                                         */
/* ------------------------------------------------------------------ */

/** Filled line chart from a numeric series. Renders a flat baseline for < 2 points. */
export function Sparkline({ points, height = 120, className = "" }: { points: number[]; height?: number; className?: string }) {
  const id = useId();
  const w = 600;
  const h = height;
  const pad = 4;
  const series = points.length >= 2 ? points : [0, 0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = (w - pad * 2) / (series.length - 1);
  const xy = series.map((v, i) => [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)] as const);
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${h} L${xy[0][0].toFixed(1)},${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`block h-full w-full ${className}`} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-lime)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-lime)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--color-lime)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Horizontal stacked bar for a composition (TVL breakdown). */
export function Composition({ parts }: { parts: { label: string; value: number; tone: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3">
        {total > 0 &&
          parts.map((p) => (
            <div key={p.label} className={p.tone} style={{ width: `${(p.value / total) * 100}%` }} />
          ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${p.tone}`} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function FeeChip({ bps }: { bps: number }) {
  return <span className="chip-lime">{(bps / 100).toFixed(2)}%</span>;
}

export function Countdown({ target, className = "" }: { target?: bigint | number; className?: string }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  if (target === undefined) return <span className="text-ink-3">—</span>;
  const tgt = Number(target);
  return <span className={`num ${className}`}>{tgt <= now ? "due now" : countdown(tgt, now)}</span>;
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const cls = {
    info: "border-line-strong bg-surface-3 text-ink-2",
    warn: "border-warn/30 bg-warn/10 text-warn",
    error: "border-bad/30 bg-bad/10 text-bad",
    ok: "border-lime/30 bg-lime/10 text-lime",
  }[kind];
  return <div className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${cls}`}>{children}</div>;
}

/** Tickers whose /tickers/<TICKER>.svg already 404'd this session, so later instances skip the probe. */
const missingLogos = new Set<string>();

/** Stock mark: the ticker's logo from /public/tickers when present, else its letters on a lime disc. */
export function StockAvatar({ symbol, size = 24 }: { symbol: string; size?: number }) {
  const key = symbol.toUpperCase();
  const [failed, setFailed] = useState(() => missingLogos.has(key));
  if (failed || !symbol || symbol === "?" || symbol === "…") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-lime font-semibold text-lime-ink"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
        aria-label={symbol}
      >
        {symbol.slice(0, 2)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="shrink-0"
      src={tickerIconUrl(symbol)}
      alt={symbol}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      onError={() => {
        missingLogos.add(key);
        setFailed(true);
      }}
    />
  );
}

/** Search field with a leading magnifier. */
export function SearchInput({ value, onChange, placeholder, ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; ariaLabel?: string }) {
  return (
    <label className="search block">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute top-1/2 left-3 h-[15px] w-[15px] -translate-y-1/2 text-ink-3" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input className="input pl-9" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel ?? placeholder} />
    </label>
  );
}

/** Sortable table header cell. */
export function SortTh<K extends string>({
  k,
  label,
  sort,
  onSort,
  right = false,
  className = "",
}: {
  k: K;
  label: string;
  sort: { key: K; dir: 1 | -1 };
  onSort: (k: K) => void;
  right?: boolean;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={`${right ? "text-right" : ""} ${active ? "is-sorted" : ""} ${className}`} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-btn" onClick={() => onSort(k)}>
        {label}
        <span className="arrow">{active && sort.dir === 1 ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

export function Dot({ tone = "good" }: { tone?: "good" | "warn" | "bad" | "muted" }) {
  const c = { good: "bg-good", warn: "bg-warn", bad: "bg-bad", muted: "bg-ink-3" }[tone];
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${c}`} />;
}

export function KV({ k, v, mono = true }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <span className="text-ink-3">{k}</span>
      <span className={`text-right text-ink ${mono ? "num" : ""}`}>{v}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-12 text-center text-[13px] text-ink-3">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Icons (16px, stroke)                                                 */
/* ------------------------------------------------------------------ */

export type IconName = "plus" | "plans" | "activity" | "overview" | "token" | "docs" | "x" | "dots" | "menu" | "arrow" | "external" | "check" | "chevron" | "info" | "bolt";

export function Icon({ name, size = 16, className = "" }: { name: IconName; size?: number; className?: string }) {
  const p: Record<IconName, ReactNode> = {
    plus: <path d="M8 3v10M3 8h10" />,
    plans: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M5.5 7h5M5.5 9.5h3" />
      </>
    ),
    activity: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" />
      </>
    ),
    overview: (
      <>
        <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
        <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
        <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
        <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
      </>
    ),
    token: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M6 8h4M8 6v4" />
      </>
    ),
    docs: (
      <>
        <path d="M4 2.5h5.5L12.5 5.5V13.5H4z" />
        <path d="M9.5 2.5v3h3" />
      </>
    ),
    x: <path d="M4 4l8 8M12 4l-8 8" />,
    dots: (
      <>
        <circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
    menu: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
    arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
    external: (
      <>
        <path d="M6.5 3.5H3.5v9h9V9.5" />
        <path d="M9 3h4v4M13 3l-6 6" />
      </>
    ),
    check: <path d="M3 8.5l3 3 7-7" />,
    chevron: <path d="M4 6l4 4 4-4" />,
    info: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7.2v4M8 5v.2" />
      </>
    ),
    bolt: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor" stroke="none" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {p[name]}
    </svg>
  );
}
