"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { decodeErrorResult, parseAbiItem, type Address } from "viem";
import { AggregatorRouterAbi, MorphoBlueStrategyAbi, PlanVaultAbi } from "@/abi";
import { LOG_LOOKBACK } from "@/lib/config";

export const planFilledEvent = parseAbiItem(
  "event PlanFilled(uint256 indexed planId, uint32 indexed epochId, uint256 spendUsdg, uint256 feeUsdg, uint256 stockShare, bool autoDistributed)",
);
export const epochPageEvent = parseAbiItem(
  "event EpochPageExecuted(address indexed stock, uint32 indexed epochId, uint256 fromIndex, uint256 toIndex, uint256 netUsdg, uint256 stockOut, uint32 plansFilled)",
);
/**
 * The boost strategy could not pay out a page's boosted spend (e.g. the lending market is fully utilised): the
 * boosted plans on that page sat it out — not charged, not marked filled, so they are picked up again — while
 * unboosted plans were filled as usual.
 *
 * Since the retry-not-skip redesign a page that cannot be bought at all emits nothing: it reverts with the
 * router's / vault's own error and leaves the cursor in place for the keeper to retry, so there is no on-chain
 * record of it to show (the old `EpochPageSkipped` event is gone).
 */
export const boostWithdrawFailedEvent = parseAbiItem(
  "event BoostWithdrawFailed(address indexed stock, uint32 indexed epochId, uint256 usdgRequested, bytes reason)",
);
/** One plan's spend alone exceeds the stock's page notional cap: it sat the epoch out instead of blocking the page. */
export const planTooLargeEvent = parseAbiItem("event PlanTooLarge(uint256 indexed planId, uint256 spend, uint256 cap)");
export const planIndexedEvent = parseAbiItem("event PlanIndexed(uint256 indexed planId, address indexed stock, bool indexed active)");
/**
 * `closePlan` paid everything out. `unindexed = true`: the plan also left epoch iteration (a `PlanIndexed(false)`
 * precedes it in the same receipt). `unindexed = false`: a buy page was open for its stock, so the empty plan
 * was PAUSED and left indexed for a later `prunePlan` / `closePlan` to drop; for the owner it is closed either way.
 */
export const planClosedEvent = parseAbiItem("event PlanClosed(uint256 indexed planId, address indexed owner, uint256 usdgOut, uint256 stockOut, bool unindexed)");
/** A deposit into an unindexed plan re-indexes it; into a parked (closed, still indexed) one it emits only this. */
export const depositedEvent = parseAbiItem("event Deposited(uint256 indexed planId, address indexed token, address from, uint256 amount, uint256 fee)");
export const idleWithdrawnEvent = parseAbiItem("event IdleWithdrawn(uint256 indexed planId, uint256 usdgAmount, uint256 usdgFee)");

export type FillLog = {
  vault: Address;
  planId: bigint;
  epochId: number;
  spendUsdg: bigint;
  feeUsdg: bigint;
  stockShare: bigint;
  autoDistributed: boolean;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp?: number;
};

export type EpochLog = {
  vault: Address;
  stock: Address;
  epochId: number;
  fromIndex: bigint;
  toIndex: bigint;
  netUsdg: bigint;
  stockOut: bigint;
  plansFilled: number;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp?: number;
};

export type WithdrawLog = { vault: Address; planId: bigint; usdgFee: bigint; blockNumber: bigint; timestamp?: number };

/** A `BoostWithdrawFailed` log: boosted plans on one page of `stock`'s epoch sat it out. */
export type BoostSkipLog = {
  vault: Address;
  stock: Address;
  epochId: number;
  usdgRequested: bigint;
  reason: string;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp?: number;
};

/** A `PlanTooLarge` log: plan `planId` sat an epoch out because its `spend` exceeds the page `cap` (both USDG). */
export type TooLargeLog = {
  vault: Address;
  planId: bigint;
  spend: bigint;
  cap: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp?: number;
};

/**
 * Human-readable reason from forwarded revert data. `BoostWithdrawFailed` carries the boost strategy's revert
 * data verbatim — an ERC-4626 limit error when the lending market cannot pay out — and the same decoder reads
 * router / vault custom errors and `Error(string)`.
 */
export function describeSkipReason(raw: `0x${string}` | undefined): string {
  if (!raw || raw === "0x") return "no reason given";
  try {
    const d = decodeErrorResult({ abi: MorphoBlueStrategyAbi, data: raw });
    switch (d.errorName) {
      case "ERC4626ExceededMaxWithdraw":
      case "ERC4626ExceededMaxRedeem":
        return "the lending market is fully utilised";
      default:
        return d.errorName;
    }
  } catch {
    /* not a strategy error */
  }
  try {
    const d = decodeErrorResult({ abi: AggregatorRouterAbi, data: raw });
    switch (d.errorName) {
      case "NoRoute":
        return "no approved route within the impact cap";
      case "InsufficientOutput":
        return "price moved past the slippage tolerance";
      case "RouteNotApproved":
        return "route not approved";
      default:
        return d.errorName;
    }
  } catch {
    /* not a router error */
  }
  try {
    return decodeErrorResult({ abi: PlanVaultAbi, data: raw }).errorName;
  } catch {
    /* not a vault error */
  }
  try {
    const d = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "m", type: "string" }] }], data: raw });
    return String(d.args?.[0] ?? "error");
  } catch {
    /* not Error(string) */
  }
  const bytes = raw.slice(2).match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [];
  if (bytes.length > 0 && bytes.every((b) => b >= 0x20 && b < 0x7f)) return String.fromCharCode(...bytes);
  return "unknown error";
}

/**
 * PlanFilled + EpochPageExecuted + BoostWithdrawFailed + PlanTooLarge + IdleWithdrawn over the last LOG_LOOKBACK
 * blocks for the given vaults.
 */
export function useEpochLogs(vaults?: Address[]) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["epochLogs", vaults?.join(",")],
    enabled: !!client && !!vaults && vaults.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const fromBlock = head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
      const [fills, epochs, boostFails, tooLarge, withdrawals] = await Promise.all([
        client!.getLogs({ address: vaults, event: planFilledEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: epochPageEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: boostWithdrawFailedEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: planTooLargeEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: idleWithdrawnEvent, fromBlock, toBlock: head }),
      ]);
      const blocks = Array.from(new Set([...fills, ...epochs, ...boostFails, ...tooLarge, ...withdrawals].map((l) => l.blockNumber)));
      const ts = new Map<bigint, number>();
      await Promise.all(
        blocks.slice(-200).map(async (b) => {
          const blk = await client!.getBlock({ blockNumber: b });
          ts.set(b, Number(blk.timestamp));
        }),
      );
      const fillLogs: FillLog[] = fills.map((l) => ({
        vault: l.address,
        planId: l.args.planId!,
        epochId: Number(l.args.epochId!),
        spendUsdg: l.args.spendUsdg!,
        feeUsdg: l.args.feeUsdg!,
        stockShare: l.args.stockShare!,
        autoDistributed: l.args.autoDistributed!,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        timestamp: ts.get(l.blockNumber),
      }));
      const epochLogs: EpochLog[] = epochs.map((l) => ({
        vault: l.address,
        stock: l.args.stock!,
        epochId: Number(l.args.epochId!),
        fromIndex: l.args.fromIndex!,
        toIndex: l.args.toIndex!,
        netUsdg: l.args.netUsdg!,
        stockOut: l.args.stockOut!,
        plansFilled: Number(l.args.plansFilled!),
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        timestamp: ts.get(l.blockNumber),
      }));
      const boostSkipLogs: BoostSkipLog[] = boostFails.map((l) => ({
        vault: l.address,
        stock: l.args.stock!,
        epochId: Number(l.args.epochId!),
        usdgRequested: l.args.usdgRequested!,
        reason: describeSkipReason(l.args.reason),
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        timestamp: ts.get(l.blockNumber),
      }));
      const tooLargeLogs: TooLargeLog[] = tooLarge.map((l) => ({
        vault: l.address,
        planId: l.args.planId!,
        spend: l.args.spend!,
        cap: l.args.cap!,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        timestamp: ts.get(l.blockNumber),
      }));
      const withdrawLogs: WithdrawLog[] = withdrawals.map((l) => ({
        vault: l.address,
        planId: l.args.planId!,
        usdgFee: l.args.usdgFee!,
        blockNumber: l.blockNumber,
        timestamp: ts.get(l.blockNumber),
      }));
      return {
        fills: fillLogs.reverse(),
        epochs: epochLogs.reverse(),
        boostSkips: boostSkipLogs.reverse(),
        tooLarge: tooLargeLogs.reverse(),
        withdrawals: withdrawLogs.reverse(),
        fromBlock,
        head,
      };
    },
  });
}

/**
 * Cumulative USDG spent on stock, oldest → newest, for a sparkline. `base` is the total before the
 * scanned window (all-time counter minus what the window saw) so the line starts from the right level.
 */
export function cumulativeSeries(epochs: EpochLog[] | undefined, base: bigint): number[] {
  if (!epochs || epochs.length === 0) return [];
  const asc = [...epochs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  let acc = base;
  const out = [Number(base) / 1e6];
  for (const e of asc) {
    acc += e.netUsdg;
    out.push(Number(acc) / 1e6);
  }
  return out;
}

/** Sum of `netUsdg` for epochs in the last `days` days (needs timestamps). */
export function sumLastDays(epochs: EpochLog[] | undefined, days: number): bigint {
  if (!epochs) return 0n;
  const cutoff = Date.now() / 1000 - days * 86400;
  return epochs.filter((e) => e.timestamp !== undefined && e.timestamp >= cutoff).reduce((a, e) => a + e.netUsdg, 0n);
}

export const planKey = (vault: Address, planId: bigint) => `${vault.toLowerCase()}:${planId.toString()}`;

/**
 * One index-relevant log, reduced to what `planLiveness` needs; exported so the rule can be read (and one
 * day unit-tested) without a client. `PlanIndexed` carries `active`, `PlanClosed` carries `unindexed`; `Deposited`
 * carries nothing more than its name.
 */
export type IndexLog = { key: string; blockNumber: bigint; logIndex: number; event: "PlanIndexed" | "PlanClosed" | "Deposited"; active?: boolean; unindexed?: boolean };

/**
 * Folds index logs into "is this plan live?" per plan key, in chain order (block, then log index — the
 * same receipt holds `PlanIndexed(false)` before `PlanClosed`, and a re-index `PlanIndexed(true)` before
 * `Deposited`), last write wins:
 *
 * - `PlanIndexed(active)` → `active`: the vault's own view of the iteration list (`prunePlan`, `closePlan`'s
 *   unindex, `_index` on a deposit into an unindexed plan).
 * - `PlanClosed(…, unindexed)` → false when it unindexed (the same receipt also carries `PlanIndexed(false)`).
 *   With `unindexed = false` the close only PARKED the plan (funds out, paused, still in the vault's iteration
 *   list because a buy page was open), so its state is left as it was: the empty, paused row stays in
 *   "My plans" and its menu finishes the delete once the buy is done. Hiding it would strand an indexed plan
 *   the keeper keeps reading every epoch, with no row left to prune it from (there is no prune sweep).
 * - `Deposited` → true: a deposit into a parked plan re-funds it WITHOUT re-indexing (it never left the list),
 *   so it emits no `PlanIndexed(true)` — the deposit alone must bring it back (review CP-03). `visiblePositions`
 *   would show it anyway, since it never hides a funded plan; this keeps the index honest for the loading gap.
 */
export function planLiveness(logs: readonly IndexLog[]): Record<string, boolean> {
  const sorted = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
  const live: Record<string, boolean> = {};
  for (const l of sorted) {
    if (l.event === "PlanIndexed") live[l.key] = !!l.active;
    else if (l.event === "Deposited") live[l.key] = true;
    else if (l.unindexed) live[l.key] = false; // PlanClosed that dropped the plan; a parked close changes nothing
  }
  return live;
}

/**
 * Which of a user's plans have been removed. `prunePlan` and `closePlan` unindex a plan but keep its record (so
 * ClaimHelper still lists it); the last `PlanIndexed` / `PlanClosed` / `Deposited` event per plan tells us
 * whether it is live (`planLiveness`). Plans older than the scanned window default to "live" — and
 * `visiblePositions` never hides a plan that holds value, whatever this says.
 */
export function usePlanIndex(vaults?: Address[]) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["planIndex", vaults?.join(",")],
    enabled: !!client && !!vaults && vaults.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const fromBlock = head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
      const [indexed, closed, deposited] = await Promise.all([
        client!.getLogs({ address: vaults, event: planIndexedEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: planClosedEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: depositedEvent, fromBlock, toBlock: head }),
      ]);
      const logs: IndexLog[] = [
        ...indexed.map((l) => ({ key: planKey(l.address, l.args.planId!), blockNumber: l.blockNumber, logIndex: l.logIndex, event: "PlanIndexed" as const, active: l.args.active! })),
        ...closed.map((l) => ({ key: planKey(l.address, l.args.planId!), blockNumber: l.blockNumber, logIndex: l.logIndex, event: "PlanClosed" as const, unindexed: l.args.unindexed! })),
        ...deposited.map((l) => ({ key: planKey(l.address, l.args.planId!), blockNumber: l.blockNumber, logIndex: l.logIndex, event: "Deposited" as const })),
      ];
      return planLiveness(logs);
    },
  });
}
