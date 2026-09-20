"use client";

import { useWriteContract, useWaitForTransactionReceipt, usePublicClient } from "wagmi";
import { useCallback, useEffect, useState } from "react";
import type { Abi, Address } from "viem";

/** writeContract + receipt wait with a single status surface. */
export function useTx(onSuccess?: () => void) {
  const w = useWriteContract();
  const r = useWaitForTransactionReceipt({ hash: w.data });
  useEffect(() => {
    if (r.isSuccess) onSuccess?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.isSuccess]);
  const error = (w.error ?? r.error) as (Error & { shortMessage?: string }) | null;
  return {
    write: w.writeContractAsync,
    hash: w.data,
    pending: w.isPending || r.isLoading,
    success: r.isSuccess,
    error: error ? error.shortMessage ?? error.message : null,
    reset: w.reset,
  };
}

// Loosely typed on purpose: callers pass `{ address, abi, functionName, args, value? }` for any contract.
export type TxStep = { label: string; params: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint } };

/**
 * Runs several writes one after another, waiting for each receipt (the vault has no multicall, so
 * "remove plan" is withdraw → claim → prune). Stops at the first failure and reports which step it was.
 */
export function useTxSequence(onDone?: () => void) {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
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
          const hash = await writeContractAsync(steps[i].params as never);
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
    [client, writeContractAsync, onDone],
  );

  const reset = useCallback(() => setState({ running: false, step: 0, total: 0, error: null, done: false }), []);
  return { ...state, run, reset };
}
