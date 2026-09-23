import type { Address } from "viem";
import type { TxStep } from "@/hooks/useTx";
import type { FlowStep } from "@/components/app/TxFlowDialog";
import { PlanVaultAbi } from "@/abi";
import { fmtUsd, fmtUnits, fmtBps, feeOf, short } from "@/lib/format";
import { MAX_UINT256, BOOST } from "@/lib/config";

/**
 * "Withdraw & remove plan" is, on chain, up to four owner-signed calls: `setPlanBoost(false)` →
 * `withdrawIdle(MAX)` → `claim(MAX)` → `prunePlan`. This module decides which of them a plan needs RIGHT NOW
 * from a fresh `getPlan` read (never from the click-time row), because `withdrawIdle(MAX)` / `claim(MAX)` revert
 * `ZeroAmount` on an empty leg and `prunePlan` reverts `PlanNotEmpty` while anything is left — including boost
 * shares whose value floors to zero, which only the unboost burns. Pure: no React, no wagmi, so the rule reads
 * on its own; `buildCloseOrder` below is the one-transaction alternative `RemoveForm` prefers when the vault
 * exposes `closePlan` and a simulation passes, with this sequence as the fallback when it reverts.
 */

/** The fields of the vault's `Plan` struct the builder reads, plus the boosted balance ClaimHelper values. */
export type FreshPlan = {
  owner: Address;
  recipient: Address;
  boosted: boolean;
  usdgIdle: bigint;
  stockAccrued: bigint;
  boostShares: bigint;
  /** USDG value of `boostShares` (yield included) from the positions read; `getPlan` has only the shares. */
  boostValue: bigint;
};

export type RemoveInput = {
  vault: Address;
  planId: bigint;
  plan: FreshPlan;
  /** `isEpochPending(stock)`: while a buy page is open the prune would revert `EpochInProgress`, so it is deferred. */
  epochPending: boolean;
  symbol: string;
  stockDecimals: number;
  withdrawFeeBps: number;
  claimFeeBps: number;
  /** The connected wallet; the claim copy names the recipient when it differs. */
  signer?: Address;
};

export type RemoveOrder = {
  /**
   * `close`: the one-transaction `closePlan`. `sequence`: the single legs (`setPlanBoost(false)` → `withdrawIdle`
   * → `claim` → `prunePlan`), used when the vault has no `closePlan` or when it reverts (Morpho short of
   * liquidity, a token that refuses the fee recipient — the close is atomic, the legs are not).
   */
  kind: "close" | "sequence";
  /** What is sent, in order. Empty when nothing is left to do but a deferred prune. */
  steps: TxStep[];
  /** One row per step for `TxFlowDialog`, plus a `deferred` "Delete plan" row when the prune waits for a running buy. */
  flow: FlowStep[];
  /**
   * Whether the plan leaves the index in this run ("sent") or stays listed because a buy page is open for its
   * stock ("deferred"): the sequence then holds `prunePlan` back; `closePlan` still runs but PARKS the plan
   * (paused, still indexed, `PlanClosed(..., false)`) until a later `prunePlan` / `closePlan` drops it.
   */
  prune: "sent" | "deferred";
  /** Index in `steps` of the step that pays the USDG out (`withdrawIdle(MAX)` or `closePlan`), or -1 when the plan holds no USDG. */
  withdrawIndex: number;
};

export const STEP_UNBOOST = BOOST.off;
export const STEP_WITHDRAW = "Withdraw funds";
export const STEP_DELETE = "Delete plan";
/** The one-transaction close; also the label `RemoveForm` matches on to offer the step-by-step fallback. */
export const STEP_CLOSE = "Withdraw & remove";
export const claimLabel = (symbol: string) => `Claim ${symbol}`;
/** Copy of the prune row while a buy is running: the funds legs still run, the delete waits for the epoch. */
export const DEFER_COPY = "Delete later — funds already withdrawn";
/** Trailing copy of the `closePlan` row while a buy is running: funds come out now, the plan is parked until the epoch is over. */
export const CLOSE_DEFER_COPY = "Funds out now · deleted after the buy";

/**
 * Whether the vault the plan lives in can take `closePlan` right now, decided by `RemoveForm` from the vault's
 * bytecode (does it dispatch the selector at all — older local deployments do not) and a simulation as the
 * owner (would it revert: Morpho illiquid, fee recipient blocked, …). `reason` is product copy for the preview.
 */
export type CloseProbe = { available: true } | { available: false; kind: "missing" | "reverted"; reason: string };

/** What `closePlan` / the sequence pay out in USDG: the idle balance plus the boosted one (yield included). */
export const usdgOut = (p: Pick<FreshPlan, "usdgIdle" | "boostValue">): bigint => p.usdgIdle + p.boostValue;

/** The contract's own definition of empty (`prunePlan` reverts `PlanNotEmpty` otherwise). */
export const isEmptyPlan = (p: Pick<FreshPlan, "usdgIdle" | "stockAccrued" | "boostShares">): boolean =>
  p.usdgIdle === 0n && p.stockAccrued === 0n && p.boostShares === 0n;

/** Where a claim pays out, in the user's words. */
export function recipientCopy(recipient: Address, signer?: Address): string {
  return signer && recipient.toLowerCase() === signer.toLowerCase() ? "your wallet" : `the plan's recipient ${short(recipient)}`;
}

/**
 * Builds the sequence for the plan as it stands. The same function rebuilds the REMAINING work after a failed
 * step (a mined withdraw leaves `usdgIdle == 0`, so it is simply not listed again) — that is what makes
 * "Try again" safe to feed into `useTxSequence.retry(steps)`.
 */
export function buildRemoveOrder(i: RemoveInput): RemoveOrder {
  const { vault, planId, plan: p } = i;
  const call = (functionName: string, args: readonly unknown[]): TxStep["params"] => ({ address: vault, abi: PlanVaultAbi, functionName, args });
  const steps: TxStep[] = [];
  const flow: FlowStep[] = [];
  let withdrawIndex = -1;

  // 1. A boosted plan is unboosted first: the Morpho position (earnings included) comes back into the plan as
  //    idle USDG and its shares are burnt — `withdrawIdle(MAX)` alone can leave dust shares behind.
  if (p.boosted) {
    steps.push({ label: STEP_UNBOOST, params: call("setPlanBoost", [planId, false]) });
    flow.push({
      label: STEP_UNBOOST,
      detail: `Pulls ${fmtUsd(p.boostValue)} back from Morpho Blue into the plan, earnings included.`,
      done: "Back in the plan",
      trailing: fmtUsd(p.boostValue),
    });
  }

  // 2. Everything the plan holds in USDG, to the wallet that signs, minus the withdrawal fee.
  const usdg = p.usdgIdle + p.boostValue;
  if (usdg > 0n) {
    withdrawIndex = steps.length;
    steps.push({ label: STEP_WITHDRAW, params: call("withdrawIdle", [planId, MAX_UINT256]) });
    flow.push({
      label: STEP_WITHDRAW,
      detail: `Sends the plan's USDG to the wallet you sign with, minus the ${fmtBps(i.withdrawFeeBps)} withdrawal fee.`,
      done: "Withdrawn",
      trailing: `≈ ${fmtUsd(usdg - feeOf(usdg, i.withdrawFeeBps))}`,
    });
  }

  // 3. Stock already bought goes to the plan's recipient (the signer unless the plan was set up otherwise).
  if (p.stockAccrued > 0n) {
    const net = p.stockAccrued - feeOf(p.stockAccrued, i.claimFeeBps);
    steps.push({ label: claimLabel(i.symbol), params: call("claim", [planId, MAX_UINT256]) });
    flow.push({
      label: claimLabel(i.symbol),
      detail: `Sends your ${i.symbol} to ${recipientCopy(p.recipient, i.signer)}${i.claimFeeBps > 0 ? `, minus the ${fmtBps(i.claimFeeBps)} claim fee (free for $DCA holders)` : ""}.`,
      done: "Claimed",
      trailing: `${fmtUnits(net, i.stockDecimals, 4)} ${i.symbol}`,
    });
  }

  // 4. The prune itself moves no value; it only needs an empty plan and no open buy page.
  if (i.epochPending) flow.push({ label: STEP_DELETE, deferred: DEFER_COPY });
  else {
    steps.push({ label: STEP_DELETE, params: call("prunePlan", [planId]) });
    flow.push({ label: STEP_DELETE, detail: "Removes the empty plan from the vault.", done: "Plan removed" });
  }

  return { kind: "sequence", steps, flow, prune: i.epochPending ? "deferred" : "sent", withdrawIndex };
}

/**
 * The one-transaction alternative: `closePlan(planId)` unboosts, pays out the USDG (withdraw fee, to the
 * signer), claims the stock (claim fee, to the recipient) and drops the plan — atomically, so it either does
 * everything or nothing. Chosen by `RemoveForm` when the vault dispatches it and a simulation passes; the
 * sequence above is the fallback when it reverts.
 *
 * Two edges match `buildRemoveOrder`: while a buy page is open for the stock the plan cannot leave the index,
 * so the close PARKS it (paused, empty, still listed, `PlanClosed(..., false)`) and a later `prunePlan` /
 * `closePlan` finishes the job — `prune` is "deferred" and the row says so; and an already-empty plan opened
 * while a buy runs sends nothing at all (a close now would only park it), exactly like the deferred prune.
 */
export function buildCloseOrder(i: RemoveInput): RemoveOrder {
  const { vault, planId, plan: p } = i;
  const usdg = usdgOut(p);
  const empty = isEmptyPlan(p);
  if (empty && i.epochPending) return { kind: "close", steps: [], flow: [{ label: STEP_DELETE, deferred: DEFER_COPY }], prune: "deferred", withdrawIndex: -1 };

  const parts: string[] = [];
  if (p.boosted) parts.push(`pulls ${fmtUsd(p.boostValue)} back from Morpho Blue (earnings included)`);
  if (usdg > 0n) parts.push(`sends ${fmtUsd(usdg)} USDG to the wallet you sign with, minus the ${fmtBps(i.withdrawFeeBps)} withdrawal fee`);
  if (p.stockAccrued > 0n) {
    parts.push(
      `sends ${fmtUnits(p.stockAccrued, i.stockDecimals, 4)} ${i.symbol} to ${recipientCopy(p.recipient, i.signer)}${i.claimFeeBps > 0 ? ` minus the ${fmtBps(i.claimFeeBps)} claim fee (free for $DCA holders)` : ""}`,
    );
  }
  const tail = i.epochPending
    ? `then pauses the empty plan — a ${i.symbol} buy is running, so it is dropped from the vault with one more confirmation once the buy has finished`
    : empty
      ? "removes the empty plan from the vault"
      : "then removes the plan from the vault";
  const detail = `One transaction: ${[...parts, tail].join(", ")}.`;

  const trailing = [usdg > 0n ? `≈ ${fmtUsd(usdg - feeOf(usdg, i.withdrawFeeBps))}` : "", p.stockAccrued > 0n ? `${fmtUnits(p.stockAccrued - feeOf(p.stockAccrued, i.claimFeeBps), i.stockDecimals, 4)} ${i.symbol}` : ""]
    .filter(Boolean)
    .join(" · ");
  const step: TxStep = { label: STEP_CLOSE, params: { address: vault, abi: PlanVaultAbi, functionName: "closePlan", args: [planId] } };
  const flow: FlowStep = {
    label: STEP_CLOSE,
    detail,
    done: i.epochPending ? "Funds out · plan parked" : "Plan removed",
    trailing: i.epochPending ? CLOSE_DEFER_COPY : trailing || undefined,
  };
  return { kind: "close", steps: [step], flow: [flow], prune: i.epochPending ? "deferred" : "sent", withdrawIndex: usdg > 0n ? 0 : -1 };
}

/**
 * The fallback when the unboost or the full withdrawal fails because Morpho is short of liquidity: only the
 * part that is not lent out can move, so this withdraws exactly `usdgIdle` and leaves the boosted part for later.
 */
export function buildPartialWithdraw(vault: Address, planId: bigint, usdgIdle: bigint, withdrawFeeBps: number): RemoveOrder {
  const step: TxStep = { label: "Withdraw available part", params: { address: vault, abi: PlanVaultAbi, functionName: "withdrawIdle", args: [planId, usdgIdle] } };
  const flow: FlowStep = {
    label: step.label,
    detail: `Sends the ${fmtUsd(usdgIdle)} that is not lent out, minus the ${fmtBps(withdrawFeeBps)} fee. The boosted part stays until Morpho has liquidity.`,
    done: "Withdrawn",
    trailing: `≈ ${fmtUsd(usdgIdle - feeOf(usdgIdle, withdrawFeeBps))}`,
  };
  return { kind: "sequence", steps: [step], flow: [flow], prune: "deferred", withdrawIndex: 0 };
}
