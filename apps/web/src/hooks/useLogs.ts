"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { LOG_LOOKBACK } from "@/lib/config";

export const planFilledEvent = parseAbiItem(
  "event PlanFilled(uint256 indexed planId, uint32 indexed epochId, uint256 spendUsdg, uint256 feeUsdg, uint256 stockShare, bool autoDistributed)",
);
export const epochPageEvent = parseAbiItem(
  "event EpochPageExecuted(address indexed stock, uint32 indexed epochId, uint256 fromIndex, uint256 toIndex, uint256 netUsdg, uint256 stockOut, uint32 plansFilled)",
);
export const skippedSlippageEvent = parseAbiItem(
  "event PlanSkippedSlippage(uint256 indexed planId, uint32 indexed epochId, uint256 impactBps, uint256 capBps)",
);
export const planIndexedEvent = parseAbiItem("event PlanIndexed(uint256 indexed planId, address indexed stock, bool indexed active)");
export const idleWithdrawnEvent = parseAbiItem(
  "event IdleWithdrawn(uint256 indexed planId, uint256 usdgAmount, uint256 usdgFee, uint256 wethAmount, uint256 wethFee, bool unwrapped)",
);

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

export type WithdrawLog = { vault: Address; planId: bigint; usdgFee: bigint; wethFee: bigint; blockNumber: bigint; timestamp?: number };

/** PlanFilled + EpochPageExecuted + IdleWithdrawn over the last LOG_LOOKBACK blocks for the given vaults. */
export function useEpochLogs(vaults?: Address[]) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["epochLogs", vaults?.join(",")],
    enabled: !!client && !!vaults && vaults.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const fromBlock = head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
      const [fills, epochs, withdrawals] = await Promise.all([
        client!.getLogs({ address: vaults, event: planFilledEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: epochPageEvent, fromBlock, toBlock: head }),
        client!.getLogs({ address: vaults, event: idleWithdrawnEvent, fromBlock, toBlock: head }),
      ]);
      const blocks = Array.from(new Set([...fills, ...epochs, ...withdrawals].map((l) => l.blockNumber)));
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
      const withdrawLogs: WithdrawLog[] = withdrawals.map((l) => ({
        vault: l.address,
        planId: l.args.planId!,
        usdgFee: l.args.usdgFee!,
        wethFee: l.args.wethFee!,
        blockNumber: l.blockNumber,
        timestamp: ts.get(l.blockNumber),
      }));
      return { fills: fillLogs.reverse(), epochs: epochLogs.reverse(), withdrawals: withdrawLogs.reverse(), fromBlock, head };
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
 * Which of a user's plans have been removed. `prunePlan` unindexes a plan but keeps its record (so
 * ClaimHelper still lists it); the last PlanIndexed event per plan tells us whether it is live.
 * Plans older than the scanned window default to "live".
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
      const logs = await client!.getLogs({ address: vaults, event: planIndexedEvent, fromBlock, toBlock: head });
      // Logs arrive in chain order; the last write wins.
      const live: Record<string, boolean> = {};
      for (const l of logs) live[planKey(l.address, l.args.planId!)] = l.args.active!;
      return live;
    },
  });
}
