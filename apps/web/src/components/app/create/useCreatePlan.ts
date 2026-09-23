"use client";

import { useEffect, useState } from "react";
import { formatEther, formatUnits, parseEther } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useDirectory, useRankedStocks, useVaults, useUser, useQuote, useBoostApys, boostAvailable } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import type { FlowStep } from "@/components/app/TxFlowDialog";
import { fmtUsd, fmtUnits, feeOf } from "@/lib/format";
import { VAULT_META, ZERO, USDG_DECIMALS, buysPerMonthOf, type VaultKind } from "@/lib/config";
import { safeParse, safeParseEth, trimEth } from "./fields";

export type Pay = "USDG" | "ETH";
/** What "Start plan" was pressed with, frozen for the transaction dialog so later refetches cannot reshape it mid-flight. */
export type Order = { flow: FlowStep[]; symbol: string; perBuy: bigint; kind: VaultKind; funded: string; boost: boolean };

export const PER_MIN_FALLBACK = 10n * 10n ** BigInt(USDG_DECIMALS); // vault default until the chain answers
export const ETH_GAS_RESERVE = parseEther("0.01");
/** Slippage applied to the ETH → USDG conversion quote when starting a plan with ETH. */
export const ZAP_SLIPPAGE_BPS = 50n;

/** Everything a create-plan layout needs: the hook's return value, passed to the blocks as `m`. */
export type CreatePlanModel = ReturnType<typeof useCreatePlan>;

/**
 * The create-plan form's state, derived values, validation and the transaction itself — everything except
 * the layout. `/app/create` and `/app/create/2` both render from this one model, so the `createPlan`
 * calldata, the frozen `Order` and the dialog's steps are identical whichever order the blocks are shown in;
 * the variants differ only in block order and labels. `defaultKind` is the frequency the form opens on.
 */
export function useCreatePlan({ defaultKind = "daily" }: { defaultKind?: VaultKind } = {}) {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { stocks, ranked, top, ready: rankReady } = useRankedStocks(dir);
  const { infos, byKind, refetch: refetchVaults } = useVaults(vaults);

  const [stock, setStock] = useState<string>("");
  const [kind, setKind] = useState<VaultKind>(defaultKind);
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

  const monthly = perBuyWei ? (perBuyWei * BigInt(Math.round(buysPerMonthOf(kind, info?.epochLength) * 100))) / 100n : 0n;
  const feeBps = user.effectiveFeeBps ?? info?.fees?.purchaseFeeBps;
  /** Error line under the funding box; undefined when the funding amount is fine (or empty). */
  const fundHint = insufficient
    ? `Not enough ${pay} in your wallet.`
    : fundingTooSmall
      ? `A plan needs at least ${fmtUsd(minDeposit)}${pay === "ETH" ? " worth of ETH" : ""} to start.`
      : undefined;
  /** How far the funding goes: "covers N buys", or that the first buy takes whatever is there; undefined until funded. */
  const coverage =
    buysCovered !== undefined && buysCovered > 0
      ? `covers ${buysCovered.toLocaleString()} ${buysCovered === 1 ? "buy" : "buys"}`
      : fundedEnough && upfrontUsdg !== undefined
        ? "first buy spends what is there"
        : undefined;

  return {
    // wiring
    address,
    dir,
    configured,
    info,
    // stock
    stocks,
    ranked,
    top,
    rankReady,
    stockObj,
    stockAddr,
    setStock,
    // frequency
    kind,
    setKind,
    // per buy
    perBuy,
    setPerBuy,
    perBuyWei,
    perBuyOk,
    perBuyTooSmall,
    minPerBuy,
    // funding
    pay,
    setPay,
    upfront,
    setUpfront,
    upfrontWei,
    upfrontUsdg,
    usdgBal,
    ethBal,
    fundMax,
    fundShare,
    zapQuote,
    fundedEnough,
    fundHint,
    coverage,
    // boost
    boost,
    setBoost,
    canBoost,
    boostApy,
    // summary
    monthly,
    feeBps,
    // transaction
    needsApproval,
    canSubmit,
    seq,
    order,
    submit,
    closeFlow,
  };
}
