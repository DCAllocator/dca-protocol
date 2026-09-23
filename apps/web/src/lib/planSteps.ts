import { parseEventLogs, type Abi, type Address, type Log } from "viem";
import type { TxStep } from "@/hooks/useTx";
import type { FlowStep } from "@/components/app/TxFlowDialog";
import { PlanVaultAbi, ERC20Abi, AggregatorRouterAbi, MorphoBlueStrategyAbi } from "@/abi";
import { fmtUsd, fmtUnits, fmtUnitsCompact, fmtBps, fmtPct, feeOf, short } from "@/lib/format";
import { MAX_UINT256, BOOST } from "@/lib/config";
import { claimLabel, recipientCopy } from "@/lib/removeSteps";

/**
 * The single-plan actions on My plans — deposit, withdraw, claim, boost and unboost — as the writes
 * `useTxSequence` sends and the rows `TxFlowDialog` draws. Each builder runs ONCE, when the user commits, from
 * the numbers on screen at that moment, and its result is the dialog's snapshot: the overview keeps showing what
 * was sent while the live row changes underneath it (a mined claim zeroes the accrued stock, a mined boost flips
 * `boosted`), so it never rewrites itself mid-flight. Pure: no React, no wagmi, like `removeSteps.ts`.
 */

/** Which plan an order is for, and how to name its stock. */
export type PlanRef = { vault: Address; planId: bigint; symbol: string; stockDecimals: number };

type Base = PlanRef & { steps: TxStep[]; flow: FlowStep[] };

export type DepositOrder = Base & {
  kind: "deposit";
  pay: "USDG" | "ETH";
  /** What leaves the wallet: USDG units, or wei for ETH. */
  amount: bigint;
  /** USDG the plan is credited: net of any deposit fee, or the ETH quote (the swap may land up to the tolerance lower). */
  credited?: bigint;
  /** Plan balance once `credited` lands. */
  balanceAfter?: bigint;
  /** The plan is boosted, so the deposit is lent on Morpho Blue as it lands. */
  boosted: boolean;
};
export type WithdrawOrder = Base & {
  kind: "withdraw";
  /** USDG taken out of the plan (the withdrawal fee comes out of this). */
  amount: bigint;
  /** What reaches the wallet: `amount` minus the withdrawal fee. */
  receive: bigint;
  feeBps: number;
  /** The part of `amount` that comes back from Morpho Blue first (idle USDG is used before the boosted balance). */
  fromBoost: bigint;
  balanceAfter: bigint;
};
export type ClaimOrder = Base & {
  kind: "claim";
  /** Stock held for the plan at click time; `claim(MAX)` takes whatever is there when it lands. */
  amount: bigint;
  /** What reaches the recipient: `amount` minus the claim fee. */
  receive: bigint;
  /** USD value of `amount` at the current quote, when there is one. */
  usd?: bigint;
  feeBps: number;
  /** The owner holds the auto-distribute amount of $DCA, which is why the fee is 0. */
  perk: boolean;
  /** The stock token, for "Add to wallet" once it has landed. */
  stock: Address;
  recipient: Address;
  /** The recipient is the wallet signing the claim. */
  toSelf: boolean;
};
export type BoostOrder = Base & {
  kind: "boost";
  /** Idle USDG lent the moment the boost lands (`setPlanBoost(true)` moves all of `usdgIdle`). */
  lend: bigint;
  /** Morpho Blue supply APY at click time, as a fraction. */
  apy?: number;
};
export type UnboostOrder = Base & {
  kind: "unboost";
  /** Boosted balance pulled back into the plan, earnings included. */
  back: bigint;
  /** Lifetime boost earnings of the plan at click time. */
  earned: bigint;
};
export type PauseOrder = Base & {
  kind: "pause";
  /** `true` pauses the plan, `false` resumes it. */
  pause: boolean;
  /** Plan balance at click time (it stays in the plan either way). */
  balance: bigint;
  /** The balance is lent on Morpho Blue and keeps earning while paused. */
  boosted: boolean;
  perBuy: bigint;
  /** When the vault's next buy starts (unix seconds), for the resume overview. */
  nextBuy?: bigint;
};
export type PlanOrder = DepositOrder | WithdrawOrder | ClaimOrder | BoostOrder | UnboostOrder | PauseOrder;
export type PlanOrderKind = PlanOrder["kind"];

/**
 * The vault's ABI plus the errors that bubble up through it unchanged: the router's (an ETH deposit swaps inside
 * `depositETH`) and the boost strategy's (a withdrawal or unboost pulls from Morpho). With them viem can name those
 * reverts — in the pre-wallet estimate, which then stops a doomed call, and in `planErrorHint`.
 */
const NESTED_ERRORS = new Set(["InsufficientOutput", "NoRoute", "PartialFill", "PriceImpactTooHigh", "ERC4626ExceededMaxWithdraw", "ERC4626ExceededMaxRedeem"]);
const VAULT_CALL_ABI = [
  ...PlanVaultAbi,
  ...[...AggregatorRouterAbi, ...MorphoBlueStrategyAbi].filter((x) => x.type === "error" && NESTED_ERRORS.has(x.name)),
] as Abi;

const vaultCall = (ref: PlanRef, functionName: string, args: readonly unknown[], value?: bigint): TxStep["params"] => ({
  address: ref.vault,
  abi: VAULT_CALL_ABI,
  functionName,
  args,
  ...(value !== undefined ? { value } : {}),
});

export const STEP_APPROVE = "Approve USDG";
export const STEP_DEPOSIT = "Deposit";
/** The withdraw row's label; the remove flow uses its own ("Withdraw funds"), which empties the plan. */
export const STEP_WITHDRAW_PART = "Withdraw";
export const STEP_BOOST = BOOST.on;
export const STEP_UNBOOST = BOOST.off;

/** Headings of the flow dialog per order, in the create flow's register ("Starting your plan" / "Plan started"). */
export function planFlowTitles(o: PlanOrder): { running: string; done: string; error: string } {
  switch (o.kind) {
    case "deposit":
      return { running: "Depositing", done: "Deposited", error: "Not deposited" };
    case "withdraw":
      return { running: "Withdrawing", done: "Withdrawn", error: "Not withdrawn" };
    case "claim":
      return { running: `Claiming ${o.symbol}`, done: `${o.symbol} claimed`, error: "Not claimed" };
    case "boost":
      return { running: "Boosting your plan", done: "Plan boosted", error: "Not boosted" };
    case "unboost":
      return { running: "Unboosting", done: "Plan unboosted", error: "Not unboosted" };
    case "pause":
      return o.pause
        ? { running: "Pausing your plan", done: "Plan paused", error: "Not paused" }
        : { running: "Resuming your plan", done: "Plan resumed", error: "Not resumed" };
  }
}

/** The line under the heading once the flow is done: where the value ended up. */
export function planFlowDoneLine(o: PlanOrder): string {
  const stock = (v: bigint) => `${fmtUnits(v, o.stockDecimals, 4)} ${o.symbol}`;
  switch (o.kind) {
    case "deposit":
      return o.balanceAfter !== undefined ? `Plan balance ≈ ${fmtUsd(o.balanceAfter)}${o.boosted ? ", lent on Morpho Blue" : ""}` : "The plan is topped up.";
    case "withdraw":
      return `≈ ${fmtUsd(o.receive)} sent to your wallet`;
    case "claim":
      return o.toSelf ? `${stock(o.receive)} is in your wallet` : `${stock(o.receive)} sent to ${short(o.recipient)}`;
    case "boost":
      return o.apy !== undefined ? `Earning ${fmtPct(o.apy, true)} APY on Morpho Blue` : "Earning on Morpho Blue";
    case "unboost":
      return `${fmtUsd(o.back)} is back in the plan`;
    case "pause":
      return o.pause ? "No buys until you resume it" : "Buying again from the next period";
  }
}

/**
 * The done line from what actually happened: the vault's own events in the last receipt (`Claimed`, `IdleWithdrawn`,
 * `Deposited` / `WethZapped`, `BoostDeposited`, `BoostWithdrawn`), so the confirmation carries mined figures rather
 * than the click-time estimate (`claim(MAX)` takes whatever is there when it lands; Morpho rounds). `undefined`
 * when the expected event is not in the logs — the caller then keeps `planFlowDoneLine`.
 */
export function planOutcomeLine(o: PlanOrder, logs: readonly Log[]): string | undefined {
  const mine = parseEventLogs({ abi: PlanVaultAbi, logs: logs as Log[] }).filter(
    (l) => l.address.toLowerCase() === o.vault.toLowerCase() && "planId" in l.args && l.args.planId === o.planId,
  );
  const last = <N extends (typeof mine)[number]["eventName"]>(name: N) =>
    mine.filter((l) => l.eventName === name).at(-1) as Extract<(typeof mine)[number], { eventName: N }> | undefined;
  const stock = (v: bigint) => `${fmtUnits(v, o.stockDecimals, 4)} ${o.symbol}`;
  switch (o.kind) {
    case "claim": {
      const e = last("Claimed");
      if (!e) return undefined;
      const net = e.args.amount - e.args.fee;
      return o.toSelf ? `${stock(net)} is in your wallet` : `${stock(net)} sent to ${short(e.args.recipient)}`;
    }
    case "withdraw": {
      const e = last("IdleWithdrawn");
      return e ? `${fmtUsd(e.args.usdgAmount - e.args.usdgFee)} sent to your wallet` : undefined;
    }
    case "deposit": {
      const zap = last("WethZapped");
      const dep = last("Deposited");
      if (o.pay === "ETH") return zap ? `${fmtUsd(zap.args.usdgOut)} added to the plan${o.boosted ? ", lent on Morpho Blue" : ""}` : undefined;
      return dep ? `${fmtUsd(dep.args.amount - dep.args.fee)} added to the plan${o.boosted ? ", lent on Morpho Blue" : ""}` : undefined;
    }
    case "boost": {
      if (!last("PlanBoostSet")) return undefined;
      const lent = last("BoostDeposited");
      const rate = o.apy !== undefined ? ` at ${fmtPct(o.apy, true)} APY` : "";
      return lent ? `${fmtUsd(lent.args.usdgIn)} earning${rate} on Morpho Blue` : `Deposits now earn${rate} on Morpho Blue`;
    }
    case "unboost": {
      if (!last("PlanBoostSet")) return undefined;
      const e = last("BoostWithdrawn");
      // A plan whose boosted balance was already spent unboosts with nothing to pull back.
      return e ? `${fmtUsd(e.args.usdgOut)} is back in the plan` : "Nothing was lent any more — the plan is unboosted";
    }
    case "pause": {
      const e = last("PlanPausedSet");
      if (!e) return undefined;
      return e.args.paused ? "No buys until you resume it" : "Buying again from the next period";
    }
  }
}

/**
 * USDG a confirmed boost actually lent, from its receipt (the vault's `BoostDeposited.usdgIn` for this plan), for the
 * Boost hero's line; `undefined` when the receipt has no such event (nothing was idle, so nothing was lent).
 */
export function boostLent(o: BoostOrder, logs: readonly Log[]): bigint | undefined {
  return parseEventLogs({ abi: PlanVaultAbi, eventName: "BoostDeposited", logs: logs as Log[] })
    .filter((l) => l.address.toLowerCase() === o.vault.toLowerCase() && l.args.planId === o.planId)
    .at(-1)?.args.usdgIn;
}

/**
 * What a failed step's custom error means for this order, in the product's voice; `undefined` when the step's own
 * error line already says enough (a wallet rejection, an undecoded revert).
 */
export function planErrorHint(o: PlanOrder, errorName?: string): string | undefined {
  switch (errorName) {
    case "EnforcedPause":
      return "The protocol is paused right now. Withdrawals, claims and unboosting still work; deposits and boosting wait until it resumes.";
    case "BoostUnavailable":
      return "Boost is not available on this vault.";
    case "NotPlanOwner":
      return "The connected wallet does not own this plan.";
    case "ZeroAmount":
      return o.kind === "claim" ? `Nothing is left to claim — the ${o.symbol} was already sent.` : "There is nothing left to move.";
    case "InsufficientIdle":
      return "The plan holds less than that now — a buy may have spent some of it. Close and try a smaller amount.";
    case "InsufficientAccrued":
      return `The plan holds less ${o.symbol} than that now. Close and try again.`;
    case "BelowMinimum":
      return "That is below the smallest deposit the vault accepts.";
    case "ERC4626ExceededMaxWithdraw":
    case "ERC4626ExceededMaxRedeem":
      return "Morpho Blue is short of liquidity for the boosted balance right now. Nothing moved; try again later.";
    case "InsufficientOutput":
      return "The ETH price moved beyond the tolerance, so nothing was swapped. Close and deposit again for a fresh quote.";
    case "PriceImpactTooHigh":
      return "That swap would move the ETH price too much, so nothing was swapped. Try a smaller amount, or pay with USDG.";
    case "NoRoute":
    case "PartialFill":
      return "The pool cannot fill this ETH swap in full right now, so nothing was swapped. Try a smaller amount, or pay with USDG.";
    default:
      return undefined;
  }
}

/**
 * Top-up: an exact-amount USDG approval when the allowance falls short (listed as done otherwise, so the flow reads
 * the same both ways, like create), then `depositUSDG`; or `depositETH`, which swaps inside the vault with
 * `minUsdgOut` as the floor. A boosted plan lends the deposit as it lands.
 */
export function buildDepositOrder(i: {
  ref: PlanRef;
  usdg: Address;
  pay: "USDG" | "ETH";
  amount: bigint;
  needsApproval: boolean;
  /** ETH only: the least USDG the swap may credit (quote minus the tolerance). */
  minUsdgOut?: bigint;
  toleranceBps?: number;
  depositFeeBps: number;
  credited?: bigint;
  balanceBefore: bigint;
  boosted: boolean;
  /** "Test vault", "daily vault": whose allowance the approval raises. */
  vaultName: string;
}): DepositOrder {
  const { ref, pay, amount } = i;
  const steps: TxStep[] = [];
  const flow: FlowStep[] = [];
  const lent = i.boosted ? " It is lent on Morpho Blue as it lands." : "";
  const fee = i.depositFeeBps > 0 ? `, minus the ${fmtBps(i.depositFeeBps)} deposit fee` : "";

  if (pay === "USDG") {
    if (i.needsApproval) steps.push({ label: STEP_APPROVE, params: { address: i.usdg, abi: ERC20Abi, functionName: "approve", args: [ref.vault, amount] } });
    flow.push({
      label: STEP_APPROVE,
      detail: `Lets the ${i.vaultName} take ${fmtUsd(amount)} from your wallet.`,
      done: "Approved",
      skipped: i.needsApproval ? undefined : "Already approved — the vault can take this amount.",
    });
    steps.push({ label: STEP_DEPOSIT, params: vaultCall(ref, "depositUSDG", [ref.planId, amount]) });
    flow.push({
      label: STEP_DEPOSIT,
      detail: `Adds ${fmtUsd(amount)} to the plan${fee}.${lent}`,
      done: "Deposited",
      trailing: fmtUsd(amount),
    });
  } else {
    steps.push({ label: STEP_DEPOSIT, params: vaultCall(ref, "depositETH", [ref.planId, i.minUsdgOut ?? 0n], amount) });
    flow.push({
      label: STEP_DEPOSIT,
      detail: `Swaps ${fmtUnits(amount, 18)} ETH to USDG${i.credited !== undefined ? ` (≈ ${fmtUsd(i.credited)})` : ""}${
        i.toleranceBps !== undefined ? ` within a ${fmtBps(i.toleranceBps)} tolerance` : ""
      } and adds it to the plan. If the pool cannot fill it in full, nothing moves.${lent}`,
      done: "Deposited",
      trailing: `${fmtUnits(amount, 18)} ETH`,
    });
  }
  return {
    ...ref,
    kind: "deposit",
    steps,
    flow,
    pay,
    amount,
    credited: i.credited,
    balanceAfter: i.credited !== undefined ? i.balanceBefore + i.credited : undefined,
    boosted: i.boosted,
  };
}

/**
 * Partial or full withdrawal of the plan's USDG with `withdrawIdle`: idle USDG first, then (boosted plans) the
 * boosted balance, earnings included. "All" sends the vault's MAX sentinel so a boosted balance that grew a hair
 * since the click still clears out.
 */
export function buildWithdrawOrder(i: { ref: PlanRef; amount: bigint; all: boolean; feeBps: number; usdgIdle: bigint; balanceBefore: bigint }): WithdrawOrder {
  const { ref, amount } = i;
  const receive = amount - feeOf(amount, i.feeBps);
  const fromBoost = amount > i.usdgIdle ? amount - i.usdgIdle : 0n;
  const steps: TxStep[] = [{ label: STEP_WITHDRAW_PART, params: vaultCall(ref, "withdrawIdle", [ref.planId, i.all ? MAX_UINT256 : amount]) }];
  const flow: FlowStep[] = [
    {
      label: STEP_WITHDRAW_PART,
      detail: `Sends ${fmtUsd(amount)} from the plan to your wallet, minus the ${fmtBps(i.feeBps)} withdrawal fee.${
        fromBoost > 0n ? ` ${fmtUsd(fromBoost)} of it comes back from Morpho Blue first, earnings included; if the market is short of liquidity nothing moves.` : ""
      }`,
      done: "Sent to your wallet",
      trailing: `≈ ${fmtUsd(receive)}`,
    },
  ];
  return { ...ref, kind: "withdraw", steps, flow, amount, receive, feeBps: i.feeBps, fromBoost, balanceAfter: i.balanceBefore > amount ? i.balanceBefore - amount : 0n };
}

/**
 * Claim everything the plan has bought: `claim(planId, MAX)` pays the stock held for it to the plan's recipient,
 * minus the claim fee — 0 when the owner holds the auto-distribute amount of $DCA (`isAutoDistribute`).
 */
export function buildClaimOrder(i: {
  ref: PlanRef;
  stock: Address;
  amount: bigint;
  usd?: bigint;
  /** The vault's claim fee for this owner: 0 when `perk`. */
  feeBps: number;
  perk: boolean;
  /** $DCA (raw units) that waives the claim fee, for the copy; the vault's `autoDistributeThreshold`. */
  perkThreshold?: bigint;
  recipient: Address;
  signer?: Address;
}): ClaimOrder {
  const { ref, amount } = i;
  const receive = amount - feeOf(amount, i.feeBps);
  const label = claimLabel(ref.symbol);
  const toSelf = !!i.signer && i.recipient.toLowerCase() === i.signer.toLowerCase();
  const steps: TxStep[] = [{ label, params: vaultCall(ref, "claim", [ref.planId, MAX_UINT256]) }];
  const flow: FlowStep[] = [
    {
      label,
      detail: `Sends the ${ref.symbol} this plan has bought to ${recipientCopy(i.recipient, i.signer)}${
        i.feeBps > 0
          ? `, minus the ${fmtBps(i.feeBps)} claim fee (${i.perkThreshold !== undefined ? `free with ${fmtUnitsCompact(i.perkThreshold, 18)} $DCA` : "free for $DCA holders"})`
          : i.perk
            ? " — no claim fee, you hold enough $DCA"
            : ""
      }.`,
      done: toSelf ? "In your wallet" : "Sent to the recipient",
      trailing: `${fmtUnits(receive, ref.stockDecimals, 4)} ${ref.symbol}`,
    },
  ];
  return { ...ref, kind: "claim", steps, flow, amount, receive, usd: i.usd, feeBps: i.feeBps, perk: i.perk, stock: i.stock, recipient: i.recipient, toSelf };
}

/**
 * Boost: `setPlanBoost(planId, true)` lends ALL of the plan's idle USDG on Morpho Blue at once, and every later
 * deposit as it lands. Each buy pulls back exactly what it spends. Needs an unpaused vault and a strategy.
 */
export function buildBoostOrder(i: { ref: PlanRef; usdgIdle: bigint; apy?: number }): BoostOrder {
  const { ref } = i;
  const rate = i.apy !== undefined ? ` at ${fmtPct(i.apy, true)} APY` : "";
  const steps: TxStep[] = [{ label: STEP_BOOST, params: vaultCall(ref, "setPlanBoost", [ref.planId, true]) }];
  const flow: FlowStep[] = [
    {
      label: STEP_BOOST,
      detail:
        i.usdgIdle > 0n
          ? `Lends the plan's ${fmtUsd(i.usdgIdle)} of idle USDG on Morpho Blue${rate}. Each buy pulls back what it spends; deposits are lent as they land.`
          : `Nothing is waiting in the plan right now; from here on every deposit is lent on Morpho Blue${rate}.`,
      done: "Earning on Morpho Blue",
      trailing: i.usdgIdle > 0n ? fmtUsd(i.usdgIdle) : undefined,
    },
  ];
  return { ...ref, kind: "boost", steps, flow, lend: i.usdgIdle, apy: i.apy };
}

/** Unboost: `setPlanBoost(planId, false)` pulls the whole boosted balance back into the plan, earnings included. */
export function buildUnboostOrder(i: { ref: PlanRef; boostValue: bigint; earned: bigint }): UnboostOrder {
  const { ref } = i;
  const steps: TxStep[] = [{ label: STEP_UNBOOST, params: vaultCall(ref, "setPlanBoost", [ref.planId, false]) }];
  const flow: FlowStep[] = [
    {
      label: STEP_UNBOOST,
      detail: `Pulls ${fmtUsd(i.boostValue)} back from Morpho Blue into the plan, earnings included. If the market is short of liquidity this fails and nothing moves.`,
      done: "Back in the plan",
      trailing: fmtUsd(i.boostValue),
    },
  ];
  return { ...ref, kind: "unboost", steps, flow, back: i.boostValue, earned: i.earned };
}

/**
 * Pause or resume: `setPlanPaused(planId, pause)`. A paused plan is skipped at every buy; its balance stays where it is
 * (lent on Morpho Blue and earning, when boosted), and deposits, withdrawals, claims and boost all keep working.
 */
export function buildPauseOrder(i: { ref: PlanRef; pause: boolean; balance: bigint; boosted: boolean; perBuy: bigint; nextBuy?: bigint }): PauseOrder {
  const { ref } = i;
  const label = i.pause ? "Pause plan" : "Resume plan";
  const steps: TxStep[] = [{ label, params: vaultCall(ref, "setPlanPaused", [ref.planId, i.pause]) }];
  const flow: FlowStep[] = [
    {
      label,
      detail: i.pause
        ? `Skips every buy until you resume it. The ${fmtUsd(i.balance)} stays in the plan${i.boosted ? ", lent on Morpho Blue and still earning" : ""}; you can still deposit, withdraw and claim.`
        : `Buys ${fmtUsd(i.perBuy)} of ${ref.symbol} again from the next period, while the plan has funds.`,
      done: i.pause ? "Paused" : "Resumed",
    },
  ];
  return { ...ref, kind: "pause", steps, flow, pause: i.pause, balance: i.balance, boosted: i.boosted, perBuy: i.perBuy, nextBuy: i.nextBuy };
}
