"use client";

import { useWriteContract, useWaitForTransactionReceipt, usePublicClient, useAccount, useConfig } from "wagmi";
import { getConnectorClient } from "wagmi/actions";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Abi, Address, Hash, PublicClient, Transaction, TransactionReceipt } from "viem";
import { useToast } from "@/components/Toast";
import { conflictCopy, describeTxError, isReceiptTimeout, STILL_PENDING_COPY, type SendConflict } from "@/lib/txErrors";
import { lastMinedOf, noteMined, waitForWalletNonce } from "@/lib/walletSync";

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
 * is refunded, so padding costs nothing.
 *
 * An estimate that reverts with a decoded custom error ("EnforcedPause", "ZeroAmount", …) is thrown: the call
 * would revert on chain too, so the step fails here with its reason instead of sending a transaction that burns
 * gas for nothing. Any other failure (an RPC hiccup, an undecodable revert) falls through to the wallet's own
 * estimate, as before.
 */
async function gasWithBuffer(client: PublicClient | undefined, params: TxParams, account?: Address): Promise<bigint | undefined> {
  if (!client || !account) return undefined;
  try {
    const est = await client.estimateContractGas({ ...params, account } as never);
    return est + est / 4n + 100_000n;
  } catch (e) {
    if (describeTxError(e).errorName) throw e;
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
 *
 * `note` replaces "Confirm in your wallet…" while a signing step is still held back for the wallet to catch up.
 * `conflict` is set when the wallet refused the send over its nonce; `maybeSent` with it when the account's
 * transaction count moved since the prompt (or could not be read), so the step may have gone through anyway and must
 * not be offered as a blind "Try again".
 */
export type TxStepPhase = "todo" | "signing" | "mining" | "done" | "error";
export type TxStepState = {
  label: string;
  phase: TxStepPhase;
  hash?: Hash;
  error?: string;
  errorName?: string;
  note?: string;
  conflict?: SendConflict;
  maybeSent?: boolean;
};

/**
 * `waiting` is set when the current step was sent but its receipt could not be had — viem's 180 s ran out, or the
 * RPC failed while polling: the step stays "mining", `running` stays true (so nothing can be resent), and
 * `keepWaiting()` re-arms the wait on the same hash. A slow network is never reported as a failure.
 *
 * `syncing` is set while the next step is held back until the wallet has caught up with the last one (see
 * `waitForWalletNonce`). Nothing has been sent for that step yet, so `cancel()` may end the run there.
 */
type SeqState = {
  running: boolean;
  step: number;
  total: number;
  label?: string;
  error: string | null;
  done: boolean;
  steps: TxStepState[];
  waiting: boolean;
  syncing: boolean;
};
const IDLE: SeqState = { running: false, step: 0, total: 0, error: null, done: false, steps: [], waiting: false, syncing: false };

export const WALLET_SYNC_COPY = "Waiting for your wallet to catch up with the last step…";

/** Our node's pending transaction count for the account, or `undefined` when it cannot be read. */
function pendingCount(client: PublicClient, address?: Address): Promise<number | undefined> {
  if (!address) return Promise.resolve(undefined);
  return client.getTransactionCount({ address, blockTag: "pending" }).catch(() => undefined);
}

/**
 * Runs several writes one after another, waiting for each receipt (the vault has no multicall, so
 * "remove plan" is withdraw → claim → prune). Stops at the first failure and reports which step it was;
 * `retry()` picks up again from that step, keeping the receipts of the ones already mined. A step whose
 * receipt is merely slow is not a failure: the sequence flags `waiting` and `retry()` / `keepWaiting()`
 * wait on the same hash again instead of sending anything.
 *
 * Nonces are left to the wallet, but a step that follows one of this account's own mined transactions (the
 * previous step, or a flow in another sequence within the last two minutes) is not prompted until the wallet's own
 * transaction count shows that transaction (`waitForWalletNonce`): a wallet a block behind signs the old nonce again
 * and the node refuses it ("nonce too low"). A send refused over its nonce is never re-prompted automatically; the
 * account's count on our node decides whether the step can be offered again (see the catch).
 */
export function useTxSequence(onDone?: (lastHash?: Hash) => void) {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const config = useConfig();
  const { address } = useAccount();
  const [state, setState] = useState<SeqState>(IDLE);
  // The steps of the current run and where it stopped, for `retry`; `waitingHash` when it stopped on a slow receipt.
  const runRef = useRef<{ steps: TxStep[]; failedAt: number; waitingHash?: Hash } | null>(null);
  // Held synchronously while a run loops, so a second `run` / `retry` / `keepWaiting` in the same tick (a
  // double-click before the re-render) is ignored instead of starting a second loop and a second wallet prompt.
  const activeRef = useRef(false);
  // Set while a step is being prepared (estimate, wallet-sync wait); aborting it ends the run before the prompt.
  const syncRef = useRef<AbortController | null>(null);

  const runFrom = useCallback(
    async (steps: TxStep[], from: number, resumeHash?: Hash) => {
      if (!client || steps.length === 0 || activeRef.current) return;
      activeRef.current = true;
      const chainId = client.chain.id;
      let lastHash: Hash | undefined;
      try {
        runRef.current = { steps, failedAt: -1 };
        setState((s) => ({
          running: true,
          waiting: false,
          syncing: false,
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
        for (let i = from; i < steps.length; i++) {
          const patch = (p: Partial<TxStepState>) =>
            setState((s) => ({ ...s, step: i, label: steps[i].label, steps: s.steps.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
          const syncing = (on: boolean) =>
            setState((s) => ({ ...s, syncing: on, steps: s.steps.map((x, j) => (j === i ? { ...x, note: on ? WALLET_SYNC_COPY : undefined } : x)) }));
          let hash: Hash | undefined = i === from ? resumeHash : undefined;
          // Set once the network has answered for `hash`; until then a failure is never "not sent" (see the catch).
          let receipt: TransactionReceipt | undefined;
          // Our node's pending count for the account just before the prompt, for judging a send refused over its nonce.
          let countBefore: number | undefined;
          try {
            if (!hash) {
              patch({ phase: "signing" });
              const prev = address ? lastMinedOf(chainId, address) : undefined;
              const sync = new AbortController();
              syncRef.current = sync;
              // Alongside the estimate, so a wallet that is already in step costs nothing: its count is read through the
              // connector (the wallet's own view), and a wallet that cannot be reached is not waited for.
              const walletSynced =
                prev && address
                  ? getConnectorClient(config, { assertChainId: false })
                      .then((wallet) => waitForWalletNonce(wallet, address, prev, { signal: sync.signal, onSlow: () => syncing(true) }))
                      .catch(() => false)
                  : undefined;
              const cancelled = new Promise<undefined>((r) => sync.signal.addEventListener("abort", () => r(undefined), { once: true }));
              let prepared: [bigint | undefined, number | undefined, unknown] | undefined;
              try {
                prepared = await Promise.race([Promise.all([gasWithBuffer(client, steps[i].params, address), pendingCount(client, address), walletSynced]), cancelled]);
              } catch (e) {
                sync.abort(); // the estimate named a revert: stop the wallet-sync wait too
                throw e;
              } finally {
                syncRef.current = null;
              }
              if (!prepared) {
                // Closed while held back for the wallet: nothing was sent for this step, the run just ends.
                runRef.current = null;
                setState(IDLE);
                return;
              }
              const gas = prepared[0];
              countBefore = prepared[1];
              if (prev) syncing(false);
              hash = await writeContractAsync({ ...steps[i].params, gas } as never);
              patch({ phase: "mining", hash });
            }
            // A step the wallet cancelled or replaced (same nonce, other calldata) never ran, even though viem hands
            // back the replacement's receipt; only a repriced (sped-up) copy of the same call counts as this step.
            let replaced: string | undefined;
            let replacement: Transaction | undefined;
            // A receipt carries no nonce: read the transaction alongside the receipt wait, for the next prompt.
            const sent = client.getTransaction({ hash }).catch(() => undefined);
            receipt = await client.waitForTransactionReceipt({
              hash,
              onReplaced: (r) => {
                replacement = r.transaction;
                if (r.reason !== "repriced") replaced = r.reason;
              },
            });
            // Whatever happens next (replaced, reverted), the mined transaction has used its nonce. A sped-up or
            // replacing copy has its own hash; this node may not have known the original yet, so read it again then.
            const mined = replacement ?? (await sent) ?? (await client.getTransaction({ hash: receipt.transactionHash }).catch(() => undefined));
            if (mined) noteMined(chainId, receipt.from, { nonce: mined.nonce, hash: receipt.transactionHash });
            if (replaced) throw new Error(`${replaced === "cancelled" ? "Cancelled" : "Replaced"} in your wallet — this step did not run.`);
            if (receipt.status !== "success") {
              // A mined revert carries no reason: replay the call against its block to name it where possible.
              let reason: unknown = new Error(`${steps[i].label} reverted`);
              try {
                await client.simulateContract({ ...steps[i].params, account: address, blockNumber: receipt.blockNumber } as never);
              } catch (e) {
                if (describeTxError(e).errorName) reason = e;
              }
              throw reason;
            }
            // A sped-up copy mined under its own hash: follow that one (explorer link, receipt reads, `onDone`).
            hash = receipt.transactionHash;
            lastHash = hash;
            patch({ phase: "done", hash });
          } catch (e) {
            if (hash && !receipt) {
              // Sent, but no receipt yet — a timeout or the RPC failing while polling. Either way it may still land:
              // hold here, keep the hash, let the user re-arm the wait. Never resend.
              runRef.current = { steps, failedAt: i, waitingHash: hash };
              setState((s) => ({ ...s, step: i, label: steps[i].label, waiting: true }));
              return;
            }
            const d = describeTxError(e);
            let error = d.title;
            let maybeSent: boolean | undefined;
            if (d.conflict && !hash) {
              // Refused over its nonce, no hash. The words alone do not prove nothing went out (a node says "nonce too
              // low" to a rebroadcast of a transaction that already mined too): only an unchanged count on our node
              // says nothing from the account landed or queued since the prompt. Never re-prompted on its own.
              const countAfter = d.conflict === "already-sent" || countBefore === undefined ? undefined : await pendingCount(client, address);
              maybeSent = countAfter === undefined || countAfter !== countBefore;
              error = conflictCopy(d.conflict, !maybeSent);
            }
            runRef.current = { steps, failedAt: i };
            patch({ phase: "error", error, errorName: d.errorName, conflict: d.conflict, maybeSent });
            setState((s) => ({ ...s, running: false, waiting: false, syncing: false, error: `${steps[i].label}: ${error}` }));
            return;
          }
        }
        setState((s) => ({ ...s, running: false, waiting: false, done: true, step: steps.length }));
      } finally {
        activeRef.current = false;
      }
      // Reached only when every step mined (the failure and waiting paths return above); released first, so
      // `onDone` may start the next run.
      onDone?.(lastHash);
    },
    [client, config, address, writeContractAsync, onDone],
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
  /**
   * Ends a run that is still preparing its next step (`syncing`: held back for the wallet); nothing has been sent for
   * that step, and the run ends as if reset. Once the wallet has been prompted it no longer applies.
   */
  const cancel = useCallback(() => syncRef.current?.abort(), []);
  const reset = useCallback(() => {
    syncRef.current?.abort();
    runRef.current = null;
    setState(IDLE);
  }, []);
  return { ...state, run, retry, keepWaiting, cancel, reset };
}
