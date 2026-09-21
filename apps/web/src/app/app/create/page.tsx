"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useDirectory, useRankedStocks, useVaults, useUser, useQuote, useBoostApys, boostAvailable, type Stock, type PriceMap } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import { Notice, Spinner, StockAvatar, Countdown, Icon, Tip } from "@/components/ui";
import { BoostCard } from "@/components/app/BoostCard";
import { TxFlowDialog, type FlowStep } from "@/components/app/TxFlowDialog";
import { ConnectButton } from "@/components/ConnectButton";
import { fmtUsd, fmtUnits, fmtBps, tsToShort, feeOf } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { BOOST, VAULT_KINDS, VAULT_META, ZERO, DOCS_PATH, USDG_DECIMALS, buysPerMonthOf, type VaultKind } from "@/lib/config";

type Pay = "USDG" | "ETH";
/** What "Start plan" was pressed with, frozen for the transaction dialog so later refetches cannot reshape it mid-flight. */
type Order = { flow: FlowStep[]; symbol: string; perBuy: bigint; kind: VaultKind; funded: string; boost: boolean };

const PER_MIN_FALLBACK = 10n * 10n ** BigInt(USDG_DECIMALS); // vault default until the chain answers
const ETH_GAS_RESERVE = parseEther("0.01");
/** Slippage applied to the ETH → USDG conversion quote when starting a plan with ETH. */
const ZAP_SLIPPAGE_BPS = 50n;

/**
 * Create page in the shape of a swap card (Jupiter's DCA form): one centred card, "Fund with" over "Buy"
 * with an arrow between them, then "Every" (the frequency) beside "Per buy", the boost switch and one big
 * button. The numbered-steps layout lives on at /app/create/legacy and sends the same transaction.
 */
export default function CreatePlanCard() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { stocks, ranked, top, prices, ready: rankReady } = useRankedStocks(dir);
  const { infos, byKind, refetch: refetchVaults } = useVaults(vaults);

  const [stock, setStock] = useState<string>("");
  const [kind, setKind] = useState<VaultKind>("daily");
  const [perBuy, setPerBuy] = useState("100");
  const [pay, setPay] = useState<Pay>("USDG");
  const [upfront, setUpfront] = useState("");
  // Boost is opt-in: idle USDG lent on Morpho Blue between buys. Off by default.
  const [boost, setBoost] = useState(false);
  // Set when Start plan is pressed; the transaction dialog is open while it is.
  const [order, setOrder] = useState<Order | null>(null);

  const vault = vaults?.[kind];
  const info = byKind[kind];
  const canBoost = boostAvailable(info);
  const { apyOf } = useBoostApys(infos);
  const boostApy = apyOf(info?.boostStrategy);
  const user = useUser(dir, vault);
  // Until the user picks, the plan buys the most popular stock (once the ranking is in).
  const stockObj = stocks.find((s) => s.address === stock) ?? top[0];
  const stockAddr = stockObj?.address;
  const stockPrice = stockObj ? prices[stockObj.address.toLowerCase()] : undefined;

  const perBuyWei = safeParse(perBuy, USDG_DECIMALS);
  const upfrontWei = pay === "USDG" ? safeParse(upfront, USDG_DECIMALS) : safeParseEth(upfront);
  // On-chain minimums (10 USDG by default): per-buy amount, and the USDG a plan must be funded with to start.
  const minPerBuy = info?.minAmountPerEpoch ?? PER_MIN_FALLBACK;
  const minDeposit = info?.minDeposit ?? PER_MIN_FALLBACK;

  // Balances → HALF / MAX
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
  const canSubmit = !!address && !!vault && !!stockAddr && perBuyOk && fundedEnough && !insufficient && !quoteMissing && !seq.running;

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
    // The dialog lists both halves for USDG even when the approval is not needed, so the flow always reads the same.
    const boosted = boost && canBoost;
    const vaultName = `${VAULT_META[kind].label.toLowerCase()} vault`;
    const flow: FlowStep[] = [];
    if (pay === "USDG")
      flow.push({
        label: "Approve USDG",
        detail: `Lets the ${vaultName} take ${fmtUsd(usdgAmount)} from your wallet.`,
        done: "Approved",
        skipped: needsApproval ? undefined : "Already approved — the vault can take this amount.",
      });
    flow.push({
      label: "Start plan",
      detail: `${pay === "USDG" ? `Funds the plan with ${fmtUsd(usdgAmount)}` : `Swaps ${fmtUnits(value, 18)} ETH to USDG, funds the plan`} and books the first buy.${
        boosted ? " Idle USDG starts earning on Morpho Blue." : ""
      }`,
      done: "Plan started",
    });
    setOrder({
      flow,
      symbol: stockObj?.symbol ?? "?",
      perBuy: perBuyWei,
      kind,
      funded: pay === "USDG" ? fmtUsd(usdgAmount) : `${fmtUnits(value, 18)} ETH${zapQuote.data ? ` (≈ ${fmtUsd(zapQuote.data.amountOut)})` : ""}`,
      boost: boosted,
    });
    await seq.run(steps);
  };
  /** Closing the dialog ends the order; after a success the funding amount is cleared so the next plan starts fresh. */
  const closeFlow = () => {
    const wasDone = seq.done;
    setOrder(null);
    seq.reset();
    if (wasDone) setUpfront("");
  };

  if (!configured) return <Notice kind="warn">App is not configured: set NEXT_PUBLIC_DIRECTORY.</Notice>;

  const monthly = perBuyWei ? (perBuyWei * BigInt(Math.round(buysPerMonthOf(kind, info?.epochLength) * 100))) / 100n : 0n;
  const feeBps = user.effectiveFeeBps ?? info?.fees?.purchaseFeeBps;
  const fundHint = insufficient
    ? `Not enough ${pay} in your wallet.`
    : fundingTooSmall
      ? `A plan needs at least ${fmtUsd(minDeposit)}${pay === "ETH" ? " worth of ETH" : ""} to start.`
      : undefined;

  return (
    <div className="mx-auto max-w-[480px] pt-1 sm:pt-6">
      <div className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
        {/* Fund with */}
            <Box label="Fund with" error={fundHint}>
              <div className="flex items-center gap-3">
                <input
                  className="amount-input swap-input text-[30px]"
                  inputMode="decimal"
                  value={upfront}
                  onChange={(e) => setUpfront(clean(e.target.value))}
                  placeholder="0"
                  aria-label={`Amount of ${pay} to fund the plan with`}
                />
                <Dropdown
                  trigger={
                    <>
                      <Coin unit={pay} />
                      {pay}
                    </>
                  }
                  width="w-60"
                >
                  {(close) =>
                    (["USDG", "ETH"] as Pay[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        role="option"
                        aria-selected={p === pay}
                        className={`menu-item gap-2.5 ${p === pay ? "bg-surface-4 text-ink" : ""}`}
                        onClick={() => {
                          setPay(p);
                          setUpfront("");
                          close();
                        }}
                      >
                        <Coin unit={p} />
                        <span className="text-[13px] font-medium text-ink">{p}</span>
                        <span className="ml-auto text-[12px] whitespace-nowrap text-ink-3">{p === "ETH" ? "swapped to USDG" : "plan currency"}</span>
                      </button>
                    ))
                  }
                </Dropdown>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
                <span className="num">
                  {pay === "ETH" && upfrontWei && upfrontWei > 0n ? (zapQuote.data ? `≈ ${fmtUsd(zapQuote.data.amountOut)} USDG` : "≈ …") : `≈ ${fmtUsd(upfrontWei ?? 0n)}`}
                </span>
                <span className="flex items-center gap-1.5">
                  <span>
                    Balance <span className="num text-ink-2">{address ? (pay === "USDG" ? fmtUsd(usdgBal) : `${fmtUnits(ethBal, 18)} ETH`) : "—"}</span>
                  </span>
                  {[50, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      disabled={!address || fundMax === 0n}
                      onClick={() => setUpfront(fundShare(pct))}
                      className="quick"
                    >
                      {pct === 100 ? "MAX" : "HALF"}
                    </button>
                  ))}
                </span>
              </div>
            </Box>

            {/* arrow */}
            <div className="relative z-10 -my-2.5 flex justify-center" aria-hidden>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-3">
                <Icon name="arrow" size={14} className="rotate-90" />
              </span>
            </div>

            {/* Buy */}
            <Box label="Buy">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] text-ink-3">
                  {stockObj ? (
                    <>
                      {tickerName(stockObj.symbol)}
                      {stockPrice !== undefined && (
                        <>
                          {" · "}
                          <span className="num">{fmtUsd(stockPrice)}</span>
                        </>
                      )}
                    </>
                  ) : (
                    "Pick a stock"
                  )}
                </span>
                <StockPill stocks={ranked} prices={prices} value={stockAddr ?? ""} onSelect={setStock} />
              </div>
              {(!rankReady || top.length > 0) && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {rankReady
                    ? top.map((s) => {
                        const active = stockAddr === s.address;
                        return (
                          <button
                            key={s.address}
                            type="button"
                            onClick={() => setStock(s.address)}
                            className={`inline-flex h-6 items-center gap-1 rounded-full border pr-2 pl-0.5 text-[11.5px] font-medium transition-colors ${
                              active ? "border-lime bg-lime/10 text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
                            }`}
                          >
                            <StockAvatar symbol={s.symbol} size={18} />
                            {s.symbol}
                          </button>
                        );
                      })
                    : Array.from({ length: 5 }, (_, i) => <span key={i} className="h-6 w-16 animate-pulse rounded-full bg-surface-4" aria-hidden />)}
                </div>
              )}
            </Box>

            {/* Every · Per buy */}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Box 
                className="flex flex-col bg-red-500"
                label="Every" tip="Fill timing includes randomization to mitigate frontrunning risk.">
                <Dropdown
                  plain
                  width="w-40"
                  trigger={
                    <>
                      {everyLabel(kind)}
                      {kind === "test" && <span className="chip-dev">dev</span>}
                    </>
                  }
                >
                  {(close) =>
                    VAULT_KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="option"
                        aria-selected={k === kind}
                        className={`menu-item gap-2 ${k === kind ? "bg-surface-4 text-ink" : ""}`}
                        onClick={() => {
                          setKind(k);
                          close();
                        }}
                      >
                        <span className="text-[13px] font-medium text-ink">{everyLabel(k)}</span>
                        {k === "test" && <span className="chip-dev">dev</span>}
                      </button>
                    ))
                  }
                </Dropdown>
              </Box>
              <Box label="Buy">
                <div className="flex items-center gap-2">
                  <input
                    className="amount-input swap-input text-[20px] sm:text-[26px]"
                    inputMode="decimal"
                    value={perBuy}
                    onChange={(e) => setPerBuy(clean(e.target.value))}
                    placeholder="100"
                    aria-label="Amount per buy"
                  />
                  <span className="shrink-0 text-[12.5px] font-medium text-ink-2">USDG</span>
                </div>
                <div className="mt-1.5 text-[12px] text-ink-3">
                  {perBuyTooSmall ? (
                    <span className="text-bad">min {fmtUsd(minPerBuy)}</span>
                  ) : buysCovered !== undefined && buysCovered > 0 ? (
                    `covers ${buysCovered.toLocaleString()} ${buysCovered === 1 ? "buy" : "buys"}`
                  ) : fundedEnough && upfrontUsdg !== undefined ? (
                    "first buy spends what is there"
                  ) : (
                    `min ${fmtUsd(minPerBuy)}`
                  )}
                </div>
              </Box>
            </div>
            {perBuyOk && (
              <p className="mt-2 text-[12.5px] text-ink-3">
                ≈ <span className="num text-ink-2">{fmtUsd(monthly)}</span> a month, spent while the plan has funds.
              </p>
            )}

            {/* Earn while you wait */}
            <div className="mt-3">
              <BoostCard checked={boost} onChange={setBoost} apy={boostApy} available={canBoost} disabled={seq.running} />
            </div>

            {/* CTA */}
            <div className="mt-3 grid gap-2">
              {!address ? (
                <ConnectButton className="btn-lg w-full rounded-xl" />
              ) : (
                <button type="button" className="btn-primary btn-lg w-full rounded-xl" disabled={!canSubmit} onClick={submit}>
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
        </div>

        {/* details */}
        <div className="mt-4 grid gap-1.5 text-[12.5px]">
          <Detail k="First buy">
            <Countdown target={info?.nextEpochStart} />
            {info?.nextEpochStart && <span className="block text-[11.5px] text-ink-3 sm:ml-1.5 sm:inline sm:text-[12.5px]">{tsToShort(info.nextEpochStart)}</span>}
          </Detail>
          <Detail k="Fee per buy">{fmtBps(feeBps)}</Detail>
          <Detail k="Swap tolerance">{fmtBps(info?.fees?.swapSlippageBps)}</Detail>
          {pay === "ETH" && upfrontWei && upfrontWei > 0n && <Detail k="ETH → USDG tolerance">{fmtBps(Number(ZAP_SLIPPAGE_BPS))}</Detail>}
        </div>
      </div>

      <TxFlowDialog
        open={order !== null}
        titles={{ running: "Starting your plan", done: "Plan started", error: "Plan not started" }}
        subtitle={
          <>
            First buy: <Countdown target={info?.nextEpochStart} className="text-ink-2" />
            {info?.nextEpochStart && ` · ${tsToShort(info.nextEpochStart)}`}
          </>
        }
        summary={order && <OrderSummary order={order} />}
        flow={order?.flow ?? []}
        seq={seq}
        onClose={closeFlow}
        doneActions={
          <div className="grid gap-2">
            <Link href="/app/plans" className="btn-primary btn-lg w-full rounded-xl">
              View my plans
            </Link>
            <button type="button" className="btn-ghost w-full" onClick={closeFlow}>
              Create another
            </button>
          </div>
        }
      />

      <p className="mt-3 px-2 text-center text-[11.5px] leading-normal text-ink-3">
        Stock Tokens are economic exposure, not shareholder rights.
        {info?.fees ? ` Claiming stock costs ${fmtBps(info.fees.claimFeeBps)} (free for $DCA holders).` : ""}{" "}
        <Link href={`${DOCS_PATH}#dca`} className="text-lime hover:underline">
          About $DCA →
        </Link>
      </p>
    </div>
  );
}

/** One field box of the card: label top-left, whatever the field needs beneath, an optional error line. */
function Box({ label, tip, children, className = "", error }: { label: string; tip?: string; children: ReactNode; className?: string; error?: string }) {
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

function Detail({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-3">{k}</span>
      <span className="num text-right text-ink">{children}</span>
    </div>
  );
}

/** The plan being started, recalled at the top of the transaction dialog. */
function OrderSummary({ order }: { order: Order }) {
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
function Coin({ unit }: { unit: Pay }) {
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
function Dropdown({ trigger, children, width = "w-72", plain = false }: { trigger: ReactNode; children: (close: () => void) => ReactNode; width?: string; plain?: boolean }) {
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

/** Token-selector pill for the stock, with the ranked, searchable list beneath. */
function StockPill({ stocks, prices, value, onSelect }: { stocks: Stock[]; prices: PriceMap; value: string; onSelect: (address: string) => void }) {
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
            filtered.map((s) => {
              const p = prices[s.address.toLowerCase()];
              return (
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
                  <span className="num shrink-0 text-[12px] text-ink-3">{p !== undefined ? fmtUsd(p) : "—"}</span>
                </button>
              );
            })
          )}
        </>
      )}
    </Dropdown>
  );
}

/** Keep only digits and one decimal point. */
const clean = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
/** The noun after "Every": day / week / month, or "test" for the local dev vault. */
const everyLabel = (k: VaultKind) => (k === "test" ? "test" : VAULT_META[k].per);
/** "0.123456789012345678" → "0.1234": four decimals is plenty for a funding amount. */
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
