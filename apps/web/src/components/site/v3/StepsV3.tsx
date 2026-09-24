"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type AnimationEvent, type CSSProperties, type FocusEvent, type ReactNode } from "react";
import { useDirectory, useVaults } from "@/hooks/useProtocol";
import { Icon, StockAvatar } from "@/components/ui";
import { PRODUCTION_VAULT_KINDS, VAULT_META, type ProductionVaultKind } from "@/lib/config";
import { tickerName } from "@/lib/tickers";
import { AMOUNT_PARAM_SUPPORTED, BUILDER_AMOUNTS, BUILDER_FALLBACK, INTERVAL_WORD } from "./config";
import { ClientCountdown, LiveRegion, Reveal, useInView, useReducedMotion } from "./motion";
import { planHref, usePlanDraft } from "./PlanDraft";
import { Threshold, useBuyableStocks } from "./shared";
import "./steps.css";

/*
 * "Three steps": how it works on the left, and on the right the visitor writes step 01 themselves as a
 * plan sentence ("Buy $50 of NVDA every week.") that deep-links into Create plan. Each pill is a native <select> laid
 * invisibly over it, so phones get the OS picker and keyboards get a real form control. The sentence is the shared
 * plan draft (PlanDraft.tsx), so the stock tiles, the sticky bar and the closing band follow whatever is picked here.
 */

const STEPS: { n: string; title: string; body: ReactNode }[] = [
  {
    n: "01",
    title: "Pick a stock and a buy interval",
    body: "NVDA, TSLA, SPY, GLD and more. Buy hourly, daily, weekly or monthly, from $10 a buy.",
  },
  {
    n: "02",
    title: "Deposit once",
    body: "Pay in USDG (a dollar stablecoin) or ETH, which converts to USDG on deposit. Withdraw idle funds any time.",
  },
  {
    n: "03",
    title: "It buys on the clock",
    body: (
      <>
        Plans on the same stock and buy interval go in as one trade, and your plan gets its share. Hold{" "}
        <span className="whitespace-nowrap font-medium text-ink">
          <Threshold compact />
        </span>{" "}
        and it&apos;s sent straight to your wallet; otherwise it waits in your plan until you claim it.
      </>
    ),
  },
];

/** Stock options per interval are capped here (market-cap order), plus the current pick if it ranks lower. */
const MAX_STOCK_OPTIONS = 40;

export function StepsV3() {
  // Step 01's disc lights up while a pill in the builder has focus: the visitor is doing step 01 right there.
  const [picking, setPicking] = useState(false);
  // A LiveRegion: the builder's cadence dot (.v3-live-dot) pulses only while the section is on screen.
  return (
    <LiveRegion as="section" className="border-y border-line bg-surface-2">
      <div className="container-x grid gap-10 py-20 lg:grid-cols-[5fr_7fr] lg:items-center">
        <div className="min-w-0">
          <p className="eyebrow">How it works</p>
          <h2 className="h-section mt-3">
            Three steps. <span className="block">Then it runs itself.</span>
          </h2>
          <StepList picking={picking} />
        </div>
        <PlanBuilder onPicking={setPicking} />
      </div>
    </LiveRegion>
  );
}

/**
 * The numbered steps, joined by a hairline from each disc to the next (steps.css). Staggered like `<Reveal stagger>`,
 * but the classes sit on the <ol> and its <li>s directly (Reveal would wrap each item in a <div>, which an <ol> must
 * not contain).
 */
function StepList({ picking }: { picking: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  const inView = useInView(ref, { once: true });
  return (
    <ol ref={ref} data-in={inView ? "" : undefined} className="v3-reveal v3-reveal-stagger v3-steps-rail mt-8 space-y-6">
      {STEPS.map((s, i) => (
        <li key={s.n} className="v3-reveal-item v3-steps-li grid grid-cols-[36px_1fr] gap-4" style={{ "--i": i } as CSSProperties}>
          <span
            aria-hidden
            data-active={i === 0 && picking ? "" : undefined}
            className="num relative z-10 grid h-9 w-9 place-items-center rounded-full border border-line bg-surface-2 text-[12px] font-semibold text-lime-text transition-colors duration-150 data-[active]:border-lime data-[active]:bg-lime data-[active]:text-lime-ink"
          >
            {s.n}
          </span>
          <div className="min-w-0 pt-1.5">
            <h3 className="text-[17px] font-semibold text-ink">{s.title}</h3>
            <p className="mt-1 max-w-md text-pretty text-[14px] leading-relaxed text-ink-2">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ the plan builder */

type PlanPick = { symbol: string; amount: number; kind: ProductionVaultKind };
type Field = keyof PlanPick;
type Pulses = Record<Field | "cta", number>;

const fmtAmount = (n: number) => `$${n.toLocaleString("en-US")}`;

/** "NVDA · NVIDIA"; just the ticker when there is no friendlier name. */
const stockLabel = (sym: string) => {
  const name = tickerName(sym);
  return name.toUpperCase() === sym.toUpperCase() ? sym : `${sym} · ${name}`;
};

/**
 * The first buy boundary after now: vault epochs are fixed-length periods from an origin, so `nextEpochStart` rolls
 * forward (or back) by whole epochs. That keeps the countdown honest when the read is older than the boundary (the
 * vault read refreshes only on the app's 15 s poll, and a local chain's clock lags) and it never shows "due now". Undefined until mounted, and when a
 * past boundary cannot be rolled (no epoch length).
 */
function useNextBuy(start: bigint | undefined, length: number | undefined): number | undefined {
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => setNow(Date.now() / 1000), [start, length]);
  let next: number | undefined;
  if (start !== undefined && now !== undefined) {
    const s = Number(start);
    next = length ? s + (Math.floor((now - s) / length) + 1) * length : s > now ? s : undefined;
  }
  // Re-roll just before the boundary, so the countdown goes 0m 0s → the next period without a "due now" frame.
  useEffect(() => {
    if (next === undefined) return;
    const ms = Math.max(0, (next - Date.now() / 1000) * 1000 - 150);
    const t = setTimeout(() => setNow(Date.now() / 1000 + 0.2), Math.min(ms, 2_147_483_647));
    return () => clearTimeout(t);
  }, [next]);
  return next;
}

/**
 * "Buy {amount} of {stock} every {interval}." Options come from the chain: stocks this interval actually buys
 * (market-cap order), amounts at or above the vault's minimum per buy, intervals with at least one buyable stock.
 * Before the chain answers (or with no deployment configured) the fallback stocks and every amount show. What the
 * visitor sees is the draft normalised against those options (`shown`); a touched draft is written back when the
 * options move under it, an untouched one is left alone and the CTA links the shown pick directly.
 */
function PlanBuilder({ onPicking }: { onPicking: (v: boolean) => void }) {
  const { draft, update, href: draftHref } = usePlanDraft();
  const reduced = useReducedMotion();
  const { vaults, configured } = useDirectory();
  const { byKind } = useVaults(vaults);
  const buyable = useBuyableStocks();
  const live = buyable.ready;

  const lists = useMemo(() => {
    const out = {} as Record<ProductionVaultKind, string[]>;
    for (const k of PRODUCTION_VAULT_KINDS) out[k] = live ? buyable.symbols.filter((s) => buyable.kindsOf(s)?.includes(k)) : [...BUILDER_FALLBACK];
    return out;
  }, [live, buyable]);
  const kinds = PRODUCTION_VAULT_KINDS.filter((k) => lists[k].length > 0);
  const kindOptions = kinds.length > 0 ? kinds : [...PRODUCTION_VAULT_KINDS];

  const minUsd = (k: ProductionVaultKind) => {
    const m = byKind[k]?.minAmountPerEpoch;
    return m === undefined ? 0 : Number(m) / 1e6;
  };
  const amountsFor = (k: ProductionVaultKind) => {
    const min = minUsd(k);
    const ok = BUILDER_AMOUNTS.filter((a) => a >= min);
    return ok.length > 0 ? ok : [Math.ceil(min)];
  };

  /**
   * Fits a pick to the options. `keep` says which side wins when the interval does not buy the stock: "symbol" (a
   * draft set elsewhere, e.g. a stock tile) moves to the nearest interval that buys it; "kind" (the visitor just picked
   * an interval) swaps the stock for that interval's top-ranked one. An amount under the minimum rises to the first
   * allowed option.
   */
  const normalise = (p: PlanPick, keep: "symbol" | "kind" = "symbol"): PlanPick => {
    let kind = kindOptions.includes(p.kind) ? p.kind : kindOptions[0];
    if (live && keep === "symbol" && !lists[kind].includes(p.symbol)) {
      const at = PRODUCTION_VAULT_KINDS.indexOf(kind);
      const near = kindOptions
        .filter((k) => lists[k].includes(p.symbol))
        .sort((a, b) => Math.abs(PRODUCTION_VAULT_KINDS.indexOf(a) - at) - Math.abs(PRODUCTION_VAULT_KINDS.indexOf(b) - at))[0];
      if (near) kind = near;
    }
    const list = lists[kind];
    // Before the list is real, an unknown ticker (a restored draft) stays and joins the options.
    const symbol = !live || list.includes(p.symbol) ? p.symbol : (list[0] ?? p.symbol);
    const amount = p.amount >= minUsd(kind) ? p.amount : amountsFor(kind)[0];
    return { symbol, amount, kind };
  };

  const shown = normalise({ symbol: draft.symbol, amount: draft.amount, kind: draft.kind });
  const drifted = shown.symbol !== draft.symbol || shown.amount !== draft.amount || shown.kind !== draft.kind;
  const href = drifted ? planHref(shown, live) : draftHref;
  // The link drops `stock=` before the app is configured or the buyable list is in: say only what it will open on.
  const hasStock = href.includes("stock=");

  const stockOptions = lists[shown.kind].slice(0, MAX_STOCK_OPTIONS);
  if (!stockOptions.includes(shown.symbol)) stockOptions.push(shown.symbol);
  const amountOptions = [...new Set([...amountsFor(shown.kind), shown.amount])].sort((a, b) => a - b);

  // A change flashes the pill(s) it moved and bumps the CTA; each counter re-keys its animation.
  const [pulses, setPulses] = useState<Pulses>({ symbol: 0, amount: 0, kind: 0, cta: 0 });
  const pulse = (fields: Field[], cta: boolean) =>
    setPulses((p) => {
      const n = { ...p };
      for (const f of fields) n[f] += 1;
      if (cta) n.cta += 1;
      return n;
    });
  const moved = (a: PlanPick, b: PlanPick) => (["symbol", "amount", "kind"] as const).filter((f) => a[f] !== b[f]);

  const commit = (patch: Partial<PlanPick>) => {
    const next = normalise({ ...shown, ...patch }, patch.kind ? "kind" : "symbol");
    update(next);
    pulse(moved(shown, next), true);
  };

  // A touched draft that no longer fits (its interval stopped buying the stock, a new minimum) is written back, and the
  // corrected pill flashes. Stock and interval wait for fresh keeper pairs, so a stale restored list never rewrites it.
  const fresh = buyable.count !== undefined;
  useEffect(() => {
    if (!draft.touched || !drifted) return;
    if (!fresh && (shown.symbol !== draft.symbol || shown.kind !== draft.kind)) return;
    update(shown);
    pulse(moved({ symbol: draft.symbol, amount: draft.amount, kind: draft.kind }, shown), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.touched, drifted, fresh, draft.symbol, draft.amount, draft.kind, shown.symbol, shown.amount, shown.kind]);

  // One nudge on the stock pill, 900ms after the card is 40% in view, if nothing has been picked yet.
  const cardRef = useRef<HTMLDivElement>(null);
  const seen = useInView(cardRef, { once: true, threshold: 0.4 });
  const [nudge, setNudge] = useState<"idle" | "on" | "done">("idle");
  useEffect(() => {
    if (!seen || reduced || draft.touched || nudge !== "idle") return;
    const t = setTimeout(() => setNudge("on"), 900);
    return () => clearTimeout(t);
  }, [seen, reduced, draft.touched, nudge]);

  // The CTA bumps on every change (its arrow pops via anim-pop, re-keyed below).
  const ctaRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!pulses.cta || reduced) return;
    ctaRef.current?.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.035)", offset: 0.4 }, { transform: "scale(1)" }], {
      duration: 380,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  }, [pulses.cta, reduced]);

  const vault = byKind[shown.kind];
  const nextBuy = useNextBuy(configured && vault?.paused === false ? vault.nextEpochStart : undefined, vault?.epochLength);

  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onPicking(false);
  };

  return (
    <div ref={cardRef} className="min-w-0">
      <Reveal className="panel v3-steps-card bg-surface-1 p-6 md:p-8">
        <div role="group" aria-labelledby="v3-plan-label">
          <p id="v3-plan-label" className="eyebrow">
            Your plan
          </p>
          <p
            className="mt-4 text-[28px] font-semibold leading-[1.25] tracking-tight text-ink sm:text-[34px] md:text-[40px]"
            onFocus={() => onPicking(true)}
            onBlur={onBlur}
          >
            <span className="whitespace-nowrap">
              Buy{" "}
              <PickPill
                label="Amount per buy"
                value={String(shown.amount)}
                options={amountOptions.map((a) => ({ value: String(a), label: fmtAmount(a) }))}
                onChange={(v) => commit({ amount: Number(v) })}
                flash={pulses.amount}
              >
                {fmtAmount(shown.amount)}
              </PickPill>
            </span>{" "}
            <span className="whitespace-nowrap">
              of{" "}
              <PickPill
                label="Stock"
                value={shown.symbol}
                options={stockOptions.map((s) => ({ value: s, label: stockLabel(s) }))}
                onChange={(v) => commit({ symbol: v })}
                flash={pulses.symbol}
                className={nudge === "on" ? "v3-nudge" : ""}
                onAnimationEnd={(e) => {
                  if (e.animationName === "v3-nudge") setNudge("done");
                }}
                mark={
                  <span className="v3-steps-mark inline-flex">
                    <StockAvatar symbol={shown.symbol} size={28} />
                  </span>
                }
              >
                {shown.symbol}
              </PickPill>
            </span>{" "}
            <span className="whitespace-nowrap">
              every{" "}
              <PickPill
                label="Buy interval"
                value={shown.kind}
                options={kindOptions.map((k) => ({ value: k, label: INTERVAL_WORD[k] }))}
                onChange={(v) => commit({ kind: v as ProductionVaultKind })}
                flash={pulses.kind}
              >
                {INTERVAL_WORD[shown.kind]}
              </PickPill>
              .
            </span>
          </p>

          {/* On phones the countdown drops under the cadence instead of wrapping mid-line (the dot separator hides there). */}
          <p key={shown.kind} className={`mt-4 flex items-start gap-2 text-[13px] leading-5 text-ink-2 ${pulses.kind ? "v3-fade-swap" : ""}`}>
            <span aria-hidden className={`mt-[6.5px] ${nextBuy !== undefined ? "v3-live-dot shrink-0" : "h-[7px] w-[7px] shrink-0 rounded-full bg-ink-3"}`} />
            <span>
              {VAULT_META[shown.kind].cadence}
              {nextBuy !== undefined && (
                <>
                  <span className="hidden sm:inline"> · </span>
                  <span className="block whitespace-nowrap sm:inline">
                    next buy in <ClientCountdown target={nextBuy} className="text-ink" />
                  </span>
                </>
              )}
            </span>
          </p>

          <div className="mt-6 flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
            <p className="max-w-[34ch] text-pretty text-[12.5px] leading-snug text-ink-3">
              {AMOUNT_PARAM_SUPPORTED && hasStock
                ? "Opens the plan form with this filled in. You confirm everything in your wallet."
                : hasStock
                  ? "Opens the plan form on this stock and buy interval. You confirm everything in your wallet."
                  : "Opens the plan form on this buy interval. You confirm everything in your wallet."}
            </p>
            <Link
              ref={ctaRef}
              href={href}
              aria-label={`Start this plan: ${fmtAmount(shown.amount)} of ${shown.symbol} every ${INTERVAL_WORD[shown.kind]}`}
              className="btn-primary btn-lg w-full sm:w-auto"
            >
              Start this plan{" "}
              <span key={pulses.cta} aria-hidden className={`inline-block ${pulses.cta ? "anim-pop" : ""}`}>
                →
              </span>
            </Link>
          </div>
        </div>
      </Reveal>
    </div>
  );
}

/**
 * One pill of the sentence: the current value (plus an optional logo) and a chevron, with a native <select> laid
 * invisibly over the whole pill (.v3-pick). The label is aria-hidden: the select carries the name and the value.
 * `flash` > 0 re-keys a lime wash, a fading lime edge and the label's slide-in, so they replay on every change and
 * never on first paint.
 */
function PickPill({
  label,
  value,
  options,
  onChange,
  flash,
  mark,
  className = "",
  onAnimationEnd,
  children,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  flash: number;
  mark?: ReactNode;
  className?: string;
  onAnimationEnd?: (e: AnimationEvent<HTMLSpanElement>) => void;
  children: ReactNode;
}) {
  return (
    <span className={`v3-pick my-1 items-baseline leading-[1.1] ${className}`} onAnimationEnd={onAnimationEnd}>
      {flash > 0 && (
        <>
          <span key={`f${flash}`} aria-hidden className="v3-flash pointer-events-none absolute inset-0 rounded-[inherit]" />
          <span key={`r${flash}`} aria-hidden className="v3-steps-ring pointer-events-none absolute -inset-px rounded-[inherit]" />
        </>
      )}
      <span key={`${value}:${flash}`} aria-hidden className={`relative inline-flex items-baseline gap-[0.22em] ${flash > 0 ? "v3-steps-swap" : ""}`}>
        {mark && <span className="self-center">{mark}</span>}
        <span>{children}</span>
      </span>
      <Icon name="chevron" size={14} className="relative shrink-0 self-center text-ink-3" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="bg-surface-1 text-ink">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
