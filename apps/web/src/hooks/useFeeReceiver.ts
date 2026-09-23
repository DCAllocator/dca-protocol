"use client";

import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { parseAbiItem, type Address } from "viem";
import { PlanVaultAbi } from "@/abi";
import { isZero, LOG_LOOKBACK } from "@/lib/config";
import type { Directory } from "@/hooks/useProtocol";

const boughtBackEvent = parseAbiItem("event BoughtBack(address indexed tokenIn, uint256 amountIn, uint256 dcaOut)");

export type BurnLog = {
  txHash: `0x${string}`;
  tokenIn: Address;
  amountIn: bigint;
  dcaOut: bigint;
  blockNumber: bigint;
  timestamp?: number;
};

/** The receiver's last `BoughtBack` events (newest first), for the public burn ledger. */
export function useBurnLogs(receiver?: Address, limit = 10) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["burnLogs", receiver, limit],
    enabled: !!client && !!receiver && !isZero(receiver),
    refetchInterval: 30_000,
    queryFn: async (): Promise<BurnLog[]> => {
      const head = await client!.getBlockNumber();
      const fromBlock = head > LOG_LOOKBACK ? head - LOG_LOOKBACK : 0n;
      const logs = await client!.getLogs({ address: receiver!, event: boughtBackEvent, fromBlock, toBlock: head });
      const last = logs.slice(-limit).reverse();
      const ts = new Map<bigint, number>();
      await Promise.all(
        Array.from(new Set(last.map((l) => l.blockNumber))).map(async (b) => {
          const blk = await client!.getBlock({ blockNumber: b });
          ts.set(b, Number(blk.timestamp));
        }),
      );
      return last.map((l) => ({
        txHash: l.transactionHash,
        tokenIn: l.args.tokenIn!,
        amountIn: l.args.amountIn!,
        dcaOut: l.args.dcaOut!,
        blockNumber: l.blockNumber,
        timestamp: ts.get(l.blockNumber),
      }));
    },
  });
}

/**
 * The slice of `contracts/src/treasury/FeeReceiver.sol` the marketing site reads. The receiver is not in the
 * VaultDirectory; it is whatever the vaults' `feeRecipient()` points at (a FeeReceiver once $DCA is deployed,
 * a plain treasury wallet before that — in which case every read below fails and the hook reports `live: false`).
 */
const FeeReceiverAbi = [
  { type: "function", name: "totalBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buybackReserve", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pending", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "BUYBACK_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "TREASURY_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

/** The split compiled into FeeReceiver.sol (`TREASURY_BPS` / `BUYBACK_BPS`); shown before the chain answers. */
export const FEE_SPLIT_DEFAULTS = { treasuryBps: 7_000, buybackBps: 3_000 } as const;

export type FeeReceiverState = {
  /** The vaults' fee recipient (FeeReceiver or treasury wallet). */
  address?: Address;
  /** True once `totalBurned()` answered, i.e. the recipient really is a FeeReceiver. */
  live: boolean;
  /** Lifetime $DCA burned by the receiver (18 decimals). */
  totalBurned?: bigint;
  /** USDG earmarked for the next buyback (6 decimals). */
  reserveUsdg?: bigint;
  /** USDG received since the last split (6 decimals). */
  pendingUsdg?: bigint;
  buybackBps: number;
  treasuryBps: number;
};

export function useFeeReceiver(dir?: Directory): FeeReceiverState {
  const vault = dir?.daily;
  const recipient = useReadContract({
    address: vault,
    abi: PlanVaultAbi,
    functionName: "feeRecipient",
    query: { enabled: !!vault && !isZero(vault), staleTime: 60_000 },
  });
  const fr = recipient.data as Address | undefined;
  const reads = useReadContracts({
    contracts:
      fr && dir
        ? [
            { address: fr, abi: FeeReceiverAbi, functionName: "totalBurned" },
            { address: fr, abi: FeeReceiverAbi, functionName: "buybackReserve", args: [dir.usdg] },
            { address: fr, abi: FeeReceiverAbi, functionName: "pending", args: [dir.usdg] },
            { address: fr, abi: FeeReceiverAbi, functionName: "BUYBACK_BPS" },
            { address: fr, abi: FeeReceiverAbi, functionName: "TREASURY_BPS" },
          ]
        : [],
    allowFailure: true,
    query: { enabled: !!fr && !isZero(fr) && !!dir, refetchInterval: 30_000 },
  });
  const r = reads.data;
  const val = (i: number): bigint | undefined => {
    const x = r?.[i];
    return x && x.status === "success" ? (x.result as bigint) : undefined;
  };
  const totalBurned = val(0);
  const buyback = val(3);
  const treasury = val(4);
  return {
    address: fr,
    live: totalBurned !== undefined,
    totalBurned,
    reserveUsdg: val(1),
    pendingUsdg: val(2),
    buybackBps: buyback !== undefined ? Number(buyback) : FEE_SPLIT_DEFAULTS.buybackBps,
    treasuryBps: treasury !== undefined ? Number(treasury) : FEE_SPLIT_DEFAULTS.treasuryBps,
  };
}
