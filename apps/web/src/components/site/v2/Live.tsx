"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDirectory, useVaults, useStocks, useRankedStocks, useBoostApys, usePerkThresholds, useDcaToken, boostAvailable } from "@/hooks/useProtocol";
import { useFeeReceiver, useBurnLogs } from "@/hooks/useFeeReceiver";
import { Countdown, StockAvatar } from "@/components/ui";
import { StockGrid } from "@/components/site/LandingLive";
import { fmtUsd, fmtUsdCompact, fmtUnits, fmtUnitsCompact, fmtPct, short } from "@/lib/format";
import { VAULT_META, isZero, type ProductionVaultKind } from "@/lib/config";
import { tickerName } from "@/lib/tickers";
import marketCapSnapshot from "@/data/market-caps.json";
import { V2, DEAD, explorerAddress, explorerTx, pct, halfBps } from "./config";

export { LaunchAppLink } from "@/components/site/LandingLive";

/* ------------------------------------------------------------------ helpers */

/** Counts a bigint up from 0 the first time it is known, then snaps to every later value. */
function useCountUp(target: bigint | undefined, ms = 1200): bigint | undefined {
  const [shown, setShown] = useState<bigint | undefined>(undefined);
  const animated = useRef(false);
  useEffect(() => {
    if (target === undefined) return;
    if (animated.current || target === 0n) {
      setShown(target);
      animated.current = true;
      return;
    }
    animated.current = true;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown((target * BigInt(Math.round(eased * 10_000))) / 10_000n);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return [copied, copy];
}

const ago = (ts?: number) => {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};

export function IconCopy({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}
export function IconExt({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7 9" />
    </svg>
  );
}

/** Mono address chip: click copies the full address; optional explorer link beside it. */
export function AddressChip({ label, address, link = true }: { label?: string; address?: string; link?: boolean }) {
  const [copied, copy] = useCopy();
  const ex = link ? explorerAddress(address) : undefined;
  if (!address) {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-ink-3">
        {label && <span className="text-ink-3">{label}</span>}
        <span>deploys with launch</span>
      </span>
    );
  }
  return (
    <span className="inline-flex h-7 items-center overflow-hidden rounded-md border border-line text-[12px]">
      {label && <span className="border-r border-line bg-surface-2 px-2 text-ink-3">{label}</span>}
      <button type="button" onClick={() => copy(address)} className="v2-num inline-flex h-full items-center gap-1.5 px-2 text-ink hover:bg-hover" title="Copy address">
        {copied ? <span className="text-lime">Copied</span> : short(address)}
        <span className="text-ink-3">
          <IconCopy />
        </span>
      </button>
      {ex && (
        <a href={ex} target="_blank" rel="noreferrer" className="inline-flex h-full items-center border-l border-line px-2 text-ink-3 hover:bg-hover hover:text-ink" title="Open on the explorer">
          <IconExt />
        </a>
      )}
    </span>
  );
}

const SNAPSHOT_COUNT = Object.keys(marketCapSnapshot.marketCaps).length;

/** Burned as a share of the fixed 1,000,000,000 supply, e.g. "0.05%", "0.0003%", "<0.0001%". */
function supplyShare(burned?: bigint): string {
  if (burned === undefined) return "";
  const share = Number((burned * 100_000_000n) / (BigInt(V2.launch.supply) * 10n ** 18n)) / 1_000_000; // percent, 6 dp
  if (share === 0) return burned > 0n ? "<0.000001%" : "0%";
  if (share >= 0.01) return `${share.toFixed(2)}%`;
  if (share >= 0.0001) return `${share.toFixed(4)}%`;
  return `${share.toFixed(6).replace(/0+$/, "")}%`;
}

/* ------------------------------------------------------------------ tape */

/** Infinite ticker tape: the degen-adjacent tickers first, then the registry by market cap. */
export function StockTape({ label }: { label?: string }) {
  const { dir, configured } = useDirectory();
  const { ranked, ready } = useRankedStocks(dir);
  const symbols = useMemo(() => {
    const live = ready && configured && ranked.length > 0 ? ranked.map((s) => s.symbol) : Object.keys(marketCapSnapshot.marketCaps).slice(0, 40);
    const pinned: string[] = V2.degenAdjacent.filter((s) => live.includes(s) || !(ready && configured));
    return [...pinned, ...live.filter((s) => !pinned.includes(s))].slice(0, 48);
  }, [ranked, ready, configured]);
  const row = (key: string) => (
    <div key={key} className="flex shrink-0 items-center" aria-hidden={key === "b"}>
      {symbols.map((sym) => (
        <Link key={sym} href="/app/create" className="flex items-center gap-2 px-5 py-2.5 text-[13px] text-ink-2 transition-colors hover:text-ink">
          <StockAvatar symbol={sym} size={22} />
          <span className="v2-num font-semibold text-ink">{sym}</span>
          <span className="hidden text-ink-3 sm:inline">{tickerName(sym)}</span>
        </Link>
      ))}
    </div>
  );
  return (
    <div className="relative border-y border-line bg-surface-0">
      {label && (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center bg-surface-0 pr-4 pl-6 text-[12px] font-semibold tracking-[0.08em] text-ink uppercase">
          {label}
          <span className="ml-3 h-4 w-px bg-line-strong" />
        </div>
      )}
      <div className="v2-tape-wrap v2-tape-mask overflow-hidden" style={{ ["--v2-tape-s" as string]: `${Math.max(40, symbols.length * 2.4)}s` }}>
        <div className="v2-tape">
          {row("a")}
          {row("b")}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ live numbers */

export function Figure({ label, value, note, big = false, tone = "ink" }: { label: ReactNode; value: ReactNode; note?: ReactNode; big?: boolean; tone?: "ink" | "lime" | "good" }) {
  const color = tone === "lime" ? "text-lime" : tone === "good" ? "text-good" : "text-ink";
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={`v2-num mt-1 truncate font-semibold ${big ? "text-[34px] leading-none md:text-[40px]" : "text-[22px] leading-tight"} ${color}`}>{value}</div>
      {note && <div className="mt-1.5 text-[12px] text-ink-3">{note}</div>}
    </div>
  );
}

/** Every number the page shows, from the contracts. */
export function useMachine() {
  const { dir, vaults, configured } = useDirectory();
  const { infos, byKind } = useVaults(vaults);
  const { stocks } = useStocks(dir?.registry);
  const fr = useFeeReceiver(dir);
  const token = useDcaToken(dir);
  const notional = infos.reduce((a, v) => a + (v.totalNotionalUsdg ?? 0n), 0n);
  const idle = infos.reduce((a, v) => a + (v.totalUsdgIdle ?? 0n), 0n);
  const epochs = infos.reduce((a, v) => a + (v.epochsCompleted ?? 0n), 0n);
  const ready = configured && infos.length > 0;
  const burned = fr.live ? fr.totalBurned : undefined;
  const queued = fr.live ? (fr.reserveUsdg ?? 0n) + ((fr.pendingUsdg ?? 0n) * BigInt(fr.buybackBps)) / 10_000n : undefined;
  const hasBurned = !!burned && burned > 0n;
  const liveStrip = hasBurned && notional >= V2.liveStripMinNotional;
  return { dir, ready, configured, infos, byKind, notional, idle, epochs, stocks: stocks.length, fr, token, burned, queued, hasBurned, liveStrip };
}

/** "$DCA burned · 12,345" with a live dot; the designed pre-burn state before the first distribution. */
export function MiniCounter() {
  const m = useMachine();
  return (
    <span className="inline-flex items-center gap-2 text-[13.5px] text-ink-2">
      <i className={`h-1.5 w-1.5 rounded-full ${m.fr.live ? "bg-lime v2-live" : "bg-surface-4"}`} />
      $DCA burned ·{" "}
      {m.hasBurned ? <b className="v2-num font-semibold text-ink">{fmtUnits(m.burned, 18, 0)}</b> : <span className="text-ink-3">first burn lands at the first distribution</span>}
    </span>
  );
}

/** "Watch the burn ↗": the FeeReceiver's explorer page, rendered only when both the explorer and the receiver are known. */
export function WatchBurnLink({ className = "" }: { className?: string }) {
  const m = useMachine();
  const href = m.fr.live ? explorerAddress(m.fr.address) : undefined;
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      Watch the burn ↗
    </a>
  );
}

/** Nav / CTA contract chip: the $DCA address once deployed, the Pons link before that, plain text before either. */
export function CaChip() {
  const { dir } = useDirectory();
  const dca = dir && !isZero(dir.dca) ? dir.dca : undefined;
  if (dca) return <AddressChip label="$DCA" address={dca} />;
  if (V2.ponsUrl)
    return (
      <a href={V2.ponsUrl} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[12px] text-ink-2 hover:border-ink hover:text-ink">
        Launching on Pons <IconExt />
      </a>
    );
  return <span className="inline-flex h-7 items-center rounded-md border border-line px-2 text-[12px] text-ink-3">CA at launch</span>;
}

/* ------------------------------------------------------------------ hero card */

export function FeeReceiverCard() {
  const m = useMachine();
  const burned = useCountUp(m.burned);
  const node = "rounded-lg border px-3 py-2.5";
  return (
    <div className="panel relative overflow-hidden bg-surface-0 shadow-[0_24px_80px_-24px_rgba(204,255,0,0.28)]">
      <div className="v2-glow pointer-events-none absolute inset-0" />
      <div className="relative">
        <div className="flex h-10 items-center gap-2 border-b border-line px-4 text-[12px]">
          <i className={`h-2 w-2 rounded-full ${m.fr.live ? "bg-lime v2-live" : "bg-surface-4"}`} />
          <span className="font-semibold text-ink">FeeReceiver</span>
          <span className="text-ink-3">·</span>
          <span className="text-ink-3">{m.fr.live ? "live" : "deploys with launch"}</span>
          <span className="ml-auto chip">Robinhood Chain</span>
        </div>

        {/* the pipe */}
        <div className="grid grid-cols-1 items-stretch gap-2 px-4 pt-4 sm:grid-cols-[1fr_16px_1fr_16px_1fr] sm:gap-0">
          <div className={`${node} border-line bg-surface-2`}>
            <div className="text-[11px] font-semibold tracking-[0.06em] text-ink uppercase">Plans buy stock</div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-3">one pooled swap per stock · every epoch</div>
          </div>
          <div className="hidden items-center sm:flex">
            <span className="v2-flow w-full" />
          </div>
          <div className={`${node} border-line bg-surface-2`}>
            <div className="text-[11px] font-semibold tracking-[0.06em] text-ink uppercase">Fee → FeeReceiver</div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-3">70% treasury · 30% reserve · no withdraw function</div>
          </div>
          <div className="hidden items-center sm:flex">
            <span className="v2-flow w-full" />
          </div>
          <div className={`${node} border-lime bg-lime/10`}>
            <div className="text-[11px] font-semibold tracking-[0.06em] text-lime uppercase">Swapped &amp; burned</div>
            <div className="mt-0.5 text-[11px] leading-snug text-ink-3">same transaction · totalBurned()</div>
          </div>
        </div>

        {/* the figure */}
        <div className="px-4 pt-5 pb-4">
          {m.hasBurned ? (
            <>
              <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-3">$DCA burned, all time</div>
              <div className="v2-num mt-2 text-[44px] leading-none font-semibold text-ink md:text-[54px]">{burned === undefined ? "0" : fmtUnits(burned, 18, 0)}</div>
              <div className="mt-2.5 text-[12.5px] text-ink-3">{supplyShare(m.burned)} of 1,000,000,000 · gone for good</div>
              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-3 text-[13px]">
                <span className="text-ink-2">Queued for the next burn</span>
                <span className="v2-num font-semibold text-ink">{m.queued === undefined ? "" : fmtUsd(m.queued)} USDG</span>
              </div>
            </>
          ) : (
            <>
              <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-3">Next pooled buy · daily vault · 00:00 UTC</div>
              <div className="v2-num mt-2 text-[44px] leading-none font-semibold text-ink md:text-[54px]">
                {m.ready ? <NextBuy kind="daily" /> : <span className="text-ink-3">at launch</span>}
              </div>
              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-3 text-[13px]">
                <span className="text-ink-2">$DCA burned, all time</span>
                <span className="text-right">
                  <span className="v2-num font-semibold text-ink">0</span>
                  <span className="ml-2 text-[12px] text-ink-3">first burn lands at the first distribution</span>
                </span>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-3 text-[13px]">
                <span className="text-ink-2">Curve on Pons</span>
                {V2.ponsUrl ? (
                  <a href={V2.ponsUrl} target="_blank" rel="noreferrer" className="v2-num font-semibold text-lime hover:underline">
                    graduates at {V2.launch.graduationEth} ETH · track on Pons ↗
                  </a>
                ) : (
                  <span className="v2-num font-semibold text-ink">graduates at {V2.launch.graduationEth} ETH · LP locked</span>
                )}
              </div>
            </>
          )}
        </div>

        {/* countdown row */}
        <div className="grid grid-cols-3 divide-x divide-line border-t border-line text-[12px]">
          {(["daily", "weekly", "monthly"] as const).map((k) => (
            <div key={k} className="px-4 py-2.5">
              <div className="text-ink-3">{VAULT_META[k].label}</div>
              <div className="v2-num mt-0.5 text-[13px] font-semibold text-ink">{m.ready ? <NextBuy kind={k} /> : "at launch"}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface-0 px-4 py-2.5 text-[11px] text-ink-3">
          <span>Every number above is a contract read on Robinhood Chain.</span>
          <span className="ml-auto">
            <AddressChip label="FeeReceiver" address={m.fr.address} />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ constants strip */

export function ConstantsStrip() {
  const m = useMachine();
  const fr = m.fr;
  const stocks = m.stocks > 0 ? String(m.stocks) : String(SNAPSHOT_COUNT);
  const tiles: [string, string, string][] = m.liveStrip
    ? [
        [fmtUnitsCompact(m.burned, 18), "$DCA burned", `${supplyShare(m.burned)} of supply · totalBurned()`],
        [fmtUsdCompact(m.queued), "USDG queued for the next burn", "reserve + 30% of pending"],
        [fmtUsdCompact(m.notional), "stock bought by plans", "Σ totalNotionalUsdg"],
        [m.epochs.toString(), "buys executed", "Σ epochsCompleted"],
        [fmtUsdCompact(m.idle), "capital waiting to buy", "Σ totalUsdgIdle"],
        [stocks, "Stock Tokens listed", "StockRegistry, live"],
      ]
    : [
        [`${fr.buybackBps / 100}%`, "of every fee, swapped into $DCA and burned", "BUYBACK_BPS = 3_000"],
        [pct(V2.maxFeeBps), "max fee, in bytecode", "MAX_FEE_BPS = 90"],
        ["1B", "$DCA supply, fixed, no mint", "1,000,000,000 · Pons"],
        ["0", "proxies or upgrade paths", "contracts/src"],
        ["4", "rhythms: hourly, daily, weekly, monthly", "PlanVault"],
        [stocks, "Stock Tokens listed", m.stocks > 0 ? "StockRegistry, live" : "CoinGecko snapshot"],
      ];
  return (
    <div className="grid grid-cols-2 divide-line overflow-hidden rounded-xl border border-line bg-surface-2 sm:grid-cols-3 md:grid-cols-6 md:divide-x">
      {tiles.map(([v, k, src]) => (
        <div key={k} className="border-b border-line px-4 py-4 md:border-b-0">
          <div className="v2-num truncate text-[28px] leading-none font-semibold text-ink md:text-[32px]">{v}</div>
          <div className="mt-2 text-[12px] leading-snug text-ink-2">{k}</div>
          <div className="v2-num mt-1.5 truncate text-[10.5px] text-ink-3">{src}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ burn section */

export function TraceABuy() {
  const { byKind } = useMachine();
  const [amount, setAmount] = useState("1000");
  const [kind, setKind] = useState<ProductionVaultKind>("weekly");
  const fr = useFeeReceiver(useDirectory().dir);
  const feeBps = byKind[kind]?.fees?.purchaseFeeBps ?? VAULT_META[kind].defaultFeeBps;
  const amt = Math.max(0, Number(amount.replace(/[^0-9.]/g, "")) || 0);
  const fee = (amt * feeBps) / 10_000;
  const tre = (fee * fr.treasuryBps) / 10_000;
  const res = (fee * fr.buybackBps) / 10_000;
  const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const line = "grid grid-cols-[1fr_auto] items-baseline gap-3 border-b border-line px-4 py-3 text-[13px] last:border-b-0";
  return (
    <div className="panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-0 px-4 py-2.5 text-[12px]">
        <span className="font-semibold text-ink">Trace a buy</span>
        <span className="text-ink-3">·</span>
        <label className="flex items-center gap-1 text-ink-3">
          $
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label="Buy amount in USD"
            className="v2-num h-7 w-24 rounded-md border border-line-strong bg-surface-3 px-2 text-[13px] text-ink outline-none focus:border-ink"
          />
        </label>
        <span className="ml-auto flex overflow-hidden rounded-md border border-line">
          {(["daily", "weekly", "monthly"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`h-7 px-2.5 text-[12px] ${k === kind ? "bg-surface-4 text-ink" : "text-ink-3 hover:text-ink"}`}>
              {VAULT_META[k].label}
            </button>
          ))}
        </span>
      </div>
      <div className={line}>
        <span className="text-ink-2">
          Buy <b className="v2-num font-semibold text-ink">{usd(amt)}</b> of NVDA · {VAULT_META[kind].label.toLowerCase()} · fee {pct(feeBps)}
        </span>
        <span className="v2-num font-semibold text-ink">{usd(fee)}</span>
      </div>
      <div className={line}>
        <span className="text-ink-2">
          FeeReceiver ← fee <span className="text-ink-3">· no withdraw function</span>
        </span>
        <span className="v2-num font-semibold text-ink">{usd(fee)}</span>
      </div>
      <div className={line}>
        <span className="text-ink-2">
          {fr.treasuryBps / 100}% → treasury <span className="text-ink-3">· runs the protocol</span>
        </span>
        <span className="v2-num font-semibold text-ink">{usd(tre)}</span>
      </div>
      <div className={`${line} bg-lime/5`}>
        <span className="text-ink">
          {fr.buybackBps / 100}% → burn reserve <span className="text-ink-3">· swapped into $DCA and burned, same tx</span>
        </span>
        <span className="v2-num font-semibold text-lime">{usd(res)}</span>
      </div>
      <div className="border-t border-line bg-surface-0 px-4 py-2 text-[11px] text-ink-3">Arithmetic on the constants, not a forecast. Change the amount.</div>
    </div>
  );
}

export function LatestBurns() {
  const m = useMachine();
  const logs = useBurnLogs(m.fr.live ? m.fr.address : undefined);
  const rows = logs.data ?? [];
  const last = rows[0];
  return (
    <div className="panel">
      <div className="flex items-center gap-2 border-b border-line bg-surface-0 px-4 py-2.5 text-[12px]">
        <span className="font-semibold text-ink">Latest burns</span>
        <span className="ml-auto inline-flex h-[22px] items-center gap-1.5 rounded-sm border border-lime/40 bg-lime/10 px-2 text-[11px] font-medium text-lime uppercase tracking-[0.06em]">
          <i className={`h-1.5 w-1.5 rounded-full ${last ? "bg-lime v2-live" : "bg-surface-4"}`} />
          {last ? `last burn · ${ago(last.timestamp)}` : "no burn yet"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13.5px] text-ink-3">Ledger fills at the first distribution.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Tx</th>
                <th className="text-right">In</th>
                <th className="text-right">$DCA burned</th>
                <th className="text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tx = explorerTx(r.txHash);
                const usdgIn = m.dir && r.tokenIn.toLowerCase() === m.dir.usdg.toLowerCase();
                return (
                  <tr key={r.txHash + r.dcaOut.toString()}>
                    <td className="v2-num">
                      {tx ? (
                        <a href={tx} target="_blank" rel="noreferrer" className="text-lime hover:underline">
                          {short(r.txHash)} ↗
                        </a>
                      ) : (
                        short(r.txHash)
                      )}
                    </td>
                    <td className="v2-num text-right">{usdgIn ? `${fmtUsd(r.amountIn)} USDG` : `${fmtUnits(r.amountIn, 18, 4)} ${m.dir && r.tokenIn.toLowerCase() === m.dir.weth.toLowerCase() ? "WETH" : "tokens"}`}</td>
                    <td className="v2-num text-right text-ink">{fmtUnits(r.dcaOut, 18, 0)}</td>
                    <td className="v2-num text-right text-ink-3">{ago(r.timestamp)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** FeeReceiver · burn address · $DCA · the four vaults. */
export function AddressRow({ compact = false }: { compact?: boolean }) {
  const m = useMachine();
  const d = m.dir;
  const items: [string, string | undefined][] = compact
    ? [
        ["$DCA", d && !isZero(d.dca) ? d.dca : undefined],
        ["FeeReceiver", m.fr.address],
        ["Hourly", d?.hourly],
        ["Daily", d?.daily],
        ["Weekly", d?.weekly],
        ["Monthly", d?.monthly],
      ]
    : [
        ["FeeReceiver", m.fr.address],
        ["Burn address", DEAD],
        ["$DCA", d && !isZero(d.dca) ? d.dca : undefined],
      ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([k, a]) => (
        <AddressChip key={k} label={k} address={a} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ protocol */

export function Threshold({ perk = "autoDistribute", compact = true }: { perk?: "autoDistribute" | "feeHalve"; compact?: boolean }) {
  const t = usePerkThresholds();
  return <>{compact ? fmtUnitsCompact(t[perk], 18) : fmtUnits(t[perk], 18, 0)}</>;
}

/** The threshold as a share of the fixed supply ("0.01%"). */
export function ThresholdShare() {
  const t = usePerkThresholds();
  const share = Number((t.feeHalve * 1_000_000n) / (BigInt(V2.launch.supply) * 10n ** 18n)) / 10_000;
  return <>{share.toFixed(share < 0.01 ? 3 : 2)}%</>;
}

export function BoostApy() {
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);
  const { apyOf } = useBoostApys(infos);
  const withBoost = infos.find(boostAvailable);
  const apy = apyOf(withBoost?.boostStrategy);
  return <>{apy === undefined ? "live at launch" : fmtPct(apy)}</>;
}

export function NextBuy({ kind }: { kind: ProductionVaultKind }) {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  return <Countdown target={byKind[kind]?.nextEpochStart} className="text-ink" />;
}

export function PlanSummaryLine() {
  const m = useMachine();
  const fee = m.byKind.weekly?.fees?.purchaseFeeBps ?? VAULT_META.weekly.defaultFeeBps;
  return (
    <div className="v2-num flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface-0 px-4 py-3 text-[13px] text-ink-2">
      <span className="text-ink">$25 of NVDA</span>
      <span className="text-ink-3">·</span>
      <span>every Monday 00:00 UTC</span>
      <span className="text-ink-3">·</span>
      <span>{pct(fee)} per buy</span>
      <span className="text-ink-3">·</span>
      <span>
        next buy in {m.ready ? <NextBuy kind="weekly" /> : <span className="text-ink-3">at launch</span>}
      </span>
    </div>
  );
}

export function VaultTable() {
  const m = useMachine();
  const t = usePerkThresholds();
  const when = { hourly: "every hour, on the hour", daily: "00:00 UTC, every day", weekly: "Monday 00:00 UTC", monthly: "every 30 days" } as const;
  const any = m.byKind.weekly ?? m.byKind.daily;
  const withdraw = any?.fees?.withdrawFeeBps ?? 25;
  const claim = any?.fees?.claimFeeBps ?? 25;
  const min = any?.minAmountPerEpoch;
  return (
    <div className="panel">
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Vault</th>
              <th>Epoch</th>
              <th className="text-right">Fee per buy</th>
              <th className="text-right">Holding {fmtUnitsCompact(t.feeHalve, 18)} $DCA</th>
              <th className="text-right">Next buy</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(["hourly", "daily", "weekly", "monthly"] as const).map((k) => {
              const bps = m.byKind[k]?.fees?.purchaseFeeBps ?? VAULT_META[k].defaultFeeBps;
              return (
                <tr key={k}>
                  <td className="font-semibold text-ink">
                    {VAULT_META[k].label}
                    {k === "weekly" && <span className="chip ml-2 align-[2px]">popular</span>}
                  </td>
                  <td className="text-ink-2">{when[k]}</td>
                  <td className="v2-num text-right text-ink">{pct(bps)}</td>
                  <td className="v2-num text-right text-ink">{pct(halfBps(bps))}</td>
                  <td className="v2-num text-right">{m.ready ? <NextBuy kind={k} /> : <span className="text-ink-3">at launch</span>}</td>
                  <td className="text-right">
                    <Link href="/app/create" className="btn-secondary btn-xs">
                      Start
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line bg-surface-0 px-4 py-2.5 text-[11.5px] text-ink-3">
        <span>
          Hard cap {pct(V2.maxFeeBps)}: <span className="v2-num">MAX_FEE_BPS = 90</span> in FeeMath.sol. No key can set a fee past it.
        </span>
        <span>Deposit 0</span>
        <span>Withdraw idle {pct(withdraw)}</span>
        <span>Claim {pct(claim)} (0 with {fmtUnitsCompact(t.autoDistribute, 18)} $DCA)</span>
        <span>Min {min !== undefined ? fmtUsd(min) : "$10"} per buy and per deposit</span>
        <span>USDG or ETH</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ stocks */

export function StocksLive() {
  const m = useMachine();
  const count = m.stocks > 0 ? String(m.stocks) : String(SNAPSHOT_COUNT);
  const tiles: [string, string][] = [
    [count, m.stocks > 0 ? "Stock Tokens · registry, live" : "Stock Tokens · CoinGecko snapshot"],
    ["3", "rhythms"],
    ["1", "swap per epoch, for everyone"],
    ["0", "custody"],
  ];
  return (
    <>
      <div className="mt-8 grid grid-cols-2 divide-line overflow-hidden rounded-xl border border-line bg-surface-2 md:grid-cols-4 md:divide-x">
        {tiles.map(([v, k]) => (
          <div key={k} className="border-b border-line px-4 py-3.5 md:border-b-0">
            <div className="v2-num text-[26px] leading-none font-semibold text-ink">{v}</div>
            <div className="mt-1.5 text-[12px] text-ink-2">{k}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-3">Degen adjacent</span>
        {V2.degenAdjacent.map((s) => (
          <Link key={s} href="/app/create" className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-surface-3 px-2.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink">
            <StockAvatar symbol={s} size={18} />
            <span className="v2-num">{s}</span>
          </Link>
        ))}
      </div>
      <div className="mt-6 text-[11.5px] font-medium uppercase tracking-[0.08em] text-ink-3">By market cap</div>
      <div className="-mt-4">
        <StockGrid />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ manifesto copy */

/** Copies "<headline> — <fact> · $DCA on Robinhood Chain · <site> · CA <address>" for the KOL paste. */
export function CopyLine({ headline, fact }: { headline: string; fact: string }) {
  const { dir } = useDirectory();
  const [copied, copy] = useCopy();
  const dca = dir && !isZero(dir.dca) ? dir.dca : undefined;
  const text = [`${headline} — ${fact}`, "$DCA on Robinhood Chain", V2.siteUrl, dca ? `CA ${dca}` : undefined].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[11.5px] text-ink-3 transition-colors hover:border-ink hover:text-ink"
      title="Copy this line"
    >
      {copied ? <span className="text-lime">Copied</span> : <IconCopy />}
    </button>
  );
}
