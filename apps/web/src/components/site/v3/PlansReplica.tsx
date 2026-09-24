"use client";

import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useDirectory, useVaults } from "@/hooks/useProtocol";
import { useStockMarket, type StockQuote } from "@/hooks/useStockMarket";
import { Dot, Icon, StockAvatar } from "@/components/ui";
import { countdown } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { VAULT_META, type ProductionVaultKind } from "@/lib/config";
import { ClientCountdown, RollingNumber, useDocumentVisible, useMounted, useReducedMotion } from "./motion";
import { Threshold, TileMark, isWordmark, useFeeBps } from "./shared";
import { DEMO_PRICES } from "./config";
import "@/components/app/BoostCelebration.css";
import "./hero.css";

/*
 * The hero's right panel: My plans (app/app/plans/page.tsx) redrawn at hero size, with one buy firing on a clock.
 * Perks read the plan owner's wallet at each buy, so a wallet's My plans is all-Standard or all-holder: the switch
 * alternates one wallet between the two instead of mixing rows. On Standard the stock lands in the plan (Purchase value
 * rolls up, "Held for you"); for a $DCA holder it goes straight to the wallet (the cell stays at 0, a ghost rises out
 * of it, "Sent to wallet"). Every figure is a plain demo number computed below, net of the purchase fee, so the rows
 * and the stat strip always agree; only the AAPL / SPY countdowns are live, and nothing prints a fee.
 */

/* ------------------------------------------------------------------ demo model */

type Sym = keyof typeof DEMO_PRICES;
type Prices = Record<Sym, number>;
type View = "standard" | "holder";

/** USD of stock that `buys` buys of `per` dollars bring in after a `bps` purchase fee (one division: exact here). */
const netBought = (buys: number, per: number, bps: number) => (buys * per * (10_000 - bps)) / 10_000;

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** "$1,150.00"; the unrounded sums round once here, so the stat strip matches the rows (448.125 → $448.13). */
const usd = (n: number) => usdFormat.format(n);

/** A stock quantity at 4 dp with trailing zeros trimmed: "0.8292", "0". */
const qty = (n: number) => n.toFixed(4).replace(/\.?0+$/, "");

/** Live prices when the market feed has them (they move the quantities, never the USD values), else DEMO_PRICES. */
function pricesFrom(quotes: Record<string, StockQuote>): Prices {
  const pick = (s: Sym) => {
    const p = quotes[s]?.price;
    return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : DEMO_PRICES[s];
  };
  return { NVDA: pick("NVDA"), AAPL: pick("AAPL"), SPY: pick("SPY") };
}

/** The three example plans. Balances are fixed; NVDA's buy fires, and its gross $50 leaves the balance. */
const NVDA = { per: 50, buys: 2, balance: 1200 } as const;
const AAPL = { per: 20, buys: 5, balance: 1450, earned: 4.12 } as const;
const SPY = { per: 250, buys: 1, balance: 1162.4 } as const;

/* ------------------------------------------------------------------ the loop */

/**
 * One cycle is ~9.1 s: swap (fade to the view's pre-buy state) → count (0m 4s … 0m 1s) → due ("due now", the row
 * flashes) → fill (numbers roll; holder: the ghost rises; NVDA's next buy moves a week out and the Next buy stat hands
 * over to AAPL's daily buy) → toast → out → rest. `end` is the static frame: after the buy, toast up. It is what SSR,
 * reduced motion and every finished run show.
 */
type Phase = "swap" | "count" | "due" | "fill" | "toast" | "out" | "rest" | "end";

/** How long each phase holds before the next tick (ms); `count` ticks once a second from 4 down to 1. */
const HOLD: Record<Exclude<Phase, "end">, number> = { swap: 300, count: 1000, due: 500, fill: 300, toast: 2800, out: 300, rest: 900 };
const COUNT_FROM = 4;
/** The auto run: holder first (the Standard static frame was already on screen), then it stops on Standard (~37 s). */
const AUTO_RUN: View[] = ["holder", "standard", "holder", "standard"];
/** Delay between the replica coming into view and the first swap. */
const START_DELAY = 600;

type LoopState = {
  view: View;
  phase: Phase;
  /** Seconds left on NVDA's demo countdown while counting. */
  secs: number;
  /** Bumps at every swap: re-keys the rolling numbers (they reset without rolling) and alternates the swap fade. */
  cycle: number;
  /** Views still to play after this one; the last cycle settles on `end` instead of fading its toast out. */
  queue: View[];
  /** During a swap: the toast of the frame before, fading out (its view, and the NVDA price it was worked out at). */
  leaving?: { view: View; price: number };
  /** Sampled once per cycle, at its swap. */
  prices: Prices;
};

type LoopAction =
  | { type: "play"; views: View[]; prices: Prices }
  | { type: "restart"; prices: Prices }
  | { type: "tick"; prices: Prices }
  | { type: "show"; view: View; prices: Prices };

/** The toast that must fade out when a new cycle starts over this frame, if one is up. */
const leavingOf = (s: LoopState) => (s.phase === "toast" || s.phase === "end" ? { view: s.view, price: s.prices.NVDA } : undefined);

function loop(s: LoopState, a: LoopAction): LoopState {
  switch (a.type) {
    case "play": {
      const [view = s.view, ...queue] = a.views;
      return { ...s, view, queue, phase: "swap", secs: COUNT_FROM, cycle: s.cycle + 1, leaving: leavingOf(s), prices: a.prices };
    }
    case "restart":
      return { ...s, phase: "swap", secs: COUNT_FROM, cycle: s.cycle + 1, leaving: leavingOf(s), prices: a.prices };
    case "show":
      return { ...s, view: a.view, phase: "end", queue: [], leaving: undefined, prices: a.prices };
    case "tick":
      switch (s.phase) {
        case "swap":
          return { ...s, phase: "count", leaving: undefined };
        case "count":
          return s.secs > 1 ? { ...s, secs: s.secs - 1 } : { ...s, phase: "due" };
        case "due":
          return { ...s, phase: "fill" };
        case "fill":
          return { ...s, phase: "toast" };
        case "toast":
          return { ...s, phase: s.queue.length > 0 ? "out" : "end" };
        case "out":
          return { ...s, phase: "rest" };
        case "rest":
          return loop(s, { type: "play", views: s.queue, prices: a.prices });
        default:
          return s;
      }
  }
}

const STATIC_FRAME: LoopState = { view: "standard", phase: "end", secs: COUNT_FROM, cycle: 0, queue: [], prices: DEMO_PRICES };

/** Seconds from now to the next 00:00 UTC, as a unix time (the daily vault's fallback). */
const nextUtcMidnight = (now: number) => (Math.floor(now / 86_400) + 1) * 86_400;

/* ------------------------------------------------------------------ component */

export function PlansReplica() {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  const { quotes } = useStockMarket();
  const weeklyFee = useFeeBps("weekly");
  const dailyFee = useFeeBps("daily");
  const monthlyFee = useFeeBps("monthly");
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const visible = useDocumentVisible();

  const [state, dispatch] = useReducer(loop, STATIC_FRAME);
  const { view, phase, secs, cycle, prices } = state;

  // Refs the timers read, so the effects below only re-run on what should restart them.
  const stateRef = useRef(state);
  const quotesRef = useRef(quotes);
  useEffect(() => {
    stateRef.current = state;
    quotesRef.current = quotes;
  });
  const sample = () => pricesFrom(quotesRef.current);

  // On screen at all (pauses when not), 40% on screen (starts a run), and seen once (the entrance).
  const wrap = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [inView, setInView] = useState(false);
  const [seen, setSeen] = useState(false);
  /** A run may start: true on load, and again each time the finished replica fully leaves the viewport. */
  const armed = useRef(true);
  /** Frozen mid-cycle (off screen, hidden tab): the cycle replays from its swap on return. */
  const paused = useRef(false);
  /** The view the visitor picked: it stops the auto alternation for good. */
  const picked = useRef<View | undefined>(undefined);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        setOnScreen(e.isIntersecting);
        setInView(e.isIntersecting && e.intersectionRatio >= 0.4);
        if (e.isIntersecting) setSeen(true);
        else if (stateRef.current.phase === "end") armed.current = true;
      },
      { threshold: [0, 0.4] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = mounted && !reduced && visible && onScreen;
  const startable = running && inView;

  // Pause and resume: the frame freezes while off screen or in a background tab; back in view, the cycle replays.
  useEffect(() => {
    if (!running) {
      if (stateRef.current.phase !== "end") paused.current = true;
      return;
    }
    if (paused.current) {
      paused.current = false;
      if (stateRef.current.phase !== "end") dispatch({ type: "restart", prices: sample() });
    }
  }, [running]);

  // Start: 600 ms after the replica is 40% in view, once per load and once per full exit and return.
  useEffect(() => {
    if (!startable || stateRef.current.phase !== "end" || !armed.current) return;
    const t = setTimeout(() => {
      // A pick inside the delay already started its own cycle (and disarmed): never restart it.
      if (!armed.current || stateRef.current.phase !== "end") return;
      armed.current = false;
      dispatch({ type: "play", views: picked.current ? [picked.current] : AUTO_RUN, prices: sample() });
    }, START_DELAY);
    return () => clearTimeout(t);
  }, [startable]);

  // The clock: one timeout per phase (and per counted second) while running.
  useEffect(() => {
    if (!running || phase === "end") return;
    const t = setTimeout(() => dispatch({ type: "tick", prices: sample() }), HOLD[phase]);
    return () => clearTimeout(t);
  }, [running, phase, secs, cycle]);

  // Live prices for the resting frame: SSR and first paint work at DEMO_PRICES, and reduced motion never starts a run,
  // so once quotes arrive the frame at rest re-samples them (once: a later 60 s refetch does not jitter it; a run
  // samples at each swap as before). A run that already ended on live prices is left as it is.
  const liveSampled = useRef(false);
  useEffect(() => {
    if (liveSampled.current || Object.keys(quotes).length === 0 || phase !== "end") return;
    liveSampled.current = true;
    const live = pricesFrom(quotes);
    const now = stateRef.current.prices;
    if (live.NVDA !== now.NVDA || live.AAPL !== now.AAPL || live.SPY !== now.SPY) dispatch({ type: "show", view: stateRef.current.view, prices: live });
  }, [quotes, phase]);

  // Reduced motion switched on mid-run: settle on the current view's end state.
  useEffect(() => {
    if (reduced && stateRef.current.phase !== "end") dispatch({ type: "show", view: stateRef.current.view, prices: sample() });
  }, [reduced]);

  /** The view the visitor last picked, for the live region (the auto-run's own swaps are never announced). */
  const [spoken, setSpoken] = useState<View | undefined>(undefined);

  const pick = (v: View) => {
    picked.current = v;
    setSpoken(v);
    armed.current = false;
    paused.current = false;
    if (reduced || !mounted) dispatch({ type: "show", view: v, prices: sample() });
    else dispatch({ type: "play", views: [v], prices: sample() });
  };

  // The live countdowns (AAPL daily, SPY monthly): the vault's next buy while it is ahead, else a stand-in. Read after
  // mount (ClientCountdown shows a dash until then) and refreshed at every swap.
  const dailyLive = byKind.daily?.nextEpochStart;
  const monthlyLive = byKind.monthly?.nextEpochStart;
  const [targets, setTargets] = useState<{ daily?: bigint | number; monthly?: bigint | number }>({});
  useEffect(() => {
    const now = Date.now() / 1000;
    const ahead = (t: bigint | undefined) => t !== undefined && Number(t) > now;
    setTargets({
      daily: ahead(dailyLive) ? dailyLive : nextUtcMidnight(now),
      monthly: ahead(monthlyLive) ? monthlyLive : Math.floor(now) + 19 * 86_400,
    });
  }, [dailyLive, monthlyLive, cycle]);

  /* ---------- this frame's numbers ---------- */
  const std = view === "standard";
  const beforeBuy = phase === "swap" || phase === "count" || phase === "due";
  const landed = phase === "fill" || phase === "toast" || phase === "out" || phase === "rest";

  const nvdaBalance = beforeBuy ? NVDA.balance : NVDA.balance - NVDA.per;
  const nvdaUsd = std ? netBought(beforeBuy ? NVDA.buys : NVDA.buys + 1, NVDA.per, weeklyFee.standard) : 0;
  const aaplUsd = std ? netBought(AAPL.buys, AAPL.per, dailyFee.standard) : 0;
  const spyUsd = std ? netBought(SPY.buys, SPY.per, monthlyFee.standard) : 0;
  const totalBalance = nvdaBalance + AAPL.balance + SPY.balance;
  const stockValue = nvdaUsd + aaplUsd + spyUsd;
  /** One NVDA buy's stock for a view (the holder's fee is halved), at this cycle's price unless told otherwise. */
  const oneBuy = (v: View, price = prices.NVDA) => qty(netBought(1, NVDA.per, v === "holder" ? weeklyFee.holder : weeklyFee.standard) / price);

  // At the fill NVDA's next buy moves a week out, as a real My plans would once the buy lands.
  const nvdaNext = phase === "swap" || phase === "count" ? countdown(secs, 0) : phase === "due" ? "due now" : countdown(604_799, 0);
  const flashRow = phase === "due" || landed;
  const holderLanded = !std && landed;
  const ghost = !std && (phase === "fill" || phase === "toast");

  const toast = phase === "swap" ? state.leaving : phase === "toast" || phase === "out" || phase === "end" ? { view, price: prices.NVDA } : undefined;
  const toastMotion = phase === "toast" ? "v3-toast-in" : phase === "out" || phase === "swap" ? "v3-toast-out" : "";
  // Alternate the fade's animation name each cycle so it replays without re-mounting anything (see hero.css).
  const swapFade = cycle === 0 ? "" : cycle % 2 === 1 ? "v3-fade-swap" : "v3-hero-swap";

  const roll = (k: string, text: string) => <RollingNumber key={`${k}${cycle}`} rollIn={false} text={text} />;

  const nvdaQty: ReactNode = std ? roll("q", qty(nvdaUsd / prices.NVDA)) : "0";
  const nvdaUsdLine: ReactNode = std ? roll("u", usd(nvdaUsd)) : undefined;
  const rows: RowModel[] = [
    {
      sym: "NVDA",
      kind: "weekly",
      id: 12,
      per: NVDA.per,
      balance: roll("b", usd(nvdaBalance)),
      qty: nvdaQty,
      qtyUsd: nvdaUsdLine,
      next: <span className="num text-ink">{nvdaNext}</span>,
      fires: true,
    },
    {
      sym: "AAPL",
      kind: "daily",
      id: 7,
      per: AAPL.per,
      balance: usd(AAPL.balance),
      earned: usd(AAPL.earned),
      boosted: true,
      qty: std ? qty(aaplUsd / prices.AAPL) : "0",
      qtyUsd: std ? usd(aaplUsd) : undefined,
      next: <ClientCountdown target={targets.daily} className="text-ink" />,
    },
    {
      sym: "SPY",
      kind: "monthly",
      id: 3,
      per: SPY.per,
      balance: usd(SPY.balance),
      qty: std ? qty(spyUsd / prices.SPY) : "0",
      qtyUsd: std ? usd(spyUsd) : undefined,
      next: <ClientCountdown target={targets.monthly} className="text-ink" />,
    },
  ];
  const fx: RowFx = { flashRow, holderLanded, ghost: ghost ? `+${oneBuy("holder")} NVDA` : undefined, cycle };

  // From the fill on, AAPL's daily buy is the soonest, so the stat hands over with the row.
  const nextBuy = beforeBuy ? (
    <span className="num text-ink">{nvdaNext}</span>
  ) : (
    <ClientCountdown target={targets.daily} className="text-ink" />
  );
  const nextBuySub = beforeBuy ? "NVDA · Weekly" : "AAPL · Daily";
  // Two unbreakable halves, so a narrow tile wraps at the dot and nowhere else.
  const boostLine = (
    <>
      <span className="whitespace-nowrap">
        <span className="text-good">{usd(AAPL.balance)}</span> boosted ·
      </span>{" "}
      <span className="whitespace-nowrap">
        <span className="text-good">+{usd(AAPL.earned)}</span> earned
      </span>
    </>
  );

  return (
    <div className="relative min-w-0" data-replica-view={view} data-replica-phase={phase}>
      <div ref={wrap} className="v3-rise relative min-w-0" data-in={seen ? "" : undefined}>
        {/* The picture: hidden from assistive tech (the summary below says what it shows). */}
        <div aria-hidden className="panel relative min-w-0 shadow-[0_24px_80px_-24px_rgba(198,255,0,0.25)] @container">
          <div className="flex h-9 items-center gap-3 border-b border-line bg-surface-0 px-3 text-[12px]">
            <span className="flex gap-1">
              <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
              <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
              <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
            </span>
            <span className="font-semibold text-ink">My plans</span>
            <span className="chip-lime ml-auto">preview</span>
          </div>
          {/* toolbar: the switch is drawn by the layer above (it must stay reachable), the count sits right */}
          <div className="flex h-10 items-center gap-2 border-b border-line px-3">
            <span className="ml-auto text-[12px] text-ink-2">3 of 3</span>
          </div>

          <div className={`grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-[minmax(0,1fr)_auto_auto_minmax(0,1fr)] ${swapFade}`}>
            <Stat label="USD Balance" className="bg-surface-0" value={roll("t", usd(totalBalance))} sub={boostLine} />
            <Stat label="Purchased Stock Value" className="hidden sm:grid" value={roll("s", usd(stockValue))} />
            <Stat
              label="Plans"
              className="hidden sm:grid"
              value={
                <>
                  3<span className="v3-hero-active ml-2 text-[13px] font-normal text-ink-2">3 active</span>
                </>
              }
            />
            <Stat label="Next buy" value={nextBuy} sub={nextBuySub} />
          </div>

          <div className={swapFade}>
            <PlansTable rows={rows} fx={fx} />
            <PlanCards rows={rows} fx={fx} />
          </div>

          <div className="flex justify-between border-t border-line bg-surface-0 px-3 py-1.5 text-[11px] text-ink-3">
            <span className="flex items-center gap-1.5">
              <i className="h-1.5 w-1.5 rounded-full bg-good" /> Robinhood Chain
            </span>
            <span>non-custodial</span>
          </div>
        </div>

        {/* The switch, over the toolbar: a sibling of the hidden picture so it stays in the accessibility tree. */}
        <div className="absolute top-9 left-3 z-10 flex h-10 items-center">
          <div role="group" aria-label="Show the preview as" className="inline-flex rounded-full border border-line p-[3px] text-[12px] font-medium">
            {(
              [
                ["standard", "Standard"],
                ["holder", "$DCA holder"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => pick(v)}
                className={`h-6 rounded-full px-2.5 transition-colors ${
                  view === v ? (v === "holder" ? "bg-lime text-lime-ink" : "bg-ink text-surface-0") : "text-ink-2 hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {toast && <Toast view={toast.view} amount={oneBuy(toast.view, toast.price)} className={toastMotion} />}
      </div>

      {/* Not a live region: the auto-run swaps this on its own. The sr-only region below speaks only the visitor's picks. */}
      <p className={`mt-5 min-h-[2.5em] text-[12.5px] leading-snug text-ink-2 sm:mt-8 ${swapFade}`}>
        {std ? (
          <>
            <span className="font-medium text-ink">Standard:</span> each buy is held in your plan. Claim it to your wallet any time.
          </>
        ) : (
          <>
            <span className="font-medium text-ink">
              Holding <Threshold perk="max" compact />:
            </span>{" "}
            each buy is sent straight to your wallet, so Purchase value stays at 0.
          </>
        )}
      </p>
      <p className="sr-only" aria-live="polite">
        {spoken === "standard" ? (
          "Standard: each buy is held in your plan. Claim it to your wallet any time."
        ) : spoken === "holder" ? (
          <>
            Holding <Threshold perk="max" compact />: each buy is sent straight to your wallet, so Purchase value stays at 0.
          </>
        ) : null}
      </p>
      <p className="sr-only">
        Preview of the My plans page with three example plans: NVDA weekly, AAPL daily with Boost on, and SPY monthly. On Standard, each buy&apos;s
        stock is held in the plan until it is claimed. For a wallet holding <Threshold perk="max" compact />, each buy&apos;s stock is sent straight
        to the wallet, so Purchase value stays at 0.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

type RowModel = {
  sym: Sym;
  kind: ProductionVaultKind;
  id: number;
  per: number;
  balance: ReactNode;
  /** Boost earnings (static: they never tick in the preview). */
  earned?: string;
  boosted?: boolean;
  qty: ReactNode;
  /** Purchase value in USD; absent at 0, as on My plans. */
  qtyUsd?: ReactNode;
  next: ReactNode;
  /** The plan whose buy fires in the demo. */
  fires?: boolean;
};

/** What the firing row does this frame. */
type RowFx = { flashRow: boolean; holderLanded: boolean; ghost?: string; cycle: number };

function Stat({ label, value, sub, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`grid min-w-0 content-start gap-0.5 px-3 py-2.5 ${className}`}>
      <span className="v3-hero-stat-label truncate text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{label}</span>
      <span className="v3-hero-stat-value num whitespace-nowrap text-[17px] font-semibold text-ink">{value}</span>
      {sub && <span className="text-[11px] leading-snug text-ink-2">{sub}</span>}
    </div>
  );
}

function Mark({ sym, size, boosted }: { sym: string; size: number; boosted?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      {/* a wide wordmark (SPY's "STATE STREET") would shrink to a strip: the neutral monogram disc instead */}
      {isWordmark(sym) ? <TileMark symbol={sym} size={size} /> : <StockAvatar symbol={sym} size={size} />}
      {boosted && (
        <span className="boost-badge">
          <Icon name="bolt" size={9} />
        </span>
      )}
    </span>
  );
}

/** "+$4.12 earned" with the bolt, as a boosted plan's balance cell shows it. */
function Earned({ amount, className = "" }: { amount: string; className?: string }) {
  return (
    <span className={`flex items-center gap-1 text-[11.5px] text-good ${className}`}>
      <Icon name="bolt" size={11} className="text-lime" />+{amount} earned
    </span>
  );
}

/**
 * Purchase value, with the holder's fill effects on the firing plan: a lime wash under the "0" and the quantity
 * rising out of it as a ghost (keyed by cycle, so both replay each time).
 */
function PurchaseValue({ row, fx, align }: { row: RowModel; fx: RowFx; align: "right" | "left" }) {
  const live = row.fires;
  return (
    <>
      {live && fx.holderLanded && <span key={`w${fx.cycle}`} className="v3-flash pointer-events-none absolute inset-0" style={{ animationDuration: "600ms" }} />}
      <span className="relative">
        {row.qty} <span className="text-[11.5px] text-ink-2">{row.sym}</span>
      </span>
      {/* Always two lines: the holder's 0 has no USD line, and without the reserved line each phone card would lose ~17px
          at every Standard / holder swap and move everything below it. */}
      <span className={`relative block text-[11.5px] text-ink-2 ${row.qtyUsd === undefined ? "invisible" : ""}`}>{row.qtyUsd ?? "$0.00"}</span>
      {live && fx.ghost && (
        <span key={`g${fx.cycle}`} className={`v3-ghost-rise ${align === "right" ? "top-[calc(50%-15px)] right-[7px]" : "v3-hero-ghost-side top-px left-[3.5rem] text-[11px]"}`}>
          {fx.ghost}
        </span>
      )}
    </>
  );
}

/** Desktop and tablet: the My plans table, without its Actions column. Name and Status need the room (container ≥ 42rem). */
function PlansTable({ rows, fx }: { rows: RowModel[]; fx: RowFx }) {
  return (
    <table className="v3-hero-tbl tbl hidden w-full sm:table">
      <thead>
        <tr>
          <th>Plan</th>
          <th className="text-right">Per buy</th>
          <th className="text-right">Balance</th>
          <th className="text-right">Purchase value</th>
          <th>Next buy</th>
          <th className="hidden @min-[42rem]:table-cell">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const flash = r.fires && fx.flashRow ? "v3-flash" : "";
          return (
            <tr key={r.sym} className={r.boosted ? "boost-row" : ""}>
              <td className={flash}>
                <span className="flex items-center gap-2.5">
                  <Mark sym={r.sym} size={26} boosted={r.boosted} />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">
                      {r.sym} <span className="hidden font-normal text-ink-2 @min-[42rem]:inline">{tickerName(r.sym)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
                      <span className="inline-flex @min-[42rem]:hidden">
                        <Dot />
                      </span>
                      {VAULT_META[r.kind].label} · #{r.id}
                    </span>
                  </span>
                </span>
              </td>
              <td className={`num text-right ${flash}`}>
                {usd(r.per)}
                <span className="v3-hero-cadence block text-[11.5px] text-ink-2">per {VAULT_META[r.kind].per}</span>
              </td>
              <td className={`num text-right ${flash}`}>
                {r.balance}
                {r.earned && <Earned amount={r.earned} className="v3-hero-earned mt-0.5 justify-end" />}
              </td>
              <td className={`num relative text-right ${flash}`}>
                <PurchaseValue row={r} fx={fx} align="right" />
              </td>
              <td className={flash}>{r.next}</td>
              <td className={`hidden @min-[42rem]:table-cell ${flash}`}>
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <Dot />
                  Active
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Phones: NVDA and AAPL as cards, each field as a label / value pair. SPY only peeks out under them, fading into the
 * footer: it is the strip the toast lands on, so a receipt never covers a plan the visitor is reading.
 */
function PlanCards({ rows, fx }: { rows: RowModel[]; fx: RowFx }) {
  const full = rows.slice(0, -1);
  const peek = rows.at(-1);
  return (
    <div className="sm:hidden">
      {full.map((r) => (
        <PlanCard key={r.sym} row={r} fx={fx} />
      ))}
      {peek && (
        <div className="h-[76px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_40%,transparent_88%)]">
          <PlanCard row={peek} fx={fx} />
        </div>
      )}
    </div>
  );
}

function PlanCard({ row: r, fx }: { row: RowModel; fx: RowFx }) {
  return (
    <div className={`border-b border-line p-3 ${r.boosted ? "v3-card-boost" : ""} ${r.fires && fx.flashRow ? "v3-flash" : ""}`}>
      <div className="flex items-center gap-2.5 text-[13px]">
        <Mark sym={r.sym} size={28} boosted={r.boosted} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="font-medium text-ink">{r.sym}</span>
            <span className="truncate text-ink-2">{tickerName(r.sym)}</span>
          </span>
          <span className="block text-[12px] text-ink-2">
            {VAULT_META[r.kind].label} · #{r.id}
          </span>
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 self-start pt-1 text-[12px] text-ink">
          <Dot />
          Active
        </span>
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
        <Pair label="Per buy">
          {usd(r.per)} <span className="text-[11.5px] text-ink-2">per {VAULT_META[r.kind].per}</span>
        </Pair>
        <Pair label="Balance">
          {r.balance}
          {r.earned && <Earned amount={r.earned} className="mt-0.5" />}
        </Pair>
        <Pair label="Purchase value" className="relative">
          <PurchaseValue row={r} fx={fx} align="left" />
        </Pair>
        <Pair label="Next buy">{r.next}</Pair>
      </dl>
    </div>
  );
}

function Pair({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className={`num mt-0.5 text-[13px] text-ink ${className}`}>{children}</dd>
    </div>
  );
}

/**
 * The buy's receipt, in the Activity page's words: "Held for you" (stock waiting in the plan) or "Sent to wallet"
 * (a holder's stock, delivered). Over the panel's corner on desktop; on phones a two-line strip inside the panel,
 * over the SPY peek and just above the footer, so the chain line stays readable.
 */
function Toast({ view, amount, className }: { view: View; amount: string; className: string }) {
  const holder = view === "holder";
  return (
    <div
      aria-hidden
      className={`absolute inset-x-3 bottom-[35px] z-10 grid grid-cols-[auto_1fr] items-center gap-x-2 rounded-lg border border-line-strong bg-surface-2 px-3 py-2.5 shadow-pop sm:inset-x-auto sm:-bottom-4 sm:right-4 sm:w-[270px] sm:grid-cols-1 sm:p-3 ${className}`}
    >
      {holder ? (
        <span className="chip-lime gap-1 justify-self-start">
          <Icon name="wallet" size={12} />
          Sent to wallet
        </span>
      ) : (
        <span className="chip justify-self-start">Held for you</span>
      )}
      <span className="flex items-center gap-2 justify-self-end sm:mt-2 sm:justify-self-start">
        <StockAvatar symbol="NVDA" size={18} />
        <span className="num text-[14px] text-ink">+{amount} NVDA</span>
      </span>
      <span className="col-span-2 mt-1 text-[11.5px] text-ink-3 sm:col-span-1">{holder ? "Weekly · #12 · just now" : "Waiting in your plan. Claim any time."}</span>
    </div>
  );
}
