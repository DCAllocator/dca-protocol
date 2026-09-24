"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatEther, formatUnits, parseEther, parseUnits, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useDirectory, useRankedStocks, useVaults, useUser, useQuote, useBoostApys, boostAvailable, TOP_STOCKS, type Stock } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import { PageHeader, Notice, Spinner, StockAvatar, Segmented, Countdown, Icon, HashLink } from "@/components/ui";
import { BoostCard } from "@/components/app/BoostCard";
import { ConnectButton } from "@/components/ConnectButton";
import { ChoiceAvatar, choiceLabel } from "@/components/app/create/fields";
import { useStockParam } from "@/components/app/create/useCreatePlan";
import { coverageCopy } from "@/lib/planFunds";
import { fmtUsd, fmtUnits, fmtBps, fmtPct, tsToShort, feeOf } from "@/lib/format";
import { VAULT_KINDS, VAULT_META, ZERO, DOCS_PATH, USDG_DECIMALS, BOOST, buysPerMonthOf, type VaultKind } from "@/lib/config";

type Pay = "USDG" | "ETH";

const PER_MIN_FALLBACK = 10n * 10n ** BigInt(USDG_DECIMALS); // vault default until the chain answers
/** Quick picks under the per-buy amount; those under the vault minimum are dropped. */
const PER_BUY_PRESETS = [25, 50, 100, 250, 500];
/** Quick picks under the funding amount, as a share of the wallet balance. */
const FUND_PRESETS = [25, 50, 100] as const;
const ETH_GAS_RESERVE = parseEther("0.01");
/** Slippage applied to the ETH → USDG conversion quote when starting a plan with ETH. */
const ZAP_SLIPPAGE_BPS = 50n;

/**
 * Legacy create layout: four numbered steps on the left (buy what, how often, how much, funded with what)
 * and a sticky summary with the checklist, the boost switch and the start button on the right. The swap
 * card at /app/create replaced it; kept for comparison and sends the same transaction.
 */
export default function CreatePlan() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const [kind, setKind] = useState<VaultKind>("weekly");
  // Only stocks this frequency's vault will actually buy (an active keeper job, and a price feed where required).
  const { stocks, ranked, top, dca, choices, preferred, ready: rankReady } = useRankedStocks(dir, vaults?.[kind]);
  const { infos, byKind, refetch: refetchVaults } = useVaults(vaults);

  const param = useStockParam(dir, kind, setKind);
  const { clear: clearParam } = param;
  const [stock, setPicked] = useState<string>("");
  /** The user's own pick (every picker calls this): it also drops a `?stock=` link. */
  const setStock = useCallback(
    (address: string) => {
      clearParam();
      setPicked(address);
    },
    [clearParam],
  );
  const [perBuy, setPerBuy] = useState("100");
  const [pay, setPay] = useState<Pay>("USDG");
  const [upfront, setUpfront] = useState("");
  // Boost is opt-in: idle USDG lent on Morpho Blue between buys. Off by default.
  const [boost, setBoost] = useState(false);

  const vault = vaults?.[kind];
  const info = byKind[kind];
  const canBoost = boostAvailable(info);
  const { apyOf } = useBoostApys(infos);
  const boostApy = apyOf(info?.boostStrategy);
  const user = useUser(dir, vault);
  // Until the user picks: the `?stock=` link's stock while it stands, else $DCA where this frequency buys it, else the most
  // popular stock (once the ranking is in). A pick (or link) the frequency does not buy reads "Pick a stock" rather than
  // silently becoming a different stock.
  const stockObj = stock
    ? stocks.find((s) => s.address === stock)
    : param.active
      ? stocks.find((s) => s.address === param.stock?.address)
      : preferred;
  const stockAddr = stockObj?.address;
  const picked = stockObj && choiceLabel(stockObj, dca?.address);

  const perBuyWei = safeParse(perBuy, USDG_DECIMALS);
  const upfrontWei = pay === "USDG" ? safeParse(upfront, USDG_DECIMALS) : safeParseEth(upfront);
  // On-chain minimums (10 USDG by default): per-buy amount, and the USDG a plan must be funded with to start.
  const minPerBuy = info?.minAmountPerEpoch ?? PER_MIN_FALLBACK;
  const minDeposit = info?.minDeposit ?? PER_MIN_FALLBACK;
  const perMinWhole = Number(formatUnits(minPerBuy, USDG_DECIMALS));

  // Balances → quick picks
  const usdgBal = user.usdg ?? 0n;
  const ethBal = user.eth ?? 0n;
  const ethMax = ethBal > ETH_GAS_RESERVE ? ethBal - ETH_GAS_RESERVE : 0n;
  const fundMax = pay === "USDG" ? usdgBal : ethMax;
  const fundShare = (pct: number) => {
    const wei = (fundMax * BigInt(pct)) / 100n;
    return pay === "USDG" ? formatUnits(wei, USDG_DECIMALS) : trimEth(formatEther(wei));
  };

  // ETH → USDG preview (also used for minOut). The vault converts the amount NET of any deposit fee, so quote that:
  // a minOut derived from the gross amount would revert whenever a deposit fee is switched on.
  const depositFeeBps = info?.fees?.depositFeeBps ?? 0;
  const ethNet = pay === "ETH" && upfrontWei ? upfrontWei - feeOf(upfrontWei, depositFeeBps) : undefined;
  const zapQuote = useQuote(dir?.router, dir?.weth, dir?.usdg, ethNet && ethNet > 0n ? ethNet : undefined);
  const upfrontUsdg = pay === "USDG" ? (upfrontWei !== undefined ? upfrontWei - feeOf(upfrontWei, depositFeeBps) : undefined) : zapQuote.data?.amountOut;
  const buysCovered = upfrontUsdg !== undefined && perBuyWei && perBuyWei > 0n ? Number(upfrontUsdg / perBuyWei) : undefined;

  const allowance = useReadContract({
    address: dir?.usdg,
    abi: ERC20Abi,
    functionName: "allowance",
    args: address && vault ? [address, vault] : undefined,
    query: { enabled: !!dir && !!address && !!vault && pay === "USDG" },
  });
  const needsApproval = pay === "USDG" && !!upfrontWei && upfrontWei > 0n && (allowance.data ?? 0n) < upfrontWei;

  const seq = useTxSequence(() => {
    refetchVaults();
    user.refetch();
    allowance.refetch();
  });
  // Any input change after a success starts a fresh order.
  useEffect(() => {
    if (seq.done || seq.error) seq.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock, kind, perBuy, pay, upfront, boost]);

  const walletBal = pay === "USDG" ? usdgBal : ethBal;
  const insufficient = upfrontWei !== undefined && upfrontWei > walletBal;
  const perBuyOk = !!perBuyWei && perBuyWei >= minPerBuy;
  const perBuyTooSmall = !!perBuyWei && perBuyWei > 0n && perBuyWei < minPerBuy;
  const quoteMissing = pay === "ETH" && !!upfrontWei && upfrontWei > 0n && zapQuote.data === undefined;
  // A plan must start with at least `minDeposit` USDG (after conversion for ETH): unfunded plans are rejected on chain.
  // For ETH, judge by the worst case the swap may deliver (quote minus the slippage tolerance), not the quote itself.
  const upfrontUsdgFloor =
    pay === "ETH" && upfrontUsdg !== undefined ? (upfrontUsdg * (10_000n - ZAP_SLIPPAGE_BPS)) / 10_000n : upfrontUsdg;
  const fundedEnough = upfrontUsdgFloor !== undefined && upfrontUsdgFloor >= minDeposit;
  const fundingTooSmall = !!upfrontWei && upfrontWei > 0n && upfrontUsdg !== undefined && !fundedEnough;
  const fundedOk = fundedEnough && !insufficient && !quoteMissing;
  const canSubmit = !!address && !!vault && !!stockAddr && perBuyOk && fundedOk && !seq.running;

  const submit = async () => {
    if (!vault || !stockAddr || !perBuyWei || !dir) return;
    const usdgAmount = pay === "USDG" ? (upfrontWei ?? 0n) : 0n;
    const value = pay === "ETH" ? (upfrontWei ?? 0n) : 0n;
    // ETH is converted to USDG inside createPlan; protect the conversion with the quoted amount minus 0.5%.
    const minOut = pay === "ETH" && zapQuote.data ? (zapQuote.data.amountOut * (10_000n - ZAP_SLIPPAGE_BPS)) / 10_000n : 0n;
    const steps: TxStep[] = [];
    if (needsApproval) steps.push({ label: "Approve USDG", params: { address: dir.usdg, abi: ERC20Abi, functionName: "approve", args: [vault, usdgAmount] } });
    steps.push({
      label: "Start plan",
      params: {
        address: vault,
        abi: PlanVaultAbi,
        functionName: "createPlan",
        args: [stockAddr, perBuyWei, ZERO, usdgAmount, 0n, minOut, boost && canBoost],
        value,
      },
    });
    await seq.run(steps);
  };

  if (!configured) return <Notice kind="warn">App is not configured: set NEXT_PUBLIC_DIRECTORY.</Notice>;

  const monthly = perBuyWei ? (perBuyWei * BigInt(Math.round(buysPerMonthOf(kind, info?.epochLength) * 100))) / 100n : 0n;
  const feeBps = user.effectiveFeeBps ?? info?.fees?.purchaseFeeBps;
  const presets = PER_BUY_PRESETS.filter((p) => p >= perMinWhole);
  const per = VAULT_META[kind].per;

  return (
    <>
      <PageHeader className="mb-5" title="Create a plan" description="Pick a stock, choose how often to buy, and fund it. The rest runs itself." />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 gap-3.5">
          {/* 1 · Stock */}
          <Step n={1} title="Buy" done={!!stockObj} hint={ranked.length > 0 ? `${ranked.length} stocks listed` : undefined}>
            {stocks.length === 0 ? (
              <p className="text-[13px] text-ink-3">No stocks are listed yet.</p>
            ) : (
              <>
                <StockSelect stocks={choices} value={stockAddr ?? ""} onSelect={setStock} dca={dca?.address} />
                {(!rankReady || top.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[12.5px] text-ink-3">Popular</span>
                    {rankReady
                      ? top.map((s) => {
                          const active = stockAddr === s.address;
                          return (
                            <button
                              key={s.address}
                              type="button"
                              onClick={() => setStock(s.address)}
                              className={`inline-flex h-7 items-center gap-1.5 rounded-md border pr-2.5 pl-1 text-[12.5px] font-medium transition-colors ${
                                active ? "border-lime bg-lime/10 text-ink" : "border-line-strong bg-surface-3 text-ink-2 hover:border-ink hover:text-ink"
                              }`}
                            >
                              <StockAvatar symbol={s.symbol} size={20} />
                              {s.symbol}
                            </button>
                          );
                        })
                      : Array.from({ length: TOP_STOCKS }, (_, i) => <span key={i} className="h-7 w-[72px] animate-pulse rounded-md bg-surface-3" aria-hidden />)}
                  </div>
                )}
              </>
            )}
            {param.unavailable && <Notice>{param.unavailable} isn&apos;t available for plans yet.</Notice>}
          </Step>

          {/* 2 · Frequency */}
          <Step n={2} title="Every" done hint="when the plan buys">
            <div className={`grid gap-2 ${VAULT_KINDS.length > 3 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}>
              {VAULT_KINDS.map((k) => {
                const active = kind === k;
                return (
                  <button key={k} type="button" onClick={() => setKind(k)} className={`tile px-3.5 py-3 ${active ? "tile-active" : ""}`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
                        {VAULT_META[k].label}
                        {k === "test" && <span className="chip-dev">dev</span>}
                      </span>
                      {active && <Icon name="check" size={14} className="text-lime" />}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-normal text-ink-3">{VAULT_META[k].blurb}</span>
                  </button>
                );
              })}
            </div>
          </Step>

          {/* 3 · Amount per buy */}
          <Step n={3} title={`Amount per ${per}`} done={perBuyOk} hint={`min ${fmtUsd(minPerBuy)} · change any time`}>
            <div className="amount-box">
              <div className="flex items-center gap-3">
                <input className="amount-input" inputMode="decimal" value={perBuy} onChange={(e) => setPerBuy(clean(e.target.value))} placeholder="100" aria-label={`Amount per ${per}`} />
                <span className="shrink-0 text-[14px] font-medium text-ink-2">USDG</span>
              </div>
              <div className="amount-meta">
                <div className="flex flex-wrap gap-1">
                  {presets.map((p) => (
                    <button key={p} type="button" onClick={() => setPerBuy(String(p))} className={`quick ${Number(perBuy) === p ? "quick-on" : ""}`}>
                      ${p}
                    </button>
                  ))}
                </div>
                {perBuyTooSmall ? (
                  <span className="text-bad">The smallest buy is {fmtUsd(minPerBuy)}.</span>
                ) : perBuyOk ? (
                  <span>
                    ≈ <span className="num text-ink-2">{fmtUsd(monthly)}</span> a month
                  </span>
                ) : (
                  <span>Spent on every buy</span>
                )}
              </div>
            </div>
          </Step>

          {/* 4 · Fund upfront */}
          <Step
            n={4}
            title="Fund the plan"
            done={fundedOk}
            hint={
              <Segmented<Pay>
                value={pay}
                onChange={(p) => {
                  setPay(p);
                  setUpfront("");
                }}
                options={[
                  { value: "USDG", label: "USDG" },
                  { value: "ETH", label: "ETH" },
                ]}
              />
            }
          >
            <div className="amount-box">
              <div className="flex items-center gap-3">
                <input className="amount-input" inputMode="decimal" value={upfront} onChange={(e) => setUpfront(clean(e.target.value))} placeholder="0" aria-label="Upfront amount" />
                <span className="shrink-0 text-[14px] font-medium text-ink-2">{pay}</span>
              </div>
              <div className="amount-meta">
                <div className="flex flex-wrap gap-1">
                  {FUND_PRESETS.map((pct) => (
                    <button key={pct} type="button" disabled={!address || fundMax === 0n} onClick={() => setUpfront(fundShare(pct))} className={`quick ${address && upfront !== "" && upfront === fundShare(pct) ? "quick-on" : ""}`}>
                      {pct === 100 ? "MAX" : `${pct}%`}
                    </button>
                  ))}
                </div>
                <span>
                  Balance <span className="num text-ink-2">{address ? (pay === "USDG" ? fmtUsd(usdgBal) : `${fmtUnits(ethBal, 18)} ETH`) : "—"}</span>
                </span>
              </div>
            </div>
            <p className="note">
              <Icon name="info" size={14} className="mt-[2px] shrink-0" />
              <span>
                {pay === "ETH" && upfrontWei && upfrontWei > 0n ? (
                  <>
                    Converted to <span className="num text-ink-2">{zapQuote.data ? `≈ ${fmtUsd(zapQuote.data.amountOut)}` : "…"}</span> USDG the moment you start the plan
                    (the plan holds USDG, never ETH).{" "}
                  </>
                ) : null}
                {insufficient ? (
                  <span className="text-bad">Not enough {pay} in your wallet.</span>
                ) : fundingTooSmall ? (
                  <span className="text-bad">
                    A plan needs at least {fmtUsd(minDeposit)}
                    {pay === "ETH" ? " worth of ETH" : ""} to start.
                  </span>
                ) : buysCovered !== undefined && buysCovered > 0 && upfrontUsdg !== undefined && perBuyWei ? (
                  <>
                    {/* Worded as on My plans: "3 buys", or "3 buys + a $50.00 final buy" when a remainder makes one smaller last buy. */}
                    Covers <span className="text-ink-2">{coverageCopy(upfrontUsdg, perBuyWei)}</span>. Top up any time from My plans.
                  </>
                ) : fundedEnough && upfrontUsdg !== undefined ? (
                  <>
                    Less than one full buy: the first buy spends what is there (≈ <span className="num text-ink-2">{fmtUsd(upfrontUsdg)}</span>). Top up any time from My
                    plans.
                  </>
                ) : (
                  `At least ${fmtUsd(minDeposit)} to start. You can top up later from My plans.`
                )}
              </span>
            </p>
          </Step>
        </div>

        {/* Summary */}
        <aside className="card xl:sticky xl:top-4">
          <div className="panel-head">
            <span>Your plan</span>
            <span className="normal-case tracking-normal text-ink-3">{VAULT_META[kind].label}</span>
          </div>
          {seq.done ? (
            <div className="step-body">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lime text-lime-ink">
                  <Icon name="check" size={16} />
                </span>
                <div>
                  <div className="text-[14px] font-medium text-ink">Plan started</div>
                  <div className="text-[12.5px] text-ink-3">First buy at the next {kind === "test" ? "epoch" : VAULT_META[kind].label.toLowerCase()} boundary.</div>
                </div>
              </div>
              <Link href="/app/plans" className="btn-primary h-10 w-full">
                View my plans
              </Link>
              <button type="button" className="btn-ghost w-full" onClick={() => seq.reset()}>
                Create another
              </button>
            </div>
          ) : (
            <div className="step-body">
              <div className="flex items-center gap-3">
                <ChoiceAvatar symbol={stockObj?.symbol ?? "?"} dca={picked?.dca} size={32} />
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-medium text-ink">
                    {picked?.symbol ?? "—"}
                    {picked && picked.name !== picked.symbol && <span className="ml-1.5 font-normal text-ink-3">{picked.name}</span>}
                  </div>
                  <div className="text-[12.5px] text-ink-3">
                    {fmtUsd(perBuyWei ?? 0n)} every {per}
                  </div>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Row k="Frequency" v={VAULT_META[kind].label} />
                <Row k="Per buy" v={fmtUsd(perBuyWei ?? 0n)} num />
                <Row k="Upfront" v={upfrontWei && upfrontWei > 0n ? (pay === "USDG" ? fmtUsd(upfrontWei) : `${fmtUnits(upfrontWei, 18)} ETH`) : "—"} num />
                {pay === "ETH" && upfrontWei && upfrontWei > 0n && <Row k="As USDG" v={zapQuote.data ? `≈ ${fmtUsd(zapQuote.data.amountOut)}` : "…"} num />}
                <Row
                  k="First buy"
                  v={
                    <span className="block text-right">
                      <Countdown target={info?.nextEpochStart} />
                      {info?.nextEpochStart && <span className="block text-[11.5px] text-ink-3">{tsToShort(info.nextEpochStart)}</span>}
                    </span>
                  }
                />
                <Row k={BOOST.name} v={boost && canBoost ? <span className="text-good">On · {fmtPct(boostApy, true)} APY</span> : "Off"} />
              </div>

              <hr className="border-line" />

              <div className="grid gap-1">
                <Check done={!!stockObj}>Stock picked</Check>
                <Check done={perBuyOk}>At least {fmtUsd(minPerBuy)} per buy</Check>
                <Check done={fundedOk}>Funded with at least {fmtUsd(minDeposit)}</Check>
                <Check done={!!address}>Wallet connected</Check>
              </div>

              <BoostCard checked={boost} onChange={setBoost} apy={boostApy} available={canBoost} disabled={seq.running} />

              <div className="grid gap-2">
                {!address ? (
                  <ConnectButton className="h-10 w-full" />
                ) : (
                  <button type="button" className="btn-primary h-10 w-full" disabled={!canSubmit} onClick={submit}>
                    {seq.running ? (
                      <>
                        <Spinner /> {seq.label}
                        {seq.total > 1 ? ` (${seq.step + 1}/${seq.total})` : ""}
                      </>
                    ) : needsApproval ? (
                      "Approve & start plan"
                    ) : (
                      "Start plan"
                    )}
                  </button>
                )}
                {seq.error && <Notice kind="error">{seq.error}</Notice>}
                {seq.waiting && (
                  <Notice kind="warn">
                    <span className="flex items-center justify-between gap-3">
                      <span>
                        Still waiting for the network — the transaction is sent and may still land. Nothing else will be sent.
                        {seq.steps[seq.step]?.hash && (
                          <>
                            {" "}
                            <HashLink hash={seq.steps[seq.step].hash!} />
                          </>
                        )}
                      </span>
                      <button type="button" className="btn-secondary btn-xs shrink-0" onClick={() => void seq.keepWaiting()}>
                        Keep waiting
                      </button>
                    </span>
                  </Notice>
                )}
              </div>

              <p className="text-[12px] leading-normal text-ink-3">
                A {fmtBps(feeBps)} fee is taken on each buy before the swap
                {info?.fees ? `; claiming ${picked?.dca ? "$DCA" : "stock"} costs ${fmtBps(info.fees.claimFeeBps)} (free for $DCA holders)` : ""}. Buys route through on-chain liquidity with a{" "}
                {fmtBps(info?.fees?.swapSlippageBps)} slippage tolerance.
                {pay === "ETH" && upfrontWei && upfrontWei > 0n
                  ? ` Your ETH is swapped to USDG on chain with a ${fmtBps(Number(ZAP_SLIPPAGE_BPS))} tolerance; if the price moves more than that the transaction fails and nothing is taken.`
                  : ""}
                {boost && canBoost ? " Boosted funds are lent on Morpho Blue between buys; the rate is variable and lending carries liquidity and bad-debt risk. No extra fee." : ""}{" "}
                {picked?.dca
                  ? "$DCA is a protocol utility token, not equity or a promise of returns. The $DCA a plan buys counts toward holder perks once it is in your wallet."
                  : "Stock Tokens are economic exposure, not shareholder rights."}{" "}
                <span className="text-ink-2">Hold $DCA</span> for stock sent straight to your wallet and lower fees —{" "}
                <Link href={`${DOCS_PATH}#dca`} className="text-lime hover:underline">
                  find out more →
                </Link>
              </p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** Token-selector style stock picker: the current pick on a tile, a searchable list ($DCA, then ranked, popular first) beneath. */
function StockSelect({ stocks, value, onSelect, dca }: { stocks: Stock[]; value: string; onSelect: (address: string) => void; dca?: Address }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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

  const q = query.trim().toLowerCase();
  const filtered = q
    ? stocks.filter((s) => {
        const l = choiceLabel(s, dca);
        return l.symbol.toLowerCase().includes(q) || l.name.toLowerCase().includes(q);
      })
    : stocks;
  const selected = stocks.find((s) => s.address === value);
  const sel = selected && choiceLabel(selected, dca);

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} className="tile flex h-12 w-full items-center gap-3 px-3">
        {selected && sel ? (
          <>
            <ChoiceAvatar symbol={selected.symbol} dca={sel.dca} size={26} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
              {sel.symbol}
              {sel.name !== sel.symbol && <span className="ml-1.5 font-normal text-ink-3">{sel.name}</span>}
            </span>
          </>
        ) : (
          <span className="flex-1 text-[14px] text-ink-3">Choose a stock</span>
        )}
        <Icon name="chevron" size={14} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="menu absolute inset-x-0 top-[calc(100%+4px)] z-10 max-h-80 overflow-y-auto" role="listbox">
          <div className="sticky top-0 border-b border-line bg-surface-3 p-1.5">
            <input autoFocus className="input h-9" placeholder="Search a stock (e.g. NVDA, Apple)" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">No stocks match &ldquo;{query}&rdquo;.</div>
          ) : (
            filtered.map((s) => {
              const l = choiceLabel(s, dca);
              return (
                <button
                  key={s.address}
                  type="button"
                  role="option"
                  aria-selected={s.address === value}
                  onClick={() => {
                    onSelect(s.address);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`menu-item gap-2.5 ${s.address === value ? "bg-surface-4 text-ink" : ""}`}
                >
                  <ChoiceAvatar symbol={s.symbol} dca={l.dca} size={22} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    <span className="text-[13px] font-medium text-ink">{l.symbol}</span>
                    {l.name !== l.symbol && <span className="ml-1.5 text-[12px] text-ink-3">{l.name}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Numbered step on a card: the badge turns lime once the step is satisfied. */
function Step({ n, title, hint, done = false, children }: { n: number; title: string; hint?: ReactNode; done?: boolean; children: ReactNode }) {
  return (
    <section className="card min-w-0">
      <div className="step-head">
        <span className={`step-n ${done ? "step-n-done" : ""}`}>{n}</span>
        <h2 className="step-title">{title}</h2>
        {hint && <div className="step-hint">{hint}</div>}
      </div>
      <div className="step-body">{children}</div>
    </section>
  );
}

function Row({ k, v, num = false }: { k: ReactNode; v: ReactNode; num?: boolean }) {
  return (
    <div className="summary-row">
      <span className="text-ink-3">{k}</span>
      <span className={`text-right text-ink ${num ? "num" : ""}`}>{v}</span>
    </div>
  );
}

function Check({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <span className={`check-item ${done ? "check-item-done" : ""}`}>
      <span className={`mt-[3px] inline-block h-3 w-3 shrink-0 rounded-full border ${done ? "border-good bg-good" : "border-line-strong"}`} aria-hidden />
      {children}
    </span>
  );
}

/** Keep only digits and one decimal point. */
const clean = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
/** "0.123456789012345678" → "0.1234": four decimals is plenty for a funding amount, and it keeps the quick picks readable. */
const trimEth = (v: string) => {
  const [i, f = ""] = v.split(".");
  const frac = f.slice(0, 4).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
};

function safeParse(v: string, d: number): bigint | undefined {
  try {
    if (!v.trim()) return undefined;
    return parseUnits(v.trim(), d);
  } catch {
    return undefined;
  }
}
function safeParseEth(v: string): bigint | undefined {
  try {
    if (!v.trim()) return undefined;
    return parseEther(v.trim());
  } catch {
    return undefined;
  }
}
