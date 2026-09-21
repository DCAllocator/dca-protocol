"use client";

import { useWriteContract, useWaitForTransactionReceipt, usePublicClient, useAccount } from "wagmi";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Abi, Address, Hash, PublicClient } from "viem";

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
 * Where one step of a sequence is: waiting its turn → in the wallet → broadcast and waiting for the receipt
 * → mined (or failed, with the reason). `hash` is set as soon as the wallet returns it.
 */
export type TxStepPhase = "todo" | "signing" | "mining" | "done" | "error";
export type TxStepState = { label: string; phase: TxStepPhase; hash?: Hash; error?: string };

type SeqState = { running: boolean; step: number; total: number; label?: string; error: string | null; done: boolean; steps: TxStepState[] };
const IDLE: SeqState = { running: false, step: 0, total: 0, error: null, done: false, steps: [] };

/**
 * Runs several writes one after another, waiting for each receipt (the vault has no multicall, so
 * "remove plan" is withdraw → claim → prune). Stops at the first failure and reports which step it was;
 * `retry()` picks up again from that step, keeping the receipts of the ones already mined.
 */
export function useTxSequence(onDone?: () => void) {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const { address } = useAccount();
  const [state, setState] = useState<SeqState>(IDLE);
  // The steps of the current run and where it stopped, for `retry`.
  const runRef = useRef<{ steps: TxStep[]; failedAt: number } | null>(null);

  const runFrom = useCallback(
    async (steps: TxStep[], from: number) => {
      if (!client || steps.length === 0) return;
      runRef.current = { steps, failedAt: -1 };
      setState((s) => ({
        running: true,
        step: from,
        total: steps.length,
        label: steps[from].label,
        error: null,
        done: false,
        // Steps before `from` are the ones a previous run already mined.
        steps: steps.map((st, i) => (i < from && s.steps[i]?.phase === "done" ? s.steps[i] : { label: st.label, phase: "todo" })),
      }));
      for (let i = from; i < steps.length; i++) {
        const patch = (p: Partial<TxStepState>) =>
          setState((s) => ({ ...s, step: i, label: steps[i].label, steps: s.steps.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
        try {
          patch({ phase: "signing" });
          const gas = await gasWithBuffer(client, steps[i].params, address);
          const hash = await writeContractAsync({ ...steps[i].params, gas } as never);
          patch({ phase: "mining", hash });
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${steps[i].label} reverted`);
          patch({ phase: "done" });
        } catch (e) {
          const err = e as Error & { shortMessage?: string };
          const msg = err.shortMessage ?? err.message;
          runRef.current = { steps, failedAt: i };
          patch({ phase: "error", error: msg });
          setState((s) => ({ ...s, running: false, error: `${steps[i].label}: ${msg}` }));
          return;
        }
      }
      setState((s) => ({ ...s, running: false, done: true, step: steps.length }));
      onDone?.();
    },
    [client, address, writeContractAsync, onDone],
  );

  const run = useCallback((steps: TxStep[]) => runFrom(steps, 0), [runFrom]);
  const retry = useCallback(() => {
    const r = runRef.current;
    if (r && r.failedAt >= 0) return runFrom(r.steps, r.failedAt);
  }, [runFrom]);
  const reset = useCallback(() => {
    runRef.current = null;
    setState(IDLE);
  }, []);
  return { ...state, run, retry, reset };
}
