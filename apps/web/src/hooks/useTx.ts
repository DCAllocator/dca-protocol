"use client";

import { useWriteContract, useWaitForTransactionReceipt, usePublicClient, useAccount } from "wagmi";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Abi, Address, Hash, PublicClient } from "viem";
import { useToast } from "@/components/Toast";
import { describeTxError, isReceiptTimeout, STILL_PENDING_COPY } from "@/lib/txErrors";

// Loosely typed on purpose: callers pass `{ address, abi, functionName, args, value? }` for any contract.
export type TxParams = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint };

/**
 * How long a single row action waits for its receipt before the row is released. wagmi's own default is
 * `0` (wait forever), which left a dropped transaction spinning until reload; viem's is 180 s. After this the
 * hook toasts "Still pending" with the hash and frees the buttons — the positions poll reconciles the row
 * whenever the transaction does land. Nothing is ever resent.
 */
export const ROW_RECEIPT_TIMEOUT_MS = 180_000;

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

/**
 * What a `useTx.write` is for, so the hook can label its feedback: `key` names the action (a row with Claim,
 * Boost and Pause passes `"claim"` / `"boost"` / `"pause"` and reads `pendingKey` to spin only that button);
 * `success` is the ok-toast title once the receipt lands ("Boosted", "Plan paused"). Without a key the
 * function name is used, so `pendingKey` is always set while a write is in flight.
 */
export type TxMeta = { key?: string; success?: string };

/**
 * writeContract + receipt wait with a single status surface, one action at a time.
 *
 * Every outcome is reported through a toast and the mutation is reset afterwards, so callers never have to
 * render `error` themselves and a stale rejection cannot linger under a row: a wallet rejection is a warning,
 * a revert or RPC failure an error, a mined receipt an ok toast titled by `meta.success` (with the hash), and
 * a receipt that has not arrived after `ROW_RECEIPT_TIMEOUT_MS` a warning that frees the buttons without
 * resending. `write()` never rejects. `pendingKey` is set synchronously before gas estimation and a second
 * call while one is in flight is ignored, so a double-click sends exactly one transaction.
 */
export function useTx(onSuccess?: () => void) {
  const w = useWriteContract();
  const client = usePublicClient();
  const { address } = useAccount();
  const { toast } = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Mirrors `pendingKey` synchronously so two clicks in the same tick cannot both pass the guard.
  const busyRef = useRef(false);
  const metaRef = useRef<TxMeta | null>(null);
  const r = useWaitForTransactionReceipt({ hash: w.data, timeout: ROW_RECEIPT_TIMEOUT_MS });
  const reset = w.reset;

  const finish = useCallback(() => {
    busyRef.current = false;
    metaRef.current = null;
    setPendingKey(null);
    reset();
  }, [reset]);

  // Receipt landed: label the outcome, refresh the caller's reads, release the row.
  useEffect(() => {
    if (!r.isSuccess || !w.data) return;
    const hash = w.data;
    const meta = metaRef.current;
    if (r.data?.status === "reverted") toast({ kind: "error", title: "Transaction reverted", hash });
    else toast({ kind: "ok", title: meta?.success ?? "Confirmed", hash });
    onSuccess?.();
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.isSuccess]);

  // Receipt wait failed: a timeout means "still pending", anything else is an error. Both release the row.
  useEffect(() => {
    if (!r.error || !w.data) return;
    const hash = w.data;
    if (isReceiptTimeout(r.error)) toast({ kind: "warn", title: STILL_PENDING_COPY, hash });
    else {
      const d = describeTxError(r.error);
      toast({ kind: d.kind, title: d.title, detail: d.detail, hash });
    }
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.error]);

  const writeContractAsync = w.writeContractAsync;
  const write = useCallback(
    async (params: TxParams, meta?: TxMeta): Promise<Hash | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      metaRef.current = meta ?? {};
      setPendingKey(meta?.key ?? params.functionName);
      try {
        const gas = await gasWithBuffer(client, params, address);
        return await writeContractAsync({ ...params, gas } as never);
      } catch (e) {
        const d = describeTxError(e);
        toast({ kind: d.kind, title: d.title, detail: d.detail });
        finish();
        return undefined;
      }
    },
    [writeContractAsync, client, address, toast, finish],
  );

  const error = (w.error ?? r.error) as unknown;
  return {
    write,
    hash: w.data,
    pending: pendingKey !== null || w.isPending || r.isLoading,
    /** Which action is in flight (the `meta.key` passed to `write`, else the function name), or `null`. */
    pendingKey,
    success: r.isSuccess,
    /** Product copy for the current mutation error; normally `null`, since errors are toasted and reset at once. */
    error: error ? describeTxError(error).title : null,
    reset: finish,
  };
}

export type TxStep = { label: string; params: TxParams };

/**
 * Where one step of a sequence is: waiting its turn → in the wallet → broadcast and waiting for the receipt
 * → mined (or failed, with the reason). `hash` is set as soon as the wallet returns it. `errorName` is the
 * decoded custom-error name when a step reverted with one ("EpochInProgress").
 */
export type TxStepPhase = "todo" | "signing" | "mining" | "done" | "error";
export type TxStepState = { label: string; phase: TxStepPhase; hash?: Hash; error?: string; errorName?: string };

/**
 * `waiting` is set when the current step's receipt has not arrived within viem's 180 s: the step stays
 * "mining", `running` stays true (so nothing can be resent), and `keepWaiting()` re-arms the wait on the
 * same hash. A slow network is never reported as a failure.
 */
type SeqState = { running: boolean; step: number; total: number; label?: string; error: string | null; done: boolean; steps: TxStepState[]; waiting: boolean };
const IDLE: SeqState = { running: false, step: 0, total: 0, error: null, done: false, steps: [], waiting: false };

/**
 * Runs several writes one after another, waiting for each receipt (the vault has no multicall, so
 * "remove plan" is withdraw → claim → prune). Stops at the first failure and reports which step it was;
 * `retry()` picks up again from that step, keeping the receipts of the ones already mined. A step whose
 * receipt is merely slow is not a failure: the sequence flags `waiting` and `retry()` / `keepWaiting()`
 * wait on the same hash again instead of sending anything.
 */
export function useTxSequence(onDone?: (lastHash?: Hash) => void) {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const { address } = useAccount();
  const [state, setState] = useState<SeqState>(IDLE);
  // The steps of the current run and where it stopped, for `retry`; `waitingHash` when it stopped on a slow receipt.
  const runRef = useRef<{ steps: TxStep[]; failedAt: number; waitingHash?: Hash } | null>(null);

  const runFrom = useCallback(
    async (steps: TxStep[], from: number, resumeHash?: Hash) => {
      if (!client || steps.length === 0) return;
      runRef.current = { steps, failedAt: -1 };
      setState((s) => ({
        running: true,
        waiting: false,
        step: from,
        total: steps.length,
        label: steps[from].label,
        error: null,
        done: false,
        // Steps before `from` are the ones a previous run already mined; `from` itself keeps its hash when resuming a wait.
        steps: steps.map((st, i) =>
          (i < from && s.steps[i]?.phase === "done") || (i === from && resumeHash && s.steps[i]) ? s.steps[i] : { label: st.label, phase: "todo" },
        ),
      }));
      let lastHash: Hash | undefined;
      for (let i = from; i < steps.length; i++) {
        const patch = (p: Partial<TxStepState>) =>
          setState((s) => ({ ...s, step: i, label: steps[i].label, steps: s.steps.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
        let hash: Hash | undefined = i === from ? resumeHash : undefined;
        try {
          if (!hash) {
            patch({ phase: "signing" });
            const gas = await gasWithBuffer(client, steps[i].params, address);
            hash = await writeContractAsync({ ...steps[i].params, gas } as never);
            patch({ phase: "mining", hash });
          }
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${steps[i].label} reverted`);
          lastHash = hash;
          patch({ phase: "done" });
        } catch (e) {
          if (hash && isReceiptTimeout(e)) {
            // Sent but not mined yet: hold here, keep the hash, let the user re-arm the wait. Never resend.
            runRef.current = { steps, failedAt: i, waitingHash: hash };
            setState((s) => ({ ...s, step: i, label: steps[i].label, waiting: true }));
            return;
          }
          const d = describeTxError(e);
          runRef.current = { steps, failedAt: i };
          patch({ phase: "error", error: d.title, errorName: d.errorName });
          setState((s) => ({ ...s, running: false, waiting: false, error: `${steps[i].label}: ${d.title}` }));
          return;
        }
      }
      setState((s) => ({ ...s, running: false, waiting: false, done: true, step: steps.length }));
      onDone?.(lastHash);
    },
    [client, address, writeContractAsync, onDone],
  );

  const run = useCallback((steps: TxStep[]) => runFrom(steps, 0), [runFrom]);
  /** Waits again for the receipt of the step that timed out, then carries on. Sends nothing. */
  const keepWaiting = useCallback(() => {
    const r = runRef.current;
    if (r && r.failedAt >= 0 && r.waitingHash) return runFrom(r.steps, r.failedAt, r.waitingHash);
  }, [runFrom]);
  /**
   * Picks up from the failed step; while `waiting`, it only re-arms the wait (never a second send).
   *
   * `remaining`, when given, REPLACES the steps from the failed one onward — the steps already mined keep
   * their receipts. Callers whose later steps depend on state the earlier ones changed (remove plan: a mined
   * withdraw leaves nothing for a second `withdrawIdle(MAX)`, which would revert `ZeroAmount`) rebuild the
   * tail from a fresh read and pass it here instead of re-running a click-time snapshot. An empty tail means
   * nothing is left to send: the sequence completes as done. Ignored while `waiting` — a hash is still
   * pending, so the tail cannot be known yet.
   */
  const retry = useCallback(
    (remaining?: TxStep[]) => {
      const r = runRef.current;
      if (!r || r.failedAt < 0) return;
      if (r.waitingHash) return runFrom(r.steps, r.failedAt, r.waitingHash);
      if (!remaining) return runFrom(r.steps, r.failedAt);
      const steps = [...r.steps.slice(0, r.failedAt), ...remaining];
      if (remaining.length === 0) {
        runRef.current = null;
        setState((s) => ({ ...s, running: false, waiting: false, error: null, done: true, step: steps.length, total: steps.length, steps: s.steps.slice(0, steps.length) }));
        onDone?.();
        return;
      }
      return runFrom(steps, r.failedAt);
    },
    [runFrom, onDone],
  );
  const reset = useCallback(() => {
    runRef.current = null;
    setState(IDLE);
  }, []);
  return { ...state, run, retry, keepWaiting, reset };
}
