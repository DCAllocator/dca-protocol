"use client";

import { useWriteContract, useWaitForTransactionReceipt, usePublicClient, useAccount } from "wagmi";
import { useCallback, useEffect, useState } from "react";
import type { Abi, Address, PublicClient } from "viem";

// Loosely typed on purpose: callers pass `{ address, abi, functionName, args, value? }` for any contract.
export type TxParams = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

/**
 * Gas limit = estimate × 1.25 + 100k. Vault calls that touch the boost strategy accrue Morpho interest for the
 * seconds since the market was last touched; an estimate taken against a block where that accrual already
 * happened is cheaper than the real execution one block later, and the exact estimate then runs out. Unused gas
 * is refunded, so padding costs nothing. Estimation failures fall through to writeContract's own simulation
 * so the user still sees the revert reason.
 */
async function gasWithBuffer(client: PublicClient | undefined, params: TxParams, account?: Address): Promise<bigint | undefined> {
  if (!client || !account) return undefined;
  try {
    const est = await client.estimateContractGas({ ...params, account } as never);
    return est + est / 4n + 100_000n;
  } catch {
    return undefined;
  }
}

/** writeContract + receipt wait with a single status surface. */
export function useTx(onSuccess?: () => void) {
  const w = useWriteContract();
  const client = usePublicClient();
  const { address } = useAccount();
  const r = useWaitForTransactionReceipt({ hash: w.data });
  useEffect(() => {
    if (r.isSuccess) onSuccess?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.isSuccess]);
  const error = (w.error ?? r.error) as (Error & { shortMessage?: string }) | null;
  const writeContractAsync = w.writeContractAsync;
  const write = useCallback(
    async (params: TxParams) => writeContractAsync({ ...params, gas: await gasWithBuffer(client, params, address) } as never),
    [writeContractAsync, client, address],
  );
  return {
    write,
    hash: w.data,
    pending: w.isPending || r.isLoading,
    success: r.isSuccess,
    error: error ? error.shortMessage ?? error.message : null,
    reset: w.reset,
  };
}

export type TxStep = { label: string; params: TxParams };

/**
 * Runs several writes one after another, waiting for each receipt (the vault has no multicall, so
 * "remove plan" is withdraw → claim → prune). Stops at the first failure and reports which step it was.
 */
export function useTxSequence(onDone?: () => void) {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const { address } = useAccount();
  const [state, setState] = useState<{ running: boolean; step: number; total: number; label?: string; error: string | null; done: boolean }>({
    running: false,
    step: 0,
    total: 0,
    error: null,
    done: false,
  });

  const run = useCallback(
    async (steps: TxStep[]) => {
      if (!client || steps.length === 0) return;
      setState({ running: true, step: 0, total: steps.length, label: steps[0].label, error: null, done: false });
      for (let i = 0; i < steps.length; i++) {
        setState((s) => ({ ...s, step: i, label: steps[i].label }));
        try {
          const gas = await gasWithBuffer(client, steps[i].params, address);
          const hash = await writeContractAsync({ ...steps[i].params, gas } as never);
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${steps[i].label} reverted`);
        } catch (e) {
          const err = e as Error & { shortMessage?: string };
          setState((s) => ({ ...s, running: false, error: `${steps[i].label}: ${err.shortMessage ?? err.message}` }));
          return;
        }
      }
      setState((s) => ({ ...s, running: false, done: true, step: steps.length }));
      onDone?.();
    },
    [client, address, writeContractAsync, onDone],
  );

  const reset = useCallback(() => setState({ running: false, step: 0, total: 0, error: null, done: false }), []);
  return { ...state, run, reset };
}
