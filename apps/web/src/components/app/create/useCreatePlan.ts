"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, parseEther } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useDirectory, useRankedStocks, useStocks, useKindsBuying, useVaults, useUser, useQuote, useBoostApys, boostAvailable, findStock, type Directory } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import type { FlowStep } from "@/components/app/TxFlowDialog";
import { fmtUsd, fmtUnits, feeOf, short } from "@/lib/format";
import { VAULT_META, ZERO, USDG_DECIMALS, buysPerMonthOf, type VaultKind } from "@/lib/config";
import { coverageCopy } from "@/lib/planFunds";
import { safeParse, safeParseEth, trimEth } from "./fields";

export type Pay = "USDG" | "ETH";
/** What "Start plan" was pressed with, frozen for the transaction dialog so later refetches cannot reshape it mid-flight. */
export type Order = { flow: FlowStep[]; symbol: string; dca: boolean; perBuy: bigint; kind: VaultKind; funded: string; boost: boolean };

export const PER_MIN_FALLBACK = 10n * 10n ** BigInt(USDG_DECIMALS); // vault default until the chain answers
export const ETH_GAS_RESERVE = parseEther("0.01");
/** Slippage applied to the ETH → USDG conversion quote when starting a plan with ETH. */
export const ZAP_SLIPPAGE_BPS = 50n;

/**
 * `?stock=<ticker or address>` (the landing pages' stock links): the stock the form opens on, kept until the user picks
 * one themselves (`clear`, which the form's pickers call). It is looked up by ticker or address in the current registry
 * list on every render, so a list restored from the last visit and then replaced by the refetch still resolves. Once
 * the fresh list and the keeper's pairs are in, it is decided once: a frequency that does not buy it switches to the
 * first one that does; when none does, or the registry does not list it, `unavailable` names it for the Buy block's
 * notice and the usual default stands. While `active`, the form's pick is `stock` if this frequency buys it, else
 * nothing ("Pick a stock", like any pick the frequency does not buy). Read from `window.location` after mount:
 * `useSearchParams` would need a Suspense boundary around the page.
 */
export function useStockParam(dir: Directory | undefined, kind: VaultKind, setKind: (kind: VaultKind) => void) {
  const [wanted, setWanted] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => setWanted(new URLSearchParams(window.location.search).get("stock")?.trim() || null), []);
  const { stocks: listed, fresh: listFresh } = useStocks(dir?.registry);
  const { kindsBuying, fresh: pairsFresh } = useKindsBuying();
  const hit = wanted ? findStock(listed, wanted) : undefined;
  const kinds = hit ? kindsBuying(hit.address) : undefined;
  useEffect(() => {
    if (!wanted || settled || !listFresh || !pairsFresh) return;
    setSettled(true);
    if (kinds && kinds.length > 0 && !kinds.some((k) => k === kind)) setKind(kinds[0]);
  }, [wanted, settled, listFresh, pairsFresh, kinds, kind, setKind]);
  const clear = useCallback(() => setWanted(null), []);
  const unavailable = wanted && settled && !kinds?.length ? (hit?.symbol ?? (/^0x[0-9a-f]{40}$/i.test(wanted) ? short(wanted) : wanted.toUpperCase())) : undefined;
  return { active: !!wanted && !unavailable, stock: hit, unavailable, clear };
}

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
  const [kind, setKind] = useState<VaultKind>(defaultKind);
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
  // Set when Start plan is pressed; the transaction dialog is open while it is.
  const [order, setOrder] = useState<Order | null>(null);

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
  // The vault spends min(balance, perBuy) each period, so a remainder is one last, smaller buy: `runs` counts it.
  const lastBuyUsdg = upfrontUsdg !== undefined && perBuyWei && perBuyWei > 0n ? upfrontUsdg % perBuyWei : undefined;
  const runs = buysCovered !== undefined ? buysCovered + (lastBuyUsdg && lastBuyUsdg > 0n ? 1 : 0) : undefined;

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
      dca: !!dca && stockObj?.address === dca.address,
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

  // When the last buy lands, if nothing is paused or topped up: one epoch per run after the first buy.
  const firstBuyAt = info?.nextEpochStart;
  const lastBuyAt = runs && firstBuyAt !== undefined && info?.epochLength ? firstBuyAt + BigInt((runs - 1) * info.epochLength) : undefined;

  const monthly = perBuyWei ? (perBuyWei * BigInt(Math.round(buysPerMonthOf(kind, info?.epochLength) * 100))) / 100n : 0n;
  const feeBps = user.effectiveFeeBps ?? info?.fees?.purchaseFeeBps;
  /** Error line under the funding box; undefined when the funding amount is fine (or empty). */
  const fundHint = insufficient
    ? `Not enough ${pay} in your wallet.`
    : fundingTooSmall
      ? `A plan needs at least ${fmtUsd(minDeposit)}${pay === "ETH" ? " worth of ETH" : ""} to start.`
      : undefined;
  /**
   * Funded with less than one buy (per-buy amount > what the plan will hold). The vault does not hold a short balance
   * back — each period it spends min(balance, per-buy amount) — so the first buy takes all of it, smaller than asked,
   * and the plan then sits empty, buying nothing, until it is topped up. Worth a warning, not a block: the plan is
   * valid and the user may mean to top it up.
   */
  const underfunded = fundedEnough && upfrontUsdg !== undefined && !!perBuyWei && upfrontUsdg < perBuyWei;
  /**
   * How far the funding goes, worded as on My plans (`coverageCopy`): "covers N buys", "covers N buys + a $X final buy",
   * or "less than one buy" (see `underfunded`); undefined until funded.
   */
  const coverage =
    buysCovered !== undefined && buysCovered > 0 && upfrontUsdg !== undefined && perBuyWei
      ? `covers ${coverageCopy(upfrontUsdg, perBuyWei)}`
      : underfunded
        ? "less than one buy"
        : undefined;

  return {
    // wiring
    address,
    dir,
    configured,
    info,
    // stock ($DCA, when this frequency buys it, is `dca`: first in `choices`, never in `ranked` / `top`)
    stocks,
    ranked,
    top,
    dca,
    choices,
    rankReady,
    stockObj,
    stockAddr,
    setStock,
    // a `?stock=` ticker no frequency buys (or the registry does not list), for the Buy block's notice
    paramUnavailable: param.unavailable,
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
    underfunded,
    fundHint,
    coverage,
    buysCovered,
    lastBuyUsdg,
    runs,
    firstBuyAt,
    lastBuyAt,
    // $DCA held by the connected wallet (holder perks)
    dcaBal: user.dca,
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
